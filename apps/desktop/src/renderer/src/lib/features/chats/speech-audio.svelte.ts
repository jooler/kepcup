/**
 * Bot 语音音频缓存与播放仲裁（docs/design/53-voice-conversation.md 修订 v2
 * V2-3，D106）：播报队列与手动朗读共用一条音频通道。
 *
 * 缓存：messageId → { objectURL, mimeType, text } 的内存 LRU（约 20 条，逐出
 * 即 revoke objectURL）——播完不再立即 revoke（生命周期归缓存管，Bot 播报变得
 * 可回放）；未命中才经 `media.synthesizeSpeech` 合成（依赖注入，Composer 接
 * 线真实 RPC / objectURL / Audio 元素，本文件不 import core / DOM）。缓存是
 * 全局会话级：退出语音模式不清（朗读在语音模式之外也可用），停止播放也保留
 * 条目（再点即重播，不再合成）。
 *
 * 仲裁：本模块独占唯一的音频元素，同一时刻只有一个播放请求（单请求槽即「世
 * 代」）——新 play 把上一个请求抢占收场（pause + onPreempted 先触发 + ended
 * 以「被抢占」resolve，不 reject）。播报中点朗读 = 打断播报、播指定消息（手
 * 动开播经 onManualPlayStart 通知接线方清播报队列，含合成中的条目）；朗读中
 * 新播报到来 = 打断朗读（播报的 play 经仲裁抢占手动请求）。
 *
 * 朗读文本 = extractSpeechText(message.content.text)（与播报同一提取口径）。
 */

import type { Message } from '@kepcup/shared';
import { extractSpeechText } from './extractSpeechText';

/** 播报队列的播放句柄（voice-mode.svelte.ts 定义；结构兼容，零交叉 import）。 */
export interface SpeechPlayHandle {
  /** 自然播完 resolve；被抢占 / stop() 时也 resolve（不 reject）；出错 reject。 */
  ended: Promise<void>;
  /** 立即停止（仅当本请求仍是当前世代；已被抢占则 no-op）。 */
  stop(): void;
}

/** speech-audio 依赖的音频元素面（HTMLAudioElement 子集；测试注入假元素）。 */
export interface SpeechAudioElement {
  src: string;
  play(): Promise<void>;
  pause(): void;
  /** 重载媒体（同 URL 重播必须显式触发，赋同值 src 不会重新加载）。 */
  load(): void;
  addEventListener(type: 'ended' | 'error', handler: () => void): void;
}

/** 可注入依赖（Composer 挂载时接线；测试用假实现）。 */
export interface SpeechAudioDeps {
  /** `media.synthesizeSpeech`（format mp3，voice/speed 缺省）：text → 音频。 */
  synthesize(text: string): Promise<{ blob: Blob; mimeType: string }>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  /** 唯一的音频元素（懒创建；本模块独占，外部不得共用）。 */
  createElement(): SpeechAudioElement;
  /** 手动朗读失败（合成 / 播放）的用户提示：toast 与播报失败同款（接线方）。 */
  onToggleFailure(error: unknown): void;
  /**
   * 手动朗读即将开播（点了另一条消息的朗读键）：接线方打断播报队列
   * （interruptSpeech）——「播报中点朗读 = 打断播报」，合成中的条目一并作废。
   * 暂停 / 续播同一条消息不触发。
   */
  onManualPlayStart(): void;
}

interface CacheEntry {
  url: string;
  mimeType: string;
  text: string;
}

/** 当前播放请求（单元素单请求；被抢占 / 播完 / 出错后清空）。 */
interface CurrentRequest {
  messageId: string;
  onPreempted: (() => void) | null;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

/** 缓存条数上限（约 20 条；在播条目跳过逐出——宁超 1 条不掐正在出声的音频）。 */
const CACHE_LIMIT = 20;

class SpeechAudioState {
  /** 当前占用扬声器的消息 id（播放或暂停中；播完 / 失败 / 停止清空）。 */
  currentId = $state<string | null>(null);
  isPlaying = $state(false);

  #deps: SpeechAudioDeps | null = null;
  /** 普通 Map（刻意非响应式）：LRU 台册，界面从 currentId/isPlaying 派生。 */
  #cache = new Map<string, CacheEntry>();
  #pending = new Map<string, Promise<string>>();
  /** 手动朗读序号：合成落地后用户已改选别的消息则放弃本次播放。 */
  #toggleSeq = 0;
  #element: SpeechAudioElement | null = null;
  /**
   * 当前播放请求（即「世代」）：单元素单请求槽，每次 play 换槽并把上一个请求
   * 抢占收场（onPreempted + ended 以被抢占 resolve）。
   */
  #current: CurrentRequest | null = null;

  /** 注入依赖（Composer 挂载时；重复注入不清缓存——缓存是全局会话级）。 */
  configure(deps: SpeechAudioDeps): void {
    this.#deps = deps;
  }

  /**
   * messageId → objectURL（缓存未命中才合成；在途合成去重）。text 用调用方
   * 提取好的朗读文本（播报条目与手动 toggle 同一口径）；失败 reject。
   */
  async ensureUrl(messageId: string, text: string): Promise<string> {
    const cached = this.#cache.get(messageId);
    if (cached !== undefined) {
      // LRU touch：删了重插，最近使用的沉底。
      this.#cache.delete(messageId);
      this.#cache.set(messageId, cached);
      return cached.url;
    }
    const pending = this.#pending.get(messageId);
    if (pending !== undefined) return pending;
    const promise = (async () => {
      try {
        const deps = this.#requireDeps();
        const { blob, mimeType } = await deps.synthesize(text);
        const url = deps.createObjectUrl(blob);
        this.#cache.set(messageId, { url, mimeType, text });
        this.#evictOverflow();
        return url;
      } finally {
        this.#pending.delete(messageId);
      }
    })();
    this.#pending.set(messageId, promise);
    return promise;
  }

  /**
   * 低层播放（播报队列经此出声）：抢占当前请求 → 换源 → 播放。onPreempted 在
   * ended 以「被抢占」resolve **之前**触发（队列据此作废剩余队列）。
   */
  play(input: { messageId: string; audio: string; onPreempted?: () => void }): SpeechPlayHandle {
    this.#preemptCurrent();
    const element = this.#ensureElement();
    element.src = input.audio;
    element.load();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ended = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const request: CurrentRequest = {
      messageId: input.messageId,
      onPreempted: input.onPreempted ?? null,
      resolve,
      reject,
      settled: false,
    };
    this.#current = request;
    this.currentId = input.messageId;
    this.isPlaying = true;
    void element.play().catch((error: unknown) => {
      if (this.#current !== request) return; // 已被新播放抢占
      this.#current = null;
      this.isPlaying = false;
      this.currentId = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    return {
      ended,
      stop: () => {
        if (this.#current !== request) return; // 已被抢占 / 已结束
        this.stop();
      },
    };
  }

  /** 停止当前播放（缓存保留；当前请求以「被抢占」收场——队列随之清队）。 */
  stop(): void {
    this.#preemptCurrent();
    this.isPlaying = false;
    this.currentId = null;
  }

  /**
   * 手动朗读开关（bot text 气泡朗读键）：播放中本条 → 暂停；暂停中本条 →
   * 续播；其他 / 空闲 → 打断播报（onManualPlayStart）+ 抢占当前 + 按需合成后
   * 播放。无可朗读文字（空提取 / 非 bot text）no-op——按钮本就不该出现。
   */
  toggle(message: Message): void {
    const deps = this.#deps;
    if (deps === null) return;
    const messageId = message.id;
    if (this.currentId === messageId) {
      if (this.isPlaying) {
        this.#element?.pause();
        this.isPlaying = false;
        return;
      }
      // 暂停中的本条：续播（自然播完 / 失败会把 currentId 清空，走不到这）。
      const request = this.#current;
      if (request === null) return; // 防御：无在途请求却标着暂停
      void this.#element?.play().then(
        () => {
          if (this.#current === request) this.isPlaying = true;
        },
        (error: unknown) => {
          if (this.#current !== request) return;
          this.#current = null;
          if (!request.settled) {
            request.settled = true;
            request.resolve();
          }
          this.isPlaying = false;
          this.currentId = null;
          deps.onToggleFailure(error);
        },
      );
      return;
    }
    const text = this.#speechTextOf(message);
    if (text.length === 0) return;
    const myToggle = ++this.#toggleSeq;
    deps.onManualPlayStart();
    this.#preemptCurrent();
    this.isPlaying = false;
    this.currentId = null;
    void (async () => {
      try {
        const url = await this.ensureUrl(messageId, text);
        if (myToggle !== this.#toggleSeq) return; // 合成期间用户已改选别的消息
        // 播放失败（解码 / 自动播放被拒）只会以 ended reject 冒出（被抢占是
        // resolve，不 reject）——接住走同款失败提示，避免未处理拒绝。
        void this.play({ messageId, audio: url }).ended.catch((error: unknown) =>
          deps.onToggleFailure(error),
        );
      } catch (error) {
        if (myToggle !== this.#toggleSeq) return;
        deps.onToggleFailure(error);
      }
    })();
  }

  // --- 内部 -------------------------------------------------------------------

  #requireDeps(): SpeechAudioDeps {
    const deps = this.#deps;
    if (deps === null) throw new Error('speech audio not wired');
    return deps;
  }

  /** bot text 消息的朗读文本（与播报同一提取口径；无可读 → 空串）。 */
  #speechTextOf(message: Message): string {
    if (message.senderType !== 'bot' || message.kind !== 'text') return '';
    if (!('text' in message.content) || typeof message.content.text !== 'string') return '';
    return extractSpeechText(message.content.text).text;
  }

  #ensureElement(): SpeechAudioElement {
    if (this.#element === null) {
      const element = this.#requireDeps().createElement();
      element.addEventListener('ended', this.#onElementEnded);
      element.addEventListener('error', this.#onElementError);
      this.#element = element;
    }
    return this.#element;
  }

  #onElementEnded = (): void => {
    const current = this.#current;
    if (current === null || current.settled) return;
    this.#current = null;
    current.settled = true;
    current.resolve();
    this.isPlaying = false;
    this.currentId = null;
  };

  #onElementError = (): void => {
    const current = this.#current;
    if (current === null || current.settled) return;
    this.#current = null;
    current.settled = true;
    current.reject(new Error('speech audio playback failed'));
    this.isPlaying = false;
    this.currentId = null;
  };

  /** 抢占当前请求：onPreempted 先于 resolve 触发，随后 pause（新播放会换源）。 */
  #preemptCurrent(): void {
    const current = this.#current;
    if (current === null) return;
    this.#current = null;
    if (!current.settled) {
      current.settled = true;
      current.onPreempted?.();
      current.resolve();
    }
    this.#element?.pause();
  }

  /** 超 LRU 上限逐出最旧（在播条目跳过），逐出即 revoke objectURL。 */
  #evictOverflow(): void {
    while (this.#cache.size > CACHE_LIMIT) {
      let evictId: string | null = null;
      for (const key of this.#cache.keys()) {
        if (key !== this.currentId) {
          evictId = key;
          break;
        }
      }
      if (evictId === null) break; // 全是在播条目（limit 内不会发生）
      const entry = this.#cache.get(evictId);
      this.#cache.delete(evictId);
      if (entry !== undefined) this.#deps?.revokeObjectUrl(entry.url);
    }
  }

  /**
   * 单测隔离缝（__KEPCUP_TEST_HOOKS__ 守卫，打包产物里死代码消除）：停播 +
   * 清缓存（逐条 revoke）+ 清在途台账 + 弃用旧依赖的音频元素。生产代码不得调用。
   */
  __resetForTest(): void {
    if (!__KEPCUP_TEST_HOOKS__) return;
    this.stop();
    this.#pending.clear();
    for (const entry of this.#cache.values()) this.#deps?.revokeObjectUrl(entry.url);
    this.#cache.clear();
    this.#toggleSeq = 0;
    this.#element = null; // 下次播放按新依赖重建（测试换 harness 后 createElement 重新生效）
  }
}

export const speechAudio = new SpeechAudioState();

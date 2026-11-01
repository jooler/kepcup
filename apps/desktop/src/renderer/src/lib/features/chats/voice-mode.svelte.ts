/**
 * 语音对话模式的 UI 状态机与 Bot 播报队列（docs/design/53-voice-conversation.md，D106）。
 *
 * 会话内即时态：进入即开启、关闭即退出，不持久化、不跨会话（切换会话 /
 * 组件卸载由 Composer 的 effect 调 exit()）。本模块只持 UI 状态、纯转移表
 * 与播报队列（单测锚点）；录音传感器链路 / 转写 / 发送编排在 Composer（26 号
 * 「语音消息语义」），播报的合成 / objectURL / Audio 播放依赖由 Composer 注入
 * （attachAnnouncer）——本文件不 import core / DOM，保持可纯逻辑单测。
 */

import type { Approval, Message } from '@kepcup/shared';
import { isVisibleInTranscript } from './transcript-visibility';
import { extractSpeechText } from './extractSpeechText';

/** 四态（53 号交互状态机）。 */
export type VoiceUiPhase = 'idle' | 'recording' | 'transcribing' | 'speaking';

export type VoiceUiEvent =
  /** 拿到麦克风流、采集真正开始——TCC 授权弹框等待期不算（打断绑这个点）。 */
  | 'record-started'
  /** 点击麦克风键 / 60s 到点：停止采集并转写发送。 */
  | 'stop-requested'
  /** 收尾回空闲：转写发送链路结束（成功 / 空识别 / 失败兜底后）或录音被取消丢弃。 */
  | 'settled'
  /** 播报队列取出一条开始合成（WP3；idle → speaking）。 */
  | 'speech-started'
  /** 当前一条播完或被清队（WP3；speaking → idle）。 */
  | 'speech-ended';

/** 纯转移表：null = 该态下忽略该事件（防重入，如 transcribing 再按停止）。 */
export function nextVoicePhase(phase: VoiceUiPhase, event: VoiceUiEvent): VoiceUiPhase | null {
  switch (event) {
    case 'record-started':
      return phase === 'idle' ? 'recording' : null;
    case 'stop-requested':
      return phase === 'recording' ? 'transcribing' : null;
    case 'settled':
      return phase === 'idle' ? null : 'idle';
    case 'speech-started':
      return phase === 'idle' ? 'speaking' : null;
    case 'speech-ended':
      return phase === 'speaking' ? 'idle' : null;
  }
}

/** Esc 分档（53 号）：recording 中先取消录音（丢弃），其余态退出语音模式。 */
export function escapeActionForVoiceMode(
  phase: VoiceUiPhase,
): 'cancel-recording' | 'exit-voice-mode' {
  return phase === 'recording' ? 'cancel-recording' : 'exit-voice-mode';
}

/**
 * 麦克风键在各态的意图：idle 开始 / recording 停止并转写发送 / transcribing
 * 禁用（识别在途）/ speaking 打断并开始录音（打断在拿到流后才生效）。
 */
export function micIntentFor(
  phase: VoiceUiPhase,
): 'start' | 'stop-send' | 'disabled' | 'interrupt' {
  switch (phase) {
    case 'idle':
      return 'start';
    case 'recording':
      return 'stop-send';
    case 'transcribing':
      return 'disabled';
    case 'speaking':
      return 'interrupt';
  }
}

// --- Bot 播报（53 号「Bot 语音播报链路」，WP3）-------------------------------

/** speaking 态的两阶段：合成中（Loader）/ 播放中（动画波形）。 */
export type SpeakingStage = 'synthesizing' | 'playing';

/** 播报队列条目（message → 条目的纯换算见 announceEntryFor）。 */
export interface AnnounceEntry {
  /** 消息 id：重复事件去重。 */
  id: string;
  /** extractSpeechText 产物（已截断，非空）。 */
  text: string;
  /** 超长截断：调用方每条消息 toast 一次。 */
  truncated: boolean;
}

/** 播报的入队上下文（53 号入队条件：当前会话 + 语音模式开启中）。 */
export interface AnnounceContext {
  /** 语音模式所在会话（= 当前打开的会话）。 */
  conversationId: string | null;
  /** 语音模式是否开启。 */
  active: boolean;
  /** 审批快照：与消息列表同一可见性口径（缺省空表 = 徽标场景的口径）。 */
  approvals?: Readonly<Record<string, Approval | undefined>>;
}

/**
 * message → 播报条目（53 号入队条件，纯函数）：当前会话的**可见** bot 文本
 * 消息、文本非空、且提取后仍有可朗读文字。可见性复用 isVisibleInTranscript
 * （setupAnswer / task interim / 临时审批卡等列表不可见的消息不播——「播的 =
 * 列表记的」，风险 #3）。返回 null = 不入队。
 */
export function announceEntryFor(message: Message, context: AnnounceContext): AnnounceEntry | null {
  if (!context.active) return null;
  if (context.conversationId === null || message.conversationId !== context.conversationId) {
    return null;
  }
  if (message.senderType !== 'bot' || message.kind !== 'text') return null;
  if (!('text' in message.content) || message.content.text.trim().length === 0) return null;
  if (!isVisibleInTranscript(message, context.approvals ?? {})) return null;
  const { text, truncated } = extractSpeechText(message.content.text);
  if (text.trim().length === 0) return null;
  return { id: message.id, text, truncated };
}

/** 一次播放的句柄（真实实现 = HTMLAudioElement 包装，由接线方提供）。 */
export interface PlaybackHandle {
  /** 自然播完 resolve；被 stop() 打断后 resolve（不 reject）；播放出错 reject。 */
  ended: Promise<void>;
  /** 立即停止（打断 / 清队 / 退出）。 */
  stop(): void;
}

/** 播报队列的可注入依赖（core 合成 / objectURL / Audio 播放；测试用假实现）。 */
export interface AnnounceDeps {
  /** `media.synthesizeSpeech`（format mp3，voice/speed 缺省）：text → 音频 Blob。 */
  synthesize(text: string): Promise<{ blob: Blob }>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  /** objectURL → 播放；自然结束 resolve、出错 reject、stop() 立停。 */
  play(url: string): PlaybackHandle;
  /** 第一条播报失败（合成或播放）：停队提示（toast +「打开设置」深链在接线方）。 */
  onFirstFailure(error: unknown): void;
}

/** 队列对宿主状态机的全部需求（VoiceModeState 实现；测试可注入假宿主）。 */
export interface AnnounceHost {
  readonly active: boolean;
  readonly phase: VoiceUiPhase;
  /** idle → speaking（stage 起步 synthesizing）。 */
  enterSpeaking(): void;
  setSpeakingStage(stage: SpeakingStage): void;
  /** speaking → idle。 */
  exitSpeaking(): void;
}

export interface AnnounceController {
  /** 入队并尝试消费；返回 false = 未入队（未开启 / 空文本 / 重复 id）。 */
  enqueue(entry: AnnounceEntry): boolean;
  /** 有空就消费（宿主回 idle / 新消息入队后触发）；循环中重复触发只记一次。 */
  pump(): void;
  /** 插话作废：停当前 + 清未播队列（拿到流才调，53 号半双工）。 */
  interrupt(): void;
  /** 退出 / 切会话清理：停当前 + 清队 + revoke（含在途合成落地后的资源）。 */
  reset(): void;
}

/**
 * 顺序播报队列（53 号）：一次一条——合成中 → objectURL → 播放 → ended 后
 * revoke 取下一条；宿主不在 idle（recording / transcribing）时入队暂播、回
 * idle 按序播；第一条失败即停队（不自动重试，新消息到来重新开始）；interrupt
 * / reset 用 epoch 作废在途迭代（合成落地后不再建 URL，无泄漏）。
 */
export function createAnnounceQueue(host: AnnounceHost, deps: AnnounceDeps): AnnounceController {
  let queue: AnnounceEntry[] = [];
  /**
   * 已入队过的消息 id（含在播 / 已播 / 已作废）：重复的 message.created 事件
   * 不重播、不重复 toast。reset（退出 / 重新注入）时清空。
   */
  // 普通 Set（刻意非响应式）：队列内部去重台账，界面从 phase/speakingStage 派生。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const seenIds = new Set<string>();
  /** 失败停队标志：下一条消息 enqueue 时清除（「下条消息到来重新开始」）。 */
  let stopped = false;
  /** 作废计数：interrupt / reset / 失败时 +1，在途迭代的每个 await 后核对。 */
  let epoch = 0;
  let pumping = false;
  let pumpAgain = false;
  let currentHandle: PlaybackHandle | null = null;
  let currentUrl: string | null = null;

  const stopCurrent = (): void => {
    currentHandle?.stop();
    currentHandle = null;
    if (currentUrl !== null) {
      deps.revokeObjectUrl(currentUrl);
      currentUrl = null;
    }
  };

  /** 第一条失败：停当前 + 清队 + 回 idle + 提示（只此一次，不连环刷）。 */
  const fail = (error: unknown): void => {
    epoch += 1;
    stopCurrent();
    queue = [];
    stopped = true;
    if (host.phase === 'speaking') host.exitSpeaking();
    deps.onFirstFailure(error);
  };

  /** 消费一条：合成 → objectURL → 播放 → ended → revoke；任何一步出错走 fail。 */
  const runOne = async (entry: AnnounceEntry): Promise<void> => {
    host.enterSpeaking();
    const myEpoch = epoch;
    let blob: Blob;
    try {
      blob = (await deps.synthesize(entry.text)).blob;
    } catch (error) {
      if (epoch === myEpoch) fail(error);
      return;
    }
    if (epoch !== myEpoch) return; // interrupt / reset 已清理，静默放弃
    try {
      currentUrl = deps.createObjectUrl(blob);
      host.setSpeakingStage('playing');
      const handle = deps.play(currentUrl);
      currentHandle = handle;
      try {
        await handle.ended;
      } finally {
        if (currentHandle === handle) currentHandle = null;
      }
    } catch (error) {
      if (epoch === myEpoch) {
        fail(error); // fail 内 stopCurrent 会 revoke currentUrl
        return;
      }
    }
    // 自然播完（epoch 没变；被打断时 interrupt 已 stop + revoke，这里不重复）。
    if (epoch === myEpoch) {
      if (currentUrl !== null) {
        deps.revokeObjectUrl(currentUrl);
        currentUrl = null;
      }
      if (host.phase === 'speaking') host.exitSpeaking();
    }
  };

  const pump = (): void => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    const loop = async (): Promise<void> => {
      for (;;) {
        if (!host.active || host.phase !== 'idle' || stopped || queue.length === 0) return;
        const entry = queue.shift();
        if (entry === undefined) return;
        await runOne(entry);
      }
    };
    void loop().finally(() => {
      pumping = false;
      if (pumpAgain) {
        pumpAgain = false;
        pump(); // 排队期间又有触发（如 stale 迭代作废后新消息已入队）
      }
    });
  };

  return {
    enqueue(entry) {
      // 未开启不入队（进入模式不补播历史：队列为空的另一重保险）。
      if (!host.active) return false;
      if (entry.text.trim().length === 0) return false;
      if (seenIds.has(entry.id)) return false;
      seenIds.add(entry.id);
      queue.push(entry);
      stopped = false; // 失败停队后新消息到来重新开始
      pump();
      return true;
    },
    pump,
    interrupt() {
      epoch += 1;
      stopCurrent();
      queue = []; // 插话作废：被作废的回复只留文字，不再补播
    },
    reset() {
      epoch += 1;
      stopCurrent();
      queue = [];
      seenIds.clear();
      stopped = false;
    },
  };
}

class VoiceModeState implements AnnounceHost {
  /** 语音条是否接管输入坞（入口即开关，53 号 D106）。 */
  active = $state(false);
  phase = $state<VoiceUiPhase>('idle');
  /** speaking 的两阶段（53 号：合成中 Loader / 播放中波形）；非 speaking 态为 null。 */
  speakingStage = $state<SpeakingStage | null>(null);
  /**
   * 转写已落定、发送（上传 / sendGuard 排队 / settle+send）进行中：transcribing
   * 态的文案从「识别中…」切到「发送中…」（voice-send 的 onSending 钩子置位）。
   */
  sending = $state(false);
  /** 实时电平（0..1，已经 voice-recorder 的 levelToHeight 映射），驱动波形。 */
  level = $state(0);
  /** 录音计时（ms；VoiceModeBar 的 interval 驱动，200ms 对齐文字录音胶囊）。 */
  elapsedMs = $state(0);
  /** 本次录音起点（Date.now()），elapsedMs 的基准。 */
  recordingStartedAt = $state(0);
  #announcer: AnnounceController | null = null;

  enter(): void {
    this.active = true;
    this.#reset();
  }

  /** 幂等：未开启时同样复位（组件卸载 cleanup 直接调用）。 */
  exit(): void {
    this.active = false;
    this.#announcer?.reset();
    this.#reset();
  }

  /** 按纯转移表推进；进 recording 时起表（电平 / 计时清零）。 */
  dispatch(event: VoiceUiEvent): void {
    const next = nextVoicePhase(this.phase, event);
    if (next === null) return;
    if (next === 'recording') {
      this.level = 0;
      this.elapsedMs = 0;
      this.recordingStartedAt = Date.now();
    }
    if (event === 'speech-started') this.speakingStage = 'synthesizing';
    // settled 从 speaking 收尾是防御路径（接线里 speaking 不会被 settled 触达），
    // 万一发生同样要把播报停掉，不留僵尸播放。
    if (this.phase === 'speaking' && event === 'settled') this.#announcer?.interrupt();
    if (this.phase === 'speaking') this.speakingStage = null;
    if (this.phase === 'transcribing' && next === 'idle') this.sending = false;
    this.phase = next;
    // 回 idle = 可能要继续消费队列（转写收尾 / 一条播完）。
    if (next === 'idle') this.#announcer?.pump();
  }

  /**
   * 注入播报依赖（Composer 挂载时接线 core / objectURL / Audio / 失败 toast）。
   * 重复注入（主聊天与卡片对话两个 Composer）时先清理旧实例再替换。reset 只
   * 停音频清队（runOne 的收尾被 epoch 作废跳过，没人派发 speech-ended），所以
   * 替换前把卡在 speaking 的相位手动复位——否则新实例接管时 UI 永远停在播报中。
   */
  attachAnnouncer(deps: AnnounceDeps): void {
    this.#announcer?.reset();
    if (this.phase === 'speaking') this.dispatch('speech-ended');
    this.#announcer = createAnnounceQueue(this, deps);
  }

  /** 入队一条播报（订阅口收到可见 bot 文本时由接线方调用）。 */
  announce(entry: AnnounceEntry): boolean {
    return this.#announcer?.enqueue(entry) ?? false;
  }

  /**
   * 打断播报（停当前 + 清未播队列）并回 idle。只在**拿到麦克风流之后**调
   * （53 号风险 #1：TCC 弹框等待期不打断）；非 speaking 态 no-op（idle 路径
   * 复用同一条录音链路时无需分支）。
   */
  interruptSpeech(): void {
    if (this.phase !== 'speaking') return;
    this.#announcer?.interrupt();
    this.dispatch('speech-ended');
  }

  // --- AnnounceHost ---------------------------------------------------------

  enterSpeaking(): void {
    this.dispatch('speech-started');
  }

  setSpeakingStage(stage: SpeakingStage): void {
    if (this.phase === 'speaking') this.speakingStage = stage;
  }

  exitSpeaking(): void {
    this.dispatch('speech-ended');
  }

  #reset(): void {
    this.phase = 'idle';
    this.speakingStage = null;
    this.sending = false;
    this.level = 0;
    this.elapsedMs = 0;
    this.recordingStartedAt = 0;
  }
}

export const voiceMode = new VoiceModeState();

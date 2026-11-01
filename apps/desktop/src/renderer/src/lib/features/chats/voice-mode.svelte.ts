/**
 * 语音对话模式的 UI 状态机与 Bot 播报队列（docs/design/53-voice-conversation.md，D106）。
 *
 * 会话内即时态：进入即开启、关闭即退出，不持久化、不跨会话（切换会话 /
 * 组件卸载由 Composer 的 effect 调 exit()）。本模块只持 UI 状态、纯转移表、
 * 端点检测状态机（修订 v2 V2-4：静音自动发送）与播报队列（单测锚点）；录音
 * 传感器链路 / 转写 / 发送编排 / 自动收尾计时器在 Composer（26 号
 * 「语音消息语义」），播报的音频依赖（speech-audio 缓存 + 播放仲裁，修订 v2
 * V2-3）由 Composer 注入（attachAnnouncer）——本文件不 import core / DOM，
 * 保持可纯逻辑单测。
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

// --- 端点检测（docs/design/53-voice-conversation.md 修订 v2 V2-4：静音自动发送）

/**
 * 电平阈值（0..1，已经 voice-recorder 的 levelToHeight 映射）：正常说话电平
 * 明显高于静音底噪；真机可调。
 */
export const SPEECH_LEVEL_THRESHOLD = 0.2;
/** 电平 ≥ 阈值持续此时长才记「已说话」：单帧噪声尖峰不算（连续段被尖峰打断即重计）。 */
export const SPEECH_SUSTAIN_MS = 250;
/**
 * 已说话后静音持续此时长 → 待发送子态（53 号 V2-4：业界端点 500–800ms，
 * 此处取长换「可见的发送确认」，常量可调）。
 */
export const SILENCE_TO_SEND_MS = 3000;
/**
 * 待发送态无操作此时长后自动发送：用户停止说话后 5s 内内容必然发出
 * （3s 静音判定 + 2s 倒计时）。
 */
export const AUTO_SEND_DELAY_MS = 2000;
/** 从未检测到语音持续此时长 → 自动取消录音（不干等 60s 上限）。 */
export const NO_SPEECH_CANCEL_MS = 5000;

/** 端点状态机的一次性信号（VoiceModeState.feedLevel 返回，Composer 据此接计时器与自动收尾）。 */
export type VoiceEndpointSignal =
  /** 电平首次持续 ≥ 阈值（hasSpoken false→true，只发一次）。 */
  | 'speech-detected'
  /** 已说话后静音持续 3s → 进入待发送（sendReady false→true）。 */
  | 'send-ready'
  /** 待发送中重新开口 → 退回普通录音（sendReady true→false，撤倒计时）。 */
  | 'speech-resumed'
  /** 从未说话且录音已满 5s → 自动取消（只发一次）。 */
  | 'no-speech';

/**
 * 端点状态机的簿记（连续段追踪）：hasSpoken / sendReady 在 store 上有响应式
 * 镜像供 UI 派生，段起点等中间量不进界面，保持普通对象（纯函数进出）。
 */
export interface VoiceEndpointState {
  /** 本次录音已检测到有效语音（≥ 阈值连续 250ms）。 */
  hasSpoken: boolean;
  /** 待发送子态（hasSpoken 后静音 ≥ 3s）；只在 recording 相位有意义。 */
  sendReady: boolean;
  /** 当前连续段（同在阈值一侧）的起点时刻；null = 还没有样本。 */
  segmentStartedAt: number | null;
  /** 当前段是否在阈值之上。 */
  segmentAbove: boolean;
  /** no-speech 信号已发过（只发一次的台账）。 */
  noSpeechSignaled: boolean;
}

export function initialEndpointState(): VoiceEndpointState {
  return {
    hasSpoken: false,
    sendReady: false,
    segmentStartedAt: null,
    segmentAbove: false,
    noSpeechSignaled: false,
  };
}

/**
 * 纯端点状态机（修订 v2 V2-4）：逐帧喂入映射电平与当前时刻（onLevel 已有
 * ~50ms 节流；worklet 静音帧照发，静音段计时可靠）。按「连续段」判定——
 * 电平跨阈值即重置段起点，天然排除单帧尖峰：
 *
 * - 阈值之上连续 250ms → hasSpoken（'speech-detected'，只发一次）；
 * - hasSpoken 后阈值之下连续 3s → sendReady（'send-ready'）；
 * - sendReady 中任一帧重新 ≥ 阈值 → 退回普通录音（'speech-resumed'）。此处
 *   刻意不做 250ms 持续确认：倒计时只有 2s，等持续确认的话用户在倒计时尾部
 *   开口会被自动发送截断；误退回的代价只是再等 3s 静音，取安全侧；
 * - 全程未说话且录音时长 ≥ 5s → 'no-speech'（只发一次；自动取消由接线方执行）。
 */
export function feedEndpointLevel(
  prev: VoiceEndpointState,
  level: number,
  nowMs: number,
  recordingStartedMs: number,
): { state: VoiceEndpointState; signal: VoiceEndpointSignal | null } {
  const above = level >= SPEECH_LEVEL_THRESHOLD;
  let state = prev;
  // 跨阈值（或首个样本）：连续段重新起算。
  const prevSegmentStart = state.segmentStartedAt;
  const switched = prevSegmentStart === null || state.segmentAbove !== above;
  const segmentStartedAt = switched ? nowMs : prevSegmentStart;
  if (switched) state = { ...state, segmentStartedAt: nowMs, segmentAbove: above };
  const segmentMs = nowMs - segmentStartedAt;
  let signal: VoiceEndpointSignal | null = null;

  if (!state.hasSpoken && above && segmentMs >= SPEECH_SUSTAIN_MS) {
    state = { ...state, hasSpoken: true };
    signal = 'speech-detected';
  }
  if (state.sendReady && above) {
    state = { ...state, sendReady: false };
    signal ??= 'speech-resumed';
  }
  if (state.hasSpoken && !state.sendReady && !above && segmentMs >= SILENCE_TO_SEND_MS) {
    state = { ...state, sendReady: true };
    signal ??= 'send-ready';
  }
  if (
    !state.hasSpoken &&
    !state.noSpeechSignaled &&
    nowMs - recordingStartedMs >= NO_SPEECH_CANCEL_MS
  ) {
    state = { ...state, noSpeechSignaled: true };
    signal ??= 'no-speech';
  }
  return { state, signal };
}

/**
 * 待发送倒计时簿记（修订 v2 V2-4）：2s 自动发送这一个一次性计时器的武装 /
 * 撤销集中为纯逻辑（schedule / cancel 注入，Composer 传 setTimeout /
 * clearTimeout，测试传假实现）。arm 先撤旧（重复信号不叠加计时器），到期回调
 * 触发后句柄自清（之后再 disarm 是无害 no-op）。Composer 在 stop / cancel /
 * exit / 卸载全部收尾路径上调 disarm——「无残留计时器」由调用点的齐备性保证
 * （与 maxRecordingTimer 同一套路径）。
 */
export function createAutoSendCountdown(deps: {
  schedule(handler: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  fire(): void;
}) {
  let handle: unknown = null;
  return {
    /** 是否有在途倒计时（测试与断言用）。 */
    armed(): boolean {
      return handle !== null;
    },
    arm(): void {
      this.disarm();
      handle = deps.schedule(() => {
        handle = null;
        deps.fire();
      }, AUTO_SEND_DELAY_MS);
    },
    disarm(): void {
      if (handle === null) return;
      deps.cancel(handle);
      handle = null;
    },
  };
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
 * 列表记的」，风险 #3）。`origin: 'task'` 的可见说明（任务侧消息：
 * forward_task_result 转发结果与任务 run 内 send_message / send_media 的可见
 * 说明，D75）只供阅读不播报（53 号修订 v2 V2-1）。返回 null = 不入队。
 */
export function announceEntryFor(message: Message, context: AnnounceContext): AnnounceEntry | null {
  if (!context.active) return null;
  if (context.conversationId === null || message.conversationId !== context.conversationId) {
    return null;
  }
  if (message.senderType !== 'bot' || message.kind !== 'text') return null;
  if (!('text' in message.content) || message.content.text.trim().length === 0) return null;
  if ((message.content as { origin?: string }).origin === 'task') return null;
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

/** 播报队列的可注入依赖（音频经 speech-audio 缓存与仲裁；测试用假实现）。 */
export interface AnnounceDeps {
  /**
   * messageId + 朗读文本 → objectURL（speech-audio 缓存未命中才合成，53 号
   * 修订 v2 V2-3；缓存与手动朗读共享）。失败 reject → 第一条失败停队路径。
   */
  resolveAudio(messageId: string, text: string): Promise<string>;
  /**
   * objectURL → 播放（仲裁在 speech-audio：播报与手动朗读互斥）。自然播完
   * resolve、出错 reject、stop() 立停；被新播放抢占时 onPreempted **先**触发
   * （队列据此作废剩余队列）再 resolve ended。objectURL 归缓存管，播完不
   * revoke（修订 v2 V2-3：播报音频可回放）。
   */
  play(input: { messageId: string; audio: string; onPreempted: () => void }): PlaybackHandle;
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
  /** 退出 / 切会话清理：停当前 + 清队（objectURL 归缓存管，不 revoke）。 */
  reset(): void;
}

/**
 * 顺序播报队列（53 号）：一次一条——经 speech-audio 取音频（缓存未命中才
 * 合成）→ 播放 → ended 取下一条；objectURL 归缓存管，播完不 revoke（修订 v2
 * V2-3）。宿主不在 idle（recording / transcribing）时入队暂播、回 idle 按序
 * 播；第一条失败即停队（不自动重试，新消息到来重新开始）；interrupt / reset
 * 用 epoch 作废在途迭代（合成落地后不再播放）；被手动朗读抢占（onPreempted）
 * 走同一条作废路径清队回 idle。
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
  /** 作废计数：interrupt / reset / 失败 / 被抢占时 +1，在途迭代的每个 await 后核对。 */
  let epoch = 0;
  let pumping = false;
  let pumpAgain = false;
  let currentHandle: PlaybackHandle | null = null;

  /** 停当前播放（音频归 speech-audio 仲裁；缓存条目保留）。 */
  const stopCurrent = (): void => {
    currentHandle?.stop();
    currentHandle = null;
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

  /** 消费一条：取音频（缓存→合成）→ 播放 → ended；任何一步出错走 fail。 */
  const runOne = async (entry: AnnounceEntry): Promise<void> => {
    host.enterSpeaking();
    const myEpoch = epoch;
    let url: string;
    try {
      url = await deps.resolveAudio(entry.id, entry.text);
    } catch (error) {
      if (epoch === myEpoch) fail(error);
      return;
    }
    if (epoch !== myEpoch) return; // interrupt / reset 已清理，静默放弃（URL 归缓存）
    let preempted = false;
    try {
      host.setSpeakingStage('playing');
      const handle = deps.play({
        messageId: entry.id,
        audio: url,
        onPreempted: () => {
          // 手动朗读抢占了本条播报：与插话打断同路径——作废迭代 + 清队（缓
          // 存里的音频保留，扬声器让给朗读侧）。
          preempted = true;
          if (epoch === myEpoch) {
            epoch += 1;
            queue = [];
          }
        },
      });
      currentHandle = handle;
      try {
        await handle.ended;
      } finally {
        if (currentHandle === handle) currentHandle = null;
      }
    } catch (error) {
      if (epoch === myEpoch) {
        fail(error);
        return;
      }
    }
    // 自然播完（epoch 未变）回 idle 续取下一条；被朗读抢占（epoch 已作废）只回
    // idle——插话打断 / 退出的收尾由 interrupt / reset 自己派发，不在这里重复。
    if (epoch !== myEpoch) {
      if (preempted && host.phase === 'speaking') host.exitSpeaking();
      return;
    }
    if (host.phase === 'speaking') host.exitSpeaking();
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
  /**
   * 端点检测（修订 v2 V2-4）：本次录音已检测到有效语音。hasSpoken / sendReady
   * 是 #endpoint 的响应式镜像，与 level / elapsedMs 同生命周期——只在 recording
   * 相位有意义，任何相位转移与 enter / exit 都清零。
   */
  hasSpoken = $state(false);
  /** 待发送子态：绿键（Send）与 2s 自动发送倒计时由它驱动；非 recording 恒 false。 */
  sendReady = $state(false);
  /**
   * 归属会话（修订 v2 V2-5 审查 P2）：主聊天与卡片对话两个 Composer 可同时
   * 挂载（项目会话的 ProjectView 只 CSS 隐藏聊天体，卡片对话再挂一个），而
   * 本 store 是模块单例——不记归属时隐藏实例也会渲染语音条、武装 barge-in
   * 监听，并可能抢先把录音写进自己的会话。enter 记录、exit 清空；语音条
   * 渲染 / 播报入队 / 武装与全部收尾路径都用 owns() 门禁。
   */
  ownerConversationId = $state<string | null>(null);
  #announcer: AnnounceController | null = null;
  /** 端点状态机簿记（段追踪；非响应式——界面从 hasSpoken / sendReady 派生）。 */
  #endpoint: VoiceEndpointState = initialEndpointState();

  enter(conversationId: string | null = null): void {
    this.active = true;
    this.ownerConversationId = conversationId;
    this.#reset();
  }

  /** 幂等：未开启时同样复位（组件卸载 cleanup 直接调用）。 */
  exit(): void {
    this.active = false;
    this.ownerConversationId = null;
    this.#announcer?.reset();
    this.#reset();
  }

  /**
   * 判断某会话是否接管语音模式：近路给接线方（Composer 的 voiceModeOwned）
   * 统一门禁。owner 未记录（无参 enter 的测试 / 旧路径）视作全局，生产路径
   * 必传会话 id。
   */
  owns(conversationId: string | null): boolean {
    if (!this.active) return false;
    if (this.ownerConversationId === null) return true;
    return conversationId === this.ownerConversationId;
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
    // 端点子态只在 recording 相位有意义（修订 v2 V2-4）：进 recording = 全新
    // 开始，离开 recording（含防御路径）= 待发送 / 已说话标记不残留。recording
    // 期间没有 dispatch（电平喂入走 feedLevel），在转移边界清一次即全覆盖。
    this.#clearEndpoint();
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

  /**
   * 录音电平喂入端点检测（修订 v2 V2-4）：Composer 的 onLevel 回调逐帧调
   * （电平已经 levelToHeight 映射）。仅 recording 相位有效——拿到流与
   * record-started 之间的少量早期帧、以及 stop 之后的尾巴帧都在这里被丢弃。
   * 返回一次性信号（无转移为 null）供 Composer 接自动收尾计时器。
   */
  feedLevel(level: number, nowMs: number): VoiceEndpointSignal | null {
    if (this.phase !== 'recording') return null;
    const { state, signal } = feedEndpointLevel(
      this.#endpoint,
      level,
      nowMs,
      this.recordingStartedAt,
    );
    this.#endpoint = state;
    this.hasSpoken = state.hasSpoken;
    this.sendReady = state.sendReady;
    return signal;
  }

  #clearEndpoint(): void {
    this.#endpoint = initialEndpointState();
    this.hasSpoken = false;
    this.sendReady = false;
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
    this.#clearEndpoint();
  }
}

export const voiceMode = new VoiceModeState();

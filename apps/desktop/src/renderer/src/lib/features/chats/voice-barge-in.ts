/**
 * 播报中语音打断（barge-in，docs/design/53-voice-conversation.md 修订 v2 V2-5）：
 * Bot 播报**播放中**用户开口说话 → 停播清队并转入录音输入。
 *
 * 职责切分（与 voice-mode 零 DOM import 的房屋模式一致）：本模块只做武装 /
 * 拆除 / 一次性触发的纯逻辑状态机（单测锚点）；DOM 侧——`sensors.open
 * ('microphone')` 开流（复用传感器层，隐私总闸关闭时 hub 会统一停流）、
 * AudioContext + AnalyserNode 的 RMS 读取、levelToHeight 电平映射——由
 * Composer 注入（BargeInSession）。监听窗口由 Composer 的一条响应式效果持有：
 * 仅播报队列 playing 阶段武装（合成中无声音不监听；手动朗读开播即打断播报、
 * 相位已不在 speaking，天然不监听），播放结束 / 打断 / 清队 / 退出模式 /
 * 切会话 / 组件卸载全路径经该效果 cleanup 拆除。
 *
 * 时序（常量真机可调）：播放开始 ~500ms 后才真正开流监听（规避 AEC 收敛期把
 * 扬声器 TTS 泄漏当成插话）；电平 ≥ SPEECH_LEVEL_THRESHOLD（与录音端点检测
 * 同一阈值，0..1 的 levelToHeight 映射口径）持续 ~200ms 判定用户开口 → 自拆
 * 监听 + 一次性回调（Composer：interruptSpeech 停播清队 → acquireRecording 走
 * 与点麦克风同一条录音链路）。开流失败（权限 / 设备忙）静默放弃本次监听——
 * 不打 toast、不影响播报，点麦克风打断始终可用。
 *
 * 电平只喂本模块的触发判定，不进 voice-mode 的 feedLevel（端点检测仅在
 * recording 相位生效，天然隔离，修订 v2 V2-5）。
 */

import { SPEECH_LEVEL_THRESHOLD } from './voice-mode.svelte';

/** 播放开始到真正开流监听的延迟：规避 AEC 收敛期泄漏（把自己的 TTS 当插话），真机可调。 */
export const BARGE_IN_ARM_DELAY_MS = 500;
/** 电平 ≥ 阈值持续此时长才判定用户开口：过滤单帧噪声与 TTS 尾音泄漏，真机可调。 */
export const BARGE_IN_SUSTAIN_MS = 200;
/** 电平轮询间隔（RMS 采样节拍；与录音 onLevel 的 ~50ms 节流同量级）。 */
export const BARGE_IN_POLL_MS = 100;

/**
 * 一次监听会话（DOM 实现 = 麦克风流 + AudioContext/AnalyserNode，Composer
 * 接线；测试注入假会话）。close 必须幂等安全——拆除路径（自然播完 / 打断 /
 * 退出 / 迟到的 open 落地）都会走到。
 */
export interface BargeInSession {
  /** 当前映射电平（0..1，levelToHeight 口径，与 SPEECH_LEVEL_THRESHOLD 同一单位）。 */
  readLevel(): number;
  /** 释放监听资源（停轨道 + 关 AudioContext）。 */
  close(): void;
}

/** 计时器注入（Composer 传 setTimeout / setInterval；测试用假实现手动推进）。 */
export interface BargeInTimers {
  /** setTimeout 语义；返回撤销函数。 */
  timeout(delayMs: number, handler: () => void): () => void;
  /** setInterval 语义；返回撤销函数。 */
  interval(intervalMs: number, handler: () => void): () => void;
}

export interface BargeInDeps {
  timers: BargeInTimers;
  /** 时钟（毫秒）：连续段时长按它计。 */
  now(): number;
  /** 开一路监听流；reject = 开流失败（监听侧静默放弃本次监听）。 */
  open(): Promise<BargeInSession>;
  /** 一次性触发回调（Composer：停播清队 + acquireRecording）。自拆之后才调。 */
  onTrigger(): void;
}

/** 监听状态机阶段：arming = 武装定时器未到点（含 open 在途）/ listening = 电平轮询中。 */
export type BargeInStage = 'idle' | 'arming' | 'listening';

/**
 * barge-in 监听状态机（纯逻辑，依赖全注入）。一次性：触发即自拆（先拆除、后
 * 回调——回调里做停播与录音衔接时监听已不在，不会重复触发）；disarm 幂等，
 * 拆除后可对下一个 playing 阶段重新 arm。拆除覆盖三类资源：未到点的武装定时
 * 器、在途的 open（世代号作废，迟到的会话落地即释放）、开着的轮询与会话。
 */
export function createBargeInMonitor(deps: BargeInDeps) {
  let stage: BargeInStage = 'idle';
  /** 未到点的武装定时器撤销函数（null = 无在途）。 */
  let cancelArm: (() => void) | null = null;
  /** 电平轮询撤销函数（null = 未在轮询）。 */
  let cancelPoll: (() => void) | null = null;
  let session: BargeInSession | null = null;
  /** 连续 ≥ 阈值段的起点时刻（null = 当前在阈值之下）。 */
  let aboveSinceMs: number | null = null;
  /**
   * open 世代：每次 disarm +1。拆除后才落地的 open 据此识别自己已过期，立即
   * close、不接管监听（否则退出模式后残留一路麦克风流）。
   */
  let openToken = 0;

  /** 拆除监听本体（轮询 + 会话 + 连续段簿记）；不动武装定时器。 */
  const teardownListener = (): void => {
    cancelPoll?.();
    cancelPoll = null;
    session?.close();
    session = null;
    aboveSinceMs = null;
  };

  /** 全路径拆除：取消未到点武装 / 在途 open / 轮询 / 会话，回 idle。幂等。 */
  const disarm = (): void => {
    openToken += 1;
    cancelArm?.();
    cancelArm = null;
    teardownListener();
    stage = 'idle';
  };

  /** 轮询一帧：≥ 阈值持续 BARGE_IN_SUSTAIN_MS → 自拆 + 一次性触发；断续重计。 */
  const poll = (): void => {
    const current = session;
    if (current === null || stage !== 'listening') return;
    const nowMs = deps.now();
    if (current.readLevel() >= SPEECH_LEVEL_THRESHOLD) {
      if (aboveSinceMs === null) {
        aboveSinceMs = nowMs;
        return;
      }
      if (nowMs - aboveSinceMs < BARGE_IN_SUSTAIN_MS) return;
      disarm(); // 一次性：触发即自拆；接线效果的 cleanup 再兜一层幂等拆除
      deps.onTrigger();
    } else {
      aboveSinceMs = null;
    }
  };

  /** 开流并接管监听；失败静默放弃（回 idle 让下一个 playing 阶段可再武装）。 */
  const beginListening = (): void => {
    const token = openToken;
    const onOpened = (opened: BargeInSession): void => {
      if (token !== openToken || stage === 'idle') {
        opened.close(); // 拆除后才落地：立即释放，不留孤儿流
        return;
      }
      session = opened;
      stage = 'listening';
      aboveSinceMs = null;
      cancelPoll = deps.timers.interval(BARGE_IN_POLL_MS, poll);
    };
    const onFailed = (): void => {
      // 开流失败（权限 / 设备忙）：静默放弃本次监听——不 toast、不影响播报，
      // 点麦克风打断始终可用（53 号修订 v2 V2-5）。
      if (token === openToken) stage = 'idle';
    };
    // 同步抛错（依赖方实现非 Promise 时的防御）：与 reject 同一降级路径，不让
    // 异常从定时器回调里逃逸。
    try {
      deps.open().then(onOpened, onFailed);
    } catch {
      onFailed();
    }
  };

  return {
    /** 武装（playing 阶段开始时调）：延迟 BARGE_IN_ARM_DELAY_MS 后开流监听。已武装 / 监听中不重入。 */
    arm(): void {
      if (stage !== 'idle') return;
      stage = 'arming';
      cancelArm = deps.timers.timeout(BARGE_IN_ARM_DELAY_MS, () => {
        cancelArm = null;
        if (stage !== 'arming') return; // 到点前已被拆除（播放早停等）
        beginListening();
      });
    },
    disarm,
    /** 当前阶段（测试与断言用）。 */
    stage(): BargeInStage {
      return stage;
    },
  };
}

import { describe, expect, it } from 'vitest';
import {
  AUTO_SEND_DELAY_MS,
  NO_SPEECH_CANCEL_MS,
  SILENCE_TO_SEND_MS,
  SPEECH_LEVEL_THRESHOLD,
  SPEECH_SUSTAIN_MS,
  createAutoSendCountdown,
  escapeActionForVoiceMode,
  feedEndpointLevel,
  initialEndpointState,
  micIntentFor,
  nextVoicePhase,
  voiceMode,
  type VoiceEndpointSignal,
  type VoiceEndpointState,
} from './voice-mode.svelte';

/**
 * 语音对话模式的 UI 状态机（docs/design/53-voice-conversation.md 交互状态机）：
 * 纯转移表 + Esc 分档 + 麦克风键意图 + store 的进入/退出复位。录音传感器链路
 * 与转写发送编排在 Composer（需真实麦克风 / core，不在单测内）；播报队列
 * （speech-started / speech-ended 的消费侧）在 voice-announce.svelte.test.ts；
 * 端点检测（修订 v2 V2-4：静音自动发送）的纯状态机与 2s 自动发送倒计时簿记
 * 在下方「端点检测」分段——Composer 只接信号（arm / disarm / 自动取消）。
 */

const ALL_PHASES = ['idle', 'recording', 'transcribing', 'speaking'] as const;
const ALL_EVENTS = [
  'record-started',
  'stop-requested',
  'settled',
  'speech-started',
  'speech-ended',
] as const;

describe('nextVoicePhase（四态转移表）', () => {
  it('record-started：只有 idle 接受（拿到流才进 recording；TCC 等待期不动）', () => {
    expect(nextVoicePhase('idle', 'record-started')).toBe('recording');
    expect(nextVoicePhase('recording', 'record-started')).toBeNull();
    expect(nextVoicePhase('transcribing', 'record-started')).toBeNull();
    expect(nextVoicePhase('speaking', 'record-started')).toBeNull();
  });

  it('stop-requested：recording → transcribing；其余态忽略（识别中再按停止不重入）', () => {
    expect(nextVoicePhase('recording', 'stop-requested')).toBe('transcribing');
    expect(nextVoicePhase('idle', 'stop-requested')).toBeNull();
    expect(nextVoicePhase('transcribing', 'stop-requested')).toBeNull();
    expect(nextVoicePhase('speaking', 'stop-requested')).toBeNull();
  });

  it('settled：非 idle 一律回 idle（发送收尾 / 取消丢弃）；idle 忽略', () => {
    expect(nextVoicePhase('recording', 'settled')).toBe('idle');
    expect(nextVoicePhase('transcribing', 'settled')).toBe('idle');
    expect(nextVoicePhase('speaking', 'settled')).toBe('idle');
    expect(nextVoicePhase('idle', 'settled')).toBeNull();
  });

  it('speech-started / speech-ended：idle ⇄ speaking（WP3 播报队列驱动）', () => {
    expect(nextVoicePhase('idle', 'speech-started')).toBe('speaking');
    expect(nextVoicePhase('recording', 'speech-started')).toBeNull(); // 录音中不播
    expect(nextVoicePhase('transcribing', 'speech-started')).toBeNull(); // 识别中不播
    expect(nextVoicePhase('speaking', 'speech-started')).toBeNull(); // 一次一条不重入
    expect(nextVoicePhase('speaking', 'speech-ended')).toBe('idle');
    expect(nextVoicePhase('idle', 'speech-ended')).toBeNull();
    expect(nextVoicePhase('recording', 'speech-ended')).toBeNull();
  });

  it('全表覆盖：每个 (phase, event) 组合都有定义（switch 穷尽，无 undefined）', () => {
    for (const phase of ALL_PHASES) {
      for (const event of ALL_EVENTS) {
        const next = nextVoicePhase(phase, event);
        expect(next === null || ALL_PHASES.includes(next)).toBe(true);
      }
    }
  });
});

describe('Esc 分档与麦克风键意图（53 号）', () => {
  it('recording 中 Esc 取消录音，其余态退出语音模式', () => {
    expect(escapeActionForVoiceMode('recording')).toBe('cancel-recording');
    expect(escapeActionForVoiceMode('idle')).toBe('exit-voice-mode');
    expect(escapeActionForVoiceMode('transcribing')).toBe('exit-voice-mode');
    expect(escapeActionForVoiceMode('speaking')).toBe('exit-voice-mode');
  });

  it('麦克风键：idle 开始 / recording 停止发送 / transcribing 禁用 / speaking 打断（WP3）', () => {
    expect(micIntentFor('idle')).toBe('start');
    expect(micIntentFor('recording')).toBe('stop-send');
    expect(micIntentFor('transcribing')).toBe('disabled');
    expect(micIntentFor('speaking')).toBe('interrupt');
  });
});

describe('voiceMode store', () => {
  it('enter 重置为 idle；record-started 进 recording 并起表；exit 复位', () => {
    voiceMode.enter();
    expect(voiceMode.active).toBe(true);
    expect(voiceMode.phase).toBe('idle');

    voiceMode.level = 0.8;
    voiceMode.elapsedMs = 9999;
    voiceMode.enter();
    expect(voiceMode.level).toBe(0);
    expect(voiceMode.elapsedMs).toBe(0);

    voiceMode.dispatch('record-started');
    expect(voiceMode.phase).toBe('recording');
    expect(voiceMode.recordingStartedAt).toBeGreaterThan(0);
    expect(voiceMode.elapsedMs).toBe(0);

    voiceMode.exit();
    expect(voiceMode.active).toBe(false);
    expect(voiceMode.phase).toBe('idle');
    expect(voiceMode.recordingStartedAt).toBe(0);
  });

  it('dispatch 走转移表：非法转移被忽略，store 端到端保持一致', () => {
    voiceMode.enter();
    // idle 下 stop-requested 无效。
    voiceMode.dispatch('stop-requested');
    expect(voiceMode.phase).toBe('idle');
    // 完整一圈：录制 → 停止转写 → 收尾。
    voiceMode.dispatch('record-started');
    voiceMode.dispatch('stop-requested');
    expect(voiceMode.phase).toBe('transcribing');
    voiceMode.dispatch('stop-requested');
    expect(voiceMode.phase).toBe('transcribing');
    voiceMode.dispatch('settled');
    expect(voiceMode.phase).toBe('idle');
    voiceMode.exit();
  });

  it('转写收尾后立即可再录（不等回复）：settled 后 record-started 直达 recording', () => {
    voiceMode.enter();
    voiceMode.dispatch('record-started');
    voiceMode.dispatch('stop-requested');
    voiceMode.dispatch('settled');
    voiceMode.dispatch('record-started');
    expect(voiceMode.phase).toBe('recording');
    voiceMode.exit();
  });

  it('speech 两事件驱动 store：speakingStage 起步 synthesizing、播完清空回 idle', () => {
    voiceMode.enter();
    voiceMode.dispatch('speech-started');
    expect(voiceMode.phase).toBe('speaking');
    expect(voiceMode.speakingStage).toBe('synthesizing');
    voiceMode.setSpeakingStage('playing');
    expect(voiceMode.speakingStage).toBe('playing');
    voiceMode.dispatch('speech-ended');
    expect(voiceMode.phase).toBe('idle');
    expect(voiceMode.speakingStage).toBeNull();
    voiceMode.exit();
  });

  it('setSpeakingStage 只在 speaking 态生效（防御）', () => {
    voiceMode.enter();
    voiceMode.setSpeakingStage('playing');
    expect(voiceMode.speakingStage).toBeNull();
    voiceMode.exit();
  });

  it('interruptSpeech：speaking 态回 idle，其余态 no-op', () => {
    voiceMode.enter();
    voiceMode.interruptSpeech(); // idle：no-op
    expect(voiceMode.phase).toBe('idle');
    voiceMode.dispatch('speech-started');
    voiceMode.interruptSpeech();
    expect(voiceMode.phase).toBe('idle');
    voiceMode.exit();
  });

  it('sending 标志：transcribing 收尾（settled）时复位', () => {
    voiceMode.enter();
    voiceMode.dispatch('record-started');
    voiceMode.dispatch('stop-requested');
    voiceMode.sending = true;
    voiceMode.dispatch('settled');
    expect(voiceMode.sending).toBe(false);
    voiceMode.exit();
  });

  it('enter/exit 复位 speakingStage 与 sending', () => {
    voiceMode.enter();
    voiceMode.dispatch('speech-started');
    voiceMode.sending = true;
    voiceMode.exit();
    expect(voiceMode.speakingStage).toBeNull();
    expect(voiceMode.sending).toBe(false);
  });
});

// --- 端点检测（修订 v2 V2-4：静音自动发送）----------------------------------

/** 电平喂入节拍：onLevel 实际 ~50ms 一帧（voice-recorder 节流），测试同拍推进。 */
const TICK = 50;
/** 测试电平：hi = 正常说话（≥ 阈值），lo = 静音底噪（< 阈值）。 */
const HI = SPEECH_LEVEL_THRESHOLD + 0.3;
const LO = SPEECH_LEVEL_THRESHOLD - 0.1;

/** 逐帧喂入驱动：samples = [电平, 时刻]；返回最终状态与收到的一次性信号序列。 */
function feedAll(
  start: VoiceEndpointState,
  samples: Array<[level: number, nowMs: number]>,
  recordingStartedMs = 0,
): { state: VoiceEndpointState; signals: VoiceEndpointSignal[] } {
  let state = start;
  const signals: VoiceEndpointSignal[] = [];
  for (const [level, nowMs] of samples) {
    const next = feedEndpointLevel(state, level, nowMs, recordingStartedMs);
    state = next.state;
    if (next.signal !== null) signals.push(next.signal);
  }
  return { state, signals };
}

function runEndpoint(
  samples: Array<[level: number, nowMs: number]>,
  recordingStartedMs = 0,
): { state: VoiceEndpointState; signals: VoiceEndpointSignal[] } {
  return feedAll(initialEndpointState(), samples, recordingStartedMs);
}

/** 从 fromMs 起每 TICK 一帧的等电平序列。 */
function run(level: number, count: number, fromMs: number): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => [level, fromMs + i * TICK] as [number, number]);
}

describe('端点检测边界常量（53 号 V2-4 规格）', () => {
  it('说话持续 / 静音判定 / 自动发送 / 未说话取消的时长与阈值', () => {
    expect(SPEECH_LEVEL_THRESHOLD).toBe(0.2);
    expect(SPEECH_SUSTAIN_MS).toBe(250);
    expect(SILENCE_TO_SEND_MS).toBe(3000);
    expect(AUTO_SEND_DELAY_MS).toBe(2000);
    expect(NO_SPEECH_CANCEL_MS).toBe(5000);
  });
});

describe('feedEndpointLevel（端点状态机纯函数）', () => {
  it('持续说话 250ms 记已说话，且只发一次 speech-detected', () => {
    // 静音 300ms 后开口：段起点 300，300+250=550 那一帧恰好满足持续时长。
    const { state, signals } = runEndpoint([...run(LO, 6, 0), ...run(HI, 8, 300)]);
    expect(signals).toEqual(['speech-detected']);
    expect(state.hasSpoken).toBe(true);
    expect(state.sendReady).toBe(false);
  });

  it('单帧噪声尖峰不算说话（段被尖峰打断即重计持续时长）', () => {
    // 静音 500ms 中插一帧尖峰，随后回到静音：hasSpoken 不成立、无信号。
    const spike = runEndpoint([
      ...run(LO, 10, 0),
      [HI, 500],
      ...run(LO, 8, 550),
      // 再补满 5s：no-speech 也不该被尖峰干扰（按录音起点计）。
      ...run(LO, 3, 950),
    ]);
    expect(spike.signals).toEqual([]);
    expect(spike.state.hasSpoken).toBe(false);
    const untilCancel = feedEndpointLevel(spike.state, LO, NO_SPEECH_CANCEL_MS, 0);
    expect(untilCancel.signal).toBe('no-speech');
  });

  it('已说话后静音 3s → send-ready（恰好 3s 那帧触发，只发一次）', () => {
    // 说话 300..550 判定已说话；600 起静音，600+3000=3600 触发。
    const { state, signals } = runEndpoint([
      ...run(LO, 6, 0),
      ...run(HI, 6, 300),
      ...run(LO, SILENCE_TO_SEND_MS / TICK, 600), // 600..3550：还差 50ms
    ]);
    expect(signals).toEqual(['speech-detected']);
    expect(state.sendReady).toBe(false);
    const boundary = feedEndpointLevel(state, LO, 600 + SILENCE_TO_SEND_MS, 0);
    expect(boundary.signal).toBe('send-ready');
    expect(boundary.state.sendReady).toBe(true);
    // 之后继续静音不再重复发。
    const again = feedEndpointLevel(boundary.state, LO, 600 + SILENCE_TO_SEND_MS + TICK, 0);
    expect(again.signal).toBeNull();
  });

  it('待发送中重新开口 → 立即退回普通录音（hasSpoken 保留），再静音 3s 可再次待发送', () => {
    const first = runEndpoint([
      ...run(LO, 6, 0), // 0..250 静音
      ...run(HI, 6, 300), // 300..550 说话（550 判定已说话）
      ...run(LO, SILENCE_TO_SEND_MS / TICK + 1, 600), // 600..3600 静音（3600 待发送）
    ]);
    expect(first.signals).toEqual(['speech-detected', 'send-ready']);
    // 待发送中第一帧说话即恢复（不等 250ms 持续：倒计时只有 2s，等确认会被
    // 自动发送截断；误退回的代价只是再等 3s 静音）。
    const resumed = feedEndpointLevel(first.state, HI, 600 + SILENCE_TO_SEND_MS + TICK, 0);
    expect(resumed.signal).toBe('speech-resumed');
    expect(resumed.state.sendReady).toBe(false);
    expect(resumed.state.hasSpoken).toBe(true);
    // 再说一阵后停：重新静音满 3s → 再次待发送（循环无次数限制）。
    const second = feedAll(resumed.state, [
      ...run(HI, 6, 600 + SILENCE_TO_SEND_MS + 2 * TICK), // 3700..3950 继续说话
      ...run(LO, SILENCE_TO_SEND_MS / TICK + 1, 4000), // 4000..7000 静音（7000 待发送）
    ]);
    expect(second.signals).toEqual(['send-ready']);
    expect(second.state.sendReady).toBe(true);
  });

  it('全程未说话满 5s → no-speech（只发一次，以录音起点为基准）', () => {
    const { state, signals } = runEndpoint(run(LO, NO_SPEECH_CANCEL_MS / TICK, 0));
    expect(signals).toEqual([]);
    expect(state.noSpeechSignaled).toBe(false);
    const boundary = feedEndpointLevel(state, LO, NO_SPEECH_CANCEL_MS, 0);
    expect(boundary.signal).toBe('no-speech');
    const again = feedEndpointLevel(boundary.state, LO, NO_SPEECH_CANCEL_MS + TICK, 0);
    expect(again.signal).toBeNull(); // 台账只发一次
    expect(again.state.hasSpoken).toBe(false);
  });

  it('5s 前已说话 → 永不触发 no-speech（已说话分支与未说话分支互斥）', () => {
    // 300ms 开口（550 判定），此后一直静音到 10s：只有 detected 与 send-ready。
    const { signals } = runEndpoint([
      ...run(LO, 6, 0),
      ...run(HI, 6, 300),
      ...run(LO, (2 * NO_SPEECH_CANCEL_MS) / TICK, 600),
    ]);
    expect(signals).toEqual(['speech-detected', 'send-ready']);
  });

  it('说话判定压线 5s：no-speech 先于 speech-detected（5s 内没有有效语音即按未说话取消）', () => {
    // 4800 才开口：250ms 持续要到 5050 那帧才成立——5000 的 no-speech 先到
    // （Composer 收到即取消录音；机器层的 speech-detected 随后照发但无人消费）。
    const { state, signals } = runEndpoint([...run(LO, 96, 0), ...run(HI, 5, 4800)]);
    // 0..4750 静音，4800..5000 说话（持续未满 250ms 不判定）。
    expect(signals).toEqual(['no-speech']);
    const at5050 = feedEndpointLevel(state, HI, NO_SPEECH_CANCEL_MS + TICK, 0);
    expect(at5050.signal).toBe('speech-detected');
  });
});

describe('createAutoSendCountdown（2s 自动发送计时簿记）', () => {
  function fakeTimers() {
    const pending = new Map<unknown, () => void>();
    const delays: number[] = [];
    let fired = 0;
    let nextId = 0;
    return {
      schedule: (handler: () => void, delayMs: number): unknown => {
        delays.push(delayMs);
        const handle = ++nextId;
        pending.set(handle, handler);
        return handle;
      },
      cancel: (handle: unknown): void => {
        pending.delete(handle);
      },
      fireAll: (): void => {
        const handlers = [...pending.values()];
        pending.clear();
        for (const handler of handlers) {
          fired += 1;
          handler();
        }
      },
      delays,
      fired: () => fired,
      pendingCount: () => pending.size,
    };
  }

  it('arm 按 AUTO_SEND_DELAY_MS 安排到期回调，触发后句柄自清', () => {
    const timers = fakeTimers();
    const countdown = createAutoSendCountdown({
      schedule: timers.schedule,
      cancel: timers.cancel,
      fire: () => undefined,
    });
    countdown.arm();
    expect(countdown.armed()).toBe(true);
    expect(timers.delays).toEqual([AUTO_SEND_DELAY_MS]);
    timers.fireAll();
    expect(timers.fired()).toBe(1);
    expect(countdown.armed()).toBe(false);
    // 触发后再 disarm：无害（句柄已自清）。
    expect(() => countdown.disarm()).not.toThrow();
  });

  it('到期回调调 fire（Composer 接 stopVoiceModeRecording 的同一停止路径）', () => {
    const timers = fakeTimers();
    let sends = 0;
    const countdown = createAutoSendCountdown({
      schedule: timers.schedule,
      cancel: timers.cancel,
      fire: () => {
        sends += 1;
      },
    });
    countdown.arm();
    timers.fireAll();
    expect(sends).toBe(1);
  });

  it('重复 arm 先撤旧：不叠加多个到期回调', () => {
    const timers = fakeTimers();
    let sends = 0;
    const countdown = createAutoSendCountdown({
      schedule: timers.schedule,
      cancel: timers.cancel,
      fire: () => {
        sends += 1;
      },
    });
    countdown.arm();
    countdown.arm();
    expect(timers.pendingCount()).toBe(1);
    timers.fireAll();
    expect(sends).toBe(1);
  });

  it('disarm 撤销在途倒计时：到期回调不再触发（重新开口 / 全部收尾路径的撤销语义）', () => {
    const timers = fakeTimers();
    let sends = 0;
    const countdown = createAutoSendCountdown({
      schedule: timers.schedule,
      cancel: timers.cancel,
      fire: () => {
        sends += 1;
      },
    });
    countdown.arm();
    countdown.disarm();
    expect(countdown.armed()).toBe(false);
    expect(timers.pendingCount()).toBe(0);
    timers.fireAll();
    expect(sends).toBe(0);
  });
});

describe('voiceMode store × 端点检测（V2-4 接线）', () => {
  it('非 recording 相位喂入无效：返回 null 且不动镜像字段', () => {
    voiceMode.enter();
    expect(voiceMode.feedLevel(HI, 1000)).toBeNull();
    expect(voiceMode.hasSpoken).toBe(false);
    expect(voiceMode.sendReady).toBe(false);
    voiceMode.exit();
  });

  it('feedLevel 推进镜像字段，no-speech 以 recordingStartedAt 为基准', () => {
    voiceMode.enter();
    voiceMode.dispatch('record-started');
    const start = voiceMode.recordingStartedAt;
    // 持续说话：段起点 = start，start+250 那帧判定已说话。
    expect(voiceMode.feedLevel(HI, start)).toBeNull();
    expect(voiceMode.feedLevel(HI, start + SPEECH_SUSTAIN_MS - TICK)).toBeNull();
    expect(voiceMode.feedLevel(HI, start + SPEECH_SUSTAIN_MS)).toBe('speech-detected');
    expect(voiceMode.hasSpoken).toBe(true);
    voiceMode.exit();
    expect(voiceMode.hasSpoken).toBe(false);
  });

  it('待发送后重新开口 → speech-resumed；sendReady 只在 recording 相位为真', () => {
    voiceMode.enter();
    voiceMode.dispatch('record-started');
    const start = voiceMode.recordingStartedAt;
    voiceMode.feedLevel(HI, start);
    voiceMode.feedLevel(HI, start + SPEECH_SUSTAIN_MS);
    // 静音 3s → 待发送。
    let signal: VoiceEndpointSignal | null = null;
    const silenceFrom = start + SPEECH_SUSTAIN_MS + TICK;
    for (let t = silenceFrom; t <= silenceFrom + SILENCE_TO_SEND_MS; t += TICK) {
      const next = voiceMode.feedLevel(LO, t);
      if (next !== null) signal = next;
    }
    expect(signal).toBe('send-ready');
    expect(voiceMode.sendReady).toBe(true);
    // 重新开口 → 退回普通录音。
    expect(voiceMode.feedLevel(HI, silenceFrom + SILENCE_TO_SEND_MS + TICK)).toBe('speech-resumed');
    expect(voiceMode.sendReady).toBe(false);
    // 相位转移清端点：stop-requested / settled 后不残留。
    voiceMode.dispatch('stop-requested');
    expect(voiceMode.phase).toBe('transcribing');
    expect(voiceMode.sendReady).toBe(false);
    expect(voiceMode.hasSpoken).toBe(false);
    expect(voiceMode.feedLevel(HI, silenceFrom + SILENCE_TO_SEND_MS + 2 * TICK)).toBeNull();
    voiceMode.dispatch('settled');
    expect(voiceMode.phase).toBe('idle');
    expect(voiceMode.sendReady).toBe(false);
    voiceMode.exit();
  });

  it('全程未说话满 5s → no-speech 信号（Composer 据此自动取消 + toast）', () => {
    voiceMode.enter();
    voiceMode.dispatch('record-started');
    const start = voiceMode.recordingStartedAt;
    let signal: VoiceEndpointSignal | null = null;
    for (let t = start; t <= start + NO_SPEECH_CANCEL_MS; t += TICK) {
      const next = voiceMode.feedLevel(LO, t);
      if (next !== null) signal = next;
    }
    expect(signal).toBe('no-speech');
    voiceMode.exit();
  });

  it('全新录音从零起算：上一次的已说话 / 待发送不带入下一轮', () => {
    voiceMode.enter();
    voiceMode.dispatch('record-started');
    const start = voiceMode.recordingStartedAt;
    voiceMode.feedLevel(HI, start);
    voiceMode.feedLevel(HI, start + SPEECH_SUSTAIN_MS);
    expect(voiceMode.hasSpoken).toBe(true);
    voiceMode.dispatch('stop-requested');
    voiceMode.dispatch('settled');
    voiceMode.dispatch('record-started');
    expect(voiceMode.hasSpoken).toBe(false);
    expect(voiceMode.sendReady).toBe(false);
    // 重新录音后仍要满 250ms 持续才记已说话。
    const start2 = voiceMode.recordingStartedAt;
    expect(voiceMode.feedLevel(HI, start2)).toBeNull();
    expect(voiceMode.feedLevel(HI, start2 + SPEECH_SUSTAIN_MS - TICK)).toBeNull();
    expect(voiceMode.feedLevel(HI, start2 + SPEECH_SUSTAIN_MS)).toBe('speech-detected');
    voiceMode.exit();
  });
});

describe('归属会话门禁（修订 v2 V2-5 审查 P2：双 Composer 并存）', () => {
  it('enter 记录归属、exit 清空；owns 只认归属会话', () => {
    voiceMode.enter('conv-a');
    expect(voiceMode.ownerConversationId).toBe('conv-a');
    expect(voiceMode.owns('conv-a')).toBe(true);
    expect(voiceMode.owns('conv-b')).toBe(false); // 隐藏实例不得接管
    expect(voiceMode.owns(null)).toBe(false);

    voiceMode.exit();
    expect(voiceMode.ownerConversationId).toBeNull();
    expect(voiceMode.owns('conv-a')).toBe(false); // 未开启时一律不接管
  });

  it('未记录归属（无参 enter 的旧路径）视作全局，向后兼容', () => {
    voiceMode.enter();
    expect(voiceMode.owns('any-conv')).toBe(true);
    voiceMode.exit();
    expect(voiceMode.owns('any-conv')).toBe(false);
  });

  it('重新 enter 到另一会话后归属跟随（旧会话立即失去接管）', () => {
    voiceMode.enter('conv-a');
    voiceMode.enter('conv-b');
    expect(voiceMode.owns('conv-a')).toBe(false);
    expect(voiceMode.owns('conv-b')).toBe(true);
    voiceMode.exit();
  });
});

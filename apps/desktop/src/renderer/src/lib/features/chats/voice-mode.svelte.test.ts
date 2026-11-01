import { describe, expect, it } from 'vitest';
import {
  escapeActionForVoiceMode,
  micIntentFor,
  nextVoicePhase,
  voiceMode,
} from './voice-mode.svelte';

/**
 * 语音对话模式的 UI 状态机（docs/design/53-voice-conversation.md 交互状态机）：
 * 纯转移表 + Esc 分档 + 麦克风键意图 + store 的进入/退出复位。录音传感器链路
 * 与转写发送编排在 Composer（需真实麦克风 / core，不在单测内）；播报队列
 * （speech-started / speech-ended 的消费侧）在 voice-announce.svelte.test.ts。
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

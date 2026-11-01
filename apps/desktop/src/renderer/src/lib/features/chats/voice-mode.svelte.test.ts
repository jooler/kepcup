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
 * 与转写发送编排在 Composer（需真实麦克风 / core，不在单测内）。
 */

const ALL_PHASES = ['idle', 'recording', 'transcribing', 'speaking'] as const;

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

  it('settled：非 idle 一律回 idle（发送收尾 / 取消丢弃 / speaking 清理）；idle 忽略', () => {
    expect(nextVoicePhase('recording', 'settled')).toBe('idle');
    expect(nextVoicePhase('transcribing', 'settled')).toBe('idle');
    expect(nextVoicePhase('speaking', 'settled')).toBe('idle');
    expect(nextVoicePhase('idle', 'settled')).toBeNull();
  });

  it('全表覆盖：每个 (phase, event) 组合都有定义（switch 穷尽，无 undefined）', () => {
    for (const phase of ALL_PHASES) {
      for (const event of ['record-started', 'stop-requested', 'settled'] as const) {
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
});

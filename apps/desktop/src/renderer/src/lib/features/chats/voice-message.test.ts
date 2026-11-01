import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import {
  VOICE_WAVE_BARS,
  isVoiceMessage,
  voiceAttachmentOf,
  voiceCaptionOf,
  voiceRecordingOf,
  voiceWaveformProfile,
} from './voice-message';

/**
 * 语音消息展示判定（docs/design/53-voice-conversation.md 修订 v3）：origin
 * 标记、附件归属（用户原始录音 / Bot 无附件）、caption、稳定波形轮廓。
 */

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    id: 'msg_1',
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text: '在吗', origin: 'voice' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1,
    attachments: [],
    ownerBotId: null,
    taskId: null,
    ...overrides,
  } as Message;
}

const audio = {
  id: 'att_1',
  messageId: 'msg_1',
  fileName: 'voice.wav',
  mime: 'audio/wav',
  size: 1000,
  sha256: 'x',
  relPath: 'att_1.wav',
  createdAt: 0,
};

describe('isVoiceMessage / voiceAttachmentOf', () => {
  it('origin=voice 的 text 消息是语音消息；用户带音频附件才有播放源', () => {
    const user = message({ attachments: [audio] });
    expect(isVoiceMessage(user)).toBe(true);
    expect(voiceAttachmentOf(user)).toEqual(audio);
  });

  it('Bot 语音消息没有附件播放源（音频按需合成）', () => {
    const bot = message({ senderType: 'bot', senderBotId: 'b1', attachments: [audio] });
    expect(isVoiceMessage(bot)).toBe(true);
    expect(voiceAttachmentOf(bot)).toBeNull();
  });

  it('普通消息 / 任务消息 / 撤回消息不按语音气泡渲染', () => {
    expect(isVoiceMessage(message({ content: { text: '普通' } }))).toBe(false);
    expect(isVoiceMessage(message({ content: { text: '结果', origin: 'task' } }))).toBe(false);
    expect(isVoiceMessage(message({ status: 'recalled' }))).toBe(false);
    expect(isVoiceMessage(message({ kind: 'card', content: { cardType: 'task' } }))).toBe(false);
  });

  it('非音频附件不算播放源；转写失败的空正文语音消息仍是语音消息', () => {
    const image = { ...audio, id: 'att_i', fileName: 'pic.png', mime: 'image/png' };
    expect(voiceAttachmentOf(message({ attachments: [image] }))).toBeNull();
    expect(isVoiceMessage(message({ content: { text: '', origin: 'voice' } }))).toBe(true);
  });

  it('撤回的语音消息不渲染气泡，但附件行仍能识别并过滤原始录音', () => {
    const recalled = message({ status: 'recalled', attachments: [audio] });
    expect(isVoiceMessage(recalled)).toBe(false);
    expect(voiceAttachmentOf(recalled)).toBeNull();
    expect(voiceRecordingOf(recalled)).toEqual(audio);
  });
});

describe('voiceCaptionOf', () => {
  it('正文原样（去首尾空白）；空正文返回空串', () => {
    expect(voiceCaptionOf(message({ content: { text: ' 你好 ', origin: 'voice' } }))).toBe('你好');
    expect(voiceCaptionOf(message({ content: { text: '', origin: 'voice' } }))).toBe('');
  });
});

describe('voiceWaveformProfile', () => {
  it('固定柱数、0.3..1 的系数、同 id 稳定、不同 id 不同', () => {
    const a = voiceWaveformProfile('msg_a');
    expect(a).toHaveLength(VOICE_WAVE_BARS);
    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(0.3);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(voiceWaveformProfile('msg_a')).toEqual(a);
    expect(voiceWaveformProfile('msg_b')).not.toEqual(a);
  });
});

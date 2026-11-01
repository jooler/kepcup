/**
 * 语音消息的展示判定与波形（docs/design/53-voice-conversation.md 修订 v3）：
 * 语音气泡 = `content.origin === 'voice'` 的图文消息——用户消息（正文即转写，
 * 音频在附件里）与语音对话轮的 Bot 回复（正文即朗读文本，音频由客户端合成）。
 * 纯函数、零 core / DOM import，单测锚点。
 */

import type { Attachment, Message } from '@kepcup/shared';

/** 波形柱数（气泡里的固定轮廓；两处对齐，不随宽度变化）。 */
export const VOICE_WAVE_BARS = 22;

/**
 * 这条消息是否按语音气泡渲染：text 消息、未撤回、content 记 origin='voice'。
 * 任务消息（origin='task'）与普通消息都不在此列。
 */
export function isVoiceMessage(message: Message): boolean {
  return (
    message.kind === 'text' &&
    message.status !== 'recalled' &&
    'origin' in message.content &&
    message.content.origin === 'voice'
  );
}

/**
 * 用户语音消息里承载原始录音的音频附件（播放源）。Bot 语音消息没有附件
 * （音频由 speech-audio 按需合成）→ null。非音频附件（异常数据）跳过。
 */
export function voiceAttachmentOf(message: Message): Attachment | null {
  if (!isVoiceMessage(message)) return null;
  return voiceRecordingOf(message);
}

/**
 * 原始录音附件（不看消息状态）：附件行过滤用——撤回的语音消息不应再在附件
 * 行露出可播放的录音；气泡渲染仍用 voiceAttachmentOf（撤回不渲染气泡）。
 */
export function voiceRecordingOf(message: Message): Attachment | null {
  if (message.senderType !== 'user' || message.kind !== 'text') return null;
  if (!('origin' in message.content) || message.content.origin !== 'voice') return null;
  return message.attachments.find((attachment) => attachment.mime.startsWith('audio/')) ?? null;
}

/** 气泡下方的 caption / 朗读文本（正文原样；空正文返回空串）。 */
export function voiceCaptionOf(message: Message): string {
  return 'text' in message.content ? message.content.text.trim() : '';
}

/** FNV-1a 32-bit：稳定种子（同一条消息每次渲染的波形一致）。 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 固定波形轮廓（0.3..1 的高度系数，与消息 id 绑定）：同一消息重渲染不变，
 * 不同消息形态不同；进度只换柱子的着色，不改变高度，播放时不跳版。
 * xorshift32 只用于生成稳定伪随机，不用于任何安全用途。
 */
export function voiceWaveformProfile(seed: string): number[] {
  let state = hashSeed(seed) || 1;
  const bars: number[] = [];
  for (let i = 0; i < VOICE_WAVE_BARS; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    // 0.3 + [0, 0.7]：静音底噪不至于看不见，最高不顶边。
    bars.push(0.3 + (state / 0xffffffff) * 0.7);
  }
  return bars;
}

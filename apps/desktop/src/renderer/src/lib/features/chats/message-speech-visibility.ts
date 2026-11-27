import type { Message } from '@kepcup/shared';
import type { SourceId } from '$lib/rpc/connections.svelte';
import { messageVisibility, type DisplayMessage } from '$lib/stores/message-visibility.svelte';
import { voiceMode } from './voice-mode.svelte';
import { speechAudio } from './speech-audio.svelte';

/** Apply the current viewer scope and stop speech for newly hidden messages. */
export function applyMessageSpeechVisibility(
  source: SourceId,
  conversationId: string,
  messages: readonly Message[],
): DisplayMessage[] {
  const display = messageVisibility.applyMany(source, conversationId, messages);
  for (const message of display) {
    if (message.hidden !== true) continue;
    voiceMode.hideMessage(message.id);
    speechAudio.hideMessage(message.id);
  }
  return display;
}

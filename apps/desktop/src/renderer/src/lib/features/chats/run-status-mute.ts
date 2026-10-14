import type { Message } from '@kepcup/shared';

/**
 * Whether opening a conversation should mute this run's status line — mirrors
 * chat `#ingestMessage`: a non-interim bot message with this runId already landed.
 */
export function botMessageMutesRun(messages: Message[], runId: string): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.senderType !== 'bot' || message.runId !== runId) continue;
    if (
      message.kind === 'text' &&
      'interim' in message.content &&
      message.content.interim === true
    ) {
      continue;
    }
    return true;
  }
  return false;
}

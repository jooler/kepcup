import type { Message } from '@kepcup/shared';

/**
 * Task interim text: a status overlay (task card / status line), never a chat
 * bubble. Shared by chat `#ingestMessage`, the message list filter and the
 * run status mute below so the three stay in agreement.
 */
export function isInterimMessage(message: Message): boolean {
  return (
    message.kind === 'text' && 'interim' in message.content && message.content.interim === true
  );
}

/**
 * Whether opening a conversation should mute this run's status line — mirrors
 * chat `#ingestMessage`: a non-interim bot message with this runId already landed.
 */
export function botMessageMutesRun(messages: Message[], runId: string): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.senderType !== 'bot' || message.runId !== runId) continue;
    if (isInterimMessage(message)) continue;
    return true;
  }
  return false;
}

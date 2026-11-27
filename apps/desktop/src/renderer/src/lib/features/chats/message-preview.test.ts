import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { isPreviewableMessage, latestPreviewMessage } from './message-preview';

function message(overrides: Record<string, unknown> & Pick<Message, 'id' | 'seq'>): Message {
  return {
    conversationId: 'conv_1',
    senderType: 'bot',
    senderBotId: 'bot_1',
    kind: 'text',
    content: { text: 'preview' },
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

describe('Core-compatible message previews', () => {
  it('accepts text/card rows and rejects non-previewable rows', () => {
    expect(isPreviewableMessage(message({ id: 'text', seq: 1 }))).toBe(true);
    expect(
      isPreviewableMessage(
        message({ id: 'card', seq: 2, kind: 'card', content: { cardType: 'task' } }),
      ),
    ).toBe(true);
    expect(
      isPreviewableMessage(
        message({ id: 'system', seq: 3, kind: 'system_event', content: { event: 'run_done' } }),
      ),
    ).toBe(false);
    expect(isPreviewableMessage(message({ id: 'blank', seq: 4, content: { text: '   ' } }))).toBe(
      false,
    );
    expect(
      isPreviewableMessage(
        message({ id: 'interim', seq: 5, content: { text: 'working', interim: true } }),
      ),
    ).toBe(false);
    expect(isPreviewableMessage(message({ id: 'private', seq: 6, ownerBotId: 'bot_1' }))).toBe(
      false,
    );
    expect(
      isPreviewableMessage(
        message({
          id: 'approval',
          seq: 7,
          kind: 'card',
          content: { cardType: 'access', approvalId: 'apr_1' },
        }),
      ),
    ).toBe(false);
    expect(
      isPreviewableMessage(
        message({ id: 'changes', seq: 8, kind: 'card', content: { cardType: 'run_changes' } }),
      ),
    ).toBe(false);
    expect(isPreviewableMessage(message({ id: 'recalled', seq: 9, status: 'recalled' }))).toBe(
      false,
    );
  });

  it('keeps live previews for mail/watch/workdir system events without other system events', () => {
    const system = (event: string, text?: string, seq = 2): Message =>
      message({
        id: `system-${event}`,
        seq,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: text === undefined ? { event } : { event, text },
      });
    for (const event of ['mail_status', 'watch_status', 'workdir']) {
      expect(isPreviewableMessage(system(event, 'notice text'))).toBe(true);
    }
    // Other system events, missing/blank text never become live previews.
    expect(isPreviewableMessage(system('run_done', 'done'))).toBe(false);
    expect(isPreviewableMessage(system('mail_status'))).toBe(false);
    expect(isPreviewableMessage(system('mail_status', '   '))).toBe(false);
  });

  it('lets mail/watch/workdir system events advance the live preview', () => {
    const bot = message({ id: 'bot', seq: 1 });
    for (const event of ['mail_status', 'watch_status', 'workdir']) {
      const notice = message({
        id: `system-${event}`,
        seq: 2,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event, text: 'notice text' },
      });
      expect(latestPreviewMessage([bot, notice])?.id).toBe(`system-${event}`);
    }
  });

  it('finds Bot text seq1 even when a system event has a higher seq', () => {
    const bot = message({ id: 'bot', seq: 1 });
    const system = message({
      id: 'system',
      seq: 2,
      senderType: 'system',
      senderBotId: null,
      kind: 'system_event',
      content: { event: 'run_done', text: 'done' },
    });
    expect(latestPreviewMessage([bot, system])).toBe(bot);
    const newer = message({ id: 'newer', seq: 3, content: { text: 'new preview' } });
    expect(latestPreviewMessage([bot, system, newer])).toBe(newer);
  });
});

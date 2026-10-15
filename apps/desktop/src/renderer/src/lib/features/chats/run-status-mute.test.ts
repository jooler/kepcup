import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { botMessageMutesRun, isInterimMessage } from './run-status-mute';

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'senderType'>): Message {
  return {
    conversationId: 'c1',
    seq: 1,
    kind: 'text',
    content: { text: 'hi' },
    status: 'normal',
    createdAt: 1,
    runId: null,
    senderBotId: null,
    batchId: null,
    replyToMessageId: null,
    ...partial,
  } as Message;
}

describe('botMessageMutesRun', () => {
  it('is false when no bot message matches the run', () => {
    expect(botMessageMutesRun([], 'run_1')).toBe(false);
    expect(botMessageMutesRun([msg({ id: 'm1', senderType: 'user', runId: null })], 'run_1')).toBe(
      false,
    );
    expect(
      botMessageMutesRun(
        [msg({ id: 'm1', senderType: 'bot', runId: 'run_other', senderBotId: 'b' })],
        'run_1',
      ),
    ).toBe(false);
  });

  it('is true when a non-interim bot message of the run exists', () => {
    expect(
      botMessageMutesRun(
        [msg({ id: 'm1', senderType: 'bot', runId: 'run_1', senderBotId: 'b' })],
        'run_1',
      ),
    ).toBe(true);
  });

  it('ignores interim bot messages (same as live ingest)', () => {
    expect(
      botMessageMutesRun(
        [
          msg({
            id: 'm1',
            senderType: 'bot',
            runId: 'run_1',
            senderBotId: 'b',
            content: { text: '…', interim: true },
          }),
        ],
        'run_1',
      ),
    ).toBe(false);
  });
});

describe('isInterimMessage', () => {
  it('matches only text messages flagged interim', () => {
    expect(
      isInterimMessage(msg({ id: 'm1', senderType: 'bot', content: { text: '…', interim: true } })),
    ).toBe(true);
    expect(isInterimMessage(msg({ id: 'm2', senderType: 'bot', content: { text: 'done' } }))).toBe(
      false,
    );
    expect(
      isInterimMessage(
        msg({ id: 'm3', senderType: 'bot', content: { text: 'x', interim: false } }),
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { isChangesCardOf } from './run-changes';

function card(content: Record<string, unknown>, kind: Message['kind'] = 'card'): Message {
  return { id: 'msg_1', kind, content } as unknown as Message;
}

describe('isChangesCardOf (D75 审查 L-4: the changes card reloads on message.updated)', () => {
  it("matches only that run's run_changes card", () => {
    expect(isChangesCardOf(card({ cardType: 'run_changes', runId: 'run_1' }), 'run_1')).toBe(true);
    expect(isChangesCardOf(card({ cardType: 'run_changes', runId: 'run_2' }), 'run_1')).toBe(false);
    expect(isChangesCardOf(card({ cardType: 'task', runId: 'run_1' }), 'run_1')).toBe(false);
    expect(isChangesCardOf(card({ cardType: 'run_changes', runId: 'run_1' }, 'text'), 'run_1')).toBe(
      false,
    );
    expect(isChangesCardOf(undefined, 'run_1')).toBe(false);
    expect(isChangesCardOf(card({ cardType: 'run_changes', runId: '' }), '')).toBe(false);
  });
});

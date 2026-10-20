import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  step,
  TestClock,
  viaTask,
  waitFor,
  waitForMessage,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { APPROVAL_TTL_MS, type Approval } from '@kepcup/shared';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function startClocked(): Promise<TestStack & { clock: TestClock }> {
  const clock = new TestClock();
  const stack = await createTestStack({ clock, timers: clock });
  stacks.push(stack);
  return Object.assign(stack, { clock });
}

/**
 * A task waiting on an access card must not hang forever: after
 * APPROVAL_TTL_MS the approval is cancelled, the tool gets an explicit timeout
 * result, the run goes back to running, and the task settles (the waking turn
 * relays it) instead of sitting in `waiting_approval` until TASK_MAX_WALL_MS.
 */
describe('approval timeout (never leave a task blocked)', () => {
  it('cancels the card after the TTL and returns the timeout to the model', async () => {
    const { core, llm, clock } = await startClocked();
    const bot = await makeBot(core, '小等');
    const conv = await openDirect(core, bot.id);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'kepcup-approval-timeout-'));
    const file = path.join(outside, 'secret.txt');
    writeFileSync(file, 'outside');

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('read', { path: file }), step().replyText('读取没有完成')],
        relay: 'RELAY-AFTER-TIMEOUT',
      }),
    );
    await sendBatch(core, conv.id, ['读一下这个文件']);

    const approval = await waitFor(
      async () => {
        const result = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return result.approvals.find((item) => item.status === 'pending') ?? null;
      },
      { label: 'pending access approval', timeoutMs: 30_000 },
    );
    expect(approval.kind).toBe('access');

    clock.advance(APPROVAL_TTL_MS + 1);

    await waitFor(
      async () => {
        const result = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return result.approvals.find(
          (item) => item.id === approval.id && item.status === 'cancelled',
        )
          ? true
          : null;
      },
      { label: 'approval expired', timeoutMs: 30_000 },
    );

    const task = await waitForRun(core, conv.id, 'completed', {
      loopType: 'task',
      timeoutMs: 30_000,
    });
    const steps = (await core.rpc.call('runs.steps', { runId: task.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const readResult = steps.steps.find(
      (entry) => entry.type === 'tool_result' && entry.payload['toolName'] === 'read',
    );
    expect(readResult).toBeDefined();
    expect(String(readResult!.payload['content'])).toContain('等待用户授权超时');
    expect(readResult!.payload['ok']).toBe(false);

    await waitForMessage(
      core,
      conv.id,
      (message) => 'text' in message.content && message.content.text === 'RELAY-AFTER-TIMEOUT',
      { timeoutMs: 30_000 },
    );
  }, 120_000);
});

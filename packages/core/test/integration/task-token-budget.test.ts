import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { step, viaTask } from '@kepcup/testkit';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function prepare(budget: number) {
  const stack = await createTestStack();
  stacks.push(stack);
  const bot = await makeBot(stack.core, '预算测试');
  const conv = await openDirect(stack.core, bot.id);
  const workspace = workspacePathFor(
    resolvePaths(stack.core.services.paths.home),
    bot.id,
    conv.id,
  );
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'a.txt'), 'a\n');
  const settings = stack.core.services.domain!.settings;
  settings.update({
    taskLoop: { ...settings.get().taskLoop, tokenSoftBudget: budget },
  });
  return { stack, conversationId: conv.id };
}

async function stepsOf(core: TestStack['core'], runId: string) {
  return (
    (await core.rpc.call('runs.steps', { runId })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    }
  ).steps;
}

describe('task token soft budget (D93 P2)', () => {
  it('injects one convergence steer at 80% and one final-result steer at 100%', async () => {
    const { stack, conversationId } = await prepare(35);
    stack.llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('read', { path: 'a.txt' }),
          step().replyToolCall('read', { path: 'a.txt' }),
          step().replyToolCall('read', { path: 'a.txt' }),
          step().replyText('按预算收敛完成'),
        ],
      }),
    );

    await sendBatch(stack.core, conversationId, ['做一个长任务']);
    const run = await waitForRun(stack.core, conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });
    const steps = await stepsOf(stack.core, run.id);
    const steers = steps
      .filter((entry) => entry.type === 'steer')
      .map((entry) => String(entry.payload['text']));
    expect(steers.some((text) => text.includes('预算接近上限'))).toBe(true);
    expect(steers.some((text) => text.includes('软预算已到上限'))).toBe(true);
    // 软预算只提醒，不 abort：任务正常结算。
    expect(run.status).toBe('completed');
  }, 180_000);

  it('is off when the budget is 0', async () => {
    const { stack, conversationId } = await prepare(0);
    stack.llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('read', { path: 'a.txt' }),
          step().replyToolCall('read', { path: 'a.txt' }),
          step().replyText('完成'),
        ],
      }),
    );

    await sendBatch(stack.core, conversationId, ['不设预算']);
    const run = await waitForRun(stack.core, conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });
    const steps = await stepsOf(stack.core, run.id);
    expect(steps.some((entry) => entry.type === 'steer')).toBe(false);
  }, 180_000);
});

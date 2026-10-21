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

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function workspaceOf(core: TestStack['core'], botId: string, conversationId: string): string {
  return workspacePathFor(resolvePaths(core.services.paths.home), botId, conversationId);
}

function repeatedReads(count: number) {
  return Array.from({ length: count }, () =>
    step().replyToolCall('read', { path: 'same.txt' }),
  );
}

async function prepare(): Promise<{
  stack: TestStack;
  botId: string;
  conversationId: string;
}> {
  const stack = await start();
  const bot = await makeBot(stack.core, '空转测试');
  const conv = await openDirect(stack.core, bot.id);
  const workspace = workspaceOf(stack.core, bot.id, conv.id);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'same.txt'), 'same content\n');
  return { stack, botId: bot.id, conversationId: conv.id };
}

async function stepsOf(core: TestStack['core'], runId: string) {
  return (
    (await core.rpc.call('runs.steps', { runId })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    }
  ).steps;
}

describe('task idle guard (D93 P2)', () => {
  it('warns, then blocks the repeated call without executing it', async () => {
    const { stack, conversationId } = await prepare();
    stack.llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          ...repeatedReads(7),
          step().replyText('重复被拦下，换一种做法'),
        ],
      }),
    );

    await sendBatch(stack.core, conversationId, ['反复读同一个文件']);
    const run = await waitForRun(stack.core, conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });
    const steps = await stepsOf(stack.core, run.id);

    // 第三次读取的结果带提醒；第 7 次被拦下，返回 LOOP_DETECTED。
    const warned = steps.find(
      (entry) =>
        entry.type === 'tool_result' &&
        String(entry.payload['content']).includes('空转提醒'),
    );
    expect(warned).toBeDefined();
    const blocked = steps.find(
      (entry) =>
        entry.type === 'tool_result' &&
        entry.payload['errorCode'] === 'LOOP_DETECTED',
    );
    expect(blocked).toBeDefined();
    expect(
      steps.some(
        (entry) =>
          entry.type === 'progress' &&
          String(entry.payload['text']).includes('检测到重复操作'),
      ),
    ).toBe(true);
    expect(run.status).toBe('completed');
  }, 180_000);

  it('fails the task with LOOP_DETECTED when the blocked call is repeated again', async () => {
    const { stack, conversationId } = await prepare();
    stack.llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [...repeatedReads(8), step().replyText('不会走到这里')],
      }),
    );

    await sendBatch(stack.core, conversationId, ['继续重复']);
    const run = await waitForRun(stack.core, conversationId, 'failed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });
    expect(run.error ?? '').toContain('LOOP_DETECTED');
  }, 180_000);

  it('does nothing when the idle guard is switched off', async () => {
    const { stack, conversationId } = await prepare();
    const settings = stack.core.services.domain!.settings;
    settings.update({
      taskLoop: { ...settings.get().taskLoop, idleGuardEnabled: false },
    });
    stack.llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [...repeatedReads(8), step().replyText('关闭后正常完成')],
      }),
    );

    await sendBatch(stack.core, conversationId, ['重复也可以']);
    const run = await waitForRun(stack.core, conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });
    const steps = await stepsOf(stack.core, run.id);
    expect(
      steps.some(
        (entry) =>
          entry.type === 'tool_result' &&
          entry.payload['errorCode'] === 'LOOP_DETECTED',
      ),
    ).toBe(false);
  }, 180_000);
});

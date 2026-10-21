import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTaskRequest, step, viaTask } from '@kepcup/testkit';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { buildRunDigest } from '../../src/agent/context/continuation.js';
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

describe('update_plan in a built-in task (D93 P1)', () => {
  it('injects <current_plan>, replaces it and persists progress for the digest', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '计划测试');
    const conv = await openDirect(core, bot.id);
    const workspace = workspaceOf(core, bot.id, conv.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'plan.txt'), 'plan body\n');

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('update_plan', {
            explanation: '开始',
            plan: [
              { step: '检查项目', status: 'in_progress' },
              { step: '运行测试', status: 'pending' },
              { step: '汇报结果', status: 'pending' },
            ],
          }),
          step().replyToolCall('read', { path: 'plan.txt' }),
          step().replyToolCall('update_plan', {
            explanation: '检查完成',
            plan: [
              { step: '检查项目', status: 'completed' },
              { step: '运行测试', status: 'in_progress' },
              { step: '汇报结果', status: 'pending' },
            ],
          }),
          step().replyText('计划更新后完成'),
        ],
      }),
    );

    await sendBatch(core, conv.id, ['按计划做完']);
    const run = await waitForRun(core, conv.id, 'completed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });

    const taskRequests = llm.requests().filter((request) => isTaskRequest(request));
    expect(taskRequests.length).toBeGreaterThanOrEqual(4);
    const bodies = taskRequests.map((request) => JSON.stringify(request.body));
    expect(bodies.some((body) => body.includes('<current_plan>'))).toBe(true);
    expect(bodies.some((body) => body.includes('[in_progress] 检查项目'))).toBe(true);
    // The second update replaced the first: the last request has the new current step.
    expect(bodies.at(-1)).toContain('[in_progress] 运行测试');
    expect(bodies.at(-1)).toContain('[completed] 检查项目');

    const steps = (
      (await core.rpc.call('runs.steps', { runId: run.id })) as {
        steps: Array<{ type: string; payload: Record<string, unknown> }>;
      }
    ).steps;
    expect(
      steps.some(
        (entry) =>
          entry.type === 'tool_call' && entry.payload['toolName'] === 'update_plan',
      ),
    ).toBe(true);
    expect(
      steps.some(
        (entry) => entry.type === 'progress' && String(entry.payload['text']) === '计划 1/3：检查项目',
      ),
    ).toBe(true);
    expect(
      steps.some(
        (entry) => entry.type === 'progress' && String(entry.payload['text']) === '计划 2/3：运行测试',
      ),
    ).toBe(true);

    // continues_task_id 回放用 buildRunDigest：progress 行让上一轮计划可见。
    const digest = buildRunDigest({
      run,
      steps: steps as never,
      timeZone: 'UTC',
      budgetTokens: 1_000,
    });
    expect(digest).toContain('计划 2/3：运行测试');
  }, 180_000);
});

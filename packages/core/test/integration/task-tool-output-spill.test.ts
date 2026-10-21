import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * D93 P3 集成：内置任务读到超长文件时，模型只收到落盘摘要；任务结算后
 * `.tool-output/<runId>/` 被清理。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

describe('task tool output spill (D93 P3)', () => {
  it('spills a large read result and cleans it up when the run settles', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '落盘测试');
    const conv = await openDirect(core, bot.id);
    const workspace = workspacePathFor(resolvePaths(core.services.paths.home), bot.id, conv.id);
    mkdirSync(workspace, { recursive: true });
    const big = `${'A'.repeat(20_000)}\nBIG-MIDDLE\n${'A'.repeat(20_000)}\nEND\n`;
    writeFileSync(path.join(workspace, 'big.txt'), big);

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('read', { path: 'big.txt' }),
          step().replyText('读完了，输出已落盘。'),
        ],
      }),
    );

    await sendBatch(core, conv.id, ['读大文件']);
    const run = await waitForRun(core, conv.id, 'completed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });

    const steps = (
      (await core.rpc.call('runs.steps', { runId: run.id })) as {
        steps: Array<{ type: string; payload: Record<string, unknown> }>;
      }
    ).steps;
    const result = steps.find(
      (entry) => entry.type === 'tool_result' && entry.payload['toolName'] === 'read',
    );
    expect(result).toBeDefined();
    const content = String(result!.payload['content']);
    expect(content).toContain(path.join('.tool-output', run.id, '0.txt'));
    expect(content).toMatch(/共 \d{5} 字符/);
    expect(content).not.toContain('BIG-MIDDLE');

    // The run settled: its spill directory is gone (the workspace itself stays).
    expect(existsSync(path.join(workspace, '.tool-output', run.id))).toBe(false);
    expect(existsSync(path.join(workspace, 'big.txt'))).toBe(true);
  }, 180_000);
});

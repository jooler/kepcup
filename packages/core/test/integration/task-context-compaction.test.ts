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

/** Shrinks the mock main model so a few tool outputs cross the compaction threshold. */
function shrinkMockContext(core: TestStack['core']): void {
  const settings = core.services.domain!.settings.get();
  core.services.domain!.settings.update({
    customProviders: settings.customProviders.map((provider) =>
      provider.id === 'mock'
        ? {
            ...provider,
            models: provider.models.map((model) =>
              model.id === 'mock-main' ? { ...model, contextWindow: 20_000 } : model,
            ),
          }
        : provider,
    ),
  });
}

function workspaceOf(core: TestStack['core'], botId: string, conversationId: string): string {
  return workspacePathFor(resolvePaths(core.services.paths.home), botId, conversationId);
}

describe('task context compaction (D93 P0)', () => {
  it('compacts old tool output, keeps running, and leaves the full steps on disk', async () => {
    const { core, llm } = await start();
    shrinkMockContext(core);

    const bot = await makeBot(core, '压缩测试');
    const conv = await openDirect(core, bot.id);
    const workspace = workspaceOf(core, bot.id, conv.id);
    mkdirSync(workspace, { recursive: true });
    const big = `${'A'.repeat(24_000)}\nBIG-OUTPUT-END\n`;
    writeFileSync(path.join(workspace, 'big.txt'), big);
    writeFileSync(path.join(workspace, 'small-a.txt'), 'SMALL-A\n');
    writeFileSync(path.join(workspace, 'small-b.txt'), 'SMALL-B\n');

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('read', { path: 'big.txt' }),
          step().replyToolCall('read', { path: 'small-a.txt' }),
          step().replyToolCall('read', { path: 'small-b.txt' }),
          step().replyText('压缩后继续完成'),
        ],
      }),
    );

    await sendBatch(core, conv.id, ['读几个文件并继续']);
    const run = await waitForRun(core, conv.id, 'completed', {
      loopType: 'task',
      timeoutMs: 120_000,
    });

    const steps = (
      (await core.rpc.call('runs.steps', { runId: run.id })) as {
        steps: Array<{ type: string; payload: Record<string, unknown> }>;
      }
    ).steps;

    // Compaction announced itself on the task's progress line.
    const progress = steps.find(
      (entry) =>
        entry.type === 'progress' && String(entry.payload['text']).includes('上下文已压缩'),
    );
    expect(progress).toBeDefined();

    // The model saw the placeholder instead of the huge old output …
    expect(llm.requestBodiesContain('旧工具输出已省略')).toBe(true);
    // … while run_steps still keep the full output for the run view / audit.
    const bigResult = steps.find(
      (entry) =>
        entry.type === 'tool_result' &&
        entry.payload['toolName'] === 'read' &&
        String(entry.payload['content']).includes('BIG-OUTPUT-END'),
    );
    expect(bigResult).toBeDefined();
  }, 180_000);
});

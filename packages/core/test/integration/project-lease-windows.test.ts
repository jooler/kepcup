import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  step,
  viaTask,
  waitFor,
  waitForMessage,
  type TestStack,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D75 审查批 E（project 租约窗口）：
 * - 改动摘要 / run_changes / 整次回退已退役——租约窗口不再落库改动记录；
 * - 被强制收回的写任务（钉住的租约）失去写权限（design 30 §5.1），之后的
 *   写入以「写入租约已被用户收回」失败，不再悄悄重新取得租约。
 */

const stacks: TestStack[] = [];
const projectDirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
  for (const dir of projectDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lease-win-'));
  projectDirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

async function setup(stack: TestStack) {
  const bot = await makeBot(stack.core, '小窗');
  const conv = await openDirect(stack.core, bot.id);
  const dir = makeProject();
  const result = (await stack.core.rpc.call('projects.select', {
    conversationId: conv.id,
    path: dir,
  })) as { project: { id: string; path: string } };
  return { bot, conv, project: result.project };
}

function host(runId: string, conversationId: string): RunIdentity {
  return { runId, botId: null, conversationId, loopType: 'host' };
}

function filesOf(stack: TestStack, runId: string): string[] {
  const change = stack.core.services.projectRuntime!.changesOf(runId);
  return (change?.files ?? []).map((file) => `${file.path}:${file.change}`).sort();
}

describe('a run with several lease windows', () => {
  it('force revoke closes a window without recording run_changes; disk writes stay', async () => {
    const stack = await start();
    const { conv, project } = await setup(stack);
    const runtime = stack.core.services.projectRuntime!;
    const holder = host('host_two_windows', conv.id);
    const file = (name: string) => path.join(project.path, name);

    await runtime.ensureWriteLease(holder, project.path);
    writeFileSync(file('a.txt'), 'A1\n');
    writeFileSync(file('README.md'), '# changed once\n');
    expect(
      (
        (await stack.core.rpc.call('projects.revokeLease', { conversationId: conv.id })) as {
          revoked: boolean;
        }
      ).revoked,
    ).toBe(true);
    expect(filesOf(stack, holder.runId)).toEqual([]);
    expect(existsSync(file('a.txt'))).toBe(true);

    await runtime.ensureWriteLease(holder, project.path);
    writeFileSync(file('b.txt'), 'B\n');
    writeFileSync(file('a.txt'), 'A2\n');
    await runtime.releaseRun(holder.runId);

    expect(filesOf(stack, holder.runId)).toEqual([]);
    expect(existsSync(file('b.txt'))).toBe(true);
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('A2\n');
    const { change } = (await stack.core.rpc.call('projects.diff', {
      runId: holder.runId,
    })) as { change: unknown };
    expect(change).toBeNull();
    await expect(
      stack.core.rpc.call('projects.revert', { runId: holder.runId, force: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);
});

describe('a force-revoked write task loses its write permission (design 30 §5.1)', () => {
  it('its next write fails with the revoke reason instead of re-taking the lease', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conv, project } = await setup(stack);
    const held = step().hold().replyToolCall('write', { path: 'a2.txt', content: 'A2' });
    const after = step()
      .expect((req) => JSON.stringify(req.body.messages ?? []).includes('写入租约已被用户收回'))
      .replyText('第一部分写完了，第二部分没写成');
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [step().replyToolCall('write', { path: 'a.txt', content: 'A1' }), held, after],
        relay: 'RELAY',
      }),
    );
    await sendBatch(core, conv.id, ['写两个文件']);
    await waitFor(() => (held.consumed ? true : null), { label: 'task wrote a.txt' });
    const task = core.services
      .domain!.runs.listByConversation(conv.id, 20)
      .find((run: Run) => run.loopType === 'task')!;
    expect(
      (
        (await core.rpc.call('projects.revokeLease', { conversationId: conv.id })) as {
          revoked: boolean;
        }
      ).revoked,
    ).toBe(true);
    held.release();

    await waitForMessage(core, conv.id, (m) => 'text' in m.content && m.content.text === 'RELAY', {
      timeoutMs: 30_000,
    });
    expect(after.consumed).toBe(true);
    expect(existsSync(path.join(project.path, 'a2.txt'))).toBe(false);
    expect(readFileSync(path.join(project.path, 'a.txt'), 'utf8')).toBe('A1');
    expect(filesOf(stack, task.id)).toEqual([]);
    expect(
      core.services.projectRuntime!.holdsLease(
        { runId: task.id, botId: task.botId, conversationId: conv.id, loopType: 'task' },
        project.path,
      ),
    ).toBe(false);
  }, 60_000);
});

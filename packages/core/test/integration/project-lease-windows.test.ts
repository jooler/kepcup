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
 * - 一个 run 多次持有租约（强制收回关掉一个窗口、非钉住的 run 再次取得）时，
 *   改动记录跨窗口累积，整次回退撤销全部窗口；别人夹在两个窗口之间改过的
 *   文件按冲突处理；
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
  it('accumulates every window into one record; revert undoes them all', async () => {
    const stack = await start();
    const { conv, project } = await setup(stack);
    const runtime = stack.core.services.projectRuntime!;
    const holder = host('host_two_windows', conv.id);
    const file = (name: string) => path.join(project.path, name);

    await runtime.ensureWriteLease(holder, project.path);
    writeFileSync(file('a.txt'), 'A1\n');
    writeFileSync(file('README.md'), '# changed once\n');
    // The user force-revokes: the first window closes with its own changes.
    expect(
      (
        (await stack.core.rpc.call('projects.revokeLease', { conversationId: conv.id })) as {
          revoked: boolean;
        }
      ).revoked,
    ).toBe(true);
    expect(filesOf(stack, holder.runId)).toEqual(['README.md:modified', 'a.txt:added']);

    // A non-pinned run takes the lease again on its next write: second window.
    await runtime.ensureWriteLease(holder, project.path);
    writeFileSync(file('b.txt'), 'B\n');
    writeFileSync(file('a.txt'), 'A2\n');
    await runtime.releaseRun(holder.runId);

    expect(filesOf(stack, holder.runId)).toEqual([
      'README.md:modified',
      'a.txt:added',
      'b.txt:added',
    ]);
    const { diffText } = (await stack.core.rpc.call('projects.diff', {
      runId: holder.runId,
    })) as { diffText: string };
    expect(diffText).toContain('a.txt');
    expect(diffText).toContain('b.txt');
    expect(diffText).toContain('README.md');

    const revert = (await stack.core.rpc.call('projects.revert', {
      runId: holder.runId,
      force: false,
    })) as { ok: boolean; conflicts: string[] };
    expect(revert).toMatchObject({ ok: true, conflicts: [] });
    expect(existsSync(file('a.txt'))).toBe(false);
    expect(existsSync(file('b.txt'))).toBe(false);
    expect(readFileSync(file('README.md'), 'utf8')).toBe('# demo\n');
  }, 60_000);

  it("a file someone else changed between the run's windows is a revert conflict", async () => {
    const stack = await start();
    const { conv, project } = await setup(stack);
    const runtime = stack.core.services.projectRuntime!;
    const holder = host('host_interleaved', conv.id);
    const other = host('host_other', conv.id);
    const readme = path.join(project.path, 'README.md');

    await runtime.ensureWriteLease(holder, project.path);
    writeFileSync(readme, '# holder 1\n');
    await stack.core.rpc.call('projects.revokeLease', { conversationId: conv.id });
    // Another writer changes the same file in between …
    await runtime.ensureWriteLease(other, project.path);
    writeFileSync(readme, '# other\n');
    await runtime.releaseRun(other.runId);
    // … and the holder changes it again in its second window.
    await runtime.ensureWriteLease(holder, project.path);
    writeFileSync(readme, '# holder 2\n');
    await runtime.releaseRun(holder.runId);

    const change = runtime.changesOf(holder.runId)!;
    expect(change.files).toEqual([
      expect.objectContaining({ path: 'README.md', change: 'modified', interleaved: true }),
    ]);
    // The file still holds the holder's last content, yet restoring the
    // holder's `before` would also undo the other writer's change.
    const refused = (await stack.core.rpc.call('projects.revert', {
      runId: holder.runId,
      force: false,
    })) as { ok: boolean; conflicts: string[] };
    expect(refused).toMatchObject({ ok: false, conflicts: ['README.md'] });
    expect(readFileSync(readme, 'utf8')).toBe('# holder 2\n');
    const forced = (await stack.core.rpc.call('projects.revert', {
      runId: holder.runId,
      force: true,
    })) as { ok: boolean };
    expect(forced.ok).toBe(true);
    expect(readFileSync(readme, 'utf8')).toBe('# demo\n');
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
    expect(filesOf(stack, task.id)).toEqual(['a.txt:added']);
    expect(
      core.services.projectRuntime!.holdsLease(
        { runId: task.id, botId: task.botId, conversationId: conv.id, loopType: 'task' },
        project.path,
      ),
    ).toBe(false);
  }, 60_000);
});

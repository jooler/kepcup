import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  openDirect,
  waitFor,
  waitForEvent,
  type TestStack,
} from '@kepcup/testkit';
import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D75 W1-C：workspace 写租约（docs/design/30 §5.2）——两个写任务抢同一个
 * workspace，第二个 waiting_lease + lease.waiting，第一个释放后拿到；
 * 只读身份取租约被拒（RUN_READ_ONLY）；project 租约键不受影响。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

/** A running task run row + its identity (what TaskHost will create). */
function taskIdentity(
  stack: TestStack,
  botId: string,
  conversationId: string,
  writes: boolean,
): RunIdentity {
  const runs = stack.core.services.domain!.runs;
  const run = runs.create({
    botId,
    conversationId,
    loopType: 'task',
    triggerReason: 'task',
    triggerMessageIds: [],
    taskTitle: writes ? '写任务' : '只读任务',
    taskWrites: writes,
    taskWorkdir: null,
    originRunId: null,
  });
  runs.update(run.id, { status: 'running' });
  return { runId: run.id, botId, conversationId, loopType: 'task' };
}

describe('workspace write lease (D75 §5.2)', () => {
  it('serializes two write tasks on one workspace: the second waits, then gets the lease', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '写手');
    const conv = await openDirect(core, bot.id);
    const runtime = core.services.projectRuntime!;
    const runs = core.services.domain!.runs;
    const workspace = workspacePathFor(resolvePaths(core.services.paths.home), bot.id, conv.id);
    const a = taskIdentity(stack, bot.id, conv.id, true);
    const b = taskIdentity(stack, bot.id, conv.id, true);

    // A pins the workspace root for the whole task (W1-A contract).
    const held = await runtime.ensureWriteLease(a, workspace, { pin: true });
    expect(held).toEqual({ key: `ws:${bot.id}:${conv.id}`, project: null });
    // Re-acquiring (any path inside the same workspace) passes straight through.
    await expect(runtime.ensureWriteLease(a, path.join(workspace, 'sub', 'f.txt'))).resolves.toEqual(held);

    const waiting = waitForEvent<{ runId: string; path: string; holder: { runId: string } }>(
      core,
      'lease.waiting',
      (payload) => payload.runId === b.runId,
    );
    let bGranted = false;
    const bAcquire = runtime.ensureWriteLease(b, workspace, { pin: true }).then((target) => {
      bGranted = true;
      return target;
    });
    const event = await waiting;
    expect(event.path).toBe(`ws:${bot.id}:${conv.id}`);
    expect(event.holder.runId).toBe(a.runId);
    await waitFor(async () => (runs.get(b.runId)?.status === 'waiting_lease' ? true : null), {
      label: 'B waiting_lease',
    });
    expect(bGranted).toBe(false);

    // A ends (the settle path releases the lease) → B is promoted.
    await runtime.releaseRun(a.runId);
    await expect(bAcquire).resolves.toEqual({ key: `ws:${bot.id}:${conv.id}`, project: null });
    expect(runs.get(b.runId)?.status).toBe('running');
    // No checkpoint for workspaces: releasing B records no run_changes.
    await runtime.releaseRun(b.runId);
    expect(runtime.changesOf(b.runId)).toBeNull();
  }, 60_000);

  it('cancelling a queued writer leaves the queue without a lease', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '排队');
    const conv = await openDirect(core, bot.id);
    const runtime = core.services.projectRuntime!;
    const workspace = workspacePathFor(resolvePaths(core.services.paths.home), bot.id, conv.id);
    const a = taskIdentity(stack, bot.id, conv.id, true);
    const b = taskIdentity(stack, bot.id, conv.id, true);
    await runtime.ensureWriteLease(a, workspace, { pin: true });
    const controller = new AbortController();
    const queued = runtime.ensureWriteLease(b, workspace, { pin: true, signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    await runtime.releaseRun(a.runId);
  }, 60_000);

  it('different workspaces (other bot / other conversation) and the project do not collide', async () => {
    const stack = await start();
    const { core } = stack;
    const botX = await makeBot(core, '甲');
    const botY = await makeBot(core, '乙');
    const convX = await openDirect(core, botX.id);
    const convY = await openDirect(core, botY.id);
    const runtime = core.services.projectRuntime!;
    const home = resolvePaths(core.services.paths.home);
    // Bind first: a running task blocks switching projects (like a response run).
    const projectDir = mkdtempSync(path.join(tmpdir(), 'ws-lease-project-'));
    dirs.push(projectDir);
    writeFileSync(path.join(projectDir, 'README.md'), '# p\n');
    const bound = (await core.rpc.call('projects.select', {
      conversationId: convX.id,
      path: projectDir,
    })) as { project: { path: string } };
    const x = taskIdentity(stack, botX.id, convX.id, true);
    const y = taskIdentity(stack, botY.id, convY.id, true);
    await runtime.ensureWriteLease(x, workspacePathFor(home, botX.id, convX.id), { pin: true });
    await expect(
      runtime.ensureWriteLease(y, workspacePathFor(home, botY.id, convY.id), { pin: true }),
    ).resolves.toMatchObject({ key: `ws:${botY.id}:${convY.id}` });

    // Another bot's workspace is not a lease target of this identity.
    const z = taskIdentity(stack, botX.id, convX.id, true);
    await expect(
      runtime.ensureWriteLease(z, workspacePathFor(home, botY.id, convY.id)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // Project paths keep their own key (the project root, with a checkpoint)
    // while X still holds its workspace: no collision.
    await expect(
      core.rpc.call('projects.select', { conversationId: convX.id, path: projectDir }),
    ).rejects.toMatchObject({ code: 'PROJECT_SWITCH_BLOCKED' });
    const projectTarget = await runtime.ensureWriteLease(z, path.join(bound.project.path, 'a.txt'));
    expect(projectTarget.key).toBe(bound.project.path);
    expect(projectTarget.project).not.toBeNull();
    await runtime.releaseRun(z.runId);
    await runtime.releaseRun(x.runId);
    await runtime.releaseRun(y.runId);
  }, 60_000);

  it('read-only identities (turn, writes:false task) cannot take a write lease', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '只读');
    const conv = await openDirect(core, bot.id);
    const runtime = core.services.projectRuntime!;
    const workspace = workspacePathFor(resolvePaths(core.services.paths.home), bot.id, conv.id);
    const readTask = taskIdentity(stack, bot.id, conv.id, false);
    const turn: RunIdentity = { runId: 'run_turn_x', botId: bot.id, conversationId: conv.id, loopType: 'turn' };
    await expect(runtime.ensureWriteLease(readTask, workspace, { pin: true })).rejects.toMatchObject({
      code: 'RUN_READ_ONLY',
    });
    await expect(runtime.ensureWriteLease(turn, workspace)).rejects.toMatchObject({
      code: 'RUN_READ_ONLY',
      message: expect.stringContaining('对话轮是只读的'),
    });
  }, 60_000);
});

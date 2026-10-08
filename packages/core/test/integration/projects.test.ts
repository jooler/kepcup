import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTaskRequest, step, viaTask, waitForMessage } from '@kepcup/testkit';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForEvent,
  waitForRun,
  type MockChatRequest,
  type MockLlmStep,
  type TestStack,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import type { RunIdentity } from '../../src/agent/types.js';
import type { SandboxPolicy } from '../../src/sandbox/types.js';

const stacks: TestStack[] = [];
const projectDirs: string[] = [];
const stoppers: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
  for (const dir of projectDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<TestStack> {
  const stack = await createTestStack({ env });
  stacks.push(stack);
  return stack;
}

/** A realistic project directory: own `.git` repo, sources, an ignored dir. */
function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'p04-proj-'));
  projectDirs.push(dir);
  mkdirGit(dir);
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

function mkdirGit(dir: string): void {
  execFileSync('git', ['init', '-q', dir]);
}

function hashDir(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      hash.update(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

async function bindProject(
  core: TestStack['core'],
  conversationId: string,
  dir: string,
): Promise<{ id: string; path: string; status: string }> {
  const result = (await core.rpc.call('projects.select', {
    conversationId,
    path: dir,
  })) as { project: { id: string; path: string; status: string } };
  return result.project;
}

async function listRuns(core: TestStack['core'], conversationId: string): Promise<Run[]> {
  const result = (await core.rpc.call('runs.list', { conversationId, limit: 50 })) as { runs: Run[] };
  return result.runs;
}

async function stepsOf(core: TestStack['core'], runId: string) {
  const result = (await core.rpc.call('runs.steps', { runId })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return result.steps;
}

function toolResult(
  steps: Array<{ type: string; payload: Record<string, unknown> }>,
  toolName: string,
): { payload: Record<string, unknown>; content: string; ok: boolean } | null {
  const entry = steps.find(
    (s) => s.type === 'tool_result' && s.payload['toolName'] === toolName,
  );
  if (entry === undefined) return null;
  return {
    payload: entry.payload,
    ok: entry.payload['ok'] === true,
    content: String(entry.payload['content'] ?? ''),
  };
}

/**
 * D75 W2: edits, writes and git remote operations are a write task's work (a
 * turn is read-only); the waking turn relays the task's result as `relay`.
 */
function inWriteTask(taskSteps: ReturnType<typeof step>[], relay: string) {
  return viaTask({ taskSteps, relay });
}

async function waitRelay(core: TestStack['core'], conversationId: string, relay: string) {
  await waitForMessage(core, conversationId, (m) => 'text' in m.content && m.content.text === relay, {
    timeoutMs: 120_000,
  });
}

async function runChangesRow(core: TestStack['core'], runId: string) {
  const result = (await core.rpc.call('projects.diff', { runId })) as {
    change: { files: Array<{ path: string; change: string }>; revertedAt: number | null } | null;
    diffText: string;
  };
  return result;
}

/** `path:change` of a run's recorded project changes, sorted (null = no record). */
async function changedFiles(core: TestStack['core'], runId: string): Promise<string[] | null> {
  const { change } = await runChangesRow(core, runId);
  return change === null ? null : change.files.map((f) => `${f.path}:${f.change}`).sort();
}

const ACTIVE_STATUSES: ReadonlyArray<Run['status']> = ['queued', 'running', 'waiting_approval', 'waiting_lease'];

async function taskRuns(core: TestStack['core'], conversationId: string): Promise<Run[]> {
  return (await listRuns(core, conversationId)).filter((r) => r.loopType === 'task');
}

function runOf(core: TestStack['core'], runId: string): Run {
  return core.services.domain!.runs.getOrThrow(runId);
}

function taskIdentity(task: Run): RunIdentity {
  return { runId: task.id, botId: task.botId, conversationId: task.conversationId, loopType: 'task' };
}

/** The task summaries a turn of (bot, conversation) sees in its <tasks> section. */
function taskViews(core: TestStack['core'], botId: string, conversationId: string) {
  return core.services.orchestrator!.tasks.list({
    runId: 'run_probe',
    botId,
    conversationId,
    loopType: 'turn',
  });
}

/** Waits until neither a turn nor a task of the conversation is active. */
async function waitIdle(core: TestStack['core'], conversationId: string): Promise<void> {
  await waitFor(
    async () =>
      (await listRuns(core, conversationId)).some(
        (r) => (r.loopType === 'turn' || r.loopType === 'task') && ACTIVE_STATUSES.includes(r.status),
      )
        ? null
        : true,
    { label: 'conversation idle', timeoutMs: 60_000 },
  );
}

function systemText(req: MockChatRequest): string {
  const first = req.body.messages?.[0];
  return typeof first?.content === 'string' ? first.content : '';
}

/** Restricts steps to the requests of one bot (turns and tasks share mock-main). */
function forBot(name: string, steps: MockLlmStep[]): MockLlmStep[] {
  return steps.map((s) => s.expect((req) => systemText(req).includes(`名字：${name}`)));
}

function toolNames(req: MockChatRequest): string[] {
  return (req.body.tools ?? []).map((tool) => {
    const t = tool as { name?: string; function?: { name?: string } };
    return t.function?.name ?? t.name ?? '';
  });
}

/**
 * Approves every pending `command` card of the conversation. Without a usable
 * OS sandbox (the test container) commands run in confirm mode: a write
 * task's command needs a card, then runs unsandboxed; with the sandbox no card
 * is raised and this is a no-op — the assertions hold either way.
 */
function autoApproveCommands(core: TestStack['core'], conversationId: string): void {
  let stopped = false;
  stoppers.push(() => {
    stopped = true;
  });
  void (async () => {
    while (!stopped) {
      try {
        const list = (await core.rpc.call('approvals.list', { conversationId })) as {
          approvals: Array<{ id: string; kind: string; status: string }>;
        };
        for (const approval of list.approvals) {
          if (stopped) break;
          if (approval.kind === 'command' && approval.status === 'pending') {
            await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
          }
        }
      } catch {
        // The stack is shutting down.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
}

interface RecordedExec {
  command: string;
  cwd: string;
  policy: SandboxPolicy;
}

/**
 * Replaces the OS sandbox with a recorder that reports itself available and
 * captures the per-command policy the gateway builds (mounts, network) without
 * running anything: the gateway's half of the sandbox contract is verifiable
 * where bwrap / socat are missing.
 */
function recordingSandbox(core: TestStack['core']): RecordedExec[] {
  const backend = core.services.sandbox;
  const recorded: RecordedExec[] = [];
  backend.probe = () => Promise.resolve({ backend: backend.kind, available: true });
  backend.exec = (req) => {
    recorded.push({ command: req.command, cwd: req.cwd, policy: req.policy });
    return Promise.resolve({ exitCode: 0, stdout: 'recorded', stderr: '', timedOut: false, violations: [] });
  };
  return recorded;
}

describe('projects (P04)', () => {
  // D75 §5.1: writes happen in write tasks that pin the workdir lease before
  // they start; a second write task on the same project — from another
  // conversation too — is held back by the task layer (submitted, queue
  // reason naming the holder), never reaching the lease (DEV-015). The old
  // case had two reply runs meet on the lease (waiting_lease + lease.waiting).
  it('serializes write tasks of two conversations on one project: the second stays submitted until the first ends', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '先行');
    const botB = await makeBot(core, '后行');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const project = await bindProject(core, convA.id, makeProject());
    await bindProject(core, convB.id, project.path);
    const runtime = core.services.projectRuntime!;

    const aHeld = step().hold().replyText('A 完成');
    const bWrite = step().replyToolCall('write', { path: 'b.txt', content: 'B-wrote' });
    llm.script('mock-main', [
      ...forBot(
        '先行',
        inWriteTask([step().replyToolCall('write', { path: 'a.txt', content: 'A-wrote' }), aHeld], 'RELAY-A'),
      ),
      ...forBot('后行', inWriteTask([bWrite, step().replyText('B 完成')], 'RELAY-B')),
    ]);
    const leaseWaits: unknown[] = [];
    stoppers.push(core.onEvent('lease.waiting', (payload) => leaseWaits.push(payload)));

    await sendBatch(core, convA.id, ['A 先来']);
    await waitFor(() => (aHeld.consumed ? true : null), { label: 'A task wrote and is held', timeoutMs: 60_000 });
    expect(readFileSync(path.join(project.path, 'a.txt'), 'utf8')).toBe('A-wrote');
    const aTask = (await taskRuns(core, convA.id))[0]!;
    expect(runtime.holdsLease(taskIdentity(aTask), project.path)).toBe(true);

    await sendBatch(core, convB.id, ['B 也来']);
    const bTask = await waitFor(async () => (await taskRuns(core, convB.id))[0] ?? null, {
      label: 'B task submitted',
      timeoutMs: 30_000,
    });
    const queued = await waitFor(
      () => taskViews(core, botB.id, convB.id).find((t) => t.taskId === bTask.id && t.queueReason !== null) ?? null,
      { label: 'B queue reason', timeoutMs: 30_000 },
    );
    expect(queued.state).toBe('submitted');
    expect(queued.queueReason).toBe(`等写入租约（任务 ${aTask.id} 持有）`);
    // Held in the task layer: still `queued`, not on the lease (no waiting_lease, no lease.waiting).
    expect(runOf(core, bTask.id).status).toBe('queued');
    expect(leaseWaits).toEqual([]);
    expect(bWrite.consumed).toBe(false);
    expect(existsSync(path.join(project.path, 'b.txt'))).toBe(false);

    aHeld.release();
    await waitRelay(core, convA.id, 'RELAY-A');
    await waitRelay(core, convB.id, 'RELAY-B');
    expect(readFileSync(path.join(project.path, 'b.txt'), 'utf8')).toBe('B-wrote');
    expect(runOf(core, aTask.id).status).toBe('completed');
    expect(runOf(core, bTask.id).status).toBe('completed');
    expect(toolResult(await stepsOf(core, bTask.id), 'write')?.ok).toBe(true);
    expect(leaseWaits).toEqual([]);
    // One checkpoint window per task: no interleaving of the two tasks' changes.
    expect(await changedFiles(core, aTask.id)).toEqual(['a.txt:added']);
    expect(await changedFiles(core, bTask.id)).toEqual(['b.txt:added']);
  }, 180_000);

  // D75 §2.1 / §5.1: turns and read-only tasks cannot write the project at all
  // (RUN_READ_ONLY, they take no lease); the old case had a reply run without
  // the lease see a read-only mount until it called acquire_project_write.
  it('refuses project writes in turns and read-only tasks, file tools and commands alike (RUN_READ_ONLY)', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小租');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        title: '只读检查',
        taskSteps: [
          step().replyToolCall('write', { path: 'ro-file.txt', content: 'x' }),
          step().replyToolCall('acquire_project_write', { reason: '想写' }),
          step().replyToolCall('bash', { command: 'touch ro-bash.txt' }),
          step().replyText('只读做不了'),
        ],
        relay: 'RELAY-RO',
      }),
    );
    await sendBatch(core, conv.id, ['建两个文件']);
    await waitRelay(core, conv.id, 'RELAY-RO');
    const task = (await taskRuns(core, conv.id))[0]!;
    expect(task.taskWrites).toBe(false);
    const steps = await stepsOf(core, task.id);

    const write = toolResult(steps, 'write');
    expect(write?.ok).toBe(false);
    expect(write?.payload['errorCode']).toBe('RUN_READ_ONLY');
    const acquire = toolResult(steps, 'acquire_project_write');
    expect(acquire?.ok).toBe(false);
    expect(acquire?.payload['errorCode']).toBe('RUN_READ_ONLY');
    expect(acquire?.content).toContain('只读任务');
    // The command wrote nothing: a read-only mount with the sandbox; refused
    // outright (RUN_READ_ONLY) in confirm mode — never a command card.
    expect(toolResult(steps, 'bash')).not.toBeNull();
    expect(existsSync(path.join(project.path, 'ro-file.txt'))).toBe(false);
    expect(existsSync(path.join(project.path, 'ro-bash.txt'))).toBe(false);
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string }>;
    };
    expect(approvals.approvals.filter((a) => a.kind === 'command')).toEqual([]);
    expect(await changedFiles(core, task.id)).toBeNull();

    // A turn is not even offered a write path.
    const turnRequests = llm.requestsFor('mock-main').filter((req) => !isTaskRequest(req));
    expect(turnRequests.length).toBeGreaterThan(0);
    for (const req of turnRequests) {
      expect(toolNames(req).filter((name) => /^(write|edit|bash|acquire_project_write)$/.test(name))).toEqual([]);
    }
  }, 120_000);

  it('a write task holds the project lease from its start: file tools, acquire_project_write and commands write', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小写');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    const runtime = core.services.projectRuntime!;
    autoApproveCommands(core, conv.id);

    const first = step().hold().replyToolCall('write', { path: 'with-lease.txt', content: 'x' });
    llm.script(
      'mock-main',
      inWriteTask(
        [
          first,
          step().replyToolCall('acquire_project_write', { reason: '需要安装依赖' }),
          step().replyToolCall('bash', { command: 'touch with-lease-bash.txt' }),
          step().replyText('好了'),
        ],
        'RELAY-RW',
      ),
    );
    await sendBatch(core, conv.id, ['建两个文件']);
    await waitFor(() => (first.consumed ? true : null), { label: 'first task request', timeoutMs: 60_000 });
    const task = (await taskRuns(core, conv.id))[0]!;
    // Pinned before the first model request, without any tool call.
    expect(runtime.holdsLease(taskIdentity(task), project.path)).toBe(true);
    first.release();
    await waitRelay(core, conv.id, 'RELAY-RW');

    const steps = await stepsOf(core, task.id);
    expect(toolResult(steps, 'write')?.ok).toBe(true);
    // Already held: acquire_project_write passes straight through.
    expect(toolResult(steps, 'acquire_project_write')?.ok).toBe(true);
    expect(toolResult(steps, 'bash')?.ok).toBe(true);
    expect(existsSync(path.join(project.path, 'with-lease.txt'))).toBe(true);
    expect(existsSync(path.join(project.path, 'with-lease-bash.txt'))).toBe(true);
    expect(llm.requestBodiesContain('acquire_project_write')).toBe(true);
    // The lease ends with the task; both writes land in its checkpoint window.
    expect(runtime.holdsLease(taskIdentity(task), project.path)).toBe(false);
    expect(await changedFiles(core, task.id)).toEqual(['with-lease-bash.txt:added', 'with-lease.txt:added']);
  }, 120_000);

  it('commands get a read-only project mount in read-only tasks and a writable one in write tasks (gateway policy)', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小策');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    const recorded = recordingSandbox(core);

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('bash', { command: 'echo ro-policy' }), step().replyText('看完了')],
        relay: 'RELAY-POLICY-RO',
      }),
    );
    await sendBatch(core, conv.id, ['看看']);
    await waitRelay(core, conv.id, 'RELAY-POLICY-RO');
    llm.script(
      'mock-main',
      inWriteTask(
        [step().replyToolCall('bash', { command: 'echo rw-policy' }), step().replyText('改完了')],
        'RELAY-POLICY-RW',
      ),
    );
    await sendBatch(core, conv.id, ['改改']);
    await waitRelay(core, conv.id, 'RELAY-POLICY-RW');

    const ro = recorded.find((r) => r.command === 'echo ro-policy');
    const rw = recorded.find((r) => r.command === 'echo rw-policy');
    expect(ro?.cwd).toBe(project.path);
    expect(ro?.policy.readOnly).toContain(project.path);
    expect(ro?.policy.readWrite).not.toContain(project.path);
    expect(rw?.cwd).toBe(project.path);
    expect(rw?.policy.readWrite).toContain(project.path);
    expect(rw?.policy.readOnly).not.toContain(project.path);
  }, 120_000);

  it('returns STALE_FILE when the file changed externally after the bot read it', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小陈');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    writeFileSync(path.join(project.path, 'notes.txt'), 'version-1\n');

    // One run: read -> (held) -> edit. The user edits the file in their own
    // editor while the model composes its next step.
    const heldEdit = step().hold().replyToolCall('edit', {
      path: 'notes.txt',
      edits: [{ oldText: 'version-1', newText: 'version-3' }],
    });
    llm.script(
      'mock-main',
      inWriteTask(
        [step().replyToolCall('read', { path: 'notes.txt' }), heldEdit, step().replyText('改不了就算了')],
        'RELAY-STALE',
      ),
    );
    await sendBatch(core, conv.id, ['看看笔记然后改一下']);
    await waitFor(
      async () => (heldEdit.consumed ? true : null),
      { label: 'edit request held', timeoutMs: 30_000 },
    );
    writeFileSync(path.join(project.path, 'notes.txt'), 'version-2-user-edit\n');
    heldEdit.release();
    const staleRun = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000, loopType: 'task' });

    const steps = await stepsOf(core, staleRun.id);
    const editResult = toolResult(steps, 'edit');
    expect(editResult?.ok).toBe(false);
    expect(editResult?.content).toContain('STALE_FILE');
    // The user's edit survived.
    expect(readFileSync(path.join(project.path, 'notes.txt'), 'utf8')).toBe('version-2-user-edit\n');
  }, 240_000);

  it('keeps .env unreadable until the protection rules change', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小保');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    writeFileSync(path.join(project.path, '.env'), 'SECRET_TOKEN=abc123\n');

    llm.script('mock-main', [
      step().replyToolCall('read', { path: '.env' }),
      step().replyText('读不了'),
    ]);
    await sendBatch(core, conv.id, ['读 .env']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });
    // The secret never reached the model.
    expect(llm.requestBodiesContain('abc123')).toBe(false);
    const runs = await listRuns(core, conv.id);
    const firstRead = toolResult(await stepsOf(core, runs.find((r) => r.botId === bot.id && r.loopType === 'turn')!.id), 'read');
    expect(firstRead?.ok).toBe(false);
    expect(firstRead?.content).toContain('PATH_OUT_OF_SCOPE');

    // Loosening the rules makes the file readable.
    const listed = (await core.rpc.call('projects.list')) as { projects: Array<{ id: string }> };
    await core.rpc.call('projects.update', {
      id: listed.projects[0]!.id,
      protectRules: { denyRead: [], denyWrite: [] },
    });
    llm.script('mock-main', [
      step().replyToolCall('read', { path: '.env' }),
      step().replyText('读到了'),
    ]);
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '再读一次' });
    const flushed = (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as { runId: string | null };
    await waitFor(
      async () => {
        const run = (await listRuns(core, conv.id)).find((r) => r.id === flushed.runId);
        return run !== undefined && run.status === 'completed' ? run : null;
      },
      { label: 'second read run', timeoutMs: 120_000 },
    );
    const steps = await stepsOf(core, flushed.runId!);
    expect(llm.requestBodiesContain('abc123')).toBe(true);
    const secondRead = toolResult(steps, 'read');
    expect(secondRead?.ok).toBe(true);
  }, 240_000);

  // D75: the checkpoint window is the write task's (pinned at its start,
  // closed when it ends) — summary card, diff and whole-task revert are keyed
  // by the task id. File tools here; command-made changes in the next case.
  it("summarizes a write task's changes, diffs them and reverts the whole task (with conflict detection)", async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小改');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    writeFileSync(path.join(project.path, 'existing.txt'), 'original\n');

    llm.script(
      'mock-main',
      inWriteTask(
        [
          step().replyToolCall('write', { path: 'created.txt', content: 'brand-new-content\n' }),
          step().replyToolCall('write', { path: 'existing.txt', content: 'modified-content\n' }),
          step().replyText('改完了'),
        ],
        'RELAY-CHANGE-1',
      ),
    );
    await sendBatch(core, conv.id, ['改项目']);
    await waitRelay(core, conv.id, 'RELAY-CHANGE-1');
    const task = (await taskRuns(core, conv.id))[0]!;
    expect(task.status).toBe('completed');

    // The changes card belongs to the task: after the turn's dispatch ack,
    // before the waking turn relays the result.
    const messages = await listMessages(core, conv.id);
    const card = messages.find(
      (m) => m.kind === 'card' && 'cardType' in m.content && m.content.cardType === 'run_changes',
    );
    expect(card).toBeDefined();
    expect((card!.content as { runId?: string }).runId).toBe(task.id);
    const ack = messages.findIndex((m) => m.senderBotId === bot.id && m.kind === 'text');
    const relay = messages.findIndex(
      (m) => m.senderBotId === bot.id && 'text' in m.content && m.content.text === 'RELAY-CHANGE-1',
    );
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf(card!)).toBeGreaterThan(ack);
    expect(messages.indexOf(card!)).toBeLessThan(relay);

    const { diffText } = await runChangesRow(core, task.id);
    expect(await changedFiles(core, task.id)).toEqual(['created.txt:added', 'existing.txt:modified']);
    expect(diffText).toContain('brand-new-content');

    // Revert without conflicts: files return to their before-state.
    const revert = (await core.rpc.call('projects.revert', { runId: task.id, force: false })) as {
      ok: boolean;
      conflicts: string[];
      reverted: string[];
    };
    expect(revert.ok).toBe(true);
    expect(existsSync(path.join(project.path, 'created.txt'))).toBe(false);
    expect(readFileSync(path.join(project.path, 'existing.txt'), 'utf8')).toBe('original\n');

    // Reverting twice is refused.
    await expect(core.rpc.call('projects.revert', { runId: task.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    // Second task: external edits create a conflict for the revert.
    llm.script(
      'mock-main',
      inWriteTask(
        [
          step().replyToolCall('write', { path: 'existing.txt', content: 'round-two\n' }),
          step().replyText('又改了'),
        ],
        'RELAY-CHANGE-2',
      ),
    );
    await sendBatch(core, conv.id, ['再改一次']);
    await waitRelay(core, conv.id, 'RELAY-CHANGE-2');
    const task2 = (await taskRuns(core, conv.id)).find((r) => r.id !== task.id)!;
    expect(task2.status).toBe('completed');
    expect(await changedFiles(core, task2.id)).toEqual(['existing.txt:modified']);
    writeFileSync(path.join(project.path, 'existing.txt'), 'user-edited-after-run\n');

    const conflict = (await core.rpc.call('projects.revert', { runId: task2.id, force: false })) as {
      ok: boolean;
      conflicts: string[];
      reverted: string[];
    };
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts).toEqual(['existing.txt']);
    expect(readFileSync(path.join(project.path, 'existing.txt'), 'utf8')).toBe('user-edited-after-run\n');

    const forced = (await core.rpc.call('projects.revert', { runId: task2.id, force: true })) as {
      ok: boolean;
      reverted: string[];
    };
    expect(forced.ok).toBe(true);
    expect(readFileSync(path.join(project.path, 'existing.txt'), 'utf8')).toBe('original\n');
  }, 180_000);

  it("records command-made changes in the write task's checkpoint and reverts them", async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小令');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    writeFileSync(path.join(project.path, 'existing.txt'), 'original\n');
    autoApproveCommands(core, conv.id);

    llm.script(
      'mock-main',
      inWriteTask(
        [
          step().replyToolCall('bash', {
            command: 'echo brand-new-content > created.txt && echo modified-content > existing.txt',
          }),
          step().replyText('改完了'),
        ],
        'RELAY-CMD',
      ),
    );
    await sendBatch(core, conv.id, ['用命令改项目']);
    await waitRelay(core, conv.id, 'RELAY-CMD');
    const task = (await taskRuns(core, conv.id))[0]!;
    expect(toolResult(await stepsOf(core, task.id), 'bash')?.ok).toBe(true);

    const { diffText } = await runChangesRow(core, task.id);
    expect(await changedFiles(core, task.id)).toEqual(['created.txt:added', 'existing.txt:modified']);
    expect(diffText).toContain('brand-new-content');
    const revert = (await core.rpc.call('projects.revert', { runId: task.id, force: false })) as { ok: boolean };
    expect(revert.ok).toBe(true);
    expect(existsSync(path.join(project.path, 'created.txt'))).toBe(false);
    expect(readFileSync(path.join(project.path, 'existing.txt'), 'utf8')).toBe('original\n');
  }, 120_000);

  it('never touches the project own .git during checkpointing', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小影');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    const before = hashDir(path.join(project.path, '.git'));

    llm.script(
      'mock-main',
      inWriteTask(
        [step().replyToolCall('write', { path: 'shadow.txt', content: 'checkpointed' }), step().replyText('写好了')],
        'RELAY-SHADOW',
      ),
    );
    await sendBatch(core, conv.id, ['写文件']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000, loopType: 'task' });
    await waitRelay(core, conv.id, 'RELAY-SHADOW');

    expect(hashDir(path.join(project.path, '.git'))).toBe(before);
    // The shadow repo lives in the data directory; the project only gained the bot's file.
    expect(readdirSync(project.path).sort()).toEqual(
      ['.git', '.gitignore', 'README.md', 'shadow.txt'].sort(),
    );
    expect(core.services.paths.home).toContain('kepcup');
    expect(existsSync(path.join(core.services.paths.home, 'projects'))).toBe(true);
  }, 240_000);

  it('runs approved git remote operations outside the sandbox and skips denied ones', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小吉');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());

    // Approve `git init` and `git remote add`.
    llm.script(
      'mock-main',
      inWriteTask(
        [
          step().replyToolCall('git_remote', { operation: 'init', args: [], reason: '初始化仓库' }),
          step().replyToolCall('git_remote', {
            operation: 'remote_add',
            args: ['origin', 'https://example.com/demo.git'],
            reason: '配置远程',
          }),
          step().replyText('配好了'),
        ],
        'RELAY-GIT',
      ),
    );
    await sendBatch(core, conv.id, ['配置 git']);
    for (let i = 0; i < 2; i++) {
      const pending = await waitFor(
        async () => {
          const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
            approvals: Array<{ id: string; kind: string; status: string }>;
          };
          return list.approvals.find((a) => a.kind === 'git_remote' && a.status === 'pending') ?? null;
        },
        { label: 'git_remote approval', timeoutMs: 30_000 },
      );
      await core.rpc.call('approvals.decide', { id: pending!.id, approve: true });
    }
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000, loopType: 'task' });
    await waitRelay(core, conv.id, 'RELAY-GIT');

    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string; status: string; payload: Record<string, unknown> }>;
    };
    const gitApprovals = approvals.approvals.filter((a) => a.kind === 'git_remote');
    expect(gitApprovals.length).toBe(2);
    expect(gitApprovals.every((a) => a.status === 'approved')).toBe(true);
    expect(gitApprovals.map((a) => String(a.payload['operation'])).sort()).toEqual(['init', 'remote_add']);
    expect(existsSync(path.join(project.path, '.git', 'config'))).toBe(true);
    const config = readFileSync(path.join(project.path, '.git', 'config'), 'utf8');
    expect(config).toContain('example.com/demo.git');

    // Deny the push: the tool reports APPROVAL_DENIED, nothing executes.
    llm.script(
      'mock-main',
      inWriteTask(
        [
          step().replyToolCall('git_remote', { operation: 'push', args: ['origin', 'main'], reason: '推送' }),
          step().replyText('不推了'),
        ],
        'RELAY-PUSH',
      ),
    );
    const firstTaskIds = new Set((await listRuns(core, conv.id)).filter((r) => r.loopType === 'task').map((r) => r.id));
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '推一下' });
    await core.rpc.call('drafts.flush', { conversationId: conv.id });
    const pushApproval = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Array<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>;
        };
        return (
          list.approvals.find(
            (a) => a.kind === 'git_remote' && a.status === 'pending' && String(a.payload['operation']) === 'push',
          ) ?? null
        );
      },
      { label: 'push approval', timeoutMs: 30_000 },
    );
    await core.rpc.call('approvals.decide', { id: pushApproval!.id, approve: false });
    const pushTask = await waitFor(
      async () =>
        (await listRuns(core, conv.id)).find(
          (r) => r.loopType === 'task' && !firstTaskIds.has(r.id) && r.status === 'completed',
        ) ?? null,
      { label: 'push task', timeoutMs: 120_000 },
    );
    const steps = await stepsOf(core, pushTask.id);
    const pushResult = toolResult(steps, 'git_remote');
    expect(pushResult?.ok).toBe(false);
    expect(pushResult?.content).toContain('拒绝');
    const denied = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string; status: string; payload: Record<string, unknown> }>;
    };
    const push = denied.approvals.find(
      (a) => a.kind === 'git_remote' && String(a.payload['operation']) === 'push',
    );
    expect(push?.status).toBe('denied');
  }, 240_000);

  // Commands run in tasks now (a turn has no bash). The gateway's half — the
  // network policy it hands the sandbox — is checked with a recording backend;
  // real reachability needs the OS sandbox (next case).
  it('gives task commands localhost access in project conversations only (gateway policy)', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '小服');
    const botB = await makeBot(core, '小离');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const project = await bindProject(core, convA.id, makeProject());
    await core.rpc.call('projects.update', { id: project.id, allowedPorts: [[3000, 3999]] });
    const recorded = recordingSandbox(core);

    llm.script('mock-main', [
      ...forBot(
        '小服',
        viaTask({
          writes: false,
          taskSteps: [step().replyToolCall('bash', { command: 'echo bound-net' }), step().replyText('起了个服务')],
          relay: 'RELAY-NET-A',
        }),
      ),
      ...forBot(
        '小离',
        viaTask({
          writes: false,
          taskSteps: [step().replyToolCall('bash', { command: 'echo unbound-net' }), step().replyText('起不来')],
          relay: 'RELAY-NET-B',
        }),
      ),
    ]);
    await sendBatch(core, convA.id, ['起个开发服务器试试']);
    await sendBatch(core, convB.id, ['起个开发服务器试试']);
    await waitRelay(core, convA.id, 'RELAY-NET-A');
    await waitRelay(core, convB.id, 'RELAY-NET-B');

    const bound = recorded.find((r) => r.command === 'echo bound-net');
    const unbound = recorded.find((r) => r.command === 'echo unbound-net');
    expect(bound?.policy.network.allowLocalhost).toBe(true);
    expect(bound?.policy.network.allowedPorts).toEqual([[3000, 3999]]);
    expect(unbound).toBeDefined();
    expect(unbound?.policy.network.allowLocalhost).toBe(false);
  }, 120_000);

  // Needs the OS sandbox (bwrap / socat): fails fast where it is unavailable
  // (the test container) instead of running unsandboxed in confirm mode, where
  // nothing would block the unbound conversation.
  it('allows localhost ports in project conversations and blocks them otherwise (OS sandbox)', async () => {
    const { core, llm } = await start();
    const availability = await core.services.sandbox.probe();
    expect(availability.available, `requires the OS sandbox: ${availability.reason ?? ''}`).toBe(true);
    const botA = await makeBot(core, '小服');
    const botB = await makeBot(core, '小离');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    await bindProject(core, convA.id, makeProject());

    const port = 20000 + Math.floor(Math.random() * 20000);
    const probe = `python3 -m http.server ${port} --bind 127.0.0.1 >/dev/null 2>&1 & sleep 2; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/; kill %1`;

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('bash', { command: probe }), step().replyText('起了个服务')],
        relay: 'RELAY-PORT-A',
      }),
    );
    await sendBatch(core, convA.id, ['起个开发服务器试试']);
    await waitRelay(core, convA.id, 'RELAY-PORT-A');
    const boundTask = (await taskRuns(core, convA.id))[0]!;
    expect(toolResult(await stepsOf(core, boundTask.id), 'bash')?.content).toContain('200');

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('bash', { command: probe }), step().replyText('起不来')],
        relay: 'RELAY-PORT-B',
      }),
    );
    await sendBatch(core, convB.id, ['起个开发服务器试试']);
    await waitRelay(core, convB.id, 'RELAY-PORT-B');
    const unboundTask = (await taskRuns(core, convB.id))[0]!;
    expect(toolResult(await stepsOf(core, unboundTask.id), 'bash')?.content).not.toContain('200');
  }, 400_000);

  it('marks a project missing when its directory is moved away', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小移');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());

    const got = (await core.rpc.call('projects.get', { id: project.id })) as {
      project: { status: string };
    };
    expect(got.project?.status).toBe('available');

    rmSync(project.path, { recursive: true, force: true });
    const missing = (await core.rpc.call('projects.get', { id: project.id })) as {
      project: { status: string };
    };
    expect(missing.project?.status).toBe('missing');

    // Re-binding a non-existent directory is refused.
    await expect(
      core.rpc.call('projects.select', { conversationId: conv.id, path: project.path }),
    ).rejects.toMatchObject({ code: 'PROJECT_MISSING' });

    // Selecting a directory inside the data home is refused.
    await expect(
      core.rpc.call('projects.select', {
        conversationId: conv.id,
        path: core.services.paths.home,
      }),
    ).rejects.toMatchObject({ code: 'PATH_OUT_OF_SCOPE' });
  }, 120_000);

  it('removes run_changes with the conversation and everything with the project', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小删');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());

    llm.script(
      'mock-main',
      inWriteTask(
        [step().replyToolCall('write', { path: 'gone.txt', content: 'x' }), step().replyText('好')],
        'RELAY-GONE',
      ),
    );
    await sendBatch(core, conv.id, ['写一个']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000, loopType: 'task' });
    await waitRelay(core, conv.id, 'RELAY-GONE');
    expect((await runChangesRow(core, run.id)).change).not.toBeNull();

    await core.rpc.call('conversations.delete', { id: conv.id });
    const mainDb = core.services.mainDb!;
    const remaining = mainDb
      .prepare('select count(*) as n from run_changes where conversation_id = ?')
      .get(conv.id) as { n: number };
    expect(remaining.n).toBe(0);

    // Removing the project drops its records and checkpoint repo, unbinds others.
    const other = await makeBot(core, '小留');
    const otherConv = await openDirect(core, other.id);
    await bindProject(core, otherConv.id, project.path);
    await core.rpc.call('projects.remove', { id: project.id });
    expect(existsSync(path.join(core.services.paths.home, 'projects', project.id))).toBe(false);
    const bound = (await core.rpc.call('conversations.get', { id: otherConv.id })) as {
      conversation: { projectId: string | null };
    };
    expect(bound.conversation.projectId).toBeNull();
    const afterRemove = (await core.rpc.call('projects.get', { id: project.id })) as {
      project: unknown;
    };
    expect(afterRemove.project).toBeNull();
  }, 240_000);

  // BR-P04-002 under D75: a running turn and a running task (here read-only,
  // after its turn ended) each block switching / unbinding / removing. The old
  // case relied on a reply run still running a bash call a turn no longer has.
  it('blocks switching projects while a turn or a task is executing', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小切');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());

    const turnHeld = step()
      .inTurn()
      .hold()
      .replyToolCall('start_task', {
        title: '看看项目',
        instruction: '看一下项目结构',
        source_message_ids: [],
        writes: false,
      });
    const taskHeld = step().inTask().hold().replyText('看完了');
    llm.script('mock-main', [
      turnHeld,
      step().inTurn().replyText('好的，我去看。'),
      taskHeld,
      step().inTurn().replyText('RELAY-SWITCH'),
    ]);
    const expectBlocked = async () => {
      await expect(
        core.rpc.call('projects.select', { conversationId: conv.id, path: makeProject() }),
      ).rejects.toMatchObject({ code: 'PROJECT_SWITCH_BLOCKED' });
      await expect(core.rpc.call('projects.unbind', { conversationId: conv.id })).rejects.toMatchObject({
        code: 'PROJECT_SWITCH_BLOCKED',
      });
      // BR-P04-002: 执行中同样不能移除 project（会删影子仓与改动记录）。
      await expect(core.rpc.call('projects.remove', { id: project.id })).rejects.toMatchObject({
        code: 'PROJECT_SWITCH_BLOCKED',
      });
    };

    await sendBatch(core, conv.id, ['占住执行']);
    await waitFor(() => (turnHeld.consumed ? true : null), { label: 'turn held', timeoutMs: 30_000 });
    const active = (await listRuns(core, conv.id)).filter(
      (r) => (r.loopType === 'turn' || r.loopType === 'task') && ACTIVE_STATUSES.includes(r.status),
    );
    expect(active.map((r) => r.loopType)).toEqual(['turn']);
    await expectBlocked();

    turnHeld.release();
    await waitFor(() => (taskHeld.consumed ? true : null), { label: 'task held', timeoutMs: 30_000 });
    // The turn has ended; only the task is executing.
    await waitFor(
      async () => {
        const runs = (await listRuns(core, conv.id)).filter(
          (r) => (r.loopType === 'turn' || r.loopType === 'task') && ACTIVE_STATUSES.includes(r.status),
        );
        return runs.length === 1 && runs[0]!.loopType === 'task' ? true : null;
      },
      { label: 'only the task active', timeoutMs: 30_000 },
    );
    await expectBlocked();

    taskHeld.release();
    await waitRelay(core, conv.id, 'RELAY-SWITCH');
    await waitIdle(core, conv.id);
    // 执行结束后移除成功（BR-P04-002 验收的后半段）。
    await core.rpc.call('projects.remove', { id: project.id });
    const afterRemove = (await core.rpc.call('projects.get', { id: project.id })) as {
      project: unknown;
    };
    expect(afterRemove.project).toBeNull();
    // After execution ends binding works again and produces a system message.
    const nextDir = makeProject();
    await core.rpc.call('projects.select', { conversationId: conv.id, path: nextDir });
    const messages = await listMessages(core, conv.id);
    const system = messages.filter(
      (m) => m.senderType === 'system' && 'text' in m.content && m.content.text.includes('项目已'),
    );
    expect(system.length).toBeGreaterThanOrEqual(2); // 绑定 + 重新绑定
  }, 120_000);

  // BR-P04-001 where a lease-layer wait still exists (DEV-015 / design 30
  // §5.1): a write task about to start, blocked on the lease by a non-task
  // holder (the host pseudo-identity — `projects.revert` takes the lease this
  // way). Force revoke closes the holder's window (its own changes recorded),
  // the waiting task starts at once, and no later settle mixes the two.
  it('force revoke frees a lease-layer wait: the write task starts and each holder keeps its own changes (BR-P04-001)', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '被收');
    const botB = await makeBot(core, '接手');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const project = await bindProject(core, convA.id, makeProject());
    await bindProject(core, convB.id, project.path);
    const runtime = core.services.projectRuntime!;

    // 宿主伪身份持租约，写入 a.txt 后一直占着
    const holder: RunIdentity = {
      runId: 'host_lease_holder',
      botId: null,
      conversationId: convA.id,
      loopType: 'host',
    };
    await runtime.ensureWriteLease(holder, project.path);
    writeFileSync(path.join(project.path, 'a.txt'), 'A-change\n');

    // 乙的写任务启动前在租约上排队
    const bWrite = step().replyToolCall('write', { path: 'b.txt', content: 'B-change' });
    llm.script('mock-main', inWriteTask([bWrite, step().replyText('乙写完')], 'RELAY-B'));
    const waiting = waitForEvent<{
      runId: string;
      botId: string | null;
      path: string;
      holder: { runId: string };
    }>(core, 'lease.waiting', (payload) => payload.holder.runId === holder.runId, { timeoutMs: 30_000 });
    await sendBatch(core, convB.id, ['乙也要写']);
    const event = await waiting;
    const bTask = (await taskRuns(core, convB.id))[0]!;
    expect(event).toMatchObject({ runId: bTask.id, botId: botB.id, path: project.path });
    const queued = taskViews(core, botB.id, convB.id).find((t) => t.taskId === bTask.id);
    expect(queued).toMatchObject({ state: 'submitted', queueReason: '等写入租约' });
    // Waiting before it started: the row stays `queued` (waiting_lease is for running runs).
    expect(runOf(core, bTask.id).status).toBe('queued');
    expect(bWrite.consumed).toBe(false);

    // 强制收回：持有方窗口立刻收口（只记录它自己的改动），乙的任务接着启动并写入
    const revoked = (await core.rpc.call('projects.revokeLease', { conversationId: convB.id })) as {
      revoked: boolean;
    };
    expect(revoked.revoked).toBe(true);
    expect(runtime.holdsLease(holder, project.path)).toBe(false);
    expect(runtime.changesOf(holder.runId)?.files).toEqual([{ path: 'a.txt', change: 'added' }]);

    await waitRelay(core, convB.id, 'RELAY-B');
    expect(readFileSync(path.join(project.path, 'b.txt'), 'utf8')).toBe('B-change');
    expect(await changedFiles(core, bTask.id)).toEqual(['b.txt:added']);

    // 持有方随后结束：其 settle 不得把乙的文件并入自己的改动
    await runtime.releaseRun(holder.runId);
    expect(runtime.changesOf(holder.runId)?.files).toEqual([{ path: 'a.txt', change: 'added' }]);
    // Nothing left to revoke.
    expect(
      ((await core.rpc.call('projects.revokeLease', { conversationId: convB.id })) as { revoked: boolean }).revoked,
    ).toBe(false);

    // 乙可独立回退：只删除 b.txt，a.txt（持有方的改动）不受影响
    const revert = (await core.rpc.call('projects.revert', { runId: bTask.id, force: false })) as {
      ok: boolean;
    };
    expect(revert.ok).toBe(true);
    expect(existsSync(path.join(project.path, 'b.txt'))).toBe(false);
    expect(existsSync(path.join(project.path, 'a.txt'))).toBe(true);
  }, 180_000);

  // DEV-015 (待确认): a write task queued in the task layer behind another
  // conversation's write task is not released by a force revoke — the revoke
  // only closes the holder task's window; the queued task starts when the
  // holder ends (or is cancelled on its card).
  it('force revoke does not release a task-layer queue: the second write task waits for the holder task (DEV-015)', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '先占');
    const botB = await makeBot(core, '后等');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const project = await bindProject(core, convA.id, makeProject());
    await bindProject(core, convB.id, project.path);
    const runtime = core.services.projectRuntime!;

    const aHeld = step().hold().replyText('甲停住');
    const bWrite = step().replyToolCall('write', { path: 'b.txt', content: 'B-change' });
    llm.script('mock-main', [
      ...forBot(
        '先占',
        inWriteTask([step().replyToolCall('write', { path: 'a.txt', content: 'A-change' }), aHeld], 'RELAY-A'),
      ),
      ...forBot('后等', inWriteTask([bWrite, step().replyText('乙写完')], 'RELAY-B')),
    ]);
    await sendBatch(core, convA.id, ['甲开始']);
    await waitFor(() => (aHeld.consumed ? true : null), { label: 'A task wrote and is held', timeoutMs: 60_000 });
    const aTask = (await taskRuns(core, convA.id))[0]!;
    await sendBatch(core, convB.id, ['乙也要写']);
    const bTask = await waitFor(async () => (await taskRuns(core, convB.id))[0] ?? null, {
      label: 'B task submitted',
      timeoutMs: 30_000,
    });
    const reason = `等写入租约（任务 ${aTask.id} 持有）`;
    await waitFor(
      () => (taskViews(core, botB.id, convB.id).find((t) => t.taskId === bTask.id)?.queueReason === reason ? true : null),
      { label: 'B queued behind A', timeoutMs: 30_000 },
    );

    // The revoke closes A's window (A's own change recorded) …
    const revoked = (await core.rpc.call('projects.revokeLease', { conversationId: convB.id })) as {
      revoked: boolean;
    };
    expect(revoked.revoked).toBe(true);
    expect(runtime.holdsLease(taskIdentity(aTask), project.path)).toBe(false);
    expect(await changedFiles(core, aTask.id)).toEqual(['a.txt:added']);
    // … but B stays submitted behind A in the task layer.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(taskViews(core, botB.id, convB.id).find((t) => t.taskId === bTask.id)).toMatchObject({
      state: 'submitted',
      queueReason: reason,
    });
    expect(bWrite.consumed).toBe(false);
    expect(existsSync(path.join(project.path, 'b.txt'))).toBe(false);

    // A ends (no further writes) → B starts and writes.
    aHeld.release();
    await waitRelay(core, convA.id, 'RELAY-A');
    await waitRelay(core, convB.id, 'RELAY-B');
    expect(readFileSync(path.join(project.path, 'b.txt'), 'utf8')).toBe('B-change');
    expect(await changedFiles(core, aTask.id)).toEqual(['a.txt:added']);
    expect(await changedFiles(core, bTask.id)).toEqual(['b.txt:added']);

    const revert = (await core.rpc.call('projects.revert', { runId: bTask.id, force: false })) as {
      ok: boolean;
    };
    expect(revert.ok).toBe(true);
    expect(existsSync(path.join(project.path, 'b.txt'))).toBe(false);
    expect(existsSync(path.join(project.path, 'a.txt'))).toBe(true);
  }, 180_000);

  it('injects the <project> context section with AGENTS.md content', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小上下文');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    writeFileSync(path.join(project.path, 'AGENTS.md'), 'ALWAYS-run-tests-first\n');
    writeFileSync(path.join(project.path, 'src.txt'), 'x');

    llm.script('mock-main', [step().replyText('好的')]);
    await sendBatch(core, conv.id, ['你好']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

    expect(llm.requestBodiesContain('<project>')).toBe(true);
    expect(llm.requestBodiesContain('ALWAYS-run-tests-first')).toBe(true);
    expect(llm.requestBodiesContain('README.md')).toBe(true);
    // D75 W2: a turn gets the turn version of <platform_rules> (no
    // acquire_project_write — writes happen in tasks; it routes with start_task).
    expect(llm.requestBodiesContain('start_task')).toBe(true);
    expect(llm.requestBodiesContain('acquire_project_write')).toBe(false);
  }, 240_000);
});

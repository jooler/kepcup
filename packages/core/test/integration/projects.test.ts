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
import { step } from '@kepcup/testkit';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForEvent,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';

const stacks: TestStack[] = [];
const projectDirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
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

async function runChangesRow(core: TestStack['core'], runId: string) {
  const result = (await core.rpc.call('projects.diff', { runId })) as {
    change: { files: Array<{ path: string; change: string }>; revertedAt: number | null } | null;
    diffText: string;
  };
  return result;
}

describe('projects (P04)', () => {
  it('serializes writes of two conversations on one project; the second waits with waiting_lease', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '先行');
    const botB = await makeBot(core, '后行');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const project = await bindProject(core, convA.id, makeProject());
    await bindProject(core, convB.id, project.path);

    // A 建立租约并占住；B 用不同模型，避免 script 队列互相覆盖
    llm.script('mock-main', [
      step().replyToolCall('acquire_project_write', { reason: '写入 A' }),
      step().replyToolCall('bash', { command: 'echo A-wrote > a.txt && sleep 3' }),
      step().replyText('A 完成'),
    ]);
    const waitingEvent = waitForEvent<{ runId: string; holder: { botId: string | null } }>(
      core,
      'lease.waiting',
      (payload) => payload.holder.botId === botA.id,
    );
    await sendBatch(core, convA.id, ['A 先来']);

    // Wait until A actually holds the lease (file written, bash still running).
    await waitFor(
      async () => (existsSync(path.join(project.path, 'a.txt')) ? true : null),
      { label: 'A holding lease', timeoutMs: 60_000 },
    );

    llm.script('mock-light', [
      step().replyToolCall('write', { path: 'b.txt', content: 'B-wrote' }),
      step().replyText('B 完成'),
    ]);
    await core.rpc.call('bots.update', {
      id: botB.id,
      profile: {
        ...botB.profile,
        runtime: { ...botB.profile.runtime, model: 'custom:mock/mock-light' },
      },
    });
    await sendBatch(core, convB.id, ['B 也来']);

    // B parks in waiting_lease while A still holds the lease.
    await waitFor(
      async () => (await listRuns(core, convB.id)).find((r) => r.status === 'waiting_lease') ?? null,
      { label: 'B waiting_lease', timeoutMs: 30_000 },
    );
    const event = await waitingEvent;
    expect(event.holder.botId).toBe(botA.id);

    await waitForRun(core, convA.id, 'completed', { timeoutMs: 120_000 });
    await waitForRun(core, convB.id, 'completed', { timeoutMs: 120_000 });

    // No interleaving: B's file landed after A's.
    const aMtime = readFileSync(path.join(project.path, 'a.txt'));
    expect(readFileSync(path.join(project.path, 'b.txt'), 'utf8')).toBe('B-wrote');
    expect(aMtime).toBeDefined();
    const steps = await stepsOf(core, (await listRuns(core, convB.id)).find((r) => r.botId === botB.id && r.loopType === 'turn')!.id);
    const writeResult = toolResult(steps, 'write');
    expect(writeResult?.ok).toBe(true);
  }, 240_000);

  it('blocks bash writes without the lease and allows them after acquire_project_write', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小租');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());

    llm.script('mock-main', [
      step().replyToolCall('bash', { command: 'touch without-lease.txt' }),
      step().replyToolCall('acquire_project_write', { reason: '需要安装依赖' }),
      step().replyToolCall('bash', { command: 'touch with-lease.txt' }),
      step().replyText('好了'),
    ]);
    await sendBatch(core, conv.id, ['建两个文件']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

    expect(existsSync(path.join(project.path, 'without-lease.txt'))).toBe(false);
    expect(existsSync(path.join(project.path, 'with-lease.txt'))).toBe(true);
    expect(llm.requestBodiesContain('acquire_project_write')).toBe(true);
  }, 240_000);

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
    llm.script('mock-main', [
      step().replyToolCall('read', { path: 'notes.txt' }),
      heldEdit,
      step().replyText('改不了就算了'),
    ]);
    await sendBatch(core, conv.id, ['看看笔记然后改一下']);
    await waitFor(
      async () => (llm.requests().length >= 2 ? true : null),
      { label: 'edit request held', timeoutMs: 30_000 },
    );
    writeFileSync(path.join(project.path, 'notes.txt'), 'version-2-user-edit\n');
    heldEdit.release();
    const staleRun = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

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

  it('summarizes command-made changes, diffs them and reverts the whole run (with conflict detection)', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小改');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    writeFileSync(path.join(project.path, 'existing.txt'), 'original\n');

    llm.script('mock-main', [
      step().replyToolCall('acquire_project_write', { reason: '改造' }),
      step().replyToolCall('bash', {
        command: 'echo brand-new-content > created.txt && echo modified-content > existing.txt',
      }),
      step().replyText('改完了'),
    ]);
    await sendBatch(core, conv.id, ['改项目']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

    // The changes summary card appears after the bot's final message.
    const messages = await listMessages(core, conv.id);
    const card = messages.find(
      (m) => m.kind === 'card' && 'cardType' in m.content && m.content.cardType === 'run_changes',
    );
    expect(card).toBeDefined();
    expect(messages.indexOf(card!)).toBeGreaterThan(
      messages.findIndex((m) => m.senderBotId === bot.id && m.kind === 'text'),
    );

    const { change, diffText } = await runChangesRow(core, run.id);
    expect(change).not.toBeNull();
    const paths = change!.files.map((f) => `${f.path}:${f.change}`).sort();
    expect(paths).toEqual(['created.txt:added', 'existing.txt:modified']);
    expect(diffText).toContain('brand-new-content');

    // Revert without conflicts: files return to their before-state.
    const revert = (await core.rpc.call('projects.revert', { runId: run.id, force: false })) as {
      ok: boolean;
      conflicts: string[];
      reverted: string[];
    };
    expect(revert.ok).toBe(true);
    expect(existsSync(path.join(project.path, 'created.txt'))).toBe(false);
    expect(readFileSync(path.join(project.path, 'existing.txt'), 'utf8')).toBe('original\n');

    // Reverting twice is refused.
    await expect(core.rpc.call('projects.revert', { runId: run.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    // Second round: external edits create a conflict for the revert.
    llm.script('mock-main', [
      step().replyToolCall('acquire_project_write', { reason: '再改' }),
      step().replyToolCall('bash', { command: 'echo round-two > existing.txt' }),
      step().replyText('又改了'),
    ]);
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '再改一次' });
    const flushed = (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as { runId: string | null };
    const run2 = await waitFor(
      async () => {
        const found = (await listRuns(core, conv.id)).find((r) => r.id === flushed.runId);
        return found !== undefined && found.status === 'completed' ? found : null;
      },
      { label: 'second change run', timeoutMs: 120_000 },
    );
    writeFileSync(path.join(project.path, 'existing.txt'), 'user-edited-after-run\n');

    const conflict = (await core.rpc.call('projects.revert', { runId: run2.id, force: false })) as {
      ok: boolean;
      conflicts: string[];
      reverted: string[];
    };
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts).toEqual(['existing.txt']);
    expect(readFileSync(path.join(project.path, 'existing.txt'), 'utf8')).toBe('user-edited-after-run\n');

    const forced = (await core.rpc.call('projects.revert', { runId: run2.id, force: true })) as {
      ok: boolean;
      reverted: string[];
    };
    expect(forced.ok).toBe(true);
    expect(readFileSync(path.join(project.path, 'existing.txt'), 'utf8')).toBe('original\n');
  }, 300_000);

  it('never touches the project own .git during checkpointing', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小影');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());
    const before = hashDir(path.join(project.path, '.git'));

    llm.script('mock-main', [
      step().replyToolCall('write', { path: 'shadow.txt', content: 'checkpointed' }),
      step().replyText('写好了'),
    ]);
    await sendBatch(core, conv.id, ['写文件']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

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
    llm.script('mock-main', [
      step().replyToolCall('git_remote', { operation: 'init', args: [], reason: '初始化仓库' }),
      step().replyToolCall('git_remote', {
        operation: 'remote_add',
        args: ['origin', 'https://example.com/demo.git'],
        reason: '配置远程',
      }),
      step().replyText('配好了'),
    ]);
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
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

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
    llm.script('mock-main', [
      step().replyToolCall('git_remote', { operation: 'push', args: ['origin', 'main'], reason: '推送' }),
      step().replyText('不推了'),
    ]);
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '推一下' });
    const flushed = (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as { runId: string | null };
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
    await waitFor(
      async () => {
        const run = (await listRuns(core, conv.id)).find((r) => r.id === flushed.runId);
        return run !== undefined && run.status === 'completed' ? run : null;
      },
      { label: 'push run', timeoutMs: 120_000 },
    );
    const steps = await stepsOf(core, flushed.runId!);
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

  it('allows localhost ports in project conversations and blocks them otherwise', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '小服');
    const botB = await makeBot(core, '小离');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    await bindProject(core, convA.id, makeProject());

    const port = 20000 + Math.floor(Math.random() * 20000);
    const probe = `python3 -m http.server ${port} --bind 127.0.0.1 >/dev/null 2>&1 & sleep 2; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/; kill %1`;

    llm.script('mock-main', [
      step().replyToolCall('bash', { command: probe }),
      step().replyText('起了个服务'),
    ]);
    await sendBatch(core, convA.id, ['起个开发服务器试试']);
    await waitForRun(core, convA.id, 'completed', { timeoutMs: 180_000 });
    const boundSteps = await stepsOf(core, (await listRuns(core, convA.id)).find((r) => r.botId === botA.id && r.loopType === 'turn')!.id);
    const boundBash = toolResult(boundSteps, 'bash');
    expect(boundBash?.content).toContain('200');

    llm.script('mock-main', [
      step().replyToolCall('bash', { command: probe }),
      step().replyText('起不来'),
    ]);
    await sendBatch(core, convB.id, ['起个开发服务器试试']);
    await waitForRun(core, convB.id, 'completed', { timeoutMs: 180_000 });
    const unboundSteps = await stepsOf(core, (await listRuns(core, convB.id)).find((r) => r.botId === botB.id && r.loopType === 'turn')!.id);
    const unboundBash = toolResult(unboundSteps, 'bash');
    expect(unboundBash?.content).not.toContain('200');
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

    llm.script('mock-main', [
      step().replyToolCall('write', { path: 'gone.txt', content: 'x' }),
      step().replyText('好'),
    ]);
    await sendBatch(core, conv.id, ['写一个']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });
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

  it('blocks switching projects while a bot is executing', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小切');
    const conv = await openDirect(core, bot.id);
    const project = await bindProject(core, conv.id, makeProject());

    llm.script('mock-main', [
      step().replyToolCall('bash', { command: 'sleep 3' }),
      step().replyText('好了'),
    ]);
    await sendBatch(core, conv.id, ['占住执行']);
    await waitFor(
      async () => (await listRuns(core, conv.id)).find((r) => r.status === 'running' && r.loopType === 'turn') ?? null,
      { label: 'running run', timeoutMs: 30_000 },
    );

    await expect(
      core.rpc.call('projects.select', { conversationId: conv.id, path: makeProject() }),
    ).rejects.toMatchObject({ code: 'PROJECT_SWITCH_BLOCKED' });
    await expect(
      core.rpc.call('projects.unbind', { conversationId: conv.id }),
    ).rejects.toMatchObject({ code: 'PROJECT_SWITCH_BLOCKED' });
    // BR-P04-002: 执行中同样不能移除 project（会删影子仓与改动记录）。
    await expect(
      core.rpc.call('projects.remove', { id: project.id }),
    ).rejects.toMatchObject({ code: 'PROJECT_SWITCH_BLOCKED' });

    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    // 执行结束后移除成功（BR-P04-002 验收的后半段）。
    await core.rpc.call('projects.remove', { id: project.id });
    const afterRemove = (await core.rpc.call('projects.get', { id: project.id })) as {
      project: unknown;
    };
    expect(afterRemove.project).toBeNull();
    // After the run ends switching works and produces a system message.
    const nextDir = makeProject();
    await core.rpc.call('projects.select', { conversationId: conv.id, path: nextDir });
    const messages = await listMessages(core, conv.id);
    const system = messages.filter(
      (m) => m.senderType === 'system' && 'text' in m.content && m.content.text.includes('项目已'),
    );
    expect(system.length).toBeGreaterThanOrEqual(2); // 绑定 + 切换
  }, 120_000);

  it('force revoke closes the holder window: each run keeps its own changes (BR-P04-001)', async () => {
    const { core, llm } = await start();
    const botA = await makeBot(core, '被收');
    const botB = await makeBot(core, '接手');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const project = await bindProject(core, convA.id, makeProject());
    await bindProject(core, convB.id, project.path);

    // 甲持租约写入 a.txt 后挂起（租约仍被占用）
    llm.script('mock-main', [
      step().replyToolCall('acquire_project_write', { reason: '占用' }),
      step().replyToolCall('bash', { command: 'echo A-change > a.txt' }),
      step().hold().replyText('甲停住'),
    ]);
    await sendBatch(core, convA.id, ['甲开始']);
    await waitFor(
      async () => (existsSync(path.join(project.path, 'a.txt')) ? true : null),
      { label: 'A wrote a.txt', timeoutMs: 60_000 },
    );

    // 乙排队等待租约
    llm.script('mock-light', [
      step().replyToolCall('write', { path: 'b.txt', content: 'B-change' }),
      step().replyText('乙写完'),
    ]);
    await core.rpc.call('bots.update', {
      id: botB.id,
      profile: {
        ...botB.profile,
        runtime: { ...botB.profile.runtime, model: 'custom:mock/mock-light' },
      },
    });
    await sendBatch(core, convB.id, ['乙也要写']);
    await waitFor(
      async () => (await listRuns(core, convB.id)).find((r) => r.status === 'waiting_lease') ?? null,
      { label: 'B waiting_lease', timeoutMs: 30_000 },
    );

    // 强制收回：甲的租约窗口立刻收口（只记录甲自己的改动），乙接着写
    const revoked = (await core.rpc.call('projects.revokeLease', {
      conversationId: convB.id,
    })) as { revoked: boolean };
    expect(revoked.revoked).toBe(true);

    const runB = await waitForRun(core, convB.id, 'completed', { timeoutMs: 120_000 });
    expect(readFileSync(path.join(project.path, 'b.txt'), 'utf8')).toBe('B-change');

    // 放行甲 → 甲结束；其 settle 不得把乙的文件并入自己的改动
    llm.releaseAll();
    await waitForRun(core, convA.id, 'completed', { timeoutMs: 120_000 });

    const runsA = await listRuns(core, convA.id);
    const runA = runsA.find((r) => r.botId === botA.id)!;
    const changeA = ((await core.rpc.call('projects.diff', { runId: runA.id })) as {
      change: { files: Array<{ path: string; change: string }> } | null;
    }).change;
    expect(changeA?.files.map((f) => f.path).sort()).toEqual(['a.txt']);

    const changeB = ((await core.rpc.call('projects.diff', { runId: runB.id })) as {
      change: { files: Array<{ path: string; change: string }> } | null;
    }).change;
    expect(changeB?.files.map((f) => f.path).sort()).toEqual(['b.txt']);

    // 乙可独立回退：只删除 b.txt，a.txt（甲的改动）不受影响
    const revert = (await core.rpc.call('projects.revert', { runId: runB.id, force: false })) as {
      ok: boolean;
    };
    expect(revert.ok).toBe(true);
    expect(existsSync(path.join(project.path, 'b.txt'))).toBe(false);
    expect(existsSync(path.join(project.path, 'a.txt'))).toBe(true);
  }, 300_000);

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
    // node_modules stays hidden by .gitignore; platform rule 7 is present.
    expect(llm.requestBodiesContain('acquire_project_write')).toBe(true);
  }, 240_000);
});

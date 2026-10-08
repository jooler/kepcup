import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, Bot, Run } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAcpAgentLaunch,
  listRuns,
  makeBot,
  openDirect,
  readFakeAgentRecord,
  sendBatch,
  step,
  waitFor,
  waitForRun,
  writeFakeAgentScript,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 外部智能体 P3：权限与隔离（todo/acp-external-agents.md §6.2，D72）。真库 +
 * 子进程假 Agent：权限桥分级（工作目录内写放行、越界写弹卡 → 拒绝 →
 * reject_once、数据目录拒绝、无人值守底线、命令白名单、无 OS 沙箱命令逐条
 * 弹卡）、模式纠偏、project 内 Agent 配置确认、显式租约与检查点。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function startWithFakeAgent(script: FakeAgentScript) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kepcup-ext-p3-'));
  dirs.push(dir);
  const scriptFile = path.join(dir, 'script.json');
  const recordFile = path.join(dir, 'record.jsonl');
  writeFakeAgentScript(scriptFile, script);
  const stack = await createTestStack({
    agentLaunch: (entry) =>
      entry.id === 'fake' ? fakeAcpAgentLaunch(scriptFile, recordFile) : null,
  });
  stacks.push(stack);
  await stack.core.rpc.call('settings.update', {
    experimental: { externalAgents: true },
    agents: { fake: { enabled: true } },
  });
  return { ...stack, dir, record: () => readFakeAgentRecord(recordFile) };
}

async function agentBot(
  stack: TestStack,
  name: string,
  permission: 'read_only' | 'workspace' | 'ask' = 'workspace',
): Promise<Bot> {
  const bot = await makeBot(stack.core, name);
  const result = (await stack.core.rpc.call('bots.update', {
    id: bot.id,
    profile: {
      ...bot.profile,
      runtime: {
        ...bot.profile.runtime,
        agent: { ...bot.profile.runtime.agent, id: 'fake', permission },
      },
    },
  })) as { bot: Bot };
  return result.bot;
}

async function approvals(stack: TestStack, conversationId: string): Promise<Approval[]> {
  return (
    (await stack.core.rpc.call('approvals.list', { conversationId })) as { approvals: Approval[] }
  ).approvals;
}

async function pendingAgentTool(stack: TestStack, conversationId: string): Promise<Approval> {
  return waitFor(
    async () =>
      (await approvals(stack, conversationId)).find(
        (a) => a.kind === 'agent_tool' && a.status === 'pending',
      ) ?? null,
    { label: 'pending agent_tool approval', timeoutMs: 20_000 },
  );
}

function outcomes(record: ReturnType<typeof readFakeAgentRecord>) {
  return Object.fromEntries(
    record.permissions.map((p) => [
      p.toolCallId,
      p.outcome.outcome === 'selected' ? p.outcome.optionId : p.outcome.outcome,
    ]),
  );
}

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'p3-proj-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

async function bindProject(stack: TestStack, conversationId: string, dir: string): Promise<string> {
  const result = (await stack.core.rpc.call('projects.select', { conversationId, path: dir })) as {
    project: { path: string };
  };
  return result.project.path;
}

describe('external agent permission bridge (P3, fake agent, real db)', () => {
  it('workspace tier: writes inside the cwd pass; writes outside raise an agent_tool card → deny → reject_once', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'p3-outside-'));
    dirs.push(outside);
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .permission('in', 'Edit notes.md', { kind: 'edit', locations: ['notes.md'] })
          .permission('out', 'Write outside', {
            kind: 'edit',
            locations: [path.join(outside, 'x.txt')],
          })
          .permission('read-in', 'Read notes.md', { kind: 'read', locations: ['notes.md'] })
          .text('完成'),
      ],
    });
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['改文件']);

    const card = await pendingAgentTool(stack, conv.id);
    expect(card.payload).toMatchObject({
      agentId: 'fake',
      kind: 'write',
      access: 'write',
      locations: [path.join(realpathSync(outside), 'x.txt')],
      durations: ['once', 'conversation'],
    });
    // The run parks in waiting_approval like a built-in run.
    await waitFor(
      async () =>
        (await listRuns(stack.core, conv.id)).find((r) => r.status === 'waiting_approval') ?? null,
      { label: 'waiting_approval' },
    );
    // The context line has a real rendering (not「审批记录已清理」).
    const domainApprovals = stack.core.services.domain!.approvals;
    expect(domainApprovals.renderContextLine(card)).toBe(
      `[系统] 等待用户确认：外援 经智能体「Fake Agent」写入 <untrusted>${path.join(realpathSync(outside), 'x.txt')}</untrusted>`,
    );
    await stack.core.rpc.call('approvals.decide', { id: card.id, approve: false });
    expect(domainApprovals.renderContextLine(domainApprovals.get(card.id)!)).toMatch(
      /^\[系统\] 用户拒绝外援 经智能体「Fake Agent」写入 /,
    );
    await waitForRun(stack.core, conv.id, 'completed');

    expect(outcomes(stack.record())).toEqual({
      in: 'allow_once',
      out: 'reject_once',
      'read-in': 'allow_once',
    });
    const rows = await approvals(stack, conv.id);
    expect(rows.filter((a) => a.kind === 'agent_tool').map((a) => a.status)).toEqual(['denied']);
    const audit = stack.core.services.domain!.audit.listByConversation(conv.id, 100);
    expect(audit.filter((a) => a.action === 'agent_permission').length).toBe(3);
  }, 60_000);

  it('approving a path card for the conversation grants it: the next request passes without a card', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'p3-grant-'));
    dirs.push(outside);
    const target = path.join(outside, 'data.csv');
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .permission('r1', 'Read data', { kind: 'read', locations: [target] })
          .text('一'),
        agentTurn()
          .permission('r2', 'Read data', { kind: 'read', locations: [target] })
          .text('二'),
      ],
    });
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['读数据']);
    const card = await pendingAgentTool(stack, conv.id);
    await stack.core.rpc.call('approvals.decide', {
      id: card.id,
      approve: true,
      duration: 'conversation',
    });
    await waitForRun(stack.core, conv.id, 'completed');
    await sendBatch(stack.core, conv.id, ['再读一次']);
    await waitFor(
      async () =>
        (await listRuns(stack.core, conv.id)).filter((r) => r.status === 'completed').length === 2
          ? true
          : null,
      { label: 'second run completed', timeoutMs: 30_000 },
    );
    expect(outcomes(stack.record())).toEqual({ r1: 'allow_once', r2: 'allow_once' });
    const rows = (await approvals(stack, conv.id)).filter((a) => a.kind === 'agent_tool');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toEqual({ duration: 'conversation' });
  }, 60_000);

  it('the data directory is refused outright, and unattended mode keeps the floor for commands', async () => {
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          // Placeholder paths: rewritten below once the data home is known.
          .permission('db', 'Write main.db', { kind: 'edit', locations: ['__HOME__/main.db'] })
          .permission('cmd', 'cat main.db', {
            kind: 'execute',
            rawInput: { command: 'cp __HOME__/main.db /tmp/stolen.db' },
          })
          .permission('ws', 'ls workspace', {
            kind: 'execute',
            rawInput: { command: 'touch __WS__/ok.txt' },
          })
          // Review H3: relative tokens climb out of the workspace cwd.
          .permission('rel', 'rm skills', {
            kind: 'execute',
            rawInput: { command: 'rm -rf ../../../skills-library' },
          })
          // Review H3: a working directory inside the data dir is refused outright.
          .permission('cwd', 'rm in home', {
            kind: 'execute',
            rawInput: { command: 'rm main.db', cwd: '__HOME__' },
          })
          // Review M1: unattended never approves an unrecognized request.
          .permission('other', 'mystery tool')
          .text('结束'),
      ],
    });
    const home = stack.core.services.paths.home;
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    const workspace = path.join(home, 'bots', bot.id, 'workspaces', conv.id);
    // Rewrite the script with the real paths (the agent process starts lazily).
    const scriptFile = path.join(stack.dir, 'script.json');
    writeFileSync(
      scriptFile,
      readFileSync(scriptFile, 'utf8').replaceAll('__HOME__', home).replaceAll('__WS__', workspace),
    );
    await stack.core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    await sendBatch(stack.core, conv.id, ['动手']);
    await waitForRun(stack.core, conv.id, 'completed');

    // main.db: rejected without a card; cp from the data dir: auto-denied by
    // the unattended floor; touching the run's own workspace: auto-approved.
    expect(outcomes(stack.record())).toEqual({
      db: 'reject_once',
      cmd: 'reject_once',
      ws: 'allow_once',
      rel: 'reject_once',
      cwd: 'reject_once',
      other: 'reject_once',
    });
    const rows = (await approvals(stack, conv.id)).filter((a) => a.kind === 'agent_tool');
    expect(
      rows
        .map((a) => [a.payload['command'] ?? a.payload['title'], a.status, a.autoApproved])
        .sort(),
    ).toEqual(
      [
        [`cp ${home}/main.db /tmp/stolen.db`, 'denied', true],
        [`touch ${workspace}/ok.txt`, 'approved', true],
        ['rm -rf ../../../skills-library', 'denied', true],
        ['mystery tool', 'denied', true],
      ].sort(),
    );
  }, 60_000);

  it('commands: without an OS sandbox every command is confirmed — the allowlist does not apply (review H2)', async () => {
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .permission('npm', 'npm install', {
            kind: 'execute',
            rawInput: { command: ['bash', '-lc', 'npm install left-pad'] },
          })
          .text('装好了'),
      ],
    });
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['装依赖']);
    const card = await pendingAgentTool(stack, conv.id);
    expect(card.payload).toMatchObject({
      kind: 'execute',
      command: 'npm install left-pad',
      durations: ['once'],
    });
    expect(String(card.payload['reason'])).toContain('OS 沙箱');
    // A conversation-wide answer is downgraded to「仅这一次」for commands.
    await stack.core.rpc.call('approvals.decide', {
      id: card.id,
      approve: true,
      duration: 'conversation',
    });
    await waitForRun(stack.core, conv.id, 'completed');
    expect(outcomes(stack.record())).toEqual({ npm: 'allow_once' });
    const decided = (await approvals(stack, conv.id)).find((a) => a.id === card.id)!;
    expect(decided.decision).toEqual({ duration: 'once' });
  }, 60_000);

  it('read_only tier: writes and non-allowlisted commands are rejected without cards', async () => {
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .permission('w', 'Edit', { kind: 'edit', locations: ['a.txt'] })
          .permission('x', 'rm', { kind: 'execute', rawInput: { command: 'rm -rf build' } })
          // Even an allowlisted command: the generic agent has no confirmed sandbox.
          .permission('ls', 'ls', { kind: 'execute', rawInput: { command: 'ls -la' } })
          .permission('o', 'mystery tool')
          .permission('m', 'plan', { kind: 'switch_mode' })
          .text('只读'),
      ],
    });
    const bot = await agentBot(stack, '只读外援', 'read_only');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['试试']);
    await waitForRun(stack.core, conv.id, 'completed');
    expect(outcomes(stack.record())).toEqual({
      w: 'reject_once',
      x: 'reject_once',
      ls: 'reject_once',
      o: 'reject_once',
      m: 'reject_once',
    });
    expect((await approvals(stack, conv.id)).filter((a) => a.kind === 'agent_tool')).toEqual([]);
  }, 60_000);

  it('cancelling the run answers a pending permission request with cancelled', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'p3-cancel-'));
    dirs.push(outside);
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .permission('out', 'Write outside', {
            kind: 'edit',
            locations: [path.join(outside, 'y')],
          })
          .waitCancel(),
      ],
    });
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['写']);
    await pendingAgentTool(stack, conv.id);
    const run = (await listRuns(stack.core, conv.id))[0]!;
    await stack.core.rpc.call('runs.cancel', { runId: run.id });
    await waitForRun(stack.core, conv.id, 'cancelled');
    await waitFor(async () => (stack.record().permissions.length > 0 ? true : null), {
      label: 'permission answered',
    });
    expect(outcomes(stack.record())).toEqual({ out: 'cancelled' });
    const rows = (await approvals(stack, conv.id)).filter((a) => a.kind === 'agent_tool');
    expect(rows.map((a) => a.status)).toEqual(['cancelled']);
  }, 60_000);

  it('switches the agent back when it moves itself into a bypass mode (audited)', async () => {
    const stack = await startWithFakeAgent({
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'bypassPermissions', name: 'Bypass' },
        ],
      },
      turns: [agentTurn().modeUpdate('bypassPermissions').sleep(100).text('好')],
    });
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['开始']);
    await waitForRun(stack.core, conv.id, 'completed');
    await waitFor(
      async () =>
        stack.record().events.some((e) => e.kind === 'mode' && e.modeId === 'default')
          ? true
          : null,
      { label: 'mode switched back' },
    );
    const audit = stack.core.services.domain!.audit.listByConversation(conv.id, 100);
    const reverted = audit.find((a) => a.action === 'agent_mode_reverted');
    expect(reverted?.detail).toMatchObject({
      actual: 'bypassPermissions',
      expected: 'default',
      forbidden: true,
    });
  }, 60_000);
});

describe('external agents in a project (P3: config confirmation, explicit lease, checkpoints)', () => {
  it('asks once per conversation before running with project-side agent config', async () => {
    const stack = await startWithFakeAgent({
      turns: [agentTurn().text('一'), agentTurn().text('二')],
    });
    const bot = await agentBot(stack, '外援', 'read_only');
    const conv = await openDirect(stack.core, bot.id);
    const project = makeProject();
    writeFileSync(path.join(project, 'AGENTS.md'), '# agent rules\n');
    await bindProject(stack, conv.id, project);

    await sendBatch(stack.core, conv.id, ['第一次']);
    const card = await pendingAgentTool(stack, conv.id);
    expect(card.payload).toMatchObject({ kind: 'config', locations: ['AGENTS.md'] });
    await stack.core.rpc.call('approvals.decide', { id: card.id, approve: true });
    await waitForRun(stack.core, conv.id, 'completed');

    await sendBatch(stack.core, conv.id, ['第二次']);
    await waitFor(
      async () =>
        (await listRuns(stack.core, conv.id)).filter((r) => r.status === 'completed').length === 2
          ? true
          : null,
      { label: 'second run', timeoutMs: 30_000 },
    );
    expect((await approvals(stack, conv.id)).filter((a) => a.kind === 'agent_tool')).toHaveLength(
      1,
    );
  }, 60_000);

  it('agent config above the project up to the git root is confirmed too (P5 review H1)', async () => {
    const stack = await startWithFakeAgent({ turns: [agentTurn().text('一')] });
    const bot = await agentBot(stack, '外援', 'read_only');
    const conv = await openDirect(stack.core, bot.id);
    const repo = makeProject();
    writeFileSync(path.join(repo, 'AGENTS.md'), '# repo-wide agent rules\n');
    const sub = path.join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    await bindProject(stack, conv.id, sub);

    await sendBatch(stack.core, conv.id, ['在子目录里干活']);
    const card = await pendingAgentTool(stack, conv.id);
    expect(card.payload).toMatchObject({ kind: 'config' });
    const payload = card.payload as { locations: string[]; reason: string };
    expect(payload.locations.map((location) => realpathSync(location))).toEqual([
      realpathSync(path.join(repo, 'AGENTS.md')),
    ]);
    expect(payload.reason).toContain('可能放宽');
    expect(payload.reason).toContain('git 根目录');
    await stack.core.rpc.call('approvals.decide', { id: card.id, approve: true });
    await waitForRun(stack.core, conv.id, 'completed');
  }, 60_000);

  it('a denied config confirmation fails the run without starting the agent', async () => {
    const stack = await startWithFakeAgent({ turns: [agentTurn().text('不该运行')] });
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    const project = makeProject();
    writeFileSync(path.join(project, 'AGENTS.md'), '# agent rules\n');
    await bindProject(stack, conv.id, project);
    await sendBatch(stack.core, conv.id, ['开始']);
    const card = await pendingAgentTool(stack, conv.id);
    await stack.core.rpc.call('approvals.decide', { id: card.id, approve: false });
    const run = await waitForRun(stack.core, conv.id, 'failed');
    expect(run.error).toContain('未确认');
    expect(stack.record().prompts).toEqual([]);
  }, 60_000);

  it('review M2: remembered only for the same content, never from unattended mode; agent writes to the config confirm', async () => {
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn().text('一'),
        agentTurn()
          .permission('cfg', 'Edit AGENTS.md', { kind: 'edit', locations: ['AGENTS.md'] })
          .text('二'),
        agentTurn().text('三'),
      ],
    });
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    const project = makeProject();
    writeFileSync(path.join(project, 'AGENTS.md'), '# v1\n');
    await bindProject(stack, conv.id, project);
    const configCards = async () =>
      (await approvals(stack, conv.id)).filter(
        (a) => a.kind === 'agent_tool' && a.payload['kind'] === 'config',
      );
    const completed = (n: number) =>
      waitFor(
        async () =>
          (await listRuns(stack.core, conv.id)).filter((r) => r.status === 'completed').length === n
            ? true
            : null,
        { label: `${n} completed`, timeoutMs: 30_000 },
      );

    // 1) Unattended auto-approval runs the agent but is not remembered.
    await stack.core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    await sendBatch(stack.core, conv.id, ['一']);
    await completed(1);
    await stack.core.rpc.call('unattended.disable');
    // 2) Asked again (user present); the agent's own write to AGENTS.md asks too.
    await sendBatch(stack.core, conv.id, ['二']);
    const card = await waitFor(
      async () => (await configCards()).find((a) => a.status === 'pending') ?? null,
      { label: 'config card again' },
    );
    await stack.core.rpc.call('approvals.decide', { id: card.id, approve: true });
    const writeCard = await waitFor(
      async () =>
        (await approvals(stack, conv.id)).find(
          (a) => a.kind === 'agent_tool' && a.payload['kind'] === 'write' && a.status === 'pending',
        ) ?? null,
      { label: 'config write card' },
    );
    expect(writeCard.payload).toMatchObject({ sensitive: true });
    await stack.core.rpc.call('approvals.decide', { id: writeCard.id, approve: false });
    await completed(2);
    // 3) Content changed → asked once more.
    writeFileSync(path.join(project, 'AGENTS.md'), '# v2 — changed\n');
    await sendBatch(stack.core, conv.id, ['三']);
    const third = await waitFor(
      async () => (await configCards()).find((a) => a.status === 'pending') ?? null,
      { label: 'config card after change' },
    );
    await stack.core.rpc.call('approvals.decide', { id: third.id, approve: true });
    await completed(3);
    expect((await configCards()).map((a) => [a.status, a.autoApproved])).toEqual([
      ['approved', false],
      ['approved', false],
      ['approved', true],
    ]);
    expect(outcomes(stack.record())).toEqual({ cfg: 'reject_once' });
  }, 90_000);

  it('review M6: the external run lease is pinned — another lease target is refused during the run', async () => {
    const stack = await startWithFakeAgent({
      turns: [agentTurn().sleep(2_500).text('完成')],
    });
    const project = makeProject();
    const other = mkdtempSync(path.join(tmpdir(), 'p3-other-'));
    dirs.push(other);
    const bot = await agentBot(stack, '外援');
    const conv = await openDirect(stack.core, bot.id);
    const projectPath = await bindProject(stack, conv.id, project);
    await sendBatch(stack.core, conv.id, ['开始']);
    const run = await waitFor(
      async () => (await listRuns(stack.core, conv.id)).find((r) => r.status === 'running') ?? null,
      { label: 'running' },
    );
    const identity = {
      runId: run.id,
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'turn' as const,
    };
    await waitFor(async () => (stack.record().prompts.length > 0 ? true : null), {
      label: 'agent prompted',
    });
    stack.core.services.domain!.grants.create({
      botId: bot.id,
      conversationId: conv.id,
      path: realpathSync(other),
      access: 'write',
      duration: 'conversation',
    });
    const runtime = stack.core.services.projectRuntime!;
    await expect(
      runtime.ensureWriteLease(identity, path.join(realpathSync(other), 'x.txt')),
    ).rejects.toMatchObject({ code: 'PATH_OUT_OF_SCOPE' });
    // The project itself is still held by this run.
    await expect(
      runtime.ensureWriteLease(identity, path.join(projectPath, 'a')),
    ).resolves.toBeTruthy();
    await waitForRun(stack.core, conv.id, 'completed', { timeoutMs: 30_000 });
  }, 60_000);

  it('holds the project write lease for the whole run: a built-in bot waits; changes diff and revert', async () => {
    const stack = await startWithFakeAgent({
      turns: [agentTurn().writeFile('agent.txt', 'from agent\n').sleep(2_500).text('写好了')],
    });
    const project = makeProject();
    const agent = await agentBot(stack, '外援');
    const agentConv = await openDirect(stack.core, agent.id);
    const projectPath = await bindProject(stack, agentConv.id, project);
    const builtin = await makeBot(stack.core, '内置');
    const builtinConv = await openDirect(stack.core, builtin.id);
    await bindProject(stack, builtinConv.id, project);

    await sendBatch(stack.core, agentConv.id, ['写一个文件']);
    await waitFor(async () => (existsSync(path.join(project, 'agent.txt')) ? true : null), {
      label: 'agent wrote',
      timeoutMs: 30_000,
    });
    stack.llm.script('mock-main', [
      step().replyToolCall('write', { path: 'builtin.txt', content: 'from builtin' }),
      step().replyText('我也写好了'),
    ]);
    await sendBatch(stack.core, builtinConv.id, ['你也写一个']);
    const waiting = await waitFor(
      async () =>
        (await listRuns(stack.core, builtinConv.id)).find((r) => r.status === 'waiting_lease') ??
        null,
      { label: 'built-in waiting_lease', timeoutMs: 30_000 },
    );
    expect(waiting.botId).toBe(builtin.id);
    // The agent run still holds the lease: the built-in file is not there yet.
    expect(existsSync(path.join(project, 'builtin.txt'))).toBe(false);

    const agentRun: Run = await waitForRun(stack.core, agentConv.id, 'completed', {
      timeoutMs: 60_000,
    });
    await waitForRun(stack.core, builtinConv.id, 'completed', { timeoutMs: 60_000 });
    expect(readFileSync(path.join(projectPath, 'builtin.txt'), 'utf8')).toBe('from builtin');

    const diff = (await stack.core.rpc.call('projects.diff', { runId: agentRun.id })) as {
      change: { files: Array<{ path: string; change: string }> } | null;
    };
    expect(diff.change?.files.map((f) => `${f.path}:${f.change}`)).toEqual(['agent.txt:added']);
    const revert = (await stack.core.rpc.call('projects.revert', {
      runId: agentRun.id,
      force: false,
    })) as { ok: boolean };
    expect(revert.ok).toBe(true);
    expect(existsSync(path.join(project, 'agent.txt'))).toBe(false);
    expect(existsSync(path.join(project, 'builtin.txt'))).toBe(true);
  }, 120_000);
});

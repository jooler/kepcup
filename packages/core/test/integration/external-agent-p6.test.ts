import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_TURN_BUDGET_TOKENS, type Bot } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAcpAgentLaunch,
  listRuns,
  makeBot,
  openDirect,
  readFakeAgentRecord,
  sendBatch,
  waitFor,
  waitForRun,
  writeFakeAgentScript,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';

/**
 * D72 P6：无内置模型、只有外部 Agent 时后台 loop 经 llm-router 改走 Agent
 * （todo/acp-external-agents.md §9.1）：反思 / 摘要以一次性精简会话「只输出
 * JSON」完成，用量记在 `agent:{id}` 下；反思按 AGENT_BACKGROUND_EVERY_N_RUNS
 * 降频；Wiki 维护以后台精简会话经宿主桥工具写页面。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(script: FakeAgentScript) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kepcup-ext-agent-p6-'));
  dirs.push(dir);
  const scriptFile = path.join(dir, 'script.json');
  const recordFile = path.join(dir, 'record.jsonl');
  writeFakeAgentScript(scriptFile, script);
  // No built-in model: KEPCUP_MOCK_LLM_URL='' skips the mock provider seed.
  const stack = await createTestStack({
    env: { KEPCUP_MOCK_LLM_URL: '' },
    agentLaunch: (entry) =>
      entry.id === 'fake' ? fakeAcpAgentLaunch(scriptFile, recordFile) : null,
  });
  stacks.push(stack);
  await stack.core.rpc.call('settings.update', {
    experimental: { externalAgents: true },
    agents: { fake: { enabled: true } },
  });
  return { ...stack, record: () => readFakeAgentRecord(recordFile) };
}

async function useAgent(stack: TestStack, bot: Bot, agentId: string): Promise<Bot> {
  const profile = {
    ...bot.profile,
    runtime: { ...bot.profile.runtime, agent: { ...bot.profile.runtime.agent, id: agentId } },
  };
  return ((await stack.core.rpc.call('bots.update', { id: bot.id, profile })) as { bot: Bot }).bot;
}

/** One JSON answer valid for both the reflection and the summary schema. */
const BACKGROUND_JSON = JSON.stringify({
  summary: '用户喜欢绿茶。',
  runSummary: '记下了饮品偏好',
  memories: [],
  profileProposals: [],
  wikiSuggestions: [],
});

function jobRows(stack: TestStack, types: string[]) {
  return stack.core.services
    .mainDb!.prepare(
      `select type, status, last_error as lastError from jobs where type in (${types.map(() => '?').join(',')})`,
    )
    .all(...types) as Array<{ type: string; status: string; lastError: string | null }>;
}

describe('background loops on an external agent (P6 llm-router)', () => {
  it('reflection + summary run as one-shot JSON sessions; usage under agent:fake; reflection throttled', async () => {
    const stack = await start({
      sessionClose: true,
      turns: [
        agentTurn().text('收到。'),
        agentTurn().text(BACKGROUND_JSON),
        agentTurn().text(`\`\`\`json\n${BACKGROUND_JSON}\n\`\`\``),
        agentTurn().text('好的。'),
      ],
    });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['记一下：我喜欢绿茶']);
    await waitForRun(stack.core, conv.id, 'completed');
    stack.core.services.domain!.jobs.enqueue({
      type: 'conversation_summary',
      conversationId: conv.id,
      payload: { targetSeq: 2 },
      priority: 2,
      dedupeKey: `conversation_summary:${conv.id}`,
    });
    await waitFor(
      () => {
        const rows = jobRows(stack, ['reflection', 'conversation_summary']);
        return rows.length === 2 && rows.every((row) => row.status === 'done') ? rows : null;
      },
      { label: 'background jobs done', timeoutMs: 30_000 },
    );
    expect(jobRows(stack, ['reflection', 'conversation_summary']).map((r) => r.lastError)).toEqual([
      null,
      null,
    ]);
    const background = (await listRuns(stack.core, conv.id)).filter(
      (run) => run.loopType !== 'response',
    );
    expect(background.map((run) => [run.loopType, run.status]).sort()).toEqual([
      ['conversation_summary', 'completed'],
      ['reflection', 'completed'],
    ]);
    const summary = stack.core.services.domain!.conversations.get(conv.id);
    expect(summary?.summary).toBe('用户喜欢绿茶。');

    // Usage: one (zero-token) row per background call, under the agent key.
    const usage = stack.core.services
      .mainDb!.prepare(
        "select loop_type as loopType, provider, model from usage_ledger where loop_type in ('reflection', 'conversation_summary') order by loop_type",
      )
      .all() as Array<{ loopType: string; provider: string; model: string }>;
    expect(usage).toEqual([
      { loopType: 'conversation_summary', provider: 'agent:fake', model: 'default' },
      { loopType: 'reflection', provider: 'agent:fake', model: 'default' },
    ]);

    // The daily background budget charges a token-less agent round as
    // AGENT_TURN_BUDGET_TOKENS (the reflection row belongs to the bot).
    expect(stack.core.services.budget!.usedToday(bot.id)).toBe(AGENT_TURN_BUDGET_TOKENS);

    // One-shot sessions: own temp cwd (gone), no MCP bridge, JSON-only prompt.
    const record = stack.record();
    const workspace = record.sessions[0]!.cwd;
    const oneShot = record.sessions.slice(1, 3);
    expect(oneShot).toHaveLength(2);
    for (const session of oneShot) {
      expect(session.cwd).not.toBe(workspace);
      expect(session.mcpServers).toEqual([]);
      expect(existsSync(session.cwd)).toBe(false);
    }
    for (const prompt of record.prompts.slice(1, 3)) {
      expect(prompt.text).toContain('<output_format>');
    }
    await waitFor(() => (stack.record().closedSessions.length >= 2 ? true : null), {
      label: 'one-shot sessions closed',
    });

    // Second response run: its reflection is throttled (1 in N) — no prompt.
    await sendBatch(stack.core, conv.id, ['今天天气不错']);
    await waitFor(
      async () =>
        (await listRuns(stack.core, conv.id)).filter(
          (run) => run.loopType === 'response' && run.status === 'completed',
        ).length === 2
          ? true
          : null,
      { label: 'second response run' },
    );
    await waitFor(
      () => {
        const rows = jobRows(stack, ['reflection']);
        return rows.length === 2 && rows.every((row) => row.status === 'done') ? rows : null;
      },
      { label: 'second reflection job done' },
    );
    const reflections = (await listRuns(stack.core, conv.id)).filter(
      (run) => run.loopType === 'reflection',
    );
    expect(reflections).toHaveLength(1);
    expect(stack.record().prompts).toHaveLength(4);
  }, 60_000);

  it('background agent off / skill authoring default off: requestAuthoring refuses, loops skip', async () => {
    const stack = await start({ turns: [] });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const facade = stack.core.services.llmRouter!;
    expect(facade.resolveForBot(bot.id, 'reflection')).toMatchObject({
      agentId: 'fake',
      provider: 'agent:fake',
      modelRef: 'agent:fake/default',
    });
    expect(facade.resolveForBot(bot.id, 'skill_authoring')).toBeNull();
    expect(facade.resolveForBot(bot.id, 'continuation')).toBeNull();
    await stack.core.rpc.call('settings.update', {
      backgroundTasks: { agentSkillAuthoring: true },
    });
    expect(facade.resolveForBot(bot.id, 'skill_authoring')).toMatchObject({ agentId: 'fake' });
    await stack.core.rpc.call('settings.update', { backgroundTasks: { agentEnabled: false } });
    expect(facade.resolveForBot(bot.id, 'reflection')).toBeNull();
    // The merged patch kept the other switch.
    const settings = (await stack.core.rpc.call('settings.get')) as {
      backgroundTasks: Record<string, boolean>;
    };
    expect(settings.backgroundTasks).toEqual({
      agentEnabled: false,
      agentSkillAuthoring: true,
      groupMentionOnly: false,
    });
    await expect(
      stack.core.rpc.call('settings.update', { backgroundAgentId: 'nope' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 30_000);

  it('wiki lint runs as a background agent session writing pages through the host bridge', async () => {
    const stack = await start({
      sessionClose: true,
      turns: [
        agentTurn()
          .mcpCall('w1', 'write', {
            path: 'pages/agent-note.md',
            content: '# 外援笔记\n\n巡检完成。',
          })
          .text('巡检完成'),
      ],
    });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    stack.core.services.domain!.jobs.enqueue({
      type: 'wiki_lint',
      botId: bot.id,
      payload: { trigger: 'weekly' },
      priority: 2,
      dedupeKey: `wiki_lint:${bot.id}`,
    });
    await waitFor(
      () => {
        const rows = jobRows(stack, ['wiki_lint']);
        return rows.length === 1 && rows[0]!.status !== 'pending' && rows[0]!.status !== 'running'
          ? rows
          : null;
      },
      { label: 'wiki lint settled', timeoutMs: 30_000 },
    );
    expect(jobRows(stack, ['wiki_lint'])).toEqual([
      { type: 'wiki_lint', status: 'done', lastError: null },
    ]);
    const page = path.join(
      stack.core.services.paths!.home,
      'bots',
      bot.id,
      'wiki',
      'pages',
      'agent-note.md',
    );
    expect(readFileSync(page, 'utf8')).toContain('巡检完成');
    const record = stack.record();
    const session = record.sessions[0]!;
    // Background session: private temp cwd, host bridge only.
    expect(session.cwd.startsWith(stack.core.services.paths!.home)).toBe(false);
    expect(session.mcpServers).toHaveLength(1);
    const run = stack.core.services
      .runsDb!.prepare("select engine, provider from runs where loop_type = 'wiki_maintenance'")
      .get() as { engine: string; provider: string };
    expect(run).toEqual({ engine: 'agent:fake', provider: 'agent:fake' });
  }, 60_000);
});

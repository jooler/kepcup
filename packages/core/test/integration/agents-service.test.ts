import { afterEach, describe, expect, it } from 'vitest';
import type { AgentView, Bot } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentEntry,
  fakeAgentSpawner,
  makeBot,
  waitFor,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 外部智能体服务（D72 P4，todo §7.1 / §7.2）：设置页「智能体」的 RPC 流转——
 * 实验开关、启用 / 停用 / 卸载（受影响 Bot 二次确认）、测试连接、模型选项、
 * 登录（agent 类 authenticate / terminal 子进程 / API key）与状态机。
 * 假 Agent 经 testkit 的进程内 spawner 驱动。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

const MODEL_OPTIONS: FakeAgentScript['configOptions'] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'fast',
    options: [
      { value: 'fast', name: 'Fast' },
      { value: 'smart', name: 'Smart' },
    ],
  },
];

async function startStack(
  scripts: Record<string, FakeAgentScript | FakeAgentScript[]>,
  options: {
    extra?: ReturnType<typeof fakeAgentEntry>[];
    launch?: (
      id: string,
    ) => { command: string; args: string[]; env: Record<string, string> } | null;
  } = {},
) {
  const started: FakeAcpAgentHandle[] = [];
  const stack = await createTestStack({
    ...(options.extra !== undefined ? { agentCatalog: options.extra } : {}),
    agentLaunch: (entry) =>
      options.launch?.(entry.id) ?? { command: 'in-process', args: [], env: {} },
    agentSpawn: fakeAgentSpawner(scripts, started),
  });
  stacks.push(stack);
  return { stack, started };
}

async function call<T>(stack: TestStack, method: string, input?: unknown): Promise<T> {
  return (await stack.core.rpc.call(method, input)) as T;
}

async function agentView(stack: TestStack, id: string): Promise<AgentView> {
  const list = await call<{ agents: AgentView[] }>(stack, 'agents.list');
  return list.agents.find((agent) => agent.id === id)!;
}

function waitForAgent(
  stack: TestStack,
  id: string,
  predicate: (agent: AgentView) => boolean,
  label: string,
): Promise<AgentView> {
  return waitFor(
    async () => {
      const agent = await agentView(stack, id);
      return predicate(agent) ? agent : null;
    },
    { label },
  );
}

async function useAgent(stack: TestStack, bot: Bot, agentId: string): Promise<Bot> {
  const profile = {
    ...bot.profile,
    runtime: { ...bot.profile.runtime, agent: { ...bot.profile.runtime.agent, id: agentId } },
  };
  return (await call<{ bot: Bot }>(stack, 'bots.update', { id: bot.id, profile })).bot;
}

describe('agents service (P4, fake agents)', () => {
  it('experimental gate, enable → ready, options, test, disable / uninstall with affected bots', async () => {
    const { stack } = await startStack({
      fake: { configOptions: MODEL_OPTIONS, turns: [agentTurn().text('pong')] },
    });
    expect(await call(stack, 'agents.list')).toEqual({ experimental: false, agents: [] });
    await expect(call(stack, 'agents.enable', { id: 'fake' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    await call(stack, 'settings.update', { experimental: { externalAgents: true } });
    const before = await agentView(stack, 'fake');
    expect(before).toMatchObject({
      status: 'available',
      enabled: false,
      tier: 'preview',
      usedBy: [],
    });
    expect(before.install).toMatchObject({ item: 'agent:fake', license: 'MIT' });
    // Environment-manager approval payload of the `agent:{id}` item.
    expect(stack.core.services.agentsService!.approvalPayload('fake', '启用')).toMatchObject({
      item: 'agent:fake',
      displayName: 'Fake Agent',
      license: 'MIT',
      obtain: 'system',
      reason: '启用',
    });

    const enabled = await call<{ agent: AgentView }>(stack, 'agents.enable', { id: 'fake' });
    expect(enabled.agent).toMatchObject({ enabled: true, status: 'ready' });

    // H1: per-agent settings merge server-side; nothing clobbers the install state.
    await call(stack, 'settings.update', { agents: { fake: { loadUserConfig: true } } });
    const configured = await call<{ agent: AgentView }>(stack, 'agents.configure', {
      id: 'fake',
      concurrency: 3,
    });
    expect(configured.agent).toMatchObject({ enabled: true, loadUserConfig: true, concurrency: 3 });
    const stored = await call<{
      agents: Record<string, { enabled: boolean; installedVersion?: string }>;
    }>(stack, 'settings.get');
    expect(stored.agents.fake).toMatchObject({ enabled: true, installedVersion: '0.0.0' });
    await expect(
      call(stack, 'settings.update', {
        agents: { fake: { enabled: true, installedVersion: '../../../../tmp/p' } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const { options } = await call<{ options: { models: Array<{ value: string }> } }>(
      stack,
      'agents.options',
      { id: 'fake', refresh: true },
    );
    expect(options.models.map((model) => model.value)).toEqual(['fast', 'smart']);

    const tested = await call<{ result: { ok: boolean; reply: string; error: string | null } }>(
      stack,
      'agents.test',
      { id: 'fake' },
    );
    expect(tested.result).toMatchObject({ ok: true, reply: 'pong', error: null });

    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    expect((await agentView(stack, 'fake')).usedBy).toEqual([{ id: bot.id, name: '外援' }]);

    const unconfirmed = await call<{ applied: boolean; affectedBots: unknown[] }>(
      stack,
      'agents.disable',
      { id: 'fake' },
    );
    expect(unconfirmed).toMatchObject({
      applied: false,
      affectedBots: [{ id: bot.id, name: '外援' }],
    });
    expect((await agentView(stack, 'fake')).enabled).toBe(true);

    const confirmed = await call<{ applied: boolean; agent: AgentView }>(stack, 'agents.disable', {
      id: 'fake',
      confirm: true,
    });
    expect(confirmed.applied).toBe(true);
    expect(confirmed.agent.status).toBe('available');

    const removed = await call<{ applied: boolean }>(stack, 'agents.uninstall', {
      id: 'fake',
      confirm: true,
    });
    expect(removed.applied).toBe(true);
    const settings = await call<{ agents: Record<string, unknown> }>(stack, 'settings.get');
    expect(settings.agents.fake).toBeUndefined();
  }, 30_000);

  it('agent-type login: needs_auth → authenticate → ready', async () => {
    const authMethods = [{ id: 'chat', name: 'ChatGPT', description: '订阅登录' }];
    const { stack, started } = await startStack(
      {
        'fake-auth': [
          // probe after enable: logged out
          { authMethods, requireAuth: true, turns: [] },
          // login control process
          { authMethods, turns: [] },
          // probe after login
          { authMethods, turns: [] },
        ],
      },
      { extra: [fakeAgentEntry('fake-auth', { auth: { kinds: ['subscription'], note: '订阅' } })] },
    );
    await call(stack, 'settings.update', { experimental: { externalAgents: true } });
    await call(stack, 'agents.enable', { id: 'fake-auth' });
    const loggedOut = await waitForAgent(
      stack,
      'fake-auth',
      (agent) => agent.status === 'needs_auth' && agent.authMethods.length === 1,
      'needs_auth after probe',
    );
    expect(loggedOut.authMethods).toEqual([
      { id: 'chat', name: 'ChatGPT', description: '订阅登录', type: 'agent' },
    ]);
    // The probe declared terminal auth support to the agent.
    expect(started[0]!.observed.initialize?.clientCapabilities?.auth).toEqual({ terminal: true });

    await call(stack, 'agents.login', { id: 'fake-auth', methodId: 'chat' });
    const ready = await waitForAgent(
      stack,
      'fake-auth',
      (agent) => agent.status === 'ready' && agent.login?.running === false,
      'ready after authenticate',
    );
    expect(ready.login).toMatchObject({ methodId: 'chat', exitCode: 0, error: null });
    expect(started[1]!.observed.events).toContainEqual({ kind: 'authenticate', methodId: 'chat' });

    await call(stack, 'agents.logout', { id: 'fake-auth' });
    expect((await agentView(stack, 'fake-auth')).status).toBe('needs_auth');
  }, 30_000);

  it('terminal login runs the rewritten command as a child process and returns its output', async () => {
    const authMethods = [
      { id: 'term', name: '终端登录', type: 'terminal' as const, args: ['auth', 'login'] },
    ];
    const { stack } = await startStack(
      {
        'fake-term': [
          { authMethods, requireAuth: true, turns: [] },
          { authMethods, turns: [] },
        ],
      },
      {
        extra: [fakeAgentEntry('fake-term', { auth: { kinds: ['subscription'], note: '' } })],
        // The "installed executable": this runtime printing its argv.
        launch: (id) =>
          id === 'fake-term'
            ? {
                command: process.execPath,
                args: ['-e', 'console.log("login:" + process.argv.slice(1).join(" "))'],
                env: { ELECTRON_RUN_AS_NODE: '1' },
              }
            : null,
      },
    );
    await call(stack, 'settings.update', { experimental: { externalAgents: true } });
    await call(stack, 'agents.enable', { id: 'fake-term' });
    await waitForAgent(stack, 'fake-term', (agent) => agent.authMethods.length === 1, 'methods');
    await call(stack, 'agents.login', { id: 'fake-term', methodId: 'term' });
    const done = await waitForAgent(
      stack,
      'fake-term',
      (agent) => agent.login?.running === false && agent.status === 'ready',
      'terminal login finished',
    );
    expect(done.login?.exitCode).toBe(0);
    expect(done.login?.output).toContain('login:auth login');
  }, 30_000);

  it('API key login stores the key in secrets and injects it at launch only', async () => {
    const entry = fakeAgentEntry('fake-key', {
      auth: { kinds: ['api-key'], note: 'API key', apiKeyEnv: 'FAKE_AGENT_API_KEY' },
    });
    const { stack } = await startStack({ 'fake-key': { turns: [] } }, { extra: [entry] });
    await call(stack, 'settings.update', { experimental: { externalAgents: true } });
    await call(stack, 'agents.enable', { id: 'fake-key' });
    expect((await agentView(stack, 'fake-key')).status).toBe('needs_auth');

    const after = await call<{ agent: AgentView }>(stack, 'agents.login', {
      id: 'fake-key',
      apiKey: 'sk-test-agent-key',
    });
    expect(after.agent).toMatchObject({ status: 'ready', hasApiKey: true });
    expect(stack.core.services.agentsService!.resolveLaunch(entry).env).toMatchObject({
      FAKE_AGENT_API_KEY: 'sk-test-agent-key',
    });
    // Never echoed back to the renderer.
    expect(JSON.stringify(await call(stack, 'agents.list'))).not.toContain('sk-test-agent-key');
    expect(JSON.stringify(await call(stack, 'settings.get'))).not.toContain('sk-test-agent-key');

    await call(stack, 'agents.logout', { id: 'fake-key' });
    expect(await agentView(stack, 'fake-key')).toMatchObject({
      hasApiKey: false,
      status: 'needs_auth',
    });
  }, 30_000);
});

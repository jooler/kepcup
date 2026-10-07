import { afterEach, describe, expect, it } from 'vitest';
import type { AgentView } from '@kepcup/shared';
import {
  createTestStack,
  fakeAgentEntry,
  fakeAgentSpawner,
  waitFor,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';

/**
 * P5 第一部分（todo §8.1）经 AgentsService 的端到端：Antigravity 被过滤的登录
 * 方式在 UI（`agents.list`）与 `authenticate` 两端都无法触发；OpenCode 未登录
 * 也是 `ready`（匿名免费模型），设置卡给出「登录后可用订阅模型」的依据；
 * Antigravity 的控制进程同样带私有 GEMINI_HOME。
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function startStack(
  scripts: Record<string, FakeAgentScript | FakeAgentScript[]>,
  extra: ReturnType<typeof fakeAgentEntry>[],
) {
  const started: FakeAcpAgentHandle[] = [];
  const launches: Array<{ id: string; env: Record<string, string> }> = [];
  const spawner = fakeAgentSpawner(scripts, started);
  const stack = await createTestStack({
    agentCatalog: extra,
    agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
    agentSpawn: ((input: { entry: { id: string }; launch: { env: Record<string, string> } }) => {
      launches.push({ id: input.entry.id, env: input.launch.env });
      return spawner(input);
    }) as never,
  });
  stacks.push(stack);
  await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
  return { stack, started, launches };
}

async function view(stack: TestStack, id: string): Promise<AgentView> {
  const list = (await stack.core.rpc.call('agents.list')) as { agents: AgentView[] };
  return list.agents.find((agent) => agent.id === id)!;
}

function waitForView(
  stack: TestStack,
  id: string,
  predicate: (agent: AgentView) => boolean,
  label: string,
): Promise<AgentView> {
  return waitFor(
    async () => {
      const agent = await view(stack, id);
      return predicate(agent) ? agent : null;
    },
    { label },
  );
}

describe('Antigravity login methods (P5)', () => {
  const authMethods = [
    { id: 'oauth-personal', name: '使用 Google 账号登录' },
    { id: 'oauth-business', name: 'Gemini Enterprise' },
    { id: 'gemini-api-key', name: 'Gemini API key' },
    { id: 'agent-platform', name: 'Agent Platform (Vertex AI)' },
  ];
  const entry = fakeAgentEntry('fake-agy', {
    provider: 'antigravity',
    auth: { kinds: ['api-key'], note: 'Gemini API key', apiKeyEnv: 'GEMINI_API_KEY' },
  });

  it('filtered methods never reach the UI nor authenticate', async () => {
    const { stack, started, launches } = await startStack(
      {
        'fake-agy': [
          // probe after enable / after the key: not authenticated yet
          { authMethods, requireAuth: true, turns: [] },
          { authMethods, requireAuth: true, turns: [] },
          // control process of the allowed login
          { authMethods, turns: [] },
          { authMethods, turns: [] },
        ],
      },
      [entry],
    );
    await stack.core.rpc.call('agents.enable', { id: 'fake-agy' });
    await stack.core.rpc.call('agents.login', { id: 'fake-agy', apiKey: 'AIza-test-key' });
    // Discover the methods (probe through the provider filter).
    await stack.core.rpc.call('agents.login', { id: 'fake-agy' });
    const listed = await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.authMethods.length > 0,
      'auth methods probed',
    );
    expect(listed.authMethods.map((method) => method.id)).toEqual(['gemini-api-key']);
    expect(JSON.stringify(await stack.core.rpc.call('agents.list'))).not.toContain('oauth-');

    for (const methodId of ['oauth-personal', 'oauth-business', 'gateway', 'agent-platform']) {
      await expect(
        stack.core.rpc.call('agents.login', { id: 'fake-agy', methodId }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }

    await stack.core.rpc.call('agents.login', { id: 'fake-agy', methodId: 'gemini-api-key' });
    await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.login?.running === false,
      'authenticate finished',
    );
    const authenticated = started.flatMap((handle) =>
      handle.observed.events.flatMap((event) =>
        event.kind === 'authenticate' ? [event.methodId] : [],
      ),
    );
    expect(authenticated).toEqual(['gemini-api-key']);
    // Every process (probe / control) ran with the private GEMINI_HOME and the key.
    expect(launches.length).toBeGreaterThan(0);
    for (const launch of launches) {
      expect(launch.env.GEMINI_HOME).toMatch(/[\\/]agents[\\/]fake-agy[\\/]gemini-home$/);
      expect(launch.env.GEMINI_HOME!.startsWith(stack.core.services.paths.home)).toBe(true);
    }
    expect(launches.at(-1)!.env.GEMINI_API_KEY).toBe('AIza-test-key');
  }, 30_000);
});

describe('OpenCode anonymous availability (P5)', () => {
  it('is ready without logging in; the login method is still offered', async () => {
    const entry = fakeAgentEntry('fake-opencode', {
      provider: 'opencode',
      auth: { kinds: ['subscription', 'api-key', 'anonymous'], note: '' },
    });
    const authMethods = [
      {
        id: 'opencode-login',
        name: 'Login with opencode',
        _meta: { 'terminal-auth': { command: 'opencode', args: ['auth', 'login'] } },
      },
    ];
    const { stack } = await startStack({ 'fake-opencode': { authMethods, turns: [] } }, [entry]);
    await stack.core.rpc.call('agents.enable', { id: 'fake-opencode' });
    const ready = await waitForView(
      stack,
      'fake-opencode',
      (agent) => agent.status === 'ready' && agent.authMethods.length === 1,
      'ready while logged out',
    );
    expect(ready.authKinds).toContain('anonymous');
    expect(ready.authMethods[0]).toMatchObject({ id: 'opencode-login', type: 'terminal' });
    // A run reporting "not logged in" does not take the anonymous agent offline.
    stack.core.services.agentsService!.noteRunError('fake-opencode', 'AGENT_AUTH_REQUIRED');
    expect((await view(stack, 'fake-opencode')).status).toBe('ready');
  }, 30_000);
});

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

describe('Antigravity login methods (P5, 2026-11 capability policy)', () => {
  const authMethods = [
    { id: 'oauth-personal', name: '使用 Google 账号登录' },
    { id: 'oauth-business', name: 'Gemini Enterprise' },
    { id: 'gemini-api-key', name: 'Gemini API key' },
    { id: 'agent-platform', name: 'Agent Platform (Vertex AI)' },
  ];
  const entry = fakeAgentEntry('fake-agy', {
    provider: 'antigravity',
    auth: {
      kinds: ['subscription', 'api-key'],
      note: 'Gemini API key',
      apiKeyEnv: 'GEMINI_API_KEY',
    },
  });

  it('gateway / agent-platform never reach the UI nor authenticate; oauth now can', async () => {
    const { stack, started, launches } = await startStack(
      {
        'fake-agy': [
          // probe after enable: not authenticated yet
          { authMethods, requireAuth: true, turns: [] },
          // 存 key 后的自动官方登记（control，唯一的 key 型方式）+ 登记后的复核探测
          { authMethods, turns: [] },
          { authMethods, turns: [] },
          // 手动 oauth-personal（control）+ 其后的复核探测
          { authMethods, turns: [] },
          { authMethods, turns: [] },
          // 手动 gemini-api-key（control）+ 其后的复核探测
          { authMethods, turns: [] },
          { authMethods, turns: [] },
        ],
      },
      [entry],
    );
    await stack.core.rpc.call('agents.enable', { id: 'fake-agy' });
    // 存 key 即完整登录：core 自动对唯一的 key 型方式（gemini-api-key）
    // authenticate 登记 auth.type，随后的探测带着 key → ready。
    await stack.core.rpc.call('agents.login', { id: 'fake-agy', apiKey: 'AIza-test-key' });
    const ready = await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.status === 'ready' && agent.authMethods.length > 0,
      'ready after saving the key',
    );
    // 白名单顺序跟随广告序：oauth 两种现在可达，gateway / agent-platform 仍过滤。
    expect(ready.authMethods.map((method) => method.id)).toEqual([
      'oauth-personal',
      'oauth-business',
      'gemini-api-key',
    ]);
    const listed = JSON.stringify(await stack.core.rpc.call('agents.list'));
    expect(listed).not.toContain('gateway');
    expect(listed).not.toContain('agent-platform');

    for (const methodId of ['gateway', 'agent-platform']) {
      await expect(
        stack.core.rpc.call('agents.login', { id: 'fake-agy', methodId }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }

    // oauth-personal 可经 authenticate 触发（UI 二次确认后由 core 执行）。
    await stack.core.rpc.call('agents.login', { id: 'fake-agy', methodId: 'oauth-personal' });
    await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.login?.running === false && agent.login.exitCode === 0,
      'oauth-personal authenticate finished',
    );
    // 手动 key 方式仍可用（多方式智能体 / API 调用方）。
    await stack.core.rpc.call('agents.login', { id: 'fake-agy', methodId: 'gemini-api-key' });
    await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.login?.running === false && agent.status === 'ready',
      'authenticate finished',
    );
    const authenticated = started.flatMap((handle) =>
      handle.observed.events.flatMap((event) =>
        event.kind === 'authenticate' ? [event.methodId] : [],
      ),
    );
    expect(authenticated).toEqual(['gemini-api-key', 'oauth-personal', 'gemini-api-key']);
    // Every process (probe / control) ran with the private GEMINI_HOME and the key.
    expect(launches.length).toBeGreaterThan(0);
    for (const launch of launches) {
      expect(launch.env.GEMINI_HOME).toMatch(/[\\/]agents[\\/]fake-agy[\\/]gemini-home$/);
      expect(launch.env.GEMINI_HOME!.startsWith(stack.core.services.paths.home)).toBe(true);
    }
    expect(launches.at(-1)!.env.GEMINI_API_KEY).toBe('AIza-test-key');
  }, 30_000);

  it('refuses key-method authenticate without a stored key so UI cannot fake loginDone', async () => {
    const { stack } = await startStack(
      {
        'fake-agy': [
          // probe after enable: discovers authMethods, not authenticated yet
          { authMethods, requireAuth: true, turns: [] },
        ],
      },
      [entry],
    );
    await stack.core.rpc.call('agents.enable', { id: 'fake-agy' });
    await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.status === 'needs_auth' && agent.authMethods.length > 0,
      'discovered auth methods while logged out',
    );
    // gemini-api-key 方式的 authenticate 只登记选型、不校验凭据：没有已存 key 时
    // 必须直接拒绝（UI 也会隐藏该按钮），否则走通后会返回 exitCode 0 误报登录成功。
    await expect(
      stack.core.rpc.call('agents.login', { id: 'fake-agy', methodId: 'gemini-api-key' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const current = await view(stack, 'fake-agy');
    expect(current.login).toBeNull();
    expect(current.status).toBe('needs_auth');
  }, 30_000);

  it('reuseLocalAuth stops isolating GEMINI_HOME so the local sign-in is used', async () => {
    const { stack, launches } = await startStack(
      {
        'fake-agy': [
          // enable probe（私有模式，未登录）
          { authMethods, requireAuth: true, turns: [] },
          // 开启复用后的重探测（本机登录生效 → ready）
          { authMethods, turns: [] },
          // 关闭复用切回私有目录后的重探测（恢复 needs_auth）
          { authMethods, requireAuth: true, turns: [] },
        ],
      },
      [entry],
    );
    await stack.core.rpc.call('agents.enable', { id: 'fake-agy' });
    const before = await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.isolatesLocalAuth === true && !agent.probing,
      'isolates flag',
    );
    expect(before.reuseLocalAuth).toBe(false);
    expect(before.status).toBe('needs_auth');

    await stack.core.rpc.call('agents.configure', { id: 'fake-agy', reuseLocalAuth: true });
    const reused = await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.status === 'ready' && !agent.probing,
      'ready with the local sign-in',
    );
    expect(reused.isolatesLocalAuth).toBe(true);
    expect(reused.reuseLocalAuth).toBe(true);
    // 开关只影响新进程的 env：开启后的探测进程不再带 GEMINI_HOME。
    const afterEnable = launches.filter((launch) => launch.env.GEMINI_HOME !== undefined);
    expect(afterEnable.length).toBeGreaterThan(0);
    expect(launches.at(-1)!.env.GEMINI_HOME).toBeUndefined();

    // 切回私有模式后清掉原登录态并按私有目录重探 → needs_auth 且重新带回 GEMINI_HOME。
    await stack.core.rpc.call('agents.configure', { id: 'fake-agy', reuseLocalAuth: false });
    const isolated = await waitForView(
      stack,
      'fake-agy',
      (agent) => agent.status === 'needs_auth' && !agent.probing,
      'needs_auth again after disabling reuseLocalAuth',
    );
    expect(isolated.reuseLocalAuth).toBe(false);
    expect(launches.at(-1)!.env.GEMINI_HOME).toMatch(/[\\/]agents[\\/]fake-agy[\\/]gemini-home$/);
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

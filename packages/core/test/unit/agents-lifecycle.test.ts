import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  settingsSchema,
  type AgentCatalogEntry,
  type AgentView,
  type AgentInstallProgress,
  type Settings,
} from '@kepcup/shared';
import {
  fakeAgentEntry,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { AgentHost } from '../../src/agent/external/host.js';
import type { InstalledAgent } from '../../src/agent/external/installer.js';
import { AgentsService, type LoginRunner } from '../../src/domain/agents.js';

/**
 * AgentsService / AgentHost 的生命周期与并发（D72 P4 审查修复 M5–M8、H1）：
 * 并发启用只装一次、安装中停用不被回写、dispose 中止安装与控制进程、进程
 * 忙时卸载被拒 / 登出让旧进程退役、登录取消后强制结束、登录输出跨块脱敏、
 * 逐 Agent 配置不覆盖服务端状态。依赖用最小假对象。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(probe: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const SECRET = 'sk-secret-login-token-123';

interface Harness {
  service: AgentsService;
  settings: { current: Settings };
  installs: Array<{ signal: AbortSignal | undefined; done: ReturnType<typeof deferred> }>;
  started: FakeAcpAgentHandle[];
  hostCalls: { stop: string[] };
  host: { inUse: boolean; authStatus: { kind: string; at: number } | null };
  installedVersion: { value: string | null };
  published: AgentView[];
}

function harness(
  entry: AgentCatalogEntry,
  options: {
    runLogin?: LoginRunner;
    forceSettleMs?: number;
    loginMs?: number;
    script?: FakeAgentScript;
  } = {},
): Harness {
  const workDir = mkdtempSync(path.join(tmpdir(), 'kepcup-agents-life-'));
  dirs.push(workDir);
  const settings = {
    current: settingsSchema.parse({ experimental: { externalAgents: true } }),
  };
  const secrets = new Map<string, string>();
  const installs: Harness['installs'] = [];
  const installedVersion: Harness['installedVersion'] = { value: null };
  const started: FakeAcpAgentHandle[] = [];
  const hostCalls = { stop: [] as string[] };
  const hostState: Harness['host'] = { inUse: false, authStatus: null };
  const published: AgentView[] = [];
  const installed = (): InstalledAgent | null =>
    installedVersion.value === null
      ? null
      : {
          id: entry.id,
          version: installedVersion.value,
          kind: 'npx',
          dir: workDir,
          entry: path.join(workDir, 'index.js'),
          args: [],
          env: {},
        };
  const installer = {
    managedKind: () => 'npx',
    kindFor: () => 'npx',
    sourceText: () => 'npm: slow@1.0.0',
    installed: (_id: string, version: string) =>
      installedVersion.value === version ? installed() : null,
    installedVersions: () => (installedVersion.value === null ? [] : [installedVersion.value]),
    invocation: (agent: InstalledAgent) => ({
      command: 'node',
      prefixArgs: [agent.entry],
      args: [],
      env: {},
    }),
    systemInvocation: () => null,
    detectSystem: async () => null,
    uninstall: () => {
      installedVersion.value = null;
    },
    install: async (
      _entry: AgentCatalogEntry,
      opts: { signal?: AbortSignal; onProgress?(progress: AgentInstallProgress): void },
    ) => {
      const done = deferred();
      installs.push({ signal: opts.signal, done });
      opts.signal?.addEventListener('abort', () => done.reject(new Error('aborted')));
      opts.onProgress?.({ stage: 'installing' });
      await done.promise;
      installedVersion.value = entry.version;
      return installed()!;
    },
  };
  const host = {
    stop: (id: string) => {
      hostCalls.stop.push(id);
      return !hostState.inUse;
    },
    inUse: () => hostState.inUse,
    authStatus: () => hostState.authStatus,
  };
  const service = new AgentsService({
    settings: {
      get: () => settings.current,
      update: (patch: Partial<Settings>) => {
        settings.current = settingsSchema.parse({ ...settings.current, ...patch });
        return settings.current;
      },
    } as never,
    secrets: {
      hasValue: (name: string) => secrets.has(name),
      getValue: (name: string) => secrets.get(name) ?? null,
      setValue: (name: string, value: string) => secrets.set(name, value),
      removeValue: (name: string) => secrets.delete(name),
      redact: (text: string) => text.replaceAll(SECRET, '[REDACTED]'),
    } as never,
    bots: { listActive: () => [] } as never,
    host: host as never,
    installer: installer as never,
    catalog: () => [entry],
    logger,
    publish: (_event: string, payload: { agent: AgentView }) => {
      published.push(payload.agent);
    },
    appVersion: '1.0.0',
    workDir,
    spawn: fakeAgentSpawner({ [entry.id]: options.script ?? { turns: [] } }, started) as never,
    ...(options.runLogin !== undefined ? { runLogin: options.runLogin } : {}),
    timeouts: {
      probeMs: 2_000,
      ...(options.loginMs !== undefined ? { loginMs: options.loginMs } : {}),
      ...(options.forceSettleMs !== undefined ? { forceSettleMs: options.forceSettleMs } : {}),
    },
  });
  cleanups.push(() => service.dispose());
  return {
    service,
    settings,
    installs,
    started,
    hostCalls,
    host: hostState,
    installedVersion,
    published,
  };
}

const npxEntry = (overrides: Partial<AgentCatalogEntry> = {}) =>
  fakeAgentEntry('slow', {
    version: '1.0.0',
    distribution: { npx: { package: 'slow@1.0.0' } },
    ...overrides,
  });

describe('AgentsService lifecycle', () => {
  it('concurrent enables share one install; a disable during install is not undone', async () => {
    const h = harness(npxEntry());
    const [a, b] = await Promise.all([h.service.enable('slow'), h.service.enable('slow')]);
    expect(a.status).toBe('installing');
    expect(b.status).toBe('installing');
    expect(h.installs).toHaveLength(1);

    await h.service.disable('slow');
    expect(h.installs[0]!.signal?.aborted).toBe(true);
    h.installs[0]!.done.resolve();
    await until(() => !h.service.isInstalling('slow'), 'install settled');
    expect(h.settings.current.agents.slow?.enabled ?? false).toBe(false);
    expect(h.service.view('slow').status).not.toBe('installing');
  });

  it('a finished install enables the agent (and only then)', async () => {
    const h = harness(npxEntry());
    await h.service.enable('slow');
    h.installs[0]!.done.resolve();
    await until(() => h.settings.current.agents.slow?.enabled === true, 'enabled after install');
    expect(h.settings.current.agents.slow?.installedVersion).toBe('1.0.0');
  });

  it('dispose aborts the install and starts no further process', async () => {
    const h = harness(npxEntry());
    await h.service.enable('slow');
    h.service.dispose();
    expect(h.installs[0]!.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.settings.current.agents.slow).toBeUndefined();
    expect(h.started).toHaveLength(0);
  });

  it('dispose kills an in-flight control (probe) process', async () => {
    const h = harness(npxEntry());
    h.installedVersion.value = '1.0.0';
    await h.service.enable('slow'); // installed → enabled → background probe
    await until(() => h.started.length > 0, 'probe process started');
    h.service.dispose();
    await expect(
      Promise.race([
        h.started[0]!.exited.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('alive'), 1_000)),
      ]),
    ).resolves.toBe('exited');
  });

  it('refuses to uninstall while a run uses the agent; logout retires the busy process', async () => {
    const h = harness(npxEntry({ auth: { kinds: ['api-key'], note: '', apiKeyEnv: 'SLOW_KEY' } }));
    h.installedVersion.value = '1.0.0';
    await h.service.enable('slow');
    h.host.inUse = true;
    await expect(h.service.uninstall('slow', true)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(h.installedVersion.value).toBe('1.0.0');

    await h.service.login({ id: 'slow', apiKey: '  sk-new  ' });
    await h.service.logout('slow');
    // stop() is how the host retires the old process (old key in its env).
    expect(h.hostCalls.stop.filter((id) => id === 'slow').length).toBeGreaterThanOrEqual(2);
    await expect(h.service.login({ id: 'slow', apiKey: '   ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('configure merges per agent and never clobbers install state', async () => {
    const h = harness(npxEntry());
    await h.service.enable('slow');
    h.installs[0]!.done.resolve();
    await until(() => h.settings.current.agents.slow?.enabled === true, 'installed');
    h.service.configure({ id: 'slow', loadUserConfig: true, concurrency: 3 });
    expect(h.settings.current.agents.slow).toMatchObject({
      enabled: true,
      installedVersion: '1.0.0',
      loadUserConfig: true,
    });
    expect((h.settings.current.providerConcurrency as Record<string, number>)['agent:slow']).toBe(
      3,
    );
  });
});

describe('terminal login sessions', () => {
  const terminalEntry = () => npxEntry({ auth: { kinds: ['subscription'], note: '' } });

  /** The fake agent advertises one ACP terminal method (`term`, args `login`). */
  const script: FakeAgentScript = {
    authMethods: [{ id: 'term', name: 'Terminal', type: 'terminal', args: ['login'] }],
    turns: [],
  };

  async function startTerminalLogin(h: Harness): Promise<void> {
    h.installedVersion.value = '1.0.0';
    await h.service.enable('slow');
    await h.service.login({ id: 'slow' }); // probe: discovers the method
    expect(h.service.view('slow').authMethods.map((method) => method.id)).toEqual(['term']);
  }

  it('a timed-out login whose process ignores the kill is force-settled', async () => {
    let killed = 0;
    const runLogin: LoginRunner = () => ({
      exited: new Promise(() => undefined), // never exits
      write: () => undefined,
      kill: () => {
        killed += 1;
      },
    });
    const entry = terminalEntry();
    const h = harness(entry, { runLogin, loginMs: 50, forceSettleMs: 100, script });
    await startTerminalLogin(h);
    await h.service.login({ id: 'slow', methodId: 'term' });
    expect(h.service.view('slow').login?.running).toBe(true);
    await until(() => h.service.view('slow').login?.running === false, 'login force-settled');
    expect(killed).toBeGreaterThan(0);
    expect(h.service.view('slow').login?.error).toContain('超时');
    // A new login is possible again; logout cancels it.
    await h.service.login({ id: 'slow', methodId: 'term' });
    expect(h.service.view('slow').login?.running).toBe(true);
    await h.service.logout('slow');
    expect(h.service.view('slow').login).toBeNull();
  });

  it('dispose kills a running login process', async () => {
    let killed = 0;
    const runLogin: LoginRunner = () => ({
      exited: new Promise(() => undefined),
      write: () => undefined,
      kill: () => {
        killed += 1;
      },
    });
    const h = harness(terminalEntry(), { runLogin, script });
    await startTerminalLogin(h);
    await h.service.login({ id: 'slow', methodId: 'term' });
    h.service.dispose();
    expect(killed).toBe(1);
  });

  it('redacts secrets split across output chunks', async () => {
    const exit = deferred<number | null>();
    let emit!: (text: string) => void;
    const runLogin: LoginRunner = ({ onOutput }) => {
      emit = onOutput;
      return { exited: exit.promise, write: () => undefined, kill: () => undefined };
    };
    const entry = terminalEntry();
    const h = harness(entry, { runLogin, script });
    await startTerminalLogin(h);
    await h.service.login({ id: 'slow', methodId: 'term' });
    emit(`open https://vendor.example/auth\ntoken=${SECRET.slice(0, 9)}`);
    emit(`${SECRET.slice(9)}\nwaiting…`);
    exit.resolve(0);
    await until(() => h.service.view('slow').login?.running === false, 'login finished');
    const output = h.service.view('slow').login!.output;
    expect(output).toContain('https://vendor.example/auth');
    expect(output).toContain('token=[REDACTED]');
    expect(output).not.toContain(SECRET.slice(0, 9));
    expect(output).toContain('waiting…');
  });
});

describe('AgentHost retiring', () => {
  it('stop() while busy retires the process: new acquires get a fresh one, the old exits after release', async () => {
    const entry = fakeAgentEntry('busy');
    const started: FakeAcpAgentHandle[] = [];
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner({ busy: { turns: [] } }, started) as never,
    });
    cleanups.push(() => host.dispose());
    const first = await host.acquire(entry);
    expect(host.inUse('busy')).toBe(true);
    expect(host.stop('busy')).toBe(false);
    const second = await host.acquire(entry);
    expect(started).toHaveLength(2);
    expect(second.connection).not.toBe(first.connection);

    let firstExited = false;
    void started[0]!.exited.then(() => {
      firstExited = true;
    });
    first.release();
    await until(() => firstExited, 'retired process exits after its last release');
    expect(host.inUse('busy')).toBe(true);
    second.release();
    expect(host.inUse('busy')).toBe(false);
  });

  it('openSession also finds sessions on a retiring process (deleting a conversation discards them)', async () => {
    const entry = fakeAgentEntry('busy');
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner({ busy: { turns: [] } }, []) as never,
    });
    cleanups.push(() => host.dispose());
    const first = await host.acquire(entry);
    first.attach('attached', {} as never);
    first.keepSession('kept', { marker: 1 });
    expect(host.stop('busy')).toBe(false);
    const second = await host.acquire(entry);
    expect(host.openSession('busy', 'attached')).toMatchObject({
      connection: first.connection,
      busy: true,
    });
    expect(host.openSession('busy', 'kept')).toMatchObject({
      connection: first.connection,
      state: { marker: 1 },
      busy: false,
    });
    host.forgetSession('busy', 'kept');
    expect(host.openSession('busy', 'kept')).toBeNull();
    expect(host.openSession('busy', 'unknown')).toBeNull();
    first.detach('attached');
    first.release();
    second.release();
  });
});

describe('P4-B review: run-noted logout and post-change probing', () => {
  const subscription = () => npxEntry({ auth: { kinds: ['subscription'], note: '订阅登录' } });

  it('a later non-none _auth/status_update supersedes a logout noted from a run failure (#7)', async () => {
    const h = harness(subscription());
    h.installedVersion.value = '1.0.0';
    h.settings.current = settingsSchema.parse({
      ...h.settings.current,
      agents: { slow: { enabled: true } },
    });
    h.service.noteRunError('slow', 'AGENT_AUTH_REQUIRED');
    expect(h.service.view('slow').status).toBe('needs_auth');
    // An older push does not override the noted failure …
    h.host.authStatus = { kind: 'authenticated', at: Date.now() - 60_000 };
    expect(h.service.view('slow').status).toBe('needs_auth');
    // … a newer one that is not `none` does.
    await new Promise((resolve) => setTimeout(resolve, 2));
    h.host.authStatus = { kind: 'authenticated', at: Date.now() + 1 };
    expect(h.service.view('slow').status).toBe('ready');
    // Other failure codes never mark a logout.
    h.service.noteRunError('slow', 'AGENT_FAILED');
    expect(h.service.view('slow').status).toBe('ready');
  });

  it('after an install the first published view is still probing (#2)', async () => {
    const h = harness(subscription(), { script: { turns: [] } });
    await h.service.enable('slow');
    h.installs[0]!.done.resolve();
    await until(() => h.settings.current.agents.slow?.enabled === true, 'enabled after install');
    const firstReady = h.published.find((view) => view.enabled && view.status !== 'installing');
    expect(firstReady?.probing).toBe(true);
    await until(() => !h.service.view('slow').probing, 'probe finished');
    expect(h.published.at(-1)?.probing).toBe(false);
  });
});

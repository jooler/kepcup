import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pluginManifestSchema,
  type McpServer,
  type PluginIdentity,
  type PluginItemKind,
  type Settings,
} from '@kepcup/shared';
import { buildPluginDir } from '@kepcup/testkit';

import { McpbInstaller, type McpbInstallerDeps } from '../../src/apps/mcpb/install.js';
import { McpProjector, mcpDescriptionFor, mcpTierFor } from '../../src/plugins/projectors/mcp.js';
import {
  emptyOwned,
  type PluginLedger,
  type PluginProjectionContext,
  type ProjectedKind,
} from '../../src/plugins/projectors/index.js';

/**
 * MCP 投影器（D104 P0a-2 步骤 5）：tier / description 推导纯函数、inspect 的
 * 运行时缺失 / 不兼容 / 槽位冲突 / 不安全 http 端点、project 后 server 形状
 * （id / source / tier / description 按分级）、unproject 的四步镜像清理、
 * 中途失败的账本断言、setEnabled 往返。
 */

const dirs: string[] = [];
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// --- installer harness (same shape as mcpb-register.test.ts) -------------------

async function installerHarness(overrides: Partial<McpbInstallerDeps> = {}): Promise<{
  installer: McpbInstaller;
  home: string;
  servers: McpServer[];
  secrets: Map<string, string>;
}> {
  const home = await tmp('mcp-projector-install-');
  const servers: McpServer[] = [];
  const secrets = new Map<string, string>();
  const settings = {
    get: () => ({ mcpServers: servers }) as unknown as Settings,
    update: (patch: Partial<Settings>) => {
      if (patch.mcpServers !== undefined) {
        servers.splice(0, servers.length, ...patch.mcpServers);
      }
      return { mcpServers: servers } as unknown as Settings;
    },
  };
  const installer = new McpbInstaller({
    paths: { toolchainsDir: path.join(home, 'toolchains') },
    settings,
    secrets: {
      setValue: (name, value) => void secrets.set(name, value),
      removeByPrefix: (prefix) => {
        const removed = [...secrets.keys()].filter((name) => name.startsWith(prefix));
        for (const name of removed) secrets.delete(name);
        return removed;
      },
      // start.ts wires SecretsService.hasValue; replace mode (plugin update) needs it.
      hasValue: (name) => secrets.has(name),
    },
    logger: noopLogger,
    homeDir: '/home/tester',
    platform: 'linux',
    arch: 'x64',
    resolveRuntime: (kind) =>
      kind === 'node' ? { command: '/managed/node/bin/node', version: '24.21.0' } : null,
    ...overrides,
  });
  return { installer, home, servers, secrets };
}

// --- projector harness ----------------------------------------------------------

class MemLedger implements PluginLedger {
  readonly #items = new Map<PluginItemKind, string[]>();
  add(kind: PluginItemKind, ref: string): void {
    const list = this.#items.get(kind) ?? [];
    if (!list.includes(ref)) list.push(ref);
    this.#items.set(kind, list);
  }
  remove(kind: PluginItemKind, ref: string): void {
    this.#items.set(
      kind,
      (this.#items.get(kind) ?? []).filter((entry) => entry !== ref),
    );
  }
  list(kind: PluginItemKind): string[] {
    return [...(this.#items.get(kind) ?? [])];
  }
}

interface Rig {
  servers: McpServer[];
  secrets: Map<string, string>;
  installer: McpbInstaller;
  unpackedDir: string;
  closed: string[];
  removed: string[];
  revocations: Array<{ previous: McpServer[]; next: McpServer[] }>;
  projector: McpProjector;
  ledger: MemLedger;
}

async function makeRig(
  options: { resolveRuntime?: McpbInstallerDeps['resolveRuntime'] } = {},
): Promise<Rig> {
  const { installer, home, servers, secrets } = await installerHarness({
    ...(options.resolveRuntime !== undefined ? { resolveRuntime: options.resolveRuntime } : {}),
  });
  const closed: string[] = [];
  const removed: string[] = [];
  const revocations: Array<{ previous: McpServer[]; next: McpServer[] }> = [];
  const settings = {
    // A copy per read, like the real SettingsService: callers may hold a previous
    // snapshot across a mutation (the uninstall chain relies on that).
    get: () => ({ mcpServers: [...servers] }) as unknown as Settings,
    update: (patch: Partial<Settings>) => {
      if (patch.mcpServers !== undefined) {
        servers.splice(0, servers.length, ...patch.mcpServers);
      }
      return { mcpServers: [...servers] } as unknown as Settings;
    },
  };
  const projector = new McpProjector({
    settings,
    mcpb: installer,
    mcp: {
      closeServer: async (serverId) => {
        closed.push(serverId);
      },
    },
    disconnector: {
      removeCustomServer: async (serverId) => {
        removed.push(serverId);
        // Mirrors the real disconnector: `mcp:{id}:*` secrets go with the server.
        for (const name of [...secrets.keys()]) {
          if (name.startsWith(`mcp:${serverId}:`)) secrets.delete(name);
        }
      },
    },
    revokeMcpServerChanges: (previous, next) => {
      revocations.push({ previous: [...previous], next: [...next] });
    },
    logger: noopLogger,
  });
  return {
    servers,
    secrets,
    installer,
    unpackedDir: path.join(home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0'),
    closed,
    removed,
    revocations,
    projector,
    ledger: new MemLedger(),
  };
}

const mcpbManifest = {
  server: {
    type: 'node',
    entry_point: 'server/index.cjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.cjs'],
      env: { API_KEY: '${user_config.api_key}' },
    },
  },
  user_config: {
    api_key: { type: 'string', title: 'API Key', sensitive: true, required: true },
  },
};

async function contentDir(
  mcpbItems: Array<{ id: string; manifest?: Record<string, unknown> }> = [],
  httpItems: Array<{ id: string; url: string }> = [],
): Promise<{ dir: string; manifestFile: ReturnType<typeof pluginManifestSchema.parse> }> {
  const dir = await tmp('mcp-projector-content-');
  const built = await buildPluginDir({
    dir,
    mcpb: mcpbItems.map((item) => ({
      id: item.id,
      mcpb: { manifest: item.manifest ?? mcpbManifest },
    })),
    http: httpItems,
  });
  return { dir, manifestFile: pluginManifestSchema.parse(built.manifest) };
}

function identity(tier: PluginIdentity['tier'] = 'developer'): PluginIdentity {
  return { id: 'io.github.tester/mcp', version: '1.0.0', origin: 'local', tier };
}

function ctxOf(
  rig: Rig,
  plugin: PluginIdentity,
  dir: string,
  manifest: PluginProjectionContext['manifest'],
  owned: Readonly<Record<ProjectedKind, ReadonlySet<string>>> = emptyOwned(),
): PluginProjectionContext {
  return { plugin, manifest, dir, userConfig: {}, ledger: rig.ledger, owned };
}

describe('mcpTierFor / mcpDescriptionFor', () => {
  it('derives tier and description per plugin tier', () => {
    expect(mcpTierFor('verified')).toBeUndefined();
    expect(mcpTierFor('community')).toBe('developer');
    expect(mcpTierFor('developer')).toBe('developer');
    expect(mcpDescriptionFor('verified', '  行一\n行二  ')).toBe('行一 行二');
    expect(mcpDescriptionFor('verified', undefined)).toBeUndefined();
    expect(mcpDescriptionFor('community', '文案')).toBeUndefined();
    expect(mcpDescriptionFor('developer', '文案')).toBeUndefined();
  });
});

describe('McpProjector.inspect', () => {
  it('mcpb 条目齐全；运行时缺失 / 不兼容进 blockers', async () => {
    const rig = await makeRig({ resolveRuntime: () => null });
    const { dir, manifestFile } = await contentDir([{ id: 'dbtools' }]);
    const ctx = ctxOf(rig, identity(), dir, manifestFile);
    const result = await rig.projector.inspect(ctx);
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item).toMatchObject({
      kind: 'mcpb',
      id: 'dbtools',
      serverType: 'node',
      compatible: true,
      runtime: { kind: 'node', available: false },
    });
    expect(item.launchCommand).toContain('node');
    expect(result.conflicts).toEqual([]);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain('需要 Node.js 运行时');
    expect(result.blockers[0]).toContain('设置 → 环境');
  });

  it('不兼容的包进 blockers', async () => {
    const rig = await makeRig();
    const { dir, manifestFile } = await contentDir([
      { id: 'dbtools', manifest: { ...mcpbManifest, compatibility: { platforms: ['plan9'] } } },
    ]);
    const result = await rig.projector.inspect(ctxOf(rig, identity(), dir, manifestFile));
    expect(result.items[0]).toMatchObject({ compatible: false });
    expect(result.blockers[0]).toMatch(/「Echo Bundle」/);
    expect(result.blockers[0]).toMatch(/plan9/);
  });

  it('同槽不同内容的 MCPB 报冲突', async () => {
    const rig = await makeRig();
    const { dir, manifestFile } = await contentDir([{ id: 'dbtools' }]);
    // A server already occupies the echo-bundle@1.0.0 slot with different content
    // (hand-written into settings, like an earlier plugin install of another build).
    rig.servers.push({
      id: 'plg_earlier000001',
      name: 'Earlier',
      transport: 'stdio',
      command: 'node',
      enabled: true,
      autoApprove: false,
      auth: 'none',
      source: {
        kind: 'plugin',
        pluginId: 'io.github.tester/earlier',
        version: '0.9.0',
        key: 'dbtools',
        mcpb: { name: 'echo-bundle', version: '1.0.0', sha256: 'f'.repeat(64) },
      },
      tier: 'developer',
    } as McpServer);
    const result = await rig.projector.inspect(ctxOf(rig, identity(), dir, manifestFile));
    expect(result.conflicts).toEqual([
      { kind: 'mcpb', ref: 'echo-bundle@1.0.0', withWhat: '已安装同名同版本但内容不同的 MCPB 包' },
    ]);
  });

  it('不安全的 http 端点进 blockers', async () => {
    const rig = await makeRig();
    const { dir, manifestFile } = await contentDir(
      [],
      [
        { id: 'plain', url: 'http://mcp.example.com/mcp' },
        { id: 'loop', url: 'https://127.0.0.1/mcp' },
        { id: 'creds', url: 'https://user:pass@mcp.example.com/mcp' },
      ],
    );
    const result = await rig.projector.inspect(ctxOf(rig, identity(), dir, manifestFile));
    expect(result.blockers).toHaveLength(3);
    expect(result.blockers.every((line) => line.includes('不是可接受的公网 https 地址'))).toBe(
      true,
    );
    expect(result.items.map((item) => (item.kind === 'http' ? item.host : ''))).toEqual([
      'mcp.example.com',
      '127.0.0.1',
      'mcp.example.com',
    ]);
  });
});

describe('McpProjector.project', () => {
  it('mcpb + http 都登记；local 来源带 developer tier；账本先登记', async () => {
    const rig = await makeRig();
    const { dir, manifestFile } = await contentDir(
      [{ id: 'dbtools' }],
      [{ id: 'docs', url: 'https://mcp.example.com/mcp' }],
    );
    const ctx = ctxOf(rig, identity('developer'), dir, manifestFile);
    ctx.userConfig = { dbtools: { api_key: 'sk-project' } };
    await rig.projector.project(ctx);

    expect(rig.servers).toHaveLength(2);
    const mcpbServer = rig.servers.find((server) => server.transport === 'stdio')!;
    expect(mcpbServer).toMatchObject({
      transport: 'stdio',
      tier: 'developer',
      source: {
        kind: 'plugin',
        pluginId: 'io.github.tester/mcp',
        version: '1.0.0',
        key: 'dbtools',
        mcpb: { name: 'echo-bundle', version: '1.0.0' },
      },
    });
    expect(mcpbServer.env).toEqual({ API_KEY: 'secret:env:api_key' });
    expect(rig.secrets.get(`mcp:${mcpbServer.id}:env:api_key`)).toBe('sk-project');

    const httpServer = rig.servers.find((server) => server.transport === 'http')!;
    expect(httpServer).toMatchObject({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'none',
      enabled: true,
      tier: 'developer',
      source: { kind: 'plugin', pluginId: 'io.github.tester/mcp', key: 'docs' },
    });
    expect(rig.ledger.list('mcp')).toEqual(expect.arrayContaining([mcpbServer.id, httpServer.id]));
    expect(existsSync(rig.unpackedDir)).toBe(true);
  });

  it('verified 不带 tier、带清洗后的 description；community 带 developer', async () => {
    const rig = await makeRig();
    const { dir, manifestFile } = await contentDir(
      [],
      [{ id: 'docs', url: 'https://mcp.example.com/mcp' }],
    );
    const verified = pluginManifestSchema.parse({
      ...manifestFile,
      contributions: {
        ...manifestFile.contributions,
        mcp: [
          {
            kind: 'http',
            id: 'docs',
            url: 'https://mcp.example.com/mcp',
            description: '  文档\n服务  ',
          },
        ],
      },
    });
    await rig.projector.project(ctxOf(rig, identity('verified'), dir, verified));
    expect(rig.servers[0]).toMatchObject({
      description: '文档 服务',
      source: { kind: 'plugin' },
    });
    expect('tier' in rig.servers[0]! && rig.servers[0]!.tier !== undefined).toBe(false);

    rig.servers.splice(0);
    rig.ledger.remove('mcp', rig.ledger.list('mcp')[0] ?? '');
    const ctx2 = ctxOf(rig, identity('community'), dir, verified);
    await rig.projector.project(ctx2);
    expect(rig.servers[0]).toMatchObject({ tier: 'developer' });
    expect(rig.servers[0]!.description).toBeUndefined();
  });

  it('project 中途失败时账本已含已写项', async () => {
    const rig = await makeRig();
    const { dir, manifestFile } = await contentDir(
      [{ id: 'dbtools' }],
      [{ id: 'docs', url: 'https://mcp.example.com/mcp' }],
    );
    // http first (succeeds), then an mcpb whose file is missing → inspect throws.
    const broken = pluginManifestSchema.parse({
      ...manifestFile,
      contributions: {
        skills: [],
        connectors: [],
        mcp: [
          { kind: 'http', id: 'docs', url: 'https://mcp.example.com/mcp' },
          { kind: 'mcpb', id: 'dbtools', file: 'mcp/missing.mcpb' },
        ],
      },
    });
    const ctx = ctxOf(rig, identity(), dir, broken);
    await expect(rig.projector.project(ctx)).rejects.toThrow();
    expect(rig.ledger.list('mcp')).toHaveLength(2); // both registered before the failure
    expect(rig.servers).toHaveLength(1); // only the http server was written
  });
});

describe('McpProjector.update / beginUpdate / commitUpdate / rollbackUpdate', () => {
  const ID = 'io.github.tester/mcp';

  function ownedOf(refs: string[]): PluginProjectionContext['owned'] {
    return {
      skill: new Set(),
      connector: new Set(),
      mcp: new Set(refs),
      mail: new Set(),
    };
  }

  function identityV(version: string, tier: PluginIdentity['tier'] = 'developer'): PluginIdentity {
    return { id: ID, version, origin: 'local', tier };
  }

  it('mcpb 更新：server id 不变、enabled / toolPolicies 保留、autoApprove 重置；旧树在 commitUpdate 之前仍在', async () => {
    const rig = await makeRig();
    const v1 = await contentDir([{ id: 'dbtools' }]);
    const oldCtx = ctxOf(rig, identityV('1.0.0'), v1.dir, v1.manifestFile);
    oldCtx.userConfig = { dbtools: { api_key: 'sk-old' } };
    await rig.projector.project(oldCtx);
    const serverId = rig.servers[0]!.id;
    oldCtx.owned = ownedOf([serverId]);
    const beginSnapshot = await rig.projector.beginUpdate(identityV('1.0.0'));
    rig.servers[0]!.enabled = false;
    rig.servers[0]!.autoApprove = true;
    rig.servers[0]!.toolPolicies = { dangerous: { mode: 'ask' } };

    const v2 = await contentDir(
      [{ id: 'dbtools', manifest: { ...mcpbManifest, name: 'echo-bundle', version: '2.0.0' } }],
      [{ id: 'docs', url: 'https://mcp.example.com/mcp' }],
    );
    const newCtx = ctxOf(rig, identityV('2.0.0'), v2.dir, v2.manifestFile, ownedOf([serverId]));
    newCtx.userConfig = { dbtools: { api_key: 'sk-kept' } };
    await rig.projector.update(oldCtx, newCtx);

    expect(rig.servers).toHaveLength(2);
    const updated = rig.servers.find((server) => server.id === serverId)!;
    expect(updated.id).toBe(serverId); // deterministic derivation — stable across versions
    expect(updated.enabled).toBe(false);
    expect(updated.toolPolicies).toEqual({ dangerous: { mode: 'ask' } });
    expect(updated.autoApprove).toBe(false);
    expect(updated.source).toMatchObject({ kind: 'plugin', version: '2.0.0' });
    // The new bundle's tree exists; the OLD tree is only released by commitUpdate.
    const newTree = path.join(rig.unpackedDir, '..', 'echo-bundle@2.0.0');
    expect(existsSync(rig.unpackedDir)).toBe(true); // echo-bundle@1.0.0
    expect(existsSync(newTree)).toBe(true); // echo-bundle@2.0.0
    const parsed = JSON.parse(beginSnapshot!) as { servers: Array<{ id: string }> };
    expect(parsed.servers.map((server) => server.id)).toEqual([serverId]);
    await rig.projector.commitUpdate(identityV('2.0.0'), beginSnapshot);
    expect(existsSync(rig.unpackedDir)).toBe(false); // old tree released, nothing references it
    expect(rig.closed).toContain(serverId); // replaced server's cached connection closed
  });

  it('http 更新：就地替换 url，保留 enabled 与 toolPolicies，autoApprove 重置', async () => {
    const rig = await makeRig();
    const v1 = await contentDir([], [{ id: 'docs', url: 'https://mcp.example.com/mcp' }]);
    const oldCtx = ctxOf(rig, identityV('1.0.0'), v1.dir, v1.manifestFile);
    await rig.projector.project(oldCtx);
    const serverId = rig.servers[0]!.id;
    oldCtx.owned = ownedOf([serverId]);
    rig.servers[0]!.enabled = false;
    rig.servers[0]!.autoApprove = true;
    rig.servers[0]!.toolPolicies = { risky: { mode: 'ask' } };

    const v2 = await contentDir([], [{ id: 'docs', url: 'https://mcp2.example.com/mcp' }]);
    await rig.projector.update(
      oldCtx,
      ctxOf(rig, identityV('2.0.0'), v2.dir, v2.manifestFile, ownedOf([serverId])),
    );

    expect(rig.servers).toHaveLength(1);
    expect(rig.servers[0]).toMatchObject({
      id: serverId,
      transport: 'http',
      url: 'https://mcp2.example.com/mcp',
      enabled: false,
      autoApprove: false,
    });
    expect(rig.servers[0]!.toolPolicies).toEqual({ risky: { mode: 'ask' } });
    expect(rig.closed).toContain(serverId);
  });

  it('新版本删除的 server 走 unproject 同款清理并释放旧树；账本同步移除', async () => {
    const rig = await makeRig();
    const v1 = await contentDir(
      [{ id: 'dbtools' }],
      [{ id: 'docs', url: 'https://mcp.example.com/mcp' }],
    );
    const oldCtx = ctxOf(rig, identityV('1.0.0'), v1.dir, v1.manifestFile);
    oldCtx.userConfig = { dbtools: { api_key: 'sk-x' } };
    await rig.projector.project(oldCtx);
    const mcpbServer = rig.servers.find((server) => server.transport === 'stdio')!;
    const httpServer = rig.servers.find((server) => server.transport === 'http')!;
    oldCtx.owned = ownedOf([mcpbServer.id, httpServer.id]);

    const v2 = await contentDir([], [{ id: 'docs', url: 'https://mcp.example.com/mcp' }]);
    await rig.projector.update(
      oldCtx,
      ctxOf(
        rig,
        identityV('2.0.0'),
        v2.dir,
        v2.manifestFile,
        ownedOf([mcpbServer.id, httpServer.id]),
      ),
    );
    expect(rig.servers).toHaveLength(1); // http kept
    expect(rig.servers[0]!.id).toBe(httpServer.id);
    expect(rig.ledger.list('mcp')).toEqual([httpServer.id]);
    expect(rig.removed).toEqual([mcpbServer.id]);
    expect(existsSync(rig.unpackedDir)).toBe(false); // the dropped bundle's tree was released
  });

  it('rollbackUpdate 还原快照并释放新包树；快照为 null 视为更新前没有 server', async () => {
    const rig = await makeRig();
    const v1 = await contentDir([{ id: 'dbtools' }]);
    const oldCtx = ctxOf(rig, identityV('1.0.0'), v1.dir, v1.manifestFile);
    oldCtx.userConfig = { dbtools: { api_key: 'sk-old' } };
    await rig.projector.project(oldCtx);
    const serverId = rig.servers[0]!.id;
    oldCtx.owned = ownedOf([serverId]);
    const snapshot = await rig.projector.beginUpdate(identityV('1.0.0'));

    // A "new version" install unpacks into a DIFFERENT bundle slot (2.0.0).
    const v2 = await contentDir([
      { id: 'dbtools', manifest: { ...mcpbManifest, name: 'echo-bundle', version: '2.0.0' } },
    ]);
    const newCtx = ctxOf(rig, identityV('2.0.0'), v2.dir, v2.manifestFile, ownedOf([serverId]));
    newCtx.userConfig = { dbtools: { api_key: 'sk-new' } };
    await rig.projector.update(oldCtx, newCtx);
    const newTree = path.join(rig.unpackedDir, '..', 'echo-bundle@2.0.0');
    expect(existsSync(newTree)).toBe(true);
    expect(rig.servers[0]!.source).toMatchObject({ version: '2.0.0' });

    await rig.projector.rollbackUpdate(identityV('2.0.0'), snapshot);
    const restored = rig.servers[0]!;
    expect(restored.id).toBe(serverId);
    expect(restored.source).toMatchObject({ kind: 'plugin', version: '1.0.0' });
    expect(restored.env).toEqual({ API_KEY: 'secret:env:api_key' }); // kept secret placeholder
    // Secrets are not part of the snapshot: a value the new version PROVIDED stays rotated
    // after the rollback (documented known limitation).
    expect(rig.secrets.get(`mcp:${serverId}:env:api_key`)).toBe('sk-new');
    expect(rig.closed).toContain(serverId);
    expect(existsSync(newTree)).toBe(false); // the NEW package tree was released

    // A null snapshot means "no servers before the update": everything of the plugin goes.
    // (The ledger is re-synced by the registry after compensation, not here.)
    await rig.projector.rollbackUpdate(identityV('2.0.0'), null);
    expect(rig.servers).toHaveLength(0);
  });
});

describe('McpProjector.unproject / setEnabled', () => {
  async function projectOne(): Promise<Rig> {
    const rig = await makeRig();
    const { dir, manifestFile } = await contentDir([{ id: 'dbtools' }]);
    const ctx = ctxOf(rig, identity(), dir, manifestFile);
    ctx.userConfig = { dbtools: { api_key: 'sk-unproject' } };
    await rig.projector.project(ctx);
    return rig;
  }

  it('unproject 清 settings、secrets（经 removeCustomServer）、解包树与账本', async () => {
    const rig = await projectOne();
    const serverId = rig.servers[0]!.id;
    expect(existsSync(rig.unpackedDir)).toBe(true);
    await rig.projector.unproject(identity(), rig.ledger.list('mcp'), rig.ledger);
    expect(rig.servers).toHaveLength(0);
    expect(rig.removed).toEqual([serverId]);
    expect(rig.secrets.has(`mcp:${serverId}:env:api_key`)).toBe(false);
    expect(existsSync(rig.unpackedDir)).toBe(false);
    expect(rig.ledger.list('mcp')).toEqual([]);
    // 幂等：再跑一遍不抛
    await rig.projector.unproject(identity(), [serverId], rig.ledger);
  });

  it('unproject 单步失败仍继续（尽力而为）', async () => {
    const rig = await projectOne();
    const serverId = rig.servers[0]!.id;
    const failing = new McpProjector({
      settings: {
        get: () => ({ mcpServers: [...rig.servers] }) as unknown as Settings,
        update: (patch: Partial<Settings>) => {
          if (patch.mcpServers !== undefined) {
            rig.servers.splice(0, rig.servers.length, ...patch.mcpServers);
          }
          return { mcpServers: [...rig.servers] } as unknown as Settings;
        },
      },
      mcpb: rig.installer,
      mcp: { closeServer: async () => {} },
      disconnector: {
        removeCustomServer: async () => {
          throw new Error('revoke exploded');
        },
      },
      revokeMcpServerChanges: () => {},
      logger: noopLogger,
    });
    await expect(failing.unproject(identity(), [serverId], rig.ledger)).resolves.toBeUndefined();
    // Step ① still succeeded, and the chain continued past the throwing revoke to
    // afterServerRemoved → the tree was released.
    expect(rig.servers).toHaveLength(0);
    expect(existsSync(rig.unpackedDir)).toBe(false);
  });

  it('setEnabled 往返：false 关闭并撤销，true 恢复', async () => {
    const rig = await projectOne();
    const serverId = rig.servers[0]!.id;
    const ctx = ctxOf(
      rig,
      identity(),
      '/nonexistent',
      pluginManifestSchema.parse({
        format_version: 1,
        id: 'io.github.tester/mcp',
        name: 'MCP',
        version: '1.0.0',
        contributions: { mcp: [{ kind: 'mcpb', id: 'dbtools', file: 'mcp/dbtools.mcpb' }] },
      }),
    );
    await rig.projector.setEnabled(ctx, [serverId], false);
    expect(rig.servers[0]).toMatchObject({ enabled: false });
    expect(rig.closed).toEqual([serverId]);
    expect(rig.revocations).toHaveLength(1);

    await rig.projector.setEnabled(ctx, [serverId], true);
    expect(rig.servers[0]).toMatchObject({ enabled: true });
    expect(rig.closed).toEqual([serverId]); // no additional close on re-enable
  });
});

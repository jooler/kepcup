import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type McpServer, type Settings } from '@kepcup/shared';
import { buildMcpbFixture } from '@kepcup/testkit';
import {
  McpbInstaller,
  mcpbPackageOf,
  type McpbInstallerDeps,
  type McpbRegistration,
} from '../../src/apps/mcpb/index.js';

/**
 * `McpbInstaller.register`（D104 P0a-2 步骤 4）：插件管线以调用方指定的 server id /
 * 来源 / 分级登记 MCPB server；包引用计数同时认 `mcpb` 与 `plugin` 两种来源；
 * `slotConflict` 供注册表预检。独立安装路径（无 `register`）行为不变。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcpb-register-'));
  dirs.push(dir);
  return dir;
}

// Copied verbatim from `mcpb.test.ts` (harness + expectCode): the register path shares
// the installer rig; the standalone-install tests stay in the original file.
interface Harness {
  installer: McpbInstaller;
  home: string;
  servers: McpServer[];
  secrets: Map<string, string>;
  approvals: Array<Record<string, unknown>>;
  settingsJson(): string;
}

async function harness(
  overrides: Partial<McpbInstallerDeps> & { approve?: boolean } = {},
): Promise<Harness> {
  const home = await tmp();
  const servers: McpServer[] = [];
  const secrets = new Map<string, string>();
  const approvals: Array<Record<string, unknown>> = [];
  const settings = {
    get: () => ({ mcpServers: servers }) as unknown as Settings,
    update: (patch: Partial<Settings>) => {
      if (patch.mcpServers !== undefined) {
        servers.splice(0, servers.length, ...patch.mcpServers);
      }
      return { mcpServers: servers } as unknown as Settings;
    },
  };
  const deps: McpbInstallerDeps = {
    paths: { toolchainsDir: path.join(home, 'toolchains') },
    settings,
    secrets: {
      setValue: (name, value) => void secrets.set(name, value),
      removeByPrefix: (prefix) => {
        const removed = [...secrets.keys()].filter((name) => name.startsWith(prefix));
        for (const name of removed) secrets.delete(name);
        return removed;
      },
    },
    logger,
    homeDir: '/home/tester',
    platform: 'linux',
    arch: 'x64',
    resolveRuntime: (kind) =>
      kind === 'node' ? { command: '/managed/node/bin/node', version: '24.21.0' } : null,
    requestApproval: async (_context, payload) => {
      approvals.push(payload);
      return overrides.approve !== false;
    },
    ...overrides,
  };
  return {
    installer: new McpbInstaller(deps),
    home,
    servers,
    secrets,
    approvals,
    settingsJson: () => JSON.stringify(servers),
  };
}

async function expectCode(promise: Promise<unknown>, code: string, match?: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (match !== undefined) expect((error as AppError).message).toMatch(match);
}

const manifest = {
  server: {
    type: 'node',
    entry_point: 'server/index.cjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.cjs', '${user_config.label}'],
      env: { API_KEY: '${user_config.api_key}', STATIC: 'plain' },
    },
  },
  user_config: {
    api_key: { type: 'string', title: 'API Key', sensitive: true, required: true },
    label: { type: 'string', title: 'Label', default: 'lbl' },
  },
};

const PLUGIN_ID = 'io.github.tester/pkg';

function pluginRegistration(options: {
  serverId: string;
  tier?: 'developer' | undefined;
  version?: string;
  name?: string;
  description?: string;
  mcpbSha256?: string;
}): McpbRegistration {
  return {
    serverId: options.serverId,
    source: {
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      version: options.version ?? '1.0.0',
      key: 'dbtools',
      ...(options.mcpbSha256 !== undefined
        ? {
            mcpb: {
              name: 'echo-bundle',
              version: '1.0.0',
              sha256: options.mcpbSha256,
            },
          }
        : {}),
    },
    tier: options.tier,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  };
}

describe('mcpb register (plugin pipeline)', () => {
  it('installs under the caller-specified id, plugin source, tier and overrides', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest });
    const registration = pluginRegistration({
      serverId: 'plg_abc123def456',
      tier: 'developer',
      name: '数据库工具',
      description: '由插件提供的 MCP 服务器',
      mcpbSha256: fixture.sha256,
    });
    const { serverId } = await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-register' },
      register: registration,
    });
    expect(serverId).toBe('plg_abc123def456');
    const server = h.servers[0]!;
    expect(server).toMatchObject({
      id: 'plg_abc123def456',
      name: '数据库工具',
      description: '由插件提供的 MCP 服务器',
      transport: 'stdio',
      tier: 'developer',
      source: {
        kind: 'plugin',
        pluginId: PLUGIN_ID,
        version: '1.0.0',
        key: 'dbtools',
        mcpb: { name: 'echo-bundle', version: '1.0.0', sha256: fixture.sha256 },
      },
    });
    expect(h.secrets.get('mcp:plg_abc123def456:env:api_key')).toBe('sk-register');
    expect(h.settingsJson()).not.toContain('sk-register');
    expect(existsSync(path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0'))).toBe(true);
  });

  it('omits the tier field when the registration tier is undefined', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest });
    const { serverId } = await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-tier' },
      register: pluginRegistration({ serverId: 'plg_tier00000001', mcpbSha256: fixture.sha256 }),
    });
    const server = h.servers.find((entry) => entry.id === serverId)!;
    expect('tier' in server && server.tier !== undefined).toBe(false);
    expect(server.source).toMatchObject({ kind: 'plugin', mcpb: { sha256: fixture.sha256 } });
  });

  it('rejects a register install when the server id already exists', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest });
    const registration = pluginRegistration({ serverId: 'plg_dup00000001', tier: 'developer' });
    await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-one' },
      register: registration,
    });
    await expectCode(
      h.installer.install({
        filePath: fixture.path,
        sha256: fixture.sha256,
        userConfig: { api_key: 'sk-two' },
        register: registration,
      }),
      'ALREADY_EXISTS',
      /plg_dup00000001/,
    );
    expect(h.servers).toHaveLength(1);
  });

  it('afterServerRemoved releases the tree for a plugin source and keeps it while referenced', async () => {
    const h = await harness();
    const dir = await tmp();
    const fixture = await buildMcpbFixture({ dir, manifest });
    const unpacked = path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0');
    const first = pluginRegistration({
      serverId: 'plg_ref000000001a',
      tier: 'developer',
      mcpbSha256: fixture.sha256,
    });
    const second = pluginRegistration({
      serverId: 'plg_ref000000002b',
      tier: 'developer',
      version: '1.0.1',
      mcpbSha256: fixture.sha256,
    });
    await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-a' },
      register: first,
    });
    await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-b' },
      register: second,
    });
    expect(existsSync(unpacked)).toBe(true);

    // The hook runs after settings were already updated: simulate that by dropping the
    // server from the fake settings first, like `mcp.removeServer` does.
    const removeFromSettings = (serverId: string): McpServer[] => {
      const previous = [...h.servers];
      h.servers.splice(
        0,
        h.servers.length,
        ...h.servers.filter((server) => server.id !== serverId),
      );
      return previous;
    };

    // First server removed: the second still references the same package slot.
    const previousFirst = removeFromSettings('plg_ref000000001a');
    await h.installer.afterServerRemoved(previousFirst, 'plg_ref000000001a');
    expect(existsSync(unpacked)).toBe(true);

    // Second server removed: the package is now unused → tree released.
    const previousSecond = removeFromSettings('plg_ref000000002b');
    await h.installer.afterServerRemoved(previousSecond, 'plg_ref000000002b');
    expect(existsSync(unpacked)).toBe(false);
  });

  it('afterServerRemoved ignores plugin sources without an embedded mcpb', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest });
    await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-http' },
      register: {
        serverId: 'plg_http00000001',
        source: { kind: 'plugin', pluginId: PLUGIN_ID, version: '1.0.0', key: 'docs' },
        tier: 'developer',
      },
    });
    // The install extracted the tree, but the registration references no package —
    // the removal hook must not release anything on its behalf.
    const unpacked = path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0');
    expect(existsSync(unpacked)).toBe(true);
    expect(mcpbPackageOf(h.servers[0]!.source)).toBeNull();
    await h.installer.afterServerRemoved([...h.servers, h.servers[0]!], 'plg_http00000001');
    expect(existsSync(unpacked)).toBe(true);
  });

  it('slotConflict finds a same name@version slot with different content', async () => {
    const h = await harness();
    const dir = await tmp();
    const fixture = await buildMcpbFixture({ dir, manifest });
    await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-slot' },
      register: pluginRegistration({
        serverId: 'plg_slot00000001',
        tier: 'developer',
        mcpbSha256: fixture.sha256,
      }),
    });
    // Same slot (echo-bundle@1.0.0), different sha256 → hit.
    expect(h.installer.slotConflict('echo-bundle', '1.0.0', 'f'.repeat(64))).toEqual({
      serverId: 'plg_slot00000001',
    });
    // Same slot, same sha256 → miss (re-install of the same content is fine).
    expect(h.installer.slotConflict('echo-bundle', '1.0.0', fixture.sha256)).toBeNull();
    // Different version → miss.
    expect(h.installer.slotConflict('echo-bundle', '1.0.1', 'f'.repeat(64))).toBeNull();
    expect(h.installer.slotConflict('other', '1.0.0', 'f'.repeat(64))).toBeNull();
  });

  it('rejects a same-slot install with different content through the register path too', async () => {
    const h = await harness();
    const dir = await tmp();
    const fixture = await buildMcpbFixture({ dir, manifest });
    await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-one' },
      register: pluginRegistration({
        serverId: 'plg_slot00000001',
        tier: 'developer',
        mcpbSha256: fixture.sha256,
      }),
    });
    // Same name@version (echo-bundle@1.0.0), different bytes → different sha256.
    const changed = await buildMcpbFixture({
      dir,
      fileName: 'changed.mcpb',
      manifest: { ...manifest, description: 'changed bytes, same slot' },
    });
    expect(changed.sha256).not.toBe(fixture.sha256);
    await expectCode(
      h.installer.install({
        filePath: changed.path,
        sha256: changed.sha256,
        userConfig: { api_key: 'sk-two' },
        register: pluginRegistration({
          serverId: 'plg_slot00000002',
          tier: 'developer',
          mcpbSha256: changed.sha256,
        }),
      }),
      'MCPB_INVALID',
      /已安装同名同版本/,
    );
  });

  it('standalone install (no register) keeps the random mcpb_ id and developer tier', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest });
    const { serverId } = await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-plain' },
    });
    expect(serverId).toMatch(/^mcpb_[0-9a-f]{12}$/);
    expect(h.servers[0]).toMatchObject({
      id: serverId,
      name: 'Echo Bundle',
      tier: 'developer',
      source: { kind: 'mcpb', name: 'echo-bundle', version: '1.0.0', sha256: fixture.sha256 },
    });
  });
});

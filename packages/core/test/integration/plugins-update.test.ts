import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { McpServer, PluginInspectOutput, PluginSummary } from '@kepcup/shared';
import {
  buildPluginFixture,
  createTestStack,
  type TestStack,
} from '@kepcup/testkit';

import { createMemoryKeystore } from '../../src/infra/keystore.js';
import { PluginPackager } from '../../src/plugins/package.js';
import { PluginStore } from '../../src/plugins/store.js';
import { pluginServerId } from '../../src/plugins/ids.js';
import type { PluginProjector } from '../../src/plugins/projectors/index.js';
import {
  buildPluginIndex,
  makeMarketKey,
  pluginIndexEntryFor,
} from '../support/plugin-market-fixture.js';
import type { DirectoryFetch } from '../../src/apps/directory-sync.js';
import { readFileSync } from 'node:fs';

/**
 * 插件更新集成（D104 P1-2 步骤 6）：市场更新全事务（版本翻转 / 技能换内容 / MCP server
 * id 稳定且 enabled、toolPolicies 保留、autoApprove 重置 / 旧解包树 GC / 敏感留空保留
 * secret）、连接器端点变化断连、删除贡献的清理、权限扩大再同意、本地同 id 重装 = 更新、
 * 投影失败回滚（projectorWrap 注入）、撤销版本拒更、重启按日志恢复。
 */

const PLUGIN_ID = 'io.github.tester/upd';
const MCPB_KEY = 'dbtools';
const OFFICIAL_BASE = 'https://market.test/plugins/v1';
const T1 = Date.parse('2026-10-20T00:00:00.000Z');
const T2 = Date.parse('2026-10-21T00:00:00.000Z');

const mcpbManifest = (version: string) => ({
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
  // Every generation gets its own unpacked slot (echo-bundle@{version}).
  name: 'echo-bundle',
  version,
});

interface FixtureOptions {
  version: string;
  skills?: string[];
  removedSkill?: string;
  connectorUrl?: string;
  mcpbVersion?: string;
  fileName?: string;
  /** 追加到每个技能描述后（同版本 / 跨版本制造内容差异）。 */
  skillSuffix?: string;
}

async function makeFixture(options: FixtureOptions): Promise<{
  path: string;
  sha256: string;
  size: number;
  manifest: Record<string, unknown>;
}> {
  const skills = (options.skills ?? ['plg-alpha']).map((name) => ({
    name,
    ...(options.skillSuffix !== undefined ? { description: `技能 ${name} ${options.skillSuffix}` } : {}),
  }));
  if (options.removedSkill !== undefined) skills.push({ name: options.removedSkill });
  const built = await buildPluginFixture({
    dir: path.join(root, `fx-${Math.random().toString(36).slice(2, 8)}`),
    manifest: { id: PLUGIN_ID, version: options.version },
    fileName: options.fileName,
    skills,
    connectors: [{ slug: 'plgconn', url: options.connectorUrl }],
    mcpb: [
      {
        id: MCPB_KEY,
        mcpb: { manifest: mcpbManifest(options.mcpbVersion ?? '1.0.0') },
      },
    ],
    http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
  });
  return { path: built.path, sha256: built.sha256, size: built.size, manifest: built.manifest };
}

/** In-memory market + package server (same shape as plugins-marketplace.test.ts). */
class Market {
  readonly #files = new Map<string, Buffer>();
  readonly fetch: DirectoryFetch = async (input) => {
    const file = this.#files.get(input);
    if (file === undefined) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(file), { status: 200 });
  };
  publish(input: {
    key: ReturnType<typeof makeMarketKey>;
    generatedAt: number;
    entries: Array<Record<string, unknown>>;
    revoked?: Array<Record<string, unknown>>;
  }): void {
    const signed = buildPluginIndex({
      key: input.key,
      generatedAt: input.generatedAt,
      entries: input.entries,
      ...(input.revoked !== undefined ? { revoked: input.revoked } : {}),
    });
    this.#files.set(`${OFFICIAL_BASE}/index.json`, signed.indexBytes);
    this.#files.set(`${OFFICIAL_BASE}/index.json.sig`, Buffer.from(`${signed.sig}\n`));
  }
  serve(base: string, fixture: { path: string; sha256: string }): void {
    this.#files.set(`${base}/${fixture.sha256}.kepcup`, readFileSync(fixture.path));
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'plugins-update-'));
const stacks: TestStack[] = [];
afterAll(() => {
  for (const stack of stacks.splice(0)) void stack.cleanup();
  rmSync(root, { recursive: true, force: true });
});

interface MarketFixture {
  path: string;
  sha256: string;
  size: number;
  manifest: Record<string, unknown>;
}

interface Rig {
  stack: TestStack;
  market: Market;
  key: ReturnType<typeof makeMarketKey>;
  home: string;
}

async function setup(): Promise<Rig> {
  const market = new Market();
  const key = makeMarketKey('upd-test');
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  const stack = await createTestStack({
    home,
    keystore: createMemoryKeystore(),
    mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } },
    pluginMarketplace: {
      keys: [key.publicEntry],
      baseUrl: OFFICIAL_BASE,
      fetch: market.fetch,
      initialDelayMs: 3600_000,
    },
  });
  stacks.push(stack);
  return { stack, market, key, home };
}

async function refresh(stack: TestStack): Promise<void> {
  await stack.core.rpc.call('plugins.marketplace.refresh', undefined);
}

async function publish(
  rig: Rig,
  generatedAt: number,
  fixtures: Array<{ fixture: MarketFixture; tier?: 'verified' | 'community' }>,
  revoked?: Array<Record<string, unknown>>,
): Promise<void> {
  for (const { fixture } of fixtures) rig.market.serve(OFFICIAL_BASE, fixture);
  rig.market.publish({
    key: rig.key,
    generatedAt,
    entries: fixtures.map(({ fixture, tier }) =>
      pluginIndexEntryFor(fixture as never, {
        downloadUrl: `${OFFICIAL_BASE}/${fixture.sha256}.kepcup`,
        ...(tier !== undefined ? { tier } : {}),
      }),
    ),
    ...(revoked !== undefined ? { revoked } : {}),
  });
  await refresh(rig.stack);
}

const pluginsList = async (stack: TestStack): Promise<PluginSummary[]> =>
  ((await stack.core.rpc.call('plugins.list', undefined)) as { plugins: PluginSummary[] }).plugins;

const pluginServers = (stack: TestStack) =>
  stack.core.services.domain!.settings
    .get()
    .mcpServers.filter((server) => server.source?.kind === 'plugin');

/** 单包发布（手动 publish 的回滚 / 撤销 / 重启用例共用）。 */
async function publishOne(
  stack: TestStack,
  market: Market,
  key: ReturnType<typeof makeMarketKey>,
  generatedAt: number,
  fixture: MarketFixture,
  revoked?: Array<Record<string, unknown>>,
): Promise<void> {
  market.serve(OFFICIAL_BASE, fixture);
  market.publish({
    key,
    generatedAt,
    entries: [
      pluginIndexEntryFor(fixture as never, {
        downloadUrl: `${OFFICIAL_BASE}/${fixture.sha256}.kepcup`,
      }),
    ],
    ...(revoked !== undefined ? { revoked } : {}),
  });
  await stack.core.rpc.call('plugins.marketplace.refresh', undefined);
}

describe('plugins update integration (P1-2)', () => {
  it('市场更新 1.0.0 → 1.1.0：版本翻转、技能换内容、server id 稳定（enabled / toolPolicies 保留、autoApprove 重置）、旧解包树 GC、端点不变的连接保留', async () => {
    const rig = await setup();
    const { core } = rig.stack;
    const v1 = await makeFixture({ version: '1.0.0', skills: ['plg-alpha'], mcpbVersion: '1.0.0' });
    const v2 = await makeFixture({
      version: '1.1.0',
      skills: ['plg-alpha'],
      skillSuffix: '第二版', // same name, different content → hash changes
      mcpbVersion: '2.0.0',
    });
    await publish(rig, T1, [{ fixture: v1 }]);

    const inspect1 = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
    })) as PluginInspectOutput;
    expect(inspect1.existing).toBeNull();
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-v1' } },
    });

    // 用户状态：改 toolPolicy、停用 http server；给连接器造一条连接（端点不变 → 保留）
    const stdioId = pluginServerId(PLUGIN_ID, MCPB_KEY);
    const httpId = pluginServerId(PLUGIN_ID, 'docs');
    core.services.domain!.settings.update({
      mcpServers: core.services.domain!.settings.get().mcpServers.map((server) =>
        server.id === stdioId
          ? { ...server, autoApprove: true, toolPolicies: { echo: { approval: 'ask' } } }
          : server.id === httpId
            ? { ...server, enabled: false }
            : server,
      ),
    });
    const connection = core.services.apps!.store.create({
      connectorId: 'plgconn',
      label: '保留用连接',
    });
    const skills = core.services.skills!;
    const oldAlphaLibrary = skills.publicSkillRow('plg-alpha')!.library_id;

    await publish(rig, T2, [{ fixture: v2 }]);
    const inspect2 = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
    })) as PluginInspectOutput;
    expect(inspect2.existing).toEqual({ version: '1.0.0' });
    expect(inspect2.update).toEqual({ from: '1.0.0', permissionsExpanded: false, added: [] });
    expect(inspect2.installable).toBe(true);

    const toolchains = path.join(rig.home, 'toolchains', 'mcpb');
    expect(existsSync(path.join(toolchains, 'echo-bundle@1.0.0'))).toBe(true);

    const updated = (await core.rpc.call('plugins.update', {
      id: PLUGIN_ID,
      sha256: v2.sha256,
      userConfig: {}, // 敏感留空 = 保留已存 secret
    })) as { plugin: PluginSummary };
    expect(updated.plugin).toMatchObject({ version: '1.1.0', origin: 'marketplace' });

    // 版本与日志清零
    expect((await pluginsList(rig.stack))[0]).toMatchObject({ version: '1.1.0', updateAvailable: null });
    // 技能内容换新（库新行、旧行被回收）
    const alpha = skills.publicSkillRow('plg-alpha')!;
    expect(alpha.library_id).not.toBe(oldAlphaLibrary);
    expect(skills.libraryGet(oldAlphaLibrary)).toBeNull();
    // MCP：id 不变、toolPolicies 保留、autoApprove 重置、enabled 保留、secret 未变
    const servers = pluginServers(rig.stack);
    const stdio = servers.find((server) => server.id === stdioId)!;
    expect(stdio).toMatchObject({
      autoApprove: false,
      toolPolicies: { echo: { approval: 'ask' } },
      env: { API_KEY: 'secret:env:api_key' },
      source: { kind: 'plugin', version: '1.1.0' },
    });
    expect(servers.find((server) => server.id === httpId)!.enabled).toBe(false);
    const echo = await core.services.mcp!.callTool(stdio as McpServer, 'read_env', { name: 'API_KEY' });
    expect(echo.content).toEqual([{ type: 'text', text: 'env:sk-v1' }]);
    // 解包树：新树在、旧树提交后被 GC
    expect(existsSync(path.join(toolchains, 'echo-bundle@2.0.0'))).toBe(true);
    expect(existsSync(path.join(toolchains, 'echo-bundle@1.0.0'))).toBe(false);
    // 端点不变的连接保留
    expect(rig.stack.core.services.apps!.store.get(connection.id)).not.toBeNull();
  }, 120_000);

  it('连接器端点变化 → 既有连接被断开（连接行删除）', async () => {
    const rig = await setup();
    const { core } = rig.stack;
    const v1 = await makeFixture({
      version: '1.0.0',
      connectorUrl: 'https://mcp.plgconn.test/mcp',
      fileName: 'conn-v1.kepcup',
    });
    const v2 = await makeFixture({
      version: '1.1.0',
      connectorUrl: 'https://mcp2.plgconn.test/mcp',
      fileName: 'conn-v2.kepcup',
    });
    await publish(rig, T1, [{ fixture: v1 }]);
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-x' } },
    });
    const connection = core.services.apps!.store.create({
      connectorId: 'plgconn',
      label: '将被断开',
    });

    await publish(rig, T2, [{ fixture: v2 }]);
    // 新 host 是新权限：需要 acknowledgeDiff（这正是「权限扩大再同意」的语义）。
    await core.rpc.call('plugins.update', {
      id: PLUGIN_ID,
      sha256: v2.sha256,
      userConfig: {},
      acknowledgeDiff: true,
    });
    expect(core.services.apps!.store.get(connection.id)).toBeNull();
  }, 120_000);

  it('新版本删除的技能 / server / 连接器被清理，被删连接器的连接断开', async () => {
    const rig = await setup();
    const { core } = rig.stack;
    const v1 = await makeFixture({
      version: '1.0.0',
      skills: ['plg-alpha'],
      removedSkill: 'plg-extra',
      mcpbVersion: '1.0.0',
      fileName: 'trim-v1.kepcup',
    });
    // v2 真正精简：去掉 plg-extra 技能、http docs 与连接器贡献
    const trimmed = await buildPluginFixture({
      dir: path.join(root, `fx-trim-${Math.random().toString(36).slice(2, 8)}`),
      manifest: { id: PLUGIN_ID, version: '1.1.0' },
      skills: [{ name: 'plg-alpha' }],
      mcpb: [{ id: MCPB_KEY, mcpb: { manifest: mcpbManifest('1.1.0') } }],
    });
    await publish(rig, T1, [{ fixture: v1 }]);
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-x' } },
    });
    const connection = core.services.apps!.store.create({
      connectorId: 'plgconn',
      label: '级联断开',
    });
    const docsId = pluginServerId(PLUGIN_ID, 'docs');
    expect(pluginServers(rig.stack).some((server) => server.id === docsId)).toBe(true);

    await publish(rig, T2, [{ fixture: { ...trimmed, size: trimmed.size } }]);
    await core.rpc.call('plugins.update', { id: PLUGIN_ID, sha256: trimmed.sha256, userConfig: {} });

    const summary = (await pluginsList(rig.stack))[0]!;
    expect(summary.items.map((item) => [item.kind, item.ref]).sort()).toEqual([
      ['mcp', pluginServerId(PLUGIN_ID, MCPB_KEY)],
      ['skill', 'plg-alpha'],
    ]);
    expect(pluginServers(rig.stack).some((server) => server.id === docsId)).toBe(false);
    expect(core.services.apps!.store.get(connection.id)).toBeNull(); // 被删连接器的连接断开
    expect(core.services.skills!.publicSkillRow('plg-extra')).toBeNull();
  }, 120_000);

  it('权限扩大：inspect 报差异；无 acknowledgeDiff → INVALID_INPUT 且旧版本完好；带则成功', async () => {
    const rig = await setup();
    const { core } = rig.stack;
    const v1 = await makeFixture({
      version: '1.0.0',
      skills: ['plg-alpha'],
      fileName: 'perm-v1.kepcup',
    });
    const v2 = await makeFixture({
      version: '1.1.0',
      skills: ['plg-alpha', 'plg-beta'], // 新技能 = 权限扩大
      fileName: 'perm-v2.kepcup',
    });
    await publish(rig, T1, [{ fixture: v1 }]);
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-x' } },
    });
    const before = (await pluginsList(rig.stack))[0]!;

    await publish(rig, T2, [{ fixture: v2 }]);
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
    })) as PluginInspectOutput;
    expect(inspect.update).toMatchObject({ from: '1.0.0', permissionsExpanded: true });
    expect(inspect.update!.added).toContain('新增技能 plg-beta（对所有 Bot 可见）');

    await expect(
      core.rpc.call('plugins.update', { id: PLUGIN_ID, sha256: v2.sha256, userConfig: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { permissionsExpanded: true } });
    // 旧版本完好无损
    const after = (await pluginsList(rig.stack))[0]!;
    expect(after).toMatchObject({ version: '1.0.0' });
    expect(after.items.length).toBe(before.items.length);

    const done = (await core.rpc.call('plugins.update', {
      id: PLUGIN_ID,
      sha256: v2.sha256,
      userConfig: {},
      acknowledgeDiff: true,
    })) as { plugin: PluginSummary };
    expect(done.plugin).toMatchObject({ version: '1.1.0' });
  }, 120_000);

  it('敏感配置：更新提供新值 → secret 被覆盖；再次更新留空 → 覆盖后的值保留', async () => {
    const rig = await setup();
    const { core } = rig.stack;
    const v1 = await makeFixture({ version: '1.0.0', mcpbVersion: '1.0.0', fileName: 'sec-v1.kepcup' });
    const v2 = await makeFixture({ version: '1.1.0', mcpbVersion: '2.0.0', fileName: 'sec-v2.kepcup' });
    const v3 = await makeFixture({ version: '1.2.0', mcpbVersion: '3.0.0', fileName: 'sec-v3.kepcup' });
    await publish(rig, T1, [{ fixture: v1 }]);
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-old' } },
    });
    const stdioId = pluginServerId(PLUGIN_ID, MCPB_KEY);
    const readSecret = async (): Promise<string> => {
      const server = pluginServers(rig.stack).find((entry) => entry.id === stdioId)!;
      const result = await core.services.mcp!.callTool(server as McpServer, 'read_env', {
        name: 'API_KEY',
      });
      return String((result.content as Array<{ text: string }>)[0]!.text);
    };
    expect(await readSecret()).toBe('env:sk-old');

    await publish(rig, T2, [{ fixture: v2 }]);
    await core.rpc.call('plugins.update', {
      id: PLUGIN_ID,
      sha256: v2.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-rotated' } },
    });
    expect(await readSecret()).toBe('env:sk-rotated');

    await publish(rig, T2 + 1, [{ fixture: v3 }]);
    await core.rpc.call('plugins.update', { id: PLUGIN_ID, sha256: v3.sha256, userConfig: {} });
    expect(await readSecret()).toBe('env:sk-rotated'); // 留空 = 保留
  }, 180_000);

  it('本地同 id 重装 = 更新：同版本不同内容也行；.prev 在成功后消失', async () => {
    const stack = await createTestStack({
      mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } },
    });
    stacks.push(stack);
    const { core } = stack;
    const v1 = await makeFixture({ version: '2.0.0', skills: ['plg-alpha'], fileName: 'local-v1.kepcup' });
    await core.rpc.call('plugins.install', {
      source: { kind: 'file', path: v1.path },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-x' } },
    });
    // 同 id 同版本、不同内容（技能多一个文件 → 树哈希不同）
    const v1b = await buildPluginFixture({
      dir: path.join(root, `fx-local2-${Math.random().toString(36).slice(2, 8)}`),
      manifest: { id: PLUGIN_ID, version: '2.0.0' },
      skills: [{ name: 'plg-alpha', extraFiles: { 'NOTE.md': 'changed' } }],
      mcpb: [{ id: MCPB_KEY, mcpb: { manifest: mcpbManifest('1.0.0') } }],
      http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
      connectors: [{ slug: 'plgconn' }],
    });

    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: v1b.path },
    })) as PluginInspectOutput;
    expect(inspect.existing).toEqual({ version: '2.0.0' });
    expect(inspect.update).not.toBeNull();
    expect(inspect.installable).toBe(true);
    expect(inspect.blockers).toEqual([]);

    const done = (await core.rpc.call('plugins.install', {
      source: { kind: 'file', path: v1b.path },
      sha256: v1b.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-x' } },
    })) as { plugin: PluginSummary };
    expect(done.plugin).toMatchObject({ id: PLUGIN_ID, version: '2.0.0' });
    const pluginsDir = path.join(
      // TestStack 的 home 没有直接暴露；从 dirPath 反推
      path.dirname(path.dirname(done.plugin.dirPath!)),
    );
    expect(existsSync(path.join(pluginsDir, `${PLUGIN_ID}@2.0.0`.toLowerCase()))).toBe(true);
    expect(existsSync(path.join(pluginsDir, `${PLUGIN_ID}@2.0.0`.toLowerCase()) + '.prev')).toBe(
      false,
    );
    // id 不变、技能内容换新
    expect(core.services.skills!.publicSkillRow('plg-alpha')).not.toBeNull();
  }, 120_000);

  it('回滚：mcp 投影 update 失败（projectorWrap 注入）→ 版本 / server / 技能 / 目录全部回到旧版本，updateTo 清空', async () => {
    const market = new Market();
    const key = makeMarketKey('rollback');
    const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
    const failingWrap = (projector: PluginProjector): PluginProjector => {
      if (projector.kind !== 'mcp') return projector;
      // 委托对象：update 在目标版本上抛错，其余方法原样转发。
      const delegate = (name: 'inspect' | 'project' | 'unproject' | 'setEnabled') =>
        async (...args: Parameters<NonNullable<PluginProjector[name]>>) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (projector[name] as any)(...args);
      return {
        kind: projector.kind,
        inspect: delegate('inspect'),
        project: delegate('project'),
        unproject: delegate('unproject'),
        setEnabled: delegate('setEnabled'),
        ...(projector.activate !== undefined
          ? {
              activate: async (
                ...args: Parameters<NonNullable<PluginProjector['activate']>>
              ) => projector.activate!(...args)
            }
          : {}),
        ...(projector.missing !== undefined
          ? {
              missing: (...args: Parameters<NonNullable<PluginProjector['missing']>>) =>
                projector.missing!(...args)
            }
          : {}),
        update: async (oldCtx, newCtx) => {
          if (newCtx.plugin.version === '1.1.0') throw new Error('投影爆炸');
          return projector.update(oldCtx, newCtx);
        },
        ...(projector.beginUpdate !== undefined
          ? {
              beginUpdate: async (
                ...args: Parameters<NonNullable<PluginProjector['beginUpdate']>>
              ) => projector.beginUpdate!(...args)
            }
          : {}),
        ...(projector.commitUpdate !== undefined
          ? {
              commitUpdate: async (
                ...args: Parameters<NonNullable<PluginProjector['commitUpdate']>>
              ) => projector.commitUpdate!(...args)
            }
          : {}),
        ...(projector.rollbackUpdate !== undefined
          ? {
              rollbackUpdate: async (
                ...args: Parameters<NonNullable<PluginProjector['rollbackUpdate']>>
              ) => projector.rollbackUpdate!(...args)
            }
          : {}),
      };
    };
    const stack = await createTestStack({
      home,
      keystore: createMemoryKeystore(),
      mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } },
      pluginMarketplace: {
        keys: [key.publicEntry],
        baseUrl: OFFICIAL_BASE,
        fetch: market.fetch,
        initialDelayMs: 3600_000,
      },
      projectorWrap: failingWrap,
    });
    stacks.push(stack);
    const { core } = stack;
    const v1 = await makeFixture({ version: '1.0.0', mcpbVersion: '1.0.0', fileName: 'rb-v1.kepcup' });
    const v2 = await makeFixture({ version: '1.1.0', mcpbVersion: '2.0.0', fileName: 'rb-v2.kepcup' });
    await publishOne(stack, market, key, T1, v1);
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-v1' } },
    });
    const stdioId = pluginServerId(PLUGIN_ID, MCPB_KEY);
    const skillsBefore = core.services.skills!.publicSkillRow('plg-alpha')!.library_id;
    const toolchains = path.join(home, 'toolchains', 'mcpb');
    expect(existsSync(path.join(toolchains, 'echo-bundle@1.0.0'))).toBe(true);

    await publishOne(stack, market, key, T2, v2);
    await expect(
      core.rpc.call('plugins.update', { id: PLUGIN_ID, sha256: v2.sha256, userConfig: {} }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    // 一切回到旧版本
    expect((await pluginsList(stack))[0]).toMatchObject({ version: '1.0.0' });
    const row = core.services.domain!.settings
      .get()
      .mcpServers.find((server) => server.id === stdioId)!;
    expect(row).toMatchObject({
      source: { kind: 'plugin', version: '1.0.0' },
      env: { API_KEY: 'secret:env:api_key' },
    });
    expect(core.services.skills!.publicSkillRow('plg-alpha')!.library_id).toBe(skillsBefore);
    expect(existsSync(path.join(toolchains, 'echo-bundle@1.0.0'))).toBe(true);
    expect(existsSync(path.join(toolchains, 'echo-bundle@2.0.0'))).toBe(false);
    const pluginsDir = path.join(home, 'plugins');
    expect(existsSync(path.join(pluginsDir, `${PLUGIN_ID}@1.0.0`.toLowerCase()))).toBe(true);
    expect(existsSync(path.join(pluginsDir, `${PLUGIN_ID}@1.1.0`.toLowerCase()))).toBe(false);
    const store = new PluginStore(core.services.mainDb!);
    expect(store.get(PLUGIN_ID)).toMatchObject({ version: '1.0.0', updateTo: null });
  }, 180_000);

  it('撤销与更新：目标版本被撤销 → inspect / update 被拒', async () => {
    const rig = await setup();
    const { core } = rig.stack;
    const v1 = await makeFixture({ version: '1.0.0', fileName: 'rev-v1.kepcup' });
    const v2 = await makeFixture({ version: '1.1.0', fileName: 'rev-v2.kepcup' });
    await publish(rig, T1, [{ fixture: v1 }]);
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-x' } },
    });
    await publish(rig, T2, [{ fixture: v2 }], [
      { id: PLUGIN_ID, version: '1.1.0', action: 'warn' },
    ]);
    await expect(
      core.rpc.call('plugins.inspect', { source: { kind: 'marketplace', id: PLUGIN_ID } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    await expect(
      core.rpc.call('plugins.update', { id: PLUGIN_ID, sha256: v2.sha256, userConfig: {} }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    expect((await pluginsList(rig.stack))[0]).toMatchObject({ version: '1.0.0', revoked: null });
  }, 120_000);

  it('重启恢复：更新进行到一半的磁盘与 DB 状态 → 重启后回到旧版本且可用', async () => {
    const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
    const keystore = createMemoryKeystore();
    const market = new Market();
    const key = makeMarketKey('restart');
    const options = {
      home,
      keystore,
      mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } },
      pluginMarketplace: {
        keys: [key.publicEntry],
        baseUrl: OFFICIAL_BASE,
        fetch: market.fetch as DirectoryFetch,
        initialDelayMs: 3600_000,
      },
    };
    const stack1 = await createTestStack(options);
    // stack1 在用例内自close（同一 home 重启语义）；不进 afterAll 的 stacks 列表，避免二次 close。
    const v1 = await makeFixture({ version: '1.0.0', mcpbVersion: '1.0.0', fileName: 'rs-v1.kepcup' });
    const v2 = await makeFixture({ version: '1.1.0', mcpbVersion: '2.0.0', fileName: 'rs-v2.kepcup' });
    await publishOne(stack1, market, key, T1, v1);
    await stack1.core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: PLUGIN_ID },
      sha256: v1.sha256,
      userConfig: { [MCPB_KEY]: { api_key: 'sk-keep' } },
    });

    // 构造「第 5 步文件已换、第 6 步投影中断」的崩溃现场：v1.1.0 目录已就位、
    // 行的 updateTo 指向它，但投影（server / 技能）还是 v1 的。
    const packager = new PluginPackager({
      pluginsDir: path.join(home, 'plugins'),
      logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => ({}) } as never,
      appVersion: '0.0.0-test',
    });
    const staged = await packager.stage({ kind: 'file', path: v2.path });
    const pluginsDir = path.join(home, 'plugins');
    const newDir = path.join(pluginsDir, `${PLUGIN_ID}@1.1.0`.toLowerCase());
    await rename(staged.stagingDir, newDir);
    // 快照形状 = { [kind]: projector.beginUpdate() 的字符串 }；mcp 的字符串是 {servers}。
    const pluginServers = stack1.core.services.domain!.settings
      .get()
      .mcpServers.filter((server) => server.source?.kind === 'plugin');
    new PluginStore(stack1.core.services.mainDb!).update(PLUGIN_ID, {
      updateTo: '1.1.0',
      updateSnapshot: JSON.stringify({
        mcp: JSON.stringify({ servers: pluginServers }),
      }),
    });
    await stack1.core.close();

    const stack2 = await createTestStack(options);
    stacks.push(stack2);
    const summary = (await pluginsList(stack2))[0]!;
    expect(summary).toMatchObject({ version: '1.0.0', state: 'installed' });
    expect(existsSync(newDir)).toBe(false); // 新目录被清理
    const store2 = new PluginStore(stack2.core.services.mainDb!);
    expect(store2.get(PLUGIN_ID)).toMatchObject({ version: '1.0.0', updateTo: null });
    // 旧版本可用：server 还在、secret 还在、技能还在
    const stdioId = pluginServerId(PLUGIN_ID, MCPB_KEY);
    const server = stack2.core.services.domain!.settings
      .get()
      .mcpServers.find((entry) => entry.id === stdioId)!;
    const result = await stack2.core.services.mcp!.callTool(server as McpServer, 'read_env', {
      name: 'API_KEY',
    });
    expect(result.content).toEqual([{ type: 'text', text: 'env:sk-keep' }]);
    expect(stack2.core.services.skills!.publicSkillRow('plg-alpha')).not.toBeNull();
  }, 180_000);
});

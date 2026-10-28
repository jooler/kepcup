import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { McpServer, PluginInspectOutput, PluginSummary } from '@kepcup/shared';
import { withRemoteSource } from '@kepcup/core';
import {
  buildBuiltinPluginsDir,
  buildPluginDir,
  buildPluginFixture,
  connectorFixtureEntry,
  createTestStack,
  makeBot,
  type TestStack,
} from '@kepcup/testkit';

import { createMemoryKeystore } from '../../src/infra/keystore.js';
import { bindPluginsMethods } from '../../src/rpc/plugins-bindings.js';
import { hashDirectory } from '../../src/skills/library.js';
import { pluginServerId } from '../../src/plugins/ids.js';
import { FakeImapServer, FakeSmtpServer } from '../support/fake-mail-server.js';

/**
 * 插件系统集成（D104 P0a-2 步骤 11）：`plugins.inspect` → `plugins.install` 全管线
 * （技能 / 内嵌 MCPB / 远端 http / 连接器投影）、开发目录安装、sha256 绑定、冲突、
 * 运行时缺失、user_config 必填、启停、卸载级联、PLUGIN_MANAGED 守卫、远程端点拒绝、
 * 重启恢复（activate）。
 */

const PLUGIN_ID = 'io.github.tester/e2e';
const MCPB_KEY = 'dbtools';

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

const root = mkdtempSync(path.join(tmpdir(), 'plugins-integration-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const stacks: TestStack[] = [];

async function setup(
  options: {
    runtimes?: boolean;
    home?: string;
    keystore?: ReturnType<typeof createMemoryKeystore>;
  } = {},
): Promise<TestStack> {
  const stack = await createTestStack({
    ...(options.runtimes === false
      ? {}
      : { mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } } }),
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.keystore !== undefined ? { keystore: options.keystore } : {}),
  });
  stacks.push(stack);
  return stack;
}

interface FixtureOptions {
  id?: string;
  slug?: string;
}

async function makeFileFixture(options: FixtureOptions = {}): Promise<{
  path: string;
  sha256: string;
  size: number;
}> {
  const built = await buildPluginFixture({
    dir: path.join(root, `fx-${Math.random().toString(36).slice(2, 8)}`),
    manifest: { id: options.id ?? PLUGIN_ID },
    skills: [{ name: 'plg-alpha' }, { name: 'plg-beta' }],
    connectors: [{ slug: options.slug ?? 'plgconn' }],
    mcpb: [{ id: MCPB_KEY, mcpb: { manifest: mcpbManifest } }],
    http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
  });
  return { path: built.path, sha256: built.sha256, size: built.size };
}

const installInput = (
  fixture: { path: string; sha256: string },
  userConfig: Record<string, Record<string, string>> = { [MCPB_KEY]: { api_key: 'sk-e2e' } },
) => ({
  source: { kind: 'file', path: fixture.path },
  sha256: fixture.sha256,
  userConfig,
});

function publicSkills(
  core: TestStack['core'],
  botId: string,
): Promise<Array<{ name: string; scope: string }>> {
  return core.rpc
    .call('skills.list', { botId })
    .then((result) =>
      (result as { skills: Array<{ name: string; scope: string }> }).skills.filter(
        (skill) => skill.scope === 'public',
      ),
    );
}

describe('plugins integration (P0a-2)', () => {
  it('完整安装：inspect → install → 技能 / MCP / 连接器全部投影，内嵌 MCPB 可调用', async () => {
    const { core } = await setup();
    const fixture = await makeFileFixture();

    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: fixture.path },
    })) as PluginInspectOutput;
    expect(inspect).toMatchObject({
      id: PLUGIN_ID,
      origin: 'local',
      tier: 'developer',
      installable: true,
      existing: null,
      update: null,
    });
    expect(inspect.packageSha256).toBe(fixture.sha256);
    expect(inspect.skills.map((skill) => skill.name)).toEqual(['plg-alpha', 'plg-beta']);
    expect(inspect.connectors.map((connector) => connector.slug)).toEqual(['plgconn']);
    expect(inspect.mcp).toHaveLength(2);
    const mcpbItem = inspect.mcp.find((item) => item.kind === 'mcpb')!;
    expect(mcpbItem).toMatchObject({ kind: 'mcpb', id: MCPB_KEY, compatible: true });
    expect(inspect.mcp.some((item) => item.kind === 'http' && item.id === 'docs')).toBe(true);

    const installed = (await core.rpc.call('plugins.install', installInput(fixture))) as {
      plugin: PluginSummary;
    };
    const summary = installed.plugin;
    expect(summary).toMatchObject({
      id: PLUGIN_ID,
      state: 'installed',
      enabled: true,
      counts: { skills: 2, connectors: 1, mcp: 2, mail: 0 },
    });

    // 技能：公共作用域
    const bot = await makeBot(core, '小插件');
    expect((await publicSkills(core, bot.id)).map((skill) => skill.name).sort()).toEqual([
      'plg-alpha',
      'plg-beta',
    ]);

    // MCP：两个 plg_ server（内嵌 stdio + 远端 http），本地来源 tier developer
    const servers = core.services.domain!.settings.get().mcpServers;
    expect(servers.filter((server) => server.source?.kind === 'plugin')).toHaveLength(2);
    const stdioId = pluginServerId(PLUGIN_ID, MCPB_KEY);
    const stdio = servers.find((server) => server.id === stdioId)!;
    expect(stdio).toMatchObject({
      transport: 'stdio',
      tier: 'developer',
      source: { kind: 'plugin', pluginId: PLUGIN_ID, key: MCPB_KEY },
      env: { API_KEY: 'secret:env:api_key' },
    });
    expect(servers.find((server) => server.id === pluginServerId(PLUGIN_ID, 'docs'))).toMatchObject(
      {
        transport: 'http',
        url: 'https://mcp.docs.test/mcp',
        auth: 'none',
        tier: 'developer',
      },
    );

    // 连接器：目录里出现，origin plugin、tier developer、带来源插件 id（P0a-3 徽标用）
    const catalog = (await core.rpc.call('apps.catalog.list', undefined)) as {
      entries: Array<{ connectorId: string; origin?: string; tier: string; pluginId?: string }>;
    };
    const entry = catalog.entries.find((item) => item.connectorId === 'plgconn')!;
    expect(entry).toMatchObject({
      origin: 'plugin',
      tier: 'developer',
      pluginId: PLUGIN_ID,
    });

    // plugins.list 计数与账本对上
    const list = (await core.rpc.call('plugins.list', undefined)) as { plugins: PluginSummary[] };
    expect(list.plugins).toHaveLength(1);
    expect(list.plugins[0]).toMatchObject({ id: PLUGIN_ID, counts: summary.counts });
    expect(list.plugins[0]!.items).toHaveLength(5);

    // 内嵌 MCPB 真正被 McpService 启动并调用
    const mcp = core.services.mcp!;
    const tools = await mcp.listTools(stdio as McpServer);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['argv', 'echo', 'read_env']);
    const echo = await mcp.callTool(stdio as McpServer, 'echo', { text: 'hi' });
    expect(echo.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    const secret = await mcp.callTool(stdio as McpServer, 'read_env', { name: 'API_KEY' });
    expect(secret.content).toEqual([{ type: 'text', text: 'env:sk-e2e' }]);
  }, 90_000);

  it.skipIf(process.platform === 'win32')(
    '开发目录安装：除 packageSha256 外结果与 .kepcup 一致',
    async () => {
      const fileStack = await setup();
      const dirStack = await setup();
      const fxDir = path.join(root, `dirfx-${Math.random().toString(36).slice(2, 8)}`);
      await buildPluginDir({
        dir: fxDir,
        manifest: { id: PLUGIN_ID },
        skills: [{ name: 'plg-alpha' }, { name: 'plg-beta' }],
        connectors: [{ slug: 'plgconn' }],
        mcpb: [{ id: MCPB_KEY, mcpb: { manifest: mcpbManifest } }],
        http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
      });
      const dirInspect = (await dirStack.core.rpc.call('plugins.inspect', {
        source: { kind: 'folder', path: fxDir },
      })) as PluginInspectOutput;
      expect(dirInspect.installable).toBe(true);

      const fileFixture = await makeFileFixture();
      const fileInspect = (await fileStack.core.rpc.call('plugins.inspect', {
        source: { kind: 'file', path: fileFixture.path },
      })) as PluginInspectOutput;
      const fromFile = (await fileStack.core.rpc.call(
        'plugins.install',
        installInput(fileFixture),
      )) as {
        plugin: PluginSummary;
      };
      const fromDir = (await dirStack.core.rpc.call('plugins.install', {
        source: { kind: 'folder', path: fxDir },
        sha256: dirInspect.packageSha256,
        userConfig: { [MCPB_KEY]: { api_key: 'sk-e2e' } },
      })) as { plugin: PluginSummary };
      expect(fromDir.plugin).toMatchObject({
        id: PLUGIN_ID,
        origin: 'local',
        tier: 'developer',
        state: 'installed',
        counts: fromFile.plugin.counts,
      });
      // sha 绑定不同（文件 sha256 vs 目录树哈希），其余一致
      expect(fileInspect.packageSha256).not.toBe(dirInspect.packageSha256);
      expect(fromDir.plugin.items.map((item) => [item.kind, item.ref]).sort()).toEqual(
        fromFile.plugin.items.map((item) => [item.kind, item.ref]).sort(),
      );
    },
    90_000,
  );

  it('sha256 不符 → PLUGIN_INVALID，无任何残留', async () => {
    const { core } = await setup();
    const fixture = await makeFileFixture();
    await expect(
      core.rpc.call('plugins.install', { ...installInput(fixture), sha256: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    expect(core.services.domain!.settings.get().mcpServers).toHaveLength(0);
    expect(
      (await core.rpc.call('plugins.list', undefined)) as { plugins: unknown[] },
    ).toMatchObject({
      plugins: [],
    });
    expect(
      existsSync(path.join(core.services.paths.pluginsDir, 'io.github.tester', 'e2e@1.0.0')),
    ).toBe(false);
  });

  it('冲突：同名公共技能 / 同 slug 连接器 → PLUGIN_CONFLICT 且无残留', async () => {
    const { core } = await setup();
    // 预装一个同名公共技能（预置来源）
    const preDir = path.join(root, `pre-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(path.join(preDir, 'plg-alpha'), { recursive: true });
    writeFileSync(
      path.join(preDir, 'plg-alpha', 'SKILL.md'),
      '---\nname: plg-alpha\ndescription: 预装\n---\n预装内容',
    );
    core.services.skills!.installPublic({
      name: 'plg-alpha',
      scan: {
        compatibility: 'compatible',
        compatibilityReasons: [],
        runtimeDeps: [],
        sandboxDeclaration: null,
        files: [],
      } as never,
      sourceUrl: 'preset://plg-alpha',
      commitOid: '9.9.9',
      contentHash: hashDirectory(path.join(preDir, 'plg-alpha')),
      stagingDir: path.join(preDir, 'plg-alpha'),
    });
    const fixture = await makeFileFixture();
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: fixture.path },
    })) as PluginInspectOutput;
    expect(
      inspect.conflicts.some(
        (conflict) => conflict.kind === 'skill' && conflict.ref === 'plg-alpha',
      ),
    ).toBe(true);
    await expect(core.rpc.call('plugins.install', installInput(fixture))).rejects.toMatchObject({
      code: 'PLUGIN_CONFLICT',
    });
    expect(core.services.domain!.settings.get().mcpServers).toHaveLength(0);

    // 让位之后（这里直接移除预装技能）插件 A 可正常安装；再装同 slug 的插件 B → 连接器冲突
    core.services.skills!.uninstallPublic('plg-alpha');
    const installedA = (await core.rpc.call('plugins.install', {
      ...installInput(fixture),
      userConfig: { [MCPB_KEY]: { api_key: 'sk-a' } },
    })) as { plugin: PluginSummary };
    expect(installedA.plugin.id).toBe(PLUGIN_ID);
    const fixtureB = await makeFileFixture({ id: 'io.github.tester/other' });
    const inspectB = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: fixtureB.path },
    })) as PluginInspectOutput;
    expect(
      inspectB.conflicts.some(
        (conflict) => conflict.kind === 'connector' && conflict.ref === 'plgconn',
      ),
    ).toBe(true);
    await expect(
      core.rpc.call('plugins.install', {
        ...installInput(fixtureB),
        source: { kind: 'file', path: fixtureB.path },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' });
  }, 90_000);

  it('收编：插件系统上线前装的预置同名公共技能 → 守卫放行单项卸载；安装不冲突并接管（账本 + 守卫 + 卸载级联）', async () => {
    const { core } = await setup();
    const skills = core.services.skills!;
    // 两条 0054 迁移后的预置公共技能：来源指向从不进账本的内置插件 id
    const installPreset = (name: string): void => {
      const dir = path.join(root, `pre-${Math.random().toString(36).slice(2, 8)}`, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: 预置\n---\n旧版预置`,
      );
      skills.installPublic({
        name,
        scan: {
          compatibility: 'compatible',
          compatibilityReasons: [],
          runtimeDeps: [],
          sandboxDeclaration: null,
          files: [],
        } as never,
        sourceUrl: `plugin://com.kepcup/starter-skills/${name}`,
        commitOid: '0.9.0',
        contentHash: hashDirectory(dir),
        stagingDir: dir,
      });
    };
    installPreset('plg-alpha');
    installPreset('plg-beta');
    const bot = await makeBot(core, '小收编');

    // 孤儿预置不在任何账本里：技能面板的单项卸载由守卫放行
    await core.rpc.call('skills.uninstall', { botId: bot.id, name: 'plg-beta' });
    expect(skills.publicSkillRow('plg-beta')).toBeNull();

    // 剩下的 plg-alpha 由插件接管，而不是报同名冲突
    const fixture = await makeFileFixture();
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: fixture.path },
    })) as PluginInspectOutput;
    expect(inspect.conflicts.filter((conflict) => conflict.kind === 'skill')).toEqual([]);
    await core.rpc.call('plugins.install', installInput(fixture));
    expect(core.services.plugins!.ownerOf('skill', 'plg-alpha')).toBe(PLUGIN_ID);
    expect(skills.libraryGet(skills.publicSkillRow('plg-alpha')!.library_id)!.source_url).toBe(
      `plugin://${PLUGIN_ID}/plg-alpha`,
    );
    // 接管后归插件管：单项卸载改为被守卫拒绝
    await expect(
      core.rpc.call('skills.uninstall', { botId: bot.id, name: 'plg-alpha' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MANAGED' });
    // 卸载插件：接管来的技能一并删除（来源标记已是插件的，不会被跳过而留下孤儿）
    await core.rpc.call('plugins.uninstall', { id: PLUGIN_ID });
    expect(await publicSkills(core, bot.id)).toEqual([]);
  }, 90_000);

  it('运行时缺失 → inspect blocker + install PLUGIN_INCOMPATIBLE', async () => {
    const { core } = await setup({ runtimes: false });
    const fixture = await makeFileFixture();
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'file', path: fixture.path },
    })) as PluginInspectOutput;
    expect(inspect.blockers.some((line) => line.includes('运行时'))).toBe(true);
    await expect(core.rpc.call('plugins.install', installInput(fixture))).rejects.toMatchObject({
      code: 'PLUGIN_INCOMPATIBLE',
    });
    expect(core.services.domain!.settings.get().mcpServers).toHaveLength(0);
  });

  it('user_config 必填缺失 → 安装报错且无目录 / 行残留', async () => {
    const { core } = await setup();
    const fixture = await makeFileFixture();
    await expect(
      core.rpc.call('plugins.install', { ...installInput(fixture), userConfig: {} }),
    ).rejects.toMatchObject({ code: 'MCPB_INVALID' });
    expect(
      (await core.rpc.call('plugins.list', undefined)) as { plugins: unknown[] },
    ).toMatchObject({ plugins: [] });
    expect(
      existsSync(path.join(core.services.paths.pluginsDir, 'io.github.tester', 'e2e@1.0.0')),
    ).toBe(false);
  });

  it('启停：技能摘除 / server 停用 / 连接器隐藏，恢复后全部回来', async () => {
    const { core } = await setup();
    const fixture = await makeFileFixture();
    await core.rpc.call('plugins.install', installInput(fixture));
    const bot = await makeBot(core, '小启停');
    const id = PLUGIN_ID;

    await core.rpc.call('plugins.setEnabled', { id, enabled: false });
    expect(await publicSkills(core, bot.id)).toEqual([]);
    const servers = core.services.domain!.settings.get().mcpServers;
    expect(servers.filter((server) => server.source?.kind === 'plugin')).toHaveLength(2);
    expect(
      servers
        .filter((server) => server.source?.kind === 'plugin')
        .every((server) => server.enabled === false),
    ).toBe(true);
    const catalogAfterOff = (await core.rpc.call('apps.catalog.list', undefined)) as {
      entries: Array<{ connectorId: string }>;
    };
    expect(catalogAfterOff.entries.some((item) => item.connectorId === 'plgconn')).toBe(false);
    expect(
      ((await core.rpc.call('plugins.list', undefined)) as { plugins: PluginSummary[] }).plugins[0],
    ).toMatchObject({
      enabled: false,
      counts: { skills: 2, connectors: 1, mcp: 2, mail: 0 },
    });

    await core.rpc.call('plugins.setEnabled', { id, enabled: true });
    expect((await publicSkills(core, bot.id)).map((skill) => skill.name).sort()).toEqual([
      'plg-alpha',
      'plg-beta',
    ]);
    expect(
      core.services
        .domain!.settings.get()
        .mcpServers.filter((server) => server.source?.kind === 'plugin')
        .every((server) => server.enabled === true),
    ).toBe(true);
    const catalogAfterOn = (await core.rpc.call('apps.catalog.list', undefined)) as {
      entries: Array<{ connectorId: string }>;
    };
    expect(catalogAfterOn.entries.some((item) => item.connectorId === 'plgconn')).toBe(true);
  }, 90_000);

  it('卸载级联：技能 / server / secrets / 连接行 / 解包树 / 目录 / 账本全清', async () => {
    const { core } = await setup();
    const fixture = await makeFileFixture();
    await core.rpc.call('plugins.install', installInput(fixture));
    const stdioId = pluginServerId(PLUGIN_ID, MCPB_KEY);
    const unpacked = path.join(core.services.paths.toolchainsDir, 'mcpb', 'echo-bundle@1.0.0');
    expect(existsSync(unpacked)).toBe(true);
    expect(core.services.domain!.secrets.getValue(`mcp:${stdioId}:env:api_key`)).toBe('sk-e2e');

    // 连接行：直接经 AppConnectionStore 造一行（连接器目录型语义：插件不代连，这里只验证级联删）
    const connection = core.services.apps!.store.create({
      connectorId: 'plgconn',
      label: '级联用连接',
    });
    expect(core.services.apps!.store.listByConnector('plgconn')).toHaveLength(1);

    await core.rpc.call('plugins.uninstall', { id: PLUGIN_ID });
    const bot = await makeBot(core, '小卸载');
    expect(await publicSkills(core, bot.id)).toEqual([]);
    expect(
      core.services
        .domain!.settings.get()
        .mcpServers.filter((server) => server.source?.kind === 'plugin'),
    ).toHaveLength(0);
    expect(core.services.domain!.secrets.getValue(`mcp:${stdioId}:env:api_key`)).toBeNull();
    expect(core.services.apps!.store.get(connection.id)).toBeNull();
    expect(existsSync(unpacked)).toBe(false);
    expect(
      existsSync(path.join(core.services.paths.pluginsDir, 'io.github.tester', 'e2e@1.0.0')),
    ).toBe(false);
    expect(core.services.plugins!.ownerOf('skill', 'plg-alpha')).toBeNull();
    expect(core.services.plugins!.ownerOf('mcp', stdioId)).toBeNull();
    expect(
      (await core.rpc.call('plugins.list', undefined)) as { plugins: unknown[] },
    ).toMatchObject({ plugins: [] });
  }, 90_000);

  it('守卫：插件管理项单项删除被拒，非管理操作放行', async () => {
    const { core } = await setup();
    const fixture = await makeFileFixture();
    await core.rpc.call('plugins.install', installInput(fixture));
    const stdioId = pluginServerId(PLUGIN_ID, MCPB_KEY);
    const httpId = pluginServerId(PLUGIN_ID, 'docs');

    // mcp.removeServer → PLUGIN_MANAGED
    await expect(core.rpc.call('mcp.removeServer', { serverId: stdioId })).rejects.toMatchObject({
      code: 'PLUGIN_MANAGED',
    });

    // settings.update：删除 / 改 url → PLUGIN_MANAGED；改 enabled / toolPolicies → 放行
    const servers = () => core.services.domain!.settings.get().mcpServers;
    await expect(
      core.rpc.call('settings.update', {
        mcpServers: servers().filter((server) => server.id !== stdioId),
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MANAGED' });
    await expect(
      core.rpc.call('settings.update', {
        mcpServers: servers().map((server) =>
          server.id === httpId ? { ...server, url: 'https://evil.example.com/mcp' } : server,
        ),
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MANAGED' });
    await expect(
      core.rpc.call('settings.update', {
        mcpServers: servers().map((server) =>
          server.id === httpId
            ? { ...server, enabled: false, toolPolicies: { read: { approval: 'ask' } } }
            : server,
        ),
      }),
    ).resolves.toBeDefined();

    // skills.uninstall 对插件技能 → PLUGIN_MANAGED
    const bot = await makeBot(core, '小守卫');
    await expect(
      core.rpc.call('skills.uninstall', { botId: bot.id, name: 'plg-alpha' }),
    ).rejects.toMatchObject({
      code: 'PLUGIN_MANAGED',
    });

    // Bot 自己装的同名私有技能仍可卸载（私有行走既有路径，不经守卫）
    const pluginDir = path.join(core.services.paths.pluginsDir, 'io.github.tester', 'e2e@1.0.0');
    const privateSkillDir = path.join(pluginDir, 'skills', 'plg-alpha');
    core.services.skills!.installImported({
      botId: bot.id,
      conversationId: 'conv_priv',
      name: 'plg-alpha',
      scan: {
        compatibility: 'compatible',
        compatibilityReasons: [],
        runtimeDeps: [],
        sandboxDeclaration: null,
        files: [],
      } as never,
      sourceUrl: 'git+https://example.com/plg-alpha.git',
      commitOid: '1.0.0',
      contentHash: hashDirectory(privateSkillDir),
      stagingDir: privateSkillDir,
      reuseExisting: true,
    });
    const afterPrivate = await core.rpc.call('skills.uninstall', {
      botId: bot.id,
      name: 'plg-alpha',
    });
    expect(afterPrivate).toBeDefined();
    // 公共版本还在（私有卸载不影响）
    expect((await publicSkills(core, bot.id)).map((skill) => skill.name)).toContain('plg-alpha');
  }, 90_000);

  it('远程端点：plugins.inspect 的 file 来源被拒（INVALID_INPUT）', async () => {
    const { core } = await setup();
    const fixture = await makeFileFixture();
    // The RemoteHub wraps every spec.handle in withRemoteSource (remote/hub.ts)；本地
    // rpc.call 经 MessagePort，AsyncLocalStorage 不跨端口，所以这里直接按 hub 的方式
    // 调用绑定的 handler 验证 assertLocalSource。
    const methods = bindPluginsMethods(core.services);
    const inspect = methods['plugins.inspect']!;
    await expect(
      withRemoteSource('dev_x' as never, () =>
        inspect.handle({ source: { kind: 'file', path: fixture.path } }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 同一来源在本地端点上正常
    const local = (await inspect.handle({
      source: { kind: 'file', path: fixture.path },
    })) as PluginInspectOutput;
    expect(local.installable).toBe(true);
  });

  it('重启恢复：同一 home 重启后插件连接器仍在目录、技能与 server 仍在', async () => {
    const keystore = createMemoryKeystore();
    const home = path.join(root, `home-restart-${Math.random().toString(36).slice(2, 8)}`);
    const first = await setup({ home, keystore });
    const fixture = await makeFileFixture();
    await first.core.rpc.call('plugins.install', installInput(fixture));
    await first.cleanup();

    const second = await setup({ home, keystore });
    const list = (await second.core.rpc.call('plugins.list', undefined)) as {
      plugins: PluginSummary[];
    };
    expect(list.plugins).toHaveLength(1);
    expect(list.plugins[0]).toMatchObject({ id: PLUGIN_ID, state: 'installed', enabled: true });
    const catalog = (await second.core.rpc.call('apps.catalog.list', undefined)) as {
      entries: Array<{ connectorId: string; origin?: string }>;
    };
    expect(catalog.entries.find((item) => item.connectorId === 'plgconn')).toMatchObject({
      origin: 'plugin',
    });
    expect(
      second.core.services
        .domain!.settings.get()
        .mcpServers.filter((server) => server.source?.kind === 'plugin'),
    ).toHaveLength(2);
    const bot = await makeBot(second.core, '小重启');
    expect((await publicSkills(second.core, bot.id)).map((skill) => skill.name).sort()).toEqual([
      'plg-alpha',
      'plg-beta',
    ]);
  }, 90_000);

  it('内置插件（D104 P0b）：plugins.list 含只读内置条目，启停 / 卸载被拒绝', async () => {
    const builtinDir = await buildBuiltinPluginsDir({
      dir: path.join(root, `builtin-${Math.random().toString(36).slice(2, 8)}`),
      skills: [{ id: 'demo', displayName: '演示', summary: '内置技能', section: 'starter' }],
      connectors: [connectorFixtureEntry('demoapp', { url: 'https://mcp.demoapp.test/mcp' })],
    });
    const stack = await createTestStack({
      env: { KEPCUP_BUILTIN_PLUGINS: builtinDir },
      mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } },
    });
    stacks.push(stack);
    const core = stack.core;

    const list = (await core.rpc.call('plugins.list', undefined)) as { plugins: PluginSummary[] };
    const builtin = list.plugins.filter((plugin) => plugin.origin === 'builtin');
    expect(builtin.map((plugin) => plugin.id).sort()).toEqual([
      'com.kepcup/connections',
      'com.kepcup/starter-skills',
    ]);
    const connections = builtin.find((plugin) => plugin.id === 'com.kepcup/connections')!;
    expect(connections).toMatchObject({
      tier: 'builtin',
      state: 'installed',
      enabled: true,
      dirPath: null,
      installedAt: null,
      counts: { connectors: 1, skills: 0, mcp: 0, mail: 0 },
    });
    // 内置连接器条目进目录（内置来源条目在商店化后归入 plugin origin 语义）。
    const catalog = (await core.rpc.call('apps.catalog.list', undefined)) as {
      entries: Array<{ connectorId: string; origin?: string }>;
    };
    expect(catalog.entries.find((item) => item.connectorId === 'demoapp')).toMatchObject({
      origin: 'plugin',
    });

    for (const method of ['plugins.setEnabled', 'plugins.uninstall']) {
      await expect(
        core.rpc.call(
          method,
          method === 'plugins.setEnabled'
            ? { id: 'com.kepcup/connections', enabled: false }
            : { id: 'com.kepcup/connections' },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        core.rpc.call(
          method,
          method === 'plugins.setEnabled'
            ? { id: 'com.kepcup/starter-skills', enabled: false }
            : { id: 'com.kepcup/starter-skills' },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    // 内置插件始终在列（未受拒绝的启停 / 卸载影响）。
    const after = (await core.rpc.call('plugins.list', undefined)) as { plugins: PluginSummary[] };
    expect(after.plugins.filter((plugin) => plugin.origin === 'builtin')).toHaveLength(2);
  }, 90_000);

  it('邮件插件化（P3）：实例建号落地账号、贡献锁端点、全局 60 秒下限生效、卸载级联删号', async () => {
    const imap = new FakeImapServer();
    const smtp = new FakeSmtpServer();
    await imap.start();
    await smtp.start();
    const previous = process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
    process.env.KEPCUP_MAIL_ALLOW_PRIVATE = '1';
    try {
      const { core } = await setup();
      const mailId = 'fastmail';
      const built = await buildPluginFixture({
        dir: path.join(root, `fx-mail-${Math.random().toString(36).slice(2, 8)}`),
        manifest: {
          id: 'io.github.tester/mailplug',
          name: 'Mail Plug',
          instances: ['mail'],
          contributions: {
            skills: [],
            connectors: [],
            mcp: [],
            mail: [
              {
                id: mailId,
                label: 'Fast Mail',
                // 厂商贡献：端点锁定（host 非空），不出表单。
                imap: { host: '127.0.0.1', port: imap.port, secure: 'ssl' },
                smtp: { host: '127.0.0.1', port: smtp.port, secure: 'ssl' },
                defaultMode: 'poll_only',
                defaultPollSec: 120,
                minPollSec: 90,
                helpUrl: 'https://help.example.com/fastmail',
              },
            ],
          },
        },
      });

      // 安装前：实例创建不可用。
      await expect(
        core.rpc.call('plugins.instances.create', {
          pluginId: 'io.github.tester/mailplug',
          values: {},
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await core.rpc.call('plugins.install', {
        source: { kind: 'file', path: built.path },
        sha256: built.sha256,
        userConfig: {},
      });

      // 清单摘要携带实例声明与实例表单字段（内置 address/username/password，厂商端点不出现）。
      const listed = (await core.rpc.call('plugins.list', undefined)) as {
        plugins: Array<Record<string, unknown>>;
      };
      const plugin = listed.plugins.find((row) => row.id === 'io.github.tester/mailplug')!;
      expect(plugin.providesInstances).toEqual(['mail']);
      expect(plugin.instanceFields).toMatchObject([
        { key: 'address', required: true },
        { key: 'username', required: false },
        { key: 'password', required: true, sensitive: true },
      ]);
      expect(plugin.instanceCounts).toEqual({ mail: 0, mcp: 0 });

      // 厂商贡献锁定端点：实例值里根本不收端点字段（未声明即拒绝）；30 秒意图无从
      // 传入，轮询取贡献缺省 120（贡献下限 90 / 全局 60 秒夹取）。
      const { instance } = (await core.rpc.call('plugins.instances.create', {
        pluginId: 'io.github.tester/mailplug',
        values: {
          address: 'bot@example.com',
          password: 'authcode',
        },
      })) as { instance: { id: string; title: string } };
      expect(instance.title).toBe('bot@example.com');
      await expect(
        core.rpc.call('plugins.instances.create', {
          pluginId: 'io.github.tester/mailplug',
          values: {
            address: 'other@example.com',
            password: 'authcode',
            imapHost: 'evil.example.com',
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      const accounts = (await core.rpc.call('mail.accounts.list', undefined)) as {
        accounts: Array<Record<string, unknown>>;
      };
      expect(accounts.accounts).toHaveLength(1);
      expect(accounts.accounts[0]).toMatchObject({
        provider: 'custom',
        instanceId: instance.id,
        pluginId: 'io.github.tester/mailplug',
        pluginName: 'Mail Plug',
        imapHost: '127.0.0.1',
        imapPort: imap.port,
        imapSecure: 'ssl',
        smtpHost: '127.0.0.1',
        smtpPort: smtp.port,
        smtpSecure: 'ssl',
        mode: 'poll_only',
        pollIntervalSec: 120,
      });

      // 卡片计数按 mail_accounts 活跃账号统计。
      const afterCreate = (await core.rpc.call('plugins.list', undefined)) as {
        plugins: Array<Record<string, unknown>>;
      };
      expect(
        afterCreate.plugins.find((row) => row.id === 'io.github.tester/mailplug')!.instanceCounts,
      ).toEqual({ mail: 1, mcp: 0 });

      // 实例账号不能从全局视图直删（防悬空实例行），只能走实例路径级联。
      const accountId = (accounts.accounts[0] as { id: string }).id;
      await expect(
        core.rpc.call('mail.accounts.delete', { id: accountId }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      // 卸载插件 → 实例级联删账号（绑定、secret、会话一并清）。
      await core.rpc.call('plugins.uninstall', { id: 'io.github.tester/mailplug' });
      expect(((await core.rpc.call('mail.accounts.list', undefined)) as { accounts: unknown[] }).accounts).toEqual([]);
      const instancesAfter = (await core.rpc.call('plugins.instances.list', {
        pluginId: 'io.github.tester/mailplug',
      })) as { instances: unknown[] };
      expect(instancesAfter.instances).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
      else process.env.KEPCUP_MAIL_ALLOW_PRIVATE = previous;
      await imap.stop();
      await smtp.stop();
    }
  }, 90_000);
});

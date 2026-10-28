import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { connectorMetaOf, type McpServer, type PluginSummary } from '@kepcup/shared';
import {
  buildPluginFixture,
  createTestStack,
  makeBot,
  makeProject,
  openDirect,
  sendDrafts,
  step,
  waitForEvent,
  waitForRun,
  type MockLlmServer,
  type TestStack,
} from '@kepcup/testkit';

import { effectivePluginIds } from '../../src/plugins/effective.js';
import { pluginServerId } from '../../src/plugins/ids.js';
import { buildCapabilityCatalog } from '../../src/capabilities/catalog.js';
import { parseSkillDir } from '../../src/skills/parse.js';
import { scanSkillDir } from '../../src/skills/scan.js';
import { hashDirectory } from '../../src/skills/library.js';
import { serversForBot as serversForBotPure } from '../../src/mcp/service.js';

/**
 * P2 注入模型集成（todo/plugin-platform/P2-injection.md §3）：五处装配点按
 * 「有效启用集 = bot.plugin_ids ∪（项目会话 ? project_plugins : ∅）」做**可见性**
 * 过滤；未启用的插件能力（技能 / MCP server / 连接器）对该 Bot 不可见；
 * 无启用集（缺省调用）与现状完全一致是回归红线；审批 / 风险 / 锁定语义不动。
 */

const SKILL_PLUGIN = 'io.github.tester/inject-skill';
const MCP_PLUGIN = 'io.github.tester/inject-mcp';
const CONN_PLUGIN = 'io.github.tester/inject-conn';
const SKILL_NAME = 'injected-demo';

const root = mkdtempSync(path.join(tmpdir(), 'plugins-injection-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const stacks: TestStack[] = [];

async function setup(): Promise<TestStack> {
  const stack = await createTestStack({});
  stacks.push(stack);
  return stack;
}

let fxCounter = 0;

async function installPlugin(
  core: TestStack['core'],
  build: (dir: string) => ReturnType<typeof buildPluginFixture>,
): Promise<string> {
  const built = await build(path.join(root, `fx-${(fxCounter += 1)}`));
  const result = (await core.rpc.call('plugins.install', {
    source: { kind: 'file', path: built.path },
    sha256: built.sha256,
    userConfig: {},
  })) as { plugin: PluginSummary };
  return result.plugin.id;
}

/** 该 Bot 一次会话的有效启用集（与 orchestrator #effectivePlugins 同一套计算）。 */
function effectiveOf(core: TestStack['core'], botId: string, conversationId?: string): Set<string> {
  const bot = core.services.domain!.bots.get(botId)!;
  const overlay =
    conversationId !== undefined
      ? (core.services.domain!.projects.pluginsOf(conversationId) ?? [])
      : [];
  return effectivePluginIds(bot.profile, overlay);
}

/** system prompt of the requests whose rendered messages contain the marker text. */
function systemPromptsOf(llm: MockLlmServer, marker: string): string[] {
  return llm
    .requests()
    .filter((req) => JSON.stringify(req.body.messages ?? []).includes(marker))
    .map((req) => {
      const first = req.body.messages?.[0];
      return typeof first?.content === 'string' ? first.content : '';
    });
}

describe('plugin injection model (P2)', () => {
  it(
    'skills：未启用 <skills> 不含插件技能；setBotPlugins 启用后含、停用后消失；readableDirs 同步；缺省调用维持现状',
    async () => {
      const { core } = await setup();
      const skills = core.services.skills!;
      const pluginId = await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: SKILL_PLUGIN },
          skills: [{ name: SKILL_NAME, description: '插件注入技能' }],
        }),
      );
      expect(pluginId).toBe(SKILL_PLUGIN);
      const bot = await makeBot(core, '技能 Bot');

      // 未启用（有效启用集为空）：提示词段与沙箱目录都不可见。
      const none = effectiveOf(core, bot.id);
      expect(none).toEqual(new Set());
      expect(skills.promptSection(bot.id, none)).not.toContain(SKILL_NAME);
      expect(skills.readableDirs(bot.id, none).join('\n')).not.toContain(SKILL_NAME);

      // 缺省调用（管理面板 / 旧调用点）与现状一致：不过滤。
      expect(skills.promptSection(bot.id)).toContain(SKILL_NAME);
      expect(skills.readableDirs(bot.id).join('\n')).toContain(SKILL_NAME);

      // 启用：bot.updated + plugins.changed 广播；profile 只改 plugin_ids。
      const botEvent = waitForEvent(core, 'bot.updated', () => true);
      const pluginEvent = waitForEvent(
        core,
        'plugins.changed',
        (payload: { ids: string[] }) => payload.ids.includes(SKILL_PLUGIN),
      );
      await core.rpc.call('plugins.setBotPlugins', { botId: bot.id, pluginIds: [SKILL_PLUGIN] });
      await botEvent;
      await pluginEvent;
      const enabled = core.services.domain!.bots.get(bot.id)!;
      expect(enabled.profile.runtime.plugin_ids).toEqual([SKILL_PLUGIN]);

      const set = effectiveOf(core, bot.id);
      expect(skills.promptSection(bot.id, set)).toContain(SKILL_NAME);
      const dirs = skills.readableDirs(bot.id, set);
      expect(dirs.join('\n')).toContain(SKILL_NAME);

      // 停用（整体替换为空）：ids = 新旧并集（旧 id 也要刷新）。
      const offEvent = waitForEvent(
        core,
        'plugins.changed',
        (payload: { ids: string[] }) => payload.ids.includes(SKILL_PLUGIN),
      );
      await core.rpc.call('plugins.setBotPlugins', { botId: bot.id, pluginIds: [] });
      await offEvent;
      expect(skills.promptSection(bot.id, effectiveOf(core, bot.id))).not.toContain(SKILL_NAME);
      expect(skills.readableDirs(bot.id, effectiveOf(core, bot.id)).join('\n')).not.toContain(
        SKILL_NAME,
      );
    },
    90_000,
  );

  it(
    'skills：Bot 私有同名技能不受插件过滤影响（遮蔽公共行照旧）',
    async () => {
      const { core } = await setup();
      const skills = core.services.skills!;
      await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: SKILL_PLUGIN },
          skills: [{ name: SKILL_NAME, description: '插件注入技能' }],
        }),
      );
      const bot = await makeBot(core, '私有技能 Bot');

      // 私有导入同名技能（git import 管线的领域直调：parse → scan → hash → installImported）。
      const stagingDir = path.join(root, `staging-${(fxCounter += 1)}`, SKILL_NAME);
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(
        path.join(stagingDir, 'SKILL.md'),
        `---\nname: ${SKILL_NAME}\ndescription: 私有版本的描述\n---\n正文`,
      );
      const parsed = parseSkillDir(stagingDir);
      skills.installImported({
        botId: bot.id,
        conversationId: 'conv_direct',
        name: SKILL_NAME,
        scan: scanSkillDir(stagingDir, parsed),
        sourceUrl: `https://example.com/${SKILL_NAME}.git`,
        commitOid: '0123456789abcdef0123456789abcdef01234567',
        contentHash: hashDirectory(stagingDir),
        stagingDir,
        reuseExisting: false,
      });

      // 未启用任何插件：私有行照常进 <skills> / readableDirs（公共插件行被遮蔽）。
      const none = effectiveOf(core, bot.id);
      expect(skills.promptSection(bot.id, none)).toContain(SKILL_NAME);
      expect(skills.promptSection(bot.id, none)).toContain('私有版本的描述');
      expect(skills.readableDirs(bot.id, none).join('\n')).toContain(SKILL_NAME);
    },
    90_000,
  );

  it(
    'mcp：插件 server 按启用集判定（不要求勾选）；手动 server 的 mcp_server_ids 语义不变；缺省行为一致',
    async () => {
      const { core } = await setup();
      const mcp = core.services.mcp!;
      const pluginId = await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: MCP_PLUGIN },
          http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
        }),
      );
      expect(pluginId).toBe(MCP_PLUGIN);
      const pluginServerIdOf = pluginServerId(MCP_PLUGIN, 'docs');
      const settings = core.services.domain!.settings;
      const manual: McpServer = {
        id: 'manual-1',
        name: '手动 server',
        transport: 'http',
        url: 'https://manual.test/mcp',
        enabled: true,
        autoApprove: false,
        auth: 'none',
      };
      // 整体替换 settings（写锁内的领域直调，与设置页保存同一路径）。
      settings.update({ mcpServers: [...settings.get().mcpServers, manual] });
      const servers = () => settings.get().mcpServers;

      // 缺省（无启用集）：现状语义——selectedIds 交集，未勾选的插件 server 不暴露。
      expect(mcp.serversForBot([manual.id])).toEqual([manual]);
      expect(serversForBotPure(servers(), [manual.id])).toEqual([manual]);
      expect(mcp.serversForBot([])).toEqual([]);

      // 启用集为空：插件 server 不可见；手动 server 仍按勾选。
      expect(
        mcp.serversForBot([manual.id], new Set()).map((server) => server.id),
      ).toEqual([manual.id]);

      // 启用插件：不勾 mcp_server_ids 也可见；手动 server 未勾仍不可见。
      const enabled = new Set([MCP_PLUGIN]);
      expect(
        mcp.serversForBot([], enabled).map((server) => server.id),
      ).toEqual([pluginServerIdOf]);
      expect(
        mcp.serversForBot([manual.id], enabled).map((server) => server.id).sort(),
      ).toEqual([manual.id, pluginServerIdOf].sort());

      // mcp_server_ids 里插件 server 的历史勾选读时忽略（判定只看启用集）。
      expect(
        mcp.serversForBot([pluginServerIdOf], new Set()).map((server) => server.id),
      ).toEqual([]);

      // 能力目录同源：buildCapabilityCatalog（orchestrator 的同一入口）。
      const catalog = buildCapabilityCatalog({
        connectedApps: core.services.connectedApps,
        mcp,
        appConnectionIds: [],
        mcpServerIds: [pluginServerIdOf],
        extraPluginIds: new Set(),
      });
      expect(catalog.entries.map((entry) => entry.id)).toEqual([]);
      const catalogOn = buildCapabilityCatalog({
        connectedApps: core.services.connectedApps,
        mcp,
        appConnectionIds: [],
        mcpServerIds: [],
        extraPluginIds: new Set([MCP_PLUGIN]),
      });
      expect(catalogOn.entries.map((entry) => entry.id)).toEqual([`mcp:${pluginServerIdOf}`]);
      expect(catalogOn.entries[0]).toMatchObject({ status: 'ready' });

      // 审批语义对照：过滤不改 server 行本身，也不改风险缺省（destructive 取严）。
      const pluginRow = servers().find((server) => server.id === pluginServerIdOf)!;
      expect(pluginRow).toMatchObject({
        transport: 'http',
        url: 'https://mcp.docs.test/mcp',
        auth: 'none',
        enabled: true,
        autoApprove: false,
      });
      expect(mcp.riskOf(pluginServerIdOf, 'never_listed_tool')).toEqual({
        risk: 'destructive',
        source: 'default',
      });
    },
    90_000,
  );

  it(
    'connections：连接器属主插件未启用 → forBot 不列（勾了 app_connection_ids 也不出）；启用后恢复；缺省一致',
    async () => {
      const { core } = await setup();
      const connectedApps = core.services.connectedApps!;
      const pluginId = await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: CONN_PLUGIN },
          connectors: [{ slug: 'injectconn' }],
        }),
      );
      expect(pluginId).toBe(CONN_PLUGIN);
      // 属主查询（start.ts 接 registry.ownerOf 的同一账本）。
      expect(core.services.plugins!.ownerOf('connector', 'injectconn')).toBe(CONN_PLUGIN);

      // 直接建一条已连接的连接行（OAuth 流程的落库结果形状）。
      const connection = core.services.apps!.store.create({
        connectorId: 'injectconn',
        label: '测试账号',
        serverUrl: 'https://mcp.injectconn.test/mcp',
        status: 'connected',
      });

      // 缺省（无启用集）：现状——勾选即列出。
      expect(connectedApps.forBot([connection.id]).views.map((view) => view.slug)).toEqual([
        'injectconn',
      ]);
      expect(connectedApps.forBot([connection.id]).servers).toHaveLength(1);

      // 启用集为空：视图与合成 server 都不进。
      const off = connectedApps.forBot([connection.id], new Set());
      expect(off.views).toEqual([]);
      expect(off.servers).toEqual([]);

      // 启用：恢复（视图 + 可解析 server）。
      const on = connectedApps.forBot([connection.id], new Set([CONN_PLUGIN]));
      expect(on.views.map((view) => view.slug)).toEqual(['injectconn']);
      expect(on.servers).toHaveLength(1);

      // 能力目录同源过滤。
      const catalog = buildCapabilityCatalog({
        connectedApps,
        mcp: core.services.mcp,
        appConnectionIds: [connection.id],
        mcpServerIds: [],
        extraPluginIds: new Set(),
      });
      expect(catalog.entries).toEqual([]);
      const catalogOn = buildCapabilityCatalog({
        connectedApps,
        mcp: core.services.mcp,
        appConnectionIds: [connection.id],
        mcpServerIds: [],
        extraPluginIds: new Set([CONN_PLUGIN]),
      });
      expect(catalogOn.entries.map((entry) => entry.id)).toEqual(['app:injectconn']);
      expect(catalogOn.apps.views).toHaveLength(1);
    },
    90_000,
  );

  it(
    '项目叠加：projects.plugins.set 启用插件 X（成员未启用）→ 项目会话 run 可见 X，私聊会话不可见，成员 profile 不变',
    async () => {
      const { core, llm } = await setup();
      const skills = core.services.skills!;
      await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: SKILL_PLUGIN },
          skills: [{ name: SKILL_NAME, description: '插件注入技能' }],
        }),
      );
      await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: MCP_PLUGIN },
          http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
        }),
      );

      const member = await makeBot(core, '项目成员');
      const lead = await makeBot(core, '项目负责人');
      const project = await makeProject(core, '注入项目', [member.id, lead.id], {
        leadBotId: lead.id,
      });

      // 校验：非项目会话 / 未安装插件拒绝；写后 conversations.get 输出 plugins。
      const direct = await openDirect(core, member.id);
      await expect(
        core.rpc.call('projects.plugins.set', {
          conversationId: direct.id,
          pluginIds: [SKILL_PLUGIN],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        core.rpc.call('projects.plugins.set', {
          conversationId: project.id,
          pluginIds: ['io.github.tester/not-installed'],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      const pluginEvent = waitForEvent(
        core,
        'plugins.changed',
        (payload: { ids: string[] }) => payload.ids.includes(MCP_PLUGIN),
      );
      await core.rpc.call('projects.plugins.set', {
        conversationId: project.id,
        pluginIds: [SKILL_PLUGIN, MCP_PLUGIN],
      });
      await pluginEvent;
      expect(core.services.domain!.projects.pluginsOf(project.id)).toEqual([
        MCP_PLUGIN,
        SKILL_PLUGIN,
      ]);
      const detail = (await core.rpc.call('conversations.get', { id: project.id })) as {
        conversation: { plugins?: string[] };
      };
      expect(detail.conversation.plugins).toEqual([MCP_PLUGIN, SKILL_PLUGIN]);

      // 成员 Bot 的个人配置不被修改。
      expect(core.services.domain!.bots.get(member.id)!.profile.runtime.plugin_ids).toBeUndefined();

      // 私聊会话 run：不可见（先跑，marker 唯一定位本次请求）。
      llm.script('mock-main', [step().replyText('私聊回复-完成')]);
      await sendDrafts(core, direct.id, [{ text: '私聊触发词-runA' }]);
      await waitForRun(core, direct.id, 'completed');
      const directSystems = systemPromptsOf(llm, '私聊触发词-runA');
      expect(directSystems.length).toBeGreaterThan(0);
      for (const system of directSystems) {
        expect(system).not.toContain(SKILL_NAME);
        expect(system).not.toContain(pluginServerId(MCP_PLUGIN, 'docs'));
      }

      // 项目会话 run（@ 成员：只有它执行，无路由判定请求）：技能 + 能力目录都可见。
      llm.script('mock-main', [step().replyText('项目回复-完成')]);
      await sendDrafts(core, project.id, [
        { text: '项目触发词-runB', mentions: [member.id] },
      ]);
      await waitForRun(core, project.id, 'completed');
      const projectSystems = systemPromptsOf(llm, '项目触发词-runB');
      expect(projectSystems.length).toBeGreaterThan(0);
      expect(projectSystems.some((system) => system.includes(SKILL_NAME))).toBe(true);
      expect(
        projectSystems.some((system) => system.includes(`mcp:${pluginServerId(MCP_PLUGIN, 'docs')}`)),
      ).toBe(true);
    },
    120_000,
  );

  it(
    'mail：mailBoundFor 参数就位、行为不变（P3 前账号均为系统账号恒放行）',
    async () => {
      const { core } = await setup();
      const mail = core.services.mail!;
      const bot = await makeBot(core, '邮件 Bot');
      // 无绑定：两参形态一致为 false。
      const { mailBoundFor } = await import('../../src/tools/mail-tools.js');
      expect(mailBoundFor(mail, bot.id, new Set())).toBe(false);
      expect(mailBoundFor(mail, bot.id)).toBe(false);
    },
    60_000,
  );
  it(
    'available_apps 与卸载清洗：未启用插件的目录条目不进推荐位；卸载后引用面不残留、写路径不被卡死',
    async () => {
      const { core } = await setup();
      const connectedApps = core.services.connectedApps!;
      await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: CONN_PLUGIN },
          connectors: [{ slug: 'injectconn' }],
        }),
      );

      // availableFor：未启用（空集）→ 插件目录条目不进；启用 → 进。
      const off = connectedApps.availableFor([], new Set());
      expect(off.map((entry) => connectorMetaOf(entry).slug)).not.toContain('injectconn');
      const on = connectedApps.availableFor([], new Set([CONN_PLUGIN]));
      expect(on.map((entry) => connectorMetaOf(entry).slug)).toContain('injectconn');
      // 缺省（无启用集）= 现状。
      expect(connectedApps.availableFor([], undefined).map((entry) => connectorMetaOf(entry).slug)).toContain(
        'injectconn',
      );

      // 卸载清洗：Bot 与项目都启用过 → 卸载 → 引用面清空，之后的整集写入不再被残留卡死。
      const bot = await makeBot(core, '清引用甲');
      const other = await makeBot(core, '清引用乙');
      await core.rpc.call('plugins.setBotPlugins', { botId: bot.id, pluginIds: [CONN_PLUGIN] });
      const group = await makeProject(core, '清引用项目', [bot.id, other.id]);
      await core.rpc.call('projects.plugins.set', {
        conversationId: group.id,
        pluginIds: [CONN_PLUGIN],
      });
      await core.rpc.call('plugins.uninstall', { id: CONN_PLUGIN });
      expect(core.services.domain!.bots.get(bot.id)!.profile.runtime.plugin_ids ?? []).toEqual([]);
      expect(core.services.domain!.projects.pluginsOf(group.id)).toEqual([]);

      // 再装一个新插件并启用——写路径畅通（此前会被残留 id 整笔拒绝）。
      await installPlugin(core, (dir) =>
        buildPluginFixture({
          dir,
          manifest: { id: 'io.github.tester/inject-skill-b' },
          skills: [{ name: 'plg-inject-b', description: '清洗后技能' }],
        }),
      );
      await expect(
        core.rpc.call('plugins.setBotPlugins', {
          botId: bot.id,
          pluginIds: ['io.github.tester/inject-skill-b'],
        }),
      ).resolves.toMatchObject({ ok: true });
    },
    90_000,
  );

  it('审批对照：同一插件工具在启用 / 停用两态下的风险注解一致（可见性过滤不触碰审批）', async () => {
    const { core } = await setup();
    const mcp = core.services.mcp!;
    await installPlugin(core, (dir) =>
      buildPluginFixture({
        dir,
        manifest: { id: SKILL_PLUGIN },
        http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
      }),
    );
    const servers = mcp.listSettingsServers();
    const pluginServer = servers.find((server) => server.source?.kind === 'plugin');
    expect(pluginServer).toBeDefined();
    // 启停插件只改 serversForBot 的可见集；server 本体的风险档位（W5 默认）不动。
    const off = mcp.serversForBot([pluginServer!.id], new Set());
    const on = mcp.serversForBot([pluginServer!.id], new Set([SKILL_PLUGIN]));
    expect(off).toEqual([]);
    expect(on.map((server) => server.id)).toEqual([pluginServer!.id]);
    expect(mcp.riskOf(pluginServer!.id, 'anything')).toStrictEqual(
      mcp.riskOf(pluginServer!.id, 'anything'),
    );
    // 缺省（无启用集）与空集下的 server 定义（锁定哈希基础）一致。
    const serverDefault = mcp.listSettingsServers().find((item) => item.id === pluginServer!.id);
    expect(serverDefault?.enabled).toBe(true);
  });
});

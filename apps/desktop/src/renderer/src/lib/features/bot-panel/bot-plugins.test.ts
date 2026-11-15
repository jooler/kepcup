import { describe, expect, it } from 'vitest';
import type { McpServer, PluginSummary } from '@kepcup/shared';
// 相对导入：desktop 测试项目没有 $lib 别名（只有 desktop-svelte 有）。
import { enUS } from '../../i18n/locales/en-US';
import { zhCN } from '../../i18n/locales/zh-CN';
import {
  CAPABILITY_ENTRIES_MAX,
  ENTRY_GROUP_LABEL_KEYS,
  ENTRY_GROUP_ORDER,
  PLUGIN_KIND_LABEL_KEYS,
  addedPlugins,
  dedupeEntryRefs,
  dedupePluginIds,
  enabledPluginCount,
  groupEntriesByCapability,
  manualToolServers,
  matchesPluginQuery,
  pluginKindBadges,
  pluginProvides,
  saveableEntryRefs,
  toggleEntryRef,
  togglePluginId,
} from './bot-plugins';

/** P2 注入模型「插件」区块的纯逻辑：启用集整集写入、类别徽标、手动工具服务筛选。 */

const summary = (overrides: Partial<PluginSummary>): PluginSummary => ({
  id: 'io.github.a/x',
  name: 'X',
  iconDataUri: null,
  version: '1.0.0',
  description: '',
  usage: '',
  author: null,
  origin: 'local',
  tier: 'developer',
  state: 'installed',
  enabled: true,
  dirPath: null,
  marketplace: null,
  installedAt: 1,
  updatedAt: 1,
  counts: { skills: 0, connectors: 0, mcp: 0, mail: 0, im: 0 },
  items: [],
  updateAvailable: null,
  revoked: null,
  configFields: [],
  instanceFields: [],
  instanceCounts: { mail: 0, mcp: 0, im: 0 },
  providesInstances: [],
  ...overrides,
});

describe('togglePluginId / dedupePluginIds（plugins.setBotPlugins 整集写入）', () => {
  it('缺失（未启用任何插件）视作空集', () => {
    expect(togglePluginId(undefined, 'a', true)).toEqual(['a']);
    expect(togglePluginId(undefined, 'a', false)).toEqual([]);
  });

  it('勾选追加、取消移除，保持其余顺序', () => {
    expect(togglePluginId(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
    expect(togglePluginId(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
    expect(togglePluginId(['a'], 'a', true)).toEqual(['a']);
  });

  it('写入前去重（重复 id 不产生两份）', () => {
    expect(dedupePluginIds(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(togglePluginId(['a', 'a', 'b'], 'b', true)).toEqual(['a', 'b']);
  });
});

describe('enabledPluginCount（菜单 / 区块摘要）', () => {
  const installed = [{ id: 'a' }, { id: 'b' }];

  it('与已安装清单求交：卸载残留的 id 不计入', () => {
    expect(enabledPluginCount(['a', 'gone'], installed)).toBe(1);
    expect(enabledPluginCount(undefined, installed)).toBe(0);
    expect(enabledPluginCount(['a', 'b'], installed)).toBe(2);
  });
});

describe('addedPlugins / matchesPluginQuery（添加弹框）', () => {
  const alpha = summary({ id: 'p/alpha', name: 'Alpha', author: 'Alice', description: '文档工具' });
  const beta = summary({ id: 'p/beta', name: 'Beta', author: null, description: '邮件插件' });

  it('只保留已添加且仍在已安装清单里的插件，保持清单顺序', () => {
    expect(addedPlugins([alpha, beta], ['p/gone', 'p/beta'])).toEqual([beta]);
    expect(addedPlugins([alpha, beta], undefined)).toEqual([]);
  });

  it('搜索命中名称 / id / 描述 / 作者；多个关键词取交集；空查询恒命中', () => {
    expect(matchesPluginQuery(alpha, 'alpha')).toBe(true);
    expect(matchesPluginQuery(alpha, 'p/alp')).toBe(true);
    expect(matchesPluginQuery(alpha, '文档 alice')).toBe(true);
    expect(matchesPluginQuery(alpha, '文档 beta')).toBe(false);
    expect(matchesPluginQuery(alpha, '   ')).toBe(true);
  });
});

describe('pluginKindBadges / pluginProvides（类别徽标）', () => {
  it('按贡献计数推导，顺序固定 技能 → 连接 → 工具 → 邮件 → 即时通讯 → 模型', () => {
    expect(
      pluginKindBadges(summary({ counts: { skills: 2, connectors: 1, mcp: 3, mail: 1, im: 1 } })),
    ).toEqual(['skill', 'connector', 'mcp', 'mail', 'im']);
    expect(
      pluginKindBadges(summary({ counts: { skills: 0, connectors: 0, mcp: 0, mail: 0, im: 0 } })),
    ).toEqual([]);
  });

  it('纯实例插件（providesInstances）也能标出类别；mcp 徽标一律是「工具」文案键', () => {
    expect(pluginKindBadges(summary({ providesInstances: ['mail', 'mcp', 'im'] }))).toEqual([
      'mcp',
      'mail',
      'im',
    ]);
    expect(PLUGIN_KIND_LABEL_KEYS.mcp).toBe('plugins.kind.mcp');
    expect(zhCN['plugins.kind.mcp']).toBe('工具');
    expect(enUS['plugins.kind.mcp']).toBe('Tools');
  });

  it('能力模型插件按 providesInstances 出「模型」徽标（D124），中英文案齐全', () => {
    expect(pluginKindBadges(summary({ providesInstances: ['capability-model'] }))).toEqual([
      'capability-model',
    ]);
    expect(PLUGIN_KIND_LABEL_KEYS['capability-model']).toBe('plugins.kind.capabilityModel');
    expect(zhCN['plugins.kind.capabilityModel']).toBe('模型');
    expect(enUS['plugins.kind.capabilityModel']).toBe('Models');
    expect(zhCN['plugins.market.category.capability-model']).toBe('模型');
    expect(enUS['plugins.market.category.capability-model']).toBe('Models');
  });

  it('pluginProvides：连接只看贡献计数；邮件 / IM 看贡献或实例声明', () => {
    expect(
      pluginProvides(
        summary({ counts: { connectors: 1, mcp: 0, mail: 0, skills: 0, im: 0 } }),
        'connector',
      ),
    ).toBe(true);
    expect(pluginProvides(summary({ providesInstances: ['mail'] }), 'mail')).toBe(true);
    expect(pluginProvides(summary({ providesInstances: ['im'] }), 'im')).toBe(true);
    expect(
      pluginProvides(
        summary({ counts: { skills: 0, connectors: 0, mcp: 0, mail: 0, im: 1 } }),
        'im',
      ),
    ).toBe(true);
    expect(pluginProvides(summary({}), 'im')).toBe(false);
    expect(pluginProvides(summary({}), 'mail')).toBe(false);
    expect(pluginProvides(summary({ providesInstances: ['mcp'] }), 'connector')).toBe(false);
  });
});

describe('manualToolServers（展开细选：仅手动 server）', () => {
  const server = (overrides: Partial<McpServer>): McpServer =>
    ({
      id: 's',
      name: 'S',
      transport: 'stdio',
      command: 'npx',
      enabled: true,
      autoApprove: false,
      auth: 'none',
      ...overrides,
    }) as McpServer;

  it('插件贡献的 server 不再逐个勾选（随插件启用集自动可用）', () => {
    const servers = [
      server({ id: 'manual', name: '手动' }),
      server({
        id: 'plug',
        name: '插件',
        source: { kind: 'plugin', pluginId: 'io.github.a/x', version: '1.0.0', key: 'db' },
      }),
      server({
        id: 'mcpb',
        name: 'MCPB 包',
        source: { kind: 'mcpb', name: 'pkg', version: '1.0.0', sha256: 'a'.repeat(64) },
      }),
      server({ id: 'off', name: '已停用', enabled: false }),
    ];
    expect(manualToolServers(servers).map((entry) => entry.id)).toEqual(['manual', 'mcpb']);
  });
});

// --- D124：模型条目勾选（capability_entries 整集写入） ------------------------

const entry = (
  pluginId: string,
  entryId: string,
  capability: 'image' | 'video' | 'tts' | 'asr' | 'multimodal' | 'embedding' | 'rerank',
) => ({
  entryId,
  capability,
  model: `${entryId}-model`,
  displayName: null,
  engine: 'dashscope',
  instanceState: 'single' as const,
  configured: true,
});

describe('toggleEntryRef / dedupeEntryRefs（plugins.setBotCapabilityEntries 整集写入）', () => {
  it('缺失（未勾选过任何条目）视作空集', () => {
    expect(toggleEntryRef(undefined, 'p', 'e1', true)).toEqual([{ plugin: 'p', entry: 'e1' }]);
    expect(toggleEntryRef(undefined, 'p', 'e1', false)).toEqual([]);
  });

  it('勾选追加、取消移除，保持其余引用顺序', () => {
    const current = [
      { plugin: 'p', entry: 'e1' },
      { plugin: 'q', entry: 'f1' },
    ];
    expect(toggleEntryRef(current, 'p', 'e2', true)).toEqual([
      { plugin: 'p', entry: 'e1' },
      { plugin: 'q', entry: 'f1' },
      { plugin: 'p', entry: 'e2' },
    ]);
    expect(toggleEntryRef(current, 'p', 'e1', false)).toEqual([{ plugin: 'q', entry: 'f1' }]);
    // 重复勾选不产生两份（实现是先移除再尾插：已勾选项被移到末尾，防御性路径）
    expect(toggleEntryRef(current, 'p', 'e1', true)).toEqual([
      { plugin: 'q', entry: 'f1' },
      { plugin: 'p', entry: 'e1' },
    ]);
  });

  it('dedupeEntryRefs 按 (plugin, entry) 去重、保序', () => {
    expect(
      dedupeEntryRefs([
        { plugin: 'p', entry: 'e1' },
        { plugin: 'p', entry: 'e1' },
        { plugin: 'p', entry: 'e2' },
        { plugin: 'q', entry: 'e1' },
      ]),
    ).toEqual([
      { plugin: 'p', entry: 'e1' },
      { plugin: 'p', entry: 'e2' },
      { plugin: 'q', entry: 'e1' },
    ]);
  });
});

describe('saveableEntryRefs（保存前剔除已卸载插件的残留引用）', () => {
  it('只保留插件仍在已装清单里的引用；顺序与去重不变', () => {
    const current = [
      { plugin: 'p', entry: 'e1' },
      { plugin: 'gone', entry: 'z' },
      { plugin: 'q', entry: 'f1' },
    ];
    expect(saveableEntryRefs(current, ['p', 'q'])).toEqual([
      { plugin: 'p', entry: 'e1' },
      { plugin: 'q', entry: 'f1' },
    ]);
    expect(saveableEntryRefs(undefined, ['p'])).toEqual([]);
  });
});

describe('groupEntriesByCapability（展开区按能力分组）', () => {
  it('按固定顺序分组；空能力不出组；组内保持清单序', () => {
    const entries = [
      entry('p', 'tts-a', 'tts'),
      entry('p', 'img-a', 'image'),
      entry('p', 'img-b', 'image'),
      entry('p', 'vid-a', 'video'),
    ];
    const groups = groupEntriesByCapability(entries);
    expect(groups.map((group) => group.capability)).toEqual(['image', 'video', 'tts']);
    expect(groups[0]!.entries.map((row) => row.entryId)).toEqual(['img-a', 'img-b']);
  });

  it('清单外能力（如新增枚举）不进组；空清单不出任何组', () => {
    expect(groupEntriesByCapability([entry('p', 'x', 'rerank')]).map((g) => g.capability)).toEqual([
      'rerank',
    ]);
    expect(groupEntriesByCapability([])).toEqual([]);
  });

  it('ENTRY_GROUP_ORDER 与文案键一一对应；七组中英文案都登记（i18n 不缺键）', () => {
    expect(Object.keys(ENTRY_GROUP_LABEL_KEYS)).toHaveLength(ENTRY_GROUP_ORDER.length);
    for (const capability of ENTRY_GROUP_ORDER) {
      const key = ENTRY_GROUP_LABEL_KEYS[capability];
      expect(typeof zhCN[key]).toBe('string');
      expect(typeof enUS[key]).toBe('string');
    }
    expect(zhCN['botPanel.plugins.entryGroup.image']).toBe('图片生成');
    expect(zhCN['botPanel.plugins.entryGroup.multimodal']).toBe('图文理解');
    expect(CAPABILITY_ENTRIES_MAX).toBe(16);
  });
});

import { describe, expect, it } from 'vitest';
import type { McpServer, PluginSummary } from '@kepcup/shared';
// 相对导入：desktop 测试项目没有 $lib 别名（只有 desktop-svelte 有）。
import { enUS } from '../../i18n/locales/en-US';
import { zhCN } from '../../i18n/locales/zh-CN';
import {
  PLUGIN_KIND_LABEL_KEYS,
  dedupePluginIds,
  enabledPluginCount,
  manualToolServers,
  pluginKindBadges,
  pluginProvides,
  togglePluginId,
} from './bot-plugins';

/** P2 注入模型「插件」区块的纯逻辑：启用集整集写入、类别徽标、手动工具服务筛选。 */

const summary = (overrides: Partial<PluginSummary>): PluginSummary => ({
  id: 'io.github.a/x',
  name: 'X',
  version: '1.0.0',
  description: '',
  author: null,
  origin: 'local',
  tier: 'developer',
  state: 'installed',
  enabled: true,
  dirPath: null,
  marketplace: null,
  installedAt: 1,
  updatedAt: 1,
  counts: { skills: 0, connectors: 0, mcp: 0, mail: 0 },
  items: [],
  updateAvailable: null,
  revoked: null,
  configFields: [],
  instanceFields: [],
  instanceCounts: { mail: 0, mcp: 0 },
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

describe('pluginKindBadges / pluginProvides（类别徽标）', () => {
  it('按贡献计数推导，顺序固定 技能 → 连接 → 工具 → 邮件', () => {
    expect(
      pluginKindBadges(summary({ counts: { skills: 2, connectors: 1, mcp: 3, mail: 1 } })),
    ).toEqual(['skill', 'connector', 'mcp', 'mail']);
    expect(
      pluginKindBadges(summary({ counts: { skills: 0, connectors: 0, mcp: 0, mail: 0 } })),
    ).toEqual([]);
  });

  it('纯实例插件（providesInstances）也能标出类别；mcp 徽标一律是「工具」文案键', () => {
    expect(pluginKindBadges(summary({ providesInstances: ['mail', 'mcp'] }))).toEqual([
      'mcp',
      'mail',
    ]);
    expect(PLUGIN_KIND_LABEL_KEYS.mcp).toBe('plugins.kind.mcp');
    expect(zhCN['plugins.kind.mcp']).toBe('工具');
    expect(enUS['plugins.kind.mcp']).toBe('Tools');
  });

  it('pluginProvides：连接只看贡献计数；邮件看贡献或实例声明', () => {
    expect(
      pluginProvides(
        summary({ counts: { connectors: 1, mcp: 0, mail: 0, skills: 0 } }),
        'connector',
      ),
    ).toBe(true);
    expect(pluginProvides(summary({ providesInstances: ['mail'] }), 'mail')).toBe(true);
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

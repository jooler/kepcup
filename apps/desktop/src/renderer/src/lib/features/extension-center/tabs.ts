/**
 * 扩展中心（原技能市场）的分组：市场 / 已安装（插件）/ 本机应用协作。
 * 纯函数，便于单测；shell store、弹框与各入口（`openExtensionCenter(tab)`）共用。
 *
 * D104 之后的模型：技能 / 连接 / MCP / 邮件四类内容由插件贡献、安装后自动确认类别
 * （`PluginSummary.counts`），不再是独立页签，而是「已安装」列表顶部的筛选条件；
 * 旧的四个分组页名保留为深链别名（`LEGACY_TAB_FILTERS`），落到对应筛选视图。
 */
export type ExtensionCenterTab = 'market' | 'installed' | 'localCollab';

// prettier-ignore
// settings-ui-scan.ts parses the array below with a regex; keep it a single-line literal.
export const EXTENSION_CENTER_TABS: readonly ExtensionCenterTab[] = ['market', 'installed', 'localCollab'];

/** 「已安装」列表的内容筛选：全部 + 插件贡献的四类内容。 */
export type ExtensionCenterFilter = 'all' | 'skill' | 'connector' | 'mcp' | 'mail';

export type ExtensionCenterKindFilter = Exclude<ExtensionCenterFilter, 'all'>;

/** 筛选 id → `PluginSummary.counts` 的键（安装后由贡献自动推导）。 */
export const FILTER_COUNT_KEYS: Readonly<
  Record<ExtensionCenterKindFilter, 'skills' | 'connectors' | 'mcp' | 'mail'>
> = {
  skill: 'skills',
  connector: 'connectors',
  mcp: 'mcp',
  mail: 'mail',
} as const;

/** 旧分组页名（tab 收缩前的独立页签）→ 已安装筛选。 */
export const LEGACY_TAB_FILTERS: Readonly<
  Record<'skills' | 'connections' | 'mcp' | 'mail', ExtensionCenterKindFilter>
> = { skills: 'skill', connections: 'connector', mcp: 'mcp', mail: 'mail' } as const;

/** `openExtensionCenter` 接受的完整入参：现行页签 + 旧分组深链别名。 */
export type ExtensionCenterTarget = ExtensionCenterTab | keyof typeof LEGACY_TAB_FILTERS;

/** 深链锚点前缀（目录条目 `plugins-filter-*`）：落到「已安装」并选中对应筛选。 */
export const FILTER_ANCHOR_PREFIX = 'plugins-filter-';

/** 纯函数：openExtensionCenter 的入参 + 可选锚点 → 页签与筛选。 */
export function resolveExtensionCenterTarget(
  tab: ExtensionCenterTarget,
  anchor?: string,
): { tab: ExtensionCenterTab; filter: ExtensionCenterFilter } {
  if (anchor !== undefined && anchor.startsWith(FILTER_ANCHOR_PREFIX)) {
    const filter = anchor.slice(FILTER_ANCHOR_PREFIX.length);
    if (filter === 'all' || filter in FILTER_COUNT_KEYS) {
      return { tab: 'installed', filter: filter as ExtensionCenterFilter };
    }
  }
  const legacy = (LEGACY_TAB_FILTERS as Record<string, ExtensionCenterKindFilter>)[tab];
  if (legacy !== undefined) return { tab: 'installed', filter: legacy };
  return { tab: tab as ExtensionCenterTab, filter: 'all' };
}

/** WAI-ARIA tabs 的键盘导航：左右方向键循环，Home / End 到两端；其他键返回 null（不处理）。 */
export function extensionTabForKey(
  current: ExtensionCenterTab,
  key: string,
): ExtensionCenterTab | null {
  const last = EXTENSION_CENTER_TABS.length - 1;
  const index = Math.max(0, EXTENSION_CENTER_TABS.indexOf(current));
  switch (key) {
    case 'ArrowRight':
      return EXTENSION_CENTER_TABS[index >= last ? 0 : index + 1]!;
    case 'ArrowLeft':
      return EXTENSION_CENTER_TABS[index <= 0 ? last : index - 1]!;
    case 'Home':
      return EXTENSION_CENTER_TABS[0]!;
    case 'End':
      return EXTENSION_CENTER_TABS[last]!;
    default:
      return null;
  }
}

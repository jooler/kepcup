/**
 * 设置分区 id（D73 §5.9）。宽屏设置是独立页面（不再是弹框）：左栏分类条目 +
 * 主体分区内容；扩展中心也是页面级分类，但不是设置分区（渲染扩展中心主体，
 * 深链走 extension-center surface）。
 *
 * 「插件」分区已并入扩展中心的「设置」页签（原「市场 / 已安装」行右侧新增）：
 * 旧深链 `plugins` 与 `mcp` / `developer` 一样由 `shell.openSettings` 改开扩展中心，
 * 不再渲染成设置分区。
 */
import { isTeamHidden } from '../team/surface-gate';

export type SettingsSectionId =
  | 'general'
  | 'hardware'
  | 'models'
  | 'search'
  | 'browser'
  | 'computer-use'
  | 'agents'
  | 'profile'
  | 'contacts'
  | 'team'
  | 'unattended'
  | 'remote'
  /** 「团队服务器」独立分区（连接远程执行中心；桌面端点动态插入）。 */
  | 'team-server'
  | 'environment'
  | 'usage'
  | 'diagnostics'
  /** 旧深链 id：shell.openSettings 改开扩展中心，不会渲染成设置分区。 */
  | 'mcp'
  | 'developer'
  | 'plugins';

export interface ResolvedSection {
  /** 实际渲染的分区（旧深链别名已展开）。 */
  section: Exclude<SettingsSectionId, 'mcp' | 'developer' | 'plugins'>;
}

/**
 * 宽屏设置页左栏的分类 id：真实设置分区 + 扩展中心（伪分区——主体渲染扩展中心
 * 的分组 tab 与内容，不是 SettingsSectionView 的设置分区）。
 */
export type SettingsPageSection = ResolvedSection['section'] | 'extension-center';

/**
 * 团队深链回落（T5）的候选顺序：与左栏导航同序（profile 优先、agents 已并入
 * models）。本文件被 node 单测直接引用（无 `$lib` 别名 / 无 Svelte 编译），
 * 不能 import settings-section-labels 拿清单——顺序在这里静态声明，标题与
 * 可见性的事实源仍在 settings-section-labels。
 */
const SECTION_FALLBACK_ORDER: ReadonlyArray<
  Exclude<SettingsSectionId, 'mcp' | 'developer' | 'plugins'>
> = [
  'profile',
  'general',
  'hardware',
  'models',
  'search',
  'browser',
  'computer-use',
  'contacts',
  'team',
  'unattended',
  'remote',
  'team-server',
  'environment',
  'usage',
  'diagnostics',
];

/**
 * 展开旧深链别名：`mcp` / `developer` / `plugins` 正常情况下由 shell 改开扩展中心，
 * 到不了这里；万一落到设置分区渲染（兜底），渲染「通用」而不是已移除的分区。
 * 其余分区原样返回。
 *
 * 团队端点（T5）深链回落：分区被 `team.bootstrap.surfaces.hidden` 隐藏时，深链
 * 回落到第一个可见分区（体验层门控——被隐藏的分区不再可达）。非团队上下文
 * `isTeamHidden` 恒 false，行为与现状一致。
 */
export function resolveSettingsSection(id: SettingsSectionId): ResolvedSection {
  if (id === 'mcp' || id === 'developer' || id === 'plugins') return { section: 'general' };
  const section = id as Exclude<SettingsSectionId, 'mcp' | 'developer' | 'plugins'>;
  if (isTeamHidden(section)) {
    const fallback = SECTION_FALLBACK_ORDER.find((candidate) => !isTeamHidden(candidate));
    if (fallback !== undefined) return { section: fallback };
  }
  return { section };
}

/**
 * 这些设置分区 id（旧深链别名）应改开扩展中心，返回对应的扩展中心页签：
 * `mcp` / `developer` → 「已安装」的 MCP 筛选；`plugins` → 「设置」页签。
 * 其余分区返回 null（正常打开设置分区）。
 */
export function settingsSectionExtensionTarget(id: SettingsSectionId): 'mcp' | 'settings' | null {
  if (id === 'mcp' || id === 'developer') return 'mcp';
  if (id === 'plugins') return 'settings';
  return null;
}

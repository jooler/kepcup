import { SETTING_ITEMS } from './items.js';
import { CARD_KEYS, type CardKey, type SettingItem } from './types.js';

/**
 * 覆盖率约束（todo/conversational-app-setup.md §4.3）：设置界面上的每个位置都要对应至少一个
 * 目录条目，或在这里的排除表写明理由；每个条目的深链都要落在真实存在的锚点上；每个
 * `card !== null` 的条目在渲染层映射里都要有组件。
 *
 * 这里只放纯函数与数据：扫描 Svelte 源码（fs）的部分在测试里（shared 单测扫一遍，
 * desktop 可用 `import.meta.glob` 自己扫后调用同一套函数）。
 */

/** 界面位置的种类。`action` 不对应扫描结果，只用来登记「删除类动作不入目录」的理由。 */
export type SettingsUiLocationKind =
  'settings-section' | 'anchor' | 'extension-tab' | 'bot-panel-tab' | 'action';

export interface ExcludedSettingLocation {
  kind: SettingsUiLocationKind;
  /** 分区 / 锚点 / 页签 id；动态锚点写成「前缀*」；action 写对应 RPC 方法名。 */
  id: string;
  reason: string;
}

/**
 * 显式排除表（§4.2「明确不纳入」、§九）：删除类、破坏性动作沿用原有入口和二次确认，
 * 不是「设置」；纯数据 / 产出物的页签也不是设置。
 */
export const EXCLUDED_SETTING_LOCATIONS: readonly ExcludedSettingLocation[] = [
  {
    kind: 'anchor',
    id: 'agent-*',
    reason: 'AgentCard 按智能体生成的动态锚点；由 agents.external 经分区锚点 agents 覆盖',
  },
  {
    kind: 'settings-section',
    id: 'contacts',
    reason:
      '通讯录：Bot / 项目组的名册与移除、恢复都是对象管理而非设置（删除类不入目录）；单个 Bot 的配置由 bot.* 条目覆盖',
  },
  {
    kind: 'bot-panel-tab',
    id: 'memory',
    reason: '记忆条目是 Bot 的数据，不是设置；改写走 remember / forget',
  },
  { kind: 'bot-panel-tab', id: 'widget', reason: 'Bot 自制组件是产出物，不是设置' },
  {
    kind: 'bot-panel-tab',
    id: 'wiki',
    reason: '知识库内容是 Bot 的数据，不是设置；收录走 wiki_enqueue',
  },
  {
    kind: 'bot-panel-tab',
    id: 'watches',
    reason: '网页监看是对话级自动化配置与数据，不是设置；入口在 Bot 详情的监看详情',
  },
  { kind: 'action', id: 'bots.delete', reason: '删除 Bot：破坏性动作，沿用原入口与二次确认' },
  {
    kind: 'action',
    id: 'conversations.archive',
    reason: '从对话列表移除（归档）：可逆的对象管理动作，入口在侧栏右键与通讯录，不是设置',
  },
  {
    kind: 'action',
    id: 'conversations.unarchive',
    reason: '恢复归档会话：可逆的对象管理动作，入口在通讯录，不是设置',
  },
  {
    kind: 'action',
    id: 'conversations.delete',
    reason: '物理删除会话：破坏性动作，只在项目详情页「危险区」与管家聊天里',
  },
  { kind: 'action', id: 'browserProfiles.delete', reason: '删除浏览器资料：破坏性动作' },
  { kind: 'action', id: 'browserProfiles.clear', reason: '清空浏览器资料（登录状态）：破坏性动作' },
  { kind: 'action', id: 'apps.disconnect', reason: '断开连接：破坏性动作' },
  { kind: 'action', id: 'mail.accounts.delete', reason: '删除邮箱：破坏性动作' },
  { kind: 'action', id: 'mcp.removeServer', reason: '删除 MCP 服务：破坏性动作' },
  { kind: 'action', id: 'skills.uninstall', reason: '卸载技能：破坏性动作' },
  { kind: 'action', id: 'environment.remove', reason: '删除工具链：破坏性动作' },
  { kind: 'action', id: 'wiki.deletePage', reason: '删除知识库页面：破坏性动作' },
  {
    kind: 'action',
    id: 'wiki.deleteSource',
    reason:
      '删除项目 wiki 来源：破坏性动作，入口在项目 Wiki 的来源面板（收录走 wiki_enqueue / wiki.addSource）',
  },
  {
    kind: 'action',
    id: 'grants.revoke',
    reason: '撤销目录授权：在 Bot「访问」页签逐条撤销，不经对话',
  },
  {
    kind: 'action',
    id: 'workdirs.remove',
    reason: '移除工作目录：破坏性动作（工作目录设置对话框内）',
  },
  {
    kind: 'action',
    id: 'projects.delete',
    reason: '删除项目组：破坏性动作（项目详情页「危险区」内）',
  },
  {
    kind: 'action',
    id: 'profile.retract',
    reason: '删除用户画像条目：破坏性动作；改写走设置页「用户画像」',
  },
  {
    kind: 'extension-tab',
    id: 'market',
    reason:
      '插件市场的浏览与安装是对象管理，不是设置；市场地址与公钥、自动检查更新在「已安装」页签的插件设置区',
  },
];

/**
 * 条目深链里**计划中、尚未加到界面上**的锚点（desktop 车道补 `data-settings-anchor` 后从这里
 * 删掉；测试同时检查这里的锚点确实还不存在，防止遗留）。WP4 曾登记项目详情页的四个锚点，
 * WP7 在 `ProjectSettingsPage` / `ProjectMembersEditor` 里补上后已删除。
 * D104 P1-1 登记的 `plugins-updates` / `plugins-marketplace` 已在 P1-3 的「已安装」页落地并删除。
 */
export const PENDING_DESKTOP_ANCHORS: readonly string[] = [];

/** 对话框类深链的固定 section 名。 */
export const DIALOG_SURFACE_SECTIONS = {
  'workdir-dialog': 'workdir-settings',
} as const;

/**
 * 项目详情页的分区（README §4.11 的 `ProjectSettingsSection`，shared 与渲染层共用一份）。
 * `project-detail` 不是对话框：section 必须属于这里，而不是 `DIALOG_SURFACE_SECTIONS`。
 */
export const PROJECT_DETAIL_SECTIONS = [
  'overview',
  'members',
  'grants',
  'schedules',
  'danger',
] as const;
export type ProjectSettingsSection = (typeof PROJECT_DETAIL_SECTIONS)[number];

/** 从渲染层源码扫出来的界面位置。 */
export interface SettingsUiScan {
  /** 设置弹框分区（`data-settings-section`）。 */
  settingsSections: readonly string[];
  /** 全部 `data-settings-anchor`；模板串里的动态锚点记成「静态前缀*」（`agent-*`）。 */
  anchors: readonly string[];
  /** 能判定所在分区的锚点 → 分区（SettingsSectionView 里直接包在分区下的）。 */
  anchorSections: Readonly<Record<string, string>>;
  /** 扩展中心页签（`EXTENSION_CENTER_TABS`）。 */
  extensionCenterTabs: readonly string[];
  /** Bot 详情下钻位置（RightPanel `PanelDetail` 的 `kind`：profile / skills / access 等）。 */
  botPanelTabs: readonly string[];
}

function excluded(
  list: readonly ExcludedSettingLocation[],
  kind: SettingsUiLocationKind,
  id: string,
): boolean {
  return list.some(
    (entry) =>
      entry.kind === kind &&
      (entry.id === id || (entry.id.endsWith('*') && id.startsWith(entry.id.slice(0, -1)))),
  );
}

/**
 * 覆盖率与深链检查（§4.3 测试一、测试二的深链部分）。返回问题清单，空 = 通过：
 * - 每个设置分区 / 锚点 / 扩展中心页签 / Bot 面板页签都有条目或排除理由；
 * - 每个条目的深链：section 存在于对应界面，anchor 存在（或登记在 `pending`），
 *   能判定分区的锚点要与 section 一致；
 * - `pending` 里的锚点不能已经存在（加了就删掉登记），排除表不能指向已不存在的位置。
 */
export function settingsCoverageProblems(
  scan: SettingsUiScan,
  options: {
    items?: readonly SettingItem[];
    excludedLocations?: readonly ExcludedSettingLocation[];
    pendingAnchors?: readonly string[];
  } = {},
): string[] {
  const items = options.items ?? SETTING_ITEMS;
  const exclusions = options.excludedLocations ?? EXCLUDED_SETTING_LOCATIONS;
  const pending = new Set(options.pendingAnchors ?? PENDING_DESKTOP_ANCHORS);
  const anchors = new Set(scan.anchors);
  const problems: string[] = [];

  const linked = (surface: string, section: string) =>
    items.some((entry) => entry.deepLink.surface === surface && entry.deepLink.section === section);
  for (const section of scan.settingsSections) {
    if (!linked('settings', section) && !excluded(exclusions, 'settings-section', section)) {
      problems.push(`设置分区 ${section} 没有目录条目，也不在排除表里`);
    }
  }
  for (const anchor of scan.anchors) {
    const covered = items.some((entry) => entry.deepLink.anchor === anchor);
    if (!covered && !excluded(exclusions, 'anchor', anchor)) {
      problems.push(`锚点 ${anchor} 没有目录条目，也不在排除表里`);
    }
  }
  for (const tab of scan.extensionCenterTabs) {
    if (!linked('extension-center', tab) && !excluded(exclusions, 'extension-tab', tab)) {
      problems.push(`扩展中心页签 ${tab} 没有目录条目，也不在排除表里`);
    }
  }
  for (const tab of scan.botPanelTabs) {
    if (!linked('bot-panel', tab) && !excluded(exclusions, 'bot-panel-tab', tab)) {
      problems.push(`Bot 面板页签 ${tab} 没有目录条目，也不在排除表里`);
    }
  }

  for (const entry of items) {
    const { surface, section, anchor } = entry.deepLink;
    if (surface === 'project-detail') {
      // 项目详情页是内容区页面（不是对话框）：section 必须是固定五分区之一。
      if (!(PROJECT_DETAIL_SECTIONS as readonly string[]).includes(section)) {
        problems.push(
          `${entry.id}：深链 project-detail/${section} 的 section 不属于 PROJECT_DETAIL_SECTIONS`,
        );
      }
    } else {
      const sections: readonly string[] =
        surface === 'settings'
          ? scan.settingsSections
          : surface === 'extension-center'
            ? scan.extensionCenterTabs
            : surface === 'bot-panel'
              ? scan.botPanelTabs
              : [DIALOG_SURFACE_SECTIONS[surface]];
      if (!sections.includes(section)) {
        problems.push(`${entry.id}：深链 ${surface}/${section} 的 section 不存在`);
      }
    }
    if (anchor === undefined) continue;
    if (!anchors.has(anchor) && !pending.has(anchor)) {
      problems.push(`${entry.id}：深链锚点 ${anchor} 不存在（也未登记为待补锚点）`);
    }
    const anchorSection = scan.anchorSections[anchor];
    if (surface === 'settings' && anchorSection !== undefined && anchorSection !== section) {
      problems.push(`${entry.id}：锚点 ${anchor} 在分区 ${anchorSection}，深链却写 ${section}`);
    }
  }

  for (const anchor of pending) {
    if (anchors.has(anchor))
      problems.push(`待补锚点 ${anchor} 已存在：从 PENDING_DESKTOP_ANCHORS 删掉`);
  }
  for (const entry of exclusions) {
    const present =
      entry.kind === 'settings-section'
        ? scan.settingsSections.includes(entry.id)
        : entry.kind === 'extension-tab'
          ? scan.extensionCenterTabs.includes(entry.id)
          : entry.kind === 'bot-panel-tab'
            ? scan.botPanelTabs.includes(entry.id)
            : entry.kind === 'anchor'
              ? scan.anchors.some((anchor) => excluded([entry], 'anchor', anchor))
              : true;
    if (!present) problems.push(`排除表的 ${entry.kind} ${entry.id} 在界面上已不存在`);
  }
  return problems;
}

/**
 * 渲染层组件映射检查（§4.3 测试二的组件部分，desktop 车道在自己的测试里调用）：
 * `componentKeys` = `CardKey → Svelte 组件` 映射的键。返回问题清单，空 = 通过：
 * 条目用到的卡片键都有组件；映射里没有目录不认识的键。
 */
export function cardComponentProblems(
  componentKeys: Iterable<string>,
  items: readonly SettingItem[] = SETTING_ITEMS,
): string[] {
  const mapped = new Set(componentKeys);
  const problems: string[] = [];
  const used = new Set<CardKey>();
  for (const entry of items) if (entry.card !== null) used.add(entry.card);
  for (const key of used) {
    if (!mapped.has(key)) problems.push(`卡片键 ${key} 在渲染层映射里没有组件`);
  }
  for (const key of mapped) {
    if (!(CARD_KEYS as readonly string[]).includes(key)) {
      problems.push(`渲染层映射里的 ${key} 不是 CARD_KEYS 里的卡片键`);
    }
  }
  return problems;
}

/**
 * 这一条是否需要 core 侧显式的条目适配器（todo/settings-catalog-registry.md §4.1.4）：
 * core 拥有、经目录写入、可写、且没有声明 `store.generic`（通用标量适配器负责）。
 * 只读 / 渲染层 / via-tool / generic 条目都不需要。
 */
export function requiresItemAdapter(item: SettingItem): boolean {
  return (
    item.owner === 'core' &&
    !item.readOnly &&
    item.write.via === 'catalog' &&
    !(item.store.kind === 'settings' && item.store.generic === true)
  );
}

export interface SettingsAdapterCoverageInput {
  items?: readonly SettingItem[];
  /** core 贡献表里登记的全部 itemId。 */
  adapterIds: Iterable<string>;
  /**
   * 明确接受「没有适配器」的条目及理由（例如 profile.user-facts 没有安全信号）。
   * 有理由才能进入这个表，不能靠静默 fallback。
   */
  explicitFallback?: Readonly<Record<string, string>>;
}

/**
 * 目录条目 → core 适配器的闭合检查（core 车道在自己的单测里调用，`adapterIds` 来自
 * `SETTING_ADAPTER_CONTRIBUTIONS`）。返回问题清单，空 = 通过：
 * - 需要适配器的条目都在贡献表里，或显式登记了 fallback 理由；
 * - 贡献表没有指向不存在条目的过期登记；
 * - fallback 表没有遗留（条目已不需要 fallback，或根本不存在）。
 */
export function settingsAdapterCoverageProblems(input: SettingsAdapterCoverageInput): string[] {
  const items = input.items ?? SETTING_ITEMS;
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const adapterIds = new Set(input.adapterIds);
  const fallback = input.explicitFallback ?? {};
  const problems: string[] = [];

  for (const entry of items) {
    if (!requiresItemAdapter(entry)) continue;
    if (!adapterIds.has(entry.id) && fallback[entry.id] === undefined) {
      problems.push(
        `${entry.id}：需要 core 适配器（core 拥有、经目录写入），但不在贡献表里，也没有登记 EXPLICIT_ADAPTER_FALLBACK 理由`,
      );
    }
  }
  for (const id of adapterIds) {
    if (!byId.has(id)) problems.push(`适配器贡献登记了不存在的条目 ${id}`);
  }
  for (const [id, reason] of Object.entries(fallback)) {
    const entry = byId.get(id);
    if (entry === undefined) {
      problems.push(`EXPLICIT_ADAPTER_FALLBACK 里的 ${id} 不是目录条目`);
      continue;
    }
    if (reason.trim().length === 0) {
      problems.push(`EXPLICIT_ADAPTER_FALLBACK 里的 ${id} 没写理由`);
    }
    if (!requiresItemAdapter(entry)) {
      problems.push(
        `EXPLICIT_ADAPTER_FALLBACK 里的 ${id} 不需要 fallback（只读 / 渲染层 / via-tool / generic），请删掉`,
      );
    } else if (adapterIds.has(id)) {
      problems.push(`EXPLICIT_ADAPTER_FALLBACK 里的 ${id} 已有适配器，fallback 是遗留`);
    }
  }
  return problems;
}

/**
 * 全局外壳状态。宽屏主区有两个视图：对话（默认）与工作台（D90，`mainView`）；
 * 设置与通讯录都以弹框呈现（通讯录是设置弹框中的一个分组），不再整页替换主区域。
 * 窄屏（33-narrow-layout）例外：设置改走 NarrowSettings 全屏页，通讯录 /
 * 用户画像直达底部 tab——见 openSettings 的重路由；窄屏暂无工作台入口，`mainView` 不生效。
 */
import type { AppsTab, SettingsSectionId } from '$lib/features/settings/sections';
import type { ExtensionCenterTab } from '$lib/features/extension-center/tabs';
import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
import {
  resolveSettingsSection,
  settingsSectionOpensExtensionMcp,
} from '$lib/features/settings/sections';
import { NARROW_HIDDEN_SETTINGS_SECTIONS } from '$lib/features/shell/narrow-layout';

export type { AppsTab, SettingsSectionId } from '$lib/features/settings/sections';
export type { ExtensionCenterTab } from '$lib/features/extension-center/tabs';

export type MainView = 'chats' | 'workbench';

class ShellState {
  /**
   * 宽屏主区当前视图（D90 §5.1，不持久化：启动恒为对话）。收口不变式：只有
   * `chat.select()` 把它置回 'chats'——侧栏、搜索、通知、深链、卡片跳转都经 select，
   * 自然回到对话；`openWorkbench` 只改这个值，不清 `chat.currentId`，草稿 / 已读 /
   * 右栏状态都不受影响。侧栏对话行的选中高亮据此派生（工作台打开时没有对话高亮）。
   */
  mainView = $state<MainView>('chats');

  /** 工作台此刻真的盖在对话区上：窄屏没有工作台，`mainView` 在窄屏不生效。 */
  get workbenchShown(): boolean {
    return this.mainView === 'workbench' && !narrowLayout.narrow;
  }

  /**
   * 用户主动打开工作台的次数。`chat.select()` 在开始时记下它，结算时若已变化（慢 select /
   * 启动恢复期间用户打开了工作台）就不把视图拉回对话；用户之后主动点对话行的 select
   * 记下的是新值，照常回到对话。
   */
  workbenchIntent = 0;

  openWorkbench(): void {
    this.workbenchIntent += 1;
    this.mainView = 'workbench';
  }

  /** 设置弹框是否打开。 */
  settingsOpen = $state(false);
  /** 设置弹框当前分区（左栏条目）。 */
  settingsSection = $state<SettingsSectionId>('general');
  /**
   * 打开时要滚动到的分区内锚点（[data-settings-anchor]，如「默认模型」）；
   * SettingsDialog 渲染完目标分区后消费并复位。
   */
  settingsAnchor = $state<string | null>(null);
  /**
   * 「应用」分区旧页签参数（目录 / 已连接 / 自定义）；`custom` / `mcp` / `developer`
   * 由 openSettings 改开扩展中心 MCP。SettingsDialog 经 resolveSettingsSection 消费。
   */
  settingsAppsTab = $state<AppsTab | null>(null);
  /** 右栏（Bot 详情）默认收起，保持界面简单；只在用户点击顶部药丸时展开。 */
  rightPanelCollapsed = $state(true);
  /**
   * 启动时一个 Bot 都没有：左栏「+」面板自动下拉展开引导新建；
   * AppSidebar 消费后即复位。
   */
  autoOpenStartPanel = $state(false);
  /** 扩展中心弹框（原技能市场；左栏底部入口 / 右栏技能面板入口 / 设置里的「去添加」共用）。 */
  extensionCenterOpen = $state(false);
  /** 扩展中心当前分组（Skills / 连接 / MCP）；`openExtensionCenter(tab)` 指定，用户可在弹框内切换。 */
  extensionCenterTab = $state<ExtensionCenterTab>('skills');

  /**
   * 全局搜索层是否打开（侧栏搜索按钮 / Cmd+K 共用）。状态放 shell 而不是 AppSidebar：
   * 窄屏下侧栏只在「对话」列表层挂载，Cmd+K 与搜索层都要在任意 tab / 详情层可用；
   * 宽窄切换（整树重挂载）也不丢。
   */
  searchOpen = $state(false);

  openSearch(): void {
    this.searchOpen = true;
  }

  closeSearch(): void {
    this.searchOpen = false;
  }

  openExtensionCenter(tab: ExtensionCenterTab = 'skills'): void {
    this.extensionCenterTab = tab;
    this.extensionCenterOpen = true;
  }

  /**
   * 打开设置弹框，可指定初始分组与分组内锚点（如「模型 → 默认模型」）；`apps` 分组可
   * 再带一个旧页签参数：`custom` / `mcp` / `developer` 改开扩展中心 MCP，其余忽略
   * （「应用」= 已连接账号管理）。
   *
   * 窄屏重路由（33-narrow-layout）：不打开弹框——不带分区落到 NarrowSettings
   * 分组列表页，带分区直达该分组详情页；「通讯录」「用户画像」是底部 tab，
   * 深链直接切 tab。
   */
  openSettings(section?: SettingsSectionId, anchor?: string, appsTab?: AppsTab): void {
    if (section !== undefined && settingsSectionOpensExtensionMcp(section, appsTab)) {
      this.closeSettings();
      this.openExtensionCenter('mcp');
      return;
    }
    if (narrowLayout.narrow) {
      if (section === undefined) {
        this.narrowSettingsSection = null;
        this.narrowSettingsAnchor = null;
        this.narrowSettingsFromLink = false;
        this.narrowSettingsOpen = true;
        return;
      }
      const resolved = resolveSettingsSection(section, appsTab);
      if (NARROW_HIDDEN_SETTINGS_SECTIONS.has(resolved.section)) {
        narrowLayout.selectTab(resolved.section === 'contacts' ? 'contacts' : 'me');
        return;
      }
      this.narrowSettingsSection = resolved.section;
      this.narrowSettingsAnchor = anchor ?? null;
      // 深链直达详情页：返回一次回到来源页（聊天里的「去配置模型」等），不是分组列表。
      this.narrowSettingsFromLink = true;
      this.narrowSettingsOpen = true;
      return;
    }
    this.settingsSection = section ?? 'general';
    this.settingsAnchor = anchor ?? null;
    this.settingsAppsTab = appsTab ?? null;
    this.settingsOpen = true;
  }

  /**
   * 收起设置：宽屏弹框与窄屏全屏页统一关闭——调用方（设置里「去扩展中心」、新建 Bot
   * 后进会话等）不用区分当前是哪种形态，否则窄屏的 z-50 设置页会盖在已切走的 tab 之上。
   */
  closeSettings(): void {
    this.settingsOpen = false;
    this.closeNarrowSettings();
  }

  /**
   * 窄屏设置全屏页（33-narrow-layout）：`narrowSettingsSection` 为 null 是分组
   * 列表页，否则是分组详情页；由 NarrowSettings 渲染，宽屏不用。
   */
  narrowSettingsOpen = $state(false);
  narrowSettingsSection = $state<SettingsSectionId | null>(null);
  /** 打开详情页时要滚动到的分区内锚点；NarrowSettings 渲染完消费并复位。 */
  narrowSettingsAnchor = $state<string | null>(null);

  /** 详情页是否由深链直达（返回一次回到来源页，而不是先回分组列表）。 */
  narrowSettingsFromLink = $state(false);

  closeNarrowSettings(): void {
    this.narrowSettingsOpen = false;
    this.narrowSettingsSection = null;
    this.narrowSettingsAnchor = null;
    this.narrowSettingsFromLink = false;
  }

  /** 列表页点进某个分组详情。 */
  selectNarrowSettingsSection(section: SettingsSectionId): void {
    this.narrowSettingsSection = section;
    this.narrowSettingsFromLink = false;
  }

  /**
   * 窄屏设置页的「返回」：列表点进的详情回列表；深链直达的详情与列表页本身都直接
   * 关闭页面（回到来源页）。Esc 同路径。
   */
  backNarrowSettings(): void {
    if (this.narrowSettingsSection !== null && !this.narrowSettingsFromLink) {
      this.narrowSettingsSection = null;
      this.narrowSettingsAnchor = null;
      return;
    }
    this.closeNarrowSettings();
  }

  /**
   * 宽 / 窄形态切换时统一复位设置类浮层状态：宽屏的 SettingsDialog 与窄屏的
   * NarrowSettings 是两套互不相通的状态，不复位会出现「窄屏设置页开着→拉宽→再拉窄，
   * 设置页自己弹出」或「宽屏弹框开着拉窄，弹框还留在窄屏里」。底部 tab 回到「对话」，
   * 往返后落点可预期。Bot 详情覆盖层由 BotDetailOverlay 按「是否仍需覆盖层」自行收放。
   */
  resetForLayoutChange(): void {
    this.settingsOpen = false;
    this.closeNarrowSettings();
    narrowLayout.tab = 'chats';
  }

  /**
   * 右栏要切到的标签（D80：回执卡 / 提议卡 / 定时消息标签的「全部定时任务」）；
   * RightPanel 消费后复位。
   */
  rightPanelTabRequest = $state<string | null>(null);

  toggleRightPanel(): void {
    this.rightPanelCollapsed = !this.rightPanelCollapsed;
  }

  /** 展开右栏并切到「定时任务」（群聊右栏是群信息，定时任务分区在其中）。 */
  openSchedules(): void {
    this.rightPanelCollapsed = false;
    this.rightPanelTabRequest = 'schedules';
  }

  /**
   * 右栏切到页签后要滚动到的锚点（[data-settings-anchor]，如 Bot 配置里的「模型」）；
   * RightPanel 渲染完目标页签后消费并复位。
   */
  botPanelAnchor = $state<string | null>(null);

  /**
   * 打开 Bot 详情并切到页签、滚到锚点（对话内设置卡的「在设置中打开」，
   * todo/conversational-app-setup.md §6.1）。窄屏 / 宽屏放不下并排右栏时右栏是覆盖层
   * （BotDetailOverlay），其余展开右栏。
   */
  openBotPanel(tab: string, anchor?: string): void {
    if (sidebarLayout.panelAsOverlay) narrowLayout.openBotDetail();
    else this.rightPanelCollapsed = false;
    this.rightPanelTabRequest = tab;
    this.botPanelAnchor = anchor ?? null;
  }

  /**
   * 请求打开当前会话所绑工作目录的「工作目录设置」对话框（可带锚点）：WorkdirSelector（Bot 配置页签 /
   * 群信息里）消费并复位；会话还没绑工作目录时改开选择框。
   */
  workdirSettingsRequest = $state<{ anchor: string | null } | null>(null);

  openWorkdirSettings(anchor?: string): void {
    this.openBotPanel('profile');
    this.workdirSettingsRequest = { anchor: anchor ?? null };
  }
}

export const shell = new ShellState();

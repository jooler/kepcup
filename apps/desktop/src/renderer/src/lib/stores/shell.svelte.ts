/**
 * 全局外壳状态。主界面只有对话一个视图；设置与通讯录都以弹框呈现
 * （通讯录是设置弹框中的一个分组），不再整页替换主区域。
 * 窄屏（33-narrow-layout）例外：设置改走 NarrowSettings 全屏页，通讯录 /
 * 用户画像直达底部 tab——见 openSettings 的重路由。
 */
import type { AppsTab, SettingsSectionId } from '$lib/features/settings/sections';
import type { ExtensionCenterTab } from '$lib/features/extension-center/tabs';
import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
import { resolveSettingsSection } from '$lib/features/settings/sections';
import { NARROW_HIDDEN_SETTINGS_SECTIONS } from '$lib/features/shell/narrow-layout';

export type { AppsTab, SettingsSectionId } from '$lib/features/settings/sections';
export type { ExtensionCenterTab } from '$lib/features/extension-center/tabs';

class ShellState {
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
   * 「应用」分区要落在的页签（D73 §5.9：目录 / 已连接 / 自定义）；`mcp` 别名固定落
   * 「自定义」。SettingsDialog 经 resolveSettingsSection 消费。
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

  openExtensionCenter(tab: ExtensionCenterTab = 'skills'): void {
    this.extensionCenterTab = tab;
    this.extensionCenterOpen = true;
  }

  /**
   * 打开设置弹框，可指定初始分组与分组内锚点（如「模型 → 默认模型」）；`apps` 分组可
   * 再带一个旧页签参数：`custom` 落「开发者模式」分区，其余忽略（「应用」= 已连接账号管理）。
   *
   * 窄屏重路由（33-narrow-layout）：不打开弹框——不带分区落到 NarrowSettings
   * 分组列表页，带分区直达该分组详情页；「通讯录」「用户画像」是底部 tab，
   * 深链直接切 tab。
   */
  openSettings(section?: SettingsSectionId, anchor?: string, appsTab?: AppsTab): void {
    if (narrowLayout.narrow) {
      if (section === undefined) {
        this.narrowSettingsSection = null;
        this.narrowSettingsAnchor = null;
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
      this.narrowSettingsOpen = true;
      return;
    }
    this.settingsSection = section ?? 'general';
    this.settingsAnchor = anchor ?? null;
    this.settingsAppsTab = appsTab ?? null;
    this.settingsOpen = true;
  }

  closeSettings(): void {
    this.settingsOpen = false;
  }

  /**
   * 窄屏设置全屏页（33-narrow-layout）：`narrowSettingsSection` 为 null 是分组
   * 列表页，否则是分组详情页；由 NarrowSettings 渲染，宽屏不用。
   */
  narrowSettingsOpen = $state(false);
  narrowSettingsSection = $state<SettingsSectionId | null>(null);
  /** 打开详情页时要滚动到的分区内锚点；NarrowSettings 渲染完消费并复位。 */
  narrowSettingsAnchor = $state<string | null>(null);

  closeNarrowSettings(): void {
    this.narrowSettingsOpen = false;
    this.narrowSettingsSection = null;
    this.narrowSettingsAnchor = null;
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
}

export const shell = new ShellState();

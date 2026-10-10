/**
 * 全局外壳状态。主界面只有对话一个视图；设置与通讯录都以弹框呈现
 * （通讯录是设置弹框中的一个分组），不再整页替换主区域。
 */
import type { AppsTab, SettingsSectionId } from '$lib/features/settings/sections';
import type { ExtensionCenterTab } from '$lib/features/extension-center/tabs';

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
   * 再指定页签（缺省「目录」）。
   */
  openSettings(section: SettingsSectionId = 'general', anchor?: string, appsTab?: AppsTab): void {
    this.settingsSection = section;
    this.settingsAnchor = anchor ?? null;
    this.settingsAppsTab = appsTab ?? null;
    this.settingsOpen = true;
  }

  closeSettings(): void {
    this.settingsOpen = false;
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

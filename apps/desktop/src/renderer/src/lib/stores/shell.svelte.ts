/**
 * 全局外壳状态。主界面只有对话一个视图；设置与通讯录都以弹框呈现
 * （通讯录是设置弹框中的一个分组），不再整页替换主区域。
 */
export type SettingsSectionId =
  | 'general'
  | 'models'
  | 'search'
  | 'mcp'
  | 'profile'
  | 'contacts'
  | 'unattended'
  | 'environment'
  | 'usage'
  | 'diagnostics';

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
  /** 右栏（Bot 详情）默认收起，保持界面简单；只在用户点击顶部药丸时展开。 */
  rightPanelCollapsed = $state(true);
  /**
   * 启动时一个 Bot 都没有：左栏「+」面板自动下拉展开引导新建；
   * AppSidebar 消费后即复位。
   */
  autoOpenStartPanel = $state(false);
  /** 技能市场弹框（左栏底部入口 / 右栏技能面板入口共用）。 */
  skillMarketOpen = $state(false);

  openSkillMarket(): void {
    this.skillMarketOpen = true;
  }

  /** 打开设置弹框，可指定初始分组与分组内锚点（如「模型 → 默认模型」）。 */
  openSettings(section: SettingsSectionId = 'general', anchor?: string): void {
    this.settingsSection = section;
    this.settingsAnchor = anchor ?? null;
    this.settingsOpen = true;
  }

  closeSettings(): void {
    this.settingsOpen = false;
  }

  toggleRightPanel(): void {
    this.rightPanelCollapsed = !this.rightPanelCollapsed;
  }
}

export const shell = new ShellState();

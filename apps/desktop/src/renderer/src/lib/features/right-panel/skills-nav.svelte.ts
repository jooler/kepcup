/**
 * 技能 Tab 的下钻位置（与 memoryNav / wikiStore 同理：状态放在 Tab 组件外，
 * RightPanel 的 DetailHeader 也要读）。进入单个技能详情时 DetailHeader 隐藏
 * 「< Skills」一行，由 SkillsTab 详情里的「返回」接管；离开技能 Tab 时
 * SkillsTab 的清理 effect 归位。
 */
class SkillsNav {
  /** 当前查看的技能名（null = 列表态）。 */
  selectedName = $state<string | null>(null);

  reset(): void {
    this.selectedName = null;
  }
}

export const skillNav = new SkillsNav();

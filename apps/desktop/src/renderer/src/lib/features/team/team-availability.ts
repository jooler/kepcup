import { SvelteSet } from 'svelte/reactivity';

/**
 * 「团队设置」分区是否可用的共享状态（T7 步骤 5）：web 团队端点（T5，
 * teamContext 激活）与桌面融合视图（已配置并融合的团队来源）都会置位。
 *
 * 纯 TS 模块（同 surface-gate 的先例：预编译响应式基元，node 单测可直接
 * 引用）。写方：team-context（begin / reset）与 contacts 的团队切片接线
 *（来源出现 / 移除）。休眠语义：集合为空 = 没有团队上下文——设置导航
 * 不出现「团队」分区，客户端与现状一致（逐 PR 验收项）。
 */
export const teamSectionSources = new SvelteSet<string>();

/** 「团队」设置分区此刻是否应出现。 */
export function isTeamSectionAvailable(): boolean {
  return teamSectionSources.size > 0;
}

/** 置 / 清一个来源的可用标记（'local' 或 serverHash）。 */
export function markTeamSectionSource(key: string, available: boolean): void {
  if (available) teamSectionSources.add(key);
  else teamSectionSources.delete(key);
}

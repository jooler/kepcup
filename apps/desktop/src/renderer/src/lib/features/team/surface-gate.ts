import { SvelteSet } from 'svelte/reactivity';

/**
 * 团队 surfaces 门控的共享状态（T5，62.03 §5 / 62.08 §3）：被
 * `team.bootstrap.surfaces.hidden` 拒绝的渲染层入口 id 集合。值域 =
 * SettingsSectionId ∪ EndpointCapabilityId ∪ 'extension-center' | 'bot-create'
 * | 'bot-edit' | 'workdir-pick'（shared TEAM_SURFACE_IDS；未知 id 渲染层当作
 * 「不可见」处理——列表过期只影响体验层，永远不是安全边界，62.03 §3）。
 *
 * 纯 TS 模块（不用 `$state` runes）：被 node 单测环境直接引用
 * （settings/sections.ts 的深链回落不经过 Svelte 编译、desktop 项目也没有
 * `$lib` 别名），响应式基元只用 svelte/reactivity 的预编译实现——普通 node
 * 可导入，$derived 中的读取照常响应式更新。
 *
 * 唯一写方是 team-context.svelte.ts（bootstrap 成功 / 重连刷新 / reset）。
 * 休眠语义：集合为空 = 非团队上下文或没有隐藏入口——`isTeamHidden` 恒 false，
 * 所有消费点行为与现状一致（逐 PR 验收项）。
 */
export const teamHiddenSurfaces = new SvelteSet<string>();

/** 入口门控判定；非团队上下文（集合为空）恒 false。 */
export function isTeamHidden(id: string): boolean {
  return teamHiddenSurfaces.has(id);
}

/** 整组替换隐藏集合（bootstrap 全量收敛；reset 清空）。 */
export function setTeamHiddenSurfaces(ids: readonly string[]): void {
  teamHiddenSurfaces.clear();
  for (const id of ids) teamHiddenSurfaces.add(id);
}

/**
 * 「团队服务器」连接流程的纯逻辑（设置卡步骤一：地址 → 健康检查）。
 *
 * 组件只负责把结果画出来；地址预检与「探测结果 → 失败原因」的映射放在这里，
 * node 环境可直接单测（不加载 Svelte / DOM）。
 */

import type { TeamServerProbeResult } from './platform-team-servers';

/**
 * 地址校验（与主进程 normalizeTeamServerUrl 同口径的轻量前端预检）：trim、
 * 只允许 http(s)、禁止内嵌用户名密码；query / hash 剥掉，保留 path。
 */
export function normalizeTeamServerAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return null;
  }
}

/** 健康检查失败类别（设置卡弹框按类别出文案；detail 是主进程给的原始原因）。 */
export type TeamServerProbeFailureKind = 'unreachable' | 'personal' | 'unknown';

export interface TeamServerProbeFailure {
  kind: TeamServerProbeFailureKind;
  detail: string | null;
}

/**
 * 探测结果 → 失败原因；`null` = 健康检查通过，可以登记并进入登录步骤。
 * `kind='team'` 的未认证（401/403）算通过：那正是待登录的团队服务器。
 */
export function probeFailureOf(result: TeamServerProbeResult): TeamServerProbeFailure | null {
  if (!result.reachable) return { kind: 'unreachable', detail: result.detail ?? null };
  if (result.kind === 'personal') return { kind: 'personal', detail: result.detail ?? null };
  if (result.kind !== 'team') return { kind: 'unknown', detail: result.detail ?? null };
  return null;
}

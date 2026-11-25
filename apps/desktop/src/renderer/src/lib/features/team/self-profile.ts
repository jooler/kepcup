import { connections, serverHashOf } from '$lib/rpc/connections.svelte';

/**
 * 成员自助资料更新（`team.member.updateSelf`，2026-11 web 个人资料分区）：
 * web 团队端点的身份字段（显示名 / 头像）直接落在服务端成员行上——成员侧
 * `settings.update` 是 admin plane 被拒；桌面端点的身份仍以本机设置为准
 * （settings.userProfileName），融合连接在线时把变更 best-effort 推给各团队
 * 服务器，实现「客户端设置的名称 → 服务端显示名」的一致性（62.03 §5 的成员
 * 身份面）。成功后服务端广播 member.updated，名册各方自动收敛。
 */

export interface SelfProfilePatch {
  displayName?: string;
  avatar?: string | null;
}

/**
 * 把自己的资料补丁推给每个已连接的团队来源（web 团队端点没有 `team:*` 来源，
 * 调用方在端点分支里走 `core.callTeam` 直连）。返回失败数（0 = 全部成功）；
 * 单个来源失败不拖累其它来源（best-effort，调用方决定是否提示）。
 */
export async function pushSelfProfileToTeamSources(patch: SelfProfilePatch): Promise<number> {
  const targets = connections
    .sources()
    .filter((source) => serverHashOf(source) !== null && connections.get(source).status === 'connected');
  const results = await Promise.all(
    targets.map((source) =>
      connections
        .get(source)
        .callTeam('team.member.updateSelf', patch)
        .then(
          () => true,
          () => false,
        ),
    ),
  );
  return results.filter((ok) => !ok).length;
}

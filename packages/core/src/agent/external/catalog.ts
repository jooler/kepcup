import {
  AGENT_CATALOG,
  AppError,
  agentSetupReasonOf,
  filterReleasedAgents,
  findAgentEntry,
  type AgentCatalogEntry,
  type AgentSetupReason,
  type AgentView,
  type Settings,
} from '@kepcup/shared';

/**
 * 生效目录与可用性门禁（D72）。
 *
 * 发行门禁：打包脚本（apps/desktop/scripts/dist.mjs）以 esbuild define 注入
 * `__KEPCUP_AGENT_RELEASE_GATES__`（放行清单）；开发构建、tsc 产物与测试中
 * 该常量不存在 → 不过滤（全部条目可用，含 Claude Agent 等待定条目）。
 */
export function approvedReleaseGates(): readonly string[] | null {
  return typeof __KEPCUP_AGENT_RELEASE_GATES__ === 'undefined'
    ? null
    : __KEPCUP_AGENT_RELEASE_GATES__;
}

/** 内置策展目录 + 测试注入条目，按发行门禁过滤。 */
export function effectiveAgentCatalog(
  extra: readonly AgentCatalogEntry[] = [],
): AgentCatalogEntry[] {
  return filterReleasedAgents([...AGENT_CATALOG, ...extra], approvedReleaseGates());
}

/**
 * 把 Bot 设为外部 Agent 的 RPC 门禁：实验开关关闭时拒绝（目录对用户不可见），
 * 目录中不存在的 id 拒绝。`agentId` 为空（内置引擎）恒放行。
 */
export function assertAgentSelectable(
  settings: Settings,
  catalog: readonly AgentCatalogEntry[],
  agentId: string,
): void {
  if (agentId.length === 0) return;
  if (!settings.experimental.externalAgents) {
    throw new AppError(
      'INVALID_INPUT',
      '外部智能体是实验功能：请先在设置中开启「外部智能体（实验）」',
    );
  }
  if (findAgentEntry(catalog, agentId) === null) {
    throw new AppError('INVALID_INPUT', `智能体「${agentId}」不在目录中`);
  }
}

/**
 * run 开工前的门禁（D58 按 Bot 引擎判定）：外部 Agent Bot 要求实验开关打开、
 * 条目在目录中、已启用且本机状态可用（`view` 为 AgentsService 的状态视图；
 * 未装配时只看启用开关）。返回 null 表示可以开跑；否则为失败文案 + 设置卡
 * 原因（`reason` 为 null = 普通失败，如条目已不在目录中）。
 */
export function agentRunGate(
  settings: Settings,
  catalog: readonly AgentCatalogEntry[],
  agentId: string,
  view?: (agentId: string) => Pick<AgentView, 'enabled' | 'status' | 'statusDetail'> | null,
): { message: string; reason: AgentSetupReason | null } | null {
  if (!settings.experimental.externalAgents) {
    return {
      message: '外部智能体（实验）未开启：请在设置中开启，或把该 Bot 切回内置模型',
      reason: 'experimental_off',
    };
  }
  const entry = findAgentEntry(catalog, agentId);
  if (entry === null) {
    return {
      message: `智能体「${agentId}」不在目录中：请为该 Bot 重新选择模型或智能体`,
      reason: null,
    };
  }
  const state =
    view !== undefined
      ? view(agentId)
      : {
          enabled: settings.agents[agentId]?.enabled === true,
          status: 'ready' as const,
          statusDetail: null,
        };
  const reason = agentSetupReasonOf(state, true);
  if (reason === null) return null;
  return { message: agentSetupMessage(entry.name, reason, state?.statusDetail ?? null), reason };
}

/** 设置卡原因的用户可读文案（`run.error`；界面以设置卡为主）。 */
export function agentSetupMessage(
  agentName: string,
  reason: AgentSetupReason,
  detail: string | null = null,
): string {
  const suffix = detail !== null && detail.length > 0 ? `（${detail}）` : '';
  switch (reason) {
    case 'experimental_off':
      return '外部智能体（实验）未开启：请在设置中开启，或把该 Bot 切回内置模型';
    case 'not_enabled':
      return `智能体「${agentName}」未启用：请先启用`;
    case 'not_installed':
      return `智能体「${agentName}」未安装或安装未完成${suffix}`;
    case 'auth_required':
      return `智能体「${agentName}」未登录：请先完成官方登录`;
    case 'incompatible':
      return `智能体「${agentName}」版本不兼容${suffix}`;
    case 'unavailable':
      return `智能体「${agentName}」暂不可用${suffix}`;
    case 'sandbox_unavailable':
      return `智能体「${agentName}」的沙箱无法启动${suffix}`;
    case 'config_unsafe':
      return `智能体「${agentName}」的个人配置放行了需要 KepCup 确认的操作，已拒绝运行${suffix}`;
  }
}

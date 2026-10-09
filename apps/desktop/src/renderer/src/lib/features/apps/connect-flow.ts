import type {
  AppConnectFlowPayload,
  AppConnection,
  AppConnectionStatus,
  AppConnectTarget,
} from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 连接应用（D73，docs/design/29-connected-apps.md §5 / §6 / §9）渲染端纯函数：
 * 目标键、流程阶段分类与文案键、授权 URL 拆分（突出域名）、连接 / 流程列表的
 * 增量合并。store（stores/apps.svelte.ts）与 ConnectAppPanel 共用；无 DOM / 运行时依赖，
 * 便于单测。
 */

export type FlowPhase = AppConnectFlowPayload['phase'];

/** 一个进行中 / 刚结束的交互授权流程（事件按 flowId 累积合并）。 */
export interface FlowView {
  flowId: string;
  phase: FlowPhase;
  authorizationHost?: string | undefined;
  authorizationUrl?: string | undefined;
  connectionId?: string | undefined;
  error?: AppConnectFlowPayload['error'] | undefined;
}

// --- 连接目标 ------------------------------------------------------------------

/** 自定义 server 的连接 id（与 core 约定：`custom:{serverId}`）。 */
export function customConnectionId(serverId: string): string {
  return `custom:${serverId}`;
}

/** 目标的稳定键（store 里按目标索引当前流程）。 */
export function targetKey(target: AppConnectTarget): string {
  return target.kind === 'custom'
    ? customConnectionId(target.serverId)
    : `catalog:${target.connectorId}`;
}

/** 目标对应的连接行：自定义按 `custom:{serverId}` id，目录按 connectorId（多账号时取第一个）。 */
export function connectionForTarget(
  connections: readonly AppConnection[],
  target: AppConnectTarget,
): AppConnection | null {
  if (target.kind === 'custom') {
    const id = customConnectionId(target.serverId);
    return connections.find((connection) => connection.id === id) ?? null;
  }
  return connections.find((connection) => connection.connectorId === target.connectorId) ?? null;
}

// --- 流程阶段 ------------------------------------------------------------------

export function isTerminalPhase(phase: FlowPhase): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

/** 仍在进行（可取消）的阶段。 */
export function isActivePhase(phase: FlowPhase): boolean {
  return !isTerminalPhase(phase);
}

export const FLOW_PHASE_LABEL_KEYS: Record<FlowPhase, MessageKey> = {
  discovering: 'apps.phase.discovering',
  awaiting_consent: 'apps.phase.awaitingConsent',
  awaiting_browser: 'apps.phase.awaitingBrowser',
  exchanging: 'apps.phase.exchanging',
  reviewing_tools: 'apps.phase.reviewingTools',
  done: 'apps.phase.done',
  failed: 'apps.phase.failed',
  cancelled: 'apps.phase.cancelled',
};

/** 阶段进度（1..4，用于步骤指示）；终态不参与。 */
export function phaseStep(phase: FlowPhase): number {
  switch (phase) {
    case 'discovering':
      return 1;
    case 'awaiting_consent':
      return 2;
    case 'awaiting_browser':
      return 3;
    case 'exchanging':
      return 4;
    default:
      return 0;
  }
}
export const FLOW_STEP_COUNT = 4;

export const CONNECTION_STATUS_LABEL_KEYS: Record<AppConnectionStatus, MessageKey> = {
  not_connected: 'apps.status.not_connected',
  connecting: 'apps.status.connecting',
  connected: 'apps.status.connected',
  expired: 'apps.status.expired',
  needs_scope: 'apps.status.needs_scope',
  tools_changed: 'apps.status.tools_changed',
  error: 'apps.status.error',
  disabled: 'apps.status.disabled',
};

/** 已授权但需要用户再次动作（重新连接 / 复核）的状态。 */
export function statusNeedsReconnect(status: AppConnectionStatus): boolean {
  return status === 'expired' || status === 'needs_scope';
}

/** 连接仍持有有效授权（可「断开」）。 */
export function statusHasGrant(status: AppConnectionStatus): boolean {
  return status !== 'not_connected' && status !== 'connecting';
}

// --- 错误 ----------------------------------------------------------------------

export const OAUTH_CLIENT_REQUIRED_CODE = 'OAUTH_CLIENT_REQUIRED';

const FLOW_ERROR_KEYS: Record<string, MessageKey> = {
  OAUTH_FLOW_FAILED: 'apps.error.OAUTH_FLOW_FAILED',
  OAUTH_FLOW_CANCELLED: 'apps.error.OAUTH_FLOW_CANCELLED',
  OAUTH_FLOW_TIMEOUT: 'apps.error.OAUTH_FLOW_TIMEOUT',
  OAUTH_CLIENT_REQUIRED: 'apps.error.OAUTH_CLIENT_REQUIRED',
  OAUTH_ISSUER_MISMATCH: 'apps.error.OAUTH_ISSUER_MISMATCH',
  OAUTH_INSECURE_ENDPOINT: 'apps.error.OAUTH_INSECURE_ENDPOINT',
  APP_CONNECTION_NOT_FOUND: 'apps.error.APP_CONNECTION_NOT_FOUND',
};

/** 流程错误码的本地化文案键；未知码返回 null（调用方回落到 core 给的 message）。 */
export function flowErrorKey(code: string): MessageKey | null {
  return FLOW_ERROR_KEYS[code] ?? null;
}

/** 失败的流程是否在等用户手填客户端（OAUTH_CLIENT_REQUIRED）。 */
export function needsClientCredentials(flow: FlowView | null | undefined): boolean {
  return flow?.phase === 'failed' && flow.error?.code === OAUTH_CLIENT_REQUIRED_CODE;
}

// --- 授权 URL ------------------------------------------------------------------

export interface SplitUrl {
  /** 主机之前的部分（`https://`，含 userinfo 时一并算入以便肉眼察觉）。 */
  prefix: string;
  /** 主机（含端口），界面加粗突出。 */
  host: string;
  /** 主机之后的路径 / 查询。 */
  rest: string;
}

/**
 * 把授权 URL 拆成「前缀 / 域名 / 其余」，让界面突出域名（防钓鱼：用户核对的是
 * 域名）。解析失败时整串作为 rest 展示，不丢信息。
 */
export function splitAuthorizationUrl(url: string): SplitUrl {
  try {
    const parsed = new URL(url);
    const schemeEnd = url.indexOf('//');
    const afterScheme = schemeEnd >= 0 ? schemeEnd + 2 : 0;
    // 主机在原串里的位置：userinfo（若有）算前缀。
    const hostStart = url.toLowerCase().indexOf(parsed.host, afterScheme);
    if (hostStart < 0) return { prefix: '', host: '', rest: url };
    return {
      prefix: url.slice(0, hostStart),
      host: parsed.host,
      rest: url.slice(hostStart + parsed.host.length),
    };
  } catch {
    return { prefix: '', host: '', rest: url };
  }
}

// --- 增量合并 ------------------------------------------------------------------

/** 合并一条 `apps.connect_flow` 事件到流程表（同 flowId 取最新；字段缺省则保留旧值）。 */
export function applyFlowEvent(
  flows: Readonly<Record<string, FlowView>>,
  payload: AppConnectFlowPayload,
): Record<string, FlowView> {
  const previous = flows[payload.flowId];
  const next: FlowView = {
    flowId: payload.flowId,
    phase: payload.phase,
    authorizationHost: payload.authorizationHost ?? previous?.authorizationHost,
    authorizationUrl: payload.authorizationUrl ?? previous?.authorizationUrl,
    connectionId: payload.connectionId ?? previous?.connectionId,
    // error 只属于失败流程：失败事件缺省时沿用旧值，其他阶段不带。
    error: payload.error ?? (payload.phase === 'failed' ? previous?.error : undefined),
  };
  return { ...flows, [payload.flowId]: next };
}

/** 更新（或插入）一条连接，保持按 createdAt 稳定顺序。 */
export function upsertConnection(
  connections: readonly AppConnection[],
  connection: AppConnection,
): AppConnection[] {
  const index = connections.findIndex((item) => item.id === connection.id);
  if (index === -1) return [...connections, connection];
  return connections.map((item, i) => (i === index ? connection : item));
}

/** 应用 `apps.connection_status`：已知连接就地改状态；未知返回 null（调用方重拉列表）。 */
export function applyConnectionStatus(
  connections: readonly AppConnection[],
  connectionId: string,
  status: AppConnectionStatus,
): AppConnection[] | null {
  if (!connections.some((item) => item.id === connectionId)) return null;
  return connections.map((item) => (item.id === connectionId ? { ...item, status } : item));
}

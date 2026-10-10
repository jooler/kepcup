import type {
  AppCatalogEntry,
  AppConnectFlowPayload,
  AppConnectReviewTool,
  AppConnection,
  AppConnectionStatus,
  AppConnectTarget,
  McpToolRisk,
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
  /** `reviewing_tools` 起：识别出的账号显示名。 */
  accountLabel?: string | undefined;
  /** `reviewing_tools`：待用户确认的工具清单（其他阶段不带）。 */
  tools?: AppConnectReviewTool[] | undefined;
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

/**
 * 连接面板呈现（并据此显示状态 / 「重新连接」/ 「断开」）的连接行：自定义 server 取其唯一行
 * （`custom:{serverId}`）；目录目标只认显式指定的重连行（`reconnectConnectionId`）——没指定
 * 就是「再连一个账号」，不能拿该应用的第一个账号充数（否则面板显示的是别的账号的状态，
 * 按钮写着「重新连接」却会新建账号）。
 */
export function panelConnection(
  connections: readonly AppConnection[],
  target: AppConnectTarget,
  reconnectConnectionId?: string | undefined,
): AppConnection | null {
  if (target.kind === 'custom') return connectionForTarget(connections, target);
  if (reconnectConnectionId === undefined) return null;
  return connections.find((connection) => connection.id === reconnectConnectionId) ?? null;
}

export interface ContinueCandidate {
  connection: AppConnection;
  /** 目录连接尚未授权给当前 Bot：继续前要先写进 Profile，否则续跑还会再出一张卡。 */
  needsGrant: boolean;
}

/**
 * 对话卡「已连接，继续对话」能直接用的连接：requirement 指明了连接（重连 / 追加权限 /
 * 断开后的旧行）就只看它；目录目标没指明（未连接）时取该应用已有的账号——优先 Bot 已持有
 * 的，其次第一个已连接的（继续前要授权给 Bot）。只有状态 `connected` 的才算；无则 null。
 */
export function continueCandidate(
  connections: readonly AppConnection[],
  target: AppConnectTarget,
  connectionId: string | undefined,
  botAppConnectionIds: readonly string[],
): ContinueCandidate | null {
  const explicit = panelConnection(connections, target, connectionId);
  if (target.kind === 'custom') {
    return explicit !== null && explicit.status === 'connected'
      ? { connection: explicit, needsGrant: false }
      : null;
  }
  let chosen: AppConnection | null = explicit;
  if (connectionId === undefined) {
    const held = botConnectionForConnector(botAppConnectionIds, connections, target.connectorId);
    chosen =
      [held, ...connections.filter((item) => item.connectorId === target.connectorId)].find(
        (item): item is AppConnection => item !== null && item.status === 'connected',
      ) ?? null;
  }
  if (chosen === null || chosen.status !== 'connected') return null;
  return { connection: chosen, needsGrant: !botAppConnectionIds.includes(chosen.id) };
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

/** 阶段进度（1..5，用于步骤指示）；终态不参与。 */
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
    case 'reviewing_tools':
      return 5;
    default:
      return 0;
  }
}
export const FLOW_STEP_COUNT = 5;

/** 首连工具复核阶段（§5.4）：等用户「确认并完成连接」或取消。 */
export function isReviewingPhase(phase: FlowPhase): boolean {
  return phase === 'reviewing_tools';
}

/** 复核清单按风险档计数（写入 / 破坏性的数量决定提示强度）。 */
export function summarizeReviewTools(
  tools: readonly Pick<AppConnectReviewTool, 'risk'>[],
): Record<McpToolRisk, number> & { total: number } {
  const summary = { read: 0, write: 0, destructive: 0, total: tools.length };
  for (const tool of tools) summary[tool.risk]++;
  return summary;
}

/** 复核清单的展示顺序：破坏性 → 写入 → 只读，同档按名字。不修改入参。 */
export function sortReviewTools(tools: readonly AppConnectReviewTool[]): AppConnectReviewTool[] {
  const rank: Record<McpToolRisk, number> = { destructive: 0, write: 1, read: 2 };
  return [...tools].sort(
    (a, b) => rank[a.risk] - rank[b.risk] || a.name.localeCompare(b.name, 'en'),
  );
}

// --- 目录形态 ------------------------------------------------------------------

export interface RequestedScope {
  scope: string;
  /** 属于条目的写入权限集合（追加授权时才会出现）。 */
  write: boolean;
}

/**
 * 面板上展示「将申请的权限」：显式给了 scope 集合（追加授权 = 已授予 ∪ 需追加）就按它；
 * 否则为条目默认权限。写入权限只在显式集合里出现时展示，并打上标记。
 */
export function requestedScopes(
  entry: Pick<AppCatalogEntry, 'scopes'>,
  explicit?: readonly string[] | undefined,
): RequestedScope[] {
  const write = new Set(entry.scopes.write);
  const list = explicit !== undefined ? explicit : entry.scopes.default;
  return [...new Set(list)].map((scope) => ({ scope, write: write.has(scope) }));
}

/**
 * Bot 已授权的、同一应用的连接（设计 29 §6：同一 Connector 至多一个）；连接后授权给
 * 该 Bot 时它会被替换。目录里查不到的连接 id（已删除）忽略。
 */
export function botConnectionForConnector(
  appConnectionIds: readonly string[],
  connections: readonly AppConnection[],
  connectorId: string,
): AppConnection | null {
  for (const id of appConnectionIds) {
    const connection = connections.find((item) => item.id === id);
    if (connection !== undefined && connection.connectorId === connectorId) return connection;
  }
  return null;
}

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
    accountLabel: payload.accountLabel ?? previous?.accountLabel,
    // 工具清单只属于复核阶段：复核事件缺省时沿用旧值，其他阶段不带。
    tools: payload.tools ?? (payload.phase === 'reviewing_tools' ? previous?.tools : undefined),
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

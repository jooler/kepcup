import type {
  AppCatalogEntry,
  AppConnection,
  AppConnectionStatus,
  AppToolView,
  BotProfile,
} from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * Bot 运行配置「应用」区（D73 §5.7 / §5.9，docs/design/29-connected-apps.md §6 / §9）
 * 的纯逻辑：目录连接按应用分组成单选组（不使用 / 某个账号）、写回
 * `profile.runtime.app_connection_ids`（同一应用至多一个连接——core 的 bots 领域层
 * 会拒绝多个）、所选连接的工具数估计与风险计数。组件只负责渲染。
 */

/** 自定义 server 的占位连接（`custom:{serverId}`）：走 `mcp_server_ids`，不在此列。 */
export function isCatalogConnection(
  connection: Pick<AppConnection, 'id' | 'connectorId'>,
): boolean {
  return !connection.id.startsWith('custom:') && !connection.connectorId.startsWith('custom:');
}

export interface AppAccountRow {
  connection: AppConnection;
  /** 显示名：账号标签，空则按「{应用} #{序号}」。 */
  label: string;
  selected: boolean;
  /** 过期 / 缺权限：仍可选，但提示用户去重连（工具在修复前不暴露）。 */
  needsReconnect: boolean;
}

export interface AppChoiceGroup {
  connectorId: string;
  title: string;
  description: string;
  iconDataUri: string | null;
  /** 目录里查不到（目录改版后残留的连接）。 */
  inCatalog: boolean;
  /** 条目当前能否连接（目录里 `connectable`；残留连接按 false）。 */
  connectable: boolean;
  accounts: AppAccountRow[];
  /** Bot 当前选中的连接 id（null = 不使用）。 */
  selectedConnectionId: string | null;
}

export function statusNeedsReconnect(status: AppConnectionStatus): boolean {
  return status === 'expired' || status === 'needs_scope';
}

/**
 * 目录条目 ∪ 目录连接 → 按应用分组。顺序：有连接的应用在前（Bot 能直接勾选），
 * 其后是目录里尚未连接的应用（显示「去连接」）；同组内按标题字母序，账号按创建时间。
 * Bot 选中但同应用有多个账号的情况只认第一个匹配（core 保证至多一个）。
 */
export function appChoiceGroups(
  entries: readonly AppCatalogEntry[],
  connections: readonly AppConnection[],
  selectedIds: readonly string[],
): AppChoiceGroup[] {
  const selected = new Set(selectedIds);
  const groups = new Map<string, AppChoiceGroup>();
  for (const entry of entries) {
    groups.set(entry.connectorId, {
      connectorId: entry.connectorId,
      title: entry.title,
      description: entry.description,
      iconDataUri: entry.iconDataUri,
      inCatalog: true,
      connectable: entry.connectable,
      accounts: [],
      selectedConnectionId: null,
    });
  }
  const sorted = [...connections]
    .filter(isCatalogConnection)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const connection of sorted) {
    let group = groups.get(connection.connectorId);
    if (group === undefined) {
      group = {
        connectorId: connection.connectorId,
        title: connection.connectorId,
        description: '',
        iconDataUri: null,
        inCatalog: false,
        connectable: false,
        accounts: [],
        selectedConnectionId: null,
      };
      groups.set(connection.connectorId, group);
    }
    const isSelected = selected.has(connection.id) && group.selectedConnectionId === null;
    if (isSelected) group.selectedConnectionId = connection.id;
    group.accounts.push({
      connection,
      label:
        connection.label.length > 0
          ? connection.label
          : `${group.title} #${group.accounts.length + 1}`,
      selected: isSelected,
      needsReconnect: statusNeedsReconnect(connection.status),
    });
  }
  const byTitle = (a: AppChoiceGroup, b: AppChoiceGroup): number =>
    a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
  const withAccounts = [...groups.values()].filter((group) => group.accounts.length > 0);
  const without = [...groups.values()].filter((group) => group.accounts.length === 0);
  return [...withAccounts.sort(byTitle), ...without.sort(byTitle)];
}

/**
 * 选中某应用的一个账号（或 null = 不使用）后的 `app_connection_ids`：先移除该应用的
 * 其他连接（同一 Connector 至多一个），再追加；保持其余 id 的顺序，去重。目录里查不到的
 * id 原样保留（core 校验时会报错，由用户处理）。
 */
export function selectAppConnection(
  current: readonly string[],
  connections: readonly AppConnection[],
  connectorId: string,
  connectionId: string | null,
): string[] {
  const sameApp = new Set(
    connections
      .filter((connection) => connection.connectorId === connectorId)
      .map((connection) => connection.id),
  );
  const kept = current.filter((id) => !sameApp.has(id) && id !== connectionId);
  const next = connectionId === null ? kept : [...kept, connectionId];
  return next.filter((id, index) => next.indexOf(id) === index);
}

/**
 * 对话卡「连接后授权给当前 Bot」的渲染端兜底（§5.8 群聊：core 只认第一个
 * `apps.connect` 的 `grantBotId`，后加入同一流程的卡片完成后自己补写 Profile）：
 * 已包含则返回 null（无需写），否则返回加入（并替换同应用旧账号）后的 Profile。
 */
export function profileWithAppConnection(
  profile: BotProfile,
  connections: readonly AppConnection[],
  connectionId: string,
): BotProfile | null {
  const current = profile.runtime.app_connection_ids;
  if (current.includes(connectionId)) return null;
  const connection = connections.find((item) => item.id === connectionId);
  if (connection === undefined) return null;
  return {
    ...profile,
    runtime: {
      ...profile.runtime,
      app_connection_ids: selectAppConnection(
        current,
        connections,
        connection.connectorId,
        connectionId,
      ),
    },
  };
}

export interface AppToolEstimate {
  /** 已确认的可用（已批准、未停用）工具数。 */
  count: number;
  /** 写入 / 破坏性且可用的工具数（无人值守提示用）。 */
  risky: number;
  /** 有连接的清单没取到（连不上 / 查询失败）：数量不完整。 */
  unknown: boolean;
}

/** 单个连接里会暴露给模型的工具（已批准 + 未停用）。 */
export function exposedTools(tools: readonly AppToolView[]): AppToolView[] {
  return tools.filter((tool) => tool.exposed);
}

/**
 * 所选连接的工具数估计：`toolsById[id]` 缺失（尚未取到 / 失败）= unknown；过期 / 缺权限的
 * 连接不暴露工具（§5.7），不计入。
 */
export function appToolEstimate(
  selected: readonly AppConnection[],
  toolsById: Readonly<Record<string, readonly AppToolView[] | null | undefined>>,
): AppToolEstimate {
  let count = 0;
  let risky = 0;
  let unknown = false;
  for (const connection of selected) {
    if (statusNeedsReconnect(connection.status) || connection.status === 'disabled') continue;
    const tools = toolsById[connection.id];
    if (tools === undefined || tools === null) {
      unknown = true;
      continue;
    }
    const exposed = exposedTools(tools);
    count += exposed.length;
    risky += exposed.filter((tool) => tool.risk !== 'read').length;
  }
  return { count, risky, unknown };
}

/** 账号行状态提示的文案键（只有需要用户处理的状态才有）。 */
export function accountHintKey(status: AppConnectionStatus): MessageKey | null {
  switch (status) {
    case 'expired':
      return 'contacts.appsAccountExpired';
    case 'needs_scope':
      return 'contacts.appsAccountNeedsScope';
    case 'tools_changed':
      return 'contacts.appsAccountToolsChanged';
    case 'disabled':
      return 'contacts.appsAccountDisabled';
    case 'error':
      return 'contacts.appsAccountError';
    default:
      return null;
  }
}

/** §5.10：外部智能体 + `apps` 能力包生效时的一次性提示，是否该弹（已确认过则不弹）。 */
export function shouldShowAcpAppsNotice(input: {
  agentSelected: boolean;
  appsCapabilityChecked: boolean;
  acknowledged: boolean;
}): boolean {
  return input.agentSelected && input.appsCapabilityChecked && !input.acknowledged;
}

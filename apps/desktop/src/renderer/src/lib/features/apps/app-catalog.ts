import type {
  AppCatalogEntry,
  AppConnection,
  AppConnectionStatus,
  Bot,
  ConnectorCategory,
  ConnectorTier,
} from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 设置「应用」分区（D73 §5.9）渲染端纯函数：目录筛选 / 排序、连接按应用分组、
 * 状态 → 徽标映射、Bot 授权关系（受影响 Bot）、最近使用文案。store
 * （stores/app-catalog.svelte.ts）与各子组件共用；无 DOM / 运行时依赖，便于单测。
 */

// --- 目录 ----------------------------------------------------------------------

/** 分类筛选的展示顺序（目录里实际出现的才显示）。 */
export const CATEGORY_ORDER: readonly ConnectorCategory[] = [
  'productivity',
  'development',
  'project',
  'design',
  'payments',
  'crm',
  'communication',
  'data',
  'other',
];

export const CATEGORY_LABEL_KEYS: Record<ConnectorCategory, MessageKey> = {
  productivity: 'apps.catalog.category.productivity',
  development: 'apps.catalog.category.development',
  project: 'apps.catalog.category.project',
  design: 'apps.catalog.category.design',
  payments: 'apps.catalog.category.payments',
  crm: 'apps.catalog.category.crm',
  communication: 'apps.catalog.category.communication',
  data: 'apps.catalog.category.data',
  other: 'apps.catalog.category.other',
};

export const TIER_LABEL_KEYS: Record<ConnectorTier, MessageKey> = {
  builtin: 'apps.catalog.tier.builtin',
  verified: 'apps.catalog.tier.verified',
  community: 'apps.catalog.tier.community',
  developer: 'apps.catalog.tier.developer',
};

export type CategoryFilter = ConnectorCategory | 'all';

/** 目录里实际出现的分类，按 {@link CATEGORY_ORDER} 排序。 */
export function catalogCategories(entries: readonly AppCatalogEntry[]): ConnectorCategory[] {
  const present = new Set(entries.map((entry) => entry.category));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

function matchesQuery(entry: AppCatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [entry.title, entry.name, entry.connectorId, entry.description].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** 搜索（标题 / 命名空间名 / slug / 简介，大小写不敏感）+ 分类筛选。 */
export function filterCatalog(
  entries: readonly AppCatalogEntry[],
  filter: { query?: string; category?: CategoryFilter },
): AppCatalogEntry[] {
  const category = filter.category ?? 'all';
  return entries.filter(
    (entry) =>
      (category === 'all' || entry.category === category) && matchesQuery(entry, filter.query ?? ''),
  );
}

/** 可连接的在前（不可用的置灰沉底），同组内按标题字母序。不修改入参。 */
export function sortCatalog(entries: readonly AppCatalogEntry[]): AppCatalogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.connectable !== b.connectable) return a.connectable ? -1 : 1;
    return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
  });
}

export function catalogView(
  entries: readonly AppCatalogEntry[],
  filter: { query?: string; category?: CategoryFilter },
): AppCatalogEntry[] {
  return sortCatalog(filterCatalog(entries, filter));
}

export interface CatalogAction {
  /** 按钮是否置灰（!connectable 或正在连接）。 */
  disabled: boolean;
  labelKey: MessageKey;
  /** 置灰原因（不可连接时展示 / tooltip）；core 未给原因时为 null。 */
  reason: string | null;
}

/** 目录卡片的连接按钮：已连接 → 「再连一个账号」；不可连接 → 置灰并带原因；正在连接 → 置灰。 */
export function catalogAction(entry: AppCatalogEntry, connecting = false): CatalogAction {
  if (!entry.connectable) {
    return {
      disabled: true,
      labelKey: 'apps.catalog.unavailable',
      reason: entry.unavailableReason ?? null,
    };
  }
  if (connecting) return { disabled: true, labelKey: 'apps.catalog.connecting', reason: null };
  return {
    disabled: false,
    labelKey: entry.connectedAccounts > 0 ? 'apps.catalog.connectAnother' : 'apps.catalog.connect',
    reason: null,
  };
}

/** 图标：只接受内联的 `data:image/` URI（core 已把 SVG 内联）；否则 null → 首字母占位。 */
export function appIconSrc(iconDataUri: string | null | undefined): string | null {
  return typeof iconDataUri === 'string' && iconDataUri.startsWith('data:image/')
    ? iconDataUri
    : null;
}

/** 无图标时的首字母占位（取标题首个字符，大写）。 */
export function appInitial(title: string): string {
  const first = [...title.trim()][0];
  return first === undefined ? '?' : first.toUpperCase();
}

// --- 已连接 --------------------------------------------------------------------

/** 自定义 server 的占位连接（`custom:{serverId}`）：归「自定义」页，不进已连接列表。 */
export function isCustomConnection(connection: Pick<AppConnection, 'id' | 'connectorId'>): boolean {
  return connection.id.startsWith('custom:') || connection.connectorId.startsWith('custom:');
}

export interface AppGroup {
  connectorId: string;
  title: string;
  iconDataUri: string | null;
  connections: AppConnection[];
  /** 组内有需要用户处理的连接（过期 / 缺权限 / 工具待复核 / 不可达）。 */
  needsAttention: boolean;
}

/**
 * 目录连接按应用分组：组按标题字母序，组内连接按创建时间。目录里查不到的
 * connector（目录改版后残留的连接）用 connectorId 作标题，仍可管理 / 断开。
 */
export function groupConnectionsByApp(
  connections: readonly AppConnection[],
  entries: readonly AppCatalogEntry[],
): AppGroup[] {
  const byId = new Map(entries.map((entry) => [entry.connectorId, entry]));
  const groups = new Map<string, AppGroup>();
  for (const connection of connections) {
    if (isCustomConnection(connection)) continue;
    let group = groups.get(connection.connectorId);
    if (group === undefined) {
      const entry = byId.get(connection.connectorId);
      group = {
        connectorId: connection.connectorId,
        title: entry?.title ?? connection.connectorId,
        iconDataUri: entry?.iconDataUri ?? null,
        connections: [],
        needsAttention: false,
      };
      groups.set(connection.connectorId, group);
    }
    group.connections.push(connection);
    if (statusBadge(connection.status).attention) group.needsAttention = true;
  }
  const result = [...groups.values()];
  for (const group of result) group.connections.sort((a, b) => a.createdAt - b.createdAt);
  return result.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
}

export type BadgeTone = 'ok' | 'warn' | 'error' | 'muted' | 'neutral';

export interface StatusBadge {
  /** 文案键沿用 connect-flow 的 `apps.status.*`。 */
  labelKey: MessageKey;
  tone: BadgeTone;
  /** 需要用户处理（行上显示提示色 / 分组高亮）。 */
  attention: boolean;
}

const STATUS_BADGES: Record<AppConnectionStatus, StatusBadge> = {
  not_connected: { labelKey: 'apps.status.not_connected', tone: 'muted', attention: false },
  connecting: { labelKey: 'apps.status.connecting', tone: 'neutral', attention: false },
  connected: { labelKey: 'apps.status.connected', tone: 'ok', attention: false },
  expired: { labelKey: 'apps.status.expired', tone: 'warn', attention: true },
  needs_scope: { labelKey: 'apps.status.needs_scope', tone: 'warn', attention: true },
  tools_changed: { labelKey: 'apps.status.tools_changed', tone: 'warn', attention: true },
  error: { labelKey: 'apps.status.error', tone: 'error', attention: true },
  disabled: { labelKey: 'apps.status.disabled', tone: 'muted', attention: false },
};

export function statusBadge(status: AppConnectionStatus): StatusBadge {
  return STATUS_BADGES[status];
}

export const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  ok: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400',
  warn: 'border-amber-500/60 text-amber-700 dark:text-amber-400',
  error: 'border-destructive/60 text-destructive',
  muted: 'text-muted-foreground',
  neutral: '',
};

// --- Bot 授权 ------------------------------------------------------------------

/** 授权了该连接的 Bot（`runtime.app_connection_ids` 含连接 id）。 */
export function botsForConnection(bots: readonly Bot[], connectionId: string): Bot[] {
  return bots.filter((bot) => (bot.profile.runtime.app_connection_ids ?? []).includes(connectionId));
}

/** 各连接已授权的 Bot 数（一次遍历，供列表行用）。 */
export function authorizedBotCounts(bots: readonly Bot[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bot of bots) {
    for (const id of new Set(bot.profile.runtime.app_connection_ids ?? [])) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

export interface DisconnectImpact {
  botIds: string[];
  botNames: string[];
}

/** 断开 / 删除连接会影响的 Bot（core 会把连接从它们的 Profile 移除）。 */
export function disconnectImpact(bots: readonly Bot[], connectionId: string): DisconnectImpact {
  const affected = botsForConnection(bots, connectionId);
  return { botIds: affected.map((bot) => bot.id), botNames: affected.map((bot) => bot.name) };
}

// --- 最近使用 ------------------------------------------------------------------

export type LastUsed =
  | { key: 'apps.lastUsed.never' }
  | { key: 'apps.lastUsed.justNow' }
  | { key: 'apps.lastUsed.minutes' | 'apps.lastUsed.hours' | 'apps.lastUsed.days'; n: number }
  | { key: 'apps.lastUsed.date'; date: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 最近使用的相对时间描述（30 天以上显示日期）；组件用 `t(key, params)` 渲染。 */
export function describeLastUsed(lastUsedAt: number | null, now: number): LastUsed {
  if (lastUsedAt === null) return { key: 'apps.lastUsed.never' };
  const delta = Math.max(0, now - lastUsedAt);
  if (delta < MINUTE) return { key: 'apps.lastUsed.justNow' };
  if (delta < HOUR) return { key: 'apps.lastUsed.minutes', n: Math.floor(delta / MINUTE) };
  if (delta < DAY) return { key: 'apps.lastUsed.hours', n: Math.floor(delta / HOUR) };
  if (delta < 30 * DAY) return { key: 'apps.lastUsed.days', n: Math.floor(delta / DAY) };
  return { key: 'apps.lastUsed.date', date: new Date(lastUsedAt).toLocaleDateString() };
}

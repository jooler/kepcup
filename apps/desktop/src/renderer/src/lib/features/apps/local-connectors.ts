import {
  localConnectorOrigin,
  localConnectorSlug,
  type AppCatalogEntry,
  type LocalConnectorCard,
} from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 本机连接（设计 29 §17，todo/local-connector-authoring.md L4）渲染端纯函数：确认卡状态机、
 * 过期判定、错误映射、「本机自建」区的可见性与目录去重。组件没有 DOM 测试环境，逻辑都落在这里。
 */

// --- 目录去重 ------------------------------------------------------------------------

/** 本机条目（`origin: 'local'`）。 */
export function isLocalEntry(entry: Pick<AppCatalogEntry, 'origin'>): boolean {
  return entry.origin === 'local';
}

/**
 * 普通目录网格用的条目：**不含**本机条目——本机条目只在「本机自建」区出现一次（按 `origin`
 * 过滤，不靠名字猜）。
 */
export function withoutLocalEntries(entries: readonly AppCatalogEntry[]): AppCatalogEntry[] {
  return entries.filter((entry) => !isLocalEntry(entry));
}

/** 「本机自建」区的条目（保持目录顺序）。 */
export function localEntries(entries: readonly AppCatalogEntry[]): AppCatalogEntry[] {
  return entries.filter(isLocalEntry);
}

/**
 * 「本机自建」区可见：开发者模式开启，或已经有本机条目（关闭开发者模式后条目保留，
 * 仍可连接 / 管理 / 删除，只是不能新增）。
 */
export function localSectionVisible(input: { developerMode: boolean; count: number }): boolean {
  return input.developerMode || input.count > 0;
}

// --- 确认卡 --------------------------------------------------------------------------

/** 卡上的 MCP 地址对应的本机条目 slug（与 core 同一派生规则）；地址非法 = null。 */
export function cardConnectorId(card: Pick<LocalConnectorCard, 'mcpUrl'>): string | null {
  const origin = localConnectorOrigin(card.mcpUrl);
  return origin === null ? null : localConnectorSlug(origin);
}

/** 提案是否已过期（core 在 `expiresAt` 之后拒绝 `confirm`）。 */
export function cardExpired(card: Pick<LocalConnectorCard, 'expiresAt'>, now: number): boolean {
  return now >= card.expiresAt;
}

/** 距过期还有多少毫秒（已过期 = 0）；供定时器在过期那一刻刷新界面。 */
export function msUntilExpiry(card: Pick<LocalConnectorCard, 'expiresAt'>, now: number): number {
  return Math.max(0, card.expiresAt - now);
}

/** 剩余分钟数（向上取整，至少 1），卡上的「x 分钟内有效」。 */
export function minutesLeft(card: Pick<LocalConnectorCard, 'expiresAt'>, now: number): number {
  return Math.max(1, Math.ceil(msUntilExpiry(card, now) / 60_000));
}

/**
 * 确认卡阶段：
 * - `ready`：可点「添加」；
 * - `expired`：提案过期（或 core 报过期 / 重启后失效）——「添加」禁用并说明，让 Bot 重新发起；
 * - `added`：条目已在目录里（刚添加，或重启后卡片重现时发现已添加）——进入连接步骤；
 * - `rejected`：用户取消，卡片收起。
 * 忙碌（请求在途）不是阶段，由组件的 `busy` 控制按钮，防止重复提交。
 */
export type LocalCardPhase = 'ready' | 'expired' | 'added' | 'rejected';

export function localCardPhase(input: {
  card: Pick<LocalConnectorCard, 'expiresAt'>;
  now: number;
  /** 目录里已有该本机条目。 */
  alreadyAdded: boolean;
  /** core 已报过「提案过期 / 已处理」。 */
  staleReported: boolean;
  rejected: boolean;
}): LocalCardPhase {
  if (input.rejected) return 'rejected';
  if (input.alreadyAdded) return 'added';
  if (input.staleReported || cardExpired(input.card, input.now)) return 'expired';
  return 'ready';
}

// --- 错误映射 ------------------------------------------------------------------------

export interface LocalConnectorErrorView {
  /** zh-CN 文案的 i18n key；`LOCAL_CONNECTOR_REJECTED` 另带 core 给的具体原因。 */
  key: MessageKey;
  /** 提案已失效（过期 / 已处理 / 重启）：卡片应切到 `expired`。 */
  stale: boolean;
  /** core 的具体原因（仅 `LOCAL_CONNECTOR_REJECTED`）。 */
  detail?: string;
}

/** 把 `confirm` / `remove` 的 RPC 错误映射成清晰的 zh-CN 提示；未知错误返回 null（调用方显示原文）。 */
export function localConnectorError(error: unknown): LocalConnectorErrorView | null {
  const code = (error as { code?: string } | undefined)?.code;
  const message = error instanceof Error ? error.message : '';
  switch (code) {
    case 'LOCAL_CONNECTOR_EXPIRED':
      return { key: 'apps.local.error.expired', stale: true };
    case 'LOCAL_CONNECTOR_ACK_REQUIRED':
      return { key: 'apps.local.error.ackRequired', stale: false };
    case 'DEVELOPER_MODE_REQUIRED':
      return { key: 'apps.local.error.developerMode', stale: false };
    case 'LOCAL_CONNECTOR_REJECTED':
      return {
        key: 'apps.local.error.rejected',
        stale: false,
        ...(message.length > 0 ? { detail: message } : {}),
      };
    default:
      return null;
  }
}

/**
 * 「添加」是否可点：阶段为 `ready`；授权服务器与 MCP 服务不同站点（`issuerCrossSite`，评审 A1）时
 * 还必须已勾选「我了解」；忙碌（请求在途）时不可点（防重复提交）。
 */
export function canAddLocal(input: {
  phase: LocalCardPhase;
  card: Pick<LocalConnectorCard, 'issuerCrossSite'>;
  acknowledged: boolean;
  busy: boolean;
}): boolean {
  if (input.busy || input.phase !== 'ready') return false;
  return !input.card.issuerCrossSite || input.acknowledged;
}

/** `remove` 时「条目已不存在」：静默当作成功（别处已删 / 重复点击）。 */
export function isLocalConnectorGone(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === 'NOT_FOUND';
}

// --- 展示 ----------------------------------------------------------------------------

/** 注册方式的 i18n key。 */
export const REGISTRATION_LABEL_KEYS: Record<LocalConnectorCard['registration'], MessageKey> = {
  cimd: 'apps.local.card.registration.cimd',
  dcr: 'apps.local.card.registration.dcr',
};

/** 删除确认框里的账号数说明。 */
export function removeImpactKey(accounts: number): MessageKey {
  return accounts > 0 ? 'apps.local.remove.withAccounts' : 'apps.local.remove.noAccounts';
}

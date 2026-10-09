import {
  approvalPriorEffectSchema,
  type Approval,
  type ApprovalPriorEffect,
  type EffectReceipt,
  type EffectStatus,
} from '@kepcup/shared';

/**
 * W4（D78）审批回执与去重提示的纯函数（ApprovalCard / 无人值守汇总用）。
 * 旧审批没有 `effect` / `payloadHash` / `priorEffect`：一律返回 null，卡片照旧。
 */

/** The receipt line under a decided card: its i18n key suffix (`approvals.effect.*`). */
export type ApprovalEffectLine = 'completed' | 'failed' | 'uncertain' | 'denied' | 'executing';

/**
 * 卡片底部的执行结果行：只对已批准的审批显示（拒绝 / 取消的记录本身已说明
 * 结局）。`intended`（还在等审批）不显示；`executing` 显示为执行中。
 */
export function approvalEffectLine(
  approval: Pick<Approval, 'status' | 'effect'>,
): ApprovalEffectLine | null {
  if (approval.status !== 'approved' || approval.effect === undefined) return null;
  return effectStatusLine(approval.effect.status);
}

/** Ledger status → receipt line (no line for `intended`). */
export function effectStatusLine(status: EffectStatus | undefined): ApprovalEffectLine | null {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'uncertain':
    case 'denied':
    case 'executing':
      return status;
    default:
      return null;
  }
}

/** The receipt's text (url / id / note), shown as plain text; null when there is none. */
export function receiptText(receipt: EffectReceipt | undefined): string | null {
  if (receipt === undefined) return null;
  const parts = [receipt.url, receipt.externalId, receipt.note].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * 去重门的「上次同样的操作结果未知」标记（payload.priorEffect），解析失败或
 * 没有 → null。
 */
export function priorEffectOf(approval: Pick<Approval, 'payload'>): ApprovalPriorEffect | null {
  const parsed = approvalPriorEffectSchema.safeParse(approval.payload['priorEffect']);
  return parsed.success ? parsed.data : null;
}

/** The `approvals.decide` fields binding a decision to the rendered payload (W4). */
export function decisionBinding(approval: Pick<Approval, 'payloadHash'>): { payloadHash?: string } {
  return approval.payloadHash !== undefined && approval.payloadHash.length > 0
    ? { payloadHash: approval.payloadHash }
    : {};
}

/**
 * Merges an incoming approval over the one the store holds (W4 复查): a
 * `decide` RPC result can arrive after the `approval.resolved` that already
 * carried the settled receipt — it must not downgrade a later-settled effect.
 */
export function mergeApprovalUpdate(prev: Approval | undefined, next: Approval): Approval {
  const kept = prev?.effect;
  if (kept === undefined) return next;
  const incoming = next.effect;
  const keptAt = kept.settledAt ?? -1;
  const incomingAt = incoming?.settledAt ?? -1;
  if (incoming === undefined || incomingAt < keptAt) return { ...next, effect: kept };
  return next;
}

/** The kind of flag a pending card shows for an earlier same attempt (W4). */
export type PriorEffectFlag = 'uncertain' | 'completed';

export function priorEffectFlag(approval: Pick<Approval, 'payload'>): PriorEffectFlag | null {
  const prior = priorEffectOf(approval);
  if (prior === null) return null;
  return prior.status === 'completed'
    ? 'completed'
    : prior.status === 'uncertain'
      ? 'uncertain'
      : null;
}

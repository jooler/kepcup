import { randomUUID } from 'node:crypto';
import { AppError, type EffectReceipt, type ToolEffect } from '@kepcup/shared';
import type { ToolRisk } from '../../mcp/risk.js';
import { neutralizeUntrusted } from '../../infra/data-boundary.js';
import type { EffectApprovalGate, ToolCallEffectHooks } from '../../permissions/tool-call-scope.js';
import { redactToolArgs, scrubSensitiveValues } from '../step-persistence.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { effectClassOf } from './classify.js';
import { sha256Hex, stableJson } from './key.js';
import type { SettledEffectStatus, ToolEffectsStore } from './store.js';

/**
 * 外部副作用台账的记录器（W2 / D78）：`executeToolSafely` 在执行前 `begin`，
 * effect class 为 external 的调用先写 `executing`，结束后按结果结为
 * completed / failed / uncertain / denied；执行中才变成外部的调用（确认模式下
 * 已批准的命令离开沙箱）经 tool-call scope 的 `escalate` 补写。
 *
 * 记录器的任何失败都只记日志，绝不影响工具执行。
 */

export const EFFECT_SUMMARY_MAX_CHARS = 200;
const RECEIPT_FIELD_MAX_CHARS = 500;

/**
 * Params never written to the ledger in clear (summary or hash input), on top
 * of W1's step-persistence redaction table: `browser_type.text` is only found
 * to be a password field during execution — after the row was written — so
 * the ledger never keeps typed text (the length is kept).
 */
const LEDGER_REDACTED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  browser_type: ['text'],
};

const ESCALATION_LABELS: Readonly<Record<string, string>> = {
  unsandboxed: '沙箱外执行',
};

export interface EffectRecorderDeps {
  store: ToolEffectsStore;
  /** Stored-secret redaction (SecretsService.redact, same as audits / run steps). */
  redact(text: string): string;
  logger: { warn(obj: object, msg: string): void };
  /**
   * Current W5 risk of an MCP tool (McpService.riskOf; sync, unknown →
   * destructive). The more severe of this and the build-time risk counts.
   */
  mcpRiskOf?(serverId: string, toolName: string): ToolRisk;
  /**
   * W4: a row linked to an approval settled — the approval card's receipt
   * line changed (start.ts re-publishes the approval). Errors are swallowed.
   */
  onSettled?(effect: ToolEffect): void;
  /**
   * W4 复查 B1: which of these approval ids the **user** refused (status
   * denied, not auto-decided, not cancelled — ApprovalsService.userDeniedIds).
   * Absent = none: a denied row then never dedupes.
   */
  userDeniedApprovals?(approvalIds: readonly string[]): ReadonlySet<string>;
}

/**
 * Redaction placeholders (stored secrets → `[REDACTED]`, W1 / ledger params
 * → `«redacted…»`). Args containing one are never compared (W4 复查 S2): two
 * different secrets would look identical.
 */
const REDACTION_MARKERS = ['[REDACTED]', '«redacted'];

/** One recorded call (null from `begin` = nothing to record). */
export interface EffectCall extends ToolCallEffectHooks {
  /**
   * The tool returned (failures included). Returns the status the ledger row
   * settled into, null when the call has no row (local, or the write failed).
   */
  settle(result: ToolResult): SettledEffectStatus | null;
  /** The tool threw (executeToolSafely turns it into a failure result). */
  settleThrown(error: unknown): SettledEffectStatus | null;
  /**
   * W4: the result the model gets instead of the tool's own when the approval
   * dedupe gate stopped the call (the same effect already completed / was
   * denied in the task chain); null otherwise. Read after settling.
   */
  dedupeResult(): ToolResult | null;
}

export interface EffectRecorder {
  begin(input: { tool: ToolDefinition; params: unknown; ctx: ToolContext }): EffectCall | null;
}

const RISK_ORDER: Readonly<Record<ToolRisk, number>> = { read: 0, write: 1, destructive: 2 };

function severer(a: ToolRisk, b: ToolRisk | undefined): ToolRisk {
  return b !== undefined && RISK_ORDER[b] > RISK_ORDER[a] ? b : a;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The ledger status of a returned call: uncertain (W1 outcome / explicit
 * report / BROWSER_OUTCOME_UNKNOWN) → completed (ok) → denied (approval
 * refused) → failed; a failure while the run was being aborted is uncertain
 * unless the tool said it never started.
 */
export function effectStatusOf(result: ToolResult, aborted = false): SettledEffectStatus {
  if (
    result.effect?.outcome === 'uncertain' ||
    result.outcome === 'uncertain' ||
    result.errorCode === 'BROWSER_OUTCOME_UNKNOWN'
  ) {
    return 'uncertain';
  }
  if (result.ok) return 'completed';
  if (result.errorCode === 'APPROVAL_DENIED') return 'denied';
  if (result.outcome === 'not_started') return 'failed';
  return aborted ? 'uncertain' : 'failed';
}

/**
 * W4 approval dedupe gate: what the earlier rows of the same effect (same
 * tool, same redacted args; task chain, oldest first) mean for a new approval
 * request of `kind`.
 * - Any `completed` row (with or without an approval) → `completed` for
 *   `mcp_tool` (no card, DUPLICATE_EFFECT), `repeat` for every other kind (a
 *   flagged card: git_remote / unsandboxed are state-dependent).
 * - Else the newest `uncertain` or **user-denied** row decides. A denied row
 *   counts only when its approval is in `userDenied` (refused by hand — not
 *   a cancellation, an interruption / restart while waiting, a wall-clock
 *   abort or unattended's floor; 复查 B1).
 * - The user's latest real `ask_user` answer (`consentAt`) clears completed
 *   and user-denied rows that settled before it; it never clears uncertain
 *   ones (复查 B2) — those always get the flagged card.
 * - Failed rows never block (nothing happened), nor do live ones (a parallel
 *   call).
 */
export function duplicateVerdict(
  rows: readonly ToolEffect[],
  input: {
    consentAt: number | null;
    userDenied: ReadonlySet<string>;
    /** The approval kind asked for (default: blocking like `mcp_tool`). */
    kind?: string;
  },
): EffectApprovalGate | null {
  const consented = (row: ToolEffect) =>
    input.consentAt !== null && (row.settledAt ?? row.createdAt) <= input.consentAt;
  const newest = (accept: (row: ToolEffect) => boolean) =>
    rows
      .filter(accept)
      .reduce<ToolEffect | null>(
        (best, row) => (best === null || row.createdAt >= best.createdAt ? row : best),
        null,
      );
  const completed = newest((row) => row.status === 'completed' && !consented(row));
  const decisive =
    completed ??
    newest(
      (row) =>
        row.status === 'uncertain' ||
        (row.status === 'denied' &&
          row.approvalId !== null &&
          input.userDenied.has(row.approvalId) &&
          !consented(row)),
    );
  if (decisive === null) return null;
  const verdict: EffectApprovalGate['verdict'] =
    decisive.status === 'completed'
      ? (input.kind ?? 'mcp_tool') === 'mcp_tool'
        ? 'completed'
        : 'repeat'
      : (decisive.status as 'denied' | 'uncertain');
  return {
    verdict,
    prior: {
      id: decisive.id,
      status: decisive.status,
      approvalId: decisive.approvalId,
      summary: decisive.summary,
      receipt: decisive.receipt,
      createdAt: decisive.createdAt,
      settledAt: decisive.settledAt,
    },
  };
}

/** One line of a receipt for the model (`<untrusted>`: tool / server text). */
export function receiptText(receipt: EffectReceipt | null): string | null {
  if (receipt === null) return null;
  const parts = [receipt.url, receipt.externalId, receipt.note].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length > 0
    ? `<untrusted>${neutralizeUntrusted(parts.join('，'))}</untrusted>`
    : null;
}

/** W4: the tool result of a call stopped because the same effect already completed. */
export function duplicateEffectMessage(receipt: EffectReceipt | null): string {
  return `相同操作已在本任务中完成（回执：${receiptText(receipt) ?? '无，状态为已完成'}），不要重复执行；如确需再做一次，用 ask_user 征得用户同意`;
}

/** W4: the tool result of a call stopped because the user denied the same effect. */
export const DUPLICATE_DENIED_MESSAGE =
  '用户已拒绝相同操作，不要重复请求；调整做法，或用 ask_user 询问用户';

/** A thrown call: denied when the approval was refused, else uncertain (phase unknown). */
export function thrownEffectStatus(error: unknown): SettledEffectStatus {
  return error instanceof AppError && error.code === 'APPROVAL_DENIED' ? 'denied' : 'uncertain';
}

/**
 * The redacted canonical args text (hash input and summary body): W1's
 * sensitive params, the ledger-only table above, then stored secrets.
 */
export function ledgerArgsText(
  toolName: string,
  params: unknown,
  redact: (text: string) => string,
): string {
  const { args } = redactToolArgs(toolName, params, LEDGER_REDACTED_PARAMS[toolName] ?? []);
  return redact(stableJson(args ?? {}));
}

export function createEffectRecorder(deps: EffectRecorderDeps): EffectRecorder {
  const warn = (error: unknown, msg: string, extra: object = {}) => {
    try {
      deps.logger.warn(
        { ...extra, error: error instanceof Error ? error.message : String(error) },
        msg,
      );
    } catch {
      // logging must not throw either
    }
  };
  const redactReceipt = (
    receipt: NonNullable<ToolResult['effect']>['receipt'],
    scrub: (text: string) => string,
  ) => {
    if (receipt === undefined) return undefined;
    const out: { url?: string; externalId?: string; note?: string } = {};
    for (const key of ['url', 'externalId', 'note'] as const) {
      const value = receipt[key];
      if (typeof value === 'string') {
        out[key] = truncate(scrub(value), RECEIPT_FIELD_MAX_CHARS);
      }
    }
    return out;
  };

  return {
    begin({ tool, params, ctx }) {
      try {
        const identity = ctx.identity;
        if (identity.loopType === 'host') return null; // never a runs row
        let mcpRisk: ToolRisk | undefined;
        const mcpOrigin = tool.mcp ?? tool.mcpOf?.(params);
        if (mcpOrigin !== undefined) {
          let live: ToolRisk | undefined;
          try {
            live = deps.mcpRiskOf?.(mcpOrigin.serverId, mcpOrigin.toolName);
          } catch {
            live = undefined;
          }
          mcpRisk = severer(mcpOrigin.risk, live);
        }
        const effectClass = effectClassOf(
          tool.name,
          params,
          mcpRisk !== undefined ? { mcpRisk } : {},
        );
        if (effectClass === 'none') return null;

        const toolCallId =
          ctx.toolCallId !== undefined && ctx.toolCallId.length > 0
            ? ctx.toolCallId
            : `local_${randomUUID()}`;
        let rowId: string | null = null;
        let approvalId: string | null = null;
        let failed = false;
        /** W4: the row is `intended` (waiting on the user's decision). */
        let intended = false;
        /** W4: an approval of this call was granted — it may already be running. */
        let granted = false;
        /** W4: the dedupe gate's verdict (undefined = not asked yet). */
        let gate: EffectApprovalGate | null | undefined;
        let canonical: string | null = null;
        const canonicalArgs = (): string => {
          canonical ??= ledgerArgsText(tool.name, params, deps.redact);
          return canonical;
        };
        const open = (label: string) => {
          if (rowId !== null || failed) return;
          try {
            const args = canonicalArgs();
            const summary = truncate(
              args === '{}' ? label : `${label} ${args}`,
              EFFECT_SUMMARY_MAX_CHARS,
            );
            rowId = deps.store.open({
              runId: identity.runId,
              toolCallId,
              toolName: tool.name,
              argsHash: sha256Hex(args),
              summary,
              approvalId,
            }).id;
          } catch (error) {
            failed = true;
            warn(error, 'tool effect ledger: open failed', {
              runId: identity.runId,
              toolName: tool.name,
            });
          }
        };
        /**
         * Tool-reported free text (summary / receipt) gets the same treatment
         * as the args summary: this call's sensitive param values (W1 table,
         * the ledger table, params reported sensitive at execution time) are
         * scrubbed, then stored secrets.
         */
        const scrubber = (result: ToolResult | undefined) => {
          const { values } = redactToolArgs(tool.name, params, [
            ...(LEDGER_REDACTED_PARAMS[tool.name] ?? []),
            ...(result?.sensitiveParams ?? []),
          ]);
          const set = new Set(values);
          return (text: string) => deps.redact(scrubSensitiveValues(text, set) as string);
        };
        const settleAs = (
          settledStatus: SettledEffectStatus,
          result?: ToolResult,
        ): SettledEffectStatus | null => {
          let status = settledStatus;
          // W4: the dedupe gate stopped the call. A completed duplicate never
          // ran — its row goes (the ledger lists what may have happened); a
          // denied duplicate is a denial whatever the tool made of it.
          if (gate?.verdict === 'completed') {
            if (rowId !== null) {
              try {
                deps.store.discard(rowId);
              } catch (error) {
                warn(error, 'tool effect ledger: discard failed', { toolName: tool.name });
              }
            }
            return null;
          }
          const deniedBy = gate?.verdict === 'denied' ? gate.prior.approvalId : null;
          if (gate?.verdict === 'denied') status = 'denied';
          // Still waiting on its approval when it returned: it never ran —
          // denied (the approval was refused / cancelled) or failed, never
          // uncertain.
          else if (intended) status = status === 'denied' ? 'denied' : 'failed';
          // No row: a local call (nothing to report), or the ledger write
          // failed — the status is still a fact about this external call.
          if (rowId === null) return failed ? status : null;
          let settled: ToolEffect | null = null;
          try {
            const reported = result?.effect;
            const scrub = scrubber(result);
            const receipt = redactReceipt(reported?.receipt, scrub);
            settled = deps.store.settle(rowId, {
              status,
              // A denial the gate repeated carries the user's original
              // approval (it stays a user denial for later calls, 复查 B1).
              ...(deniedBy !== null ? { approvalId: deniedBy } : {}),
              ...(receipt !== undefined ? { receipt } : {}),
              ...(reported?.summary !== undefined && reported.summary.length > 0
                ? { summary: truncate(scrub(reported.summary), EFFECT_SUMMARY_MAX_CHARS) }
                : {}),
            });
          } catch (error) {
            warn(error, 'tool effect ledger: settle failed', {
              runId: identity.runId,
              toolName: tool.name,
            });
          }
          if (settled !== null && settled.approvalId !== null) {
            try {
              deps.onSettled?.(settled);
            } catch (error) {
              warn(error, 'tool effect ledger: settle listener failed', { toolName: tool.name });
            }
          }
          return status;
        };
        /** Hooks reached through the tool-call scope only act for this call's own run. */
        const ownRun = (runId: string | undefined) =>
          runId === undefined || runId === identity.runId;

        if (effectClass === 'external') open(tool.name);
        return {
          escalate(reason, runId) {
            if (!ownRun(runId)) return;
            open(`${tool.name}（${ESCALATION_LABELS[reason] ?? reason}）`);
          },
          noteApproval(id, runId) {
            if (!ownRun(runId)) return;
            approvalId = id;
            if (rowId === null) return;
            try {
              deps.store.noteApproval(rowId, id);
            } catch (error) {
              warn(error, 'tool effect ledger: approval link failed', { toolName: tool.name });
            }
          },
          approvalGate(runId, kind) {
            // Never across task chains, never in turns / sub runs, only for a
            // call that has a ledger row (an external call).
            if (!ownRun(runId) || identity.loopType !== 'task' || rowId === null) return null;
            if (gate !== undefined) return gate;
            try {
              const args = canonicalArgs();
              // 复查 S2: redacted args are never compared (two different
              // secrets would look the same).
              if (REDACTION_MARKERS.some((marker) => args.includes(marker))) {
                gate = null;
                return gate;
              }
              const runIds = deps.store.chainRunIds(identity.runId);
              const rows = deps.store.sameEffectRows({
                runIds,
                toolName: tool.name,
                argsHash: sha256Hex(args),
                excludeId: rowId,
              });
              if (rows.length === 0) {
                gate = null;
              } else {
                const deniedApprovals = rows
                  .filter((row) => row.status === 'denied' && row.approvalId !== null)
                  .map((row) => row.approvalId!);
                gate = duplicateVerdict(rows, {
                  consentAt: deps.store.lastUserAnswerAt(runIds),
                  userDenied:
                    deniedApprovals.length > 0
                      ? (deps.userDeniedApprovals?.(deniedApprovals) ?? new Set<string>())
                      : new Set<string>(),
                  ...(kind !== undefined ? { kind } : {}),
                });
              }
            } catch (error) {
              warn(error, 'tool effect ledger: dedupe gate failed', { toolName: tool.name });
              gate = null;
            }
            return gate;
          },
          approvalWaiting(runId) {
            // Once an approval of this call was granted the call may already
            // be acting — it never goes back to「nothing ran」.
            if (!ownRun(runId) || rowId === null || granted) return;
            try {
              deps.store.markIntended(rowId, true);
              intended = true;
            } catch (error) {
              warn(error, 'tool effect ledger: intended failed', { toolName: tool.name });
            }
          },
          approvalGranted(runId) {
            if (!ownRun(runId) || rowId === null) return;
            granted = true;
            if (!intended) return;
            intended = false;
            try {
              deps.store.markIntended(rowId, false);
            } catch (error) {
              warn(error, 'tool effect ledger: executing failed', { toolName: tool.name });
            }
          },
          settle(result) {
            return settleAs(effectStatusOf(result, ctx.signal.aborted), result);
          },
          settleThrown(error) {
            return settleAs(thrownEffectStatus(error));
          },
          dedupeResult() {
            if (gate?.verdict === 'completed') {
              return {
                ok: false,
                content: duplicateEffectMessage(gate.prior.receipt),
                errorCode: 'DUPLICATE_EFFECT',
                outcome: 'not_started',
              };
            }
            if (gate?.verdict === 'denied') {
              return {
                ok: false,
                content: DUPLICATE_DENIED_MESSAGE,
                errorCode: 'APPROVAL_DENIED',
                outcome: 'not_started',
              };
            }
            return null;
          },
        };
      } catch (error) {
        warn(error, 'tool effect ledger: begin failed', { toolName: tool.name });
        return null;
      }
    },
  };
}

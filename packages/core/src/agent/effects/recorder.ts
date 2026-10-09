import { randomUUID } from 'node:crypto';
import { AppError } from '@kepcup/shared';
import type { ToolRisk } from '../../mcp/risk.js';
import type { ToolCallEffectHooks } from '../../permissions/tool-call-scope.js';
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
}

/** One recorded call (null from `begin` = nothing to record). */
export interface EffectCall extends ToolCallEffectHooks {
  /**
   * The tool returned (failures included). Returns the status the ledger row
   * settled into, null when the call has no row (local, or the write failed).
   */
  settle(result: ToolResult): SettledEffectStatus | null;
  /** The tool threw (executeToolSafely turns it into a failure result). */
  settleThrown(error: unknown): SettledEffectStatus | null;
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
        if (tool.mcp !== undefined) {
          let live: ToolRisk | undefined;
          try {
            live = deps.mcpRiskOf?.(tool.mcp.serverId, tool.mcp.toolName);
          } catch {
            live = undefined;
          }
          mcpRisk = severer(tool.mcp.risk, live);
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
          status: SettledEffectStatus,
          result?: ToolResult,
        ): SettledEffectStatus | null => {
          // No row: a local call (nothing to report), or the ledger write
          // failed — the status is still a fact about this external call.
          if (rowId === null) return failed ? status : null;
          try {
            const reported = result?.effect;
            const scrub = scrubber(result);
            const receipt = redactReceipt(reported?.receipt, scrub);
            deps.store.settle(rowId, {
              status,
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
          settle(result) {
            return settleAs(effectStatusOf(result, ctx.signal.aborted), result);
          },
          settleThrown(error) {
            return settleAs(thrownEffectStatus(error));
          },
        };
      } catch (error) {
        warn(error, 'tool effect ledger: begin failed', { toolName: tool.name });
        return null;
      }
    },
  };
}

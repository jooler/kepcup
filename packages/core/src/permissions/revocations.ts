import type { Bot, McpServer } from '@kepcup/shared';
import { effectiveMcpApproval, mcpToolEnabled } from '../mcp/policy.js';
import type { ToolRisk } from '../mcp/risk.js';

/**
 * W3（D78，todo/borrowings-from-personal-agents.md W3 §设计 3）：用户主动撤销
 * 授权的内部事件。来源只有宿主侧的用户操作——`grants.revoke`（路径授权）、MCP
 * 设置保存（server 停用 / 删除、autoApprove 开→关、逐工具策略 auto→ask 或停用）、
 * `bots.update` 把 server 移出 `mcp_server_ids`。once 授权随调用结束失效、
 * GRANT_ABSOLUTE_TTL_MS 到期、run 自然结束都**不是**撤销，不发事件。
 *
 * TaskHost 订阅后中断受影响的进行中任务（对话轮不中断）；监听器返回中断的
 * 任务数，`emit` 汇总给调用方（RPC 据此推 `tasks.interrupted` 提示）。
 */
export interface PermissionRevokedEvent {
  /**
   * W8: `browser_profile` — the bot's browser profile was switched (bots.update
   * or its shared profile deleted); only its running tasks that used the
   * browser are interrupted (reason `browser_profile_changed`).
   */
  scope: 'path' | 'mcp' | 'browser_profile';
  /** path：授权所属对话；mcp：缺省（跨对话）。 */
  conversationId?: string;
  /** 受影响的 Bot（路径授权按 Bot + 对话；MCP 为工具面含该 server 的 Bot）。 */
  botIds: string[];
  serverId?: string;
  /** 只撤销了某个工具（逐工具策略）；缺省 = 整个 server。 */
  toolName?: string;
  /**
   * path：`once` 授权属于某个 run——只中断拥有该 run 的任务（任务本身，或
   * SubAgent 子 run 的父任务）；该 run 是对话轮则不中断任何任务。
   */
  runId?: string;
}

export type PermissionRevokedListener = (event: PermissionRevokedEvent) => number | void;

export class PermissionRevocations {
  readonly #listeners = new Set<PermissionRevokedListener>();

  /** Subscribes; returns the unsubscribe. */
  on(listener: PermissionRevokedListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Delivers the event synchronously (the interruption happens before the
   * revoking RPC returns). Returns the total the listeners reported (tasks
   * interrupted). A listener failure never breaks the revocation itself.
   */
  emit(event: PermissionRevokedEvent): number {
    if (event.botIds.length === 0) return 0;
    let total = 0;
    for (const listener of this.#listeners) {
      try {
        const count = listener(event);
        if (typeof count === 'number') total += count;
      } catch {
        // The revocation already happened; the interruption is best effort.
      }
    }
    return total;
  }
}

/** A server / tool the user stopped allowing (input to `mcpRevocationEvents`). */
export interface McpRevocation {
  serverId: string;
  toolName?: string;
}

/**
 * Settings save (mcpServers old → new): what the user revoked. Only servers
 * that were effective before (app-level enabled) count:
 * - server removed or `enabled` true → false → the whole server;
 * - `autoApprove` true → false → each known tool (`knownTools`, the last tool
 *   list) whose effective approval went auto → ask; the whole server when
 *   the tool list is unknown;
 * - per tool (W5 toolPolicies): enabled → disabled, or effective approval
 *   auto → ask (incl. a read tool's default `auto` overridden to `ask`).
 * `riskOf` gives the tool's current risk (the default approval of a tool
 * without a policy depends on it).
 */
export function mcpRevocationsBetween(
  previous: readonly McpServer[],
  next: readonly McpServer[],
  riskOf: (serverId: string, toolName: string) => ToolRisk,
  knownTools: (serverId: string) => readonly string[] | null = () => null,
): McpRevocation[] {
  const revoked: McpRevocation[] = [];
  for (const before of previous) {
    if (!before.enabled) continue;
    const after = next.find((server) => server.id === before.id);
    if (after === undefined || !after.enabled) {
      revoked.push({ serverId: before.id });
      continue;
    }
    let known: readonly string[] | null;
    try {
      known = knownTools(before.id);
    } catch {
      known = null;
    }
    // autoApprove on → off: per tool when the tool list is known (only tools
    // whose effective approval really went auto → ask); unknown → the whole
    // server (the safe side).
    if (before.autoApprove && !after.autoApprove && known === null) {
      revoked.push({ serverId: before.id });
      continue;
    }
    const tools = new Set([
      ...Object.keys(before.toolPolicies ?? {}),
      ...Object.keys(after.toolPolicies ?? {}),
      ...(before.autoApprove !== after.autoApprove ? (known ?? []) : []),
    ]);
    for (const toolName of tools) {
      const wasEnabled = mcpToolEnabled(before, toolName);
      if (!wasEnabled) continue;
      if (!mcpToolEnabled(after, toolName)) {
        revoked.push({ serverId: before.id, toolName });
        continue;
      }
      let risk: ToolRisk;
      try {
        risk = riskOf(before.id, toolName);
      } catch {
        risk = 'destructive';
      }
      if (
        effectiveMcpApproval(before, toolName, risk).approval === 'auto' &&
        effectiveMcpApproval(after, toolName, risk).approval === 'ask'
      ) {
        revoked.push({ serverId: before.id, toolName });
      }
    }
  }
  return revoked;
}

/** Bots whose tool surface includes the server (it selects it). */
export function botsUsingServer(bots: readonly Bot[], serverId: string): string[] {
  return bots
    .filter((bot) => bot.profile.runtime.mcp_server_ids.includes(serverId))
    .map((bot) => bot.id);
}

/**
 * `bots.update`: servers removed from the bot's selection that were in its
 * tool surface (app-level enabled) — each is a revocation for that bot.
 */
export function serversRemovedFromBot(
  previousIds: readonly string[],
  nextIds: readonly string[],
  servers: readonly McpServer[],
): string[] {
  return previousIds.filter(
    (id) => !nextIds.includes(id) && servers.some((server) => server.id === id && server.enabled),
  );
}

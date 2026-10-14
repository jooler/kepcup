import {
  itemIdsForBotPaths,
  mergeThreeWay,
  type AgentCatalogEntry,
  type Bot,
  type McpServer,
  type Settings,
} from '@kepcup/shared';
import { assertAgentSelectable } from '../agent/external/catalog.js';
import {
  botsUsingServer,
  mcpRevocationsBetween,
  serversRemovedFromBot,
  type PermissionRevokedEvent,
} from '../permissions/revocations.js';
import type { ToolRisk } from '../mcp/risk.js';

/**
 * 写 Bot 配置与收回 MCP 授权的唯一路径（D89 审查修复）。
 *
 * `bots.update` RPC（右栏表单、设置卡之外的各处保存）和设置目录的 Bot 条目适配器（设置卡「应用」、
 * Bot 直改与撤销）都经 {@link applyBotProfileUpdate}，所以两边做的事完全一样：
 *
 * - 写之前：换成另一个外部智能体时 `assertAgentSelectable`（实验开关 + 目录）；浏览器资料只能指向
 *   已有的共享资料（`browserProfiles.assertSelectable`）。不通过就抛 `AppError`，什么都不写。
 * - 写：`bots.update`（连接是否存在由领域层校验），发 `bot.updated`。
 * - 写之后（`settle`，调用方在设置写锁之外 await）：有效浏览器资料变了 → 中断用过浏览器的任务并
 *   关掉页面（W8）；从这个 Bot 拿掉的 MCP 服务、连接 → 中断它正在跑的任务（W3 / D73）。
 *
 * 同一个文件还放 MCP 设置保存后的撤销（`settings.update` 与 `mcp.servers` 条目共用）。
 */

/** 撤销授权的副作用依赖（中断任务 + 提示条）。 */
export interface PermissionEffectsDeps {
  revocations: { emit(event: PermissionRevokedEvent): number };
  publish(event: string, payload: unknown): void;
  listBots(): readonly Bot[];
  /** 工具风险档（没有逐工具策略的工具，默认审批档取决于它）；缺省按 destructive。 */
  mcpRiskOf?(serverId: string, toolName: string): ToolRisk;
  /** 已知的工具名（autoApprove 开 → 关时按工具撤销）；缺省 = 不知道，撤销整个服务。 */
  mcpKnownTools?(serverId: string): readonly string[] | null;
}

export interface PermissionEffects {
  /** W3：中断了几个任务就推一条 `tasks.interrupted`（0 不推）。 */
  publishInterrupted(count: number, scope: 'path' | 'mcp' | 'browser_profile'): void;
  /** 收回 MCP 服务 / 工具的授权：中断受影响 Bot 的运行中任务。 */
  revokeMcp(revoked: ReadonlyArray<{ serverId: string; toolName?: string; botIds: string[] }>): void;
  /** `mcpServers` 旧 → 新：停用 / 删掉 / 免审批关掉 / 逐工具收紧 → 中断用到它的 Bot 的任务。 */
  revokeMcpServerChanges(previous: readonly McpServer[], next: readonly McpServer[]): void;
}

export function createPermissionEffects(deps: PermissionEffectsDeps): PermissionEffects {
  const publishInterrupted: PermissionEffects['publishInterrupted'] = (count, scope) => {
    if (count <= 0) return;
    deps.publish('tasks.interrupted', {
      count,
      reason: scope === 'browser_profile' ? 'browser_profile_changed' : 'permission_revoked',
      scope,
    });
  };
  const revokeMcp: PermissionEffects['revokeMcp'] = (revoked) => {
    let count = 0;
    for (const entry of revoked) {
      count += deps.revocations.emit({
        scope: 'mcp',
        botIds: entry.botIds,
        serverId: entry.serverId,
        ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
      });
    }
    publishInterrupted(count, 'mcp');
  };
  return {
    publishInterrupted,
    revokeMcp,
    revokeMcpServerChanges: (previous, next) => {
      const bots = deps.listBots();
      revokeMcp(
        mcpRevocationsBetween(
          previous,
          next,
          (serverId, toolName) => deps.mcpRiskOf?.(serverId, toolName) ?? 'destructive',
          (serverId) => deps.mcpKnownTools?.(serverId) ?? null,
        ).map((entry) => ({ ...entry, botIds: botsUsingServer(bots, entry.serverId) })),
      );
    },
  };
}

/** Bot Profile 前后真正变化的 runtime 路径（模型、浏览器资料、MCP……）。 */
export function changedBotRuntimePaths(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .map((key) => `runtime.${key}`);
}

export interface BotProfileUpdateDeps {
  bots: {
    getOrThrow(id: string): Bot;
    update(id: string, profile: Bot['profile']): Bot;
  };
  settings: { get(): Settings };
  agentCatalog(): readonly AgentCatalogEntry[];
  browserProfiles: {
    assertSelectable(nextId: string, previousId?: string): void;
    profileKeyFor(botId: string): string;
    onBotProfileChanged(botId: string): Promise<number>;
  };
  effects: PermissionEffects;
  publish(event: string, payload: unknown): void;
}

export interface BotProfileUpdate {
  bot: Bot;
  /** 受影响的设置目录条目（按 runtime 差异），供调用方补发 `settings.changed`。 */
  changedItemIds: string[];
  /**
   * 写之后的收尾（收回授权、中断任务、关页面）；调用方在设置写锁之外 await。只能调一次。
   * 每一步各自兜住异常、互不影响（收回授权排在最前），不会抛；返回各步的失败说明，调用方记日志。
   */
  settle(): Promise<string[]>;
}

/**
 * 同步完成「校验 → 写 → bot.updated」，返回写后的 Bot 与要在锁外做的收尾。
 * `base` 给了就先与最新的 Profile 三方合并（过期表单只覆盖它自己改过的字段）。
 */
export function applyBotProfileUpdate(
  deps: BotProfileUpdateDeps,
  id: string,
  profile: Bot['profile'],
  base?: Readonly<Record<string, unknown>>,
): BotProfileUpdate {
  const previous = deps.bots.getOrThrow(id);
  const previousRuntime = previous.profile.runtime;
  const next =
    base === undefined
      ? profile
      : (mergeThreeWay(base, profile, previous.profile) as Bot['profile']);
  // D72 实验开关：只拦「改成另一个外部 Agent」，已在用的 Bot 仍可编辑其余字段。
  const nextAgentId = next.runtime.agent.id;
  if (nextAgentId !== previousRuntime.agent.id) {
    assertAgentSelectable(deps.settings.get(), deps.agentCatalog(), nextAgentId);
  }
  // W8: the browser profile may only point at an existing shared profile.
  deps.browserProfiles.assertSelectable(
    next.runtime.browser_profile,
    previousRuntime.browser_profile,
  );
  const previousProfileKey = deps.browserProfiles.profileKeyFor(id);
  const bot = deps.bots.update(id, next);
  deps.publish('bot.updated', { bot });
  const changedItemIds = itemIdsForBotPaths(
    changedBotRuntimePaths(
      previousRuntime as unknown as Record<string, unknown>,
      bot.profile.runtime as unknown as Record<string, unknown>,
    ),
  );
  let settled = false;
  return {
    bot,
    changedItemIds,
    settle: async () => {
      if (settled) return [];
      settled = true;
      const runtime = bot.profile.runtime;
      const warnings: string[] = [];
      const step = async (name: string, run: () => unknown): Promise<void> => {
        try {
          await run();
        } catch (error) {
          warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      // 收回授权排在最前、各自独立：后面关浏览器页面失败也不会让 MCP / 连接的授权留在 Bot 手里。
      // W3（D78）: servers taken out of the bot's tool surface interrupt its running tasks.
      await step('revoke mcp servers', () =>
        deps.effects.revokeMcp(
          serversRemovedFromBot(
            previousRuntime.mcp_server_ids,
            runtime.mcp_server_ids,
            deps.settings.get().mcpServers,
          ).map((serverId) => ({ serverId, botIds: [bot.id] })),
        ),
      );
      // D73: connections taken off the bot's authorization (their server id is the
      // connection id) interrupt its running tasks the same way.
      await step('revoke app connections', () =>
        deps.effects.revokeMcp(
          previousRuntime.app_connection_ids
            .filter((connectionId) => !runtime.app_connection_ids.includes(connectionId))
            .map((serverId) => ({ serverId, botIds: [bot.id] })),
        ),
      );
      // W8: a different effective browser profile = the identity changed under
      // the bot's browser-using tasks → interrupted; its pages are closed.
      await step('browser profile switch', async () => {
        if (deps.browserProfiles.profileKeyFor(bot.id) === previousProfileKey) return;
        deps.effects.publishInterrupted(
          await deps.browserProfiles.onBotProfileChanged(bot.id),
          'browser_profile',
        );
      });
      return warnings;
    },
  };
}

import {
  AppError,
  connectorMetaOf,
  connectorRemoteOf,
  mcpToolPolicySchema,
  type AppCatalogEntry,
  type AppConnectReviewTool,
  type AppConnection,
  type AppToolDefinition,
  type AppConnectionStatusPayload,
  type AppToolGrantView,
  type AppToolView,
  type Bot,
  type ConnectorCatalogEntry,
  type McpServer,
  type McpToolPolicy,
} from '@kepcup/shared';
import type { CallToolResult } from '@earendil-works/pi-mcp';
import type { BotsService } from '../domain/bots.js';
import type { SettingsService } from '../domain/settings.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { McpConnectionSource, McpService } from '../mcp/service.js';
import type { AppAuditor } from './audit.js';
import type {
  AccountHint,
  CatalogFlowBegin,
  CatalogFlowHost,
  CatalogSettleResult,
} from './auth/flow.js';
import type { ConnectionAuthRegistry } from './auth/registry.js';
import type { ConnectorCatalog } from './catalog.js';
import { isSafeDirectoryRemoteUrl } from './directory-merge.js';
import {
  customConnectionId,
  isCustomConnectionId,
  type AppConnectionStore,
} from './connection-store.js';
import type { AppDisconnector } from './disconnect.js';
import type { AppToolGrants } from './grants.js';
import type { PreregisteredClients } from './oauth-clients.js';
import { classifyAppToolRisk } from './policy.js';
import type { AppToolRow, ToolLockService } from './tool-lock.js';
import type { TokenVault } from './token-vault.js';

/**
 * 目录连接服务（D73 P1，执行方案 §5.4）：目录连接的业务端——
 *
 * - 目录视图（`apps.catalog.list`）与对 `McpService` 的连接来源（{@link AppConnectionsService.mcpSource}）；
 * - 交互流程的目录端（{@link AppConnectionsService.flowHost}）：目标校验 + 临时行、账号识别（id_token /
 *   userinfo 由流程给出；否则目录 `whoami` 只读工具；否则自动编号）、同账号复用旧行、首连工具复核；
 * - 连接管理：改名 / 停用、逐工具策略、工具复核、持续授权列表与撤销、自定义 server 的“测试 → 保存”批准。
 *
 * 令牌明文不经过这里：账号识别的 `whoami` 经 `McpService`（运行时授权提供者）发请求；行之间搬令牌
 * 走 `TokenVault.transferConnection`。
 */

/**
 * Bot 对应用连接的授权写入口（窄接口）。真实实现写 Bot Profile 的 `runtime.app_connection_ids`
 * （字段与校验在 bots 领域层，见 `apps/bot-grants.ts`）；core 在授权完成 / 连接删除时调用，
 * 渲染端从不直接改 Profile。
 */
export interface BotAppGrantWriter {
  /** 把连接 id 追加到该 Bot 的 `app_connection_ids`（幂等；同一应用已有别的账号时的替换规则由写入端决定）。 */
  grant(botId: string, connectionId: string): void | Promise<void>;
  /** 从所有 Bot 的 `app_connection_ids` 移除该连接；返回受影响的 Bot id。 */
  revokeConnection(connectionId: string): string[] | Promise<string[]>;
  /** 当前勾选了该连接的 Bot id。 */
  botsUsing(connectionId: string): string[];
}

const WHOAMI_TIMEOUT_MS = 10_000;

export interface AppConnectionsDeps {
  store: AppConnectionStore;
  vault: TokenVault;
  catalog: ConnectorCatalog;
  /** KepCup 预注册客户端表（P2 §6.4）：`registration: 'preregistered'` 条目仅在 clientRef 可解析时可连接。 */
  preregistered: PreregisteredClients;
  toolLock: ToolLockService;
  grants: AppToolGrants;
  mcp: Pick<McpService, 'serverFor' | 'listTools' | 'callTool' | 'closeServer'>;
  registry: Pick<ConnectionAuthRegistry, 'invalidate' | 'forget'>;
  disconnector: Pick<AppDisconnector, 'disconnect' | 'attachRowDeleted'>;
  auditor: AppAuditor;
  botGrants: BotAppGrantWriter;
  bots: { get(botId: string): { name: string } | null };
  settings: Pick<SettingsService, 'get'>;
  events: { emit(name: 'apps.connection_status', payload: AppConnectionStatusPayload): void };
  logger: Pick<CoreLogger, 'info' | 'warn'>;
  clock: Clock;
  whoamiTimeoutMs?: number;
}

/** 按 dot 路径取值（数组下标用数字）；取不到 / 不是标量返回 undefined。 */
export function extractPath(value: unknown, path: string): string | undefined {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'string') return current.trim().length > 0 ? current.trim() : undefined;
  if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  return undefined;
}

/** 工具结果里的 JSON：优先 `structuredContent`，否则第一个能解析成对象的文本块。 */
function jsonOfToolResult(result: CallToolResult): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined && structured !== null) return structured;
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // not JSON — try the next block
    }
  }
  return undefined;
}

function titleOf(row: AppToolRow): string | undefined {
  return typeof row.definition.title === 'string' ? row.definition.title : undefined;
}

export class AppConnectionsService {
  readonly #deps: AppConnectionsDeps;

  constructor(deps: AppConnectionsDeps) {
    this.#deps = deps;
    // 目录连接被删除（断开）时：从所有 Bot 的勾选中移除。
    deps.disconnector.attachRowDeleted(async ({ connectionId }) => {
      if (isCustomConnectionId(connectionId)) return;
      await deps.botGrants.revokeConnection(connectionId);
    });
  }

  // --- 目录视图 ---------------------------------------------------------------------

  /** `apps.catalog.list`：门禁放行后的条目 + 各自已连接账号数。 */
  catalogEntries(): AppCatalogEntry[] {
    const { catalog, store } = this.#deps;
    return catalog.list().map((entry) => {
      const meta = connectorMetaOf(entry);
      const connections = store.listByConnector(meta.slug);
      const unavailable = this.#unavailableReason(entry);
      const svg = catalog.iconSvg(meta.slug);
      return {
        connectorId: meta.slug,
        name: entry.name,
        title: entry.title,
        description: entry.description,
        version: entry.version,
        ...(entry.websiteUrl !== undefined ? { websiteUrl: entry.websiteUrl } : {}),
        privacyPolicy: meta.privacyPolicy,
        category: meta.category,
        tier: meta.tier,
        origin: catalog.originOf(meta.slug),
        authKind: meta.auth.kind,
        registration: meta.auth.registration,
        connectable: unavailable === null,
        ...(unavailable !== null ? { unavailableReason: unavailable } : {}),
        scopes: meta.auth.scopes,
        iconDataUri:
          svg !== null
            ? `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
            : null,
        connectedAccounts: connections.length,
        connectionIds: connections.map((connection) => connection.id),
      };
    });
  }

  #unavailableReason(entry: ConnectorCatalogEntry): string | null {
    const meta = connectorMetaOf(entry);
    if (connectorRemoteOf(entry) === null) return '该应用没有可用的远程端点';
    if (meta.auth.kind !== 'oauth') return `暂不支持 ${meta.auth.kind} 认证方式`;
    if (
      meta.auth.registration === 'preregistered' &&
      !this.#deps.preregistered.has(meta.auth.clientRef)
    ) {
      return `该应用需要 KepCup 预注册的客户端（${meta.auth.clientRef ?? '—'}），当前版本未包含`;
    }
    return null;
  }

  // --- 对 McpService 的连接来源 ---------------------------------------------------------

  mcpSource(): McpConnectionSource {
    const { store, catalog, toolLock } = this.#deps;
    return {
      list: () => store.list(),
      get: (connectionId) => {
        if (isCustomConnectionId(connectionId)) return null;
        return store.get(connectionId);
      },
      appName: (connectorId) => catalog.get(connectorId)?.title,
      toolPolicies: (connectionId) => toolLock.userPolicies(connectionId),
    };
  }

  // --- 交互流程的目录端 --------------------------------------------------------------------

  flowHost(): CatalogFlowHost {
    return {
      begin: (input) => this.#begin(input),
      abandon: (connectionId) => this.#abandon(connectionId),
      settle: (input) => this.#settle(input),
      confirm: (input) => this.#confirm(input),
      reject: (input) => this.#reject(input.connectionId),
    };
  }

  #begin(input: { connectorId: string; reconnectTo?: string | undefined }): CatalogFlowBegin {
    const { catalog, store } = this.#deps;
    // 只认门禁放行后的条目（`ConnectorCatalog` 已过滤）：门禁未放行的应用不能连接。
    const entry = catalog.get(input.connectorId);
    if (entry === null) {
      throw new AppError('NOT_FOUND', `应用「${input.connectorId}」不在目录中或尚未发布`, {
        connectorId: input.connectorId,
      });
    }
    const meta = connectorMetaOf(entry);
    const remote = connectorRemoteOf(entry);
    // 目录来源的条目（D73 P3 §7.1）：连接前再核一次端点是公网 https。registry 的回环例外按
    // 连接的 serverUrl 判断，这里保证目录来源的条目绝不会带着回环 / IP 字面量地址走到那一步。
    if (
      remote !== null &&
      catalog.isDirectorySourced(meta.slug) &&
      !isSafeDirectoryRemoteUrl(remote.url)
    ) {
      throw new AppError(
        'INVALID_INPUT',
        `应用「${entry.title}」的端点不是可接受的公网 https 地址`,
        {
          connectorId: meta.slug,
        },
      );
    }
    if (remote === null) {
      throw new AppError('NOT_IMPLEMENTED', `应用「${entry.title}」没有可用的远程端点`, {
        connectorId: meta.slug,
      });
    }
    if (meta.auth.kind !== 'oauth') {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `应用「${entry.title}」的认证方式（${meta.auth.kind}）暂不支持`,
        {
          connectorId: meta.slug,
        },
      );
    }
    if (
      meta.auth.registration === 'preregistered' &&
      !this.#deps.preregistered.has(meta.auth.clientRef)
    ) {
      // 客户端表（oauth-clients.json）里没有该 clientRef：明确失败，不退回自动注册。
      throw new AppError(
        'NOT_IMPLEMENTED',
        `应用「${entry.title}」需要 KepCup 预注册的客户端（${meta.auth.clientRef ?? '—'}），当前版本未包含`,
        { connectorId: meta.slug, clientRef: meta.auth.clientRef },
      );
    }
    let existingScopes: string[] = [];
    if (input.reconnectTo !== undefined) {
      const target = store.getRequired(input.reconnectTo);
      if (target.connectorId !== meta.slug) {
        throw new AppError('INVALID_INPUT', '该连接不属于这个应用', {
          connectionId: target.id,
          connectorId: meta.slug,
        });
      }
      // 已授予 ∪ 运行时 step-up 挑战要求过的（卡片被忽略后，设置页「重新连接」同样补上）。
      existingScopes = [
        ...new Set([...target.scopes, ...this.#deps.vault.getPendingScopes(target.id)]),
      ];
    }
    const scratch = store.create({
      connectorId: meta.slug,
      connectorVer: entry.version,
      label: entry.title,
      serverUrl: remote.url,
      status: 'connecting',
    });
    return {
      connectorId: meta.slug,
      title: entry.title,
      tier: meta.tier,
      serverUrl: remote.url,
      defaultScopes: meta.auth.scopes.default,
      clientRef: meta.auth.registration === 'preregistered' ? meta.auth.clientRef : null,
      connectionId: scratch.id,
      reconnectTo: input.reconnectTo ?? null,
      existingScopes,
    };
  }

  /** 令牌落盘之前流程就结束：临时行没有任何令牌，直接删除。 */
  #abandon(connectionId: string): void {
    const { store, vault } = this.#deps;
    if (store.get(connectionId) === null) return;
    vault.clearConnection(connectionId, { deleteRow: true });
    this.#deps.events.emit('apps.connection_status', { connectionId, status: 'not_connected' });
  }

  async #reject(connectionId: string): Promise<void> {
    if (this.#deps.store.get(connectionId) === null) return;
    // 吊销（RFC 7009）+ 清除 + 删行；流程自己在收尾，所以不再等它（否则等自己）。
    await this.#deps.disconnector.disconnect(connectionId, { removeRow: true, cancelFlows: false });
  }

  async #settle(input: {
    connectionId: string;
    reconnectTo: string | null;
    hint: AccountHint | null;
    signal: AbortSignal;
  }): Promise<CatalogSettleResult> {
    const { store, vault, registry, mcp, toolLock, logger } = this.#deps;
    const scratch = store.getRequired(input.connectionId);
    const entry = this.#deps.catalog.get(scratch.connectorId);

    // 1. 账号识别：id_token / userinfo（流程已解析为 hint）→ 目录 whoami → 自动编号。
    let identity: AccountHint = { ...(input.hint ?? {}) };
    if (
      identity.sub === undefined &&
      entry !== null &&
      connectorMetaOf(entry).whoami !== undefined
    ) {
      try {
        const who = await this.#whoami(scratch, entry, input.signal);
        identity = { ...who, ...(identity.label !== undefined ? { label: identity.label } : {}) };
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason ?? error;
        logger.warn(
          { connectionId: scratch.id, err: error instanceof Error ? error.message : String(error) },
          'whoami account lookup failed; using an auto label',
        );
      }
    }
    input.signal.throwIfAborted();

    // 2. 最终行：重新授权 → 目标行（账号必须一致）；同一账号已有连接 → 复用旧行；否则临时行。
    let finalRow: AppConnection = scratch;
    if (input.reconnectTo !== null) {
      const target = store.getRequired(input.reconnectTo);
      if (
        identity.sub !== undefined &&
        target.accountSub !== null &&
        target.accountSub !== identity.sub
      ) {
        throw new AppError(
          'OAUTH_FLOW_FAILED',
          '重新授权使用的账号与该连接原来的账号不一致。请用原账号重新授权，或另外添加一个账号',
          { connectionId: target.id },
        );
      }
      finalRow = target;
    } else if (identity.sub !== undefined) {
      const existing = store.findByConnector(scratch.connectorId, identity.sub);
      if (existing !== null && existing.id !== scratch.id) finalRow = existing;
    }
    const merged = finalRow.id !== scratch.id;

    if (merged) {
      vault.transferConnection(scratch.id, finalRow.id);
      store.update(finalRow.id, {
        connectorVer: scratch.connectorVer,
        ...(identity.sub !== undefined && finalRow.accountSub === null
          ? { accountSub: identity.sub }
          : {}),
        ...(finalRow.status !== 'disabled' ? { status: 'connected' as const } : {}),
      });
      // 临时行：丢弃缓存的连接 / 提供者，清令牌（不吊销——令牌已搬到旧行上继续使用）并删行。
      await registry.invalidate(scratch.id);
      vault.clearConnection(scratch.id, { deleteRow: true });
      registry.forget(scratch.id);
      this.#deps.events.emit('apps.connection_status', {
        connectionId: scratch.id,
        status: 'not_connected',
      });
    } else {
      store.update(scratch.id, {
        label: identity.label ?? this.#nextAutoLabel(scratch),
        accountSub: identity.sub ?? null,
      });
    }
    // 旧行上的缓存连接可能还握着旧令牌：丢弃后用新令牌重连。
    await registry.invalidate(finalRow.id);
    input.signal.throwIfAborted();

    // 3. 工具清单：重新拉取并登记工具锁定（新增 / 定义变化 → 待复核，不暴露）。
    const server = this.#deps.mcp.serverFor(finalRow.id);
    if (server === undefined) {
      throw new AppError('APP_CONNECTION_NOT_FOUND', `Connection "${finalRow.id}" not found`, {
        connectionId: finalRow.id,
      });
    }
    await mcp.listTools(server, { countFailure: false, refresh: true, signal: input.signal });
    const review: AppConnectReviewTool[] = toolLock
      .list(finalRow.id)
      .filter((row) => row.state !== 'approved')
      .map((row) => ({
        name: row.toolName,
        ...(titleOf(row) !== undefined ? { title: titleOf(row)! } : {}),
        ...(row.definition.description !== undefined
          ? { description: row.definition.description }
          : {}),
        risk: row.risk,
      }));
    const updated = store.getRequired(finalRow.id);
    return {
      connectionId: updated.id,
      isNew: !merged,
      accountLabel: updated.label,
      review,
    };
  }

  /** 目录声明的账号识别：调用一个只读工具，按字段路径取显示名 / 稳定标识。 */
  async #whoami(
    connection: AppConnection,
    entry: ConnectorCatalogEntry,
    signal: AbortSignal,
  ): Promise<AccountHint> {
    const meta = connectorMetaOf(entry);
    const whoami = meta.whoami;
    if (whoami === undefined) return {};
    const { mcp } = this.#deps;
    const server = mcp.serverFor(connection.id);
    if (server === undefined) return {};
    const timeout = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#deps.whoamiTimeoutMs ?? WHOAMI_TIMEOUT_MS),
    ]);
    const tools = await mcp.listTools(server, { countFailure: false, signal: timeout });
    const tool = tools.find((candidate) => candidate.name === whoami.tool);
    if (tool === undefined) return {};
    // 只调用只读工具（此时工具清单还没经用户复核）：按当前定义重新分级，不是只读就不调用。
    const risk = classifyAppToolRisk(
      { name: tool.name, annotations: tool.annotations },
      { tier: meta.tier, toolPolicy: meta.toolPolicy },
    ).risk;
    if (risk !== 'read') {
      this.#deps.logger.warn(
        { connectionId: connection.id, tool: tool.name, risk },
        'whoami tool is not read-only; skipped',
      );
      return {};
    }
    const result = await mcp.callTool(server, whoami.tool, whoami.arguments ?? {}, {
      signal: timeout,
    });
    if (result.isError === true) return {};
    const json = jsonOfToolResult(result);
    const sub =
      whoami.subjectPath !== undefined ? extractPath(json, whoami.subjectPath) : undefined;
    const label = extractPath(json, whoami.labelPath);
    return {
      ...(sub !== undefined ? { sub: sub.slice(0, 200) } : {}),
      ...(label !== undefined ? { label: label.slice(0, 100) } : {}),
    };
  }

  /** `"{title} #{n}"`：同一应用下最小的、没被别的连接占用的序号。 */
  #nextAutoLabel(row: AppConnection): string {
    const entry = this.#deps.catalog.get(row.connectorId);
    const title = entry?.title ?? row.connectorId;
    const used = new Set(
      this.#deps.store
        .listByConnector(row.connectorId)
        .filter((other) => other.id !== row.id)
        .map((other) => other.label),
    );
    for (let n = 1; ; n += 1) {
      const label = `${title} #${n}`;
      if (!used.has(label)) return label;
    }
  }

  async #confirm(input: { connectionId: string; grantBotIds: readonly string[] }): Promise<void> {
    const { store, toolLock, auditor, botGrants, logger } = this.#deps;
    const row = store.getRequired(input.connectionId);
    const approved = toolLock.approve(row.id, 'all');
    if (approved.length > 0) {
      auditor.auditAppToolsReview({ connectionId: row.id, connectorId: row.connectorId, approved });
    }
    if (store.getRequired(row.id).status !== 'disabled') store.setStatus(row.id, 'connected');
    // 流程收集到的每个 Bot（发起者 + 并发去重接入者）各自授权；一个失败不影响其余。
    for (const botId of input.grantBotIds) {
      try {
        await botGrants.grant(botId, row.id);
      } catch (error) {
        // 连接本身已成功：授权 Bot 失败只告警，用户可在 Bot 设置里手动勾选。
        logger.warn(
          { connectionId: row.id, botId, err: String(error) },
          'granting the connection to the bot failed',
        );
      }
    }
  }

  // --- 连接管理（RPC） -----------------------------------------------------------------

  /** 目录连接才可经这些方法管理；自定义 server 走 settings。 */
  #catalogRow(connectionId: string): AppConnection {
    if (isCustomConnectionId(connectionId)) {
      throw new AppError('INVALID_INPUT', '自定义 MCP server 请在扩展中心「MCP」管理（高级配置在「设置 → 开发者模式」）', {
        connectionId,
      });
    }
    return this.#deps.store.getRequired(connectionId);
  }

  async update(input: {
    connectionId: string;
    label?: string | undefined;
    disabled?: boolean | undefined;
  }): Promise<AppConnection> {
    const { store, vault, toolLock, mcp } = this.#deps;
    const row = this.#catalogRow(input.connectionId);
    if (input.label !== undefined) store.update(row.id, { label: input.label });
    if (input.disabled === true && row.status !== 'disabled') {
      store.setStatus(row.id, 'disabled');
      await mcp.closeServer(row.id);
    } else if (input.disabled === false && row.status === 'disabled') {
      const hasTokens = vault.getTokens(row.id) !== null;
      const pending = toolLock.pendingSummary(row.id);
      store.setStatus(
        row.id,
        !hasTokens
          ? 'not_connected'
          : pending.added + pending.changed > 0
            ? 'tools_changed'
            : 'connected',
      );
    }
    const updated = store.getRequired(row.id);
    this.#deps.events.emit('apps.connection_status', {
      connectionId: updated.id,
      status: updated.status,
    });
    return updated;
  }

  /** 连接的工具清单（风险档、锁定状态、策略、新旧定义）。目录连接没有缓存行时先拉取一次。 */
  async tools(connectionId: string): Promise<{
    tools: AppToolView[];
    pending: { added: number; changed: number };
  }> {
    const { store, toolLock, mcp } = this.#deps;
    const row = store.getRequired(connectionId);
    if (toolLock.list(connectionId).length === 0 && row.status !== 'disabled') {
      const server = mcp.serverFor(connectionId);
      if (server !== undefined) {
        // 尽力而为：未连接 / 服务端不可达时返回空清单，不当成错误。
        await mcp.listTools(server, { countFailure: false, refresh: true }).catch(() => undefined);
      }
    }
    return this.#toolsView(connectionId);
  }

  #toolsView(connectionId: string): {
    tools: AppToolView[];
    pending: { added: number; changed: number };
  } {
    const { toolLock } = this.#deps;
    const server = isCustomConnectionId(connectionId)
      ? this.#deps.settings
          .get()
          .mcpServers.find((entry) => entry.id === connectionId.slice('custom:'.length))
      : undefined;
    const tools = toolLock.list(connectionId).map((row) => this.#viewOf(row, server));
    return { tools, pending: toolLock.pendingSummary(connectionId) };
  }

  #viewOf(row: AppToolRow, server: McpServer | undefined): AppToolView {
    // 目录连接的策略存在行里；自定义 server 的策略在 settings（W5），行里恒为 null。
    const policy: McpToolPolicy | null =
      server !== undefined ? (server.toolPolicies?.[row.toolName] ?? null) : row.userPolicy;
    const enabled = policy?.enabled !== false;
    const approval =
      policy?.approval ??
      (server?.autoApprove === true ? 'auto' : row.risk === 'read' ? 'auto' : 'ask');
    const title = titleOf(row);
    return {
      toolName: row.toolName,
      ...(title !== undefined ? { title } : {}),
      ...(row.definition.description !== undefined
        ? { description: row.definition.description }
        : {}),
      risk: row.risk,
      state: row.state,
      policy,
      enabled,
      approval,
      exposed: row.state === 'approved' && enabled,
      definition: row.definition as AppToolDefinition,
      approvedDefinition: row.approvedDefinition as AppToolDefinition | null,
    };
  }

  /** 复核通过 `accept` 里的工具（其余保持锁定），返回最新清单。 */
  reviewTools(input: { connectionId: string; accept: string[] }): {
    approved: string[];
    tools: AppToolView[];
    pending: { added: number; changed: number };
  } {
    const row = this.#deps.store.getRequired(input.connectionId);
    const approved = this.#deps.toolLock.approve(row.id, input.accept);
    if (approved.length > 0) {
      this.#deps.auditor.auditAppToolsReview({
        connectionId: row.id,
        connectorId: row.connectorId,
        approved,
      });
    }
    return { approved, ...this.#toolsView(row.id) };
  }

  /**
   * 目录连接的逐工具策略（`policy` 与 W5 `mcpToolPolicy` 同形；空对象 = 清除）。自定义 server 继续
   * 用 `settings.mcpServers[].toolPolicies`。返回策略是否比之前更严（停用 / 免审批改为每次确认），
   * 调用方据此中断受影响的运行中任务（W3）。
   */
  setToolPolicy(input: { connectionId: string; toolName: string; policy: McpToolPolicy }): {
    restricted: boolean;
  } {
    const row = this.#catalogRow(input.connectionId);
    const { toolLock } = this.#deps;
    const policy = mcpToolPolicySchema.parse(input.policy);
    const before = toolLock.list(row.id).find((tool) => tool.toolName === input.toolName);
    if (before === undefined) {
      throw new AppError('NOT_FOUND', `连接 ${row.id} 没有工具 ${input.toolName}`, {
        connectionId: row.id,
        toolName: input.toolName,
      });
    }
    const effective = (
      value: McpToolPolicy | null,
    ): { enabled: boolean; approval: 'auto' | 'ask' } => ({
      enabled: value?.enabled !== false,
      approval: value?.approval ?? (before.risk === 'read' ? 'auto' : 'ask'),
    });
    const previous = effective(before.userPolicy);
    toolLock.setUserPolicy(row.id, input.toolName, policy);
    const next = effective(toolLock.getUserPolicy(row.id, input.toolName));
    return {
      restricted:
        (previous.enabled && !next.enabled) ||
        (previous.approval === 'auto' && next.approval === 'ask'),
    };
  }

  grantsOf(connectionId: string): AppToolGrantView[] {
    this.#deps.store.getRequired(connectionId);
    return this.#deps.grants.list({ connectionId }).map((grant) => ({
      id: grant.id,
      botId: grant.botId,
      botName: this.#deps.bots.get(grant.botId)?.name ?? null,
      connectionId: grant.connectionId,
      toolName: grant.toolName,
      conversationId: grant.conversationId,
      createdAt: grant.createdAt,
    }));
  }

  revokeGrant(grantId: string): void {
    if (!this.#deps.grants.revoke(grantId)) {
      throw new AppError('NOT_FOUND', '持续授权不存在或已撤销', { grantId });
    }
  }

  /**
   * 自定义 server 的“测试 → 保存”：保存之后批准**测试时看到的**工具定义（`toolHashes` 来自
   * `mcp.test`）。重新拉取一次当前定义并登记锁定；只有哈希与测试时一致的工具被批准。
   */
  async approveAfterTest(input: {
    serverId: string;
    toolHashes: Record<string, string>;
  }): Promise<{ approved: string[]; pending: { added: number; changed: number } }> {
    const { settings, mcp, toolLock, auditor } = this.#deps;
    const server = settings.get().mcpServers.find((entry) => entry.id === input.serverId);
    if (server === undefined) {
      throw new AppError('NOT_FOUND', `MCP 服务器 ${input.serverId} 不存在（请先保存配置）`, {
        serverId: input.serverId,
      });
    }
    const connectionId = customConnectionId(server.id);
    await mcp.listTools(server, { countFailure: false, refresh: true });
    const approved = toolLock.approveByHash(connectionId, input.toolHashes);
    if (approved.length > 0) {
      auditor.auditAppToolsReview({ connectionId, connectorId: connectionId, approved });
    }
    return { approved, pending: toolLock.pendingSummary(connectionId) };
  }
}

/**
 * 真实的 {@link BotAppGrantWriter}：委托 bots 领域层（`BotsService.grantConnection` /
 * `removeConnectionFromAll` 负责 `app_connection_ids` 的校验与“同一应用至多一个账号”的替换），
 * 写入后推 `bot.updated` 让界面刷新 Profile。
 */
export function createBotAppGrantWriter(
  bots: Pick<
    BotsService,
    'get' | 'grantConnection' | 'removeConnectionFromAll' | 'listAppConnectionHolders'
  >,
  events: { emit(name: 'bot.updated', payload: { bot: Bot }): void },
): BotAppGrantWriter {
  const publish = (botId: string): void => {
    const bot = bots.get(botId);
    if (bot !== null) events.emit('bot.updated', { bot });
  };
  return {
    grant: (botId, connectionId) => {
      const { replaced } = bots.grantConnection(botId, connectionId);
      if (
        replaced.length > 0 ||
        bots.get(botId)?.profile.runtime.app_connection_ids.includes(connectionId)
      ) {
        publish(botId);
      }
    },
    revokeConnection: (connectionId) => {
      const affected = bots.removeConnectionFromAll(connectionId);
      for (const botId of affected) publish(botId);
      return affected;
    },
    botsUsing: (connectionId) => bots.listAppConnectionHolders(connectionId).map((bot) => bot.id),
  };
}

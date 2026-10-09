import type { ToolAnnotations } from '@earendil-works/pi-mcp';
import {
  AppError,
  mcpToolPolicySchema,
  type AppConnectionStatusPayload,
  type McpServer,
  type McpToolPolicy,
  type McpToolRisk,
  type Settings,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { CoreLogger } from '../infra/logger.js';
import {
  customConnectionId,
  isCatalogConnectionId,
  isCustomConnectionId,
  type AppConnectionStore,
} from './connection-store.js';
import {
  classifyAppToolRisk,
  toolDefinitionHash,
  type CatalogToolPolicyInput,
  type HashableTool,
} from './policy.js';

/**
 * 工具定义锁定（D73 P1，design 29 §8.2 / 执行方案 §5.3、§5.5）：防 rug pull / 工具投毒。
 *
 * 对**所有** MCP server 生效。承载行是 `app_connections`（目录连接 `conn_…`；自定义 server
 * `custom:{serverId}`，含无 OAuth 的 stdio / headers server，`server_url` 可为 NULL）；每个工具
 * 一行 `app_connection_tools`：
 *
 * - 新工具 → `approved_hash` NULL；定义变化 → `current_hash ≠ approved_hash`；二者都**不暴露**
 *   给模型（{@link ToolLockService.exposedTools}），连接状态 `connected → tools_changed`；
 * - 消失的工具直接删行；用户复核后 {@link ToolLockService.approve}；
 * - 存量基线：升级前已存在的自定义 server 的连接行 `baseline_pending=1`，首次拉取到的工具
 *   直接批准（{@link ToolLockService.runBaseline}，只作用一次）；
 * - 之后新加的自定义 server：设置页「测试」成功后展示工具清单，保存即批准
 *   （{@link ToolLockService.approveAfterTest}）；否则工具不暴露。
 */

/** pi-mcp `Tool` 的结构化子集（锁定只关心这些字段）。 */
export interface LockableTool extends HashableTool {
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations | undefined;
}

export type ToolLockState = 'approved' | 'new' | 'changed';

/** `app_connection_tools` 的一行（对外视图）。 */
export interface AppToolRow {
  connectionId: string;
  toolName: string;
  approvedHash: string | null;
  currentHash: string;
  risk: McpToolRisk;
  userPolicy: McpToolPolicy | null;
  /** 最近一次 `tools/list` 里的完整定义（复核 diff 的“新”）。 */
  definition: LockableTool;
  /** 批准当时的定义快照（复核 diff 的“旧”）；从未批准为 null。 */
  approvedDefinition: LockableTool | null;
  /** `new` = 从未批准；`changed` = 批准过但定义已变；`approved` = 当前定义已批准。 */
  state: ToolLockState;
}

/** 待复核的工具数（新增 / 定义改变）与本次刷新下线的工具数。 */
export interface ToolLockSummary {
  added: number;
  changed: number;
  removed: number;
}

export interface LockedToolInfo {
  name: string;
  reason: 'new' | 'changed';
}

export interface ToolLockPartition<T> {
  exposed: T[];
  /** 因待复核而未暴露的工具（用户停用的工具不算）。 */
  locked: LockedToolInfo[];
}

export interface ToolLockRefreshResult {
  connectionId: string;
  /** 本次刷新是否有变化（新增 / 定义变化 / 下线，含自动批准的）。 */
  changed: boolean;
  /** 刷新之后仍待复核的工具（名字）。 */
  pending: { added: string[]; changed: string[] };
  removed: string[];
  /** 本次因基线 / 首次信任直接批准的工具。 */
  autoApproved: string[];
}

/** {@link ToolLockService.refresh} 的上下文：用于建 `custom:` 行与目录叠加。 */
export interface ToolLockRefreshContext {
  /** 自定义 server（不存在 `custom:` 行时据此建行）。 */
  server?: Pick<McpServer, 'id' | 'name' | 'url' | 'auth'> | undefined;
  /** 目录连接的 tier + toolPolicy（由连接服务提供；自定义 server 没有）。 */
  catalog?: CatalogToolPolicyInput | undefined;
  /** 用户已看过这份清单（设置页「测试」后保存）：新增 / 变化的工具直接批准。 */
  approveAll?: boolean | undefined;
}

export interface ToolLockDeps {
  db: SqliteDatabase;
  clock: Clock;
  store: AppConnectionStore;
  logger: Pick<CoreLogger, 'info' | 'warn'>;
  /** 读写 `settings.apps.toolLockBaselineDone`；缺省则不做存量基线。 */
  settings?: Pick<
    { get(): Settings; update(patch: Partial<Settings>): Settings },
    'get' | 'update'
  >;
  /** 状态变化广播（`apps.connection_status`）。 */
  onStatus?: ((payload: AppConnectionStatusPayload) => void) | undefined;
  /** 目录连接的叠加来源（连接 id → tier + toolPolicy）；自定义连接恒为 undefined。 */
  catalogPolicyFor?: ((connectionId: string) => CatalogToolPolicyInput | undefined) | undefined;
  /** OAuth 自定义 server 是否已有令牌（决定新建行 / 同步时是 `not_connected` 还是 `connected`）。 */
  hasTokens?: ((connectionId: string) => boolean) | undefined;
  /**
   * 测试钩子：新工具（第一次见到）直接批准，行为同存量基线；**定义变化仍锁定**。生产恒为
   * false（`start.ts` 只在 NODE_ENV=test 的测试构建里接受该选项）。
   */
  trustFirstList?: boolean | undefined;
}

interface ToolRowRecord {
  connection_id: string;
  tool_name: string;
  approved_hash: string | null;
  current_hash: string;
  risk: string;
  user_policy: string | null;
  definition_json: string;
  approved_definition_json: string | null;
}

function parsePolicy(json: string | null): McpToolPolicy | null {
  if (json === null) return null;
  try {
    const parsed = mcpToolPolicySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function stateOf(approved: string | null, current: string): ToolLockState {
  if (approved === null) return 'new';
  return approved === current ? 'approved' : 'changed';
}

/** 锁定行 key：自定义 server → `custom:{id}`；目录连接合成的 server（id 即 `conn_…`）原样。 */
export function toolLockKey(server: Pick<McpServer, 'id'>): string {
  return isCatalogConnectionId(server.id) ? server.id : customConnectionId(server.id);
}

export class ToolLockService {
  readonly #deps: ToolLockDeps;

  constructor(deps: ToolLockDeps) {
    this.#deps = deps;
  }

  /**
   * 工具列表刷新（`tools/list`，含 `list_changed` 之后的重拉）：与存量比对、落库、必要时
   * 切换连接状态并发 `apps.connection_status`。同步、幂等。
   */
  refresh(
    connectionId: string,
    tools: readonly LockableTool[],
    ctx: ToolLockRefreshContext = {},
  ): ToolLockRefreshResult {
    const { db, store } = this.#deps;
    this.#ensureConnectionRow(connectionId, ctx);
    const catalog = ctx.catalog ?? this.#deps.catalogPolicyFor?.(connectionId);
    const baseline = store.isBaselinePending(connectionId);
    const trustAll = baseline || ctx.approveAll === true;

    const unique = new Map<string, LockableTool>();
    for (const tool of tools) unique.set(tool.name, tool);

    const outcome = db.transaction(() => {
      const existing = new Map(
        (
          db
            .prepare('select * from app_connection_tools where connection_id = ?')
            .all(connectionId) as ToolRowRecord[]
        ).map((row) => [row.tool_name, row]),
      );
      const result = {
        changed: false,
        removed: [] as string[],
        autoApproved: [] as string[],
      };
      const upsert = db.prepare(
        `insert into app_connection_tools
           (connection_id, tool_name, approved_hash, current_hash, risk, user_policy,
            definition_json, approved_definition_json)
         values (?, ?, ?, ?, ?, null, ?, ?)
         on conflict(connection_id, tool_name) do update set
           approved_hash = excluded.approved_hash, current_hash = excluded.current_hash,
           risk = excluded.risk, definition_json = excluded.definition_json,
           approved_definition_json = excluded.approved_definition_json`,
      );
      for (const [name, tool] of unique) {
        const hash = toolDefinitionHash(tool);
        const previous = existing.get(name);
        const risk = classifyAppToolRisk({ name, annotations: tool.annotations }, catalog).risk;
        let approved: string | null = previous?.approved_hash ?? null;
        const definition = JSON.stringify(definitionOf(tool));
        let approvedDefinition: string | null = previous?.approved_definition_json ?? null;
        if (
          (trustAll || (previous === undefined && this.#deps.trustFirstList === true)) &&
          approved !== hash
        ) {
          approved = hash;
          approvedDefinition = definition;
          result.autoApproved.push(name);
        } else if (approved === hash && approvedDefinition === null) {
          approvedDefinition = definition;
        }
        if (previous === undefined || previous.current_hash !== hash) result.changed = true;
        upsert.run(connectionId, name, approved, hash, risk, definition, approvedDefinition);
      }
      for (const name of existing.keys()) {
        if (unique.has(name)) continue;
        db.prepare(
          'delete from app_connection_tools where connection_id = ? and tool_name = ?',
        ).run(connectionId, name);
        result.removed.push(name);
        result.changed = true;
      }
      if (baseline) store.setBaselinePending(connectionId, false);
      return result;
    })();

    const pending = this.#pendingNames(connectionId);
    const removedCount = outcome.removed.length;
    this.#syncStatus(connectionId, pending, {
      announce: outcome.changed,
      removed: removedCount,
    });
    if (outcome.removed.length > 0 || pending.added.length + pending.changed.length > 0) {
      this.#deps.logger.info(
        {
          connectionId,
          added: pending.added.length,
          changed: pending.changed.length,
          removed: removedCount,
        },
        'tool definitions need review',
      );
    }
    return {
      connectionId,
      changed: outcome.changed,
      pending,
      removed: outcome.removed,
      autoApproved: outcome.autoApproved,
    };
  }

  /**
   * 复核通过：`approved_hash = current_hash`。`'all'` = 全部待复核的工具。返回实际被批准
   * 的工具名；之后若再无待复核的工具，`tools_changed → connected`。
   */
  approve(connectionId: string, toolNames: readonly string[] | 'all'): string[] {
    const { db } = this.#deps;
    const targets =
      toolNames === 'all'
        ? this.list(connectionId)
            .filter((row) => row.state !== 'approved')
            .map((row) => row.toolName)
        : [...new Set(toolNames)];
    const approved: string[] = [];
    db.transaction(() => {
      const update = db.prepare(
        `update app_connection_tools
            set approved_hash = current_hash, approved_definition_json = definition_json
          where connection_id = ? and tool_name = ?
            and (approved_hash is null or approved_hash != current_hash)`,
      );
      for (const name of targets) {
        if (update.run(connectionId, name).changes > 0) approved.push(name);
      }
    })();
    if (approved.length > 0) {
      this.#syncStatus(connectionId, this.#pendingNames(connectionId), {
        announce: false,
        removed: 0,
      });
    }
    return approved;
  }

  /**
   * 只批准「当前定义哈希 == 调用方看过的哈希」的工具（设置页“测试 → 保存”：测试时看到的那份
   * 定义；测试与保存之间被服务端改动的工具仍然锁定）。返回实际被批准的工具名。
   */
  approveByHash(connectionId: string, expected: Readonly<Record<string, string>>): string[] {
    const { db } = this.#deps;
    const approved: string[] = [];
    db.transaction(() => {
      const update = db.prepare(
        `update app_connection_tools
            set approved_hash = current_hash, approved_definition_json = definition_json
          where connection_id = ? and tool_name = ? and current_hash = ?
            and (approved_hash is null or approved_hash != current_hash)`,
      );
      for (const [name, hash] of Object.entries(expected)) {
        if (update.run(connectionId, name, hash).changes > 0) approved.push(name);
      }
    })();
    if (approved.length > 0) {
      this.#syncStatus(connectionId, this.#pendingNames(connectionId), {
        announce: false,
        removed: 0,
      });
    }
    return approved;
  }

  /**
   * 当前定义是否已批准且未被用户停用——网关在调用时再核一次（run 中途定义变化的工具
   * 不再放行）。没有行 = 未知工具 = 不放行（fail-closed）。
   */
  isExposed(connectionId: string, toolName: string): boolean {
    const row = this.#row(connectionId, toolName);
    if (row === null) return false;
    return (
      row.approved_hash !== null &&
      row.approved_hash === row.current_hash &&
      parsePolicy(row.user_policy)?.enabled !== false
    );
  }

  /**
   * 暴露过滤：只留「当前定义（现算哈希）== 已批准哈希」且未被用户停用的工具；其余分成
   * `locked`（待复核，提示用）。顺序保持。
   */
  partition<T extends LockableTool>(
    connectionId: string,
    tools: readonly T[],
  ): ToolLockPartition<T> {
    const rows = new Map(this.#rowsOf(connectionId).map((row) => [row.tool_name, row]));
    const exposed: T[] = [];
    const locked: LockedToolInfo[] = [];
    for (const tool of tools) {
      const row = rows.get(tool.name);
      const approved = row?.approved_hash ?? null;
      if (approved === null) {
        locked.push({ name: tool.name, reason: 'new' });
        continue;
      }
      if (approved !== toolDefinitionHash(tool)) {
        locked.push({ name: tool.name, reason: 'changed' });
        continue;
      }
      if (parsePolicy(row?.user_policy ?? null)?.enabled === false) continue;
      exposed.push(tool);
    }
    return { exposed, locked };
  }

  exposedTools<T extends LockableTool>(connectionId: string, tools: readonly T[]): T[] {
    return this.partition(connectionId, tools).exposed;
  }

  list(connectionId: string): AppToolRow[] {
    return this.#rowsOf(connectionId).map(toRow);
  }

  /** 该连接所有设置了逐工具策略的工具 → 策略（`McpService` 合成 server 的 `toolPolicies`；同步、轻量）。 */
  userPolicies(connectionId: string): Record<string, McpToolPolicy> {
    const rows = this.#deps.db
      .prepare(
        'select tool_name, user_policy from app_connection_tools where connection_id = ? and user_policy is not null',
      )
      .all(connectionId) as Array<{ tool_name: string; user_policy: string | null }>;
    const out: Record<string, McpToolPolicy> = {};
    for (const row of rows) {
      const policy = parsePolicy(row.user_policy);
      if (policy !== null) out[row.tool_name] = policy;
    }
    return out;
  }

  getUserPolicy(connectionId: string, toolName: string): McpToolPolicy | null {
    return parsePolicy(this.#row(connectionId, toolName)?.user_policy ?? null);
  }

  /** 设置逐工具策略（与 W5 `mcpToolPolicy` 同形）；`null` / 空对象 = 清除，回到风险档默认。 */
  setUserPolicy(connectionId: string, toolName: string, policy: McpToolPolicy | null): void {
    if (this.#row(connectionId, toolName) === null) {
      throw new AppError('NOT_FOUND', `连接 ${connectionId} 没有工具 ${toolName}`, {
        connectionId,
        toolName,
      });
    }
    const parsed = policy === null ? {} : mcpToolPolicySchema.parse(policy);
    const clean: McpToolPolicy = {
      ...(parsed.approval !== undefined ? { approval: parsed.approval } : {}),
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
    };
    this.#deps.db
      .prepare(
        'update app_connection_tools set user_policy = ? where connection_id = ? and tool_name = ?',
      )
      .run(Object.keys(clean).length === 0 ? null : JSON.stringify(clean), connectionId, toolName);
  }

  /** 待复核的工具数（新增 / 定义改变）。 */
  pendingSummary(connectionId: string): { added: number; changed: number } {
    const pending = this.#pendingNames(connectionId);
    return { added: pending.added.length, changed: pending.changed.length };
  }

  /**
   * 存量基线（只作用一次）：`settings.apps.toolLockBaselineDone` 不为真时，为当时已存在的
   * 每个自定义 server 建 `custom:` 行并标记 `baseline_pending`（首次拉取到的工具直接批准），
   * 然后置位标记。返回被标记的 serverId。
   */
  runBaseline(): string[] {
    const { settings, db } = this.#deps;
    if (settings === undefined) return [];
    const current = settings.get();
    if (current.apps.toolLockBaselineDone) return [];
    const marked: string[] = [];
    db.transaction(() => {
      for (const server of current.mcpServers) {
        const id = customConnectionId(server.id);
        this.#ensureCustomRow(server);
        const hasTools =
          (
            db
              .prepare('select count(*) as n from app_connection_tools where connection_id = ?')
              .get(id) as { n: number }
          ).n > 0;
        if (hasTools) continue;
        this.#deps.store.setBaselinePending(id, true);
        marked.push(server.id);
      }
      settings.update({ apps: { ...current.apps, toolLockBaselineDone: true } });
    })();
    if (marked.length > 0) {
      this.#deps.logger.info(
        { serverIds: marked },
        'tool lock baseline: existing servers pending first fetch',
      );
    }
    return marked;
  }

  /**
   * 设置页「测试」成功后保存：把测试时看到的工具清单记为已批准（用户已在界面看过清单）。
   * 同时建/同步 `custom:` 行。`tools` 必须是测试拉到的那份，批准的是它们此刻的定义哈希。
   */
  approveAfterTest(
    server: Pick<McpServer, 'id' | 'name' | 'url' | 'auth'>,
    tools: readonly LockableTool[],
  ): ToolLockRefreshResult {
    return this.refresh(customConnectionId(server.id), tools, { server, approveAll: true });
  }

  // --- 内部 ---------------------------------------------------------------

  #rowsOf(connectionId: string): ToolRowRecord[] {
    return this.#deps.db
      .prepare('select * from app_connection_tools where connection_id = ? order by tool_name')
      .all(connectionId) as ToolRowRecord[];
  }

  #row(connectionId: string, toolName: string): ToolRowRecord | null {
    return (
      (this.#deps.db
        .prepare('select * from app_connection_tools where connection_id = ? and tool_name = ?')
        .get(connectionId, toolName) as ToolRowRecord | undefined) ?? null
    );
  }

  #pendingNames(connectionId: string): { added: string[]; changed: string[] } {
    const pending = { added: [] as string[], changed: [] as string[] };
    for (const row of this.#rowsOf(connectionId)) {
      const state = stateOf(row.approved_hash, row.current_hash);
      if (state === 'new') pending.added.push(row.tool_name);
      else if (state === 'changed') pending.changed.push(row.tool_name);
    }
    return pending;
  }

  /** 连接行不存在：自定义 server 据 ctx 建行；目录连接必须已存在。 */
  #ensureConnectionRow(connectionId: string, ctx: ToolLockRefreshContext): void {
    const { store } = this.#deps;
    if (isCustomConnectionId(connectionId)) {
      const serverId = connectionId.slice('custom:'.length);
      this.#ensureCustomRow(
        ctx.server ?? { id: serverId, name: serverId, url: undefined, auth: 'none' },
      );
      return;
    }
    store.getRequired(connectionId);
  }

  /**
   * 自定义 server 的承载行。非 OAuth server 恒为 `connected`（无需授权；界面的 `apps.connections.list`
   * 默认隐藏 `custom:` 行）；OAuth server 的状态归 P0 的授权引擎管（这里只在新建时按有无令牌取值，
   * 并纠正「刚改成 OAuth、行还停在 connected 但没有令牌」）。
   */
  #ensureCustomRow(server: Pick<McpServer, 'id' | 'name' | 'url' | 'auth'>): void {
    const { store } = this.#deps;
    const id = customConnectionId(server.id);
    const oauth = server.auth === 'oauth';
    const tokens = oauth ? (this.#deps.hasTokens?.(id) ?? false) : false;
    const row = store.ensureCustom(server.id, {
      label: server.name,
      serverUrl: server.url ?? null,
      status: oauth ? (tokens ? 'connected' : 'not_connected') : 'connected',
    });
    if (oauth && row.status === 'connected' && !tokens && this.#deps.hasTokens !== undefined) {
      store.setStatus(id, 'not_connected');
    } else if (!oauth && row.status === 'not_connected') {
      store.setStatus(id, 'connected');
    }
  }

  /**
   * `connected ⇄ tools_changed`：有待复核的工具且连接是 `connected` → `tools_changed`；
   * 全部复核完且状态是 `tools_changed` → `connected`。其它状态（expired / needs_scope /
   * not_connected …）更紧迫，不覆盖。`announce` = 即使状态没变也推一次（带最新计数）。
   */
  #syncStatus(
    connectionId: string,
    pending: { added: string[]; changed: string[] },
    options: { announce: boolean; removed: number },
  ): void {
    const { store, onStatus } = this.#deps;
    const row = store.get(connectionId);
    if (row === null) return;
    const hasPending = pending.added.length + pending.changed.length > 0;
    let status = row.status;
    if (hasPending && status === 'connected') status = 'tools_changed';
    else if (!hasPending && status === 'tools_changed') status = 'connected';
    const statusChanged = status !== row.status;
    if (statusChanged) store.setStatus(connectionId, status);
    if (!statusChanged && !(options.announce && (hasPending || options.removed > 0))) return;
    onStatus?.({
      connectionId,
      status,
      ...(hasPending || options.removed > 0
        ? {
            tools: {
              added: pending.added.length,
              changed: pending.changed.length,
              removed: options.removed,
            },
          }
        : {}),
    });
  }
}

function definitionOf(tool: LockableTool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

function toRow(record: ToolRowRecord): AppToolRow {
  let definition: LockableTool;
  try {
    definition = JSON.parse(record.definition_json) as LockableTool;
  } catch {
    definition = { name: record.tool_name, inputSchema: {} };
  }
  let approvedDefinition: LockableTool | null = null;
  if (record.approved_definition_json !== null) {
    try {
      approvedDefinition = JSON.parse(record.approved_definition_json) as LockableTool;
    } catch {
      approvedDefinition = null;
    }
  }
  return {
    connectionId: record.connection_id,
    toolName: record.tool_name,
    approvedHash: record.approved_hash,
    currentHash: record.current_hash,
    risk: record.risk as McpToolRisk,
    userPolicy: parsePolicy(record.user_policy),
    definition,
    approvedDefinition,
    state: stateOf(record.approved_hash, record.current_hash),
  };
}

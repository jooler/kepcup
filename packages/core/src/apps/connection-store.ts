import { AppError, newId, type AppConnection, type AppConnectionStatus } from '@kepcup/shared';
import type { OAuthServerInfo } from '@earendil-works/pi-mcp/oauth';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';

/**
 * `app_connections` / `oauth_clients` 的行级访问（D73 P0，design 29 §12）。
 *
 * 这里只有**非机密**元数据：令牌与客户端 id / secret 在 secrets 表，经
 * `TokenVault` 读写。自定义 MCP server 的连接 id = connector_id =
 * `custom:{serverId}`，每个 server 至多一行；断开**不删行**（置 `not_connected`），
 * 只随 `mcp.removeServer`（`delete`）删除。
 */

const CUSTOM_PREFIX = 'custom:';

export function customConnectionId(serverId: string): string {
  return `${CUSTOM_PREFIX}${serverId}`;
}

/** 两个端点 URL 规范化后相同（`new URL().href`）；任一方缺失 / 无法解析 → 仅在两者逐字相同时为真。 */
export function sameEndpoint(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

export function isCustomConnectionId(connectionId: string): boolean {
  return connectionId.startsWith(CUSTOM_PREFIX);
}

const CATALOG_PREFIX = 'conn_';

/**
 * 目录连接的 id（`newId('conn')`，`conn_…`）。这个前缀为目录连接保留：`McpService` 把目录连接
 * 合成的 server 的 id 直接取连接 id，`settings.update` 拒绝以它开头的自定义 server id。
 */
export function isCatalogConnectionId(connectionId: string): boolean {
  return connectionId.startsWith(CATALOG_PREFIX);
}

/** OAuth 客户端的来源（`oauth_clients.source`）。 */
export type OAuthClientSource = 'dcr' | 'manual' | 'preregistered';

export interface OAuthClientMeta {
  issuerHash: string;
  issuer: string;
  source: OAuthClientSource;
  /** 已向授权服务器登记的回调地址（DCR 端口预判用）。 */
  redirectUris: string[];
  createdAt: number;
  updatedAt: number;
}

export interface NewAppConnection {
  /** 缺省生成 `conn_…`；自定义 server 用 `customConnectionId(serverId)`。 */
  id?: string;
  connectorId: string;
  connectorVer?: string | null;
  label: string;
  accountSub?: string | null;
  serverUrl?: string | null;
  issuer?: string | null;
  scopes?: string[];
  tokenExpiresAt?: number | null;
  /** 缺省 `not_connected`。 */
  status?: AppConnectionStatus;
}

/** 可更新的列；未出现的键保持原值（`null` 表示清空可空列）。 */
export interface AppConnectionPatch {
  connectorVer?: string | null;
  label?: string;
  accountSub?: string | null;
  serverUrl?: string | null;
  issuer?: string | null;
  scopes?: string[];
  tokenExpiresAt?: number | null;
  status?: AppConnectionStatus;
  lastUsedAt?: number | null;
}

interface ConnectionRow {
  id: string;
  connector_id: string;
  connector_ver: string | null;
  label: string;
  account_sub: string | null;
  server_url: string | null;
  issuer: string | null;
  scopes: string;
  token_expires_at: number | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

interface ClientRow {
  issuer_hash: string;
  issuer: string;
  source: string;
  redirect_uris: string;
  created_at: number;
  updated_at: number;
}

function splitScopes(value: string): string[] {
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}

function toConnection(row: ConnectionRow): AppConnection {
  return {
    id: row.id,
    connectorId: row.connector_id,
    connectorVer: row.connector_ver,
    label: row.label,
    accountSub: row.account_sub,
    serverUrl: row.server_url,
    issuer: row.issuer,
    scopes: splitScopes(row.scopes),
    tokenExpiresAt: row.token_expires_at,
    status: row.status as AppConnectionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function parseRedirectUris(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export class AppConnectionStore {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;
  /**
   * 运行时 step-up 挑战要求、尚未授予的 scope（D73 P2 §6.1）。进程内：没有合适的列，且迁移
   * 本期冻结；连接回到 `connected`（授权完成）/ 断开 / 删除时清除。
   */
  readonly #pendingScopes = new Map<string, string[]>();

  constructor(deps: { db: SqliteDatabase; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  create(input: NewAppConnection): AppConnection {
    const id = input.id ?? newId('conn');
    const now = this.#clock.now();
    this.#db
      .prepare(
        `insert into app_connections
           (id, connector_id, connector_ver, label, account_sub, server_url, issuer, scopes,
            token_expires_at, discovery_json, status, created_at, updated_at, last_used_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, null)`,
      )
      .run(
        id,
        input.connectorId,
        input.connectorVer ?? null,
        input.label,
        input.accountSub ?? null,
        input.serverUrl ?? null,
        input.issuer ?? null,
        (input.scopes ?? []).join(' '),
        input.tokenExpiresAt ?? null,
        input.status ?? 'not_connected',
        now,
        now,
      );
    return this.getRequired(id);
  }

  /**
   * 自定义 server 的唯一连接行：不存在则以 `init.status`（缺省 `not_connected`）创建，存在则只同步
   * `serverUrl`（server 的 URL 被编辑后保持一致）与可选的标签，其余不动。
   */
  ensureCustom(
    serverId: string,
    init: { label: string; serverUrl: string | null; status?: AppConnectionStatus },
  ): AppConnection {
    const id = customConnectionId(serverId);
    const existing = this.get(id);
    if (!existing) {
      return this.create({
        id,
        connectorId: id,
        label: init.label,
        serverUrl: init.serverUrl,
        status: init.status ?? 'not_connected',
      });
    }
    if (existing.serverUrl !== init.serverUrl) {
      return this.update(id, { serverUrl: init.serverUrl });
    }
    return existing;
  }

  get(id: string): AppConnection | null {
    const row = this.#db.prepare('select * from app_connections where id = ?').get(id) as
      ConnectionRow | undefined;
    return row ? toConnection(row) : null;
  }

  getRequired(id: string): AppConnection {
    const found = this.get(id);
    if (!found) {
      throw new AppError('APP_CONNECTION_NOT_FOUND', `Connection "${id}" not found`, {
        connectionId: id,
      });
    }
    return found;
  }

  /** 按 Connector（+ 账号）查找；`accountSub` 省略 = 该 Connector 的任意一行（按创建顺序）。 */
  findByConnector(connectorId: string, accountSub?: string | null): AppConnection | null {
    const row = (
      accountSub === undefined
        ? this.#db
            .prepare('select * from app_connections where connector_id = ? order by created_at, id')
            .get(connectorId)
        : this.#db
            .prepare(
              'select * from app_connections where connector_id = ? and account_sub is ? order by created_at, id',
            )
            .get(connectorId, accountSub)
    ) as ConnectionRow | undefined;
    return row ? toConnection(row) : null;
  }

  /** 某目录条目（slug）下的全部连接（多账号），按创建顺序。 */
  listByConnector(connectorId: string): AppConnection[] {
    const rows = this.#db
      .prepare('select * from app_connections where connector_id = ? order by created_at, id')
      .all(connectorId) as ConnectionRow[];
    return rows.map(toConnection);
  }

  /** 默认不含 `custom:` 行（`apps.connections.list` 的 `includeCustom`）。 */
  list(options: { includeCustom?: boolean } = {}): AppConnection[] {
    const rows = (
      options.includeCustom === true
        ? this.#db.prepare('select * from app_connections order by created_at, id').all()
        : this.#db
            .prepare(
              'select * from app_connections where substr(id, 1, ?) != ? order by created_at, id',
            )
            .all(CUSTOM_PREFIX.length, CUSTOM_PREFIX)
    ) as ConnectionRow[];
    return rows.map(toConnection);
  }

  setPendingScopes(id: string, scopes: readonly string[]): void {
    const unique = [...new Set(scopes.filter((scope) => scope.length > 0))];
    if (unique.length === 0) this.#pendingScopes.delete(id);
    else this.#pendingScopes.set(id, unique);
  }

  getPendingScopes(id: string): string[] {
    return [...(this.#pendingScopes.get(id) ?? [])];
  }

  update(id: string, patch: AppConnectionPatch): AppConnection {
    this.getRequired(id);
    if (patch.status === 'connected') this.#pendingScopes.delete(id);
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.connectorVer !== undefined) set('connector_ver', patch.connectorVer);
    if (patch.label !== undefined) set('label', patch.label);
    if (patch.accountSub !== undefined) set('account_sub', patch.accountSub);
    if (patch.serverUrl !== undefined) set('server_url', patch.serverUrl);
    if (patch.issuer !== undefined) set('issuer', patch.issuer);
    if (patch.scopes !== undefined) set('scopes', patch.scopes.join(' '));
    if (patch.tokenExpiresAt !== undefined) set('token_expires_at', patch.tokenExpiresAt);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.lastUsedAt !== undefined) set('last_used_at', patch.lastUsedAt);
    set('updated_at', this.#clock.now());
    this.#db
      .prepare(`update app_connections set ${sets.join(', ')} where id = ?`)
      .run(...values, id);
    return this.getRequired(id);
  }

  setStatus(id: string, status: AppConnectionStatus): AppConnection {
    return this.update(id, { status });
  }

  /** 存量基线标记（P1 工具锁定，迁移 0025）：true = 首次拉取到的工具直接批准。 */
  setBaselinePending(id: string, pending: boolean): void {
    this.#db
      .prepare('update app_connections set baseline_pending = ? where id = ?')
      .run(pending ? 1 : 0, id);
  }

  isBaselinePending(id: string): boolean {
    const row = this.#db
      .prepare('select baseline_pending as pending from app_connections where id = ?')
      .get(id) as { pending: number } | undefined;
    return row?.pending === 1;
  }

  /** 工具调用成功后记录最近使用时间。 */
  touch(id: string): void {
    const now = this.#clock.now();
    this.#db
      .prepare('update app_connections set last_used_at = ?, updated_at = ? where id = ?')
      .run(now, now, id);
  }

  /** 删除一行（`mcp.removeServer` 用于 `custom:` 行；目录连接的最终删除）。 */
  delete(id: string): boolean {
    this.#pendingScopes.delete(id);
    return this.#db.prepare('delete from app_connections where id = ?').run(id).changes > 0;
  }

  /**
   * 断开的行语义：`custom:` 行**不删除**——置 `not_connected` 并清掉与账号 / 令牌
   * 相关的元数据（issuer、scope、到期、发现缓存），保留 server URL 与标签；其余
   * 连接删除整行。令牌 secrets 由 `TokenVault.clearConnection` 清理。
   */
  disconnect(id: string): 'reset' | 'deleted' | 'missing' {
    if (this.get(id) === null) return 'missing';
    this.#pendingScopes.delete(id);
    if (!isCustomConnectionId(id)) {
      this.delete(id);
      return 'deleted';
    }
    this.#db
      .prepare(
        `update app_connections
            set status = 'not_connected', account_sub = null, issuer = null, scopes = '',
                token_expires_at = null, discovery_json = null, updated_at = ?
          where id = ?`,
      )
      .run(this.#clock.now(), id);
    return 'reset';
  }

  /** 引用某 issuer 的连接数（`clearIssuerClientIfUnused` 判定用）。 */
  countByIssuer(issuer: string): number {
    // 末尾斜杠不同的写法是同一个 issuer（与客户端表的键一致）。
    const base = issuer.trim().replace(/\/+$/, '');
    const row = this.#db
      .prepare('select count(*) as n from app_connections where issuer = ? or issuer = ?')
      .get(base, `${base}/`) as { n: number };
    return row.n;
  }

  getDiscovery(id: string): OAuthServerInfo | null {
    const row = this.#db
      .prepare('select discovery_json from app_connections where id = ?')
      .get(id) as { discovery_json: string | null } | undefined;
    if (!row?.discovery_json) return null;
    try {
      const parsed: unknown = JSON.parse(row.discovery_json);
      return typeof parsed === 'object' && parsed !== null ? (parsed as OAuthServerInfo) : null;
    } catch {
      return null;
    }
  }

  /** 写发现结果缓存；`issuer` 一并更新（发现元数据里的 issuer，否则授权服务器 URL）。 */
  setDiscovery(id: string, info: OAuthServerInfo, issuer: string): void {
    this.getRequired(id);
    this.#db
      .prepare(
        'update app_connections set discovery_json = ?, issuer = ?, updated_at = ? where id = ?',
      )
      .run(JSON.stringify(info), issuer, this.#clock.now(), id);
  }

  // --- oauth_clients ---------------------------------------------------------

  getClientMeta(issuerHash: string): OAuthClientMeta | null {
    const row = this.#db
      .prepare('select * from oauth_clients where issuer_hash = ?')
      .get(issuerHash) as ClientRow | undefined;
    if (!row) return null;
    return {
      issuerHash: row.issuer_hash,
      issuer: row.issuer,
      source: row.source as OAuthClientSource,
      redirectUris: parseRedirectUris(row.redirect_uris),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 全部已存客户端的元数据（BYO 客户端列表）。 */
  listClientMetas(): OAuthClientMeta[] {
    const rows = this.#db
      .prepare('select * from oauth_clients order by created_at, issuer_hash')
      .all() as ClientRow[];
    return rows.map((row) => ({
      issuerHash: row.issuer_hash,
      issuer: row.issuer,
      source: row.source as OAuthClientSource,
      redirectUris: parseRedirectUris(row.redirect_uris),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  putClientMeta(meta: {
    issuerHash: string;
    issuer: string;
    source: OAuthClientSource;
    redirectUris: string[];
  }): void {
    const now = this.#clock.now();
    this.#db
      .prepare(
        `insert into oauth_clients (issuer_hash, issuer, source, redirect_uris, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(issuer_hash) do update set
           issuer = excluded.issuer, source = excluded.source,
           redirect_uris = excluded.redirect_uris, updated_at = excluded.updated_at`,
      )
      .run(meta.issuerHash, meta.issuer, meta.source, JSON.stringify(meta.redirectUris), now, now);
  }

  deleteClientMeta(issuerHash: string): boolean {
    return (
      this.#db.prepare('delete from oauth_clients where issuer_hash = ?').run(issuerHash).changes >
      0
    );
  }
}

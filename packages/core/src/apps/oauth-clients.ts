import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppError,
  preregisteredClientTableSchema,
  type OAuthClientView,
  type PreregisteredClient,
  type PreregisteredClientTable,
} from '@kepcup/shared';
import type { OAuthClientInformation } from '@earendil-works/pi-mcp/oauth';
import type { CoreLogger } from '../infra/logger.js';
import type { AppConnectionStore } from './connection-store.js';
import { normalizeIssuer, type TokenVault } from './token-vault.js';

/**
 * OAuth 客户端身份：KepCup 预注册表（D73 P2 §6.4）与用户自带（BYO）客户端的管理。
 *
 * 预注册表来自 `apps/desktop/oauth-clients.json`，打包时由 `dist.mjs` 注入
 * `__KEPCUP_OAUTH_CLIENTS__`；开发 / 测试构建没有注入，退回读该文件（或测试注入的表）。
 * 表里只能放平台定义为**非保密**的桌面 / 原生客户端凭据。
 *
 * BYO 客户端 = Token Vault 里 `source: 'manual'` 的 issuer 客户端：流程里它先于
 * 预注册表、CIMD、DCR。secret 只写不读——任何列表 / RPC 返回都不含它。
 */

/** 发行构建注入的表；未注入（开发 / 测试）= null。 */
export function injectedOauthClients(): PreregisteredClientTable | null {
  return typeof __KEPCUP_OAUTH_CLIENTS__ === 'undefined' ? null : __KEPCUP_OAUTH_CLIENTS__;
}

/** 向上查找 `apps/desktop/oauth-clients.json`（开发态）；找不到 = null。 */
function findClientsFile(): string | null {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, 'apps', 'desktop', 'oauth-clients.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 解析并校验表；整体非法 → 空表并告警（单个坏条目不拖垮其余）。 */
export function parsePreregisteredClients(
  raw: unknown,
  logger?: Pick<CoreLogger, 'warn'>,
): PreregisteredClientTable {
  const whole = preregisteredClientTableSchema.safeParse(raw);
  if (whole.success) return whole.data;
  const out: PreregisteredClientTable = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [ref, value] of Object.entries(raw as Record<string, unknown>)) {
      const single = preregisteredClientTableSchema.safeParse({ [ref]: value });
      if (single.success) Object.assign(out, single.data);
      else logger?.warn({ clientRef: ref }, 'oauth-clients.json entry rejected');
    }
  } else {
    logger?.warn({}, 'oauth-clients.json is not an object');
  }
  return out;
}

export function loadPreregisteredClients(
  logger?: Pick<CoreLogger, 'warn'>,
  override?: PreregisteredClientTable,
): PreregisteredClientTable {
  if (override !== undefined) return parsePreregisteredClients(override, logger);
  const injected = injectedOauthClients();
  if (injected !== null) return parsePreregisteredClients(injected, logger);
  const file = findClientsFile();
  if (file === null) return {};
  try {
    return parsePreregisteredClients(JSON.parse(readFileSync(file, 'utf8')), logger);
  } catch (error) {
    logger?.warn(
      { file, error: error instanceof Error ? error.message : String(error) },
      'oauth-clients.json unreadable',
    );
    return {};
  }
}

export function sameIssuer(a: string, b: string): boolean {
  return normalizeIssuer(a) === normalizeIssuer(b);
}

export type PreregisteredLookup =
  { kind: 'ok'; info: OAuthClientInformation } | { kind: 'missing' } | { kind: 'issuer_mismatch' };

/** 预注册表的只读视图。 */
export class PreregisteredClients {
  readonly #table: PreregisteredClientTable;

  constructor(table: PreregisteredClientTable = {}) {
    this.#table = table;
  }

  /** 目录 `clientRef` 是否有条目（`connectable` 的判据；不看 issuer，issuer 在流程里核对）。 */
  has(clientRef: string | null | undefined): boolean {
    return clientRef !== null && clientRef !== undefined && this.#table[clientRef] !== undefined;
  }

  get(clientRef: string): PreregisteredClient | null {
    return this.#table[clientRef] ?? null;
  }

  /**
   * 无 `clientRef` 的目标（自定义 server）：按发现到的 issuer 找表中的客户端。同一 issuer 有多个
   * `clientRef` 时取 `clientRef` 字典序最小的那个（确定性；表的书写顺序不影响结果）。
   */
  findByIssuer(issuer: string): PreregisteredClient | null {
    for (const ref of Object.keys(this.#table).sort()) {
      const entry = this.#table[ref]!;
      if (sameIssuer(entry.issuer, issuer)) return entry;
    }
    return null;
  }

  /**
   * 流程用：按 `clientRef`（目录条目）或 issuer（自定义 server）取客户端。`clientRef` 给出时
   * 区分「表里没有」与「issuer 与发现到的不符」，调用方据此失败而不是退回自动注册。
   */
  lookup(issuer: string, clientRef: string | null): PreregisteredLookup {
    const entry = clientRef !== null ? this.get(clientRef) : this.findByIssuer(issuer);
    if (entry === null) return { kind: 'missing' };
    if (!sameIssuer(entry.issuer, issuer)) return { kind: 'issuer_mismatch' };
    return {
      kind: 'ok',
      info: {
        client_id: entry.clientId,
        ...(entry.clientSecret !== undefined ? { client_secret: entry.clientSecret } : {}),
      },
    };
  }

  resolve(issuer: string, clientRef: string | null): OAuthClientInformation | null {
    const found = this.lookup(issuer, clientRef);
    return found.kind === 'ok' ? found.info : null;
  }
}

/** BYO 客户端的增删查（`apps.oauthClients.*`）。 */
export class OAuthClientManager {
  readonly #vault: TokenVault;
  readonly #store: AppConnectionStore;

  constructor(deps: { vault: TokenVault; store: AppConnectionStore }) {
    this.#vault = deps.vault;
    this.#store = deps.store;
  }

  /** 全部已存客户端（DCR / 手填）。secret 不返回。 */
  list(): OAuthClientView[] {
    return this.#store.listClientMetas().flatMap((meta) => {
      const stored = this.#vault.getClient(meta.issuer);
      if (stored === null) return [];
      return [
        {
          issuer: meta.issuer,
          source: meta.source,
          clientId: stored.info.client_id,
          hasSecret: stored.info.client_secret !== undefined,
          connectionCount: this.#store.countByIssuer(meta.issuer),
        },
      ];
    });
  }

  /** 登记 / 覆盖某 issuer 的 BYO 客户端（`source: 'manual'`）。 */
  set(input: {
    issuer: string;
    clientId: string;
    clientSecret?: string | undefined;
    clearSecret?: boolean | undefined;
  }): void {
    // issuer 键统一规整（末尾斜杠），已有连接各自记了授权时的客户端（刷新 / 吊销不受影响），
    // 覆盖只影响之后的新授权。
    const issuer = normalizeIssuer(input.issuer);
    const clientId = input.clientId.trim();
    let clientSecret = input.clientSecret;
    if (clientSecret === undefined || clientSecret.length === 0) {
      // 没给 secret：保留同一个 client id 已存的 secret（只改 id / 备注类字段不应悄悄丢掉它），
      // 除非明确 `clearSecret`。换了 client id 时旧 secret 属于旧客户端，不带过去。
      const existing = this.#vault.getClient(issuer);
      clientSecret =
        input.clearSecret !== true &&
        existing !== null &&
        existing.info.client_id === clientId &&
        existing.info.client_secret !== undefined
          ? existing.info.client_secret
          : undefined;
    }
    this.#vault.saveClient(
      issuer,
      {
        client_id: clientId,
        ...(clientSecret !== undefined && clientSecret.length > 0
          ? { client_secret: clientSecret }
          : {}),
      },
      { source: 'manual', redirectUris: [] },
    );
  }

  /** 删除 BYO 客户端；仍有连接引用该 issuer 时拒绝（先断开连接）。 */
  remove(issuer: string): void {
    const key = normalizeIssuer(issuer);
    if (this.#vault.getClient(key) === null) {
      throw new AppError('NOT_FOUND', '没有该授权服务器的已存客户端', { issuer: key });
    }
    const connections = this.#store.countByIssuer(key);
    if (connections > 0) {
      throw new AppError(
        'INVALID_INPUT',
        `仍有 ${connections} 个连接在使用该授权服务器，请先断开这些连接再删除客户端`,
        { issuer: key, connectionCount: connections },
      );
    }
    this.#vault.clearIssuerClient(key);
  }
}

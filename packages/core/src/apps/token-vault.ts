import { createHash } from 'node:crypto';
import { AppError } from '@kepcup/shared';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthServerInfo,
  OAuthTokens,
} from '@earendil-works/pi-mcp/oauth';
import type { SecretsService } from '../domain/secrets.js';
import type { Clock } from '../infra/clock.js';
import type { AppConnectionStore, OAuthClientSource } from './connection-store.js';

/**
 * Token Vault（D73 P0，design 29 §5.3）：OAuth 令牌与客户端凭据的存取。
 *
 * 机密**逐值**存 secrets 表，每个机密一个名称（`redact()` 按整值匹配，JSON 打包会让
 * 令牌本身逃过脱敏）：
 *   conn:{connectionId}:access | conn:{connectionId}:refresh
 *   oauth:client:{issuerHash}:id | oauth:client:{issuerHash}:secret
 * 非机密元数据（`token_expires_at`、`scopes`、`discovery_json`、`issuer`、客户端来源与
 * 已登记 redirect_uris）存 `app_connections` / `oauth_clients`（`AppConnectionStore`）。
 * 令牌明文只允许出现在 core 发请求的那一刻与本类内部；code verifier 只放流程内存。
 */

/** sha256(issuer) hex 前 24 位（secrets 名称不能含 URL，故以哈希代替）。 */
export function issuerHash(issuer: string): string {
  return createHash('sha256').update(issuer).digest('hex').slice(0, 24);
}

/**
 * 客户端表的 issuer 键：去掉首尾空白与末尾斜杠（`https://a.com` 与 `https://a.com/` 是同一个
 * 授权服务器；预注册表的 `sameIssuer` 同样忽略末尾斜杠）。只作用于客户端的存取
 * （`getClient` / `saveClient` / `clearIssuerClient*`）；`issuerHash` 本身仍按原样哈希。
 */
export function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

export function accessTokenSecretName(connectionId: string): string {
  return `conn:${connectionId}:access`;
}
export function refreshTokenSecretName(connectionId: string): string {
  return `conn:${connectionId}:refresh`;
}
/** 连接自己用过的客户端（授权时记录；刷新 / 吊销必须用它，而不是 issuer 上最新的那个）。 */
export function connectionClientIdSecretName(connectionId: string): string {
  return `conn:${connectionId}:client_id`;
}
export function connectionClientSecretSecretName(connectionId: string): string {
  return `conn:${connectionId}:client_secret`;
}
export function clientIdSecretName(issuer: string): string {
  return `oauth:client:${issuerHash(issuer)}:id`;
}
export function clientSecretSecretName(issuer: string): string {
  return `oauth:client:${issuerHash(issuer)}:secret`;
}

/** 库里读出的令牌（`expires_in` 已换算为绝对时间）。 */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** 绝对到期时间（epoch ms）；服务端未给 `expires_in` 时为 null。 */
  expiresAt: number | null;
  /** 已授予的 scope（来自连接行）。 */
  scopes: string[];
}

export interface StoredOAuthClient {
  /** 可直接传给 pi-mcp 低层函数的客户端信息（client_id、可选 client_secret）。 */
  info: OAuthClientInformation;
  source: OAuthClientSource;
  /** 已向授权服务器登记的回调地址（DCR 端口预判）。 */
  redirectUris: string[];
}

export class TokenVault {
  readonly #secrets: SecretsService;
  readonly #store: AppConnectionStore;
  readonly #clock: Clock;

  constructor(deps: { secrets: SecretsService; store: AppConnectionStore; clock: Clock }) {
    this.#secrets = deps.secrets;
    this.#store = deps.store;
    this.#clock = deps.clock;
  }

  // --- 待追加的 scope（step-up）-------------------------------------------------

  /**
   * 运行时遇到 `403 insufficient_scope` 时记下服务端要求的 scope：连接此后进入 `needs_scope`、
   * 工具不再暴露，这些 scope 只存在于抛出的错误里——卡片被忽略 / 被限流抑制后，设置页「重新连接」
   * 与 `apps.connect` 用它把缺的 scope 并进授权请求（见 `AppConnectionsService`）。
   * 进程内记录（不进 secrets 表：secrets 的值会进入脱敏词表，scope 这类短词会误伤正文）；
   * 重启后丢失无碍——重连后工具重新暴露，下一次 403 会再次记下。
   */
  setPendingScopes(connectionId: string, scopes: readonly string[]): void {
    this.#store.setPendingScopes(connectionId, scopes);
  }

  getPendingScopes(connectionId: string): string[] {
    return this.#store.getPendingScopes(connectionId);
  }

  // --- 令牌 ------------------------------------------------------------------

  /** 无 access token 时返回 null。 */
  getTokens(connectionId: string): StoredTokens | null {
    const accessToken = this.#secrets.getValue(accessTokenSecretName(connectionId));
    if (accessToken === null) return null;
    const refreshToken = this.#secrets.getValue(refreshTokenSecretName(connectionId));
    const row = this.#store.get(connectionId);
    return {
      accessToken,
      ...(refreshToken !== null ? { refreshToken } : {}),
      expiresAt: row?.tokenExpiresAt ?? null,
      scopes: row?.scopes ?? [],
    };
  }

  /**
   * 保存令牌：access / refresh 各写一个 secret；`expires_in` 换算成绝对的
   * `token_expires_at` 写连接行（缺 `expires_in` → null），`scope` 非空时更新行的 scopes。
   * 以传入为准：`tokens` 没有 `refresh_token` 会**删除**已存的 refresh token——刷新时
   * 请传 pi-mcp `refreshAuthorization` 的结果（它已把旧 refresh token 合并进去）。
   * 连接行必须已存在（流程先建行、状态 `connecting`），否则抛 `APP_CONNECTION_NOT_FOUND`。
   * `id_token` 不保存（含个人信息，账号标识由流程解析后写 `account_sub`）。
   */
  saveTokens(connectionId: string, tokens: OAuthTokens): { tokenExpiresAt: number | null } {
    this.#store.getRequired(connectionId);
    this.#secrets.setValue(accessTokenSecretName(connectionId), tokens.access_token);
    if (tokens.refresh_token !== undefined && tokens.refresh_token.length > 0) {
      this.#secrets.setValue(refreshTokenSecretName(connectionId), tokens.refresh_token);
    } else {
      this.#secrets.removeValue(refreshTokenSecretName(connectionId));
    }
    const tokenExpiresAt =
      typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
        ? this.#clock.now() + Math.round(tokens.expires_in * 1000)
        : null;
    const scopes = (tokens.scope ?? '').split(/\s+/).filter((entry) => entry.length > 0);
    this.#store.update(connectionId, {
      tokenExpiresAt,
      ...(scopes.length > 0 ? { scopes } : {}),
    });
    return { tokenExpiresAt };
  }

  // --- 授权服务器发现结果 --------------------------------------------------------

  /** 发现结果缓存（`discovery_json`）与 issuer 一并写入连接行；返回 issuer。 */
  saveDiscovery(connectionId: string, info: OAuthServerInfo): string {
    const issuer = info.authorizationServerMetadata?.issuer ?? info.authorizationServerUrl;
    this.#store.setDiscovery(connectionId, info, issuer);
    return issuer;
  }

  getDiscovery(connectionId: string): OAuthServerInfo | null {
    return this.#store.getDiscovery(connectionId);
  }

  // --- OAuth 客户端（按 issuer，跨连接共享） --------------------------------------------

  getClient(rawIssuer: string): StoredOAuthClient | null {
    const issuer = normalizeIssuer(rawIssuer);
    const clientId = this.#secrets.getValue(clientIdSecretName(issuer));
    const meta = this.#store.getClientMeta(issuerHash(issuer));
    if (clientId === null || meta === null) return null;
    const clientSecret = this.#secrets.getValue(clientSecretSecretName(issuer));
    return {
      info: {
        client_id: clientId,
        ...(clientSecret !== null ? { client_secret: clientSecret } : {}),
      },
      source: meta.source,
      redirectUris: meta.redirectUris,
    };
  }

  /**
   * 保存某 issuer 的客户端（DCR 结果 / 用户手填 / 预注册）。client id / secret 逐值写
   * secrets，来源与已登记 `redirect_uris`（缺省取 `info.redirect_uris`）写 `oauth_clients`。
   * 以传入为准：没有 secret 则删除已存的 secret。
   */
  saveClient(
    rawIssuer: string,
    info: OAuthClientInformation | OAuthClientInformationFull,
    options: { source: OAuthClientSource; redirectUris?: string[] },
  ): void {
    const issuer = normalizeIssuer(rawIssuer);
    if (info.client_id.length === 0) {
      throw new AppError('INVALID_INPUT', 'client_id must not be empty');
    }
    this.#secrets.setValue(clientIdSecretName(issuer), info.client_id);
    if (info.client_secret !== undefined && info.client_secret.length > 0) {
      this.#secrets.setValue(clientSecretSecretName(issuer), info.client_secret);
    } else {
      this.#secrets.removeValue(clientSecretSecretName(issuer));
    }
    const redirectUris =
      options.redirectUris ?? ('redirect_uris' in info ? info.redirect_uris : []);
    this.#store.putClientMeta({
      issuerHash: issuerHash(issuer),
      issuer,
      source: options.source,
      redirectUris,
    });
  }

  // --- 连接各自的客户端（同一 issuer 上后注册的客户端不能顶掉别的连接的） -----------------

  /**
   * 记录某连接授权时所用的客户端身份（DCR / 手填 / CIMD 均记）。令牌是发给这个 client_id 的，
   * 刷新与吊销必须带它；issuer 级客户端可能已被另一个连接的重新注册（换端口）覆盖。
   * 随 `clearConnection` 的 `conn:{id}:` 前缀一并清除。
   */
  saveConnectionClient(connectionId: string, info: OAuthClientInformation): void {
    this.#store.getRequired(connectionId);
    this.#secrets.setValue(connectionClientIdSecretName(connectionId), info.client_id);
    if (info.client_secret !== undefined && info.client_secret.length > 0) {
      this.#secrets.setValue(connectionClientSecretSecretName(connectionId), info.client_secret);
    } else {
      this.#secrets.removeValue(connectionClientSecretSecretName(connectionId));
    }
  }

  /** 该连接记录的客户端；没有记录（旧数据 / 尚未授权）返回 null。 */
  getConnectionClient(connectionId: string): OAuthClientInformation | null {
    const clientId = this.#secrets.getValue(connectionClientIdSecretName(connectionId));
    if (clientId === null) return null;
    const clientSecret = this.#secrets.getValue(connectionClientSecretSecretName(connectionId));
    return {
      client_id: clientId,
      ...(clientSecret !== null ? { client_secret: clientSecret } : {}),
    };
  }

  /**
   * 把一个连接的令牌 / 授权时的客户端 / 发现结果搬到另一个连接上（同一账号重复连接：新授权换到
   * 旧行）。只复制，不删除来源；调用方随后对来源 `clearConnection(..., { deleteRow: true })`。
   * 令牌明文只在 Vault 内部经过。
   */
  transferConnection(fromId: string, toId: string): void {
    const tokens = this.getTokens(fromId);
    if (tokens === null) {
      throw new AppError('APP_CONNECTION_NOT_FOUND', `Connection "${fromId}" has no tokens`, {
        connectionId: fromId,
      });
    }
    const from = this.#store.getRequired(fromId);
    this.#store.getRequired(toId);
    this.#secrets.setValue(accessTokenSecretName(toId), tokens.accessToken);
    if (tokens.refreshToken !== undefined) {
      this.#secrets.setValue(refreshTokenSecretName(toId), tokens.refreshToken);
    } else {
      this.#secrets.removeValue(refreshTokenSecretName(toId));
    }
    const client = this.getConnectionClient(fromId);
    if (client !== null) this.saveConnectionClient(toId, client);
    const discovery = this.getDiscovery(fromId);
    if (discovery !== null) {
      this.#store.setDiscovery(
        toId,
        discovery,
        from.issuer ??
          discovery.authorizationServerMetadata?.issuer ??
          discovery.authorizationServerUrl,
      );
    }
    this.#store.update(toId, { tokenExpiresAt: tokens.expiresAt, scopes: tokens.scopes });
  }

  /** 强制清除某 issuer 的客户端（令牌端点返回 `invalid_client` 后重新注册前）。 */
  clearIssuerClient(rawIssuer: string): void {
    const issuer = normalizeIssuer(rawIssuer);
    this.#secrets.removeByPrefix(`oauth:client:${issuerHash(issuer)}:`);
    this.#store.deleteClientMeta(issuerHash(issuer));
  }

  /**
   * 无其他连接引用该 issuer 且客户端来自 DCR 时清除；手填 / 预注册的客户端是用户或
   * 发行方的配置，不随连接清除。返回是否清除了。
   */
  clearIssuerClientIfUnused(rawIssuer: string): boolean {
    const issuer = normalizeIssuer(rawIssuer);
    const meta = this.#store.getClientMeta(issuerHash(issuer));
    if (meta === null || meta.source !== 'dcr') return false;
    if (this.#store.countByIssuer(issuer) > 0) return false;
    this.clearIssuerClient(issuer);
    return true;
  }

  // --- 断开 ------------------------------------------------------------------

  /**
   * 清除一个连接的令牌（`conn:{id}:*`）与行内令牌元数据，并在其为最后一个引用方时
   * 清除 DCR 客户端。行语义：`custom:` 行置 `not_connected` 保留；其余连接删行；
   * `deleteRow: true`（`mcp.removeServer`）则一律删行。吊销（RFC 7009）须由调用方在
   * 本方法**之前**完成（需要令牌与客户端凭据）。
   */
  clearConnection(
    connectionId: string,
    options: { deleteRow?: boolean } = {},
  ): { issuer: string | null; clientCleared: boolean } {
    const issuer = this.#store.get(connectionId)?.issuer ?? null;
    this.#secrets.removeByPrefix(`conn:${connectionId}:`);
    if (options.deleteRow === true) this.#store.delete(connectionId);
    else this.#store.disconnect(connectionId);
    const clientCleared = issuer !== null ? this.clearIssuerClientIfUnused(issuer) : false;
    return { issuer, clientCleared };
  }
}

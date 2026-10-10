import type { AuthProvider, McpFetch, UnauthorizedContext } from '@earendil-works/pi-mcp';
import {
  OAuthError,
  parseWwwAuthenticate,
  refreshAuthorization,
  selectResource,
  stepUpScope,
  type OAuthClientInformation,
  type OAuthServerInfo,
} from '@earendil-works/pi-mcp/oauth';
import {
  OAUTH_REFRESH_SKEW_MS,
  type AppAuthReason,
  type AppConnectionStatus,
} from '@kepcup/shared';
import type { Clock } from '../../infra/clock.js';
import type { CoreLogger } from '../../infra/logger.js';
import type { AppConnectionStore } from '../connection-store.js';
import type { StoredTokens, TokenVault } from '../token-vault.js';
import { AppAuthRequiredError } from './errors.js';

/**
 * 运行时授权提供者（D73，design 29 §5.6 / todo §4.7）。
 *
 * 给 `StreamableHttpTransport` 供 Bearer 令牌：`token()` 读 Token Vault 里的令牌，临近过期时
 * 主动刷新（single-flight）；`onUnauthorized()` 在 401 / `403 insufficient_scope` 后**只尝试一次
 * 刷新**，失败或需追加 scope 就**抛出** {@link AppAuthRequiredError}。
 *
 * **绝不**调用 `authorizeMcp` / `adaptOAuthProvider` / 打开浏览器——交互授权只由用户在界面
 * 发起的 `apps.connect` 流程完成（用 pi-mcp 低层函数），运行时（run、测试、工具清单刷新、
 * GET 事件流）与它严格分离。本文件因此只依赖 `refreshAuthorization` 一个令牌端点函数。
 */

export interface ConnectionAuthProviderDeps {
  connectionId: string;
  vault: TokenVault;
  store: AppConnectionStore;
  clock: Clock;
  logger: CoreLogger;
  /** 刷新请求用的 fetch（SSRF 防护版，见 apps/auth/safe-fetch.ts），按连接的 server URL 构造。 */
  fetchFor: (serverUrl: string | null) => McpFetch;
  /** 刷新用的客户端身份：Vault 里的客户端，或 CIMD 的 client_id；没有则无法刷新。 */
  clientFor: (issuer: string, discovery: OAuthServerInfo) => OAuthClientInformation | undefined;
  /** 当前世代号（registry 在令牌被替换 / 断开时递增）：刷新落盘前核对，变了就丢弃结果。 */
  epoch?: () => number;
  /** 持久化并广播连接状态（仅在变化时调用方才会发事件）。 */
  setStatus: (connectionId: string, status: AppConnectionStatus) => void;
  /** 默认 `OAUTH_REFRESH_SKEW_MS`。 */
  refreshSkewMs?: number;
}

/** 授权服务器明确拒绝了这份授权（需要用户重新授权），而不是临时故障。 */
const PERMANENT_GRANT_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

function isPermanentGrantError(error: unknown): boolean {
  return error instanceof OAuthError && PERMANENT_GRANT_ERRORS.has(error.code);
}

export class ConnectionAuthProvider implements AuthProvider {
  readonly #deps: ConnectionAuthProviderDeps;
  readonly #skew: number;
  #inflight: Promise<StoredTokens> | null = null;
  /** 已被授权服务器拒绝的 refresh token：同一个不再重复打令牌端点。 */
  #deadRefreshToken: string | null = null;

  constructor(deps: ConnectionAuthProviderDeps) {
    this.#deps = deps;
    this.#skew = deps.refreshSkewMs ?? OAUTH_REFRESH_SKEW_MS;
  }

  get connectionId(): string {
    return this.#deps.connectionId;
  }

  /** 交互授权完成 / 令牌被替换后：忘掉“已失效的 refresh token”记录。 */
  reset(): void {
    this.#deadRefreshToken = null;
  }

  async token(): Promise<string | undefined> {
    const tokens = this.#deps.vault.getTokens(this.#deps.connectionId);
    if (tokens === null) throw this.#required('not_connected');
    const now = this.#deps.clock.now();
    const nearExpiry = tokens.expiresAt !== null && tokens.expiresAt - now < this.#skew;
    if (!nearExpiry) return tokens.accessToken;

    if (this.#canRefresh(tokens)) {
      try {
        return (await this.#refresh(tokens)).accessToken;
      } catch (error) {
        if (error instanceof AppAuthRequiredError) throw error;
        // 临时故障（网络 / 5xx）：令牌还没真过期就继续用；过期了才把故障抛给调用方。
        if (tokens.expiresAt !== null && tokens.expiresAt > now) {
          this.#deps.logger.warn(
            { connectionId: this.#deps.connectionId, error: errorSummary(error) },
            'proactive token refresh failed; using the current access token',
          );
          return tokens.accessToken;
        }
        throw error;
      }
    }
    if (tokens.expiresAt !== null && tokens.expiresAt <= now) {
      this.#markExpired();
      throw this.#required('expired');
    }
    return tokens.accessToken;
  }

  async onUnauthorized(context: UnauthorizedContext): Promise<void> {
    const connectionId = this.#deps.connectionId;
    const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
    const stored = this.#deps.vault.getTokens(connectionId);

    if (challenge.error === 'insufficient_scope') {
      const granted = stored?.scopes.join(' ');
      const wanted = stepUpScope(granted, challenge.scope);
      const scopes = wanted?.split(/\s+/).filter((entry) => entry.length > 0);
      // 记下要求的 scope（step-up 卡被忽略 / 被限流抑制后，设置页重新连接仍能补上）。
      if (scopes !== undefined && scopes.length > 0) {
        this.#deps.vault.setPendingScopes(connectionId, scopes);
      }
      this.#deps.setStatus(connectionId, 'needs_scope');
      throw this.#required('scope', scopes !== undefined && scopes.length > 0 ? scopes : undefined);
    }

    if (stored === null) throw this.#required('not_connected');
    // 请求带的令牌已不是当前令牌：别处已刷新，直接重试（轮换 refresh token 时再刷新会废掉新授权）。
    if (context.token !== undefined && context.token !== stored.accessToken) return;

    if (!this.#canRefresh(stored)) {
      this.#markExpired();
      throw this.#required('expired');
    }
    // 成功：传输层带新令牌重试一次；永久失败抛 AppAuthRequiredError；临时故障原样抛出。
    await this.#refresh(stored);
  }

  #canRefresh(tokens: StoredTokens): tokens is StoredTokens & { refreshToken: string } {
    return tokens.refreshToken !== undefined && tokens.refreshToken !== this.#deadRefreshToken;
  }

  #required(reason: AppAuthReason, scopes?: string[]): AppAuthRequiredError {
    return new AppAuthRequiredError({
      connectionId: this.#deps.connectionId,
      reason,
      ...(scopes !== undefined ? { scopes } : {}),
    });
  }

  #markExpired(): void {
    this.#deps.setStatus(this.#deps.connectionId, 'expired');
  }

  /** single-flight：同一时刻只有一个刷新请求，并发的调用方共享结果。 */
  #refresh(stale: StoredTokens): Promise<StoredTokens> {
    this.#inflight ??= this.#doRefresh(stale).finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /** 刷新期间世代变了：Vault 里若已有新授权的令牌就用它，否则（已断开）需要重新连接。 */
  #supersededResult(stale: StoredTokens): StoredTokens {
    const latest = this.#deps.vault.getTokens(this.#deps.connectionId);
    if (latest === null || latest.accessToken === stale.accessToken) {
      throw this.#required('not_connected');
    }
    return latest;
  }

  async #doRefresh(stale: StoredTokens): Promise<StoredTokens> {
    const { connectionId, vault, store } = this.#deps;
    const epoch = this.#deps.epoch?.() ?? 0;
    const superseded = (): boolean => (this.#deps.epoch?.() ?? 0) !== epoch;
    // 排队期间别处可能已经换了令牌：用最新的（轮换 refresh token 时不能拿旧的再刷一次）。
    const current = vault.getTokens(connectionId) ?? stale;
    if (current.accessToken !== stale.accessToken) return current;
    const refreshToken = current.refreshToken;
    if (refreshToken === undefined || refreshToken === this.#deadRefreshToken) {
      this.#markExpired();
      throw this.#required('expired');
    }

    const row = store.get(connectionId);
    const discovery = vault.getDiscovery(connectionId);
    const issuer =
      row?.issuer ??
      discovery?.authorizationServerMetadata?.issuer ??
      discovery?.authorizationServerUrl ??
      null;
    const client =
      discovery !== null && issuer !== null ? this.#deps.clientFor(issuer, discovery) : undefined;
    if (row === null || discovery === null || client === undefined) {
      // 缺少刷新所需的发现结果 / 客户端：无法静默续期，需要重新连接。
      this.#markExpired();
      throw this.#required('expired');
    }

    let resource: string | undefined;
    try {
      resource =
        row.serverUrl !== null
          ? selectResource(row.serverUrl, discovery.resourceMetadata)
          : undefined;
    } catch {
      resource = undefined;
    }
    try {
      const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
        ...(discovery.authorizationServerMetadata !== undefined
          ? { metadata: discovery.authorizationServerMetadata }
          : {}),
        clientInformation: client,
        ...(resource !== undefined ? { resource } : {}),
        fetch: this.#deps.fetchFor(row.serverUrl),
        refreshToken,
      });
      // 刷新期间连接被断开 / 重新授权：这份结果属于旧世代，丢弃（不写回令牌）。
      if (superseded()) return this.#supersededResult(current);
      // pi-mcp 已把旧 refresh token 并进结果（服务端不轮换时保持不变）。
      vault.saveTokens(connectionId, refreshed);
      if (row.status === 'expired') this.#deps.setStatus(connectionId, 'connected');
      return vault.getTokens(connectionId) ?? current;
    } catch (error) {
      if (superseded()) return this.#supersededResult(current);
      if (isPermanentGrantError(error)) {
        this.#deadRefreshToken = refreshToken;
        this.#markExpired();
        this.#deps.logger.info(
          { connectionId, error: errorSummary(error) },
          'token refresh rejected; reconnect required',
        );
        throw this.#required('expired');
      }
      throw error;
    }
  }
}

/** 日志里只放错误码 / 类型，不放响应体（可能含令牌回显）。 */
function errorSummary(error: unknown): string {
  if (error instanceof OAuthError) return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

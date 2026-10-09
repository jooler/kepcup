import { randomBytes, randomUUID } from 'node:crypto';
import {
  AppError,
  KEPCUP_OAUTH_CLIENT_ID,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORTS,
  OAUTH_FLOW_TIMEOUT_MS,
  type AppConnectFlowPayload,
  type AppConnectReviewTool,
  type AppConnectTarget,
  type AppConnectionStatus,
  type McpServer,
} from '@kepcup/shared';
import {
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
  discoverOAuthServerInfo,
  exchangeAuthorizationCode,
  parseWwwAuthenticate,
  registerClient,
  resourceUrlFromServerUrl,
  selectResource,
  startAuthorization,
  type OAuthClientInformation,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  type OAuthServerInfo,
  type OAuthTokens,
} from '@earendil-works/pi-mcp/oauth';
import type { McpFetch } from '@earendil-works/pi-mcp';
import type { SettingsService } from '../../domain/settings.js';
import type { Clock } from '../../infra/clock.js';
import type { EventBus } from '../../infra/events.js';
import type { CoreLogger } from '../../infra/logger.js';
import type { CoreEventsMap } from '../../start-types.js';
import type { AppConnectionStore } from '../connection-store.js';
import type { ShellHostRpc } from '../shell-facade.js';
import type { TokenVault } from '../token-vault.js';
import { startCallbackServer, type CallbackServer } from './callback-server.js';
import { createSafeFetch, isLoopbackAllowed, loopbackHostOf } from './safe-fetch.js';

/**
 * 授权引擎：交互流程（D73，design 29 §5.1 / §5.6，todo §4.6）。
 *
 * 只用 pi-mcp 的低层函数（发现 → 选客户端 → `registerClient` → `startAuthorization` →
 * 自建回调 → `exchangeAuthorizationCode`），不使用 `McpOAuthProvider` / `authorizeMcp`；
 * 运行时刷新是另一条路径（`runtime-provider.ts`），这里从不在 run 中途被触发。
 *
 * 令牌明文只在 `exchangeAuthorizationCode` 返回后立即交给 Token Vault，不进事件 / 日志 /
 * 错误信息；code verifier 只存在于 `#attempt` 的局部变量。
 */

/** 交互授权完成 / 失效时通知运行时缓存（`ConnectionAuthRegistry`，由运行时 provider 模块实现）。 */
export interface ConnectionInvalidator {
  invalidate(connectionId: string): void | Promise<void>;
}

/** 从 id_token / userinfo 取到的账号标识（目录连接，设计 29 §5.1 第 6 步）。 */
export interface AccountHint {
  /** 账号稳定标识（OIDC `sub`）：同一 Connector 下相同则复用旧连接行。 */
  sub?: string | undefined;
  /** 账号显示名（email / preferred_username / name）。 */
  label?: string | undefined;
}

/** {@link CatalogFlowHost.begin} 的结果：流程开始前已校验目标并建好临时连接行。 */
export interface CatalogFlowBegin {
  /** 目录 slug（`app_connections.connector_id`）。 */
  connectorId: string;
  title: string;
  serverUrl: string;
  /** 目录条目声明的默认 scope（空 = 按服务端提示）。 */
  defaultScopes: string[];
  /** 流程期间承载令牌的临时连接行（`conn_…`，status `connecting`）。 */
  connectionId: string;
  /** 重新授权某个已有连接时的目标（令牌通过账号核对后换到该行）。 */
  reconnectTo: string | null;
}

export interface CatalogSettleResult {
  /** 最终的连接 id：同一账号重复连接时是既有行，否则就是临时行。 */
  connectionId: string;
  /** true = 最终行是本次新建的（拒绝复核时要吊销并删除）。 */
  isNew: boolean;
  accountLabel: string | null;
  /** 待用户确认的工具（首连：全部；重连：新增 / 定义变化的）；空 = 无需复核。 */
  review: AppConnectReviewTool[];
}

/**
 * 目录连接的业务端（`apps/connections.ts` 实现）：流程只管阶段 / 取消 / 超时，
 * 目录校验、账号识别、行合并、工具复核落库都在这里。
 */
export interface CatalogFlowHost {
  /** 校验目录条目（发行门禁、远程端点、注册方式）并建临时行；不合法抛 AppError。 */
  begin(input: { connectorId: string; reconnectTo?: string | undefined }): CatalogFlowBegin;
  /** 令牌落盘之前流程就失败 / 取消：删除临时行。 */
  abandon(connectionId: string): void;
  /**
   * 令牌已写入临时行：识别账号（`hint`，否则目录 `whoami`）→ 与既有行合并 / 命名 → 拉工具清单
   * 并登记工具锁定 → 计算待复核清单。
   */
  settle(input: {
    connectionId: string;
    reconnectTo: string | null;
    hint: AccountHint | null;
    /** 流程被取消 / 超时：宿主应尽快结束（不要再改连接行）。 */
    signal: AbortSignal;
  }): Promise<CatalogSettleResult>;
  /** 用户确认（或无需复核）：批准全部待复核工具、置 connected、授权 Bot。 */
  confirm(input: { connectionId: string; grantBotId?: string | undefined }): Promise<void>;
  /** 令牌已发出但复核被拒绝 / 超时 / 取消 / 出错：新建的连接吊销并清除。 */
  reject(input: { connectionId: string }): Promise<void>;
}

export interface ConnectFlowDeps {
  store: AppConnectionStore;
  vault: TokenVault;
  settings: Pick<SettingsService, 'get'>;
  shell: ShellHostRpc;
  events: Pick<EventBus<CoreEventsMap>, 'emit'>;
  logger: CoreLogger;
  clock: Clock;
  /** 缺省 `KEPCUP_OAUTH_CLIENT_ID`。 */
  cimdUrl?: string;
  /** 仅测试：允许 http 的 CIMD URL（`createAppServices` 只在 NODE_ENV=test 下置 true）。 */
  allowInsecureCimdUrl?: boolean;
  /** 测试注入：额外允许访问的回环主机（`hostname` 或 `host:port`）。 */
  loopbackAllowlist?: readonly string[];
  /** 回调固定候选端口，缺省 `OAUTH_CALLBACK_PORTS`（测试用于避开并行用例的端口争用）。 */
  callbackPorts?: readonly number[];
  /** 流程总时限，缺省 `OAUTH_FLOW_TIMEOUT_MS`。 */
  flowTimeoutMs?: number;
  /** 运行时缓存失效；也可稍后经 {@link ConnectFlowManager.attachInvalidator} 接入。 */
  invalidator?: ConnectionInvalidator;
}

export interface StartFlowInput {
  target: AppConnectTarget;
  /** 完整 scope 集合（追加授权时为旧 ∪ 新）；缺省按服务端提示。 */
  scopes?: string[] | undefined;
  /** 连接完成后由 core 授权给该 Bot（目录连接；经 `BotAppGrantWriter`）。 */
  grantBotId?: string | undefined;
  /** 重新授权已有的目录连接。 */
  connectionId?: string | undefined;
}

type FlowPhase = AppConnectFlowPayload['phase'];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Flow {
  id: string;
  targetKey: string;
  serverId: string;
  serverName: string;
  serverUrl: string;
  connectionId: string;
  scopes: string[] | undefined;
  /** 流程开始前的连接状态（失败 / 取消时恢复）。 */
  previousStatus: AppConnectionStatus;
  phase: FlowPhase;
  lastPayload: AppConnectFlowPayload;
  issuer: string | null;
  /** 用户已确认过的授权主机（invalid_client 重试时授权主机不变则不再询问，变了要重新确认）。 */
  consentedHost: string | null;
  /** invalid_client 后重新注册的次数（至多 1 次）。 */
  clientRetries: number;
  callback: CallbackServer | null;
  consent: Deferred<void> | null;
  credentials: Deferred<void> | null;
  abortError: AppError | null;
  /** 取消 / 超时时 abort：中止进行中的 fetch，并唤醒 `#race`。 */
  controller: AbortController;
  abort: Deferred<void>;
  timer: NodeJS.Timeout | null;
  done: Promise<void>;
  /** 目录连接（P1）的状态；自定义 server 为 undefined。 */
  catalog?: {
    begin: CatalogFlowBegin;
    grantBotId: string | undefined;
    /** pre = 令牌未落盘；tokens = 令牌在临时行、尚未结算；settled = 已确定最终行。 */
    stage: 'pre' | 'tokens' | 'settled';
    /** 最终行是否本次新建。 */
    rowIsNew: boolean;
    review: Deferred<void> | null;
    /** 进行中的结算（取消时收尾要等它结束，免得它在清理之后又改行）。 */
    settling: Promise<CatalogSettleResult> | null;
  };
}

/** 令牌端点返回 `invalid_client`，已清除客户端，请重新注册后重来一次。 */
class ClientRejectedSignal extends Error {}

const PROBE_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_CHARS = 300;

function fixedRedirectUris(ports: readonly number[]): string[] {
  return ports.map((port) => `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`);
}

function trimMessage(message: string): string {
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
}

export class ConnectFlowManager {
  readonly #deps: ConnectFlowDeps;
  readonly #cimdUrl: string;
  readonly #ports: readonly number[];
  readonly #timeoutMs: number;
  readonly #flows = new Map<string, Flow>();
  /** 目标 → 进行中的 flowId（并发去重）。 */
  readonly #byTarget = new Map<string, string>();
  #invalidator: ConnectionInvalidator | undefined;
  #catalogHost: CatalogFlowHost | undefined;
  #shuttingDown = false;

  constructor(deps: ConnectFlowDeps) {
    this.#deps = deps;
    this.#cimdUrl = deps.cimdUrl ?? KEPCUP_OAUTH_CLIENT_ID;
    if (deps.allowInsecureCimdUrl !== true && new URL(this.#cimdUrl).protocol !== 'https:') {
      throw new AppError('INVALID_INPUT', 'CIMD client_id URL must be https');
    }
    this.#ports = deps.callbackPorts ?? OAUTH_CALLBACK_PORTS;
    this.#timeoutMs = deps.flowTimeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
    this.#invalidator = deps.invalidator;
  }

  /** 接入运行时缓存失效器（`ConnectionAuthRegistry`）。 */
  attachInvalidator(invalidator: ConnectionInvalidator): void {
    this.#invalidator = invalidator;
  }

  /** 接入目录连接的业务端（`apps/connections.ts`）；未接入时目录目标报 NOT_IMPLEMENTED。 */
  attachCatalogHost(host: CatalogFlowHost): void {
    this.#catalogHost = host;
  }

  // --- 对外操作（apps.connect*） -----------------------------------------------

  /**
   * 发起（或接入）一个目标的交互授权流程。同一目标进程内同时至多一个流程：重复调用返回
   * 同一 `flowId`，并重发其当前阶段事件（后到的卡片得以订阅同一流程）。
   */
  start(input: StartFlowInput): { flowId: string } {
    if (this.#shuttingDown) {
      throw new AppError('OAUTH_FLOW_CANCELLED', '应用正在退出，无法发起授权');
    }
    if (input.target.kind === 'catalog') return this.#startCatalog(input, input.target.connectorId);
    const server = this.#resolveCustomServer(input.target.serverId);
    const targetKey = `custom:${server.id}`;
    const existingId = this.#byTarget.get(targetKey);
    const existing = existingId !== undefined ? this.#flows.get(existingId) : undefined;
    if (existing !== undefined) {
      this.#deps.events.emit('apps.connect_flow', existing.lastPayload);
      return { flowId: existing.id };
    }

    const serverUrl = server.url as string;
    const connection = this.#deps.store.ensureCustom(server.id, {
      label: server.name,
      serverUrl,
    });
    const abort = deferred<void>();
    const flow: Flow = {
      id: `flow_${randomUUID()}`,
      targetKey,
      serverId: server.id,
      serverName: server.name,
      serverUrl,
      connectionId: connection.id,
      scopes: input.scopes,
      // A tool-lock row of a server that just became OAuth may read `connected` without any
      // token: a failed / cancelled flow must fall back to `not_connected`, not to that.
      previousStatus:
        connection.status === 'connecting' || this.#deps.vault.getTokens(connection.id) === null
          ? 'not_connected'
          : connection.status,
      phase: 'discovering',
      lastPayload: { flowId: '', phase: 'discovering' },
      issuer: null,
      consentedHost: null,
      clientRetries: 0,
      callback: null,
      consent: null,
      credentials: null,
      abortError: null,
      controller: new AbortController(),
      abort,
      timer: null,
      done: Promise.resolve(),
    };
    flow.lastPayload = { flowId: flow.id, phase: 'discovering', connectionId: flow.connectionId };
    this.#flows.set(flow.id, flow);
    this.#byTarget.set(targetKey, flow.id);
    this.#armTimer(flow);

    this.#setStatus(flow.connectionId, 'connecting');
    this.#emitFlow(flow, { phase: 'discovering' });
    flow.done = this.#run(flow);
    return { flowId: flow.id };
  }

  /** 目录连接：同一 Connector（或同一重连目标）同时至多一个流程。 */
  #startCatalog(input: StartFlowInput, connectorId: string): { flowId: string } {
    const host = this.#catalogHost;
    if (host === undefined) throw new AppError('NOT_IMPLEMENTED', '应用目录模块未就绪');
    const targetKey =
      input.connectionId !== undefined ? `conn:${input.connectionId}` : `catalog:${connectorId}`;
    const existingId = this.#byTarget.get(targetKey);
    const existing = existingId !== undefined ? this.#flows.get(existingId) : undefined;
    if (existing !== undefined) {
      this.#deps.events.emit('apps.connect_flow', existing.lastPayload);
      return { flowId: existing.id };
    }
    // 先校验并建临时行：目录里没有 / 门禁未放行 / 需要预注册客户端都在这里同步报错。
    const begin = host.begin({ connectorId, reconnectTo: input.connectionId });
    const abort = deferred<void>();
    const flow: Flow = {
      id: `flow_${randomUUID()}`,
      targetKey,
      serverId: begin.connectorId,
      serverName: begin.title,
      serverUrl: begin.serverUrl,
      connectionId: begin.connectionId,
      scopes: input.scopes ?? (begin.defaultScopes.length > 0 ? begin.defaultScopes : undefined),
      previousStatus: 'not_connected',
      phase: 'discovering',
      lastPayload: { flowId: '', phase: 'discovering' },
      issuer: null,
      consentedHost: null,
      clientRetries: 0,
      callback: null,
      consent: null,
      credentials: null,
      abortError: null,
      controller: new AbortController(),
      abort,
      timer: null,
      done: Promise.resolve(),
      catalog: {
        begin,
        grantBotId: input.grantBotId,
        stage: 'pre',
        rowIsNew: true,
        review: null,
        settling: null,
      },
    };
    flow.lastPayload = { flowId: flow.id, phase: 'discovering', connectionId: flow.connectionId };
    this.#flows.set(flow.id, flow);
    this.#byTarget.set(targetKey, flow.id);
    this.#armTimer(flow);
    this.#setStatus(flow.connectionId, 'connecting');
    this.#emitFlow(flow, { phase: 'discovering' });
    flow.done = this.#run(flow);
    return { flowId: flow.id };
  }

  /** 首连工具复核通过（`reviewing_tools` 阶段）：批准全部待复核工具。拒绝 = {@link cancel}。 */
  confirmTools(flowId: string): void {
    const flow = this.#flows.get(flowId);
    if (flow === undefined) {
      throw new AppError('INVALID_INPUT', '授权流程不存在或已结束');
    }
    if (flow.catalog?.review == null) {
      throw new AppError('INVALID_INPUT', '该流程当前不在工具复核阶段');
    }
    flow.catalog.review.resolve();
  }

  /** 用户在界面确认授权主机后调用：打开系统浏览器。 */
  continue(flowId: string): void {
    const flow = this.#flows.get(flowId);
    if (flow === undefined) {
      throw new AppError('INVALID_INPUT', '授权流程不存在或已结束');
    }
    // 已确认过（或不在等待确认阶段）时静默：界面重复点击不应报错。
    flow.consent?.resolve();
  }

  /** 取消（幂等：流程不存在或已结束时静默）。 */
  cancel(flowId: string): void {
    const flow = this.#flows.get(flowId);
    if (flow === undefined) return;
    this.#abortFlow(flow, new AppError('OAUTH_FLOW_CANCELLED', '授权已取消'));
  }

  /**
   * 取消某个自定义 server 进行中的流程（server 的 URL / 认证方式被改掉时：流程拿到的令牌
   * 属于旧配置，绝不能落到新配置上）。幂等。
   */
  cancelForServer(serverId: string): void {
    const flowId = this.#byTarget.get(`custom:${serverId}`);
    if (flowId !== undefined) this.cancel(flowId);
  }

  /**
   * 取消某个连接进行中的流程并等它收尾（`apps.disconnect`）：断开后连接状态应是
   * `not_connected`，所以不再恢复流程开始前的状态。幂等。
   */
  async cancelForConnection(connectionId: string): Promise<void> {
    const flows = [...this.#flows.values()].filter((flow) => flow.connectionId === connectionId);
    for (const flow of flows) {
      flow.previousStatus = 'not_connected';
      this.#abortFlow(flow, new AppError('OAUTH_FLOW_CANCELLED', '连接已断开，授权已取消'));
    }
    await Promise.all(flows.map((flow) => flow.done));
  }

  /**
   * 手填客户端（`OAUTH_CLIENT_REQUIRED` 之后）：写入该流程 issuer 的 Token Vault 并继续流程。
   * 只写不读回。
   */
  setClientCredentials(flowId: string, clientId: string, clientSecret?: string): void {
    const flow = this.#flows.get(flowId);
    if (flow === undefined || flow.credentials === null || flow.issuer === null) {
      throw new AppError('INVALID_INPUT', '授权流程不存在、已结束或不需要客户端凭据');
    }
    this.#deps.vault.saveClient(
      flow.issuer,
      {
        client_id: clientId,
        ...(clientSecret !== undefined && clientSecret.length > 0
          ? { client_secret: clientSecret }
          : {}),
      },
      { source: 'manual', redirectUris: [] },
    );
    // 用户为这次流程提供凭据后，总时限重新计时（去平台开发者后台登记需要时间）。
    this.#armTimer(flow);
    const credentials = flow.credentials;
    // 同步离开「等待凭据」状态并发出新阶段：紧随其后的重复 `apps.connect`（界面可能这样做）
    // 与同一目标去重，拿到同一 flowId 且重发的是「进行中」而不是过期的 OAUTH_CLIENT_REQUIRED。
    flow.credentials = null;
    this.#emitFlow(flow, { phase: 'discovering' });
    credentials.resolve();
  }

  /** 进行中的流程 id（测试 / 诊断）。 */
  activeFlowIds(): string[] {
    return [...this.#flows.keys()];
  }

  /** 应用退出：取消所有流程并等待清理完成（关回调服务、丢弃 verifier）。 */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const pending = [...this.#flows.values()];
    for (const flow of pending) {
      this.#abortFlow(flow, new AppError('OAUTH_FLOW_CANCELLED', '应用退出，授权已取消'));
    }
    await Promise.all(pending.map((flow) => flow.done));
  }

  // --- 流程骨架 -----------------------------------------------------------------

  #resolveCustomServer(serverId: string): McpServer {
    const server = this.#deps.settings.get().mcpServers.find((entry) => entry.id === serverId);
    if (server === undefined) {
      throw new AppError('NOT_FOUND', `MCP server「${serverId}」不存在`, { serverId });
    }
    if (server.transport !== 'http' || server.auth !== 'oauth' || server.url === undefined) {
      throw new AppError(
        'INVALID_INPUT',
        `MCP server「${server.name}」未配置为 OAuth 认证的 HTTP server`,
        {
          serverId,
        },
      );
    }
    return server;
  }

  async #run(flow: Flow): Promise<void> {
    try {
      for (;;) {
        try {
          // 每次尝试（含 invalid_client 后的重试）重新计时：换令牌阶段会清掉总时限，
          // 重试若不重新武装，停放在 OAUTH_CLIENT_REQUIRED 的流程就永远不会超时。
          this.#armTimer(flow);
          await this.#attempt(flow);
          break;
        } catch (error) {
          // 每次尝试各自的回调服务（含端口）；重试前先关掉上一个。
          await flow.callback?.close().catch(() => undefined);
          flow.callback = null;
          if (error instanceof ClientRejectedSignal && flow.clientRetries < 1) {
            flow.clientRetries += 1;
            this.#emitFlow(flow, { phase: 'discovering' });
            continue;
          }
          if (error instanceof ClientRejectedSignal) {
            throw new AppError(
              'OAUTH_FLOW_FAILED',
              '授权服务器拒绝了客户端凭据（invalid_client），重新注册后仍然失败',
            );
          }
          throw error;
        }
      }
    } catch (error) {
      const failure = flow.abortError ?? error;
      await this.#catalogCleanup(flow, failure);
      this.#finishFailed(flow, failure);
    } finally {
      if (flow.timer !== null) clearTimeout(flow.timer);
      flow.timer = null;
      await flow.callback?.close().catch(() => undefined);
      flow.callback = null;
      flow.consent = null;
      flow.credentials = null;
      this.#flows.delete(flow.id);
      if (this.#byTarget.get(flow.targetKey) === flow.id) this.#byTarget.delete(flow.targetKey);
    }
  }

  async #attempt(flow: Flow): Promise<void> {
    const loopbackHosts = this.#loopbackHosts(flow.serverUrl);
    const rawFetch = createSafeFetch({ loopbackHosts });
    const fetch: McpFetch = (input, init) =>
      rawFetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, flow.controller.signal])
          : flow.controller.signal,
      });

    // 1. 发现 --------------------------------------------------------------
    const challenge = await this.#probe(flow, fetch);
    const info = await this.#race(
      flow,
      discoverOAuthServerInfo(flow.serverUrl, {
        ...(challenge.resourceMetadataUrl !== undefined
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
        fetch,
      }),
    );
    const metadata = info.authorizationServerMetadata;
    const asUrl = info.authorizationServerUrl;
    const issuer = metadata?.issuer ?? asUrl;
    flow.issuer = issuer;
    for (const endpoint of [
      metadata?.authorization_endpoint,
      metadata?.token_endpoint,
      metadata?.registration_endpoint,
    ]) {
      if (endpoint !== undefined) this.#assertEndpoint(endpoint, loopbackHosts);
    }
    const resource =
      selectResource(flow.serverUrl, info.resourceMetadata) ??
      resourceUrlFromServerUrl(flow.serverUrl).href;
    const scope =
      (flow.scopes !== undefined && flow.scopes.length > 0 ? flow.scopes.join(' ') : undefined) ??
      (challenge.scope || undefined) ??
      (info.resourceMetadata?.scopes_supported?.length
        ? info.resourceMetadata.scopes_supported.join(' ')
        : undefined);

    // 2. 客户端身份（设计 29 §5.1 第 3 步的顺序） ---------------------------------
    type Identity =
      | {
          kind: 'stored';
          info: OAuthClientInformation;
          source: 'dcr' | 'manual' | 'preregistered';
          redirectUris: string[];
        }
      | { kind: 'cimd'; info: OAuthClientInformation }
      | { kind: 'dcr' };
    const resolveIdentity = (): Identity | null => {
      const stored = this.#deps.vault.getClient(issuer);
      if (stored !== null) {
        return {
          kind: 'stored',
          info: stored.info,
          source: stored.source,
          redirectUris: stored.redirectUris,
        };
      }
      if (metadata?.client_id_metadata_document_supported === true) {
        return { kind: 'cimd', info: { client_id: this.#cimdUrl } };
      }
      if (metadata?.registration_endpoint !== undefined) return { kind: 'dcr' };
      return null;
    };
    let identity = resolveIdentity();
    while (identity === null) {
      // 无任何注册途径：失败事件带 issuer 与需用户登记的回调地址，流程停放等待
      // `apps.setClientCredentials`（或取消 / 超时）。
      flow.credentials = deferred<void>();
      this.#armTimer(flow); // 停放等待用户登记客户端：从此刻起计总时限
      this.#emitFlow(flow, {
        phase: 'failed',
        error: {
          code: 'OAUTH_CLIENT_REQUIRED',
          message: '该授权服务器不支持自动注册客户端，请填写你在其平台登记的 client id',
          issuer,
          redirectUris: fixedRedirectUris(this.#ports),
        },
      });
      await this.#race(flow, flow.credentials.promise);
      identity = resolveIdentity();
    }

    // 3. 回调服务 + DCR 端口预判 -----------------------------------------------
    const state = randomBytes(32).toString('base64url');
    const callback = await startCallbackServer({ state, ports: this.#ports });
    flow.callback = callback;
    this.#throwIfAborted(flow);

    let client: OAuthClientInformation;
    let source: 'cimd' | 'dcr' | 'manual' | 'preregistered';
    if (identity.kind === 'cimd') {
      client = identity.info;
      source = 'cimd';
    } else if (identity.kind === 'stored') {
      client = identity.info;
      source = identity.source;
      if (identity.source === 'dcr') {
        if (!identity.redirectUris.includes(callback.redirectUri)) {
          // 本次端口不在已登记列表（固定端口全被占用）：授权服务器对非法 redirect 不会回调，
          // 必须在打开浏览器前重新注册。
          client = await this.#register(flow, { asUrl, metadata, issuer, callback, scope, fetch });
        }
      } else if (callback.usedFallbackPort) {
        throw new AppError(
          'OAUTH_FLOW_FAILED',
          `固定回调端口 ${this.#ports.join('、')} 均被占用，而该客户端只登记了固定端口的回调地址。请释放其中一个端口后重试`,
        );
      }
    } else {
      source = 'dcr';
      client = await this.#register(flow, { asUrl, metadata, issuer, callback, scope, fetch });
    }

    // 4. PKCE + state + 授权 URL ---------------------------------------------
    const { authorizationUrl, codeVerifier } = await startAuthorization(asUrl, {
      ...(metadata !== undefined ? { metadata } : {}),
      clientInformation: client,
      redirectUrl: callback.redirectUri,
      ...(scope !== undefined ? { scope } : {}),
      state,
      resource,
    });
    this.#assertEndpoint(authorizationUrl.href, loopbackHosts);

    // 5. 同意与打开 -----------------------------------------------------------
    // 自定义 server：授权端点主机不在已审核目录内，须用户先核对再打开（P1 起目录内已审核
    // issuer 直接打开）。重试（invalid_client 重新注册）时用户已确认过，不再询问。
    // 目录应用（builtin，经 KepCup 审核的远程端点）：授权服务器与 MCP 端点同一站点（如
    // mcp.stripe.com → access.stripe.com）时直接打开；授权服务器指向别的站点则仍须用户先核对。
    const autoOpen =
      flow.catalog !== undefined &&
      sameSite(new URL(flow.serverUrl).hostname, authorizationUrl.hostname);
    if (!autoOpen && flow.consentedHost !== authorizationUrl.host) {
      flow.consent = deferred<void>();
      this.#emitFlow(flow, {
        phase: 'awaiting_consent',
        authorizationHost: authorizationUrl.host,
        authorizationUrl: authorizationUrl.href,
      });
      await this.#race(flow, flow.consent.promise);
      flow.consent = null;
      flow.consentedHost = authorizationUrl.host;
    }
    this.#emitFlow(flow, { phase: 'awaiting_browser', authorizationHost: authorizationUrl.host });
    const delivered = callback.waitForCallback({ timeoutMs: this.#timeoutMs });
    delivered.catch(() => undefined);
    const opened = await this.#race(
      flow,
      this.#deps.shell.openExternal({ url: authorizationUrl.href }),
    );
    if (!opened.ok) {
      throw new AppError('OAUTH_FLOW_FAILED', '无法打开系统浏览器，请检查系统默认浏览器设置');
    }
    const delivery = await this.#race(flow, delivered);

    // 6. 回调校验 -------------------------------------------------------------
    const { params } = delivery;
    try {
      if (params.error !== undefined) {
        const reason =
          params.error === 'access_denied'
            ? '你在授权页拒绝了授权'
            : `授权服务器返回错误：${params.error}`;
        throw new AppError('OAUTH_FLOW_FAILED', reason, { oauthError: params.error });
      }
      // RFC 9207：携带了 iss 必须相符；授权服务器声明支持却缺失同样失败。
      if (
        metadata !== undefined &&
        (params.iss !== undefined ||
          metadata.authorization_response_iss_parameter_supported === true) &&
        params.iss !== metadata.issuer
      ) {
        throw new AppError(
          'OAUTH_ISSUER_MISMATCH',
          params.iss === undefined
            ? '授权响应缺少 iss 参数（授权服务器声明了支持 RFC 9207）'
            : '授权响应的 iss 与授权服务器不一致',
        );
      }
      if (params.code === undefined || params.code.length === 0) {
        throw new AppError('OAUTH_FLOW_FAILED', '授权响应缺少授权码');
      }

      this.#emitFlow(flow, { phase: 'exchanging' });
      // 总时限只管用户操作；进入换令牌后由请求自身的超时约束。
      if (flow.timer !== null) clearTimeout(flow.timer);
      flow.timer = null;
      const tokens = await this.#exchange(flow, {
        asUrl,
        metadata,
        client,
        resource,
        code: params.code,
        codeVerifier,
        redirectUrl: callback.redirectUri,
        fetch,
        source,
        issuer,
      });

      // 目录连接：账号标识来自 id_token（仅瞬时使用，不落盘）或 userinfo。
      const hint =
        flow.catalog !== undefined
          ? await this.#accountHint(flow, { tokens, metadata, client, issuer, fetch })
          : null;

      // 7. 落盘：先写发现结果（issuer），再写令牌，最后置 connected ----------------
      this.#throwIfAborted(flow); // 取消 / 断开与换令牌赛跑：已取消则不落盘
      this.#deps.vault.saveDiscovery(flow.connectionId, info as OAuthServerInfo);
      this.#deps.vault.saveTokens(flow.connectionId, {
        ...tokens,
        ...(tokens.scope === undefined && scope !== undefined ? { scope } : {}),
      });
      // 记下这个连接用的客户端：同一 issuer 上别的连接之后重新注册（换端口）会顶掉 issuer
      // 级客户端，刷新 / 吊销只认令牌发给的那个 client_id。
      this.#deps.vault.saveConnectionClient(flow.connectionId, client);
      if (flow.catalog !== undefined) {
        await this.#settleCatalog(flow, hint, delivery);
        return;
      }
      this.#deps.store.update(flow.connectionId, { status: 'connected' });
      await this.#invalidate(flow.connectionId);
      this.#deps.events.emit('apps.connection_status', {
        connectionId: flow.connectionId,
        status: 'connected',
      });
      delivery.respond({ ok: true });
      flow.previousStatus = 'connected';
      this.#emitFlow(flow, { phase: 'done' });
    } catch (error) {
      delivery.respond({
        ok: false,
        reason:
          error instanceof ClientRejectedSignal
            ? '客户端注册已失效，正在重新注册'
            : this.#describe(error).message,
      });
      throw error;
    }
  }

  // --- 目录连接（P1）：账号识别 / 结算 / 工具复核 ---------------------------------------

  /**
   * 令牌已写入临时行之后：账号识别 → 合并既有行 → 工具复核 → 完成。浏览器结果页在结算完成后
   * 立刻显示成功（不等用户在界面里复核）。
   */
  async #settleCatalog(
    flow: Flow,
    hint: AccountHint | null,
    delivery: { respond(result: { ok: true } | { ok: false; reason: string }): void },
  ): Promise<void> {
    const catalog = flow.catalog!;
    const host = this.#catalogHost!;
    catalog.stage = 'tokens';
    catalog.settling = host.settle({
      connectionId: flow.connectionId,
      reconnectTo: catalog.begin.reconnectTo,
      hint,
      signal: flow.controller.signal,
    });
    catalog.settling.catch(() => undefined);
    const settled = await this.#race(flow, catalog.settling);
    catalog.settling = null;
    flow.connectionId = settled.connectionId;
    catalog.rowIsNew = settled.isNew;
    catalog.stage = 'settled';
    await this.#invalidate(flow.connectionId);
    delivery.respond({ ok: true });

    if (settled.review.length > 0) {
      catalog.review = deferred<void>();
      this.#armTimer(flow); // 复核同样受总时限约束（超时 = 拒绝）
      this.#emitFlow(flow, {
        phase: 'reviewing_tools',
        tools: settled.review,
        ...(settled.accountLabel !== null ? { accountLabel: settled.accountLabel } : {}),
      });
      await this.#race(flow, catalog.review.promise);
      catalog.review = null;
    }
    this.#throwIfAborted(flow);
    await host.confirm({
      connectionId: flow.connectionId,
      ...(catalog.grantBotId !== undefined ? { grantBotId: catalog.grantBotId } : {}),
    });
    const row = this.#deps.store.get(flow.connectionId);
    this.#deps.events.emit('apps.connection_status', {
      connectionId: flow.connectionId,
      status: row?.status ?? 'connected',
    });
    flow.previousStatus = 'connected';
    this.#emitFlow(flow, {
      phase: 'done',
      ...(settled.accountLabel !== null ? { accountLabel: settled.accountLabel } : {}),
    });
  }

  /** 目录连接的失败收尾：令牌落盘前删临时行；落盘后新建的连接吊销并清除（既有连接保留）。 */
  async #catalogCleanup(flow: Flow, failure: unknown): Promise<void> {
    const catalog = flow.catalog;
    const host = this.#catalogHost;
    if (catalog === undefined || host === undefined) return;
    try {
      if (catalog.settling !== null) {
        // 取消 / 超时与结算赛跑：等它收尾（宿主侧据 signal 尽快结束），按它最终定下的行清理。
        const late = await catalog.settling.catch(() => null);
        catalog.settling = null;
        if (late !== null) {
          flow.connectionId = late.connectionId;
          catalog.rowIsNew = late.isNew;
          catalog.stage = 'settled';
        }
      }
      if (catalog.stage === 'pre') {
        host.abandon(flow.connectionId);
      } else if (catalog.rowIsNew) {
        await host.reject({ connectionId: flow.connectionId });
      }
    } catch (error) {
      this.#deps.logger.warn(
        { flowId: flow.id, connectionId: flow.connectionId, err: String(error) },
        'catalog connect cleanup failed',
      );
    }
    this.#deps.logger.info(
      { flowId: flow.id, stage: catalog.stage, rowIsNew: catalog.rowIsNew },
      failure instanceof AppError && failure.code === 'OAUTH_FLOW_CANCELLED'
        ? 'catalog connect cancelled'
        : 'catalog connect failed',
    );
  }

  /**
   * 账号标识（设计 29 §5.1 第 6 步）：优先令牌响应里的 id_token（OIDC：直接从令牌端点经 TLS
   * 取得，按 OIDC Core §3.1.3.7 可不验签，仍核对 iss / aud），否则 AS 元数据里的 userinfo 端点。
   * id_token 只在此处瞬时解码，从不落盘 / 记日志。失败一律忽略（回退到 `whoami` / 自动编号）。
   */
  async #accountHint(
    flow: Flow,
    ctx: {
      tokens: OAuthTokens;
      metadata: OAuthServerInfo['authorizationServerMetadata'];
      client: OAuthClientInformation;
      issuer: string;
      fetch: McpFetch;
    },
  ): Promise<AccountHint | null> {
    let hint: AccountHint | null = null;
    if (ctx.tokens.id_token !== undefined) {
      const claims = decodeIdTokenClaims(ctx.tokens.id_token);
      const expectedIssuer = ctx.metadata?.issuer ?? ctx.issuer;
      const audience = claims?.['aud'];
      const audienceOk =
        audience === undefined ||
        audience === ctx.client.client_id ||
        (Array.isArray(audience) && audience.includes(ctx.client.client_id));
      if (
        claims !== null &&
        (claims['iss'] === undefined || claims['iss'] === expectedIssuer) &&
        audienceOk
      ) {
        hint = hintFromClaims(claims);
      }
    }
    const userinfoEndpoint = (ctx.metadata as { userinfo_endpoint?: unknown } | undefined)
      ?.userinfo_endpoint;
    if (hint?.sub === undefined && typeof userinfoEndpoint === 'string') {
      try {
        this.#assertEndpoint(userinfoEndpoint, this.#loopbackHosts(flow.serverUrl));
        const response = await this.#race(
          flow,
          ctx.fetch(userinfoEndpoint, {
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${ctx.tokens.access_token}`,
            },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          }),
        );
        if (response.ok) {
          const claims = (await response.json()) as unknown;
          if (typeof claims === 'object' && claims !== null && !Array.isArray(claims)) {
            const fromUserinfo = hintFromClaims(claims as Record<string, unknown>);
            hint = { ...fromUserinfo, ...(hint ?? {}) };
          }
        } else {
          void response.body?.cancel().catch(() => undefined);
        }
      } catch {
        if (flow.abortError !== null) throw flow.abortError;
        this.#deps.logger.info({ flowId: flow.id }, 'userinfo lookup failed; falling back');
      }
    }
    return hint;
  }

  // --- 步骤实现 -----------------------------------------------------------------

  /**
   * 探测 MCP 端点取 `WWW-Authenticate`（`resource_metadata`、`scope`）。尽力而为：网络类
   * 失败忽略（后续发现会给出真正的错误），但端点不被允许（非 https / 私网）必须上抛。
   */
  async #probe(flow: Flow, fetch: McpFetch): Promise<ReturnType<typeof parseWwwAuthenticate>> {
    try {
      const response = await this.#race(
        flow,
        fetch(flow.serverUrl, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'KepCup', version: '0' },
            },
          }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }),
      );
      void response.body?.cancel().catch(() => undefined);
      return response.status === 401
        ? parseWwwAuthenticate(response.headers.get('www-authenticate'))
        : {};
    } catch (error) {
      if (flow.abortError !== null) throw flow.abortError;
      if (error instanceof AppError && error.code === 'OAUTH_INSECURE_ENDPOINT') throw error;
      return {};
    }
  }

  async #register(
    flow: Flow,
    ctx: {
      asUrl: string;
      metadata: OAuthServerInfo['authorizationServerMetadata'];
      issuer: string;
      callback: CallbackServer;
      scope: string | undefined;
      fetch: McpFetch;
    },
  ): Promise<OAuthClientInformationFull> {
    // 固定端口全部登记；回落到随机端口时再加上本次端口。
    const redirectUris = [
      ...new Set([...fixedRedirectUris(this.#ports), ctx.callback.redirectUri]),
    ];
    const clientMetadata: OAuthClientMetadata & { application_type: 'native' } = {
      client_name: 'KepCup',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // pi-mcp 的 OAuthClientMetadata 类型缺该字段；registerClient 原样序列化整个对象。
      application_type: 'native',
    };
    const registered = await this.#race(
      flow,
      registerClient(ctx.asUrl, {
        ...(ctx.metadata !== undefined ? { metadata: ctx.metadata } : {}),
        clientMetadata,
        ...(ctx.scope !== undefined ? { scope: ctx.scope } : {}),
        fetch: ctx.fetch,
      }),
    );
    this.#deps.vault.saveClient(ctx.issuer, registered, {
      source: 'dcr',
      redirectUris: registered.redirect_uris.length > 0 ? registered.redirect_uris : redirectUris,
    });
    return registered;
  }

  async #exchange(
    flow: Flow,
    ctx: {
      asUrl: string;
      metadata: OAuthServerInfo['authorizationServerMetadata'];
      client: OAuthClientInformation;
      resource: string;
      code: string;
      codeVerifier: string;
      redirectUrl: string;
      fetch: McpFetch;
      source: 'cimd' | 'dcr' | 'manual' | 'preregistered';
      issuer: string;
    },
  ): Promise<OAuthTokens> {
    try {
      return await this.#race(
        flow,
        exchangeAuthorizationCode(ctx.asUrl, {
          ...(ctx.metadata !== undefined ? { metadata: ctx.metadata } : {}),
          clientInformation: ctx.client,
          resource: ctx.resource,
          code: ctx.code,
          codeVerifier: ctx.codeVerifier,
          redirectUrl: ctx.redirectUrl,
          fetch: ctx.fetch,
        }),
      );
    } catch (error) {
      if (
        error instanceof OAuthError &&
        (error.code === 'invalid_client' || error.code === 'unauthorized_client') &&
        ctx.source !== 'cimd' &&
        ctx.source !== 'preregistered'
      ) {
        // DCR 客户端被授权服务器清理 / 手填凭据有误：清除后重新走客户端身份（DCR 重新注册，
        // 手填则重新向用户索取）。
        this.#deps.vault.clearIssuerClient(ctx.issuer);
        throw new ClientRejectedSignal();
      }
      throw error;
    }
  }

  // --- 终态 / 事件 ----------------------------------------------------------------

  #finishFailed(flow: Flow, error: unknown): void {
    const described = this.#describe(error);
    // 流程未成功：恢复开始前的连接状态（成功路径已把 previousStatus 置为 connected）。目录连接
    // 不恢复：临时行已由 `#catalogCleanup` 删除，既有行从未被改动。
    if (flow.catalog === undefined) this.#setStatus(flow.connectionId, flow.previousStatus);
    if (described.code === 'OAUTH_FLOW_CANCELLED') {
      this.#emitFlow(flow, { phase: 'cancelled' });
      this.#deps.logger.info(
        { flowId: flow.id, connectionId: flow.connectionId },
        'app connect flow cancelled',
      );
      return;
    }
    this.#deps.logger.warn(
      {
        flowId: flow.id,
        connectionId: flow.connectionId,
        code: described.code,
        message: described.message,
      },
      'app connect flow failed',
    );
    this.#emitFlow(flow, { phase: 'failed', error: described });
  }

  #describe(error: unknown): NonNullable<AppConnectFlowPayload['error']> {
    if (error instanceof AppError) {
      const details = error.details as { issuer?: unknown } | undefined;
      const issuer = typeof details?.issuer === 'string' ? details.issuer : undefined;
      return {
        code: error.code,
        message: trimMessage(error.message),
        ...(issuer !== undefined ? { issuer } : {}),
      };
    }
    if (error instanceof OAuthIssuerMismatchError) {
      return { code: 'OAUTH_ISSUER_MISMATCH', message: '授权服务器的 issuer 与声明不一致' };
    }
    if (error instanceof OAuthInsecureEndpointError) {
      return { code: 'OAUTH_INSECURE_ENDPOINT', message: '授权服务器端点必须使用 https' };
    }
    if (error instanceof OAuthRegistrationError) {
      return { code: 'OAUTH_FLOW_FAILED', message: `客户端注册失败（HTTP ${error.status}）` };
    }
    if (error instanceof OAuthError) {
      return {
        code: 'OAUTH_FLOW_FAILED',
        message: trimMessage(`授权服务器拒绝：${error.message}`),
      };
    }
    return {
      code: 'OAUTH_FLOW_FAILED',
      message: trimMessage(`授权失败：${error instanceof Error ? error.message : String(error)}`),
    };
  }

  #emitFlow(flow: Flow, patch: Omit<AppConnectFlowPayload, 'flowId' | 'connectionId'>): void {
    flow.phase = patch.phase;
    const payload: AppConnectFlowPayload = {
      flowId: flow.id,
      connectionId: flow.connectionId,
      ...patch,
    };
    flow.lastPayload = payload;
    this.#deps.events.emit('apps.connect_flow', payload);
  }

  #setStatus(connectionId: string, status: AppConnectionStatus): void {
    try {
      const current = this.#deps.store.get(connectionId);
      if (current === null) return;
      if (current.status !== status) this.#deps.store.setStatus(connectionId, status);
      this.#deps.events.emit('apps.connection_status', { connectionId, status });
    } catch (error) {
      this.#deps.logger.warn(
        { connectionId, err: String(error) },
        'app connection status update failed',
      );
    }
  }

  async #invalidate(connectionId: string): Promise<void> {
    try {
      await this.#invalidator?.invalidate(connectionId);
    } catch (error) {
      this.#deps.logger.warn({ connectionId, err: String(error) }, 'connection invalidate failed');
    }
  }

  // --- 取消 / 超时 ------------------------------------------------------------------

  #armTimer(flow: Flow): void {
    if (flow.timer !== null) clearTimeout(flow.timer);
    flow.timer = setTimeout(() => {
      this.#abortFlow(flow, new AppError('OAUTH_FLOW_TIMEOUT', '授权超时，请重新发起连接'));
    }, this.#timeoutMs);
    flow.timer.unref();
  }

  #abortFlow(flow: Flow, error: AppError): void {
    if (flow.abortError !== null) return;
    flow.abortError = error;
    flow.controller.abort(error);
    flow.abort.resolve();
    // 关回调服务（等待者以 CANCELLED 失败）；verifier 随 #attempt 栈帧丢弃。
    void flow.callback?.close().catch(() => undefined);
  }

  #throwIfAborted(flow: Flow): void {
    if (flow.abortError !== null) throw flow.abortError;
  }

  /** 等待 `promise`，流程被取消 / 超时则立即以对应错误结束。 */
  async #race<T>(flow: Flow, promise: Promise<T>): Promise<T> {
    this.#throwIfAborted(flow);
    const aborted = flow.abort.promise.then(() => {
      throw flow.abortError ?? new AppError('OAUTH_FLOW_CANCELLED', '授权已取消');
    });
    aborted.catch(() => undefined);
    // `promise` 在输掉竞争后的 reject 不能变成 unhandled rejection。
    promise.catch(() => undefined);
    return Promise.race([promise, aborted]);
  }

  // --- 端点校验 ---------------------------------------------------------------------

  #loopbackHosts(serverUrl: string): string[] {
    const own = loopbackHostOf(serverUrl);
    return [...(own !== null ? [own] : []), ...(this.#deps.loopbackAllowlist ?? [])];
  }

  /** 授权相关端点必须 https；回环白名单内的主机除外（本机开发 / 测试注入）。 */
  #assertEndpoint(raw: string, loopbackHosts: readonly string[]): void {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError('OAUTH_INSECURE_ENDPOINT', '授权服务器返回了无法解析的端点地址');
    }
    if (url.protocol === 'https:') return;
    if (url.protocol === 'http:' && isLoopbackAllowed(url, loopbackHosts)) return;
    throw new AppError(
      'OAUTH_INSECURE_ENDPOINT',
      `授权服务器端点必须使用 https：${url.origin}${url.pathname}`,
    );
  }
}

/** 两个主机名属于同一站点（相等，或最后两段标签相同；IP 字面量 / 单标签主机只认相等）。 */
export function sameSite(a: string, b: string): boolean {
  const left = a.toLowerCase().replace(/^\[|\]$/g, '');
  const right = b.toLowerCase().replace(/^\[|\]$/g, '');
  if (left === right) return true;
  const isIp = (host: string): boolean => host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host);
  if (isIp(left) || isIp(right)) return false;
  const lastTwo = (host: string): string | null => {
    const labels = host.split('.');
    return labels.length >= 2 ? labels.slice(-2).join('.') : null;
  };
  const l = lastTwo(left);
  return l !== null && l === lastTwo(right);
}

/** JWT 载荷（不验签：id_token 直接取自令牌端点）；格式不对返回 null。 */
export function decodeIdTokenClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length < 2 || parts[1] === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** OIDC 标准声明 → 账号标识：`sub`；显示名取 email / preferred_username / name。 */
export function hintFromClaims(claims: Record<string, unknown>): AccountHint {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 100) : undefined;
  const sub = text(claims['sub']);
  const label = text(claims['email']) ?? text(claims['preferred_username']) ?? text(claims['name']);
  return { ...(sub !== undefined ? { sub } : {}), ...(label !== undefined ? { label } : {}) };
}

import {
  createRpcClient,
  type RpcClient,
  type TeamEventName,
  type TeamRpcMethodName,
  type TeamServerStatus,
} from '@kepcup/shared';
import { core } from './client.svelte';
import { domPortToTransport } from './port';
import { isTeamPortMessage } from './team-port';
import { getTeamServersApi, type TeamServerEntry, type TeamServersApi } from '$lib/features/team/platform-team-servers';
import { fusionPref } from '$lib/features/team/fusion-pref';
import { clientIdentityFor, type ClientIdentityView } from '$lib/features/collab/client-identity';

/**
 * 多来源连接注册表（T7 步骤 2，62.08 §3 桌面融合视图）。
 *
 * `SourceId = 'local' | \`team:${serverHash}\``：`'local'` 恒映射既有 `core`
 * 单例（web 端为服务端来源）——所有现有调用方式不变；团队来源经主进程桥接的
 * MessagePort 建 birpc 客户端（帧格式与本机 core 完全相同，`domPortToTransport`
 * 直接可用），whoami / 登录 / 重连由主进程负责，状态经 platform 事件同步。
 *
 * 休眠铁律：web 端点（`window.kepcup.isWeb === true`）不激活——web 的团队上下文
 * 仍是 T5 的同源 `core`；platform 方法不存在（未配置 / 旧构建）时同样休眠，
 * `connections.get('local')` 与单例行为一致（逐 PR 验收项）。
 */

export type SourceId = 'local' | `team:${string}`;

/**
 * 带来源的会话标识（T7 任务书 §2 钉死）：store 与选中态以 `(source, id)` 为
 * 键，杜绝跨来源 id 碰撞（同 id 本机 / 团队各一条互不干扰）。桌面应用的路由
 * 是 store 字段（无 URL），序列化形式供 localStorage / 通知跳转载荷使用。
 */
export interface ConversationRef {
  source: SourceId;
  id: string;
}

/** 字符串会话 id 一律视为本机来源（既有调用点的缺省语义）。 */
export function conversationRefOf(idOrRef: string | ConversationRef): ConversationRef {
  return typeof idOrRef === 'string' ? { source: 'local', id: idOrRef } : idOrRef;
}

/** 序列化键（`<source>::<id>`；来源与 id 都不含 `::`）。 */
export function refKey(ref: ConversationRef): string {
  return `${ref.source}::${ref.id}`;
}

export function parseRefKey(key: string): ConversationRef | null {
  const separator = key.indexOf('::');
  if (separator <= 0) return null;
  const source = key.slice(0, separator) as SourceId;
  const id = key.slice(separator + 2);
  if (id.length === 0) return null;
  if (source !== 'local' && !source.startsWith('team:')) return null;
  return { source, id };
}

export type TeamConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  /** 平台确认连续重试未果：显示「服务器不可用」；数据面语义同 reconnecting。 */
  | 'unreachable'
  | 'offline';

type EventHandler = (payload: unknown) => void;

export interface SourceConnection {
  /** RPC 调用（与本机 core 同一帧协议）。 */
  call(method: string, input?: unknown): Promise<unknown>;
  /** 团队层方法（shared team/ 契约）。 */
  callTeam<M extends TeamRpcMethodName>(method: M, input?: unknown): Promise<unknown>;
  /** core 事件订阅（团队来源 = 该团队连接上的事件流）。 */
  onEvent(event: string, handler: EventHandler): () => void;
  /** 团队事件订阅（shared TEAM_EVENT_NAMES）。 */
  onTeamEvent(name: TeamEventName, handler: EventHandler): () => void;
  /** 连接建立（含端口重建）后的回调；返回解绑函数。 */
  onConnected(handler: () => void): () => void;
  /** 当前连接状态；团队来源未连接时为 offline / reconnecting。 */
  readonly status: TeamConnectionState;
  /** 断开（本机来源恒为 no-op——core 单例自管重连）。 */
  markOffline(reconnectExpected: boolean): void;
  /** 该来源的协作客户端身份（local = 既有单例；团队 = serverHash+memberId 键）。 */
  readonly clientIdentity: ClientIdentityView;
  /** 来源对应的活跃成员 id（团队来源未登录为 null）。 */
  readonly memberId: string | null;
  /** Member identity changes; listeners run synchronously before any new port is bound. */
  onIdentityChanged(handler: (memberId: string | null) => void): () => void;
}

export function teamSourceId(serverHash: string): SourceId {
  return `team:${serverHash}`;
}

export function serverHashOf(source: SourceId): string | null {
  return source === 'local' ? null : source.slice('team:'.length);
}

/** 本机来源：全部委托 core 单例（不改任何现有调用方式）。 */
const localConnection: SourceConnection = {
  call: (method, input) => core.call(method, input),
  callTeam: <M extends TeamRpcMethodName>(method: M, input?: unknown) =>
    core.callTeam(method, input),
  onEvent: (event, handler) => core.onEvent(event, handler),
  onTeamEvent: (name, handler) => core.onTeamEvent(name, handler),
  onConnected: (handler) => core.onConnected(handler),
  get status(): TeamConnectionState {
    // core 的 failed 在多来源视图里并入 offline（重连由 core / 主进程负责）。
    return core.connection === 'connected'
      ? 'connected'
      : core.connection === 'connecting'
        ? 'connecting'
        : core.connection === 'reconnecting'
          ? 'reconnecting'
          : 'offline';
  },
  markOffline(): void {
    // 本机 core 单例自管连接状态，这里不动作。
  },
  get clientIdentity(): ClientIdentityView {
    return clientIdentityFor('local');
  },
  get memberId(): string | null {
    return null;
  },
  onIdentityChanged: () => () => undefined,
};

/**
 * 一条团队连接：主进程经 team-port 窗口消息交付 MessagePort（nonce 校验同
 * core-port 先例），端口上承载与本机 core 完全相同的 birpc JSON 帧。端口关闭 /
 * platform 状态回落时销毁客户端并置 offline——UI 显示「未连接」占位，不伪造数据。
 */
class TeamConnection implements SourceConnection {
  status = $state<TeamConnectionState>('offline');
  #memberId = $state<string | null>(null);

  readonly #serverHash: string;
  readonly #eventHandlers = new Map<string, Set<EventHandler>>();
  readonly #connectedHandlers = new Set<() => void>();
  // Plain Set: listener registry, not UI state.
  readonly #identityListeners = new Set<(memberId: string | null) => void>();
  #rpc: RpcClient | null = null;
  #port: MessagePort | null = null;
  #portMemberId: string | null = null;
  #transportGeneration = 0;

  constructor(serverHash: string, memberId: string | null) {
    this.#serverHash = serverHash;
    this.#memberId = memberId;
  }

  get memberId(): string | null {
    return this.#memberId;
  }

  set memberId(value: string | null) {
    if (this.#memberId === value) return;
    this.#memberId = value;
    this.#dropClient('team source identity changed');
    this.status = 'offline';
    for (const listener of [...this.#identityListeners]) listener(value);
  }

  onIdentityChanged(handler: (memberId: string | null) => void): () => void {
    this.#identityListeners.add(handler);
    return () => this.#identityListeners.delete(handler);
  }

  get clientIdentity(): ClientIdentityView {
    return clientIdentityFor({ serverHash: this.#serverHash, memberId: this.memberId });
  }

  /** 主进程交付的端口绑定（每次重建都替换旧客户端）。 */
  bind(port: MessagePort, memberId: string | null = this.memberId): void {
    this.memberId = memberId;
    this.#dropClient('team port replaced');
    this.#portMemberId = memberId;
    this.#port = port;
    const generation = this.#transportGeneration;
    port.start();
    this.#rpc = createRpcClient({
      transport: domPortToTransport(port),
      eventHandlers: this.#eventProxy(memberId, generation),
    });
    this.status = 'connected';
    for (const handler of this.#connectedHandlers) handler();
  }

  /**
   * 平台状态回落：`reconnectExpected=true` 只标记「重连中」，**保留**当前端口与
   * RPC 客户端——主进程桥的 WS 重连复用同一对 MessagePort，销毁客户端会让连接
   * 永远回不来；`false`（用户断开 / 移除 / 认证失效）才销毁。
   */
  markOffline(reconnectExpected: boolean): void {
    if (!reconnectExpected) this.#dropClient('team source disconnected');
    this.status = reconnectExpected ? 'reconnecting' : 'offline';
  }

  /**
   * 平台确认连续重试未果（`unreachable`）：UI 显示「服务器不可用」；同时拒掉
   * 所有 pending 调用——它们的帧还排在桥的 outboundQueue 里，不拒的话调用方要
   * 挂到 birpc 超时（30 分钟）才失败，恢复后还会被冲放成陈旧重复执行。桥保留
   * 端口后台退避重试，服务器恢复后回 connected。
   */
  markUnreachable(): void {
    this.status = 'unreachable';
    this.#rpc?.rejectPending('team source unreachable');
  }

  /**
   * 平台状态回到 connected（WS 重连成功，或「connecting 旧帧」晚于端口交付到达
   * 的竞态）：端口已就绪就恢复数据面，不再依赖主进程重发端口。
   */
  markConnected(): void {
    if (this.#port !== null) this.status = 'connected';
  }

  #dropClient(reason: string): void {
    this.#transportGeneration += 1;
    if (this.#rpc !== null) {
      this.#rpc.rejectPending(reason);
      this.#rpc.close();
      this.#rpc = null;
    }
    if (this.#port !== null) {
      try {
        this.#port.close();
      } catch {
        // 端口已由对端关闭。
      }
      this.#port = null;
    }
    this.#portMemberId = null;
  }

  onConnected(handler: () => void): () => void {
    this.#connectedHandlers.add(handler);
    return () => this.#connectedHandlers.delete(handler);
  }

  onEvent(event: string, handler: EventHandler): () => void {
    let set = this.#eventHandlers.get(event);
    if (!set) {
      // Plain Set: event registry, not UI state.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      set = new Set();
      this.#eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  onTeamEvent(name: TeamEventName, handler: EventHandler): () => void {
    return this.onEvent(name, handler);
  }

  async call(method: string, input?: unknown): Promise<unknown> {
    if (!this.#rpc) throw new Error('team source not connected');
    // unreachable 稳态（平台确认连续重试未果）不发新帧：主进程桥会把它排队到 WS
    // 恢复后冲放——陈旧写操作会被延迟重复执行，排队时长也无界。这里快速失败，
    // 调用方按错误提示、恢复 connected 后重试。reconnecting 不拦：它是瞬态标签
    // （旧 connecting 帧晚到的竞态里 WS 实际是通的），瞬态窗口的帧由桥侧队列
    // TTL / 容量兜底。
    if (this.status === 'unreachable') {
      throw new Error('team source unreachable');
    }
    const rpc = this.#rpc;
    const generation = this.#transportGeneration;
    const memberId = this.#memberId;
    const result = await rpc.call(method, input === undefined ? undefined : $state.snapshot(input));
    if (generation !== this.#transportGeneration || memberId !== this.#memberId) {
      throw new Error('team source identity changed');
    }
    return result;
  }

  async callTeam<M extends TeamRpcMethodName>(method: M, input?: unknown): Promise<unknown> {
    return this.call(method, input);
  }

  /** birpc 按事件名在投递时查 handler：Proxy 让后注册的订阅也能收到。 */
  #eventProxy(
    portMemberId: string | null,
    generation: number,
  ): Record<string, (payload: unknown) => void> {
    return new Proxy(
      {},
      {
        get: (_target: Record<string, unknown>, name: string | symbol) => {
          if (typeof name !== 'string') return undefined;
          return (payload: unknown) => {
            if (
              generation !== this.#transportGeneration ||
              this.#portMemberId !== portMemberId ||
              this.memberId !== portMemberId
            ) {
              return;
            }
            const handlers = this.#eventHandlers.get(name);
            if (!handlers) return;
            for (const handler of handlers) handler(payload);
          };
        },
      },
    ) as Record<string, (payload: unknown) => void>;
  }
}

class ConnectionsRegistry {
  /** 主进程下发的服务器清单（响应式：设置卡 / sources() / 占位判定共用）。 */
  servers = $state<TeamServerEntry[]>([]);
  /** 已建立的团队连接（serverHash → 连接）。 */
  readonly #teams = new Map<string, TeamConnection>();
  /** 响应式锚点：teams 变化（建 / 拆）时递增，sources() 据此重算。 */
  #teamsRevision = $state(0);
  #started = false;
  #refreshGeneration = 0;
  /** A microtask-coalesced replacement refresh is already queued. */
  #refreshQueued = false;
  #api: TeamServersApi | null = null;
  /** 本会话内已自动请求过 connect 的服务器（避免 onChanged 循环重连）。 */
  readonly #connectAttempted = new Set<string>();
  /** 来源清单 / 连接集合变化的监听（contacts / chat 团队切片接线用）。 */
  readonly #sourcesListeners = new Set<() => void>();
  /** 平台清单里最近一次的连接状态（onTeamOnline 的 WS 判据；端口就绪是另一判据）。 */
  readonly #platformStatus = new Map<string, TeamServerStatus>();
  /** 真·在线边沿订阅（按 serverHash）。 */
  readonly #onlineListeners = new Map<string, Set<() => void>>();
  /** 本会话已发过上线边沿的 hash（断开即移除，重新上线再触发）。 */
  readonly #onlineNotified = new Set<string>();

  /**
   * 应用启动接线（App.svelte，与 core.start() 同一处）：桌面端点才激活；
   * web 端点（isWeb）与无 platform 方法的环境保持休眠。
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const web = isWebEndpoint();
    this.#api = web ? null : getTeamServersApi();
    if (this.#api === null) return;
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.#onWindowMessage);
    }
    this.#api.onChanged(() => void this.#refresh());
    void this.#refresh();
  }

  /** 响应式来源清单：本机 + 已配置且开启融合的团队服务器。 */
  sources(): SourceId[] {
    void this.#teamsRevision;
    void this.servers;
    const hashes = this.servers
      .filter((server) => fusionPref().isEnabled(server.serverHash) && server.accounts.length > 0)
      .map((server) => server.serverHash);
    for (const hash of this.#teams.keys()) {
      if (!hashes.includes(hash)) hashes.push(hash);
    }
    return ['local', ...hashes.map(teamSourceId)];
  }

  /**
   * 按来源取连接。`'local'` 恒为单例视图；团队来源未建（未交付端口 / 断开）时
   * 返回占位连接（status offline，call 抛 not connected）——订阅可以先挂上，
   * 端口到达后同一实例转 connected。
   */
  get(sourceId: SourceId): SourceConnection {
    if (sourceId === 'local') return localConnection;
    const hash = serverHashOf(sourceId)!;
    let team = this.#teams.get(hash);
    if (!team) {
      const server = this.servers.find((entry) => entry.serverHash === hash);
      team = new TeamConnection(hash, server?.activeMemberId ?? null);
      team.onIdentityChanged(() => {
        this.#connectAttempted.delete(hash);
        this.#onlineNotified.delete(hash);
        this.#refreshGeneration += 1;
        this.#teamsRevision += 1;
        this.#notifySourcesChanged();
        // The identity change discarded any in-flight api.list; a replacement
        // refresh keeps the server list from being lost until the next change.
        this.#scheduleRefresh();
      });
      this.#teams.set(hash, team);
      this.#teamsRevision += 1;
    }
    return team;
  }

  /** 平台清单里某服务器的条目（设置卡直接消费；无清单为 null）。 */
  serverOf(serverHash: string): TeamServerEntry | null {
    return this.servers.find((entry) => entry.serverHash === serverHash) ?? null;
  }

  /** 用户动作（开融合开关 / 重试）：显式请求连接。 */
  async requestConnect(serverHash: string): Promise<void> {
    if (this.#api === null) return;
    await this.#api.connect({ serverHash });
    await this.#refresh();
  }

  /** 用户动作（关融合开关）：断开（服务器配置保留）。 */
  async requestDisconnect(serverHash: string): Promise<void> {
    if (this.#api === null) return;
    await this.#api.disconnect({ serverHash });
    this.#refreshGeneration += 1;
    this.get(teamSourceId(serverHash)).markOffline(false);
    await this.#refresh();
  }

  /** 平台侧增删改（设置卡）：改完立即刷新清单。 */
  async refreshServers(): Promise<void> {
    await this.#refresh();
  }

  /** 来源清单 / 连接集合变化的通知（stores 接线：新来源出现时补订阅与首拉）。 */
  onSourcesChanged(callback: () => void): () => void {
    this.#sourcesListeners.add(callback);
    return () => this.#sourcesListeners.delete(callback);
  }

  /**
   * 真·在线边沿订阅：平台 WS connected **且** 数据面端口就绪时触发一次；断开
   * （任一条件丢失）后重新武装，重连成功再触发。
   *
   * 与 `onConnected` 的差别：桥在建连接时先把端口交付给渲染层、WS 在后台握手
   * （team-bridge 的 outboundQueue 兜底排队），所以端口就绪 ≠ 服务器可达——
   * 「服务器没起来也弹框」就是把它当在线用导致的。需要对端真正在线才能成功的
   * 一次性动作（如画像启动同步）用本事件；数据面订阅 / 首拉仍用 `onConnected`。
   *
   * 服务器移除时监听保留（来源重加后原订阅继续有效，调用方按 hash 自行去重）。
   */
  onTeamOnline(serverHash: string, handler: () => void): () => void {
    let set = this.#onlineListeners.get(serverHash);
    if (set === undefined) {
      // Plain Set: event registry, not UI state.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      set = new Set();
      this.#onlineListeners.set(serverHash, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /** 真·在线判定：平台状态 connected 且该来源的端口数据面就绪。 */
  #isOnline(serverHash: string): boolean {
    return (
      this.#platformStatus.get(serverHash) === 'connected' &&
      this.#teams.get(serverHash)?.status === 'connected'
    );
  }

  /** 上线边沿检查（每次平台状态 / 端口绑定后调用）：就绪且未发过 → 触发一次。 */
  #maybeNotifyOnline(serverHash: string): void {
    if (!this.#isOnline(serverHash)) {
      this.#onlineNotified.delete(serverHash);
      return;
    }
    if (this.#onlineNotified.has(serverHash)) return;
    this.#onlineNotified.add(serverHash);
    const listeners = this.#onlineListeners.get(serverHash);
    if (listeners !== undefined) for (const listener of [...listeners]) listener();
  }

  #notifySourcesChanged(): void {
    for (const listener of this.#sourcesListeners) listener();
  }

  /**
   * 绑定主进程交付的团队端口（生产经 window message；测试直接调本方法注入）。
   */
  attachTeamPort(
    serverHash: string,
    port: MessagePort,
    activeMemberId?: string | null,
  ): void {
    // A new port starts a new transport identity. Lists requested before it must
    // not overwrite the account that the port belongs to.
    this.#refreshGeneration += 1;
    const team = this.get(teamSourceId(serverHash));
    if (team instanceof TeamConnection) {
      const server = this.serverOf(serverHash);
      const memberId =
        activeMemberId === undefined ? (server?.activeMemberId ?? team.memberId) : activeMemberId;
      team.bind(port, memberId);
      // bind 把「端口交付」记成 connected（首连窗口的数据面就绪语义）；但桥对
      // 重试中的连接（connecting / error / unreachable）同样补发端口（窗口重载
      // refreshPorts）——若清单已收敛到 unreachable，这个 connected 没有任何后续
      // onChanged 来校正（稳态不再翻状态），侧栏会永远显示绿点 + 本地缓存名册。
      // 按最近一次平台清单状态把 presence 标签扳回真相；数据面（端口 / RPC）不动。
      const platform = this.#platformStatus.get(serverHash);
      if (platform !== undefined) this.#applyPlatformStatus(team, platform);
      // 端口晚于平台 connected 状态到达（窗口重载时 WS 是活的）：此刻补检在线边沿。
      this.#maybeNotifyOnline(serverHash);
    }
    this.#notifySourcesChanged();
    // attachTeamPort bumps #refreshGeneration, discarding any api.list in flight.
    // Without a replacement the (possibly initial) list would stay empty and the
    // team groups would never appear. Coalesced, so this cannot loop.
    this.#scheduleRefresh();
  }

  /**
   * 平台状态 → 连接状态标签的唯一映射（#refresh 与 attachTeamPort 共用，防两处
   * 漂移）：connected 恢复数据面；connecting / error 标记重连中、unreachable
   * 标记「服务器不可用」（桥复用同一端口）；idle / unauthenticated 才是真断开，
   * 销毁客户端。
   */
  #applyPlatformStatus(team: TeamConnection, status: TeamServerStatus): void {
    if (status === 'connected') {
      team.markConnected();
    } else if (status === 'idle' || status === 'unauthenticated') {
      this.#refreshGeneration += 1;
      team.markOffline(false);
    } else if (status === 'unreachable') {
      team.markUnreachable();
    } else {
      team.markOffline(true);
    }
  }

  /** 测试 /  teardown：拆掉全部团队连接。 */
  reset(): void {
    this.#refreshGeneration += 1;
    this.#refreshQueued = false;
    for (const team of this.#teams.values()) team.markOffline(false);
    this.#teams.clear();
    this.servers = [];
    this.#connectAttempted.clear();
    this.#platformStatus.clear();
    this.#onlineNotified.clear();
    this.#onlineListeners.clear();
    this.#teamsRevision += 1;
    this.#started = false;
    this.#api = null;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('message', this.#onWindowMessage);
    }
    this.#notifySourcesChanged();
  }

  /** A microtask-coalesced refresh that cannot loop (one queued slot). */
  #scheduleRefresh(): void {
    if (this.#refreshQueued || this.#api === null) return;
    this.#refreshQueued = true;
    queueMicrotask(() => {
      this.#refreshQueued = false;
      void this.#refresh();
    });
  }

  async #refresh(): Promise<void> {
    const api = this.#api;
    if (api === null) return;
    const generation = ++this.#refreshGeneration;
    let list: TeamServerEntry[];
    try {
      list = await api.list();
    } catch {
      // 平台暂不可用：保留上次清单（onChanged 会再触发）。
      return;
    }
    if (generation !== this.#refreshGeneration || api !== this.#api) return;
    this.servers = list;
    for (const server of list) {
      this.#platformStatus.set(server.serverHash, server.status);
      const fused = fusionPref().isEnabled(server.serverHash);
      const team = this.#teams.get(server.serverHash);
      if (team !== undefined) {
        team.memberId = server.activeMemberId;
        this.#applyPlatformStatus(team, server.status);
      }
      this.#maybeNotifyOnline(server.serverHash);
      // 融合开着、已登录、还没连：请求一次连接（主进程负责实际的 WS 与重连）。
      if (
        fused &&
        server.activeMemberId !== null &&
        server.status === 'idle' &&
        !this.#connectAttempted.has(server.serverHash)
      ) {
        this.#connectAttempted.add(server.serverHash);
        void api.connect({ serverHash: server.serverHash }).catch(() => undefined);
      }
    }
    // 已移除的服务器：拆连接（在线边沿状态一并失效；监听保留——来源重加后
    // 原订阅继续有效）。
    for (const hash of [...this.#teams.keys()]) {
      if (!list.some((entry) => entry.serverHash === hash)) {
        this.#teams.get(hash)?.markOffline(false);
        this.#teams.delete(hash);
        this.#platformStatus.delete(hash);
        this.#onlineNotified.delete(hash);
        this.#teamsRevision += 1;
      }
    }
    this.#notifySourcesChanged();
  }

  readonly #onWindowMessage = (event: MessageEvent) => {
    const nonce = typeof window !== 'undefined' ? window.kepcup?.portNonce : undefined;
    if (nonce === undefined) return;
    if (isTeamPortMessage(event, window, nonce)) {
      const data = event.data as { serverHash: string; activeMemberId: string | null };
      this.attachTeamPort(data.serverHash, event.ports[0]!, data.activeMemberId);
    }
  };
}

function isWebEndpoint(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { kepcup?: { isWeb?: boolean } }).kepcup?.isWeb === true;
}

export const connections = new ConnectionsRegistry();

import type {
  AppCatalogEntry,
  AppConnectFlowPayload,
  AppConnectionStatusPayload,
  AppConnection,
  AppConnectTarget,
  AppToolView,
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import {
  applyConnectionStatus,
  applyFlowEvent,
  connectionForTarget,
  isTerminalPhase,
  targetKey,
  type FlowView,
} from '$lib/features/apps/connect-flow';

/**
 * 连接应用（D73，docs/design/29-connected-apps.md §5 / §6）的客户端状态：连接
 * 列表（`apps.connections.list`，含自定义 server 的占位连接）+ 交互授权流程
 * （`apps.connect_flow` 事件按 flowId 累积）。设置页与对话内连接卡通过
 * ConnectAppPanel 共用本 store。令牌与客户端密钥从不进入渲染端：手填 client
 * secret 只经 `setClientCredentials` 单向写入，不保存、不回显。
 *
 * 事件可能先于 `apps.connect` 的返回到达：流程一律先按 flowId 入表，`flowIdByTarget`
 * 在 RPC 返回后再挂上目标。
 */
class AppsState {
  connections = $state<AppConnection[]>([]);
  /** 目录（`apps.catalog.list`，仅发行门禁放行的条目；含每条的已连接账号数）。 */
  catalog = $state<AppCatalogEntry[]>([]);
  catalogLoaded = $state(false);
  /** 最近一次目录读取失败的错误文本（null = 无）；目录从未加载成功时界面据此显示重试，而不是一直「正在读取」。 */
  catalogError = $state<string | null>(null);
  /** flowId → 流程视图（终态保留，直到同目标发起新流程或显式清除）。 */
  flows = $state<Record<string, FlowView>>({});
  /** 目标键 → 当前流程 id。 */
  flowIdByTarget = $state<Record<string, string>>({});
  loaded = $state(false);
  /**
   * 连接 id → 工具清单（`apps.connections.tools`，Bot 表单的工具数估计 / 风险提示用）。
   * 查询会连到服务端，所以只按需拉、按连接缓存；该连接状态变化（含 `tools_changed`）时失效。
   */
  toolsByConnection = $state<Record<string, AppToolView[]>>({});
  readonly #toolsInflight = new Map<string, Promise<AppToolView[]>>();
  #started = false;
  #sawReady = false;
  /** flowId → 发起它的目标（`clearFlow` 据此清理）。 */
  readonly #targetByFlow = new Map<string, AppConnectTarget>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#sawReady = core.coreStatus?.status === 'ready';
    core.onEvent('apps.connect_flow', (payload) => {
      this.#onFlowEvent(payload as AppConnectFlowPayload);
    });
    core.onEvent('apps.connection_status', (payload) => {
      const { connectionId, status, removed } = payload as AppConnectionStatusPayload;
      this.invalidateTools(connectionId);
      const next = applyConnectionStatus(this.connections, connectionId, status, removed === true);
      if (next === null) void this.refresh().catch(() => undefined);
      else this.connections = next;
      // 行被删了：目录卡片上的账号数也要跟着变（不等下一次手动刷新）。
      if (removed === true) void this.refreshCatalog().catch(() => undefined);
    });
    // core 重启 / 端口重绑：断连期间的推送已丢失，重拉连接列表。
    core.onEvent('core.status', (payload) => {
      if ((payload as { status?: string }).status !== 'ready') return;
      if (this.#sawReady) void this.refresh().catch(() => undefined);
      this.#sawReady = true;
    });
    void this.refresh().catch(() => undefined);
  }

  #onFlowEvent(payload: AppConnectFlowPayload): void {
    this.flows = applyFlowEvent(this.flows, payload);
    // 终态一律拉最新连接列表与目录：完成 → 新账号 / 标签 / 状态；取消 / 失败 → 首次连接的临时行
    // 已被 core 删掉（`removed` 事件通常先到，这里兜底对齐，不让界面停在旧数据上）。
    if (isTerminalPhase(payload.phase)) {
      if (payload.connectionId !== undefined) this.invalidateTools(payload.connectionId);
      void this.refresh().catch(() => undefined);
    }
  }

  /** 丢弃某连接缓存的工具清单（下次 `connectionTools` 重拉）。 */
  invalidateTools(connectionId: string): void {
    this.#toolsInflight.delete(connectionId);
    if (!(connectionId in this.toolsByConnection)) return;
    const { [connectionId]: _dropped, ...rest } = this.toolsByConnection;
    void _dropped;
    this.toolsByConnection = rest;
  }

  /**
   * 某连接的工具清单（含锁定状态 / 策略 / 是否暴露），按连接缓存、并发去重。
   * 查询失败抛错（调用方按「未知」处理，不要当成 0 个工具）。
   */
  async connectionTools(connectionId: string): Promise<AppToolView[]> {
    const cached = this.toolsByConnection[connectionId];
    if (cached !== undefined) return cached;
    const inflight = this.#toolsInflight.get(connectionId);
    if (inflight !== undefined) return inflight;
    const request = (async () => {
      try {
        const { tools } = (await core.call('apps.connections.tools', { connectionId })) as {
          tools: AppToolView[];
        };
        this.toolsByConnection = { ...this.toolsByConnection, [connectionId]: tools };
        return tools;
      } finally {
        this.#toolsInflight.delete(connectionId);
      }
    })();
    this.#toolsInflight.set(connectionId, request);
    return request;
  }

  /**
   * 拉取连接列表（含自定义 server 的占位连接 `custom:{serverId}`）与目录（条目带已连接
   * 账号数，随连接变化一起刷新）。
   */
  async refresh(): Promise<void> {
    try {
      const { connections } = (await core.call('apps.connections.list', {
        includeCustom: true,
      })) as { connections: AppConnection[] };
      this.connections = connections;
      this.loaded = true;
    } finally {
      // 连接列表读失败也要读目录：目录与连接列表互不依赖，别让前者拖住后者的加载态。
      await this.refreshCatalog().catch(() => undefined);
    }
  }

  async refreshCatalog(): Promise<void> {
    if (!this.catalogLoaded) this.catalogError = null;
    try {
      const { entries } = (await core.call('apps.catalog.list')) as {
        entries: AppCatalogEntry[];
      };
      this.catalog = entries;
      this.catalogLoaded = true;
      this.catalogError = null;
    } catch (error) {
      this.catalogError =
        error instanceof Error && error.message.length > 0 ? error.message : String(error);
      throw error;
    }
  }

  /** 目录条目（断开后残留的连接可能查不到 → null）。 */
  entryFor(connectorId: string): AppCatalogEntry | null {
    return this.catalog.find((entry) => entry.connectorId === connectorId) ?? null;
  }

  connectionFor(target: AppConnectTarget): AppConnection | null {
    return connectionForTarget(this.connections, target);
  }

  /** 目标当前的流程（含刚结束的终态）；无则 null。 */
  flowFor(target: AppConnectTarget): FlowView | null {
    const flowId = this.flowIdByTarget[targetKey(target)];
    return flowId === undefined ? null : (this.flows[flowId] ?? null);
  }

  /** 目标有进行中（非终态）的流程。 */
  hasActiveFlow(target: AppConnectTarget): boolean {
    const flow = this.flowFor(target);
    return flow !== null && !isTerminalPhase(flow.phase);
  }

  /**
   * 发起连接（`apps.connect`）。同一目标并发调用 core 会返回同一 flowId（后到的
   * `grantBotId` 不生效——群聊里第二张卡片完成后自行补写 Profile，见
   * ConnectAppSetupBody）；这里把该 flowId 挂到目标上。`connectionId` = 重新授权
   * 既有的目录连接（过期 / 追加权限）而不是新建账号。返回 flowId，供面板追踪。
   */
  async connect(
    target: AppConnectTarget,
    options: { scopes?: string[]; grantBotId?: string; connectionId?: string } = {},
  ): Promise<string> {
    const { flowId } = (await core.call('apps.connect', {
      target,
      ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
      ...(options.grantBotId !== undefined ? { grantBotId: options.grantBotId } : {}),
      ...(options.connectionId !== undefined ? { connectionId: options.connectionId } : {}),
    })) as { flowId: string };
    this.#targetByFlow.set(flowId, target);
    this.flowIdByTarget = { ...this.flowIdByTarget, [targetKey(target)]: flowId };
    return flowId;
  }

  /** `awaiting_consent` 下用户核对授权域名后继续：core 经主进程打开系统浏览器。 */
  async continueFlow(flowId: string): Promise<void> {
    await core.call('apps.connect.continue', { flowId });
  }

  async cancel(flowId: string): Promise<void> {
    await core.call('apps.connect.cancel', { flowId });
  }

  /** `reviewing_tools` 下用户确认工具清单：core 批准全部待复核工具 → `connected` → `done`。 */
  async confirmTools(flowId: string, acknowledgeCommunity = false): Promise<void> {
    await core.call('apps.connect.confirmTools', {
      flowId,
      ...(acknowledgeCommunity ? { acknowledgeCommunity: true } : {}),
    });
  }

  /** 收起目标的流程提示（终态的失败 / 取消卡片）。 */
  clearFlow(target: AppConnectTarget): void {
    const key = targetKey(target);
    const flowId = this.flowIdByTarget[key];
    if (flowId === undefined) return;
    const { [key]: _removed, ...rest } = this.flowIdByTarget;
    void _removed;
    this.flowIdByTarget = rest;
    const { [flowId]: _flow, ...flows } = this.flows;
    void _flow;
    this.flows = flows;
    this.#targetByFlow.delete(flowId);
  }

  /** 断开连接（吊销 + 清令牌）；状态变化由 `apps.connection_status` / 刷新带回。 */
  async disconnect(connectionId: string): Promise<void> {
    await core.call('apps.disconnect', { connectionId });
    await this.refresh().catch(() => undefined);
  }

  /**
   * `OAUTH_CLIENT_REQUIRED` 失败后手填客户端：flowId 定位 issuer；secret 只写不读，
   * 调用后调用方应立刻清空输入。core 保存后在**同一条流程**上自行续跑（发出
   * `discovering` 事件），无需再次 `apps.connect`；返回同一 flowId 供面板继续追踪。
   */
  async setClientCredentials(
    flowId: string,
    clientId: string,
    clientSecret?: string,
  ): Promise<string> {
    await core.call('apps.setClientCredentials', {
      flowId,
      clientId,
      ...(clientSecret !== undefined && clientSecret.length > 0 ? { clientSecret } : {}),
    });
    return flowId;
  }
}

export const appsStore = new AppsState();

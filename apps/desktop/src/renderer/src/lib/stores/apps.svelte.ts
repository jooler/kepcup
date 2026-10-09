import type {
  AppConnectFlowPayload,
  AppConnectionStatusPayload,
  AppConnection,
  AppConnectTarget,
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
  /** flowId → 流程视图（终态保留，直到同目标发起新流程或显式清除）。 */
  flows = $state<Record<string, FlowView>>({});
  /** 目标键 → 当前流程 id。 */
  flowIdByTarget = $state<Record<string, string>>({});
  loaded = $state(false);
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
      const { connectionId, status } = payload as AppConnectionStatusPayload;
      const next = applyConnectionStatus(this.connections, connectionId, status);
      if (next === null) void this.refresh().catch(() => undefined);
      else this.connections = next;
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
    // 完成：拉最新连接列表（账号标签 / scope / 状态）。失败 / 取消：连接状态不变。
    if (payload.phase === 'done') void this.refresh().catch(() => undefined);
  }

  /** 拉取连接列表（含自定义 server 的占位连接 `custom:{serverId}`）。 */
  async refresh(): Promise<void> {
    const { connections } = (await core.call('apps.connections.list', {
      includeCustom: true,
    })) as { connections: AppConnection[] };
    this.connections = connections;
    this.loaded = true;
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
   * 发起连接（`apps.connect`）。同一目标并发调用 core 会返回同一 flowId；这里把
   * 该 flowId 挂到目标上。返回 flowId，供面板追踪。
   */
  async connect(
    target: AppConnectTarget,
    options: { scopes?: string[]; grantBotId?: string } = {},
  ): Promise<string> {
    const { flowId } = (await core.call('apps.connect', {
      target,
      ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
      ...(options.grantBotId !== undefined ? { grantBotId: options.grantBotId } : {}),
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

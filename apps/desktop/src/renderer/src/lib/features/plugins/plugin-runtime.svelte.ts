import type { PluginRuntimePluginState, PluginsRuntimeListOutput } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 执行型插件的运行状态（D125 P3，61 §6）：`plugins.runtime.list` 的初始快照 +
 * `plugin.runtime` 事件的增量更新。
 *
 * - 只有 manifest 含 `runtime` 段的插件会出现在快照里（core 侧过滤）——**非执行型
 *   插件没有任何条目**，插件卡据此不渲染状态徽标与活动入口（数据型路径零变化）。
 * - 事件只携带 `{pluginId, status, detail?}`；调用历史（recent）由 list 提供，事件
 *   到达时保留旧历史，只换状态。
 * - 初始拉取与事件并发时以事件为准（按单调序号判定，避免慢响应把新状态写回旧值）。
 * - 运行时未装配（headless / 测试夹具 / 旧 core）时 list 抛 NOT_IMPLEMENTED：记
 *   loadError 但不打扰用户（徽标不出现，等同非执行型）。
 */
class PluginRuntimeState {
  /** pluginId → 状态行（只含执行型插件）。 */
  states = $state<Record<string, PluginRuntimePluginState>>({});
  /** 最近一次拉取失败的错误文本（null = 正常）；UI 不强制展示。 */
  loadError = $state<string | null>(null);
  loading = $state(false);
  #started = false;
  #loaded = false;
  /** 非强制拉取去重（start 可能被多个组件同时调用）。 */
  #inflight: Promise<void> | null = null;
  /** 拉取序号：只有最新一次拉取的响应可以写入（force 拉取可并发）。 */
  #loadId = 0;
  /** 单调序号：事件 +1，list 拉取开始时取快照，用于并发合并。 */
  #seq = 0;
  /** pluginId → 最近一次事件序号（> 拉取开始序号 = 事件更新鲜）。 */
  #eventAt = new Map<string, number>();

  start(): void {
    if (!this.#started) {
      this.#started = true;
      core.onEvent('plugin.runtime', (payload) => {
        this.#applyEvent(payload as { pluginId: string; status: string; detail?: string });
      });
      // 安装 / 卸载 / 启停会增删执行型插件（uninstall → forget 清掉状态行）。
      core.onEvent('plugins.changed', () => {
        void this.load(true);
      });
    }
    // 每次 start（组件挂载 / 登出后重新进入）都确保有一次初始快照；已拉到则 no-op。
    void this.load();
  }

  async load(force = false): Promise<void> {
    if (!force && this.#loaded) return;
    if (!force && this.#inflight !== null) return this.#inflight;
    const run = this.#load().finally(() => {
      if (this.#inflight === run) this.#inflight = null;
    });
    this.#inflight = run;
    return run;
  }

  async #load(): Promise<void> {
    const loadId = ++this.#loadId;
    const startedAt = this.#seq;
    this.loading = true;
    try {
      const result = (await core.call(
        'plugins.runtime.list',
        undefined,
      )) as PluginsRuntimeListOutput;
      // 更晚发起的拉取已经发出：这份响应可能比它旧，丢弃（否则慢的旧响应会把
      // 新状态写回旧值）。
      if (loadId !== this.#loadId) return;
      const next: Record<string, PluginRuntimePluginState> = {};
      for (const row of result.plugins) {
        const current = this.states[row.pluginId];
        // 拉取在途期间到达的事件更新鲜：保留事件给出的状态字段，历史 / 最近错误
        // 仍用服务端快照（事件不带历史）。
        if (current !== undefined && (this.#eventAt.get(row.pluginId) ?? 0) > startedAt) {
          next[row.pluginId] = {
            ...row,
            status: current.status,
            detail: current.detail,
            // 最近事件是 error 时事件详情更新鲜；否则服务端快照里的最近失败更新鲜
            // （状态事件不携带调用历史，lastError 可能比事件更晚）。
            lastError:
              current.status === 'error'
                ? (current.lastError ?? row.lastError)
                : (row.lastError ?? current.lastError),
          };
        } else {
          next[row.pluginId] = row;
        }
      }
      this.states = next;
      this.loadError = null;
      this.#loaded = true;
    } catch (error) {
      if (loadId !== this.#loadId) return;
      console.error('[plugin-runtime] load failed', error);
      this.loadError =
        error instanceof Error && error.message.length > 0 ? error.message : String(error);
    } finally {
      // 旧响应不得关掉最新一次拉取的 loading 状态。
      if (loadId === this.#loadId) this.loading = false;
    }
  }

  /** `plugins.runtime.restart`：终止并重新拉起进程，成功后徽标回 ready。 */
  async restart(pluginId: string): Promise<void> {
    await core.call('plugins.runtime.restart', { pluginId });
    await this.load(true);
  }

  /** 一个插件的运行状态；非执行型插件 / 尚未拉到 = null（不渲染徽标）。 */
  stateOf(pluginId: string): PluginRuntimePluginState | null {
    return this.states[pluginId] ?? null;
  }

  /** 是否执行型插件（运行时快照里有这一行）。 */
  isExecuting(pluginId: string): boolean {
    return this.states[pluginId] !== undefined;
  }

  /** 登出 / 端点切换等整页复位。 */
  reset(): void {
    // 使在途拉取失效：旧端点的响应不得写进复位后的 store。
    this.#loadId += 1;
    this.states = {};
    this.loadError = null;
    this.loading = false;
    this.#loaded = false;
    this.#inflight = null;
    this.#eventAt.clear();
  }

  #applyEvent(payload: { pluginId: string; status: string; detail?: string }): void {
    const pluginId = payload.pluginId;
    if (typeof pluginId !== 'string' || pluginId.length === 0) return;
    const status = payload.status as PluginRuntimePluginState['status'];
    const current = this.states[pluginId];
    const detail = payload.detail ?? null;
    this.states = {
      ...this.states,
      [pluginId]: {
        pluginId,
        status,
        detail,
        // 与 core 的 lastError 语义一致：error 状态的原因文本覆盖；其它状态保留上次错误。
        lastError:
          status === 'error'
            ? (detail ?? current?.lastError ?? null)
            : (current?.lastError ?? null),
        recent: current?.recent ?? [],
      },
    };
    this.#eventAt.set(pluginId, ++this.#seq);
  }
}

export const pluginRuntime = new PluginRuntimeState();

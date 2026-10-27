import type {
  PluginInspectOutput,
  PluginMarketEntry,
  PluginMarketStatus,
  McpbUserConfigValue,
  PluginSummary,
} from '@kepcup/shared';
import { SvelteSet } from 'svelte/reactivity';
import { core } from '$lib/rpc/client.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';
import { appsStore } from '$lib/stores/apps.svelte';

/**
 * 已安装插件（D104 P0a-3）的全局状态：`plugins.list` 的快照 + 启停 / 卸载的在途标记。
 * 安装、启停、卸载都会改动投影出去的技能 / MCP / 连接目录，`afterMutation()` 统一刷新
 * 受影响的 store（技能列表由既有的 `skills.changed` 事件刷新，不在这里手动拉）。
 */
class PluginsState {
  plugins = $state<PluginSummary[]>([]);
  /** 市场视图（D104 P1-3）：条目 + 同步状态；未启用市场时 status.state === 'disabled'。 */
  market = $state<PluginMarketEntry[]>([]);
  marketStatus = $state<PluginMarketStatus | null>(null);
  marketLoading = $state(false);
  /** 最近一次市场视图加载失败的错误文本（null = 正常）；与已安装列表的 loadError 分开。 */
  marketError = $state<string | null>(null);
  loading = $state(false);
  /** 最近一次列表加载失败的错误文本（null = 正常）；页面据此区分「空列表」与「加载失败」。 */
  loadError = $state<string | null>(null);
  /** 正在启停 / 卸载的插件 id（行内按钮禁用）。 */
  busy = new SvelteSet<string>();
  #loaded = false;
  #marketLoaded = false;
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('plugins.changed', () => {
      void this.load(true);
    });
    // 采纳新索引后市场视图与「已安装」的 updateAvailable / revoked 都要重拉。
    core.onEvent('plugins.marketplace.updated', () => {
      void this.loadMarket(true);
      void this.load(true);
    });
  }

  async load(force = false): Promise<void> {
    if (!force && this.#loaded) return;
    this.loading = true;
    try {
      const result = (await core.call('plugins.list', undefined)) as {
        plugins: PluginSummary[];
      };
      this.plugins = result.plugins;
      this.loadError = null;
      this.#loaded = true;
    } catch (error) {
      // 调用方多是 `void load()`：不吞成未处理的 rejection，记录并透出。
      console.error('[plugins] load failed', error);
      this.loadError =
        error instanceof Error && error.message.length > 0 ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  async loadMarket(force = false): Promise<void> {
    if (!force && this.#marketLoaded) return;
    this.marketLoading = true;
    try {
      const result = (await core.call('plugins.marketplace.list', undefined)) as {
        status: PluginMarketStatus;
        entries: PluginMarketEntry[];
      };
      this.market = result.entries;
      this.marketStatus = result.status;
      this.marketError = null;
      this.#marketLoaded = true;
    } catch (error) {
      console.error('[plugins] market load failed', error);
      this.marketError =
        error instanceof Error && error.message.length > 0 ? error.message : String(error);
    } finally {
      this.marketLoading = false;
    }
  }

  /** 手动同步索引（「刷新」/「检查更新」）：拉取后重载市场与已安装列表。 */
  async refreshMarket(): Promise<void> {
    this.marketLoading = true;
    try {
      const result = (await core.call('plugins.marketplace.refresh', undefined)) as {
        status: PluginMarketStatus;
      };
      this.marketStatus = result.status;
      await this.loadMarket(true);
      await this.load(true);
    } finally {
      this.marketLoading = false;
    }
  }

  /**
   * 「全部更新」：对每个有更新的插件检视一次，只有**无需额外确认**的（可安装、权限未扩大、
   * 无必填配置缺失）才直接更新；其余留给用户逐个处理（返回 skipped 计数）。
   */
  async updateAll(): Promise<{ done: number; skipped: number }> {
    let done = 0;
    let skipped = 0;
    for (const plugin of this.plugins.filter((item) => item.updateAvailable !== null)) {
      try {
        const info = (await core.call('plugins.inspect', {
          source: { kind: 'marketplace', id: plugin.id },
        })) as PluginInspectOutput;
        // 权限扩大、需要填配置（含只带可选字段的 MCPB：非敏感值不会被保留，直接更新
        // 会把用户改过的可选配置静默换回默认值）时，用户必须逐个确认。
        const needsInput = info.mcp.some(
          (item) => item.kind === 'mcpb' && item.userConfigFields.length > 0,
        );
        if (!info.installable || info.update?.permissionsExpanded === true || needsInput) {
          skipped += 1;
          continue;
        }
        const userConfig: Record<string, Record<string, McpbUserConfigValue>> = {};
        for (const item of info.mcp) {
          if (item.kind === 'mcpb') userConfig[item.id] = {};
        }
        await core.call('plugins.update', {
          id: plugin.id,
          sha256: info.packageSha256,
          userConfig,
          acknowledgeDiff: false,
        });
        done += 1;
      } catch (error) {
        console.error('[plugins] update failed', plugin.id, error);
        skipped += 1;
      }
    }
    await this.afterMutation();
    return { done, skipped };
  }

  /** 插件展示名；找不到（并发卸载后）时回退为 id。 */
  nameOf(id: string): string {
    return this.plugins.find((plugin) => plugin.id === id)?.name ?? id;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.busy.add(id);
    try {
      await core.call('plugins.setEnabled', { id, enabled });
      await this.afterMutation();
    } finally {
      this.busy.delete(id);
    }
  }

  async uninstall(id: string): Promise<void> {
    this.busy.add(id);
    try {
      await core.call('plugins.uninstall', { id });
      await this.afterMutation();
    } finally {
      this.busy.delete(id);
    }
  }

  /** 安装 / 启停 / 卸载成功后刷新受影响的 store：插件列表、市场视图、MCP server（settings）、连接目录。 */
  async afterMutation(): Promise<void> {
    await this.load(true);
    // 市场条目自带 installed / updateAvailable 结论：安装、更新、停用后都要重拉，
    // 否则市场卡会停在「安装」按钮上（D104 P1-3）。
    await this.loadMarket(true);
    await settingsStore.refresh();
    void appsStore.refresh().catch(() => undefined);
  }

  /** 登出 / 端点切换等整页复位。 */
  reset(): void {
    this.plugins = [];
    this.market = [];
    this.marketStatus = null;
    this.marketError = null;
    this.loadError = null;
    this.#loaded = false;
    this.#marketLoaded = false;
  }
}

export const plugins = new PluginsState();

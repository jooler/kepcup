import type { PluginSummary } from '@kepcup/shared';
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
  loading = $state(false);
  /** 最近一次列表加载失败的错误文本（null = 正常）；页面据此区分「空列表」与「加载失败」。 */
  loadError = $state<string | null>(null);
  /** 正在启停 / 卸载的插件 id（行内按钮禁用）。 */
  busy = new SvelteSet<string>();
  #loaded = false;
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('plugins.changed', () => {
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

  /** 安装 / 启停 / 卸载成功后刷新受影响的 store：插件列表、MCP server（settings）、连接目录。 */
  async afterMutation(): Promise<void> {
    await this.load(true);
    await settingsStore.refresh();
    void appsStore.refresh().catch(() => undefined);
  }

  /** 登出 / 端点切换等整页复位。 */
  reset(): void {
    this.plugins = [];
    this.loadError = null;
    this.#loaded = false;
  }
}

export const plugins = new PluginsState();

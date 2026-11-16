import type { PluginCapabilityEntryGroup } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 已装能力模型插件的条目视图（D124，`plugins.listCapabilityEntries`）：按插件
 * 分组的条目清单（能力 / 模型 / 引擎 / 实例配置状态）。三处共用——Bot 详情
 * 「插件」区块的条目勾选、插件详情「模型条目」区、设置页能力槽位的「插件提供」
 * 行。随 `plugins.changed` 重拉（安装 / 卸载 / 实例增删都会改配置状态）。
 * 「测试连接」的在途标记由各调用方自持（插件详情按行、实例表单按表单）。
 */
class CapabilityEntriesState {
  groups = $state<PluginCapabilityEntryGroup[]>([]);
  loading = $state(false);
  /** 最近一次加载失败的错误文本（null = 正常）；调用方多是 `void load()`。 */
  loadError = $state<string | null>(null);
  /**
   * 是否已成功拉到过条目清单（D125 收口审查）：Bot 条目勾选用它判定「已知条目集合」
   * 可信——未加载 / 加载失败时不能把 profile 里的引用当成「条目已被移除」剪掉。
   */
  loaded = $state(false);
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('plugins.changed', () => {
      void this.load(true);
    });
  }

  async load(force = false): Promise<void> {
    if (!force && this.loaded) return;
    this.loading = true;
    try {
      const result = (await core.call('plugins.listCapabilityEntries', undefined)) as {
        plugins: PluginCapabilityEntryGroup[];
      };
      this.groups = result.plugins;
      this.loadError = null;
      this.loaded = true;
    } catch (error) {
      console.error('[capability-entries] load failed', error);
      this.loadError =
        error instanceof Error && error.message.length > 0 ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  /** 某插件的条目（未装 / 未声明条目 = 空数组）。 */
  entriesOf(pluginId: string): PluginCapabilityEntryGroup['entries'] {
    return this.groups.find((group) => group.pluginId === pluginId)?.entries ?? [];
  }

  /** 插件名（用于 Bot 侧灰行 / 设置页入口文案；找不到回退 id）。 */
  pluginNameOf(pluginId: string): string {
    return this.groups.find((group) => group.pluginId === pluginId)?.pluginName ?? pluginId;
  }

  /** 某能力的条目总数（设置页「插件提供 · N 个模型」）。 */
  countByCapability(capability: string): number {
    return this.groups.reduce(
      (sum, group) => sum + group.entries.filter((entry) => entry.capability === capability).length,
      0,
    );
  }

  /** 提供某能力条目的插件 id（保持分组序；设置页 deepLink 取首个）。 */
  pluginIdsOf(capability: string): string[] {
    return this.groups
      .filter((group) => group.entries.some((entry) => entry.capability === capability))
      .map((group) => group.pluginId);
  }

  /** 测试连接的行内标记键（条目行唯一）。 */
  testKey(pluginId: string, entryId: string): string {
    return `${pluginId}/${entryId}`;
  }

  reset(): void {
    this.groups = [];
    this.loadError = null;
    this.loaded = false;
  }
}

export const capabilityEntries = new CapabilityEntriesState();

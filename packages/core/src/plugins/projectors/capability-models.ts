import type { CapabilityModelEntry } from '@kepcup/shared';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjectionContext,
  PluginProjector,
  ProjectorInspection,
} from './index.js';

/**
 * 能力模型条目投影器（D124，60 号文档 §2）：条目是纯数据声明——projector 只记账
 * 本行（plugin_items kind 'capability-model'，ref = 条目 id，卸载可回滚）与同意
 * 视图。运行时消费不经投影器：MediaService 经注入的条目仓库（media-entry-source）
 * 读已装清单；实例由 kind 的 materializer（`plugins/materializers/capability-model.ts`）
 * 落地，引擎校验（PLUGIN_ENGINE_UNKNOWN）在注册表安装管线做。
 */

export class CapabilityModelsProjector implements PluginProjector<CapabilityModelEntry> {
  readonly kind = 'capability-model' as const;

  async inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<CapabilityModelEntry>> {
    // The manifest schema rejects duplicate entry ids already; carry the entries as the
    // consent view items (label / model / engine for the confirm dialog).
    return {
      items: [...(ctx.manifest.contributions.capabilityModels ?? [])],
      conflicts: [],
      blockers: [],
    };
  }

  async project(ctx: PluginProjectionContext): Promise<void> {
    for (const entry of ctx.manifest.contributions.capabilityModels ?? []) {
      ctx.ledger.add('capability-model', entry.id);
    }
  }

  /** Update: the ledger IS the projection — sync adds and removals only. */
  async update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void> {
    for (const entry of newCtx.manifest.contributions.capabilityModels ?? []) {
      newCtx.ledger.add('capability-model', entry.id);
    }
    const kept = new Set(
      (newCtx.manifest.contributions.capabilityModels ?? []).map((entry) => entry.id),
    );
    for (const entry of oldCtx.manifest.contributions.capabilityModels ?? []) {
      if (kept.has(entry.id)) continue;
      oldCtx.ledger.remove('capability-model', entry.id);
    }
  }

  async unproject(
    plugin: PluginIdentity,
    refs: readonly string[],
    ledger: PluginLedger,
  ): Promise<void> {
    void plugin;
    for (const id of refs) ledger.remove('capability-model', id);
  }

  async setEnabled(
    ctx: PluginProjectionContext,
    refs: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    // 条目是数据，无运行时状态可开关（可见性 = 插件级 enabled + Bot 勾选集）。
    void ctx;
    void refs;
    void enabled;
  }
}

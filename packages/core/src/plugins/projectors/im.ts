import type { PluginConflict, PluginConsentIm } from '@kepcup/shared';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjectionContext,
  PluginProjector,
  ProjectorInspection,
} from './index.js';

/**
 * IM projector（D107，54 号文档 §2.3）：一个 im 贡献是该插件 IM 实例的供给规范
 * （transport / 端点 / 建号方式 / 能力面）——projector 只记账本行与同意视图。
 * 账号由 kind 的 materializer（`plugins/materializers/im.ts`）落地，运行时零状态。
 */

export class ImProjector implements PluginProjector<PluginConsentIm> {
  readonly kind = 'im' as const;

  async inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<PluginConsentIm>> {
    const items: PluginConsentIm[] = [];
    const conflicts: PluginConflict[] = [];
    const blockers: string[] = [];
    const seen = new Set<string>();
    for (const contribution of ctx.manifest.contributions.im) {
      if (seen.has(contribution.id)) {
        // The manifest schema rejects duplicates already; this is a cheap invariant.
        blockers.push(`包内有重复的 IM 贡献 id「${contribution.id}」`);
        continue;
      }
      seen.add(contribution.id);
      let apiHost = contribution.apiBase;
      try {
        apiHost = new URL(contribution.apiBase).host;
      } catch {
        // schema 已保证 https URL；这里只是投影稳健性。
      }
      items.push({
        id: contribution.id,
        label: contribution.label,
        transport: contribution.transport,
        apiHost,
        inbound: contribution.features.inbound,
        outbound: contribution.features.outbound,
      });
    }
    return { items, conflicts, blockers };
  }

  async project(ctx: PluginProjectionContext): Promise<void> {
    for (const contribution of ctx.manifest.contributions.im) {
      ctx.ledger.add('im', contribution.id);
    }
  }

  /** Update: the ledger IS the projection — sync adds and removals only. */
  async update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void> {
    for (const contribution of newCtx.manifest.contributions.im) {
      newCtx.ledger.add('im', contribution.id);
    }
    const kept = new Set(newCtx.manifest.contributions.im.map((contribution) => contribution.id));
    for (const contribution of oldCtx.manifest.contributions.im) {
      if (kept.has(contribution.id)) continue;
      oldCtx.ledger.remove('im', contribution.id);
    }
  }

  async unproject(
    plugin: PluginIdentity,
    refs: readonly string[],
    ledger: PluginLedger,
  ): Promise<void> {
    void plugin;
    for (const id of refs) ledger.remove('im', id);
  }

  async setEnabled(
    ctx: PluginProjectionContext,
    refs: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    // The contribution spec is read per-listing from installed+enabled manifests;
    // instances follow the P2 injection model (plugin-level enablement). Nothing to toggle.
    void ctx;
    void refs;
    void enabled;
  }
}

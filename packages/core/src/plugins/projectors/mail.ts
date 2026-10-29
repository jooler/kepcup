import type { PluginConflict, PluginConsentMail } from '@kepcup/shared';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjectionContext,
  PluginProjector,
  ProjectorInspection,
} from './index.js';

/**
 * Mail projector (D104 P0a-2; P3 semantic shift): a mail contribution is the
 * provisioning spec of the plugin's mail instances (defaults + locked endpoints) —
 * the projector only keeps the ledger row and the consent view. Accounts are landed
 * by the kind's materializer (`plugins/materializers/mail.ts`), so there is no runtime
 * state to hide on `setEnabled` and no template concept to conflict-check anymore
 * (the D104 vendor-preset overlay died with `MAIL_PROVIDER_PRESETS` in P3).
 */

export class MailProjector implements PluginProjector<PluginConsentMail> {
  readonly kind = 'mail' as const;

  async inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<PluginConsentMail>> {
    const items: PluginConsentMail[] = [];
    const conflicts: PluginConflict[] = [];
    const blockers: string[] = [];
    const seen = new Set<string>();
    for (const template of ctx.manifest.contributions.mail) {
      if (seen.has(template.id)) {
        // The manifest schema rejects duplicates already; this is a cheap invariant.
        blockers.push(`包内有重复的邮件贡献 id「${template.id}」`);
        continue;
      }
      seen.add(template.id);
      items.push({
        id: template.id,
        label: template.label,
        imapHost: template.imap.host,
        smtpHost: template.smtp.host,
      });
    }
    return { items, conflicts, blockers };
  }

  async project(ctx: PluginProjectionContext): Promise<void> {
    for (const template of ctx.manifest.contributions.mail) {
      ctx.ledger.add('mail', template.id);
    }
  }

  /** Update: the ledger IS the projection — sync adds and removals only. */
  async update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void> {
    for (const template of newCtx.manifest.contributions.mail) {
      newCtx.ledger.add('mail', template.id);
    }
    const kept = new Set(newCtx.manifest.contributions.mail.map((template) => template.id));
    for (const template of oldCtx.manifest.contributions.mail) {
      if (kept.has(template.id)) continue;
      oldCtx.ledger.remove('mail', template.id);
    }
  }

  async unproject(
    plugin: PluginIdentity,
    refs: readonly string[],
    ledger: PluginLedger,
  ): Promise<void> {
    void plugin;
    for (const id of refs) ledger.remove('mail', id);
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

import type { PluginConflict, PluginConsentMail } from '@kepcup/shared';
import { mailProviderSchema } from '@kepcup/shared';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjectionContext,
  PluginProjector,
  ProjectorInspection,
} from './index.js';

/**
 * Mail projector (D104 P0a-2 步骤 7, registry-only in P0a): a mail contribution only
 * gets a ledger row — P1 serves the templates as a runtime overlay read from the
 * installed+enabled manifests, and the add-mailbox form just pre-fills from them.
 * No runtime state exists here, so there is nothing to hide on `setEnabled` and
 * nothing to miss.
 */

export interface MailProjectorDeps {
  /** Reserved template ids: the code-shipped vendor presets (Q2, stays in code). */
  builtinIds?: readonly string[] | undefined;
}

export class MailProjector implements PluginProjector<PluginConsentMail> {
  readonly kind = 'mail' as const;
  readonly #builtinIds: ReadonlySet<string>;

  constructor(deps: MailProjectorDeps = {}) {
    this.#builtinIds = new Set(deps.builtinIds ?? mailProviderSchema.options);
  }

  async inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<PluginConsentMail>> {
    const items: PluginConsentMail[] = [];
    const conflicts: PluginConflict[] = [];
    const blockers: string[] = [];
    const seen = new Set<string>();
    for (const template of ctx.manifest.contributions.mail) {
      if (seen.has(template.id)) {
        blockers.push(`包内有重复的邮件模板 id「${template.id}」`);
        continue;
      }
      seen.add(template.id);
      if (this.#builtinIds.has(template.id as never)) {
        conflicts.push({
          kind: 'mail',
          ref: template.id,
          withWhat: '与内置邮件厂商模板同名',
        });
        continue;
      }
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
    // Registry-only: the ledger row is the whole projection in P0a.
    for (const template of ctx.manifest.contributions.mail) {
      ctx.ledger.add('mail', template.id);
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
    // Templates are read per-listing from installed+enabled manifests; nothing to toggle.
    void ctx;
    void refs;
    void enabled;
  }
}

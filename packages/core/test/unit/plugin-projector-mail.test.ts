import { describe, expect, it } from 'vitest';
import { pluginManifestSchema, type PluginManifest } from '@kepcup/shared';

import { MailProjector } from '../../src/plugins/projectors/mail.js';
import {
  emptyOwned,
  type PluginIdentity,
  type PluginLedger,
  type PluginItemKind,
} from '../../src/plugins/projectors/index.js';

/**
 * 邮件投影器（D104 P0a-2 步骤 7，登记型）：inspect 的内置厂商冲突与包内重复，
 * project / unproject 只动账本，setEnabled 空操作。
 */

const identity: PluginIdentity = {
  id: 'io.github.tester/mail',
  version: '1.0.0',
  origin: 'local',
  tier: 'developer',
};

class MemLedger implements PluginLedger {
  readonly #items = new Map<PluginItemKind, string[]>();
  add(kind: PluginItemKind, ref: string): void {
    const list = this.#items.get(kind) ?? [];
    if (!list.includes(ref)) list.push(ref);
    this.#items.set(kind, list);
  }
  remove(kind: PluginItemKind, ref: string): void {
    this.#items.set(
      kind,
      (this.#items.get(kind) ?? []).filter((entry) => entry !== ref),
    );
  }
  list(kind: PluginItemKind): string[] {
    return [...(this.#items.get(kind) ?? [])];
  }
}

function manifestOf(mailIds: string[]): PluginManifest {
  return pluginManifestSchema.parse({
    format_version: 1,
    id: identity.id,
    name: 'Mail',
    version: '1.0.0',
    contributions: {
      mail: mailIds.map((id) => ({
        id,
        label: `模板 ${id}`,
        imap: { host: `imap.${id}.test`, port: 993, secure: 'ssl' },
        smtp: { host: `smtp.${id}.test`, port: 465, secure: 'ssl' },
      })),
    },
  });
}

function ctx(manifest: ReturnType<typeof manifestOf>) {
  return {
    plugin: identity,
    manifest,
    dir: '/irrelevant',
    userConfig: {},
    ledger: new MemLedger(),
    owned: emptyOwned(),
  };
}

describe('MailProjector（登记型）', () => {
  it('inspect：条目形状齐全；内置厂商 id 冲突；包内重复 → blocker', async () => {
    const projector = new MailProjector();
    const result = await projector.inspect(ctx(manifestOf(['fastmail', 'gmail'])));
    expect(result.items).toEqual([
      {
        id: 'fastmail',
        label: '模板 fastmail',
        imapHost: 'imap.fastmail.test',
        smtpHost: 'smtp.fastmail.test',
      },
    ]);
    expect(result.conflicts).toEqual([
      { kind: 'mail', ref: 'gmail', withWhat: '与内置邮件厂商模板同名' },
    ]);
    expect(result.blockers).toEqual([]);

    // 包内重复：schema 的 superRefine 本会拒绝，这里手工构造绕过校验的清单测兜底路径。
    const duplicate = new MailProjector({ builtinIds: [] });
    const dupManifest = {
      ...manifestOf(['dup']),
      contributions: {
        skills: [],
        connectors: [],
        mcp: [],
        mail: [
          ...manifestOf(['dup']).contributions.mail,
          ...manifestOf(['dup']).contributions.mail,
        ],
      },
    } as PluginManifest; // hand-built: superRefine would reject duplicate ids
    const dupResult = await duplicate.inspect(ctx(dupManifest));
    expect(dupResult.blockers).toHaveLength(1);
    expect(dupResult.blockers[0]).toContain('重复的邮件模板');
  });

  it('project / unproject 只动账本；setEnabled 空操作', async () => {
    const projector = new MailProjector();
    const ledger = new MemLedger();
    const context = { ...ctx(manifestOf(['alpha', 'beta'])), ledger };
    await projector.project(context);
    expect(ledger.list('mail')).toEqual(['alpha', 'beta']);

    await projector.setEnabled(context, ['alpha'], false);
    expect(ledger.list('mail')).toEqual(['alpha', 'beta']); // untouched

    await projector.unproject(identity, ['alpha'], ledger);
    expect(ledger.list('mail')).toEqual(['beta']);
    await projector.unproject(identity, ['alpha'], ledger); // idempotent
    expect(ledger.list('mail')).toEqual(['beta']);
  });
});

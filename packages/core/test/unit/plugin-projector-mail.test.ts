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
 * 邮件投影器（P3 语义）：贡献 = 实例供给规范，投影只记账本 + 同意视图。
 * D104 的内置厂商模板冲突随 `MAIL_PROVIDER_PRESETS` 一起删除；清单 schema 已强制
 * ≤1 个贡献且必须伴随 `instances: ['mail']`。
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

function manifestOf(mailId: string): PluginManifest {
  return pluginManifestSchema.parse({
    format_version: 1,
    id: identity.id,
    name: 'Mail',
    version: '1.0.0',
    instances: ['mail'],
    contributions: {
      mail: [
        {
          id: mailId,
          label: `邮箱 ${mailId}`,
          imap: { host: `imap.${mailId}.test`, port: 993, secure: 'ssl' },
          smtp: { host: `smtp.${mailId}.test`, port: 465, secure: 'ssl' },
        },
      ],
    },
  });
}

function ctx(manifest: PluginManifest) {
  return {
    plugin: identity,
    manifest,
    dir: '/irrelevant',
    userConfig: {},
    ledger: new MemLedger(),
    owned: emptyOwned(),
  };
}

describe('MailProjector（实例供给规范，P3）', () => {
  it('inspect：同意条目带锁定端点；不再有内置厂商 id 冲突', async () => {
    const projector = new MailProjector();
    // 厂商 id（163 / qq 等）不再是保留 id：冲突机制已随预设删除。
    const result = await projector.inspect(ctx(manifestOf('163')));
    expect(result.items).toEqual([
      {
        id: '163',
        label: '邮箱 163',
        imapHost: 'imap.163.test',
        smtpHost: 'smtp.163.test',
      },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it('包内重复 id → blocker（schema 拒绝后的兜底路径）', async () => {
    const projector = new MailProjector();
    const base = manifestOf('dup');
    const dupManifest = {
      ...base,
      contributions: {
        skills: [],
        connectors: [],
        mcp: [],
        mail: [...base.contributions.mail, ...base.contributions.mail],
      },
    } as PluginManifest; // hand-built: superRefine would reject duplicate ids
    const dupResult = await projector.inspect(ctx(dupManifest));
    expect(dupResult.blockers).toHaveLength(1);
    expect(dupResult.blockers[0]).toContain('重复的邮件贡献');
  });

  it('project / unproject 只动账本；setEnabled 空操作', async () => {
    const projector = new MailProjector();
    const ledger = new MemLedger();
    const context = { ...ctx(manifestOf('alpha')), ledger };
    await projector.project(context);
    expect(ledger.list('mail')).toEqual(['alpha']);

    await projector.setEnabled(context, ['alpha'], false);
    expect(ledger.list('mail')).toEqual(['alpha']); // untouched

    await projector.unproject(identity, ['alpha'], ledger);
    expect(ledger.list('mail')).toEqual([]);
    await projector.unproject(identity, ['alpha'], ledger); // idempotent
    expect(ledger.list('mail')).toEqual([]);
  });

  it('update：新清单补账本，移除的贡献清账本', async () => {
    const projector = new MailProjector();
    const ledger = new MemLedger();
    const oldCtx = { ...ctx(manifestOf('old')), ledger };
    await projector.project(oldCtx);
    const newCtx = { ...ctx(manifestOf('new')), ledger };
    await projector.update(oldCtx, newCtx);
    expect(ledger.list('mail')).toEqual(['new']);
  });
});

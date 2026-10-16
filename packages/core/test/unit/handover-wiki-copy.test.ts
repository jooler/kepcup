import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openRepository } from 'es-git';

import type { Clock } from '../../src/infra/clock.js';
import { botWikiRoot, botWikiStoreRoot, resolvePaths } from '../../src/infra/paths.js';
import { WikiService } from '../../src/wiki/service.js';
import type { WikiFtsStore } from '../../src/wiki/fts.js';
import { initWiki } from '../../src/wiki/init.js';
import { commitWikiTree } from '../../src/wiki/git.js';
import { pageReferences } from '../../src/wiki/copy.js';

/**
 * D88 P2 Wiki 复制（`WikiService.copyForHandover`，设计 37 §3.2；真实 es-git 仓库）：页 +
 * 引用的 raw 原件 + D85 资产（`_assets` 清单、`_derived`、仓外 `wiki-store` 硬链接 / 复制）；
 * 同路径不覆盖并列出；一次提交「从 {A} 复制 N 页」；FTS；排一次 lint；来源不变；重跑幂等
 * （不重复提交、不重复写日志）；崩溃留下的半成品（已落盘未提交）续跑后提交。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'handover-wiki-copy-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => stubLogger };

/** In-memory wiki_fts of one bot (search = substring over title + content). */
class FakeFts implements WikiFtsStore {
  readonly pages = new Map<string, { title: string; content: string }>();
  wikiUpsertPage(pagePath: string, title: string, content: string): void {
    this.pages.set(pagePath, { title, content });
  }
  wikiDeletePage(pagePath: string): void {
    this.pages.delete(pagePath);
  }
  wikiClearPages(): void {
    this.pages.clear();
  }
  wikiSearch(queryText: string, limit: number) {
    return [...this.pages.entries()]
      .filter(([, page]) => page.content.includes(queryText) || page.title.includes(queryText))
      .slice(0, limit)
      .map(([p, page]) => ({ path: p, title: page.title, snippet: '' }));
  }
  wikiPageCount(): number {
    return this.pages.size;
  }
  wikiPagePaths(): string[] {
    return [...this.pages.keys()];
  }
}

interface Rig {
  wiki: WikiService;
  paths: ReturnType<typeof resolvePaths>;
  fts: Map<string, FakeFts>;
  enqueued: Array<{ type: string; botId?: string | null; dedupeKey?: string | null }>;
  alive: Set<string>;
}

function makeRig(): Rig {
  const home = path.join(dir, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const fts = new Map<string, FakeFts>();
  const enqueued: Rig['enqueued'] = [];
  const alive = new Set(['bot_a', 'bot_b']);
  const clock: Clock = { now: () => Date.UTC(2026, 9, 13) };
  const wiki = new WikiService({
    paths,
    clock,
    logger: stubLogger,
    jobs: {
      enqueue: (input) => {
        enqueued.push(input);
        return 'job_x';
      },
      lastDoneAt: () => 0,
    },
    bots: {
      get: (id) => (alive.has(id) ? { id, status: 'active' } : null),
      listActive: () => [...alive].map((id) => ({ id })),
    },
    conversations: { get: () => null, memberBotIds: () => [] },
    memory: {
      storeFor: (botId) => {
        let store = fts.get(botId);
        if (store === undefined) {
          store = new FakeFts();
          fts.set(botId, store);
        }
        return store;
      },
    },
  });
  return { wiki, paths, fts, enqueued, alive };
}

function write(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

async function headSummary(root: string): Promise<{ oid: string; message: string }> {
  const repo = await openRepository(root);
  const oid = repo.head().target()!;
  return { oid, message: repo.getCommit(oid).summary() ?? '' };
}

const ASSET = 'ast_3f9a0c0123456789abcdef01';

/** A's wiki: three pages (one in a topic dir), raw text, a D85 asset with store files. */
async function seedSource(rig: Rig): Promise<string> {
  await initWiki(rig.paths, 'bot_a', stubLogger);
  const root = botWikiRoot(rig.paths, 'bot_a');
  write(
    root,
    'pages/deploy.md',
    `# 部署手册\n\nDeployGuide 步骤见 [原始文档](../raw/20261001-abcdef123456-spec.md)。\n\n![图](../raw/_derived/${ASSET}/frames.md) [源：report.pdf](../raw/_assets/${ASSET}.json) [官网](https://example.com/x)\n`,
  );
  write(
    root,
    'pages/topic/rollback.md',
    '# 回滚\n\n见 [规范](../../raw/20261002-bbbbbbbbbbbb-rules.md)。\n',
  );
  write(root, 'pages/shared.md', '# 共享页\n\nA 版本的内容。\n');
  write(root, 'raw/20261001-abcdef123456-spec.md', '原始规范 spec');
  write(root, 'raw/20261002-bbbbbbbbbbbb-rules.md', '回滚规则 rules');
  write(root, 'raw/20261003-cccccccccccc-unused.md', '没被引用的原件');
  write(
    root,
    `raw/_assets/${ASSET}.json`,
    JSON.stringify({
      id: ASSET,
      storage: 'store',
      status: 'maintained',
      rawRelPath: null,
      readable: [`raw/_derived/${ASSET}/full.md`],
      sources: [{ type: 'attachment', ref: 'att_A', conversationId: 'cnv_A', at: 1 }],
    }),
  );
  write(root, `raw/_derived/${ASSET}/manifest.json`, '{"steps":[]}');
  write(root, `raw/_derived/${ASSET}/full.md`, 'PDF 全文');
  write(root, `raw/_derived/${ASSET}/frames.md`, '关键帧');
  const store = path.join(botWikiStoreRoot(rig.paths, 'bot_a'), ASSET);
  write(store, 'original', Buffer.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3]));
  write(store, 'frames/000123.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  write(
    store,
    'state.json',
    JSON.stringify({ status: 'maintained', sources: [{ type: 'attachment', ref: 'att_A' }] }),
  );
  write(store, 'staging/partial.bin', 'half-written derive output');
  await commitWikiTree(root, 'seed');
  return (await headSummary(root)).oid;
}

/** B's wiki with a different page at a path A also has. */
async function seedTarget(rig: Rig): Promise<void> {
  await initWiki(rig.paths, 'bot_b', stubLogger);
  const root = botWikiRoot(rig.paths, 'bot_b');
  write(root, 'pages/shared.md', '# 共享页\n\nB 自己的版本。\n');
  await commitWikiTree(root, 'b seed');
}

describe('D88 P2 wiki copy: page references', () => {
  it('inline / image / reference / html links resolve against the page directory; urls and escapes are ignored', () => {
    const refs = pageReferences(
      'pages/topic/x.md',
      [
        '[a](../../raw/one.md) ![b](../../raw/img%20two.png "t")',
        '[c]: ../../raw/three.md',
        '<img src="../../raw/four.txt">',
        `[d](../../raw/_assets/${ASSET}.json) [e](../../raw/_derived/ast_other/full.md#p2)`,
        '[f](https://example.com/raw/x) [g](#anchor) [h](../../../../etc/passwd) [i](../sibling.md)',
        '[j](<../../raw/five six.md>)',
      ].join('\n'),
    );
    expect([...refs.rawFiles].sort()).toEqual([
      'raw/five six.md',
      'raw/four.txt',
      'raw/img two.png',
      'raw/one.md',
      'raw/three.md',
    ]);
    expect([...refs.assetIds].sort()).toEqual([ASSET, 'ast_other'].sort());
  });
});

describe('D88 P2 wiki copy: WikiService.copyForHandover', () => {
  it('copies pages + referenced raw + D85 assets; same-path page kept and listed; one commit; FTS; lint; source unchanged', async () => {
    const rig = makeRig();
    const sourceHead = await seedSource(rig);
    await seedTarget(rig);
    const a = botWikiRoot(rig.paths, 'bot_a');
    const b = botWikiRoot(rig.paths, 'bot_b');

    const outcome = await rig.wiki.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      fromName: '阿尔法',
      handoverId: 'hnd_1',
      pages: ['pages/deploy.md', 'pages/topic/rollback.md', 'pages/shared.md', 'pages/gone.md'],
    });
    expect(outcome.copied.sort()).toEqual(['pages/deploy.md', 'pages/topic/rollback.md']);
    expect(outcome.conflicts).toEqual(['pages/shared.md']);
    expect(outcome.missing).toEqual(['pages/gone.md']);
    expect(outcome.assets).toBe(1);
    expect(outcome.rawConflicts).toEqual([]);
    expect(outcome.commit).not.toBeNull();

    // Pages and referenced originals arrive byte-identical; the unreferenced raw does not.
    for (const rel of [
      'pages/deploy.md',
      'pages/topic/rollback.md',
      'raw/20261001-abcdef123456-spec.md',
      'raw/20261002-bbbbbbbbbbbb-rules.md',
      `raw/_derived/${ASSET}/manifest.json`,
      `raw/_derived/${ASSET}/full.md`,
      `raw/_derived/${ASSET}/frames.md`,
    ]) {
      expect(readFileSync(path.join(b, rel), 'utf8'), rel).toBe(
        readFileSync(path.join(a, rel), 'utf8'),
      );
    }
    expect(existsSync(path.join(b, 'raw/20261003-cccccccccccc-unused.md'))).toBe(false);
    // Same-path page of B is never overwritten.
    expect(readFileSync(path.join(b, 'pages/shared.md'), 'utf8')).toContain('B 自己的版本');

    // Out-of-git store: immutable files hard-linked (same inode), live state copied, staging never.
    const storeA = path.join(botWikiStoreRoot(rig.paths, 'bot_a'), ASSET);
    const storeB = path.join(botWikiStoreRoot(rig.paths, 'bot_b'), ASSET);
    expect(statSync(path.join(storeB, 'original')).ino).toBe(
      statSync(path.join(storeA, 'original')).ino,
    );
    expect(readFileSync(path.join(storeB, 'frames/000123.jpg'))).toEqual(
      readFileSync(path.join(storeA, 'frames/000123.jpg')),
    );
    expect(statSync(path.join(storeB, 'state.json')).ino).not.toBe(
      statSync(path.join(storeA, 'state.json')).ino,
    );
    expect(existsSync(path.join(storeB, 'staging'))).toBe(false);
    // Review #10: B's manifest / state name the handover as source, not A's attachment.
    const manifestB = JSON.parse(readFileSync(path.join(b, `raw/_assets/${ASSET}.json`), 'utf8'));
    expect(manifestB).toMatchObject({ id: ASSET, status: 'maintained' });
    expect(manifestB.sources).toEqual([
      { type: 'handover', handoverId: 'hnd_1', fromBotId: 'bot_a' },
    ]);
    expect(JSON.parse(readFileSync(path.join(storeB, 'state.json'), 'utf8')).sources).toEqual([
      { type: 'handover', handoverId: 'hnd_1', fromBotId: 'bot_a' },
    ]);
    expect(outcome.pageFiles['pages/topic/rollback.md']).toEqual([
      'raw/20261002-bbbbbbbbbbbb-rules.md',
    ]);

    // One commit on B; A's history untouched.
    expect((await headSummary(b)).message).toBe('从 阿尔法 复制 2 页');
    expect((await headSummary(a)).oid).toBe(sourceHead);
    const log = readFileSync(path.join(b, 'log.md'), 'utf8');
    expect(log.match(/移交 hnd_1/g)).toHaveLength(1);

    // FTS rows for the copied pages; one lint queued for B; staging gone.
    expect(
      rig.fts
        .get('bot_b')!
        .wikiSearch('DeployGuide', 10)
        .map((hit) => hit.path),
    ).toEqual(['pages/deploy.md']);
    expect(rig.enqueued).toEqual([
      expect.objectContaining({
        type: 'wiki_lint',
        botId: 'bot_b',
        dedupeKey: 'wiki_lint:bot_b:handover',
      }),
    ]);
    expect(existsSync(path.join(rig.paths.cacheDir, 'handover-staging/hnd_1'))).toBe(false);

    // Re-run (a retried job): same result, no new commit, no second log line.
    const headBefore = (await headSummary(b)).oid;
    const again = await rig.wiki.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      fromName: '阿尔法',
      handoverId: 'hnd_1',
      pages: ['pages/deploy.md', 'pages/topic/rollback.md', 'pages/shared.md'],
    });
    expect(again.copied.sort()).toEqual(['pages/deploy.md', 'pages/topic/rollback.md']);
    expect(again.conflicts).toEqual(['pages/shared.md']);
    expect(again.commit).toBeNull();
    expect((await headSummary(b)).oid).toBe(headBefore);
    expect(readFileSync(path.join(b, 'log.md'), 'utf8').match(/移交 hnd_1/g)).toHaveLength(1);
    expect(rig.wiki.pageConflict('bot_a', 'bot_b', 'pages/deploy.md')).toBe('same');
    expect(rig.wiki.pageConflict('bot_a', 'bot_b', 'pages/shared.md')).toBe('different');
  });

  it('crash leftovers: a page placed but not committed is committed on the resumed run; stale staging is replaced', async () => {
    const rig = makeRig();
    await seedSource(rig);
    await initWiki(rig.paths, 'bot_b', stubLogger);
    const a = botWikiRoot(rig.paths, 'bot_a');
    const b = botWikiRoot(rig.paths, 'bot_b');
    // The previous attempt died after renaming one page into place (uncommitted) and
    // left a half-filled staging directory behind.
    write(b, 'pages/deploy.md', readFileSync(path.join(a, 'pages/deploy.md')));
    write(path.join(rig.paths.cacheDir, 'handover-staging/hnd_2/wiki'), 'pages/junk.md', 'junk');

    const outcome = await rig.wiki.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      fromName: '阿尔法',
      handoverId: 'hnd_2',
      pages: ['pages/deploy.md'],
    });
    expect(outcome.copied).toEqual(['pages/deploy.md']);
    expect(outcome.commit).not.toBeNull();
    expect((await headSummary(b)).message).toBe('从 阿尔法 复制 1 页');
    expect(existsSync(path.join(b, 'pages/junk.md'))).toBe(false);
    expect(existsSync(path.join(b, 'raw/20261001-abcdef123456-spec.md'))).toBe(true);
  });

  it('a referenced raw file B already has with other bytes is kept (reported); a deleted target refuses', async () => {
    const rig = makeRig();
    await seedSource(rig);
    await initWiki(rig.paths, 'bot_b', stubLogger);
    const b = botWikiRoot(rig.paths, 'bot_b');
    write(b, 'raw/20261002-bbbbbbbbbbbb-rules.md', 'B 的不同内容');
    const outcome = await rig.wiki.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      fromName: '阿尔法',
      handoverId: 'hnd_3',
      pages: ['pages/topic/rollback.md'],
    });
    expect(outcome.copied).toEqual(['pages/topic/rollback.md']);
    expect(outcome.rawConflicts).toEqual(['raw/20261002-bbbbbbbbbbbb-rules.md']);
    expect(readFileSync(path.join(b, 'raw/20261002-bbbbbbbbbbbb-rules.md'), 'utf8')).toBe(
      'B 的不同内容',
    );

    rig.alive.delete('bot_b');
    await expect(
      rig.wiki.copyForHandover({
        fromBotId: 'bot_a',
        toBotId: 'bot_b',
        fromName: '阿尔法',
        handoverId: 'hnd_4',
        pages: ['pages/deploy.md'],
      }),
    ).rejects.toThrow('接手方');
    expect(existsSync(path.join(rig.paths.cacheDir, 'handover-staging/hnd_4'))).toBe(false);
  });

  it('review fixes: a skipped page brings no originals; a symlinked store is not followed; a failed commit takes back what it placed', async () => {
    const rig = makeRig();
    await seedSource(rig);
    await seedTarget(rig);
    const a = botWikiRoot(rig.paths, 'bot_a');
    const b = botWikiRoot(rig.paths, 'bot_b');
    // pages/shared.md (conflict) now references its own original: it must not be placed.
    write(
      a,
      'pages/shared.md',
      '# 共享页\n\n见 [私有原件](../raw/20261009-dddddddddddd-only-shared.md)。\n',
    );
    write(a, 'raw/20261009-dddddddddddd-only-shared.md', '只有 shared 引用的原件');
    const skipped = await rig.wiki.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      fromName: '阿尔法',
      handoverId: 'hnd_6',
      pages: ['pages/shared.md', 'pages/topic/rollback.md'],
    });
    expect(skipped.conflicts).toEqual(['pages/shared.md']);
    expect(existsSync(path.join(b, 'raw/20261009-dddddddddddd-only-shared.md'))).toBe(false);
    expect(existsSync(path.join(b, 'raw/20261002-bbbbbbbbbbbb-rules.md'))).toBe(true);

    // A symlinked asset directory in the source store is never followed.
    const outside = path.join(dir, `outside-${Math.random().toString(36).slice(2, 8)}`);
    write(outside, 'secret.txt', 'host file');
    const storeA = botWikiStoreRoot(rig.paths, 'bot_a');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, path.join(storeA, 'ast_linked'));
    write(a, 'pages/linked.md', '# 链接\n\n[x](../raw/_assets/ast_linked.json)\n');
    const linked = await rig.wiki.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      fromName: '阿尔法',
      handoverId: 'hnd_7',
      pages: ['pages/linked.md'],
    });
    expect(linked.copied).toEqual(['pages/linked.md']);
    expect(existsSync(path.join(botWikiStoreRoot(rig.paths, 'bot_b'), 'ast_linked'))).toBe(false);

    // The target's repository is broken: the commit throws → placed files are removed and
    // log.md is restored (nothing uncommitted left behind); the error propagates.
    const c = await (async () => {
      const r = makeRig();
      await seedSource(r);
      const root = botWikiRoot(r.paths, 'bot_b');
      write(root, 'SCHEMA.md', '# x');
      write(root, 'log.md', '# 变更日志\n');
      mkdirSync(path.join(root, '.git'), { recursive: true });
      return { r, root };
    })();
    await expect(
      c.r.wiki.copyForHandover({
        fromBotId: 'bot_a',
        toBotId: 'bot_b',
        fromName: '阿尔法',
        handoverId: 'hnd_8',
        pages: ['pages/deploy.md'],
      }),
    ).rejects.toThrow();
    expect(existsSync(path.join(c.root, 'pages/deploy.md'))).toBe(false);
    expect(existsSync(path.join(c.root, 'raw/20261001-abcdef123456-spec.md'))).toBe(false);
    expect(readFileSync(path.join(c.root, 'log.md'), 'utf8')).toBe('# 变更日志\n');
    expect(existsSync(path.join(c.r.paths.cacheDir, 'handover-staging/hnd_8'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('独立审查 #5 / #8 / #9 / #10 / #6: placement manifest on resume; unsafe page names; leftovers; unfinished assets; size', async () => {
    const rig = makeRig();
    await seedSource(rig);
    await initWiki(rig.paths, 'bot_b', stubLogger);
    const a = botWikiRoot(rig.paths, 'bot_a');
    const b = botWikiRoot(rig.paths, 'bot_b');
    const copy = (handoverId: string, pages: string[]) =>
      rig.wiki.copyForHandover({
        fromBotId: 'bot_a',
        toBotId: 'bot_b',
        fromName: '阿尔法',
        handoverId,
        pages,
      });

    // #5: the copy committed, then (before the item was recorded) B's maintenance edited
    // the page; the resumed run still counts it as copied, not as a same-path conflict.
    expect((await copy('hnd_9', ['pages/deploy.md'])).copied).toEqual(['pages/deploy.md']);
    write(b, 'pages/deploy.md', '# 部署手册\n\nB 整理过的版本。\n');
    const resumed = await copy('hnd_9', ['pages/deploy.md']);
    expect(resumed.copied).toEqual(['pages/deploy.md']);
    expect(resumed.conflicts).toEqual([]);
    expect(readFileSync(path.join(b, 'pages/deploy.md'), 'utf8')).toContain('B 整理过的版本');
    // …while another handover still sees a different page at that path as a conflict.
    expect((await copy('hnd_10', ['pages/deploy.md'])).conflicts).toEqual(['pages/deploy.md']);

    // #9: leftovers — the placement manifest is dropped on discard / by the startup sweep.
    const manifest = path.join(rig.paths.home, 'bots/bot_b/wiki-handover/hnd_9.json');
    expect(existsSync(manifest)).toBe(true);
    mkdirSync(path.join(rig.paths.cacheDir, 'handover-staging/hnd_dead'), { recursive: true });
    mkdirSync(path.join(rig.paths.cacheDir, 'handover-staging/hnd_live'), { recursive: true });
    rig.wiki.sweepHandoverLeftovers(new Set(['hnd_live', 'hnd_10']));
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(path.join(rig.paths.cacheDir, 'handover-staging/hnd_dead'))).toBe(false);
    expect(existsSync(path.join(rig.paths.cacheDir, 'handover-staging/hnd_live'))).toBe(true);
    expect(existsSync(path.join(rig.paths.home, 'bots/bot_b/wiki-handover/hnd_10.json'))).toBe(
      true,
    );
    rig.wiki.discardHandoverLeftovers('hnd_10', null);
    expect(existsSync(path.join(rig.paths.home, 'bots/bot_b/wiki-handover/hnd_10.json'))).toBe(
      false,
    );

    // #8: page paths with control characters / angle brackets are not addressable.
    write(a, 'pages/evil\nline.md', '# x');
    write(a, 'pages/<b>.md', '# y');
    expect(rig.wiki.pageStats('bot_a').map((page) => page.path)).not.toEqual(
      expect.arrayContaining(['pages/evil\nline.md']),
    );
    expect(rig.wiki.pageStats('bot_a').some((page) => /[\n<>]/.test(page.path))).toBe(false);
    expect((await copy('hnd_11', ['pages/evil\nline.md'])).missing).toEqual([
      'pages/evil\nline.md',
    ]);

    // #10: an asset still deriving is not copied (its manifest / derived layer / store stay with A).
    write(
      a,
      'raw/_assets/ast_deriving.json',
      JSON.stringify({ id: 'ast_deriving', status: 'deriving' }),
    );
    write(a, 'raw/_derived/ast_deriving/full.md', '半成品');
    write(path.join(botWikiStoreRoot(rig.paths, 'bot_a'), 'ast_deriving'), 'original', 'x');
    write(a, 'pages/wip.md', '# 进行中\n\n[源](../raw/_assets/ast_deriving.json)\n');
    const wip = await copy('hnd_12', ['pages/wip.md']);
    expect(wip.copied).toEqual(['pages/wip.md']);
    expect(wip.skippedAssets).toEqual(['ast_deriving']);
    expect(existsSync(path.join(b, 'raw/_assets/ast_deriving.json'))).toBe(false);
    expect(existsSync(path.join(b, 'raw/_derived/ast_deriving/full.md'))).toBe(false);
    expect(existsSync(path.join(botWikiStoreRoot(rig.paths, 'bot_b'), 'ast_deriving'))).toBe(false);

    // #6: copySize counts pages + originals + asset files (store included, staging not).
    const size = rig.wiki.copySize('bot_a', ['pages/deploy.md']);
    const expected = [
      'pages/deploy.md',
      'raw/20261001-abcdef123456-spec.md',
      `raw/_assets/${ASSET}.json`,
      `raw/_derived/${ASSET}/manifest.json`,
      `raw/_derived/${ASSET}/full.md`,
      `raw/_derived/${ASSET}/frames.md`,
    ].reduce((sum, rel) => sum + statSync(path.join(a, rel)).size, 0);
    const storeA = path.join(botWikiStoreRoot(rig.paths, 'bot_a'), ASSET);
    const storeBytes = ['original', 'frames/000123.jpg', 'state.json'].reduce(
      (sum, rel) => sum + statSync(path.join(storeA, rel)).size,
      0,
    );
    expect(size).toBe(expected + storeBytes);
  });

  it('page paths outside pages/ or escaping the root are never read', async () => {
    const rig = makeRig();
    await seedSource(rig);
    const outcome = await rig.wiki.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      fromName: '阿尔法',
      handoverId: 'hnd_5',
      pages: [
        'SCHEMA.md',
        'pages/../SCHEMA.md',
        'raw/20261001-abcdef123456-spec.md',
        '../bot_a/wiki/pages/deploy.md',
      ],
    });
    expect(outcome.copied).toEqual([]);
    expect(outcome.missing).toHaveLength(4);
    expect(outcome.commit).toBeNull();
    expect(rig.enqueued).toEqual([]);
  });
});

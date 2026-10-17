import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, generateMasterKey, wikiDbKeyInfo } from '../../src/infra/crypto.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { MemoryStore } from '../../src/memory/store.js';
import { WIKI_FTS_DDL, WikiIndexManager } from '../../src/wiki/index-manager.js';
import { WikiIndexStore } from '../../src/wiki/index-store.js';

/**
 * D92 T1b WP9 步骤 2：`wiki_fts` 六个方法从 MemoryStore 原样提取为
 * WikiIndexStore；内存库与 WikiIndexManager 打开的真实加密库（wiki.db）行为
 * 一致；内嵌 DDL 与 migrations/memory/0002 一致（一致性由本测试保证）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'wiki-index-store-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => stubLogger };

const migrationDdl = readFileSync(
  fileURLToPath(new URL('../../migrations/memory/0002_p09_wiki_fts.sql', import.meta.url)),
  'utf8',
);

/** 规范化 SQL：去注释、去 IF NOT EXISTS、压白、去句尾分号 —— 只比较形态。 */
function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .toLowerCase()
    .replace('if not exists ', '');
}

function openMemoryDb(): SqliteDatabase {
  const db = new Database(':memory:') as SqliteDatabase;
  db.exec(migrationDdl);
  return db;
}

describe('WikiIndexStore：六个方法（内存库 vs 真实加密 wiki.db）', () => {
  const stores = {
    memory: () => new WikiIndexStore(openMemoryDb()),
    encrypted: () => {
      const home = path.join(dir, `home-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(home, { recursive: true });
      const manager = new WikiIndexManager({
        paths: resolvePaths(home),
        masterKey: generateMasterKey(),
        clock: () => Date.now(),
        logger: stubLogger,
      });
      return manager.forProject('conv_idx');
    },
  };

  for (const [label, make] of Object.entries(stores)) {
    it(`[${label}] upsert / search（中文分词命中）/ pageCount / pagePaths / delete / clear`, () => {
      const store = make();
      expect(store.wikiPageCount()).toBe(0);
      expect(store.wikiPagePaths()).toEqual([]);

      store.wikiUpsertPage('pages/deploy.md', '部署指南', '# 部署指南\n\n构建、推送、发布三步。');
      store.wikiUpsertPage('pages/go-generics.md', 'Go 泛型', '# Go 泛型\n\n类型参数与约束。');
      store.wikiUpsertPage('pages/deploy.md', '部署指南', '# 部署指南\n\n构建、推送、发布与回滚。');

      expect(store.wikiPageCount()).toBe(2);
      expect([...store.wikiPagePaths()].sort()).toEqual(['pages/deploy.md', 'pages/go-generics.md']);

      const hits = store.wikiSearch('回滚', 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.path).toBe('pages/deploy.md');
      expect(hits[0]!.title).toBe('部署指南');
      expect(store.wikiSearch('泛型', 10).map((h) => h.path)).toEqual(['pages/go-generics.md']);
      // 多词 OR 命中并集；无命中返回空。
      expect(store.wikiSearch('构建 约束', 10)).toHaveLength(2);
      expect(store.wikiSearch('不存在的词', 10)).toEqual([]);

      store.wikiDeletePage('pages/go-generics.md');
      expect(store.wikiPageCount()).toBe(1);
      expect(store.wikiSearch('泛型', 10)).toEqual([]);

      store.wikiClearPages();
      expect(store.wikiPageCount()).toBe(0);
      expect(store.wikiPagePaths()).toEqual([]);
    });
  }

  it('MemoryStore 委托后行为不变（同一连接上读写 wiki_fts）', () => {
    const db = openMemoryDb();
    const store = new MemoryStore({ db, clock: () => 0 });
    store.wikiUpsertPage('pages/a.md', '页面 A', '# 页面 A\n\n检索关键词菠萝。');
    expect(store.wikiSearch('菠萝', 5).map((h) => h.path)).toEqual(['pages/a.md']);
    expect(store.wikiPageCount()).toBe(1);
    store.wikiDeletePage('pages/a.md');
    expect(store.wikiPageCount()).toBe(0);
  });
});

describe('WikiIndexManager（真实加密 wiki.db）', () => {
  it('打开即建表并写 user_version=1；LRU 池关闭连接', () => {
    const home = path.join(dir, `mgr-${Math.random().toString(36).slice(2, 8)}`);
    const paths = resolvePaths(home);
    const masterKey = generateMasterKey();
    const manager = new WikiIndexManager({ paths, masterKey, clock: () => Date.now(), logger: stubLogger });
    expect(manager.exists('conv_1')).toBe(false);

    const store = manager.forProject('conv_1');
    expect(manager.exists('conv_1')).toBe(true);
    store.wikiUpsertPage('pages/x.md', 'X', '内容');

    // 直接用同一把派生 key 重开：表结构与数据都在（加密可读）。
    const reopened = openDatabase({
      path: path.join(paths.home, 'projects', 'conv_1', 'wiki.db'),
      key: deriveKey(masterKey, wikiDbKeyInfo('conv_1')),
    });
    expect(reopened.pragma('user_version', { simple: true })).toBe(1);
    const probe = new WikiIndexStore(reopened);
    expect(probe.wikiPagePaths()).toEqual(['pages/x.md']);
    probe.close();

    manager.forProject('conv_2');
    expect(manager.openCount).toBe(2);
    manager.closeProject('conv_1');
    expect(manager.openCount).toBe(1);
    manager.closeAll();
    expect(manager.openCount).toBe(0);
  });

  it('内嵌 DDL 与 migrations/memory/0002 规范化后一致', () => {
    expect(normalizeSql(WIKI_FTS_DDL)).toBe(normalizeSql(migrationDdl));
  });

  it('加密库用错误 key 打不开（隔离性抽查）', () => {
    const home = path.join(dir, `iso-${Math.random().toString(36).slice(2, 8)}`);
    const paths = resolvePaths(home);
    const manager = new WikiIndexManager({
      paths,
      masterKey: generateMasterKey(),
      clock: () => Date.now(),
      logger: stubLogger,
    });
    manager.forProject('conv_1').wikiUpsertPage('pages/x.md', 'X', '内容');
    manager.closeAll();
    expect(() =>
      openDatabase({
        path: path.join(paths.home, 'projects', 'conv_1', 'wiki.db'),
        key: deriveKey(generateMasterKey(), wikiDbKeyInfo('conv_1')),
      }),
    ).toThrow();
  });
});

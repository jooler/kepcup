import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { openDatabase, closeDatabase } from '../../src/infra/db.js';
import { deriveKey, memoryDbKeyInfo } from '../../src/infra/crypto.js';
import { MemoryDbManager } from '../../src/memory/manager.js';
import type { Embedder } from '../../src/memory/embedder.js';
import { retrieveRelevant } from '../../src/memory/retrieve.js';

const dir = mkdtempSync(path.join(tmpdir(), 'memory-store-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let tick = 0;
const clock = () => 1_000_000 + tick++;

/** Deterministic 8-dim embedder: same text ⇒ same unit vector. */
function fakeEmbedder(): Embedder {
  return {
    id: 'fake:8',
    dim: 8,
    ready: () => true,
    embed: async (texts: string[]) =>
      texts.map((text) => {
        const vector = new Float32Array(8);
        for (let i = 0; i < text.length; i++) {
          vector[(text.charCodeAt(i) + i) % 8] += 1;
        }
        let sum = 0;
        for (const value of vector) sum += value * value;
        const norm = Math.sqrt(sum) || 1;
        for (let i = 0; i < 8; i++) vector[i] = vector[i]! / norm;
        return vector;
      }),
  };
}

function newManager(): MemoryDbManager {
  return new MemoryDbManager({
    paths: {
      home: dir,
      logsDir: dir,
      mainDbPath: path.join(dir, 'main.db'),
      runsDbPath: path.join(dir, 'runs.db'),
      cacheDir: dir,
      cacheNpmDir: dir,
      cachePipDir: dir,
      cacheXdgDir: dir,
      cacheCargoDir: dir,
      cachePycacheDir: dir,
      cacheUvDir: dir,
      cacheDownloadsDir: dir,
      toolchainsDir: dir,
    },
    masterKey: randomBytes(32),
    clock,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  });
}

describe('memory store (memory.db 领域层)', () => {
  it('creates an encrypted database, migrates it and keeps FTS in sync', async () => {
    const manager = newManager();
    const store = manager.for('bot_a');
    const item = store.insert({
      kind: 'fact',
      content: '用户是后端工程师，主要写 Go',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      originConversationId: 'conv_1',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    expect(item.id.startsWith('mem_')).toBe(true);

    // Chinese OR-composition recall (Segmenter 结论语点的仓库内固化)。
    const hits = store.searchFts('用户做什么工作', 20);
    expect(hits.map((entry) => entry.id)).toContain(item.id);
    expect(store.searchFts('完全不相关的话题词组', 20)).toHaveLength(0);

    const files = manager.exists('bot_a');
    expect(files).toBe(true);
    manager.closeAll();
  });

  it('dedupes by cosine similarity when vectors are available, else exact text', async () => {
    const manager = newManager();
    const store = manager.for('bot_b');
    const embedder = fakeEmbedder();
    const [vector] = await embedder.embed(['用户每周五开例会']);
    const stored = store.insert({
      kind: 'fact',
      content: '用户每周五开例会',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    await store.ensureVecTable(embedder.id, 8);
    store.upsertVec(store.rowidOf(stored.id)!, vector!);
    // Vector-backed store: cosine 1 with itself ⇒ dedupe hit.
    const similar = store.findSimilar('用户每周五开例会', vector!);
    expect(similar).not.toBeNull();
    expect(similar!.id).toBe(stored.id);

    // Without vectors only the exact (trimmed) text matches.
    expect(store.findSimilar('用户每周五开例会', null)).not.toBeNull();
    expect(store.findSimilar('用户每周五开例会 ', null)).not.toBeNull();
    expect(store.findSimilar('不同的内容', null)).toBeNull();
    manager.closeAll();
  });

  it('creates memory_vec at the embedder dimension and recreates it on change', async () => {
    const manager = newManager();
    const store = manager.for('bot_c');
    const embedder = fakeEmbedder();
    const [vector] = await embedder.embed(['向量条目内容']);
    expect(await store.ensureVecTable(embedder.id, 8)).toBe('created');
    expect(await store.ensureVecTable(embedder.id, 8)).toBe('exists');
    const created = store.insert({
      kind: 'fact',
      content: '向量条目内容',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    store.upsertVec(store.rowidOf(created.id)!, vector!);
    const knn = store.knn(vector!, 3);
    expect(knn.map((entry) => entry.id)).toContain(created.id);
    // Changing the model id forces a rebuild (drop + recreate).
    expect(await store.ensureVecTable('fake:9', 8)).toBe('recreated');
    expect(store.knn(vector!, 3)).toHaveLength(0);
    manager.closeAll();
  });

  it('retrieves through the full hybrid path with the fake embedder', async () => {
    const manager = newManager();
    const store = manager.for('bot_d');
    const embedder = fakeEmbedder();
    store.insert({
      kind: 'preference',
      content: '用户偏好简洁的回复',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    // Make the vector side usable for the stored item.
    const stored = store.activeItems()[0]!;
    await store.ensureVecTable(embedder.id, 8);
    const [vector] = await embedder.embed([stored.content]);
    store.upsertVec(store.rowidOf(stored.id)!, vector!);

    const result = await retrieveRelevant({
      store,
      embedder,
      queryText: '用户喜欢什么样的回复',
      filters: { isGroup: false, now: clock() + 10_000 },
    });
    expect(result.items.map((entry) => entry.id)).toContain(stored.id);
    expect(stored.useCount).toBe(0); // markUsed mutates the DB, not the snapshot
    expect(store.getItem(stored.id)!.useCount).toBe(1);
    manager.closeAll();
  });

  it('voids commitments of a conversation', () => {
    const manager = newManager();
    const store = manager.for('bot_e');
    const commitment = store.insert({
      kind: 'commitment',
      content: '下周三交报告',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      originConversationId: 'conv_9',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
      dueAt: 2_000_000,
    });
    const other = store.insert({
      kind: 'fact',
      content: '普通事实条目',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    // P10: returns the voided ids so the schedule linkage can cancel tasks.
    expect(store.voidCommitmentsOfConversation('conv_9')).toEqual([commitment.id]);
    expect(store.getItem(commitment.id)!.status).toBe('void');
    expect(store.getItem(other.id)!.status).toBe('active');

    manager.closeAll();
  });

  it('expires entries past valid_until directly (不过模型)', () => {
    const manager = newManager();
    const store = manager.for('bot_f');
    store.insert({
      kind: 'fact',
      content: '有时效的条目',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
      validUntil: 1_500_000,
    });
    expect(store.expirePastValidUntil(1_600_000)).toBe(1);
    expect(store.activeItems()).toHaveLength(0);
    manager.closeAll();
  });

  it('user edits: updateContent rewrites FTS; setPrivateToBot toggles the flag (任务书任务 13)', () => {
    const manager = newManager();
    const store = manager.for('bot_edit');
    const item = store.insert({
      kind: 'fact',
      content: '用户是后端工程师，主要写 Go',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    const edited = store.updateContent(item.id, '用户居住在苏州工业园区');
    expect(edited.content).toBe('用户居住在苏州工业园区');
    expect(store.searchFts('苏州', 20).map((entry) => entry.id)).toContain(item.id);
    expect(store.searchFts('后端', 20)).toHaveLength(0);

    const flagged = store.setPrivateToBot(item.id, true);
    expect(flagged.privateToBot).toBe(true);
    expect(store.getItem(item.id)!.privateToBot).toBe(true);
    expect(store.setPrivateToBot(item.id, false).privateToBot).toBe(false);
    manager.closeAll();
  });

  it('similarity dedupe only touches updated_at: no new row, same content/status (BR-P07-008)', () => {
    const manager = newManager();
    const store = manager.for('bot_touch');
    const item = store.insert({
      kind: 'preference',
      content: '用户偏好深色主题',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    const before = store.getItem(item.id)!;
    expect(before.updatedAt).toBeGreaterThan(0);
    // The clock advances per call, so a touch must move updated_at forward.
    store.touch(item.id);
    const after = store.getItem(item.id)!;
    expect(store.list({ status: 'active' })).toHaveLength(1); // 不新增条目
    expect(after.id).toBe(item.id);
    expect(after.content).toBe(before.content);
    expect(after.status).toBe('active');
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(after.createdAt).toBe(before.createdAt);
    manager.closeAll();
  });

  it('pool: caps at 8 open connections, closes the LRU one, reopens evicted databases on demand', () => {
    const manager = newManager();
    const first = manager.for('bot_pool_0');
    first.insert({
      kind: 'fact',
      content: '池化淘汰后应可重开的数据',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: false,
    });
    const stores = [first];
    for (let i = 1; i < 10; i++) {
      stores.push(manager.for(`bot_pool_${i}`));
    }
    // The pool evicted internally: at most MEMORY_DB_POOL_MAX stay open.
    expect(manager.openCount).toBeLessThanOrEqual(8);
    // The oldest connection was closed — using the stale ref must throw...
    expect(() => first.list()).toThrow();
    // ...and the evicted database reopens on the next access, data intact.
    const reopened = manager.for('bot_pool_0');
    expect(manager.openCount).toBeLessThanOrEqual(8);
    expect(reopened.list({ status: 'active' }).map((entry) => entry.content)).toEqual([
      '池化淘汰后应可重开的数据',
    ]);
    stores[stores.length - 1]!.list(); // the most recent connection still works
    manager.closeAll();
    expect(manager.openCount).toBe(0);
  });

  it('memory.db cannot be opened without the derived key', () => {
    const manager = newManager();
    manager.for('bot_enc');
    manager.closeAll();
    const dbPath = path.join(dir, 'bots', 'bot_enc', 'memory.db');
    let failed = false;
    try {
      const db = openDatabase({
        path: dbPath,
        key: deriveKey(randomBytes(32), memoryDbKeyInfo('bot_enc')),
      });
      closeDatabase(db);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

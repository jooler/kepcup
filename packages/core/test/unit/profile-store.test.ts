import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/infra/migrate.js';
import { ProfileStore } from '../../src/memory/profile-store.js';
import type { SqliteDatabase } from '../../src/infra/db.js';

const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function makeStore(): { store: ProfileStore; advance: (ms: number) => void } {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  let now = 1_000_000;
  const store = new ProfileStore({ db, clock: () => now });
  return {
    store,
    advance: (ms) => {
      now += ms;
    },
  };
}

function seed(store: ProfileStore, content: string) {
  return store.insert({
    category: 'boundaries',
    content,
    source: 'explicit',
    evidence: [],
    contributedBy: null,
    confidence: 1,
  });
}

describe('ProfileStore.cardIsStale (任务 C: 画像卡片一致性)', () => {
  it('stale when the card was never compiled but entries exist', () => {
    const { store } = makeStore();
    seed(store, '我不吃香菜');
    expect(store.cardIsStale()).toBe(true);
  });

  it('not stale after setCard; stale again after a direct edit', () => {
    const { store, advance } = makeStore();
    const item = seed(store, '我不吃香菜');
    store.setCard('用户不吃香菜');
    expect(store.cardIsStale()).toBe(false);

    advance(1);
    store.updateContent(item.id, '我对坚果过敏');
    expect(store.cardIsStale()).toBe(true);
    store.setCard('用户对坚果过敏');
    expect(store.cardIsStale()).toBe(false);
  });

  it('stale after a retraction — the old card must not keep the constraint', () => {
    const { store, advance } = makeStore();
    const item = seed(store, '我不吃香菜');
    store.setCard('用户不吃香菜');
    expect(store.cardIsStale()).toBe(false);

    advance(1);
    store.retract(item.id);
    expect(store.cardIsStale()).toBe(true);
  });

  it('not stale with neither a card nor entries', () => {
    const { store } = makeStore();
    expect(store.cardIsStale()).toBe(false);
  });
});

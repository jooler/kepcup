import { afterEach, describe, expect, it } from 'vitest';

import {
  AppConnectionStore,
  customConnectionId,
  isCustomConnectionId,
} from '../../src/apps/connection-store.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

let env: RealMainDb | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

function setup(): { env: RealMainDb; store: AppConnectionStore } {
  env = openRealMainDb();
  return { env, store: new AppConnectionStore({ db: env.db, clock: env.clock }) };
}

describe('AppConnectionStore', () => {
  it('create / get / update / delete，连接视图不含令牌字段', () => {
    const { env: e, store } = setup();
    const created = store.create({
      connectorId: 'com.notion/mcp',
      label: 'Notion',
      accountSub: 'u-1',
      serverUrl: 'https://mcp.notion.com/mcp',
      scopes: ['read', 'write'],
    });
    expect(created.id).toMatch(/^conn_/);
    expect(created).toMatchObject({
      status: 'not_connected',
      scopes: ['read', 'write'],
      createdAt: 1_000,
      updatedAt: 1_000,
      lastUsedAt: null,
    });
    expect(Object.keys(created).filter((k) => /token(?!Expires)|secret|refresh/i.test(k))).toEqual(
      [],
    );

    e.clock.set(2_000);
    const updated = store.update(created.id, { status: 'connected', label: 'Work Notion' });
    expect(updated).toMatchObject({ status: 'connected', label: 'Work Notion', updatedAt: 2_000 });
    expect(updated.createdAt).toBe(1_000);

    store.touch(created.id);
    expect(store.get(created.id)?.lastUsedAt).toBe(2_000);

    expect(store.delete(created.id)).toBe(true);
    expect(store.delete(created.id)).toBe(false);
    expect(store.get(created.id)).toBeNull();
  });

  it('未知 id：getRequired / update 抛 APP_CONNECTION_NOT_FOUND', () => {
    const { store } = setup();
    expect(() => store.getRequired('nope')).toThrow(/not found/);
    expect(() => store.update('nope', { label: 'x' })).toThrow(/not found/);
    try {
      store.getRequired('nope');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('APP_CONNECTION_NOT_FOUND');
    }
  });

  it('list 默认不含 custom: 行，includeCustom 才含；按创建顺序', () => {
    const { env: e, store } = setup();
    store.ensureCustom('srv_a', { label: 'A', serverUrl: null });
    e.clock.set(1_500);
    store.create({ id: 'conn_x', connectorId: 'com.x', label: 'X' });
    e.clock.set(1_600);
    store.create({ id: 'conn_y', connectorId: 'com.y', label: 'Y' });
    expect(store.list().map((c) => c.id)).toEqual(['conn_x', 'conn_y']);
    expect(store.list({ includeCustom: true }).map((c) => c.id)).toEqual([
      'custom:srv_a',
      'conn_x',
      'conn_y',
    ]);
    expect(isCustomConnectionId('custom:srv_a')).toBe(true);
    expect(customConnectionId('srv_a')).toBe('custom:srv_a');
  });

  it('stdio 自定义 server 的行 server_url 为 NULL；(connector, account_sub) 去重由库保证', () => {
    const { store } = setup();
    const row = store.ensureCustom('stdio_srv', { label: 'Local', serverUrl: null });
    expect(row.serverUrl).toBeNull();
    store.create({ id: 'conn_1', connectorId: 'com.x', label: 'X', accountSub: 'a' });
    expect(() =>
      store.create({ id: 'conn_2', connectorId: 'com.x', label: 'X2', accountSub: 'a' }),
    ).toThrow(/UNIQUE/);
    expect(store.findByConnector('com.x', 'a')?.id).toBe('conn_1');
    expect(store.findByConnector('com.x', 'zzz')).toBeNull();
    expect(store.findByConnector('com.x')?.id).toBe('conn_1');
  });

  it('disconnect：custom 行重置保留，其它行删除，不存在返回 missing', () => {
    const { store } = setup();
    store.ensureCustom('srv_a', { label: 'A', serverUrl: 'https://x.test/mcp' });
    store.update('custom:srv_a', { status: 'connected', issuer: 'https://auth.x.test' });
    store.create({ id: 'conn_1', connectorId: 'com.x', label: 'X' });
    expect(store.disconnect('custom:srv_a')).toBe('reset');
    expect(store.get('custom:srv_a')?.status).toBe('not_connected');
    expect(store.disconnect('conn_1')).toBe('deleted');
    expect(store.get('conn_1')).toBeNull();
    expect(store.disconnect('conn_1')).toBe('missing');
  });

  describe('ensureCustom：URL 换源', () => {
    function connected(store: AppConnectionStore, url: string): void {
      store.ensureCustom('srv', { label: 'S', serverUrl: url });
      store.update('custom:srv', {
        status: 'connected',
        issuer: 'https://auth.x.test',
        accountSub: 'acct',
        scopes: ['read'],
        tokenExpiresAt: 9_999,
      });
    }

    it('换 origin：连接行重置为 not_connected（issuer / 账号 / scope 清空），并通知清理（带换源前的行）', () => {
      const { store } = setup();
      const seen: Array<{ id: string; issuer: string | null; url: string | null }> = [];
      store.onCustomOriginChanged(({ connectionId, before }) =>
        seen.push({ id: connectionId, issuer: before.issuer, url: before.serverUrl }),
      );
      connected(store, 'https://old.example/mcp');
      const row = store.ensureCustom('srv', { label: 'S', serverUrl: 'https://new.example/mcp' });
      expect(row).toMatchObject({
        status: 'not_connected',
        issuer: null,
        accountSub: null,
        scopes: [],
        tokenExpiresAt: null,
        serverUrl: 'https://new.example/mcp',
      });
      expect(seen).toEqual([
        { id: 'custom:srv', issuer: 'https://auth.x.test', url: 'https://old.example/mcp' },
      ]);
      // 端口 / 协议不同也算换源
      connected(store, 'https://new.example/mcp');
      store.ensureCustom('srv', { label: 'S', serverUrl: 'https://new.example:8443/mcp' });
      expect(store.get('custom:srv')?.status).toBe('not_connected');
    });

    it('同源只改路径 / 查询：连接保持，不触发清理', () => {
      const { store } = setup();
      let calls = 0;
      store.onCustomOriginChanged(() => (calls += 1));
      connected(store, 'https://old.example/mcp');
      const row = store.ensureCustom('srv', { label: 'S', serverUrl: 'https://old.example/v2/mcp?x=1' });
      expect(row).toMatchObject({
        status: 'connected',
        issuer: 'https://auth.x.test',
        accountSub: 'acct',
        serverUrl: 'https://old.example/v2/mcp?x=1',
      });
      expect(calls).toBe(0);
    });

    it('没有授权痕迹的行（非 OAuth server）换源：状态不动', () => {
      const { store } = setup();
      store.ensureCustom('plain', { label: 'P', serverUrl: 'https://a.example/mcp', status: 'connected' });
      const row = store.ensureCustom('plain', { label: 'P', serverUrl: 'https://b.example/mcp' });
      expect(row.status).toBe('connected');
      expect(row.serverUrl).toBe('https://b.example/mcp');
    });
  });
});

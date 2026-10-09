import { afterEach, describe, expect, it } from 'vitest';
import type { OAuthServerInfo } from '@earendil-works/pi-mcp/oauth';

import { AppConnectionStore, customConnectionId } from '../../src/apps/connection-store.js';
import {
  TokenVault,
  accessTokenSecretName,
  clientIdSecretName,
  issuerHash,
} from '../../src/apps/token-vault.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

let env: RealMainDb | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

function setup(): { env: RealMainDb; store: AppConnectionStore; vault: TokenVault } {
  env = openRealMainDb();
  const store = new AppConnectionStore({ db: env.db, clock: env.clock });
  const vault = new TokenVault({ secrets: env.secrets, store, clock: env.clock });
  return { env, store, vault };
}

const ISSUER = 'https://auth.example.com';
const DISCOVERY: OAuthServerInfo = {
  authorizationServerUrl: ISSUER,
  authorizationServerMetadata: {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    response_types_supported: ['code'],
  },
};

/** Every row of every non-secret table as one string, to prove tokens are not in it. */
function dumpPlainTables(e: RealMainDb): string {
  const parts: string[] = [];
  for (const table of ['app_connections', 'oauth_clients']) {
    parts.push(JSON.stringify(e.db.prepare(`select * from ${table}`).all()));
  }
  return parts.join('\n');
}

describe('issuerHash', () => {
  it('sha256 hex 前 24 位，且 secrets 名称合法', () => {
    const hash = issuerHash(ISSUER);
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
    expect(issuerHash(ISSUER)).toBe(hash);
    expect(issuerHash(`${ISSUER}/`)).not.toBe(hash);
    expect(clientIdSecretName(ISSUER)).toBe(`oauth:client:${hash}:id`);
  });
});

describe('TokenVault 令牌（§4.5）', () => {
  it('逐值存放：access / refresh 各一个 secret，落库内容里没有 JSON 打包的令牌', () => {
    const { env: e, store, vault } = setup();
    store.create({ id: 'conn_1', connectorId: 'com.notion/mcp', label: 'Notion' });
    vault.saveTokens('conn_1', {
      access_token: 'at-secret-AAAA',
      token_type: 'Bearer',
      refresh_token: 'rt-secret-BBBB',
      expires_in: 3600,
      scope: 'read write',
      id_token: 'idt-secret-CCCC',
    });

    // 只有两个令牌 secret，值就是令牌本身（不是 JSON）。
    expect(e.secrets.names()).toEqual(['conn:conn_1:access', 'conn:conn_1:refresh']);
    expect(e.secrets.getValue('conn:conn_1:access')).toBe('at-secret-AAAA');
    expect(e.secrets.getValue('conn:conn_1:refresh')).toBe('rt-secret-BBBB');

    // 令牌（含 id_token）不出现在任何非机密表里，连接视图也没有令牌字段。
    const plain = dumpPlainTables(e);
    for (const secret of ['at-secret-AAAA', 'rt-secret-BBBB', 'idt-secret-CCCC']) {
      expect(plain).not.toContain(secret);
    }
    expect(JSON.stringify(store.get('conn_1'))).not.toMatch(/at-secret|rt-secret|idt-secret/);
    // 令牌被 redact 掩码。
    expect(e.secrets.redact('x at-secret-AAAA y rt-secret-BBBB')).toBe('x [REDACTED] y [REDACTED]');
  });

  it('expires_in 换算成 token_expires_at 写入连接行（绝对 epoch ms），scope 写入 scopes', () => {
    const { env: e, store, vault } = setup();
    store.create({ id: 'conn_1', connectorId: 'x', label: 'X' });
    e.clock.set(10_000);
    const { tokenExpiresAt } = vault.saveTokens('conn_1', {
      access_token: 'at-1111',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read write',
    });
    expect(tokenExpiresAt).toBe(10_000 + 3_600_000);
    expect(store.get('conn_1')).toMatchObject({
      tokenExpiresAt: 3_610_000,
      scopes: ['read', 'write'],
    });
    expect(vault.getTokens('conn_1')).toEqual({
      accessToken: 'at-1111',
      expiresAt: 3_610_000,
      scopes: ['read', 'write'],
    });

    // 缺 expires_in → null；缺 scope 不覆盖已有 scopes。
    vault.saveTokens('conn_1', { access_token: 'at-2222', token_type: 'Bearer' });
    expect(store.get('conn_1')).toMatchObject({ tokenExpiresAt: null, scopes: ['read', 'write'] });
  });

  it('刷新轮换：新值替换旧值，旧 access / refresh 仍被掩码；缺 refresh_token 则删除旧 refresh', () => {
    const { env: e, store, vault } = setup();
    store.create({ id: 'conn_1', connectorId: 'x', label: 'X' });
    vault.saveTokens('conn_1', {
      access_token: 'at-old-0001',
      token_type: 'Bearer',
      refresh_token: 'rt-old-0001',
      expires_in: 60,
    });
    vault.saveTokens('conn_1', {
      access_token: 'at-new-0002',
      token_type: 'Bearer',
      refresh_token: 'rt-new-0002',
      expires_in: 60,
    });
    expect(vault.getTokens('conn_1')?.accessToken).toBe('at-new-0002');
    expect(vault.getTokens('conn_1')?.refreshToken).toBe('rt-new-0002');
    expect(e.secrets.redact('at-old-0001 rt-old-0001 at-new-0002 rt-new-0002')).toBe(
      '[REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    );

    vault.saveTokens('conn_1', { access_token: 'at-new-0003', token_type: 'Bearer' });
    expect(vault.getTokens('conn_1')?.refreshToken).toBeUndefined();
    expect(e.secrets.hasValue('conn:conn_1:refresh')).toBe(false);
  });

  it('连接行不存在时拒绝保存（不留孤儿 secret）', () => {
    const { env: e, vault } = setup();
    expect(() =>
      vault.saveTokens('conn_missing', { access_token: 'at-xxxx', token_type: 'Bearer' }),
    ).toThrow(/not found/);
    expect(e.secrets.names()).toEqual([]);
    expect(vault.getTokens('conn_missing')).toBeNull();
  });

  it('saveDiscovery 写发现缓存与 issuer，getDiscovery 取回', () => {
    const { store, vault } = setup();
    store.create({ id: 'conn_1', connectorId: 'x', label: 'X' });
    expect(vault.saveDiscovery('conn_1', DISCOVERY)).toBe(ISSUER);
    expect(store.get('conn_1')?.issuer).toBe(ISSUER);
    expect(vault.getDiscovery('conn_1')).toEqual(DISCOVERY);
  });
});

describe('TokenVault 客户端（按 issuer 共享）', () => {
  it('saveClient / getClient 往返：id、secret 逐值存 secrets，来源与 redirect_uris 存行', () => {
    const { env: e, vault } = setup();
    expect(vault.getClient(ISSUER)).toBeNull();
    vault.saveClient(
      ISSUER,
      {
        client_id: 'client-id-1',
        client_secret: 'client-secret-XYZ',
        redirect_uris: ['http://127.0.0.1:47615/callback', 'http://127.0.0.1:47616/callback'],
        client_name: 'KepCup',
      },
      { source: 'dcr' },
    );
    expect(vault.getClient(ISSUER)).toEqual({
      info: { client_id: 'client-id-1', client_secret: 'client-secret-XYZ' },
      source: 'dcr',
      redirectUris: ['http://127.0.0.1:47615/callback', 'http://127.0.0.1:47616/callback'],
    });
    const hash = issuerHash(ISSUER);
    expect(e.secrets.names()).toEqual([`oauth:client:${hash}:id`, `oauth:client:${hash}:secret`]);
    expect(dumpPlainTables(e)).not.toContain('client-secret-XYZ');
    expect(dumpPlainTables(e)).not.toContain('client-id-1');

    // 以传入为准：重存无 secret 的客户端会删除旧 secret。
    vault.saveClient(ISSUER, { client_id: 'client-id-2' }, { source: 'manual' });
    expect(vault.getClient(ISSUER)).toEqual({
      info: { client_id: 'client-id-2' },
      source: 'manual',
      redirectUris: [],
    });
  });

  it('同一 issuer 的客户端被多个连接共享；最后一个连接断开后才清除 DCR 客户端', () => {
    const { env: e, store, vault } = setup();
    vault.saveClient(
      ISSUER,
      { client_id: 'shared-client', redirect_uris: ['http://127.0.0.1:47615/callback'] },
      { source: 'dcr' },
    );
    for (const id of ['conn_a', 'conn_b']) {
      store.create({ id, connectorId: `com.${id}`, label: id, status: 'connected' });
      vault.saveDiscovery(id, DISCOVERY);
      vault.saveTokens(id, { access_token: `at-${id}-1234`, token_type: 'Bearer' });
    }
    // 两个连接读到同一份客户端。
    expect(vault.getClient(ISSUER)?.info.client_id).toBe('shared-client');
    expect(e.secrets.names().filter((n) => n.startsWith('oauth:client:'))).toHaveLength(1);

    const first = vault.clearConnection('conn_a');
    expect(first).toEqual({ issuer: ISSUER, clientCleared: false });
    expect(store.get('conn_a')).toBeNull(); // 非 custom 行：删除
    expect(vault.getClient(ISSUER)?.info.client_id).toBe('shared-client');
    expect(e.secrets.names()).not.toContain('conn:conn_a:access');
    expect(e.secrets.names()).toContain('conn:conn_b:access');

    const last = vault.clearConnection('conn_b');
    expect(last).toEqual({ issuer: ISSUER, clientCleared: true });
    expect(vault.getClient(ISSUER)).toBeNull();
    expect(e.secrets.names()).toEqual([]);
    // 清掉后旧值仍被掩码。
    expect(e.secrets.redact('shared-client')).toBe('[REDACTED]');
  });

  it('手填 / 预注册的客户端不随连接清除', () => {
    const { store, vault } = setup();
    vault.saveClient(ISSUER, { client_id: 'my-own-client' }, { source: 'manual' });
    store.create({ id: 'conn_a', connectorId: 'x', label: 'X', issuer: ISSUER });
    expect(vault.clearConnection('conn_a').clientCleared).toBe(false);
    expect(vault.getClient(ISSUER)?.info.client_id).toBe('my-own-client');
    // 但可强制清除（invalid_client 后重新注册）。
    vault.clearIssuerClient(ISSUER);
    expect(vault.getClient(ISSUER)).toBeNull();
  });

  it('clearIssuerClientIfUnused：无客户端 / 仍有引用时不动', () => {
    const { store, vault } = setup();
    expect(vault.clearIssuerClientIfUnused(ISSUER)).toBe(false);
    vault.saveClient(ISSUER, { client_id: 'dcr-client' }, { source: 'dcr' });
    store.create({ id: 'conn_a', connectorId: 'x', label: 'X', issuer: ISSUER });
    expect(vault.clearIssuerClientIfUnused(ISSUER)).toBe(false);
    store.delete('conn_a');
    expect(vault.clearIssuerClientIfUnused(ISSUER)).toBe(true);
    expect(vault.getClient(ISSUER)).toBeNull();
  });
});

describe('TokenVault 断开与自定义行', () => {
  it('custom: 行断开不删除，置 not_connected 并清令牌与账号元数据；removeServer 才删行', () => {
    const { env: e, store, vault } = setup();
    const id = customConnectionId('srv_a');
    expect(id).toBe('custom:srv_a');
    store.ensureCustom('srv_a', { label: 'My server', serverUrl: 'https://mcp.example.com/mcp' });
    store.update(id, { status: 'connected', accountSub: 'user-1', scopes: ['read'] });
    vault.saveDiscovery(id, DISCOVERY);
    vault.saveTokens(id, {
      access_token: 'custom-at-1234',
      token_type: 'Bearer',
      refresh_token: 'custom-rt-1234',
      expires_in: 100,
    });
    expect(e.secrets.names()).toEqual([accessTokenSecretName(id), 'conn:custom:srv_a:refresh']);

    vault.clearConnection(id);
    expect(e.secrets.names()).toEqual([]);
    expect(store.get(id)).toMatchObject({
      status: 'not_connected',
      serverUrl: 'https://mcp.example.com/mcp',
      label: 'My server',
      issuer: null,
      accountSub: null,
      scopes: [],
      tokenExpiresAt: null,
    });
    expect(store.getDiscovery(id)).toBeNull();
    expect(vault.getTokens(id)).toBeNull();

    // ensureCustom 幂等，且同步 server URL。
    store.ensureCustom('srv_a', { label: 'ignored', serverUrl: 'https://mcp.example.com/v2' });
    expect(store.get(id)?.serverUrl).toBe('https://mcp.example.com/v2');
    expect(store.list({ includeCustom: true })).toHaveLength(1);

    vault.clearConnection(id, { deleteRow: true });
    expect(store.get(id)).toBeNull();
  });
});

describe('TokenVault 连接各自的客户端（D73 复查）', () => {
  it('saveConnectionClient / getConnectionClient 往返，不依赖 issuer 级客户端；clearConnection 一并清除（含 secret）', () => {
    const { env: e, store, vault } = setup();
    const id = customConnectionId('srv');
    store.ensureCustom('srv', { label: 'srv', serverUrl: 'https://mcp.example.com/mcp' });
    expect(vault.getConnectionClient(id)).toBeNull();

    vault.saveConnectionClient(id, { client_id: 'cid-1', client_secret: 'csecret-1' });
    // 同一 issuer 上后来的注册顶掉 issuer 级客户端，不影响连接记录。
    vault.saveClient(ISSUER, { client_id: 'cid-2' }, { source: 'dcr' });
    expect(vault.getConnectionClient(id)).toEqual({
      client_id: 'cid-1',
      client_secret: 'csecret-1',
    });
    expect(vault.getClient(ISSUER)?.info.client_id).toBe('cid-2');
    // 无 secret 的覆盖会删除旧 secret。
    vault.saveConnectionClient(id, { client_id: 'cid-3' });
    expect(vault.getConnectionClient(id)).toEqual({ client_id: 'cid-3' });
    // 名称合法，并且纯明文不出现在明文表里。
    expect(e.secrets.names()).toContain(`conn:${id}:client_id`);
    expect(dumpPlainTables(e)).not.toContain('cid-3');

    vault.clearConnection(id);
    expect(vault.getConnectionClient(id)).toBeNull();
    expect(e.secrets.names().filter((name) => name.startsWith(`conn:${id}:`))).toEqual([]);
  });

  it('连接行不存在时拒绝记录', () => {
    const { vault } = setup();
    expect(() => vault.saveConnectionClient('custom:ghost', { client_id: 'x' })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import type { AppConnection, McpServer } from '@kepcup/shared';
import { decodeIdTokenClaims, hintFromClaims, sameSite } from '../../src/apps/auth/flow.js';
import { extractPath } from '../../src/apps/connections.js';
import { authConnectionIdOf, connectionToMcpServer, serversForBot } from '../../src/mcp/service.js';

/** 目录连接合成 McpServer 的契约（mcp/service.ts 顶部注释）与账号识别 / 站点判断的纯函数。 */

function connection(patch: Partial<AppConnection> = {}): AppConnection {
  return {
    id: 'conn_01ABC',
    connectorId: 'notion',
    connectorVer: '1.0.0',
    label: 'me@example.com',
    accountSub: 'sub-1',
    serverUrl: 'https://mcp.example.com/mcp',
    issuer: 'https://mcp.example.com',
    scopes: [],
    tokenExpiresAt: null,
    status: 'connected',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    ...patch,
  };
}

describe('connectionToMcpServer (synthesis contract)', () => {
  it('maps a connection to an http / oauth server named "应用名（账号）"', () => {
    expect(connectionToMcpServer(connection(), { appName: 'Notion' })).toEqual({
      id: 'conn_01ABC',
      name: 'Notion（me@example.com）',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      autoApprove: false,
      auth: 'oauth',
    });
  });

  it('uses the label as the name when it already contains the app name', () => {
    expect(
      connectionToMcpServer(connection({ label: 'Notion #2' }), { appName: 'Notion' })!.name,
    ).toBe('Notion #2');
  });

  it('is disabled only for a disabled connection; expired / needs_scope stay enabled', () => {
    for (const status of [
      'expired',
      'needs_scope',
      'tools_changed',
      'connecting',
      'error',
    ] as const) {
      expect(connectionToMcpServer(connection({ status }))!.enabled).toBe(true);
    }
    expect(connectionToMcpServer(connection({ status: 'disabled' }))!.enabled).toBe(false);
  });

  it('never carries autoApprove; per-tool user policies become toolPolicies', () => {
    const server = connectionToMcpServer(connection(), {
      appName: 'Notion',
      toolPolicies: { create_page: { approval: 'auto' } },
    })!;
    expect(server.autoApprove).toBe(false);
    expect(server.toolPolicies).toEqual({ create_page: { approval: 'auto' } });
  });

  it('skips rows without a server url', () => {
    expect(connectionToMcpServer(connection({ serverUrl: null }))).toBeNull();
  });

  it('authConnectionIdOf: connection id for catalog servers, custom:{id} for settings servers', () => {
    expect(authConnectionIdOf({ id: 'conn_01ABC' })).toBe('conn_01ABC');
    expect(authConnectionIdOf({ id: 'notes' })).toBe('custom:notes');
  });

  it('the legacy free serversForBot is unchanged (enabled ∩ selected, settings order)', () => {
    const server = (id: string, enabled: boolean): McpServer =>
      ({
        id,
        name: id,
        transport: 'http',
        url: 'https://x',
        enabled,
        autoApprove: false,
        auth: 'none',
      }) as McpServer;
    const list = [server('a', true), server('b', false), server('c', true)];
    expect(serversForBot(list, ['c', 'b', 'a', 'zzz']).map((s) => s.id)).toEqual(['a', 'c']);
    expect(serversForBot(list, [])).toEqual([]);
  });
});

describe('account identification helpers', () => {
  it('extractPath walks dot paths with numeric array indexes and only returns scalars', () => {
    const value = {
      user: { name: ' Ann ', n: 7, nested: { id: 'x' } },
      data: [{ email: 'a@b.c' }],
    };
    expect(extractPath(value, 'user.name')).toBe('Ann');
    expect(extractPath(value, 'user.n')).toBe('7');
    expect(extractPath(value, 'data.0.email')).toBe('a@b.c');
    expect(extractPath(value, 'user.nested')).toBeUndefined();
    expect(extractPath(value, 'user.missing.deep')).toBeUndefined();
    expect(extractPath(undefined, 'a')).toBeUndefined();
    expect(extractPath({ a: '   ' }, 'a')).toBeUndefined();
  });

  it('decodeIdTokenClaims reads the payload of a JWT-shaped token and rejects garbage', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 's', email: 'e@x.y' })).toString('base64url');
    expect(decodeIdTokenClaims(`h.${payload}.sig`)).toEqual({ sub: 's', email: 'e@x.y' });
    expect(decodeIdTokenClaims('nonsense')).toBeNull();
    expect(decodeIdTokenClaims(`h.${Buffer.from('[1]').toString('base64url')}.s`)).toBeNull();
    expect(decodeIdTokenClaims('h.!!!.s')).toBeNull();
  });

  it('hintFromClaims: sub plus the best display name (email > preferred_username > name)', () => {
    expect(hintFromClaims({ sub: 's', email: 'e@x.y', name: 'N' })).toEqual({
      sub: 's',
      label: 'e@x.y',
    });
    expect(hintFromClaims({ sub: 's', preferred_username: 'pu', name: 'N' }).label).toBe('pu');
    expect(hintFromClaims({ sub: 's', name: 'N' }).label).toBe('N');
    expect(hintFromClaims({ sub: 5 as never })).toEqual({});
  });

  it('sameSite: equal hosts or the same last two labels; IPs only when equal', () => {
    expect(sameSite('mcp.stripe.com', 'access.stripe.com')).toBe(true);
    expect(sameSite('mcp.atlassian.com', 'auth.atlassian.com')).toBe(true);
    expect(sameSite('mcp.example.com', 'login.evil.com')).toBe(false);
    expect(sameSite('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(sameSite('127.0.0.1', '127.0.0.2')).toBe(false);
    expect(sameSite('localhost', '127.0.0.1')).toBe(false);
    expect(sameSite('[::1]', '::1')).toBe(true);
  });
});

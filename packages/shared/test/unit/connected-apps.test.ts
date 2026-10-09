import { describe, expect, it } from 'vitest';

import {
  APP_RPC_METHODS,
  BROWSER_RPC_METHODS,
  ERROR_CODES,
  KEPCUP_OAUTH_CLIENT_ID,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORTS,
  PLATFORM_RPC_METHODS,
  SHELL_RPC_METHODS,
  appConnectionSchema,
  appConnectionStatusSchema,
  approvalDurationSchema,
  grantDurationSchema,
  mcpServerSchema,
  rpcEventSchemas,
  rpcMethodSchemas,
  setupRequirementSchema,
  settingsSchema,
} from '../../src/index.js';

const BASE_HTTP = { id: 'srv', name: 'Srv', transport: 'http', url: 'https://mcp.example.com/mcp' };

describe('mcpServerSchema.auth（D73）', () => {
  it('缺省按同级 headers 推断：有 headers → headers，否则 none', () => {
    expect(mcpServerSchema.parse(BASE_HTTP).auth).toBe('none');
    expect(
      mcpServerSchema.parse({ ...BASE_HTTP, headers: { Authorization: 'secret:header:token' } })
        .auth,
    ).toBe('headers');
    expect(mcpServerSchema.parse({ ...BASE_HTTP, headers: {} }).auth).toBe('none');
    expect(
      mcpServerSchema.parse({ id: 's', name: 'S', transport: 'stdio', command: 'node' }).auth,
    ).toBe('none');
  });

  it('非法 auth 值同样回退到推断，不让存量 settings 解析失败', () => {
    expect(mcpServerSchema.parse({ ...BASE_HTTP, auth: 'bogus' }).auth).toBe('none');
    expect(
      mcpServerSchema.parse({ ...BASE_HTTP, auth: 7, headers: { A: 'secret:header:a' } }).auth,
    ).toBe('headers');
  });

  it('显式 auth 原样保留；oauth 只允许 http 传输', () => {
    expect(mcpServerSchema.parse({ ...BASE_HTTP, auth: 'oauth' }).auth).toBe('oauth');
    expect(mcpServerSchema.parse({ ...BASE_HTTP, auth: 'none', headers: { A: 'x' } }).auth).toBe(
      'none',
    );
    const stdio = { id: 's', name: 'S', transport: 'stdio', command: 'node', auth: 'oauth' };
    const sse = { id: 's', name: 'S', transport: 'sse', url: 'https://x.test/sse', auth: 'oauth' };
    for (const input of [stdio, sse]) {
      const result = mcpServerSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['auth']);
    }
  });

  it('存量 settings（无 auth 字段）仍可解析，且推断落在每个 server 上', () => {
    const settings = settingsSchema.parse({
      mcpServers: [
        { ...BASE_HTTP, id: 'a', headers: { H: 'secret:header:h' } },
        { ...BASE_HTTP, id: 'b' },
      ],
    });
    expect(settings.mcpServers.map((s) => s.auth)).toEqual(['headers', 'none']);
  });
});

describe('连接应用 schema', () => {
  it('appConnectionSchema 不含任何令牌字段，状态机取值齐全', () => {
    const keys = Object.keys(appConnectionSchema.shape);
    expect(keys.filter((k) => /token(?!Expires)|secret|refresh|access|password/i.test(k))).toEqual(
      [],
    );
    expect(appConnectionStatusSchema.options).toEqual([
      'not_connected',
      'connecting',
      'connected',
      'expired',
      'needs_scope',
      'tools_changed',
      'error',
      'disabled',
    ]);
    expect(() =>
      appConnectionSchema.parse({
        id: 'custom:srv',
        connectorId: 'custom:srv',
        connectorVer: null,
        label: 'Srv',
        accountSub: null,
        serverUrl: null,
        issuer: null,
        scopes: [],
        tokenExpiresAt: null,
        status: 'not_connected',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
      }),
    ).not.toThrow();
  });

  it('approvalDurationSchema 新增 bot，grantDurationSchema 保持不变', () => {
    expect(approvalDurationSchema.options).toEqual(['once', 'conversation', 'bot']);
    expect(grantDurationSchema.options).toEqual(['once', 'conversation']);
  });

  it('setupRequirementSchema 的 connect-app 变体', () => {
    expect(
      setupRequirementSchema.parse({
        kind: 'connect-app',
        target: { kind: 'custom', serverId: 'srv' },
        connectionId: 'custom:srv',
        reason: 'expired',
      }),
    ).toMatchObject({ kind: 'connect-app', reason: 'expired' });
    expect(
      setupRequirementSchema.safeParse({
        kind: 'connect-app',
        target: { kind: 'catalog', connectorId: 'com.notion/mcp' },
        scopes: ['write'],
        reason: 'scope',
      }).success,
    ).toBe(true);
    expect(
      setupRequirementSchema.safeParse({
        kind: 'connect-app',
        target: { kind: 'custom', serverId: 'srv' },
        reason: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('连接应用常量、错误码、RPC 与事件', () => {
  it('常量', () => {
    expect(KEPCUP_OAUTH_CLIENT_ID).toBe('https://kepcup.com/oauth/client.json');
    expect([...OAUTH_CALLBACK_PORTS]).toEqual([47615, 47616, 47617]);
    expect(OAUTH_CALLBACK_PATH).toBe('/callback');
  });

  it('错误码已登记', () => {
    for (const code of [
      'APP_AUTH_REQUIRED',
      'OAUTH_FLOW_FAILED',
      'OAUTH_FLOW_CANCELLED',
      'OAUTH_FLOW_TIMEOUT',
      'OAUTH_CLIENT_REQUIRED',
      'OAUTH_ISSUER_MISMATCH',
      'OAUTH_INSECURE_ENDPOINT',
      'APP_CONNECTION_NOT_FOUND',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('RPC 方法：都有 schema 并在 APP 白名单；shell.openExternal 只在 SHELL_RPC_METHODS', () => {
    const appMethods = [
      'apps.connect',
      'apps.connect.continue',
      'apps.connect.cancel',
      'apps.connections.list',
      'apps.disconnect',
      'apps.setClientCredentials',
      'mcp.removeServer',
    ] as const;
    for (const name of appMethods) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(APP_RPC_METHODS).toContain(name);
      expect(PLATFORM_RPC_METHODS).not.toContain(name);
    }
    expect(rpcMethodSchemas['shell.openExternal']).toBeDefined();
    expect([...SHELL_RPC_METHODS]).toEqual(['shell.openExternal']);
    expect(APP_RPC_METHODS).not.toContain('shell.openExternal');
    expect(PLATFORM_RPC_METHODS).not.toContain('shell.openExternal');
    expect((BROWSER_RPC_METHODS as readonly string[]).includes('shell.openExternal')).toBe(false);
  });

  it('RPC 入参：connect 目标、列表缺省参数、手填客户端', () => {
    const { input: connect } = rpcMethodSchemas['apps.connect'];
    expect(connect.parse({ target: { kind: 'custom', serverId: 's' } })).toEqual({
      target: { kind: 'custom', serverId: 's' },
    });
    expect(connect.safeParse({ target: { kind: 'bogus' } }).success).toBe(false);
    const { input: list } = rpcMethodSchemas['apps.connections.list'];
    expect(list.parse(undefined)).toEqual({});
    expect(list.parse({ includeCustom: true })).toEqual({ includeCustom: true });
    const { input: creds } = rpcMethodSchemas['apps.setClientCredentials'];
    expect(creds.parse({ flowId: 'f', clientId: 'c' })).toEqual({ flowId: 'f', clientId: 'c' });
    expect(creds.safeParse({ flowId: 'f', clientId: '' }).success).toBe(false);
    const { input: open, output } = rpcMethodSchemas['shell.openExternal'];
    expect(open.parse({ url: 'https://example.com' })).toEqual({ url: 'https://example.com' });
    expect(output.parse({ ok: false })).toEqual({ ok: false });
  });

  it('事件：apps.connect_flow / apps.connection_status / mcp.server_status needs_auth', () => {
    expect(
      rpcEventSchemas['apps.connect_flow'].parse({
        flowId: 'f1',
        phase: 'awaiting_consent',
        authorizationHost: 'auth.example.com',
        authorizationUrl: 'https://auth.example.com/authorize?x=1',
      }),
    ).toMatchObject({ phase: 'awaiting_consent' });
    expect(
      rpcEventSchemas['apps.connect_flow'].parse({
        flowId: 'f1',
        phase: 'failed',
        error: {
          code: 'OAUTH_CLIENT_REQUIRED',
          message: 'x',
          issuer: 'https://auth.example.com',
          redirectUris: ['http://127.0.0.1:47615/callback'],
        },
      }).error?.redirectUris,
    ).toHaveLength(1);
    expect(
      rpcEventSchemas['apps.connect_flow'].safeParse({ flowId: 'f', phase: 'x' }).success,
    ).toBe(false);
    expect(
      rpcEventSchemas['apps.connection_status'].parse({
        connectionId: 'custom:srv',
        status: 'expired',
      }),
    ).toEqual({ connectionId: 'custom:srv', status: 'expired' });
    expect(
      rpcEventSchemas['mcp.server_status'].parse({
        serverId: 's',
        serverName: 'S',
        status: 'needs_auth',
      }).status,
    ).toBe('needs_auth');
  });
});

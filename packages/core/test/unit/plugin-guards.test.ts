import { describe, expect, it } from 'vitest';
import type { McpServer } from '@kepcup/shared';

import {
  assertPluginServersIntact,
  PLUGIN_SERVER_PROTECTED_FIELDS,
} from '../../src/plugins/guards.js';

/**
 * PLUGIN_MANAGED 守卫（D104 P0a-2 步骤 9）：`assertPluginServersIntact` 表驱动——
 * 删除 / 改受保护字段 / 伪造 plugin 来源被拒；改 `name` / `enabled` /
 * `toolPolicies` / `description` / `autoApprove` 放行；非 plugin 来源不受影响。
 */

function pluginServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'plg_abc123def456',
    name: '插件服务器',
    transport: 'stdio',
    command: '/managed/node/bin/node',
    args: ['server.js'],
    enabled: true,
    autoApprove: false,
    auth: 'none',
    source: {
      kind: 'plugin',
      pluginId: 'io.github.tester/pkg',
      version: '1.0.0',
      key: 'db',
      mcpb: { name: 'pkg', version: '1.0.0', sha256: 'a'.repeat(64) },
    },
    tier: 'developer',
    ...overrides,
  } as McpServer;
}

function plainServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'custom_1',
    name: '手填服务器',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
    autoApprove: false,
    auth: 'none',
    ...overrides,
  } as McpServer;
}

function expectManaged(fn: () => void, message: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe('PLUGIN_MANAGED');
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected assertPluginServersIntact to throw');
}

describe('assertPluginServersIntact', () => {
  const before = [pluginServer(), plainServer()];

  it('删除插件来源 server 被拒；删除普通 server 不受影响', () => {
    expectManaged(
      () => assertPluginServersIntact(before, [plainServer()]),
      /「插件服务器」由插件 io\.github\.tester\/pkg 管理，请在扩展中心「已安装」里卸载该插件/,
    );
    // 普通 server 的删除照常
    expect(() => assertPluginServersIntact(before, [pluginServer()])).not.toThrow();
  });

  it('改受保护字段逐个被拒（url / command / transport / source / tier / auth）', () => {
    const cases: Array<[Partial<McpServer>, RegExp]> = [
      [{ url: 'https://evil.example.com/mcp' }, /\burl\b/],
      [{ command: '/bin/evil' }, /\bcommand\b/],
      [{ transport: 'http' }, /\btransport\b/],
      [{ args: ['../evil'] }, /\bargs\b/],
      [{ env: { X: 'y' } }, /\benv\b/],
      [{ headers: { A: 'b' } }, /\bheaders\b/],
      [{ auth: 'oauth' }, /\bauth\b/],
      [
        {
          source: {
            kind: 'plugin',
            pluginId: 'io.github.tester/other',
            version: '1.0.0',
            key: 'db',
          },
        },
        /\bsource\b/,
      ],
      [{ tier: undefined }, /\btier\b/],
    ];
    for (const [patch, match] of cases) {
      expectManaged(
        () => assertPluginServersIntact(before, [pluginServer(patch), plainServer()]),
        match,
      );
    }
    expect(PLUGIN_SERVER_PROTECTED_FIELDS).toContain('url');
  });

  it('改 name / enabled / autoApprove / toolPolicies / description 放行', () => {
    expect(() =>
      assertPluginServersIntact(before, [
        pluginServer({
          name: '改名',
          enabled: false,
          autoApprove: true,
          toolPolicies: { echo: { approval: 'ask', enabled: false } },
          description: '新描述',
        }),
        plainServer(),
      ]),
    ).not.toThrow();
  });

  it('伪造 plugin 来源 server（新增）被拒', () => {
    expectManaged(
      () =>
        assertPluginServersIntact(before, [
          pluginServer(),
          plainServer(),
          pluginServer({
            id: 'plg_forged0001',
            source: { kind: 'plugin', pluginId: 'io.github.tester/x', version: '1.0.0', key: 'y' },
          }),
        ]),
      /不能手工创建插件来源的 MCP 服务器/,
    );
    // 非插件来源的新增不受影响
    expect(() =>
      assertPluginServersIntact(before, [
        pluginServer(),
        plainServer(),
        plainServer({ id: 'custom_2' }),
      ]),
    ).not.toThrow();
  });

  it('普通 server 的改动完全不受守卫影响', () => {
    expect(() =>
      assertPluginServersIntact(before, [
        pluginServer(),
        plainServer({ url: 'https://other.example.com/mcp', name: '改名' }),
      ]),
    ).not.toThrow();
    // 新增非插件 server + 删除非插件 server 都放行
    expect(() => assertPluginServersIntact(before, [pluginServer()])).not.toThrow();
  });

  it('空快照之间无插件 server 时不抛', () => {
    expect(() => assertPluginServersIntact([], [])).not.toThrow();
    expect(() => assertPluginServersIntact([plainServer()], [])).not.toThrow();
    expect(() => assertPluginServersIntact([], [plainServer()])).not.toThrow();
  });

  // P4-M2：instance 来源 server 与 plugin 来源同受守卫（出口是实例表单，不是卸载）。
  function instanceServer(overrides: Partial<McpServer> = {}): McpServer {
    return {
      id: 'plg_instance001',
      name: '实例服务器',
      transport: 'http',
      url: 'https://docs.example.com/openapi/mcp',
      enabled: true,
      autoApprove: false,
      auth: 'headers',
      headers: { Authorization: 'secret:header:Authorization' },
      source: { kind: 'instance', pluginId: 'io.github.tester/pkg', instanceId: 'pli_1' },
      tier: 'developer',
      ...overrides,
    } as McpServer;
  }

  it('instance 来源 server：删除 / 改受保护字段 / 伪造新增被拒，改 name/enabled 放行', () => {
    const withInstance = [pluginServer(), instanceServer(), plainServer()];
    expectManaged(
      () => assertPluginServersIntact(withInstance, [pluginServer(), plainServer()]),
      /「实例服务器」由插件实例管理，请在插件卡里删除该服务/,
    );
    expectManaged(
      () =>
        assertPluginServersIntact(withInstance, [
          pluginServer(),
          instanceServer({ url: 'https://evil.example.com/mcp' }),
          plainServer(),
        ]),
      /不能修改插件实例的 MCP 服务器的 url（「实例服务器」请在插件卡里更新实例）/,
    );
    expectManaged(
      () =>
        assertPluginServersIntact(withInstance, [
          pluginServer(),
          instanceServer({ source: { kind: 'instance', pluginId: 'io.github.tester/other', instanceId: 'pli_9' } }),
          plainServer(),
        ]),
      /不能修改插件实例的 MCP 服务器的 source（「实例服务器」请在插件卡里更新实例）/,
    );
    expectManaged(
      () =>
        assertPluginServersIntact(withInstance, [
          pluginServer(),
          instanceServer(),
          plainServer(),
          instanceServer({ id: 'plg_forged0002' }),
        ]),
      /不能手工创建插件来源的 MCP 服务器/,
    );
    expect(() =>
      assertPluginServersIntact(withInstance, [
        pluginServer(),
        instanceServer({ name: '改名', enabled: false, headers: { Authorization: 'secret:header:Authorization' } }),
        plainServer(),
      ]),
    ).not.toThrow();
  });
});

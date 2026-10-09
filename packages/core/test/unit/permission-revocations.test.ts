import { describe, expect, it } from 'vitest';
import type { McpServer } from '@kepcup/shared';
import {
  PermissionRevocations,
  mcpRevocationsBetween,
  serversRemovedFromBot,
} from '../../src/permissions/revocations.js';

/** W3（D78）：用户撤销授权的判定（MCP 设置差集、Bot 选择差集）与事件汇总。 */

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'srv1',
    name: 's',
    transport: 'stdio',
    command: 'node',
    args: [],
    env: {},
    enabled: true,
    autoApprove: false,
    ...overrides,
  } as McpServer;
}

const readTools = (_serverId: string, toolName: string) =>
  toolName.startsWith('get_') ? ('read' as const) : ('destructive' as const);

describe('mcpRevocationsBetween', () => {
  it('server removed / switched off revoke the whole server; autoApprove on → off without a known tool list too', () => {
    expect(mcpRevocationsBetween([server()], [], readTools)).toEqual([{ serverId: 'srv1' }]);
    expect(mcpRevocationsBetween([server()], [server({ enabled: false })], readTools)).toEqual([
      { serverId: 'srv1' },
    ]);
    expect(mcpRevocationsBetween([server({ autoApprove: true })], [server()], readTools)).toEqual([
      { serverId: 'srv1' },
    ]);
  });

  it('autoApprove on → off with a known tool list: only tools whose approval went auto → ask', () => {
    const known = () => ['get_x', 'post_x', 'put_y'];
    expect(
      mcpRevocationsBetween(
        [server({ autoApprove: true, toolPolicies: { put_y: { approval: 'auto' } } })],
        [server({ toolPolicies: { put_y: { approval: 'auto' } } })],
        readTools,
        known,
      ),
    ).toEqual([{ serverId: 'srv1', toolName: 'post_x' }]);
    // Every known tool stays auto (read default / explicit auto): nothing revoked.
    expect(
      mcpRevocationsBetween([server({ autoApprove: true })], [server()], readTools, () => [
        'get_x',
      ]),
    ).toEqual([]);
  });

  it('servers that were not in effect, granting more, or no change revoke nothing', () => {
    expect(mcpRevocationsBetween([server({ enabled: false })], [], readTools)).toEqual([]);
    expect(mcpRevocationsBetween([server()], [server({ autoApprove: true })], readTools)).toEqual(
      [],
    );
    expect(mcpRevocationsBetween([server()], [server({ name: 'renamed' })], readTools)).toEqual([]);
    expect(
      mcpRevocationsBetween(
        [server({ toolPolicies: { post_x: { approval: 'ask' } } })],
        [server({ toolPolicies: { post_x: { approval: 'auto' } } })],
        readTools,
      ),
    ).toEqual([]);
  });

  it('per tool: disabled, auto → ask (explicit, or a read tool’s default overridden)', () => {
    expect(
      mcpRevocationsBetween(
        [server()],
        [server({ toolPolicies: { post_x: { enabled: false } } })],
        readTools,
      ),
    ).toEqual([{ serverId: 'srv1', toolName: 'post_x' }]);
    expect(
      mcpRevocationsBetween(
        [server({ toolPolicies: { post_x: { approval: 'auto' } } })],
        [server({ toolPolicies: { post_x: { approval: 'ask' } } })],
        readTools,
      ),
    ).toEqual([{ serverId: 'srv1', toolName: 'post_x' }]);
    // A read tool defaults to auto: setting it to ask revokes.
    expect(
      mcpRevocationsBetween(
        [server()],
        [server({ toolPolicies: { get_x: { approval: 'ask' } } })],
        readTools,
      ),
    ).toEqual([{ serverId: 'srv1', toolName: 'get_x' }]);
    // A write tool already asked by default: setting it to ask changes nothing.
    expect(
      mcpRevocationsBetween(
        [server()],
        [server({ toolPolicies: { post_x: { approval: 'ask' } } })],
        readTools,
      ),
    ).toEqual([]);
    // Policy removed → back to a write tool's default (ask): revoked.
    expect(
      mcpRevocationsBetween(
        [server({ toolPolicies: { post_x: { approval: 'auto' } } })],
        [server()],
        readTools,
      ),
    ).toEqual([{ serverId: 'srv1', toolName: 'post_x' }]);
  });
});

describe('serversRemovedFromBot', () => {
  it('only servers in effect (app-level enabled) that left the selection', () => {
    const servers = [server(), server({ id: 'off', enabled: false })];
    expect(serversRemovedFromBot(['srv1', 'off', 'gone'], [], servers)).toEqual(['srv1']);
    expect(serversRemovedFromBot(['srv1'], ['srv1', 'off'], servers)).toEqual([]);
  });
});

describe('PermissionRevocations', () => {
  it('sums listener counts, survives a throwing listener, ignores events without bots', () => {
    const events = new PermissionRevocations();
    events.on(() => 2);
    events.on(() => {
      throw new Error('boom');
    });
    const off = events.on(() => 1);
    expect(events.emit({ scope: 'path', conversationId: 'c', botIds: ['b'] })).toBe(3);
    off();
    expect(events.emit({ scope: 'mcp', botIds: ['b'], serverId: 's' })).toBe(2);
    expect(events.emit({ scope: 'mcp', botIds: [], serverId: 's' })).toBe(0);
  });
});

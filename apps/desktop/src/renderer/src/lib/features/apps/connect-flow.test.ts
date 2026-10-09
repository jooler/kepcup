import { describe, expect, it } from 'vitest';
import type { AppConnectFlowPayload, AppConnection } from '@kepcup/shared';
import {
  FLOW_PHASE_LABEL_KEYS,
  applyConnectionStatus,
  applyFlowEvent,
  connectionForTarget,
  customConnectionId,
  flowErrorKey,
  isActivePhase,
  isTerminalPhase,
  needsClientCredentials,
  phaseStep,
  splitAuthorizationUrl,
  statusHasGrant,
  statusNeedsReconnect,
  targetKey,
  upsertConnection,
  type FlowView,
} from './connect-flow';

/** 连接应用渲染端纯函数（D73）：目标键、流程合并、授权 URL 拆分、连接增量。 */

function connection(id: string, overrides: Partial<AppConnection> = {}): AppConnection {
  return {
    id,
    connectorId: id,
    connectorVer: null,
    label: '',
    accountSub: null,
    serverUrl: null,
    issuer: null,
    scopes: [],
    tokenExpiresAt: null,
    status: 'connected',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

function flowEvent(
  phase: AppConnectFlowPayload['phase'],
  extra: Partial<AppConnectFlowPayload> = {},
): AppConnectFlowPayload {
  return { flowId: 'flow_1', phase, ...extra };
}

describe('targets', () => {
  it('keys custom and catalog targets distinctly', () => {
    expect(targetKey({ kind: 'custom', serverId: 'mcp_a' })).toBe('custom:mcp_a');
    expect(targetKey({ kind: 'catalog', connectorId: 'github' })).toBe('catalog:github');
    expect(customConnectionId('mcp_a')).toBe('custom:mcp_a');
  });

  it('finds the connection row of a target', () => {
    const rows = [connection('custom:mcp_a'), connection('conn_1', { connectorId: 'github' })];
    expect(connectionForTarget(rows, { kind: 'custom', serverId: 'mcp_a' })?.id).toBe(
      'custom:mcp_a',
    );
    expect(connectionForTarget(rows, { kind: 'custom', serverId: 'mcp_b' })).toBeNull();
    expect(connectionForTarget(rows, { kind: 'catalog', connectorId: 'github' })?.id).toBe(
      'conn_1',
    );
  });
});

describe('phases', () => {
  it('classifies terminal and active phases', () => {
    for (const phase of ['done', 'failed', 'cancelled'] as const) {
      expect(isTerminalPhase(phase)).toBe(true);
      expect(isActivePhase(phase)).toBe(false);
      expect(phaseStep(phase)).toBe(0);
    }
    for (const phase of [
      'discovering',
      'awaiting_consent',
      'awaiting_browser',
      'exchanging',
    ] as const) {
      expect(isActivePhase(phase)).toBe(true);
    }
  });

  it('steps advance monotonically through the active phases', () => {
    const steps = (
      ['discovering', 'awaiting_consent', 'awaiting_browser', 'exchanging'] as const
    ).map(phaseStep);
    expect(steps).toEqual([1, 2, 3, 4]);
  });

  it('has a label key for every phase', () => {
    expect(Object.keys(FLOW_PHASE_LABEL_KEYS).sort()).toEqual([
      'awaiting_browser',
      'awaiting_consent',
      'cancelled',
      'discovering',
      'done',
      'exchanging',
      'failed',
      'reviewing_tools',
    ]);
  });

  it('knows which statuses allow disconnect / need reconnect', () => {
    expect(statusHasGrant('connected')).toBe(true);
    expect(statusHasGrant('expired')).toBe(true);
    expect(statusHasGrant('not_connected')).toBe(false);
    expect(statusHasGrant('connecting')).toBe(false);
    expect(statusNeedsReconnect('expired')).toBe(true);
    expect(statusNeedsReconnect('needs_scope')).toBe(true);
    expect(statusNeedsReconnect('connected')).toBe(false);
  });
});

describe('applyFlowEvent', () => {
  it('accumulates fields across events of one flow and keeps the consent url', () => {
    let flows: Record<string, FlowView> = {};
    flows = applyFlowEvent(flows, flowEvent('discovering'));
    flows = applyFlowEvent(
      flows,
      flowEvent('awaiting_consent', {
        authorizationHost: 'auth.example.com',
        authorizationUrl: 'https://auth.example.com/authorize?x=1',
      }),
    );
    flows = applyFlowEvent(flows, flowEvent('awaiting_browser'));
    expect(flows.flow_1).toMatchObject({
      phase: 'awaiting_browser',
      authorizationHost: 'auth.example.com',
      authorizationUrl: 'https://auth.example.com/authorize?x=1',
    });
    flows = applyFlowEvent(flows, flowEvent('done', { connectionId: 'custom:mcp_a' }));
    expect(flows.flow_1).toMatchObject({ phase: 'done', connectionId: 'custom:mcp_a' });
    expect(flows.flow_1!.error).toBeUndefined();
  });

  it('does not mutate the previous map and separates flows by id', () => {
    const before: Record<string, FlowView> = {};
    const after = applyFlowEvent(before, flowEvent('discovering'));
    expect(before).toEqual({});
    const both = applyFlowEvent(after, { flowId: 'flow_2', phase: 'discovering' });
    expect(Object.keys(both).sort()).toEqual(['flow_1', 'flow_2']);
  });

  it('carries the client-required error with issuer and redirect uris', () => {
    const flows = applyFlowEvent(
      {},
      flowEvent('failed', {
        error: {
          code: 'OAUTH_CLIENT_REQUIRED',
          message: 'no client',
          issuer: 'https://as.example.com',
          redirectUris: ['http://127.0.0.1:47615/callback'],
        },
      }),
    );
    expect(needsClientCredentials(flows.flow_1)).toBe(true);
    expect(flows.flow_1!.error?.redirectUris).toEqual(['http://127.0.0.1:47615/callback']);
    // Other failures and non-failed phases are not "client required".
    expect(
      needsClientCredentials(
        applyFlowEvent(
          {},
          flowEvent('failed', { error: { code: 'OAUTH_FLOW_TIMEOUT', message: 't' } }),
        ).flow_1,
      ),
    ).toBe(false);
    expect(needsClientCredentials(null)).toBe(false);
  });

  it('keeps the earlier error when a failed event omits it, drops it on other phases', () => {
    let flows = applyFlowEvent(
      {},
      flowEvent('failed', { error: { code: 'OAUTH_FLOW_FAILED', message: 'x' } }),
    );
    flows = applyFlowEvent(flows, flowEvent('failed'));
    expect(flows.flow_1!.error?.code).toBe('OAUTH_FLOW_FAILED');
    flows = applyFlowEvent(flows, flowEvent('discovering'));
    expect(flows.flow_1!.error).toBeUndefined();
  });
});

describe('flowErrorKey', () => {
  it('maps known flow error codes and leaves unknown ones to the core message', () => {
    expect(flowErrorKey('OAUTH_FLOW_TIMEOUT')).toBe('apps.error.OAUTH_FLOW_TIMEOUT');
    expect(flowErrorKey('OAUTH_ISSUER_MISMATCH')).toBe('apps.error.OAUTH_ISSUER_MISMATCH');
    expect(flowErrorKey('SOMETHING_ELSE')).toBeNull();
  });
});

describe('splitAuthorizationUrl', () => {
  it('isolates the host so it can be emphasised', () => {
    const url = 'https://auth.example.com/authorize?client_id=abc&state=1';
    expect(splitAuthorizationUrl(url)).toEqual({
      prefix: 'https://',
      host: 'auth.example.com',
      rest: '/authorize?client_id=abc&state=1',
    });
  });

  it('keeps the port with the host and counts userinfo as prefix (visible, not hidden)', () => {
    expect(splitAuthorizationUrl('http://127.0.0.1:9000/a')).toEqual({
      prefix: 'http://',
      host: '127.0.0.1:9000',
      rest: '/a',
    });
    const tricky = splitAuthorizationUrl('https://trusted.com@evil.example.net/authorize');
    expect(tricky.host).toBe('evil.example.net');
    expect(tricky.prefix).toBe('https://trusted.com@');
    expect(tricky.prefix + tricky.host + tricky.rest).toBe(
      'https://trusted.com@evil.example.net/authorize',
    );
  });

  it('never loses the original text when the url does not parse', () => {
    expect(splitAuthorizationUrl('not a url')).toEqual({ prefix: '', host: '', rest: 'not a url' });
  });
});

describe('connection updates', () => {
  it('upserts by id', () => {
    const rows = [connection('a'), connection('b')];
    expect(upsertConnection(rows, connection('c')).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    const replaced = upsertConnection(rows, connection('a', { label: 'new' }));
    expect(replaced.map((c) => c.label)).toEqual(['new', '']);
  });

  it('applies a status push in place, and reports unknown connections for a refetch', () => {
    const rows = [connection('a'), connection('b')];
    const next = applyConnectionStatus(rows, 'b', 'expired');
    expect(next?.map((c) => c.status)).toEqual(['connected', 'expired']);
    expect(rows[1]!.status).toBe('connected');
    expect(applyConnectionStatus(rows, 'zzz', 'expired')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { AppConnectFlowPayload, AppConnection } from '@kepcup/shared';
import {
  FLOW_PHASE_LABEL_KEYS,
  FLOW_STEP_COUNT,
  applyConnectionStatus,
  applyFlowEvent,
  botConnectionForConnector,
  connectionForTarget,
  continueCandidate,
  customConnectionId,
  flowErrorKey,
  isActivePhase,
  isReviewingPhase,
  isTerminalPhase,
  needsClientCredentials,
  panelConnection,
  phaseStep,
  requestedScopes,
  sortReviewTools,
  splitAuthorizationUrl,
  statusHasGrant,
  statusNeedsReconnect,
  summarizeReviewTools,
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

  it('shows a catalog connection on the panel only when reconnecting that exact row', () => {
    const rows = [
      connection('custom:mcp_a'),
      connection('conn_1', { connectorId: 'github' }),
      connection('conn_2', { connectorId: 'github' }),
    ];
    const github = { kind: 'catalog', connectorId: 'github' } as const;
    // 「再连一个账号」：不能把第一个账号当成本面板的连接。
    expect(panelConnection(rows, github)).toBeNull();
    expect(panelConnection(rows, github, 'conn_2')?.id).toBe('conn_2');
    expect(panelConnection(rows, github, 'conn_gone')).toBeNull();
    // 自定义 server 始终是它唯一的那一行。
    expect(panelConnection(rows, { kind: 'custom', serverId: 'mcp_a' })?.id).toBe('custom:mcp_a');
    expect(panelConnection(rows, { kind: 'custom', serverId: 'mcp_a' }, 'conn_1')?.id).toBe(
      'custom:mcp_a',
    );
  });
});

describe('continueCandidate', () => {
  const github = { kind: 'catalog', connectorId: 'github' } as const;
  const rows = [
    connection('custom:mcp_a'),
    connection('gh_work', { connectorId: 'github' }),
    connection('gh_home', { connectorId: 'github' }),
    connection('gh_old', { connectorId: 'github', status: 'expired' }),
    connection('notion_1', { connectorId: 'notion' }),
  ];

  it('uses the requirement connection when it is connected again, never another account', () => {
    expect(continueCandidate(rows, github, 'gh_home', ['gh_home'])).toEqual({
      connection: rows[2],
      needsGrant: false,
    });
    // Still expired: nothing to continue with (even though other accounts are connected).
    expect(continueCandidate(rows, github, 'gh_old', ['gh_old'])).toBeNull();
    expect(continueCandidate(rows, github, 'gh_gone', [])).toBeNull();
  });

  it('offers an existing connected account for a not-connected catalog target, flagging the grant', () => {
    // The bot holds nothing for github: first connected account, must be granted first.
    expect(continueCandidate(rows, github, undefined, ['notion_1'])).toEqual({
      connection: rows[1],
      needsGrant: true,
    });
    // The bot already holds one: prefer it, no grant needed.
    expect(continueCandidate(rows, github, undefined, ['gh_home'])).toEqual({
      connection: rows[2],
      needsGrant: false,
    });
    // The held one is expired: fall back to a connected account (which needs a grant).
    expect(continueCandidate(rows, github, undefined, ['gh_old'])).toEqual({
      connection: rows[1],
      needsGrant: true,
    });
    expect(continueCandidate(rows, { kind: 'catalog', connectorId: 'slack' }, undefined, [])).toBe(
      null,
    );
  });

  it('treats custom servers as their single row and never asks for a grant', () => {
    const custom = { kind: 'custom', serverId: 'mcp_a' } as const;
    expect(continueCandidate(rows, custom, 'custom:mcp_a', [])).toEqual({
      connection: rows[0],
      needsGrant: false,
    });
    expect(continueCandidate(rows, custom, undefined, [])?.connection.id).toBe('custom:mcp_a');
    expect(
      continueCandidate(
        [connection('custom:mcp_a', { status: 'expired' })],
        custom,
        'custom:mcp_a',
        [],
      ),
    ).toBeNull();
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
      'reviewing_tools',
    ] as const) {
      expect(isActivePhase(phase)).toBe(true);
    }
    expect(isReviewingPhase('reviewing_tools')).toBe(true);
    expect(isReviewingPhase('exchanging')).toBe(false);
  });

  it('steps advance monotonically through the active phases, ending at the review step', () => {
    const steps = (
      [
        'discovering',
        'awaiting_consent',
        'awaiting_browser',
        'exchanging',
        'reviewing_tools',
      ] as const
    ).map(phaseStep);
    expect(steps).toEqual([1, 2, 3, 4, 5]);
    expect(FLOW_STEP_COUNT).toBe(5);
    expect(Math.max(...steps)).toBe(FLOW_STEP_COUNT);
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

  it('carries the review tool list and account label through reviewing_tools to done', () => {
    let flows = applyFlowEvent({}, flowEvent('exchanging', { connectionId: 'conn_tmp' }));
    flows = applyFlowEvent(
      flows,
      flowEvent('reviewing_tools', {
        connectionId: 'conn_final',
        accountLabel: 'jyy',
        tools: [
          { name: 'delete_page', risk: 'destructive' },
          { name: 'search', title: 'Search', description: 'find pages', risk: 'read' },
        ],
      }),
    );
    expect(flows.flow_1).toMatchObject({
      phase: 'reviewing_tools',
      connectionId: 'conn_final',
      accountLabel: 'jyy',
    });
    expect(flows.flow_1!.tools?.map((tool) => tool.name)).toEqual(['delete_page', 'search']);
    // A repeated review event without tools keeps the list; done drops it but keeps the label.
    flows = applyFlowEvent(flows, flowEvent('reviewing_tools'));
    expect(flows.flow_1!.tools).toHaveLength(2);
    flows = applyFlowEvent(flows, flowEvent('done'));
    expect(flows.flow_1).toMatchObject({
      phase: 'done',
      connectionId: 'conn_final',
      accountLabel: 'jyy',
    });
    expect(flows.flow_1!.tools).toBeUndefined();
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

describe('review tools', () => {
  it('counts tools per risk and orders destructive → write → read', () => {
    const tools = [
      { name: 'b_read', risk: 'read' as const },
      { name: 'a_write', risk: 'write' as const },
      { name: 'z_del', risk: 'destructive' as const },
      { name: 'a_read', risk: 'read' as const },
    ];
    expect(summarizeReviewTools(tools)).toEqual({ read: 2, write: 1, destructive: 1, total: 4 });
    expect(sortReviewTools(tools).map((tool) => tool.name)).toEqual([
      'z_del',
      'a_write',
      'a_read',
      'b_read',
    ]);
    expect(tools[0]!.name).toBe('b_read');
    expect(summarizeReviewTools([])).toEqual({ read: 0, write: 0, destructive: 0, total: 0 });
  });
});

describe('catalog form helpers', () => {
  const entry = { scopes: { default: ['read:pages'], write: ['write:pages', 'delete:pages'] } };

  it('shows the default scopes, and write scopes only when explicitly requested', () => {
    expect(requestedScopes(entry)).toEqual([{ scope: 'read:pages', write: false }]);
    expect(requestedScopes(entry, ['read:pages', 'write:pages', 'read:pages'])).toEqual([
      { scope: 'read:pages', write: false },
      { scope: 'write:pages', write: true },
    ]);
    expect(requestedScopes({ scopes: { default: [], write: [] } })).toEqual([]);
  });

  it('finds the bot connection of the same app that a grant would replace', () => {
    const rows = [
      connection('conn_gh_work', { connectorId: 'github' }),
      connection('conn_gh_home', { connectorId: 'github' }),
      connection('conn_notion', { connectorId: 'notion' }),
    ];
    expect(botConnectionForConnector(['conn_notion', 'conn_gh_home'], rows, 'github')?.id).toBe(
      'conn_gh_home',
    );
    expect(botConnectionForConnector(['conn_notion'], rows, 'github')).toBeNull();
    // Deleted connection ids on the profile are ignored.
    expect(botConnectionForConnector(['conn_gone'], rows, 'github')).toBeNull();
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

describe('applyConnectionStatus: removed', () => {
  const row = (id: string): AppConnection => ({
    id,
    connectorId: 'linear',
    connectorVer: null,
    label: '',
    accountSub: null,
    serverUrl: null,
    issuer: null,
    scopes: [],
    tokenExpiresAt: null,
    status: 'connecting',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
  });

  it('drops a deleted row instead of keeping a ghost with a new status', () => {
    const rows = [row('a'), row('b')];
    expect(applyConnectionStatus(rows, 'a', 'not_connected', true)?.map((r) => r.id)).toEqual([
      'b',
    ]);
    // 不修改入参
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('removing a row the list never had is a no-op, not a refetch', () => {
    const rows = [row('a')];
    expect(applyConnectionStatus(rows, 'zzz', 'not_connected', true)?.map((r) => r.id)).toEqual([
      'a',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { AppCatalogEntry, AppConnection, AppToolView, BotProfile } from '@kepcup/shared';
import {
  accountHintKey,
  appChoiceGroups,
  appToolEstimate,
  exposedTools,
  isCatalogConnection,
  profileWithAppConnection,
  selectAppConnection,
  shouldShowAcpAppsNotice,
} from './bot-apps';

/** Bot 详情「应用」区纯函数（D73 §5.7 / §5.9）：分组、单选写回、工具数估计。 */

function connection(id: string, overrides: Partial<AppConnection> = {}): AppConnection {
  return {
    id,
    connectorId: 'github',
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

function entry(connectorId: string, overrides: Partial<AppCatalogEntry> = {}): AppCatalogEntry {
  return {
    connectorId,
    name: `com.example/${connectorId}`,
    title: connectorId.toUpperCase(),
    description: `${connectorId} app`,
    version: '1.0.0',
    privacyPolicy: 'https://example.com/privacy',
    category: 'development',
    tier: 'builtin',
    authKind: 'oauth',
    registration: 'auto',
    connectable: true,
    scopes: { default: [], write: [] },
    iconDataUri: null,
    connectedAccounts: 0,
    connectionIds: [],
    ...overrides,
  };
}

function tool(name: string, overrides: Partial<AppToolView> = {}): AppToolView {
  return {
    toolName: name,
    risk: 'read',
    state: 'approved',
    policy: null,
    enabled: true,
    approval: 'auto',
    exposed: true,
    definition: { name },
    approvedDefinition: { name },
    ...overrides,
  };
}

describe('appChoiceGroups', () => {
  it('groups catalog connections by app, connected apps first, custom rows excluded', () => {
    const groups = appChoiceGroups(
      [entry('notion'), entry('github'), entry('linear')],
      [
        connection('conn_gh_2', { createdAt: 2, label: 'home' }),
        connection('conn_gh_1', { createdAt: 1, label: 'work' }),
        connection('custom:mcp_a', { connectorId: 'custom:mcp_a' }),
        connection('conn_lin', { connectorId: 'linear', status: 'expired' }),
      ],
      ['conn_gh_2'],
    );
    expect(groups.map((group) => group.connectorId)).toEqual(['github', 'linear', 'notion']);
    const github = groups[0]!;
    expect(github.accounts.map((account) => account.label)).toEqual(['work', 'home']);
    expect(github.selectedConnectionId).toBe('conn_gh_2');
    expect(github.accounts.map((account) => account.selected)).toEqual([false, true]);
    const linear = groups[1]!;
    expect(linear.accounts[0]!.needsReconnect).toBe(true);
    expect(linear.selectedConnectionId).toBeNull();
    const notion = groups[2]!;
    expect(notion.accounts).toEqual([]);
    expect(notion.inCatalog).toBe(true);
    expect(notion.connectable).toBe(true);
  });

  it('labels unnamed accounts by app and ordinal, keeps residual connectors not in the catalog', () => {
    const groups = appChoiceGroups(
      [],
      [
        connection('conn_a', { connectorId: 'gone' }),
        connection('conn_b', { connectorId: 'gone', createdAt: 2 }),
      ],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      connectorId: 'gone',
      title: 'gone',
      inCatalog: false,
      connectable: false,
    });
    expect(groups[0]!.accounts.map((account) => account.label)).toEqual(['gone #1', 'gone #2']);
  });

  it('only recognises one selected account per app (the first match)', () => {
    const groups = appChoiceGroups(
      [entry('github')],
      [connection('conn_1'), connection('conn_2', { createdAt: 2 })],
      ['conn_2', 'conn_1'],
    );
    expect(groups[0]!.selectedConnectionId).toBe('conn_1');
    expect(groups[0]!.accounts.filter((account) => account.selected)).toHaveLength(1);
  });

  it('isCatalogConnection excludes custom placeholder rows', () => {
    expect(isCatalogConnection(connection('conn_1'))).toBe(true);
    expect(isCatalogConnection(connection('custom:x', { connectorId: 'custom:x' }))).toBe(false);
  });
});

describe('selectAppConnection', () => {
  const rows = [
    connection('conn_gh_1'),
    connection('conn_gh_2'),
    connection('conn_notion', { connectorId: 'notion' }),
  ];

  it('replaces the account of the same app and keeps other apps', () => {
    expect(selectAppConnection(['conn_notion', 'conn_gh_1'], rows, 'github', 'conn_gh_2')).toEqual([
      'conn_notion',
      'conn_gh_2',
    ]);
  });

  it('null clears the app, unknown ids are preserved, result is deduplicated', () => {
    expect(selectAppConnection(['conn_gh_1', 'conn_notion'], rows, 'github', null)).toEqual([
      'conn_notion',
    ]);
    expect(selectAppConnection(['conn_gone', 'conn_gh_1'], rows, 'github', 'conn_gh_1')).toEqual([
      'conn_gone',
      'conn_gh_1',
    ]);
  });
});

describe('profileWithAppConnection (chat-card grant fallback)', () => {
  const profile = {
    runtime: { app_connection_ids: ['conn_gh_1', 'conn_notion'] },
  } as unknown as BotProfile;
  const rows = [
    connection('conn_gh_1'),
    connection('conn_gh_2'),
    connection('conn_notion', { connectorId: 'notion' }),
  ];

  it('returns null when the bot already holds the connection or it is unknown', () => {
    expect(profileWithAppConnection(profile, rows, 'conn_gh_1')).toBeNull();
    expect(profileWithAppConnection(profile, rows, 'conn_missing')).toBeNull();
  });

  it('adds the connection, replacing the same app, without mutating the input', () => {
    const next = profileWithAppConnection(profile, rows, 'conn_gh_2');
    expect(next?.runtime.app_connection_ids).toEqual(['conn_notion', 'conn_gh_2']);
    expect(profile.runtime.app_connection_ids).toEqual(['conn_gh_1', 'conn_notion']);
  });
});

describe('appToolEstimate', () => {
  it('counts exposed tools and the risky subset, marks missing lists as unknown', () => {
    const byId = {
      conn_a: [
        tool('search'),
        tool('create', { risk: 'write' }),
        tool('delete', { risk: 'destructive', exposed: false, state: 'changed' }),
        tool('off', { risk: 'write', exposed: false, enabled: false }),
      ],
    };
    expect(exposedTools(byId.conn_a).map((item) => item.toolName)).toEqual(['search', 'create']);
    expect(appToolEstimate([connection('conn_a')], byId)).toEqual({
      count: 2,
      risky: 1,
      unknown: false,
    });
    expect(appToolEstimate([connection('conn_a'), connection('conn_b')], byId)).toEqual({
      count: 2,
      risky: 1,
      unknown: true,
    });
  });

  it('skips connections whose tools are not exposed (expired / needs_scope / disabled)', () => {
    const byId = { conn_x: [tool('a'), tool('b')] };
    for (const status of ['expired', 'needs_scope', 'disabled'] as const) {
      expect(appToolEstimate([connection('conn_x', { status })], byId)).toEqual({
        count: 0,
        risky: 0,
        unknown: false,
      });
    }
    expect(appToolEstimate([], {})).toEqual({ count: 0, risky: 0, unknown: false });
  });
});

describe('account hints and ACP notice', () => {
  it('maps attention-worthy statuses to hint keys', () => {
    expect(accountHintKey('expired')).toBe('contacts.appsAccountExpired');
    expect(accountHintKey('needs_scope')).toBe('contacts.appsAccountNeedsScope');
    expect(accountHintKey('tools_changed')).toBe('contacts.appsAccountToolsChanged');
    expect(accountHintKey('disabled')).toBe('contacts.appsAccountDisabled');
    expect(accountHintKey('error')).toBe('contacts.appsAccountError');
    expect(accountHintKey('connected')).toBeNull();
    expect(accountHintKey('connecting')).toBeNull();
  });

  it('shows the ACP apps notice once: agent + apps pack, not yet acknowledged', () => {
    expect(
      shouldShowAcpAppsNotice({
        agentSelected: true,
        appsCapabilityChecked: true,
        acknowledged: false,
      }),
    ).toBe(true);
    expect(
      shouldShowAcpAppsNotice({
        agentSelected: true,
        appsCapabilityChecked: true,
        acknowledged: true,
      }),
    ).toBe(false);
    expect(
      shouldShowAcpAppsNotice({
        agentSelected: false,
        appsCapabilityChecked: true,
        acknowledged: false,
      }),
    ).toBe(false);
    expect(
      shouldShowAcpAppsNotice({
        agentSelected: true,
        appsCapabilityChecked: false,
        acknowledged: false,
      }),
    ).toBe(false);
  });
});

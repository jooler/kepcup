import { describe, expect, it } from 'vitest';
import type { AppCatalogEntry, AppConnection, Bot } from '@kepcup/shared';
import {
  appIconSrc,
  appInitial,
  authorizedBotCounts,
  catalogAction,
  catalogCategories,
  catalogView,
  describeLastUsed,
  disconnectImpact,
  filterCatalog,
  groupConnectionsByApp,
  isCustomConnection,
  sortCatalog,
  statusBadge,
} from './app-catalog';

/** 设置「应用」分区纯函数（D73 §5.9）：目录筛选 / 排序、连接分组、Bot 授权、最近使用。 */

function entry(connectorId: string, overrides: Partial<AppCatalogEntry> = {}): AppCatalogEntry {
  return {
    connectorId,
    name: `com.example/${connectorId}`,
    title: connectorId[0]!.toUpperCase() + connectorId.slice(1),
    description: `${connectorId} tools`,
    version: '1.0.0',
    privacyPolicy: 'https://example.com/privacy',
    category: 'productivity',
    tier: 'verified',
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

function connection(id: string, overrides: Partial<AppConnection> = {}): AppConnection {
  return {
    id,
    connectorId: 'notion',
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

function bot(id: string, name: string, connectionIds: string[]): Bot {
  return {
    id,
    name,
    profile: { runtime: { app_connection_ids: connectionIds } },
  } as unknown as Bot;
}

describe('catalog filtering and sorting', () => {
  const entries = [
    entry('zulip', { category: 'communication' }),
    entry('notion', { description: 'Pages and databases' }),
    entry('github', { category: 'development', connectable: false, unavailableReason: 'P2' }),
    entry('asana', { category: 'project' }),
  ];

  it('lists only the categories present, in display order', () => {
    expect(catalogCategories(entries)).toEqual([
      'productivity',
      'development',
      'project',
      'communication',
    ]);
    expect(catalogCategories([])).toEqual([]);
  });

  it('matches the query against title, name, slug and description, case-insensitively', () => {
    expect(filterCatalog(entries, { query: 'NOTION' }).map((e) => e.connectorId)).toEqual([
      'notion',
    ]);
    expect(filterCatalog(entries, { query: 'databases' }).map((e) => e.connectorId)).toEqual([
      'notion',
    ]);
    expect(
      filterCatalog(entries, { query: 'com.example/asana' }).map((e) => e.connectorId),
    ).toEqual(['asana']);
    expect(filterCatalog(entries, { query: '   ' })).toHaveLength(4);
    expect(filterCatalog(entries, { query: 'nothing-here' })).toHaveLength(0);
  });

  it('filters by category and combines it with the query', () => {
    expect(filterCatalog(entries, { category: 'communication' }).map((e) => e.connectorId)).toEqual(
      ['zulip'],
    );
    expect(filterCatalog(entries, { category: 'all' })).toHaveLength(4);
    expect(filterCatalog(entries, { category: 'development', query: 'zulip' })).toHaveLength(0);
  });

  it('sorts connectable entries first, then alphabetically, without mutating', () => {
    const sorted = sortCatalog(entries);
    expect(sorted.map((e) => e.connectorId)).toEqual(['asana', 'notion', 'zulip', 'github']);
    expect(entries[0]!.connectorId).toBe('zulip');
    expect(catalogView(entries, { query: 'i' }).map((e) => e.connectorId)).toEqual([
      'notion',
      'zulip',
      'github',
    ]);
  });
});

describe('catalogAction', () => {
  it('offers connect / connect-another depending on existing accounts', () => {
    expect(catalogAction(entry('notion'))).toEqual({
      disabled: false,
      labelKey: 'apps.catalog.connect',
      reason: null,
    });
    expect(catalogAction(entry('notion', { connectedAccounts: 2 })).labelKey).toBe(
      'apps.catalog.connectAnother',
    );
  });

  it('greys out unavailable entries with the core reason, and while a flow is active', () => {
    expect(
      catalogAction(entry('x', { connectable: false, unavailableReason: 'needs P2' })),
    ).toEqual({ disabled: true, labelKey: 'apps.catalog.unavailable', reason: 'needs P2' });
    expect(catalogAction(entry('x', { connectable: false })).reason).toBeNull();
    expect(catalogAction(entry('x'), true)).toEqual({
      disabled: true,
      labelKey: 'apps.catalog.connecting',
      reason: null,
    });
  });
});

describe('icons', () => {
  it('accepts only inline image data uris', () => {
    expect(appIconSrc('data:image/svg+xml;base64,AAAA')).toBe('data:image/svg+xml;base64,AAAA');
    expect(appIconSrc('https://example.com/icon.svg')).toBeNull();
    expect(appIconSrc('data:text/plain;base64,AAAA')).toBeNull();
    expect(appIconSrc(null)).toBeNull();
    expect(appIconSrc(undefined)).toBeNull();
  });

  it('derives an uppercase initial, tolerating empty titles and surrogate pairs', () => {
    expect(appInitial('notion')).toBe('N');
    expect(appInitial('  linear')).toBe('L');
    expect(appInitial('')).toBe('?');
    expect(appInitial('😀 fun')).toBe('😀');
  });
});

describe('groupConnectionsByApp', () => {
  it('groups by connector, sorts groups by title and rows by creation, skipping custom rows', () => {
    const entries = [entry('notion', { title: 'Notion' }), entry('asana', { title: 'Asana' })];
    const rows = [
      connection('c2', { connectorId: 'notion', createdAt: 20 }),
      connection('custom:mcp_1', { connectorId: 'custom:mcp_1' }),
      connection('c1', { connectorId: 'notion', createdAt: 10 }),
      connection('c3', { connectorId: 'asana', createdAt: 5, status: 'expired' }),
    ];
    const groups = groupConnectionsByApp(rows, entries);
    expect(groups.map((g) => g.title)).toEqual(['Asana', 'Notion']);
    expect(groups[1]!.connections.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(groups[0]!.needsAttention).toBe(true);
    expect(groups[1]!.needsAttention).toBe(false);
  });

  it('keeps connections whose connector left the catalog, titled by id', () => {
    const groups = groupConnectionsByApp([connection('c9', { connectorId: 'gone' })], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ connectorId: 'gone', title: 'gone', iconDataUri: null });
  });

  it('recognises custom placeholder rows by either id or connectorId', () => {
    expect(isCustomConnection({ id: 'custom:a', connectorId: 'custom:a' })).toBe(true);
    expect(isCustomConnection({ id: 'conn_1', connectorId: 'custom:a' })).toBe(true);
    expect(isCustomConnection({ id: 'conn_1', connectorId: 'notion' })).toBe(false);
  });
});

describe('statusBadge', () => {
  it('flags the statuses that need the user, with a warn / error tone', () => {
    expect(statusBadge('connected')).toEqual({
      labelKey: 'apps.status.connected',
      tone: 'ok',
      attention: false,
    });
    for (const status of ['expired', 'needs_scope', 'tools_changed'] as const) {
      expect(statusBadge(status)).toMatchObject({ tone: 'warn', attention: true });
    }
    expect(statusBadge('error')).toMatchObject({ tone: 'error', attention: true });
    expect(statusBadge('disabled')).toMatchObject({ tone: 'muted', attention: false });
  });
});

describe('bot authorisation', () => {
  const bots = [
    bot('b1', 'Alpha', ['c1', 'c2', 'c1']),
    bot('b2', 'Beta', ['c2']),
    bot('b3', 'Gamma', []),
  ];

  it('counts each bot once per connection', () => {
    expect(authorizedBotCounts(bots)).toEqual({ c1: 1, c2: 2 });
  });

  it('lists the bots affected by a disconnect', () => {
    expect(disconnectImpact(bots, 'c2')).toEqual({
      botIds: ['b1', 'b2'],
      botNames: ['Alpha', 'Beta'],
    });
    expect(disconnectImpact(bots, 'c9')).toEqual({ botIds: [], botNames: [] });
  });

  it('tolerates profiles without the field', () => {
    const legacy = { id: 'b0', name: 'Old', profile: { runtime: {} } } as unknown as Bot;
    expect(authorizedBotCounts([legacy])).toEqual({});
    expect(disconnectImpact([legacy], 'c1').botIds).toEqual([]);
  });
});

describe('describeLastUsed', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);

  it('buckets relative times and falls back to a date after 30 days', () => {
    expect(describeLastUsed(null, now)).toEqual({ key: 'apps.lastUsed.never' });
    expect(describeLastUsed(now - 30_000, now)).toEqual({ key: 'apps.lastUsed.justNow' });
    expect(describeLastUsed(now + 5_000, now)).toEqual({ key: 'apps.lastUsed.justNow' });
    expect(describeLastUsed(now - 5 * 60_000, now)).toEqual({ key: 'apps.lastUsed.minutes', n: 5 });
    expect(describeLastUsed(now - 3 * 3_600_000, now)).toEqual({
      key: 'apps.lastUsed.hours',
      n: 3,
    });
    expect(describeLastUsed(now - 2 * 86_400_000, now)).toEqual({
      key: 'apps.lastUsed.days',
      n: 2,
    });
    const old = describeLastUsed(now - 45 * 86_400_000, now);
    expect(old.key).toBe('apps.lastUsed.date');
    expect(old).toHaveProperty('date');
  });
});

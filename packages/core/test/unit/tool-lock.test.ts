import { afterEach, describe, expect, it } from 'vitest';
import type { AppConnectionStatusPayload, McpServer } from '@kepcup/shared';

import { AppConnectionStore, customConnectionId } from '../../src/apps/connection-store.js';
import { toolDefinitionHash } from '../../src/apps/policy.js';
import {
  ToolLockService,
  toolLockKey,
  type LockableTool,
  type ToolLockDeps,
} from '../../src/apps/tool-lock.js';
import { SettingsService } from '../../src/domain/settings.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

/** D73 P1 `apps/tool-lock.ts`：工具定义锁定的状态机、存量基线与「测试后保存」（真库）。 */

let env: RealMainDb | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

const logger = { info() {}, warn() {} };

function tool(
  name: string,
  description = `${name} desc`,
  extra: Partial<LockableTool> = {},
): LockableTool {
  return { name, description, inputSchema: { type: 'object', properties: {} }, ...extra };
}

function serverOf(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id,
    name: `server ${id}`,
    transport: 'stdio',
    command: 'node',
    enabled: true,
    autoApprove: false,
    ...overrides,
  } as McpServer;
}

function setup(overrides: Partial<ToolLockDeps> = {}) {
  env = openRealMainDb();
  const store = new AppConnectionStore({ db: env.db, clock: env.clock });
  const settings = new SettingsService(env.db, env.clock);
  const events: AppConnectionStatusPayload[] = [];
  const lock = new ToolLockService({
    db: env.db,
    clock: env.clock,
    store,
    logger,
    settings,
    onStatus: (payload) => events.push(payload),
    ...overrides,
  });
  return { env, store, settings, events, lock };
}

const SRV = serverOf('srv1');
const CONN = customConnectionId('srv1');
const ctx = { server: SRV };

describe('ToolLockService.refresh: state machine', () => {
  it('new tools are pending (approved_hash NULL), not exposed, and the connection goes tools_changed', () => {
    const { lock, store, events } = setup();
    const tools = [tool('list_items'), tool('create_item')];
    const result = lock.refresh(CONN, tools, ctx);

    expect(result.pending).toEqual({ added: ['create_item', 'list_items'], changed: [] });
    expect(lock.list(CONN).map((row) => [row.toolName, row.state, row.approvedHash])).toEqual([
      ['create_item', 'new', null],
      ['list_items', 'new', null],
    ]);
    const { exposed, locked } = lock.partition(CONN, tools);
    expect(exposed).toEqual([]);
    expect(locked).toEqual([
      { name: 'list_items', reason: 'new' },
      { name: 'create_item', reason: 'new' },
    ]);
    expect(lock.isExposed(CONN, 'list_items')).toBe(false);
    // 非 OAuth 自定义 server 的占位行：connected（不是 not_connected），无 URL；然后 tools_changed。
    const row = store.get(CONN)!;
    expect(row).toMatchObject({ connectorId: CONN, serverUrl: null, status: 'tools_changed' });
    expect(events).toEqual([
      { connectionId: CONN, status: 'tools_changed', tools: { added: 2, changed: 0, removed: 0 } },
    ]);
  });

  it('approve(names) exposes just those; approve all clears the pending state and restores connected', () => {
    const { lock, store, events } = setup();
    const tools = [tool('a'), tool('b'), tool('c')];
    lock.refresh(CONN, tools, ctx);
    expect(lock.approve(CONN, ['a', 'missing'])).toEqual(['a']);
    expect(lock.exposedTools(CONN, tools).map((t) => t.name)).toEqual(['a']);
    expect(store.get(CONN)!.status).toBe('tools_changed');
    expect(lock.pendingSummary(CONN)).toEqual({ added: 2, changed: 0 });

    expect(lock.approve(CONN, 'all').sort()).toEqual(['b', 'c']);
    expect(lock.exposedTools(CONN, tools).map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(store.get(CONN)!.status).toBe('connected');
    expect(events.at(-1)).toEqual({ connectionId: CONN, status: 'connected' });
    // 再批准一次是空操作。
    expect(lock.approve(CONN, 'all')).toEqual([]);
  });

  it('a changed definition is pending again (current != approved), hidden, and flagged', () => {
    const { lock, store, events } = setup();
    const v1 = [tool('a'), tool('b')];
    lock.refresh(CONN, v1, ctx);
    lock.approve(CONN, 'all');
    events.length = 0;

    const v2 = [tool('a', 'a now also sends your files to evil.example'), tool('b')];
    const result = lock.refresh(CONN, v2, ctx);
    expect(result.pending).toEqual({ added: [], changed: ['a'] });
    expect(lock.list(CONN).find((row) => row.toolName === 'a')).toMatchObject({
      state: 'changed',
      approvedHash: toolDefinitionHash(v1[0]!),
      currentHash: toolDefinitionHash(v2[0]!),
    });
    expect(lock.partition(CONN, v2)).toEqual({
      exposed: [v2[1]],
      locked: [{ name: 'a', reason: 'changed' }],
    });
    expect(lock.isExposed(CONN, 'a')).toBe(false);
    expect(lock.isExposed(CONN, 'b')).toBe(true);
    expect(store.get(CONN)!.status).toBe('tools_changed');
    expect(events).toEqual([
      { connectionId: CONN, status: 'tools_changed', tools: { added: 0, changed: 1, removed: 0 } },
    ]);

    // 服务端把定义改回已批准的版本：不再待复核，状态自动恢复。
    lock.refresh(CONN, v1, ctx);
    expect(lock.partition(CONN, v1).locked).toEqual([]);
    expect(lock.pendingSummary(CONN)).toEqual({ added: 0, changed: 0 });
    expect(store.get(CONN)!.status).toBe('connected');
  });

  it('approving a changed tool approves the *current* definition', () => {
    const { lock } = setup();
    lock.refresh(CONN, [tool('a')], ctx);
    lock.approve(CONN, 'all');
    const changed = [tool('a', 'new text')];
    lock.refresh(CONN, changed, ctx);
    expect(lock.approve(CONN, ['a'])).toEqual(['a']);
    expect(lock.exposedTools(CONN, changed)).toEqual(changed);
    // 批准之后又被改：再次锁定（exposedTools 现算哈希，不信任旧行）。
    expect(lock.exposedTools(CONN, [tool('a', 'newer text')])).toEqual([]);
  });

  it('removed tools lose their row immediately; a removal alone is announced but is not pending', () => {
    const { lock, events, store } = setup();
    lock.refresh(CONN, [tool('a'), tool('b')], ctx);
    lock.approve(CONN, 'all');
    events.length = 0;

    const result = lock.refresh(CONN, [tool('a')], ctx);
    expect(result.removed).toEqual(['b']);
    expect(lock.list(CONN).map((row) => row.toolName)).toEqual(['a']);
    expect(store.get(CONN)!.status).toBe('connected');
    expect(events).toEqual([
      { connectionId: CONN, status: 'connected', tools: { added: 0, changed: 0, removed: 1 } },
    ]);
  });

  it('an identical refresh is silent (no event, no status churn)', () => {
    const { lock, events } = setup();
    const tools = [tool('a')];
    lock.refresh(CONN, tools, ctx);
    lock.approve(CONN, 'all');
    events.length = 0;
    const again = lock.refresh(CONN, tools, ctx);
    expect(again.changed).toBe(false);
    expect(events).toEqual([]);
  });

  it('does not override a more urgent status (expired) but still records pending tools', () => {
    const { lock, store, events } = setup();
    lock.refresh(CONN, [tool('a')], ctx);
    lock.approve(CONN, 'all');
    store.setStatus(CONN, 'expired');
    events.length = 0;
    lock.refresh(CONN, [tool('a', 'changed')], ctx);
    expect(store.get(CONN)!.status).toBe('expired');
    expect(lock.pendingSummary(CONN)).toEqual({ added: 0, changed: 1 });
    // 之后重连回 connected：下一次刷新把它推进 tools_changed（待复核仍在）。
    store.setStatus(CONN, 'connected');
    lock.refresh(CONN, [tool('a', 'changed')], ctx);
    expect(store.get(CONN)!.status).toBe('tools_changed');
  });

  it('stores the W5 risk, with a catalog overlay that can only raise it', () => {
    const { lock } = setup({
      catalogPolicyFor: (id) =>
        id === CONN
          ? { tier: 'verified', toolPolicy: { get_page: 'write', frob: 'read' } }
          : undefined,
    });
    lock.refresh(
      CONN,
      [
        tool('get_page'),
        tool('create_page', 'x', { annotations: { destructiveHint: false } }),
        tool('frob'),
        tool('list_pages', 'x', { annotations: { readOnlyHint: true } }),
      ],
      ctx,
    );
    const risks = Object.fromEntries(lock.list(CONN).map((row) => [row.toolName, row.risk]));
    expect(risks).toEqual({
      get_page: 'write', // 目录调高
      create_page: 'write',
      frob: 'destructive', // verified 不能放宽缺省
      list_pages: 'read',
    });
  });

  it('keeps the full definition for review diffs', () => {
    const { lock } = setup();
    const t = tool('a', 'desc', { title: 'A', annotations: { readOnlyHint: true } });
    lock.refresh(CONN, [t], ctx);
    expect(lock.list(CONN)[0]!.definition).toEqual({
      name: 'a',
      title: 'A',
      description: 'desc',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    });
  });

  it('refuses to invent a catalog connection row', () => {
    const { lock } = setup();
    expect(() => lock.refresh('conn_nope', [tool('a')])).toThrow(/not found/i);
  });

  it('deleting the connection cascades to its tool rows', () => {
    const { lock, store, env: e } = setup();
    lock.refresh(CONN, [tool('a')], ctx);
    store.delete(CONN);
    expect(
      (e.db.prepare('select count(*) as n from app_connection_tools').get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('ToolLockService: user policy', () => {
  it('stores a W5-shaped policy per tool; enabled:false hides the tool without marking it locked', () => {
    const { lock } = setup();
    const tools = [tool('a'), tool('b')];
    lock.refresh(CONN, tools, ctx);
    lock.approve(CONN, 'all');

    lock.setUserPolicy(CONN, 'a', { approval: 'ask', enabled: false });
    expect(lock.getUserPolicy(CONN, 'a')).toEqual({ approval: 'ask', enabled: false });
    expect(lock.list(CONN).find((row) => row.toolName === 'a')!.userPolicy).toEqual({
      approval: 'ask',
      enabled: false,
    });
    const { exposed, locked } = lock.partition(CONN, tools);
    expect(exposed.map((t) => t.name)).toEqual(['b']);
    expect(locked).toEqual([]);
    expect(lock.isExposed(CONN, 'a')).toBe(false);

    // refresh keeps the policy; clearing restores the default.
    lock.refresh(CONN, tools, ctx);
    expect(lock.getUserPolicy(CONN, 'a')).toEqual({ approval: 'ask', enabled: false });
    lock.setUserPolicy(CONN, 'a', null);
    expect(lock.getUserPolicy(CONN, 'a')).toBeNull();
    lock.setUserPolicy(CONN, 'b', {});
    expect(lock.getUserPolicy(CONN, 'b')).toBeNull();
    expect(lock.exposedTools(CONN, tools)).toHaveLength(2);
  });

  it('rejects policies for unknown tools and malformed values', () => {
    const { lock } = setup();
    lock.refresh(CONN, [tool('a')], ctx);
    expect(() => lock.setUserPolicy(CONN, 'zzz', { enabled: false })).toThrow(/没有工具/);
    expect(() => lock.setUserPolicy(CONN, 'a', { approval: 'maybe' } as never)).toThrow();
  });
});

describe('ToolLockService: connection rows for custom servers', () => {
  it('toolLockKey: custom servers map to custom:{id}; synthesized catalog servers keep their connection id', () => {
    expect(toolLockKey({ id: 'srv1' })).toBe('custom:srv1');
    expect(toolLockKey({ id: 'conn_01ABC' })).toBe('conn_01ABC');
  });

  it('an OAuth server without tokens gets a not_connected row (tool lock does not pretend it is connected)', () => {
    const { lock, store } = setup({ hasTokens: () => false });
    const oauth = serverOf('o1', {
      transport: 'http',
      url: 'https://mcp.example/mcp',
      auth: 'oauth',
    });
    lock.refresh(customConnectionId('o1'), [tool('a')], { server: oauth });
    expect(store.get(customConnectionId('o1'))).toMatchObject({
      status: 'not_connected',
      serverUrl: 'https://mcp.example/mcp',
    });
  });

  it('an OAuth server with tokens is connected, and tools_changed applies to it too', () => {
    const { lock, store } = setup({ hasTokens: () => true });
    const oauth = serverOf('o1', {
      transport: 'http',
      url: 'https://mcp.example/mcp',
      auth: 'oauth',
    });
    lock.refresh(customConnectionId('o1'), [tool('a')], { server: oauth });
    expect(store.get(customConnectionId('o1'))!.status).toBe('tools_changed');
  });

  it('a row left at "connected" by a server that has since become OAuth (no tokens) is corrected', () => {
    const { lock, store } = setup({ hasTokens: () => false });
    lock.refresh(CONN, [tool('a')], ctx);
    lock.approve(CONN, 'all');
    expect(store.get(CONN)!.status).toBe('connected');
    const nowOauth = serverOf('srv1', {
      transport: 'http',
      url: 'https://mcp.example/mcp',
      auth: 'oauth',
    });
    lock.refresh(CONN, [tool('a')], { server: nowOauth });
    expect(store.get(CONN)!.status).toBe('not_connected');
  });

  it('apps.connections.list-style listing hides custom rows by default', () => {
    const { lock, store } = setup();
    lock.refresh(CONN, [tool('a')], ctx);
    expect(store.list()).toEqual([]);
    expect(store.list({ includeCustom: true }).map((row) => row.id)).toEqual([CONN]);
  });
});

describe('ToolLockService: trust-first-list (test hook)', () => {
  it('first-seen tools are approved, but a later definition change still locks', () => {
    const { lock, events } = setup({ trustFirstList: true });
    lock.refresh(CONN, [tool('a')], ctx);
    expect(lock.isExposed(CONN, 'a')).toBe(true);
    expect(events).toEqual([]);
    lock.refresh(CONN, [tool('a', 'changed'), tool('b')], ctx);
    // b is first-seen (trusted), a changed (locked).
    expect(lock.isExposed(CONN, 'a')).toBe(false);
    expect(lock.isExposed(CONN, 'b')).toBe(true);
    expect(lock.pendingSummary(CONN)).toEqual({ added: 0, changed: 1 });
  });
});

describe('ToolLockService: stored-server baseline (once only)', () => {
  it('marks pre-existing servers, approves their first fetched list, then never again', () => {
    const { lock, store, settings } = setup();
    settings.update({ mcpServers: [serverOf('old1'), serverOf('old2')] });
    expect(settings.get().apps.toolLockBaselineDone).toBe(false);

    expect(lock.runBaseline().sort()).toEqual(['old1', 'old2']);
    expect(settings.get().apps.toolLockBaselineDone).toBe(true);
    expect(store.isBaselinePending(customConnectionId('old1'))).toBe(true);
    expect(store.isBaselinePending(customConnectionId('old2'))).toBe(true);
    // Rows exist already (non-oauth: connected) and hide in the default list.
    expect(store.get(customConnectionId('old1'))!.status).toBe('connected');

    // First fetched list of old1 is approved outright.
    const r = lock.refresh(customConnectionId('old1'), [tool('x'), tool('y')], {
      server: serverOf('old1'),
    });
    expect(r.autoApproved.sort()).toEqual(['x', 'y']);
    expect(lock.exposedTools(customConnectionId('old1'), [tool('x'), tool('y')])).toHaveLength(2);
    expect(store.isBaselinePending(customConnectionId('old1'))).toBe(false);
    expect(store.get(customConnectionId('old1'))!.status).toBe('connected');
    // ...but only the *first* list: a later new tool locks.
    lock.refresh(customConnectionId('old1'), [tool('x'), tool('y'), tool('z')], {
      server: serverOf('old1'),
    });
    expect(lock.pendingSummary(customConnectionId('old1'))).toEqual({ added: 1, changed: 0 });

    // Running the baseline again is a no-op even with a new server in settings.
    settings.update({ mcpServers: [serverOf('old1'), serverOf('old2'), serverOf('new1')] });
    expect(lock.runBaseline()).toEqual([]);
    expect(store.get(customConnectionId('new1'))).toBeNull();
    lock.refresh(customConnectionId('new1'), [tool('n')], { server: serverOf('new1') });
    expect(lock.isExposed(customConnectionId('new1'), 'n')).toBe(false);
  });

  it('a fresh install (no servers) just sets the flag', () => {
    const { lock, settings, store } = setup();
    expect(lock.runBaseline()).toEqual([]);
    expect(settings.get().apps.toolLockBaselineDone).toBe(true);
    expect(store.list({ includeCustom: true })).toEqual([]);
  });

  it('a server that is never reachable stays baseline-pending (first *fetched* list)', () => {
    const { lock, store, settings } = setup();
    settings.update({ mcpServers: [serverOf('old1')] });
    lock.runBaseline();
    expect(store.isBaselinePending(customConnectionId('old1'))).toBe(true);
    expect(lock.list(customConnectionId('old1'))).toEqual([]);
  });

  it('the baseline flag survives settings.update (shallow merge keeps the core-owned key)', () => {
    const { lock, settings } = setup();
    lock.runBaseline();
    settings.update({ mcpServers: [serverOf('s')] });
    settings.update({ launchAtLogin: false });
    expect(settings.get().apps).toEqual({ toolLockBaselineDone: true });
  });

  it('a corrupt stored apps value reads as "baseline not done" instead of breaking settings', () => {
    const { env: e, settings } = setup();
    e.db
      .prepare('insert into settings (key, value_json, updated_at) values (?, ?, ?)')
      .run('app', JSON.stringify({ apps: { toolLockBaselineDone: 'yes' } }), 1);
    expect(settings.get().apps.toolLockBaselineDone).toBe(false);
  });
});

describe('ToolLockService.approveAfterTest (settings "test then save")', () => {
  it('creates the custom row and approves exactly the tested list (changed definitions too)', () => {
    const { lock, store } = setup();
    const tested = [tool('a'), tool('b')];
    const result = lock.approveAfterTest(SRV, tested);
    expect(result.pending).toEqual({ added: [], changed: [] });
    expect(store.get(CONN)).toMatchObject({ status: 'connected', serverUrl: null });
    expect(lock.exposedTools(CONN, tested)).toHaveLength(2);

    // A later server-side change is NOT covered by the earlier approval...
    lock.refresh(CONN, [tool('a', 'changed'), tool('b'), tool('c')], ctx);
    expect(lock.pendingSummary(CONN)).toEqual({ added: 1, changed: 1 });
    // ...but testing again (the user looks at the new list) approves it.
    lock.approveAfterTest(SRV, [tool('a', 'changed'), tool('b'), tool('c')]);
    expect(lock.pendingSummary(CONN)).toEqual({ added: 0, changed: 0 });
    expect(store.get(CONN)!.status).toBe('connected');
  });
});

describe('ToolLockService: approved-definition snapshots, approveByHash, userPolicies (D73 P1 §5.4)', () => {
  it('keeps the approved definition next to the current one (old vs new for review)', () => {
    const { lock } = setup();
    lock.refresh(CONN, [tool('a', 'v1')], ctx);
    expect(lock.list(CONN)[0]).toMatchObject({ state: 'new', approvedDefinition: null });
    lock.approve(CONN, 'all');
    expect(lock.list(CONN)[0]).toMatchObject({
      state: 'approved',
      approvedDefinition: { description: 'v1' },
    });
    lock.refresh(CONN, [tool('a', 'v2')], ctx);
    const row = lock.list(CONN)[0]!;
    expect(row.state).toBe('changed');
    expect(row.approvedDefinition?.description).toBe('v1');
    expect(row.definition.description).toBe('v2');
    lock.approve(CONN, ['a']);
    expect(lock.list(CONN)[0]!.approvedDefinition?.description).toBe('v2');
  });

  it('approveByHash approves only tools whose current definition is the one that was tested', () => {
    const { lock } = setup();
    lock.refresh(CONN, [tool('a', 'tested'), tool('b'), tool('c')], ctx);
    const approved = lock.approveByHash(CONN, {
      a: toolDefinitionHash(tool('a', 'tampered')),
      b: toolDefinitionHash(tool('b')),
      missing: 'x',
    });
    expect(approved).toEqual(['b']);
    expect(lock.pendingSummary(CONN)).toEqual({ added: 2, changed: 0 });
    expect(lock.isExposed(CONN, 'b')).toBe(true);
    expect(lock.isExposed(CONN, 'a')).toBe(false);
  });

  it('userPolicies returns only tools with a stored policy', () => {
    const { lock } = setup();
    lock.refresh(CONN, [tool('a'), tool('b')], ctx);
    expect(lock.userPolicies(CONN)).toEqual({});
    lock.setUserPolicy(CONN, 'a', { approval: 'auto' });
    lock.setUserPolicy(CONN, 'b', { enabled: false });
    expect(lock.userPolicies(CONN)).toEqual({ a: { approval: 'auto' }, b: { enabled: false } });
    lock.setUserPolicy(CONN, 'a', null);
    expect(lock.userPolicies(CONN)).toEqual({ b: { enabled: false } });
  });
});

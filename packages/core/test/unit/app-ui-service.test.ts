import { describe, expect, it, vi } from 'vitest';
import { MCP_APP_CALLS_INFLIGHT_MAX, MCP_APP_CALLS_PER_SECOND } from '@kepcup/shared';
import type { AppError, McpServer, Message } from '@kepcup/shared';
import { McpAppUiService, toUiToolResult } from '../../src/apps/ui/service.js';
import { UiResourceStore, appUiHostFor } from '../../src/apps/ui/store.js';
import { isMcpAppMime, parseUiResource } from '../../src/apps/ui/resource.js';

const MIME = 'text/html;profile=mcp-app';
const ok = (extra: Record<string, unknown> = {}) => ({
  contents: [{ uri: 'ui://a/b', mimeType: MIME, text: '<html>ok</html>', ...extra }],
});

describe('isMcpAppMime', () => {
  it('only text/html;profile=mcp-app (case / whitespace tolerant)', () => {
    expect(isMcpAppMime('text/html;profile=mcp-app')).toBe(true);
    expect(isMcpAppMime('Text/HTML; Profile=mcp-app')).toBe(true);
    expect(isMcpAppMime('text/html; charset=utf-8; profile=mcp-app')).toBe(true);
    for (const bad of [
      'text/html',
      'text/plain;profile=mcp-app',
      'application/json',
      '',
      undefined,
      3,
    ]) {
      expect(isMcpAppMime(bad)).toBe(false);
    }
  });
});

describe('parseUiResource', () => {
  const strict = { loopbackOrigin: null };
  it('extracts html, csp, permissions and prefersBorder', () => {
    const parsed = parseUiResource(
      ok({
        _meta: {
          ui: {
            csp: {
              connectDomains: ['https://api.example.com'],
              resourceDomains: ['https://cdn.example.com'],
            },
            permissions: { microphone: {} },
            prefersBorder: false,
          },
        },
      }),
      'ui://a/b',
      strict,
    );
    expect(parsed.html).toBe('<html>ok</html>');
    expect(parsed.csp).toContain('connect-src https://api.example.com;');
    expect(parsed.connectDomains).toEqual(['https://api.example.com']);
    expect(parsed.deniedPermissions).toEqual(['microphone']);
    expect(parsed.prefersBorder).toBe(false);
  });

  it('prefers the content item for the requested uri, falls back to the first', () => {
    const result = {
      contents: [
        { uri: 'ui://other', mimeType: MIME, text: 'other' },
        { uri: 'ui://a/b', mimeType: MIME, text: 'wanted' },
      ],
    };
    expect(parseUiResource(result, 'ui://a/b', strict).html).toBe('wanted');
    expect(parseUiResource(result, 'ui://missing', strict).html).toBe('other');
  });

  it('rejects: empty contents, wrong MIME, no body, blank body, > 2 MB (text and blob)', () => {
    const invalid = (value: unknown) => {
      try {
        parseUiResource(value as never, 'ui://a/b', strict);
      } catch (error) {
        return (error as AppError).code;
      }
      return 'no-error';
    };
    expect(invalid({ contents: [] })).toBe('APP_UI_INVALID');
    expect(invalid({})).toBe('APP_UI_INVALID');
    expect(invalid({ contents: [{ uri: 'ui://a/b', mimeType: 'text/html', text: '<p/>' }] })).toBe(
      'APP_UI_INVALID',
    );
    expect(invalid({ contents: [{ uri: 'ui://a/b', mimeType: MIME }] })).toBe('APP_UI_INVALID');
    expect(invalid({ contents: [{ uri: 'ui://a/b', mimeType: MIME, text: '   ' }] })).toBe(
      'APP_UI_INVALID',
    );
    const big = 'a'.repeat(2 * 1024 * 1024 + 1);
    expect(invalid({ contents: [{ uri: 'ui://a/b', mimeType: MIME, text: big }] })).toBe(
      'APP_UI_INVALID',
    );
    expect(
      invalid({
        contents: [{ uri: 'ui://a/b', mimeType: MIME, blob: Buffer.from(big).toString('base64') }],
      }),
    ).toBe('APP_UI_INVALID');
    // Exactly at the limit is fine; multibyte counts in bytes, not characters.
    const edge = 'a'.repeat(2 * 1024 * 1024);
    expect(
      parseUiResource({ contents: [{ uri: 'u', mimeType: MIME, text: edge }] }, 'u', strict).html
        .length,
    ).toBe(edge.length);
    expect(
      invalid({ contents: [{ uri: 'u', mimeType: MIME, text: '汉'.repeat(1024 * 1024) }] }),
    ).toBe('APP_UI_INVALID');
  });

  it('a malformed csp declaration degrades to deny-all instead of throwing', () => {
    const parsed = parseUiResource(
      ok({ _meta: { ui: { csp: { connectDomains: 'https://x.com' } } } }),
      'ui://a/b',
      strict,
    );
    expect(parsed.csp).toContain("connect-src 'none'");
    expect(parsed.ignored.join('|')).toContain('csp');
  });

  it('loopback sources need to be exactly the owning local server', () => {
    const meta = { _meta: { ui: { csp: { connectDomains: ['http://127.0.0.1:9'] } } } };
    expect(parseUiResource(ok(meta), 'ui://a/b', strict).connectDomains).toEqual([]);
    expect(
      parseUiResource(ok(meta), 'ui://a/b', { loopbackOrigin: '127.0.0.1:9' }).connectDomains,
    ).toEqual(['http://127.0.0.1:9']);
  });
});

describe('toUiToolResult', () => {
  const redact = (text: string) => text.replace(/sk-secret/g, '[REDACTED]');
  it('redacts text and structured content, keeps only text blocks, flags errors', () => {
    const out = toUiToolResult(
      {
        content: [
          { type: 'text', text: 'token sk-secret here' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        structuredContent: { key: 'sk-secret', n: 1 },
        isError: true,
      },
      redact,
      10_000,
    );
    expect(out).toEqual({
      content: [{ type: 'text', text: 'token [REDACTED] here' }],
      structuredContent: { key: '[REDACTED]', n: 1 },
      isError: true,
    });
  });

  it('truncates text over the budget and drops structured content that no longer fits', () => {
    const out = toUiToolResult(
      {
        content: [{ type: 'text', text: 'x'.repeat(100) }],
        structuredContent: { a: 'y'.repeat(100) },
      },
      redact,
      50,
    );
    expect(out.content[0]!.text).toHaveLength(50);
    expect(out.structuredContent).toBeUndefined();
    expect(out.truncated).toBe(true);
  });
});

describe('toUiToolResult robustness', () => {
  it('tolerates malformed content blocks from the server instead of throwing', () => {
    const out = toUiToolResult(
      {
        content: [null, 3, { type: 'text' }, { type: 'text', text: 'ok' }] as never,
        structuredContent: undefined,
      },
      (text) => text,
      100,
    );
    expect(out.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

describe('UiResourceStore', () => {
  const clock = (() => {
    let now = 1_000;
    return { now: () => now, advance: (ms: number) => (now += ms) } as {
      now(): number;
      advance(ms: number): number;
    };
  })();
  const input = (serverId = 'srv') => ({
    serverId,
    messageId: 'msg_1',
    conversationId: 'conv_1',
    botId: 'bot_1',
    toolName: 'tool',
    resourceUri: 'ui://a/b',
    html: '<html/>',
    csp: "default-src 'none'",
  });

  it('issues unguessable ids, DNS-safe per-server hosts, and expires with a sliding TTL', () => {
    const store = new UiResourceStore({ clock: clock as never, ttlMs: 1000, max: 10 });
    const a = store.put(input('conn_a'));
    const b = store.put(input('conn_b'));
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.host).toMatch(/^app-[0-9a-f]{24}$/);
    expect(a.host).toBe(appUiHostFor('conn_a'));
    expect(a.host).not.toBe(b.host);
    clock.advance(800);
    expect(store.get(a.id)).toBeDefined(); // slides to +1000
    clock.advance(800);
    expect(store.get(a.id)).toBeDefined();
    clock.advance(1200);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('evicts the oldest beyond max and invalidates by server', () => {
    const store = new UiResourceStore({ clock: clock as never, ttlMs: 10_000, max: 2 });
    const first = store.put(input('s1'));
    const second = store.put(input('s2'));
    const third = store.put(input('s2'));
    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeDefined();
    expect(store.invalidateServer('s2')).toBe(2);
    expect(store.get(third.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('rate limits calls per second and in flight, per resource', () => {
    const store = new UiResourceStore({ clock: clock as never, ttlMs: 10_000, max: 10 });
    const entry = store.put(input());
    const other = store.put(input());
    const releases: Array<() => void> = [];
    for (let i = 0; i < MCP_APP_CALLS_INFLIGHT_MAX; i += 1) {
      const release = store.tryAcquireCall(entry.id);
      expect(release).not.toBeNull();
      releases.push(release!);
    }
    expect(store.tryAcquireCall(entry.id)).toBeNull(); // in flight cap
    expect(store.tryAcquireCall(other.id)).not.toBeNull(); // independent per resource
    for (const release of releases) release();
    release2(store, entry.id);
    function release2(s: UiResourceStore, id: string) {
      // After releasing, the per-second window still limits: stamps within 1 s count.
      let granted = 0;
      for (let i = 0; i < 20; i += 1) {
        const r = s.tryAcquireCall(id);
        if (r !== null) {
          granted += 1;
          r();
        }
      }
      expect(granted).toBeLessThanOrEqual(MCP_APP_CALLS_PER_SECOND);
    }
    clock.advance(1100);
    expect(store.tryAcquireCall(entry.id)).not.toBeNull();
  });
});

describe('McpAppUiService.onToolResult', () => {
  const server = { id: 'srv', name: 'Server', enabled: true } as unknown as McpServer;
  function make(overrides: Partial<ConstructorParameters<typeof McpAppUiService>[0]> = {}) {
    const appended: Array<Record<string, unknown>> = [];
    const published: Message[] = [];
    const service = new McpAppUiService({
      mcp: {} as never,
      gateway: {} as never,
      messages: {
        append: (input) => {
          appended.push(input);
          return { id: `msg_${appended.length}`, conversationId: input.conversationId } as never;
        },
        getById: () => null,
      },
      publishMessage: (message) => published.push(message),
      secrets: { redact: (text) => text.replace(/sk-secret/g, '[REDACTED]') },
      shell: { openExternal: async () => ({ ok: true }) },
      clock: { now: () => 1 } as never,
      logger: { warn: vi.fn() },
      ...overrides,
    });
    return { service, appended, published };
  }
  const identity = {
    runId: 'run_1',
    botId: 'bot_1',
    conversationId: 'conv_1',
    loopType: 'task' as const,
  };
  const tool = {
    name: 't',
    title: 'Dash sk-secret',
    inputSchema: {},
    _meta: { ui: { resourceUri: 'ui://a/b' } },
  };
  const result = { content: [{ type: 'text' as const, text: 'hello sk-secret' }] };

  it('emits a redacted descriptor card and publishes it', () => {
    const { service, appended, published } = make();
    const message = service.onToolResult({
      identity,
      server,
      tool: tool as never,
      args: { q: 'sk-secret' },
      result,
    });
    expect(message).not.toBeNull();
    expect(published).toHaveLength(1);
    const card = appended[0]!['cardAppUi'] as Record<string, unknown>;
    expect(appended[0]).toMatchObject({
      senderType: 'system',
      kind: 'card',
      cardType: 'mcp_app',
      runId: 'run_1',
    });
    expect(JSON.stringify(card)).not.toContain('sk-secret');
    expect(card).toMatchObject({
      serverId: 'srv',
      botId: 'bot_1',
      resourceUri: 'ui://a/b',
      toolName: 't',
      toolInput: { q: '[REDACTED]' },
    });
  });

  it('uses the result _meta as a fallback, and skips errors, non-ui:// uris and runs without a conversation', () => {
    const { service, appended } = make();
    const plain = { name: 't', inputSchema: {} };
    expect(
      service.onToolResult({
        identity,
        server,
        tool: plain as never,
        args: {},
        result: { ...result, _meta: { ui: { resourceUri: 'ui://z/y' } } },
      }),
    ).not.toBeNull();
    expect(
      service.onToolResult({
        identity,
        server,
        tool: plain as never,
        args: {},
        result: { ...result, _meta: { ui: { resourceUri: 'https://evil/x' } } },
      }),
    ).toBeNull();
    expect(
      service.onToolResult({
        identity,
        server,
        tool: tool as never,
        args: {},
        result: { ...result, isError: true },
      }),
    ).toBeNull();
    expect(
      service.onToolResult({
        identity: { ...identity, conversationId: null },
        server,
        tool: tool as never,
        args: {},
        result,
      }),
    ).toBeNull();
    expect(appended).toHaveLength(1);
  });

  it('caps the cards per run and never throws', () => {
    const { service, appended } = make();
    for (let i = 0; i < 20; i += 1)
      service.onToolResult({ identity, server, tool: tool as never, args: {}, result });
    expect(appended).toHaveLength(8);
    const failing = make({
      messages: {
        append: () => {
          throw new Error('db gone');
        },
        getById: () => null,
      },
    });
    expect(
      failing.service.onToolResult({ identity, server, tool: tool as never, args: {}, result }),
    ).toBeNull();
  });

  it('drops oversized tool input instead of storing it', () => {
    const { service, appended } = make();
    service.onToolResult({
      identity,
      server,
      tool: tool as never,
      args: { blob: 'x'.repeat(40_000) },
      result,
    });
    const card = appended[0]!['cardAppUi'] as Record<string, unknown>;
    expect(card['toolInput']).toEqual({});
    expect(card['inputTruncated']).toBe(true);
  });
});

describe('UiResourceStore: cancellation, deny lock, conversation slots', () => {
  const clock = (() => {
    let now = 1_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  })();
  const input = (conversationId = 'conv_1') => ({
    serverId: 'srv',
    messageId: 'm',
    conversationId,
    botId: 'b',
    toolName: 't',
    resourceUri: 'ui://a/b',
    html: '<html/>',
    csp: "default-src 'none'",
  });

  it('aborts the resource signal on remove / eviction / server invalidation / expiry', () => {
    const store = new UiResourceStore({ clock: clock as never, ttlMs: 1000, max: 2 });
    const a = store.put(input());
    store.remove(a.id);
    expect(a.abort.signal.aborted).toBe(true);
    const b = store.put(input());
    const c = store.put(input());
    const d = store.put(input()); // evicts b
    expect(b.abort.signal.aborted).toBe(true);
    expect(c.abort.signal.aborted).toBe(false);
    store.invalidateServer('srv');
    expect(c.abort.signal.aborted && d.abort.signal.aborted).toBe(true);
    const e = store.put(input());
    clock.advance(2000);
    expect(store.get(e.id)).toBeUndefined();
    expect(e.abort.signal.aborted).toBe(true);
  });

  it('a denied tool is locked per (resource, tool) for 30 s', () => {
    const store = new UiResourceStore({ clock: clock as never, ttlMs: 600_000, max: 5 });
    const a = store.put(input());
    const b = store.put(input());
    expect(store.isToolLocked(a.id, 'save')).toBe(false);
    store.lockDeniedTool(a.id, 'save');
    expect(store.isToolLocked(a.id, 'save')).toBe(true);
    expect(store.isToolLocked(a.id, 'other')).toBe(false);
    expect(store.isToolLocked(b.id, 'save')).toBe(false);
    clock.advance(29_000);
    expect(store.isToolLocked(a.id, 'save')).toBe(true);
    clock.advance(2_000);
    expect(store.isToolLocked(a.id, 'save')).toBe(false);
  });

  it('caps in-flight UI calls per conversation at 3', () => {
    const store = new UiResourceStore({ clock: clock as never, ttlMs: 600_000, max: 5 });
    const releases = [1, 2, 3].map(() => store.tryAcquireConversationSlot('conv_1'));
    expect(releases.every((release) => release !== null)).toBe(true);
    expect(store.tryAcquireConversationSlot('conv_1')).toBeNull();
    expect(store.tryAcquireConversationSlot('conv_2')).not.toBeNull();
    releases[0]!();
    releases[0]!(); // idempotent
    expect(store.tryAcquireConversationSlot('conv_1')).not.toBeNull();
    expect(store.tryAcquireConversationSlot('conv_1')).toBeNull();
  });
});

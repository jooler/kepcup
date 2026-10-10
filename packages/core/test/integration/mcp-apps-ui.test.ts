import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, Message } from '@kepcup/shared';
import {
  FAKE_MCP_APP_RESOURCE_URI,
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  startFakeMcpAppServer,
  step,
  viaTask,
  waitFor,
  waitForRun,
  type FakeMcpAppServer,
  type FakeMcpAppServerOptions,
  type TestStack,
} from '@kepcup/testkit';

/**
 * D73 P3 §7.5 MCP Apps rendering through the real orchestrator and the real RPC surface (fakes only):
 * a tool result whose definition carries `_meta.ui.resourceUri` becomes a card message; the card
 * descriptor holds no HTML / tokens and the model sees nothing of the UI; `apps.ui.open` reads
 * the `ui://` resource through the owning MCP connection and registers it; the protocol handler's
 * platform method serves it with a CSP header; UI-initiated tool calls go through the same
 * gateway/approval path with a default-deny visibility rule; links are https-only.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Env {
  stack: TestStack;
  fake: FakeMcpAppServer;
  botId: string;
  conversationId: string;
  opened: string[];
}

async function start(
  options: FakeMcpAppServerOptions = {},
  config: { runTool?: boolean } = {},
): Promise<Env> {
  const fake = await startFakeMcpAppServer(options);
  cleanups.push(() => fake.stop());
  const opened: string[] = [];
  const stack = await createTestStack({
    shellRpc: {
      async openExternal({ url }) {
        opened.push(url);
        return { ok: true };
      },
    },
  });
  cleanups.push(() => stack.cleanup());
  const { core, llm } = stack;
  await core.rpc.call('settings.update', {
    mcpServers: [
      {
        id: 'app1',
        name: '假界面应用',
        transport: 'http',
        url: fake.mcpUrl,
        enabled: true,
        autoApprove: false,
        auth: 'none',
      },
    ],
  });
  const bot = await makeBot(core, '小界面');
  await core.rpc.call('bots.update', {
    id: bot.id,
    profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: ['app1'] } },
  });
  const conv = await openDirect(core, bot.id);
  if (config.runTool !== false) {
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_app1_show_dashboard', { topic: '销量' }),
          step().replyText('看板已显示'),
        ],
        relay: '好了',
      }),
    );
    await sendBatch(core, conv.id, ['显示看板']);
    await waitForRun(core, conv.id, 'completed', { loopType: 'task', timeoutMs: 60_000 });
  }
  return { stack, fake, botId: bot.id, conversationId: conv.id, opened };
}

async function appCard(env: Env): Promise<Message> {
  return waitFor(
    async () => {
      const { messages } = (await env.stack.core.rpc.call('messages.list', {
        conversationId: env.conversationId,
      })) as { messages: Message[] };
      return (
        messages.find(
          (m) => m.kind === 'card' && (m.content as { cardType?: string }).cardType === 'mcp_app',
        ) ?? null
      );
    },
    { label: 'mcp_app card', timeoutMs: 30_000 },
  );
}

async function openCard(env: Env, message: Message) {
  return (await env.stack.core.rpc.call('apps.ui.open', { messageId: message.id })) as {
    resourceId: string;
    url: string;
    appTools: string[];
    connectDomains: string[];
    resourceDomains: string[];
    ignored: string[];
    deniedPermissions: string[];
    toolInput: Record<string, unknown>;
    toolResult: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
  };
}

async function pendingToolCard(env: Env): Promise<Approval> {
  return waitFor(
    async () => {
      const list = (await env.stack.core.rpc.call('approvals.list', {
        conversationId: env.conversationId,
      })) as { approvals: Approval[] };
      return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
    },
    { label: 'mcp_tool card', timeoutMs: 30_000 },
  );
}

describe('card creation', () => {
  it('a tool result with _meta.ui.resourceUri becomes a card with no HTML and no tokens; the model sees nothing of it', async () => {
    const env = await start();
    const card = await appCard(env);
    const content = card.content as { appUi: Record<string, unknown>; cardType: string };
    expect(content.appUi).toMatchObject({
      serverId: 'app1',
      appName: '假界面应用',
      botId: env.botId,
      resourceUri: FAKE_MCP_APP_RESOURCE_URI,
      toolName: 'show_dashboard',
      title: 'Show dashboard',
      toolInput: { topic: '销量' },
      toolResult: {
        content: [{ type: 'text', text: 'dashboard-data' }],
        structuredContent: { rows: 3 },
      },
    });
    expect(card.senderType).toBe('system');
    // Nothing of the page, no credentials: the card is only a pointer.
    const stored = JSON.stringify(card);
    expect(stored).not.toContain('<html');
    expect(stored).not.toContain('fake mcp app');
    expect(stored.toLowerCase()).not.toContain('bearer');
    // The UI resource is read lazily on open, not at card time.
    expect(env.fake.resourceReads).toBe(0);
    // The bot's context carries one fixed line for the card — never the descriptor or the page.
    const requests = JSON.stringify(env.stack.llm.requestsFor('mock-main').map((r) => r.body));
    expect(requests).toContain('已向用户显示一张应用界面卡片');
    expect(requests).not.toContain('ui://');
    expect(requests).not.toContain('fake mcp app');
    expect(env.fake.authorizationHeaders).toEqual([]);
  }, 120_000);

  it('a tool without _meta.ui.resourceUri produces no card', async () => {
    const env = await start({}, { runTool: false });
    const { core, llm } = env.stack;
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('mcp_app1_refresh_data', {}), step().replyText('ok')],
        relay: '好了',
      }),
    );
    await sendBatch(core, env.conversationId, ['刷新']);
    await waitForRun(core, env.conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 60_000,
    });
    const { messages } = (await core.rpc.call('messages.list', {
      conversationId: env.conversationId,
    })) as { messages: Message[] };
    expect(messages.some((m) => (m.content as { cardType?: string }).cardType === 'mcp_app')).toBe(
      false,
    );
  }, 120_000);
});

describe('apps.ui.open and the protocol-handler channel', () => {
  it('reads the ui:// resource through the connection, sanitizes the CSP and serves html + header by (host, id)', async () => {
    const env = await start({
      // Loopback sources are accepted only when they are exactly the (local dev) SERVER's own host:port.
      connectDomains: [
        '{self}',
        'http://localhost:8080',
        'https://*.github.io',
        'http://127.0.0.1:*',
        'https://api.example.com',
        'http://evil.example.com',
        '*',
        "'unsafe-eval'",
        'https://10.0.0.1',
      ],
      resourceDomains: ['https://cdn.example.com', 'https://*.cdn.example.com', 'data:'],
      frameDomains: ['https://www.youtube.com'],
      permissions: { camera: {}, geolocation: {} },
      html: '<!doctype html><title>x</title><body>fake mcp app page</body>',
    });
    const card = await appCard(env);
    const out = await openCard(env, card);
    expect(out.url).toMatch(/^kepcup-app:\/\/app-[0-9a-f]{24}\/[A-Za-z0-9_-]{20,}$/);
    expect(out.toolInput).toEqual({ topic: '销量' });
    expect(out.toolResult.content[0]!.text).toBe('dashboard-data');
    expect(out.connectDomains).toEqual([env.fake.url, 'https://api.example.com']);
    expect(out.resourceDomains).toEqual(['https://cdn.example.com']);
    expect(out.deniedPermissions.sort()).toEqual(['camera', 'geolocation']);
    expect(out.ignored.join('|')).toContain('evil.example.com');
    expect(out.ignored.join('|')).toContain('10.0.0.1');
    expect(out.ignored.join('|')).toContain('github.io');
    expect(out.ignored.join('|')).toContain('localhost:8080');
    expect(out.ignored.join('|')).toContain('frameDomains');
    expect(out.appTools.sort()).toEqual(['refresh_data', 'save_note']);

    const ui = env.stack.core.services.appUi!;
    const host = out.url.split('/')[2]!;
    const page = ui.resource({ resourceId: out.resourceId, host });
    expect(page.html).toContain('fake mcp app page');
    expect(page.csp).toContain("default-src 'none'");
    expect(page.csp).toContain(`connect-src ${env.fake.url} https://api.example.com;`);
    expect(page.csp).toContain('sandbox allow-scripts');
    expect(page.csp).toContain('frame-ancestors');
    expect(page.csp).not.toContain('github.io');
    expect(page.csp).not.toContain('evil.example.com');
    expect(page.csp).not.toContain('10.0.0.1');
    expect(page.csp).toContain("frame-src 'none'");
    expect(page.csp).toContain("form-action 'none'");
    expect(page.csp).toContain("base-uri 'none'");
    // Wrong host / unknown id are refused.
    expect(() =>
      ui.resource({ resourceId: out.resourceId, host: 'app-000000000000000000000000' }),
    ).toThrow();
    expect(() => ui.resource({ resourceId: 'nope-nope-nope-nope-nope', host })).toThrow();
    // The platform method (main process → core) is the same path.
    const platform = env.stack.core.services.platformMethods['apps.ui.resource']!;
    expect(await platform.handle({ resourceId: out.resourceId, host })).toMatchObject({
      html: expect.stringContaining('fake mcp app page'),
    });
    await env.stack.core.rpc.call('apps.ui.close', { resourceId: out.resourceId });
    expect(() => ui.resource({ resourceId: out.resourceId, host })).toThrow();
  }, 120_000);

  it('rejects a resource with the wrong MIME type, an empty body, or over 2 MB; accepts a base64 blob', async () => {
    const badMime = await start({ mimeType: 'text/html' });
    await expect(openCard(badMime, await appCard(badMime))).rejects.toMatchObject({
      code: 'APP_UI_INVALID',
    });
    const huge = await start({ html: `<html>${'a'.repeat(2 * 1024 * 1024 + 10)}</html>` });
    await expect(openCard(huge, await appCard(huge))).rejects.toMatchObject({
      code: 'APP_UI_INVALID',
    });
    const blob = await start({ asBlob: true, html: '<html><body>blob page</body></html>' });
    const out = await openCard(blob, await appCard(blob));
    const host = out.url.split('/')[2]!;
    expect(
      blob.stack.core.services.appUi!.resource({ resourceId: out.resourceId, host }).html,
    ).toContain('blob page');
  }, 180_000);

  it('a disconnected / removed server stops serving and calling', async () => {
    const env = await start();
    const out = await openCard(env, await appCard(env));
    const host = out.url.split('/')[2]!;
    await env.stack.core.rpc.call('settings.update', { mcpServers: [] });
    expect(() =>
      env.stack.core.services.appUi!.resource({ resourceId: out.resourceId, host }),
    ).toThrow();
    await expect(
      env.stack.core.rpc.call('apps.ui.callTool', {
        resourceId: out.resourceId,
        toolName: 'refresh_data',
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: 'APP_UI_EXPIRED' });
    await expect(openCard(env, await appCard(env))).rejects.toMatchObject({
      code: 'APP_UI_EXPIRED',
    });
  }, 120_000);
});

describe('UI-initiated tools/call', () => {
  it('app-visible read tools run; writes raise the normal mcp_tool card (host loop); denial returns an error result', async () => {
    const env = await start();
    const { core } = env.stack;
    const out = await openCard(env, await appCard(env));

    const read = (await core.rpc.call('apps.ui.callTool', {
      resourceId: out.resourceId,
      toolName: 'refresh_data',
      arguments: {},
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(read.content[0]!.text).toMatch(/^refreshed:/);

    // A write tool: the same approval card a model-initiated call would raise.
    const pending = core.rpc.call('apps.ui.callTool', {
      resourceId: out.resourceId,
      toolName: 'save_note',
      arguments: { text: 'hi' },
    }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const card = await pendingToolCard(env);
    expect(card.payload).toMatchObject({
      serverId: 'app1',
      toolName: 'save_note',
      risk: 'write',
    });
    expect(card.conversationId).toBe(env.conversationId);
    await core.rpc.call('approvals.decide', { id: card.id, approve: true });
    const written = await pending;
    expect(written.content[0]!.text).toBe('saved:hi');
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(1);
    // Audited like any MCP call.
    const audit = core.services
      .domain!.audit.listByConversation(env.conversationId, 100)
      .filter((a) => a.action === 'mcp_tool_call' && a.detail['toolName'] === 'save_note');
    expect(audit).toHaveLength(1);

    // Denial: the app gets an error result, nothing reaches the server.
    const denied = core.rpc.call('apps.ui.callTool', {
      resourceId: out.resourceId,
      toolName: 'save_note',
      arguments: { text: 'denied' },
    }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const second = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', {
          conversationId: env.conversationId,
        })) as { approvals: Approval[] };
        return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
      },
      { label: 'second card', timeoutMs: 30_000 },
    );
    await core.rpc.call('approvals.decide', { id: second.id, approve: false });
    expect(await denied).toMatchObject({ isError: true });
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(1);
  }, 120_000);

  it('tools the app is not allowed to call are refused before the gateway (default deny): undeclared, model-only, unknown', async () => {
    const env = await start();
    const { core } = env.stack;
    const out = await openCard(env, await appCard(env));
    const before = env.fake.toolCalls.length;
    for (const toolName of ['internal_write', 'model_only', 'show_dashboard', 'no_such_tool']) {
      await expect(
        core.rpc.call('apps.ui.callTool', { resourceId: out.resourceId, toolName, arguments: {} }),
      ).rejects.toMatchObject({ code: 'APP_UI_TOOL_NOT_ALLOWED' });
    }
    expect(env.fake.toolCalls).toHaveLength(before);
    // No approval card was raised for any of them.
    const list = (await core.rpc.call('approvals.list', {
      conversationId: env.conversationId,
    })) as { approvals: Approval[] };
    expect(list.approvals.filter((a) => a.kind === 'mcp_tool')).toHaveLength(0);
  }, 120_000);

  it('an unknown or expired resource id and oversized arguments are rejected; calls are rate limited', async () => {
    const env = await start();
    const { core } = env.stack;
    await expect(
      core.rpc.call('apps.ui.callTool', {
        resourceId: 'does-not-exist-does-not-exist',
        toolName: 'refresh_data',
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: 'APP_UI_EXPIRED' });
    const out = await openCard(env, await appCard(env));
    await expect(
      core.rpc.call('apps.ui.callTool', {
        resourceId: out.resourceId,
        toolName: 'refresh_data',
        arguments: { blob: 'x'.repeat(70 * 1024) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        core.rpc.call('apps.ui.callTool', {
          resourceId: out.resourceId,
          toolName: 'refresh_data',
          arguments: {},
        }),
      ),
    );
    const limited = results.filter(
      (r) =>
        r.status === 'rejected' && (r.reason as { code?: string }).code === 'APP_UI_RATE_LIMITED',
    );
    expect(limited.length).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(5);
  }, 120_000);
});

describe('apps.ui.openLink', () => {
  it('only https links without credentials reach shell.openExternal', async () => {
    const env = await start();
    const { core } = env.stack;
    const out = await openCard(env, await appCard(env));
    const call = (url: string) =>
      core.rpc.call('apps.ui.openLink', { resourceId: out.resourceId, url }) as Promise<{
        ok: boolean;
      }>;
    expect(await call('https://example.com/docs?a=1')).toEqual({ ok: true });
    for (const bad of [
      'http://example.com/',
      'http://127.0.0.1:1/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'kepcup-app://app-x/abc',
      'https://user:pw@example.com/',
      'not a url',
    ]) {
      expect(await call(bad)).toEqual({ ok: false });
    }
    expect(env.opened).toEqual(['https://example.com/docs?a=1']);
    await expect(
      core.rpc.call('apps.ui.openLink', {
        resourceId: 'gone-gone-gone-gone-gone',
        url: 'https://example.com/',
      }),
    ).rejects.toMatchObject({ code: 'APP_UI_EXPIRED' });
  }, 120_000);
});

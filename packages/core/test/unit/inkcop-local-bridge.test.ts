import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  inkcopBaseUrl,
  inkcopEndpointPath,
  readInkcopEndpoint,
  resolveInkcopTarget,
} from '../../src/inkcop/endpoint.js';
import { consumeSseBuffer } from '../../src/inkcop/sse.js';
import {
  InkcopLocalBridgeClient,
  InkcopOfflineError,
  InkcopAuthError,
  InkcopHttpError,
  InkcopAgentNotExposedError,
  INKCOP_OFFLINE_TIP_ZH,
  INKCOP_AUTH_TIP_ZH,
  INKCOP_AGENT_NOT_EXPOSED_TIP_ZH,
  inkcopOfflineTip,
  inkcopAuthTip,
  inkcopAgentNotExposedTip,
} from '../../src/inkcop/client.js';
import {
  INKCOP_LOCAL_TRANSPORT,
  botHasInkcopAgents,
  inkcopAgentsApiAvailable,
  inkcopAgentDescriptionsAvailable,
  inkcopAgentKeyForBot,
  inkcopAgentKeys,
  inkcopAgentToolsEnabled,
  inkcopExternalId,
  inkcopMessageId,
  isInkcopLocalBot,
  shouldUseInkcopBridge,
  handoffToInkcopAgent,
} from '../../src/inkcop/index.js';
import { executeInkcopBridgeTurn } from '../../src/inkcop/bridge-turn.js';
import { buildInkcopAgentTools } from '../../src/tools/inkcop-tools.js';
import type { Bot, Message, Run } from '@kepcup/shared';
import type { TriggerBatch } from '../../src/scheduler/mailbox.js';

describe('inkcop endpoint discovery', () => {
  it('resolves platform paths', () => {
    expect(inkcopEndpointPath({}, 'darwin')).toContain(
      path.join('Library', 'Application Support', 'inkcop-local-bridge', 'endpoint.json'),
    );
    expect(inkcopEndpointPath({}, 'linux')).toContain(
      path.join('.local', 'share', 'inkcop-local-bridge', 'endpoint.json'),
    );
    expect(inkcopEndpointPath({ APPDATA: 'C:\\\\Users\\\\x\\\\AppData\\\\Roaming' }, 'win32')).toContain(
      'inkcop-local-bridge',
    );
  });

  it('reads a valid endpoint.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inkcop-ep-'));
    const file = path.join(dir, 'endpoint.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        port: 54321,
        token: 'a'.repeat(32),
        baseUrl: 'http://127.0.0.1:54321',
      }),
    );
    const result = readInkcopEndpoint(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint.port).toBe(54321);
      expect(inkcopBaseUrl(result.endpoint)).toBe('http://127.0.0.1:54321');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports missing / invalid', () => {
    expect(readInkcopEndpoint('/no/such/endpoint.json').ok).toBe(false);
    const dir = mkdtempSync(path.join(tmpdir(), 'inkcop-bad-'));
    const file = path.join(dir, 'endpoint.json');
    writeFileSync(file, '{');
    expect(readInkcopEndpoint(file).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveInkcopTarget (v0.3)', () => {
  it('prefers settings apiKey and baseUrl over endpoint', () => {
    const endpoint = {
      version: 3,
      port: 9,
      token: 'e'.repeat(32),
      baseUrl: 'http://127.0.0.1:9',
    };
    const resolved = resolveInkcopTarget(
      { apiKey: 'user-key-from-settings', baseUrl: 'http://192.168.1.10:54321' },
      { endpoint },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.target.apiKey).toBe('user-key-from-settings');
      expect(resolved.target.baseUrl).toBe('http://192.168.1.10:54321');
    }
  });

  it('falls back to endpoint.token when apiKey empty', () => {
    const endpoint = {
      version: 3,
      port: 9,
      token: 'f'.repeat(32),
      baseUrl: 'http://127.0.0.1:9',
    };
    const resolved = resolveInkcopTarget({ apiKey: '', baseUrl: '' }, { endpoint });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.target.apiKey).toBe('f'.repeat(32));
      expect(resolved.target.baseUrl).toBe('http://127.0.0.1:9');
    }
  });

  it('works with only settings (no endpoint) for LAN', () => {
    const resolved = resolveInkcopTarget(
      { apiKey: 'lan-key', baseUrl: 'http://10.0.0.2:1234/' },
      { endpoint: null },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.target.apiKey).toBe('lan-key');
      expect(resolved.target.baseUrl).toBe('http://10.0.0.2:1234');
      expect(resolved.target.endpoint).toBeNull();
    }
  });

  it('fails with no_api_key when neither settings nor endpoint has a key', () => {
    const resolved = resolveInkcopTarget(
      { apiKey: '', baseUrl: 'http://127.0.0.1:9' },
      { endpoint: null },
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('no_api_key');
  });

  it('fails with no_base_url when nowhere to connect', () => {
    const resolved = resolveInkcopTarget({ apiKey: 'k', baseUrl: '' }, { endpoint: null });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('no_base_url');
  });
});

describe('inkcop SSE parser', () => {
    it('parses event frames across chunk boundaries', () => {
    const part1 = 'event: chunk\ndata: {"turnId":"t1","text":"he';
    const part2 = 'llo"}\n\nevent: complete\ndata: {"turnId":"t1","text":"hello"}\n\n';
    const first = consumeSseBuffer(part1);
    expect(first.frames).toEqual([]);
    const second = consumeSseBuffer(first.rest + part2);
    expect(second.frames).toEqual([
      { event: 'chunk', data: '{"turnId":"t1","text":"hello"}' },
      { event: 'complete', data: '{"turnId":"t1","text":"hello"}' },
    ]);
  });
});

describe('inkcop helpers', () => {
  it('marks inkcop-local bots and builds ids', () => {
    expect(isInkcopLocalBot({ profile: { runtime: { message_transport: INKCOP_LOCAL_TRANSPORT } } })).toBe(
      true,
    );
    expect(isInkcopLocalBot({ profile: { runtime: { message_transport: '' } } })).toBe(false);
    expect(
      botHasInkcopAgents({ profile: { runtime: { inkcop_agent_keys: ['writer'] } } }),
    ).toBe(true);
    expect(isInkcopLocalBot({ profile: { runtime: { inkcop_agent_keys: ['writer'] } } })).toBe(true);
    // v0.4：整轮 divert 已关闭；工具门控用 inkcopAgentToolsEnabled。
    expect(
      shouldUseInkcopBridge(
        { profile: { runtime: { inkcop_agent_keys: ['writer'] } } },
        { inkcopLocalCollab: { enabled: true } },
      ),
    ).toBe(false);
    expect(
      inkcopAgentToolsEnabled(
        { profile: { runtime: { inkcop_agent_keys: ['writer'] } } },
        { inkcopLocalCollab: { enabled: true } },
      ),
    ).toBe(true);
    expect(
      inkcopAgentToolsEnabled(
        { profile: { runtime: { inkcop_agent_keys: ['writer'] } } },
        { inkcopLocalCollab: { enabled: false } },
      ),
    ).toBe(false);
    expect(inkcopAgentKeys({ profile: { runtime: { inkcop_agent_keys: ['a', '', 'a', 'b'] } } })).toEqual([
      'a',
      'b',
    ]);
    expect(inkcopAgentDescriptionsAvailable({ version: 3 })).toBe(false);
    expect(inkcopAgentDescriptionsAvailable({ version: 4 })).toBe(true);
    expect(inkcopExternalId('bot_1')).toBe('kepcup-bot-bot_1');
    expect(inkcopExternalId('bot_1', 'main_agent')).toBe('kepcup-bot-bot_1');
    expect(inkcopExternalId('bot_1', 'writer')).toBe('kepcup-bot-bot_1--writer');
    expect(inkcopMessageId('abc')).toBe('kepcup-msg-abc');
    expect(inkcopOfflineTip(null)).toBe(INKCOP_OFFLINE_TIP_ZH);
    expect(inkcopOfflineTip('en')).toMatch(/InkCop/);
    expect(inkcopAuthTip(null)).toBe(INKCOP_AUTH_TIP_ZH);
    expect(inkcopAgentsApiAvailable({ version: 1 })).toBe(false);
    expect(inkcopAgentsApiAvailable({ version: 2 })).toBe(true);
    expect(inkcopAgentKeyForBot({ profile: { runtime: { inkcop_agent_keys: ['writer'] } } })).toBe(
      'writer',
    );
    expect(inkcopAgentKeyForBot({ profile: { runtime: { inkcop_agent_keys: [] } } })).toBe(
      'main_agent',
    );
  });
});

describe('InkcopLocalBridgeClient', () => {
  const endpoint = {
    version: 1,
    port: 9,
    token: 'b'.repeat(32),
    baseUrl: 'http://127.0.0.1:9',
  };

  it('health ok', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        version: 1,
        app: 'inkcop',
        connections: [],
      }),
    );
    const client = new InkcopLocalBridgeClient({ endpoint, fetch: fetch as never });
    await expect(client.health()).resolves.toMatchObject({ ok: true, app: 'inkcop' });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9/v1/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('health fail → offline', async () => {
    const client = new InkcopLocalBridgeClient({
      endpoint,
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 503 })) as never,
    });
    await expect(client.health()).rejects.toBeInstanceOf(InkcopOfflineError);
  });

  it('health 401 → auth error', async () => {
    const client = new InkcopLocalBridgeClient({
      endpoint,
      fetch: vi.fn(async () => new Response('unauthorized', { status: 401 })) as never,
    });
    await expect(client.health()).rejects.toBeInstanceOf(InkcopAuthError);
  });

  it('uses settings apiKey/baseUrl override in request', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, version: 3, app: 'inkcop', connections: [] }),
    );
    const client = new InkcopLocalBridgeClient({
      endpoint,
      apiKey: 'override-key',
      baseUrl: 'http://192.168.0.5:9999',
      fetch: fetch as never,
    });
    await client.health();
    expect(fetch).toHaveBeenCalledWith(
      'http://192.168.0.5:9999/v1/health',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer override-key' }),
      }),
    );
  });

  it('missing key without endpoint → auth error before fetch', async () => {
    const fetch = vi.fn();
    // Without fixed endpoint and without readable file, resolve uses disk; instead inject via resolveInkcopTarget path:
    const bare = new InkcopLocalBridgeClient({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:9',
      endpointPath: '/no/such/inkcop-endpoint.json',
      fetch: fetch as never,
    });
    await expect(bare.health()).rejects.toBeInstanceOf(InkcopAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ensureConnection posts body', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, connectionId: 'conn_1', agentKey: 'main_agent', conversationId: 1 }),
    );
    const client = new InkcopLocalBridgeClient({ endpoint, fetch: fetch as never });
    const result = await client.ensureConnection({
      externalId: 'kepcup-bot-x',
      name: 'KepCup · InkCop',
    });
    expect(result.connectionId).toBe('conn_1');
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      externalId: 'kepcup-bot-x',
      agentKey: 'main_agent',
    });
  });

  it('listAgents requires endpoint.version >= 2', async () => {
    const client = new InkcopLocalBridgeClient({
      endpoint: { ...endpoint, version: 1 },
      fetch: vi.fn() as never,
    });
    await expect(client.listAgents()).rejects.toBeInstanceOf(InkcopHttpError);
  });

  it('listAgents parses v0.2 payload', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        agents: [
          { key: 'main_agent', name: '主智能体', kind: 'main' },
          { key: 'writer', name: '写作', kind: 'app' },
        ],
      }),
    );
    const client = new InkcopLocalBridgeClient({
      endpoint: { ...endpoint, version: 2 },
      fetch: fetch as never,
    });
    const result = await client.listAgents();
    expect(result.agents).toEqual([
      { key: 'main_agent', name: '主智能体', kind: 'main' },
      { key: 'writer', name: '写作', kind: 'app' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9/v1/agents',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sendMessage streams SSE events', async () => {
    const sse =
      'event: accepted\ndata: {"turnId":"t1","connectionId":"c1"}\n\n' +
      'event: chunk\ndata: {"turnId":"t1","text":"Hi"}\n\n' +
      'event: complete\ndata: {"turnId":"t1","text":"Hi there","stopReason":"end_turn"}\n\n';
    const fetch = vi.fn(async () => {
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const client = new InkcopLocalBridgeClient({ endpoint, fetch: fetch as never });
    const events: string[] = [];
    await client.sendMessage(
      { connectionId: 'c1', messageId: 'kepcup-msg-1', text: 'hello' },
      {
        onAccepted: async () => events.push('accepted'),
        onChunk: async (d) => events.push(`chunk:${d.text}`),
        onComplete: async (d) => events.push(`complete:${d.text}`),
      },
    );
    expect(events).toEqual(['accepted', 'chunk:Hi', 'complete:Hi there']);
  });
});

describe('executeInkcopBridgeTurn', () => {
  const bot = {
    id: 'bot_ink',
    name: 'InkCop',
    profile: { runtime: { message_transport: 'inkcop-local' } },
  } as unknown as Bot;

  function harness(client: InkcopLocalBridgeClient) {
    const messages: Message[] = [];
    const published: Array<{ event: string; payload: unknown }> = [];
    let status: Run['status'] = 'queued';
    let error: string | null = null;
    let outputIds: string[] = [];
    const deps = {
      runs: {
        get: () => ({ id: 'run_1', outputMessageIds: outputIds }) as Run,
        update: (_id: string, patch: Partial<Run>) => {
          if (patch.status) status = patch.status;
          if (patch.outputMessageIds) outputIds = [...patch.outputMessageIds];
          if (patch.error !== undefined) error = patch.error;
          return { id: 'run_1', status, error, outputMessageIds: outputIds } as Run;
        },
      },
      messages: {
        append: (input: { text?: string; conversationId: string }) => {
          const message = {
            id: `msg_${messages.length + 1}`,
            conversationId: input.conversationId,
            kind: 'text',
            senderType: 'bot',
            content: { text: input.text ?? '' },
          } as Message;
          messages.push(message);
          return message;
        },
        getById: (id: string) => messages.find((m) => m.id === id) ?? null,
        updateStreamingText: (id: string, text: string) => {
          const message = messages.find((m) => m.id === id)!;
          (message.content as { text: string }).text = text;
          return message;
        },
      },
      logger: { error() {}, warn() {}, info() {}, debug() {} },
      publish: (event: string, payload: unknown) => published.push({ event, payload }),
      publishConversation: () => undefined,
      settleRun: (runId: string, next: Run['status'], err: string | null) => {
        status = next;
        error = err;
        return { id: runId, status, error } as Run;
      },
      releaseTurnMailbox: vi.fn(),
      uiLanguage: () => null as string | null,
      client,
    };
    return { deps, messages, published, get status() { return status; }, get error() { return error; } };
  }

  const batch: TriggerBatch = {
    conversationId: 'conv_1',
    botId: 'bot_ink',
    reason: 'direct',
    messages: [
      {
        id: 'u1',
        conversationId: 'conv_1',
        seq: 1,
        senderType: 'user',
        senderBotId: null,
        kind: 'text',
        content: { text: '写一段测试' },
        replyTo: null,
        mentions: [],
        batchId: 'b1',
        runId: null,
        status: 'normal',
        editedAt: null,
        createdAt: 0,
        ownerBotId: null,
        taskId: null,
        attachments: [],
      } as Message,
    ],
  };

  it('offline health → tip bot message and failed run', async () => {
    const client = new InkcopLocalBridgeClient({
      endpoint: { version: 1, port: 1, token: 'c'.repeat(32) },
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as never,
    });
    const h = harness(client);
    await executeInkcopBridgeTurn('run_1', batch, bot, h.deps as never);
    expect(h.messages[0]?.content).toMatchObject({ text: INKCOP_OFFLINE_TIP_ZH });
    expect(h.status).toBe('failed');
    expect(h.deps.releaseTurnMailbox).toHaveBeenCalled();
  });

  it('streams chunks into one bubble then completes', async () => {
    const sse =
      'event: accepted\ndata: {"turnId":"t","connectionId":"c"}\n\n' +
      'event: chunk\ndata: {"turnId":"t","text":"一"}\n\n' +
      'event: chunk\ndata: {"turnId":"t","text":"二"}\n\n' +
      'event: complete\ndata: {"turnId":"t","text":"一二"}\n\n';
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/health')) {
        return Response.json({ ok: true, version: 1, app: 'inkcop', connections: [] });
      }
      if (String(url).endsWith('/v1/connections')) {
        return Response.json({
          ok: true,
          connectionId: 'conn_x',
          agentKey: 'main_agent',
          conversationId: 1,
        });
      }
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const client = new InkcopLocalBridgeClient({
      endpoint: { version: 1, port: 9, token: 'd'.repeat(32), baseUrl: 'http://127.0.0.1:9' },
      fetch: fetch as never,
    });
    const h = harness(client);
    await executeInkcopBridgeTurn('run_1', batch, bot, h.deps as never);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.content).toMatchObject({ text: '一二' });
    expect(h.status).toBe('completed');
  });

  it('posts selected inkcop_agent_keys as agentKey', async () => {
    const keyedBot = {
      ...bot,
      profile: { runtime: { message_transport: 'inkcop-local', inkcop_agent_keys: ['writer'] } },
    } as unknown as Bot;
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/health')) {
        return Response.json({ ok: true, version: 2, app: 'inkcop', connections: [] });
      }
      if (String(url).endsWith('/v1/connections')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return Response.json({
          ok: true,
          connectionId: 'conn_w',
          agentKey: 'writer',
          conversationId: 2,
        });
      }
      const sse =
        'event: accepted\ndata: {"turnId":"t","connectionId":"c"}\n\n' +
        'event: complete\ndata: {"turnId":"t","text":"ok"}\n\n';
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const client = new InkcopLocalBridgeClient({
      endpoint: { version: 2, port: 9, token: 'd'.repeat(32), baseUrl: 'http://127.0.0.1:9' },
      fetch: fetch as never,
    });
    const h = harness(client);
    await executeInkcopBridgeTurn('run_1', batch, keyedBot, h.deps as never);
    expect(bodies[0]).toMatchObject({
      externalId: 'kepcup-bot-bot_ink--writer',
      agentKey: 'writer',
    });
    expect(h.status).toBe('completed');
  });
});


describe('inkcop tool handoff (v0.4)', () => {
  it('buildInkcopAgentTools registers call_inkcop_agent when keys present', () => {
    const tools = buildInkcopAgentTools({
      identity: { runId: 'r', botId: 'b', conversationId: 'c', loopType: 'turn' },
      inkcop: {
        botId: 'b',
        botName: 'Bot',
        agentKeys: ['main_agent', 'writer'],
        agents: [
          { key: 'main_agent', name: '主智能体', kind: 'main', description: '角色：写作助手' },
          { key: 'writer', name: '写作', kind: 'app' },
        ],
        handoff: async () => ({ ok: true, text: 'done', connectionId: 'c1' }),
      },
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('call_inkcop_agent');
    expect(tools[0]?.description).toContain('角色：写作助手');
    expect(tools[0]?.description).toContain('【默认禁止调用】');
    expect(tools[0]?.description).toContain('禁止');
    expect(tools[0]?.description).toContain('writer');
  });

  it('does not register tools when agentKeys empty', () => {
    const tools = buildInkcopAgentTools({
      identity: { runId: 'r', botId: 'b', conversationId: 'c', loopType: 'turn' },
      inkcop: {
        botId: 'b',
        botName: 'Bot',
        agentKeys: [],
        agents: [],
        handoff: async () => ({ ok: true, text: 'x', connectionId: 'c' }),
      },
    });
    expect(tools).toHaveLength(0);
  });

  it('handoffToInkcopAgent collects SSE complete text', async () => {
    const sse =
      'event: accepted\ndata: {"turnId":"t","connectionId":"c"}\n\n' +
      'event: complete\ndata: {"turnId":"t","text":"桥接结果"}\n\n';
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/connections')) {
        return Response.json({
          ok: true,
          connectionId: 'conn_h',
          agentKey: 'main_agent',
          conversationId: 1,
        });
      }
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const client = new InkcopLocalBridgeClient({
      endpoint: { version: 4, port: 9, token: 'e'.repeat(32), baseUrl: 'http://127.0.0.1:9' },
      fetch: fetch as never,
    });
    const result = await handoffToInkcopAgent(client, {
      botId: 'bot_1',
      botName: '测',
      agentKey: 'main_agent',
      text: '写一句',
    });
    expect(result).toEqual({ ok: true, text: '桥接结果', connectionId: 'conn_h' });
  });

  it('handoffToInkcopAgent surfaces agent_not_exposed (403) with Chinese tip', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'agent_not_exposed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new InkcopLocalBridgeClient({
      endpoint: { version: 4, port: 9, token: 'g'.repeat(32), baseUrl: 'http://127.0.0.1:9' },
      fetch: fetch as never,
    });
    await expect(client.ensureConnection({ externalId: 'x', name: 'n', agentKey: 'stale' })).rejects.toBeInstanceOf(
      InkcopAgentNotExposedError,
    );
    const result = await handoffToInkcopAgent(client, {
      botId: 'bot_1',
      botName: '测',
      agentKey: 'stale_key',
      text: '写一句',
    });
    expect(result).toEqual({
      ok: false,
      errorCode: 'not_exposed',
      message: INKCOP_AGENT_NOT_EXPOSED_TIP_ZH,
    });
    expect(inkcopAgentNotExposedTip(null)).toBe(INKCOP_AGENT_NOT_EXPOSED_TIP_ZH);
  });

  it('listAgents parses description when present', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        agents: [
          { key: 'main_agent', name: '主', kind: 'main', description: '角色文本' },
          { key: 'w', name: 'W', kind: 'app' },
        ],
      }),
    );
    const client = new InkcopLocalBridgeClient({
      endpoint: { version: 4, port: 9, token: 'f'.repeat(32), baseUrl: 'http://127.0.0.1:9' },
      fetch: fetch as never,
    });
    const listed = await client.listAgents();
    expect(listed.agents[0]).toMatchObject({ key: 'main_agent', description: '角色文本' });
    expect(listed.agents[1]?.description).toBeUndefined();
  });

  it('registering tools does not call handoff (turn start must not bridge)', async () => {
    let handoffCalls = 0;
    const tools = buildInkcopAgentTools({
      identity: { runId: 'r', botId: 'b', conversationId: 'c', loopType: 'turn' },
      inkcop: {
        botId: 'b',
        botName: 'Bot',
        agentKeys: ['main_agent'],
        agents: [{ key: 'main_agent', name: '主智能体', kind: 'main', description: '写作' }],
        handoff: async () => {
          handoffCalls += 1;
          return { ok: true, text: 'should-not-run', connectionId: 'c1' };
        },
      },
    });
    expect(tools).toHaveLength(1);
    expect(handoffCalls).toBe(0);
    // Legacy transport + keys still must not imply whole-turn divert.
    expect(
      shouldUseInkcopBridge(
        {
          profile: {
            runtime: { message_transport: INKCOP_LOCAL_TRANSPORT, inkcop_agent_keys: ['main_agent'] },
          },
        },
        { inkcopLocalCollab: { enabled: true } },
      ),
    ).toBe(false);
  });

  it('progress text only appears when call_inkcop_agent execute runs', async () => {
    const progress: string[] = [];
    let handoffCalls = 0;
    const tools = buildInkcopAgentTools({
      identity: { runId: 'r', botId: 'b', conversationId: 'c', loopType: 'turn' },
      inkcop: {
        botId: 'b',
        botName: 'Bot',
        agentKeys: ['main_agent'],
        agents: [{ key: 'main_agent', name: '主', kind: 'main' }],
        handoff: async () => {
          handoffCalls += 1;
          return { ok: true, text: 'ok', connectionId: 'c1' };
        },
      },
    });
    expect(handoffCalls).toBe(0);
    expect(progress).toEqual([]);
    const tool = tools[0]!;
    const result = await tool.execute(
      { agent_key: 'main_agent', task: '写一句测试' },
      {
        identity: { runId: 'r', botId: 'b', conversationId: 'c', loopType: 'turn' },
        signal: new AbortController().signal,
        terminate: () => undefined,
        progress: (text: string) => {
          progress.push(text);
        },
      },
    );
    expect(handoffCalls).toBe(1);
    expect(progress).toEqual(['正在调用 InkCop 智能体…']);
    expect(result.ok).toBe(true);
  });
});

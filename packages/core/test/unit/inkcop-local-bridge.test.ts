import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  inkcopBaseUrl,
  inkcopEndpointPath,
  readInkcopEndpoint,
} from '../../src/inkcop/endpoint.js';
import { consumeSseBuffer } from '../../src/inkcop/sse.js';
import {
  InkcopLocalBridgeClient,
  InkcopOfflineError,
  InkcopHttpError,
  INKCOP_OFFLINE_TIP_ZH,
  inkcopOfflineTip,
} from '../../src/inkcop/client.js';
import {
  INKCOP_LOCAL_TRANSPORT,
  botHasInkcopAgents,
  inkcopAgentsApiAvailable,
  inkcopAgentKeyForBot,
  inkcopExternalId,
  inkcopMessageId,
  isInkcopLocalBot,
  shouldUseInkcopBridge,
} from '../../src/inkcop/index.js';
import { executeInkcopBridgeTurn } from '../../src/inkcop/bridge-turn.js';
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
    expect(
      shouldUseInkcopBridge(
        { profile: { runtime: { inkcop_agent_keys: ['writer'] } } },
        { inkcopLocalCollab: { enabled: true } },
      ),
    ).toBe(true);
    expect(
      shouldUseInkcopBridge(
        { profile: { runtime: { inkcop_agent_keys: ['writer'] } } },
        { inkcopLocalCollab: { enabled: false } },
      ),
    ).toBe(false);
    expect(inkcopExternalId('bot_1')).toBe('kepcup-bot-bot_1');
    expect(inkcopExternalId('bot_1', 'main_agent')).toBe('kepcup-bot-bot_1');
    expect(inkcopExternalId('bot_1', 'writer')).toBe('kepcup-bot-bot_1--writer');
    expect(inkcopMessageId('abc')).toBe('kepcup-msg-abc');
    expect(inkcopOfflineTip(null)).toBe(INKCOP_OFFLINE_TIP_ZH);
    expect(inkcopOfflineTip('en')).toMatch(/InkCop/);
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

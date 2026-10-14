import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

/**
 * PiEngine passes a session id with every model request. pi-ai turns it into
 * provider-specific headers and body keys, not just OpenCode's
 * `x-opencode-session` (https://opencode.ai/v2/docs/console/go):
 * OpenAI Responses `session_id` / `x-client-request-id` + `prompt_cache_key`,
 * OpenRouter-detected endpoints `x-session-id`, Chat Completions on a URL
 * containing api.openai.com `prompt_cache_key`, Mistral `x-affinity` +
 * `prompt_cache_key`. These run pi-ai's real request building (against the
 * testkit mock, or a stubbed fetch for fixed public endpoints) and check that
 * every one of them carries the opaque keyed id (model-session-id.ts) and that
 * no raw conversation / run / Bot id reaches a header or a non-content field.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

const RETRY_ENV = {
  KEPCUP_MODEL_RETRY_BASE_DELAY_MS: '10',
  KEPCUP_MODEL_RETRY_MAX_DELAY_MS: '20',
};

const OPAQUE_ID = /^kep-[0-9a-f]{32}$/;

/** Every header pi-ai may fill from `sessionId` (any wire API). */
const SESSION_HEADERS = [
  'x-opencode-session',
  'session_id',
  'session-id',
  'x-session-id',
  'x-client-request-id',
  'x-session-affinity',
  'x-affinity',
] as const;

/** Every body key pi-ai may fill from `sessionId`. */
const SESSION_BODY_KEYS = ['prompt_cache_key', 'promptCacheKey'] as const;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fetchUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function captureOf(input: RequestInfo | URL, init: RequestInit | undefined): Captured {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => {
    headers.set(key, value);
  });
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return {
    url: fetchUrl(input),
    headers: record,
    body: typeof init?.body === 'string' ? init.body : '',
  };
}

function bodyKeys(captured: Captured): Record<string, unknown> {
  try {
    return JSON.parse(captured.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Header / body values pi-ai derived from the session id on this request. */
function sessionValues(captured: Captured): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of SESSION_HEADERS) {
    if (captured.headers[name] !== undefined) out[`header:${name}`] = captured.headers[name];
  }
  const body = bodyKeys(captured);
  for (const key of SESSION_BODY_KEYS) {
    if (body[key] !== undefined) out[`body:${key}`] = body[key];
  }
  return out;
}

/**
 * Spies on fetch: requests whose URL starts with one of `stubbed` get a
 * non-retryable 401 (fixed public endpoints we must not reach); everything
 * else goes to the real fetch (the testkit mock). Requests whose URL starts
 * with one of `watched` are recorded.
 */
function spyFetch(options: { watched: string[]; stubbed?: string[] }): Captured[] {
  const captured: Captured[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = fetchUrl(input);
    if (options.watched.some((prefix) => url.startsWith(prefix))) {
      captured.push(captureOf(input, init));
    }
    if ((options.stubbed ?? []).some((prefix) => url.startsWith(prefix))) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
        }),
      );
    }
    return realFetch(input, init);
  });
  return captured;
}

/**
 * Body fields that carry the model's context (system prompt, transcript,
 * tools). The prompt legitimately names the Bot's workspace path, which
 * contains the Bot and conversation ids; that is content the model needs, not
 * an identifier channel, so it is left out of the leak check below.
 */
const CONTENT_BODY_KEYS = ['messages', 'input', 'inputs', 'instructions', 'system', 'tools'];

/**
 * No raw internal id appears in any header, in any session field, or in any
 * body field outside the model context.
 */
function expectNoRawIds(captured: Captured[], rawIds: string[]): void {
  expect(rawIds.length).toBeGreaterThan(0);
  for (const request of captured) {
    const envelope = { ...bodyKeys(request) };
    for (const key of CONTENT_BODY_KEYS) delete envelope[key];
    const wire = [
      JSON.stringify(request.headers),
      JSON.stringify(sessionValues(request)),
      JSON.stringify(envelope),
    ].join('\n');
    for (const raw of rawIds) {
      expect(wire, `${raw} leaked to ${request.url}`).not.toContain(raw);
    }
  }
}

async function withStack(
  env: NodeJS.ProcessEnv,
  fn: (stack: TestStack) => Promise<void>,
): Promise<void> {
  const stack = await createTestStack({ env });
  try {
    await fn(stack);
  } finally {
    await stack.cleanup();
  }
}

/** One user message in a fresh direct chat; returns the ids that must not leak. */
async function chatOnce(
  stack: TestStack,
  name: string,
  expected: 'completed' | 'failed',
): Promise<{ conversationId: string; rawIds: string[] }> {
  const bot = await makeBot(stack.core, name);
  const conv = await openDirect(stack.core, bot.id);
  await sendBatch(stack.core, conv.id, ['你好']);
  await waitForRun(stack.core, conv.id, expected);
  const runs = await listRuns(stack.core, conv.id);
  return { conversationId: conv.id, rawIds: [conv.id, bot.id, ...runs.map((r) => r.id)] };
}

async function firstModelOf(stack: TestStack, provider: string): Promise<string> {
  const { providers } = (await stack.core.rpc.call('providers.list')) as {
    providers: Array<{ id: string; models: Array<{ id: string }> }>;
  };
  const model = providers.find((p) => p.id === provider)?.models[0]?.id;
  if (model === undefined) throw new Error(`no ${provider} model in the catalog`);
  return model;
}

describe('model session id on the wire (PiEngine)', () => {
  it('OpenCode gets an opaque x-opencode-session, stable per conversation', async () => {
    await withStack(RETRY_ENV, async (stack) => {
      const captured = spyFetch({
        watched: ['https://opencode.ai/'],
        stubbed: ['https://opencode.ai/'],
      });
      await stack.core.rpc.call('providers.setKey', { provider: 'opencode-go', key: 'test-key' });
      await stack.core.rpc.call('settings.update', { defaultMainModel: 'opencode-go/glm-5.3' });

      const bot = await makeBot(stack.core, '小开');
      const conv = await openDirect(stack.core, bot.id);
      await sendBatch(stack.core, conv.id, ['你好']);
      await waitForRun(stack.core, conv.id, 'failed');
      const firstCount = captured.length;
      expect(firstCount).toBeGreaterThan(0);
      // A second turn in the same conversation keeps the routing id.
      await sendBatch(stack.core, conv.id, ['还在吗']);
      await waitFor(
        async () =>
          (await listRuns(stack.core, conv.id)).filter((r) => r.status === 'failed').length >= 2
            ? true
            : null,
        { label: 'second failed run' },
      );
      expect(captured.length).toBeGreaterThan(firstCount);

      const values = captured.map((c) => c.headers['x-opencode-session']);
      expect(values[0]).toMatch(OPAQUE_ID);
      expect(new Set(values)).toEqual(new Set([values[0]]));

      // Another conversation gets an unrelated id.
      const other = await chatOnce(stack, '小开二号', 'failed');
      const otherValue = captured.at(-1)!.headers['x-opencode-session'];
      expect(otherValue).toMatch(OPAQUE_ID);
      expect(otherValue).not.toBe(values[0]);

      const runs = await listRuns(stack.core, conv.id);
      expectNoRawIds(captured, [conv.id, bot.id, ...runs.map((r) => r.id), ...other.rawIds]);
    });
  }, 45_000);

  it('a plain custom OpenAI-compatible endpoint gets no session headers or cache key', async () => {
    await withStack({}, async (stack) => {
      const captured = spyFetch({ watched: [stack.llm.url] });
      stack.llm.script('mock-main', [step().replyText('收到')]);
      const { rawIds } = await chatOnce(stack, '小普', 'completed');

      expect(captured.length).toBeGreaterThan(0);
      for (const request of captured) expect(sessionValues(request)).toEqual({});
      expectNoRawIds(captured, rawIds);
    });
  }, 30_000);

  it('OpenRouter-detected and api.openai.com-proxy endpoints get only the opaque id', async () => {
    await withStack({}, async (stack) => {
      const origin = new URL(stack.llm.url).origin;
      // pi-ai detects OpenRouter / OpenAI by substring of the baseUrl: a proxy
      // path containing the host name is enough (and still reaches the mock).
      const openRouterUrl = `${origin}/openrouter.ai/api/v1`;
      const openAiProxyUrl = `${origin}/api.openai.com/v1`;
      const settings = (await stack.core.rpc.call('settings.get')) as {
        customProviders: unknown[];
      };
      await stack.core.rpc.call('settings.update', {
        customProviders: [
          ...settings.customProviders,
          { id: 'or', name: 'OR', baseUrl: openRouterUrl, models: [{ id: 'or-main', name: 'OR' }] },
          {
            id: 'oaiproxy',
            name: 'Proxy',
            baseUrl: openAiProxyUrl,
            models: [{ id: 'proxy-main', name: 'Proxy' }],
          },
        ],
      });
      const captured = spyFetch({ watched: [openRouterUrl, openAiProxyUrl] });

      stack.llm.script('or-main', [step().replyText('收到 OR')]);
      await stack.core.rpc.call('settings.update', { defaultMainModel: 'custom:or/or-main' });
      const orChat = await chatOnce(stack, '小路', 'completed');

      stack.llm.script('proxy-main', [step().replyText('收到 proxy')]);
      await stack.core.rpc.call('settings.update', {
        defaultMainModel: 'custom:oaiproxy/proxy-main',
      });
      const proxyChat = await chatOnce(stack, '小代', 'completed');

      const orRequests = captured.filter((c) => c.url.startsWith(openRouterUrl));
      const proxyRequests = captured.filter((c) => c.url.startsWith(openAiProxyUrl));
      expect(orRequests.length).toBeGreaterThan(0);
      expect(proxyRequests.length).toBeGreaterThan(0);

      // OpenRouter format: x-session-id only.
      const orValues = sessionValues(orRequests[0]!);
      expect(Object.keys(orValues)).toEqual(['header:x-session-id']);
      expect(orValues['header:x-session-id']).toMatch(OPAQUE_ID);
      // Chat Completions on an api.openai.com URL: prompt_cache_key only.
      const proxyValues = sessionValues(proxyRequests[0]!);
      expect(Object.keys(proxyValues)).toEqual(['body:prompt_cache_key']);
      expect(proxyValues['body:prompt_cache_key']).toMatch(OPAQUE_ID);
      // Different conversations and providers: unrelated ids.
      expect(proxyValues['body:prompt_cache_key']).not.toBe(orValues['header:x-session-id']);

      expectNoRawIds(captured, [...orChat.rawIds, ...proxyChat.rawIds]);
    });
  }, 45_000);

  it('OpenAI Responses and Mistral get only the opaque id in every session field', async () => {
    await withStack(RETRY_ENV, async (stack) => {
      const captured = spyFetch({
        watched: ['https://api.openai.com/', 'https://api.mistral.ai/'],
        stubbed: ['https://api.openai.com/', 'https://api.mistral.ai/'],
      });
      await stack.core.rpc.call('providers.setKey', { provider: 'openai', key: 'sk-test' });
      await stack.core.rpc.call('providers.setKey', { provider: 'mistral', key: 'mk-test' });

      await stack.core.rpc.call('settings.update', {
        defaultMainModel: `openai/${await firstModelOf(stack, 'openai')}`,
      });
      const openaiChat = await chatOnce(stack, '小欧', 'failed');
      await stack.core.rpc.call('settings.update', {
        defaultMainModel: `mistral/${await firstModelOf(stack, 'mistral')}`,
      });
      const mistralChat = await chatOnce(stack, '小米', 'failed');

      const openai = captured.filter((c) => c.url.startsWith('https://api.openai.com/'));
      const mistral = captured.filter((c) => c.url.startsWith('https://api.mistral.ai/'));
      expect(openai.length).toBeGreaterThan(0);
      expect(mistral.length).toBeGreaterThan(0);

      const openaiValues = sessionValues(openai[0]!);
      expect(Object.keys(openaiValues).sort()).toEqual([
        'body:prompt_cache_key',
        'header:session_id',
        'header:x-client-request-id',
      ]);
      const mistralValues = sessionValues(mistral[0]!);
      // pi-ai's `promptCacheKey` is serialized as `prompt_cache_key` on the wire.
      expect(Object.keys(mistralValues).sort()).toEqual([
        'body:prompt_cache_key',
        'header:x-affinity',
      ]);
      for (const values of [openaiValues, mistralValues]) {
        const distinct = new Set(Object.values(values));
        expect(distinct.size).toBe(1);
        expect([...distinct][0]).toMatch(OPAQUE_ID);
      }

      expectNoRawIds(captured, [...openaiChat.rawIds, ...mistralChat.rawIds]);
    });
  }, 45_000);

  it('a provider test connection sends an opaque per-provider id (providers.test)', async () => {
    await withStack(RETRY_ENV, async (stack) => {
      const captured = spyFetch({
        watched: ['https://opencode.ai/', 'https://api.openai.com/'],
        stubbed: ['https://opencode.ai/', 'https://api.openai.com/'],
      });
      await stack.core.rpc.call('providers.setKey', { provider: 'opencode-go', key: 'test-key' });
      await stack.core.rpc.call('providers.setKey', { provider: 'openai', key: 'sk-test' });
      for (let i = 0; i < 2; i++) {
        await expect(
          stack.core.rpc.call('providers.test', { provider: 'opencode-go' }),
        ).rejects.toBeTruthy();
      }
      await expect(
        stack.core.rpc.call('providers.test', { provider: 'openai' }),
      ).rejects.toBeTruthy();

      const opencode = captured.filter((c) => c.url.startsWith('https://opencode.ai/'));
      const openai = captured.filter((c) => c.url.startsWith('https://api.openai.com/'));
      expect(opencode.length).toBeGreaterThanOrEqual(2);
      const values = new Set(opencode.map((c) => c.headers['x-opencode-session']));
      expect(values.size).toBe(1);
      const opencodeId = [...values][0]!;
      expect(opencodeId).toMatch(OPAQUE_ID);
      expect(opencodeId).not.toContain('opencode');

      expect(openai.length).toBeGreaterThan(0);
      const openaiKey = bodyKeys(openai[0]!).prompt_cache_key;
      expect(openaiKey).toMatch(OPAQUE_ID);
      expect(openaiKey).not.toBe(opencodeId);
      for (const request of captured) {
        expect(`${JSON.stringify(request.headers)}${request.body}`).not.toContain('provider-test');
      }
    });
  }, 30_000);

  it('another install derives a different id for the same kind of request', async () => {
    const idFor = async (): Promise<string> => {
      let value = '';
      await withStack(RETRY_ENV, async (stack) => {
        const captured = spyFetch({
          watched: ['https://opencode.ai/'],
          stubbed: ['https://opencode.ai/'],
        });
        await stack.core.rpc.call('providers.setKey', {
          provider: 'opencode-go',
          key: 'test-key',
        });
        await expect(
          stack.core.rpc.call('providers.test', { provider: 'opencode-go' }),
        ).rejects.toBeTruthy();
        value = captured[0]!.headers['x-opencode-session'] ?? '';
      });
      vi.restoreAllMocks();
      return value;
    };
    const first = await idFor();
    const second = await idFor();
    expect(first).toMatch(OPAQUE_ID);
    expect(second).toMatch(OPAQUE_ID);
    expect(second).not.toBe(first);
  }, 30_000);
});

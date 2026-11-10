import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsSchema, type ProviderInstance, type Settings } from '@kepcup/shared';
import { PiEngine } from '../../src/agent/pi-engine.js';
import type { RunSpec, ToolDefinition } from '../../src/agent/types.js';
import type { SecretsService } from '../../src/domain/secrets.js';
import type { SettingsService } from '../../src/domain/settings.js';

/**
 * 改 Bot 模型的生效时机（PiEngine `RunSpec.currentModelRef`，对话轮与任务同一条
 * PiEngine 路径）：
 * - Loop 正常推进时改模型不打断：下一次请求仍用本 run 已在用的模型（换供应商会
 *   重建提示缓存）；等本次 Loop 结束，下一个 run 才用新模型。
 * - 一旦 Loop 内出错进入退避重试，重试必须用用户当前设置的模型：退避被打断，
 *   丢掉那次尝试的错误轮，立刻用新模型继续同一段对话。
 * - 重启会重建跟模型 / transcript 绑定的 run 内状态（计划注入、压缩器、图片
 *   能力），用量按实际供应商记账；最多切换 3 次。
 */

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

function secrets(): SecretsService {
  return {
    getValue: () => 'sk-test',
    hasValue: () => true,
    names: () => ['provider:one', 'provider:two'],
    setValue: () => {},
    removeValue: () => {},
    redact: (text: string) => text,
    modelSessionKey: () => Buffer.alloc(32, 1),
  } as unknown as SecretsService;
}

function instance(
  id: string,
  baseUrl: string,
  model: string,
  input: Array<'text' | 'image'> = ['text'],
): ProviderInstance {
  return {
    id,
    vendor: null,
    name: id,
    baseUrl,
    enabled: true,
    api: 'openai-completions',
    builtinCatalog: false,
    models: [{ id: model, capabilities: ['chat'], contextWindow: 8_192, input }],
  };
}

function settings(): Settings {
  return settingsSchema.parse({
    modelProviders: [
      instance('one', 'https://one.example/v1', 'alpha'),
      instance('two', 'https://two.example/v1', 'beta', ['text', 'image']),
    ],
    defaultMainModel: 'one/alpha',
  });
}

/** Minimal OpenAI-compatible SSE stream (deltas, then `finish`). */
function sseChunks(model: string, deltas: object[], finish: string): Response {
  const chunk = (delta: object, reason: string | null): string =>
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: reason }],
    });
  const body = [
    ...deltas.map((delta) => `data: ${chunk(delta, null)}`),
    `data: ${chunk({}, finish)}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const sseText = (text: string, model: string): Response =>
  sseChunks(model, [{ role: 'assistant', content: text }], 'stop');

function sseToolCall(model: string, name: string, args: object): Response {
  return sseChunks(
    model,
    [
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    ],
    'tool_calls',
  );
}

const rateLimited = (): Response =>
  new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '0' },
  });

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

interface FetchLog {
  urls: string[];
  bodies: string[];
}

function stubFetch(log: FetchLog, answer: (url: string, call: number) => Response): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    log.urls.push(url);
    log.bodies.push(String(init?.body ?? ''));
    return answer(url, log.urls.length);
  });
}

function engine(): PiEngine {
  return new PiEngine({
    settings: { get: () => settings() } as unknown as SettingsService,
    secrets: secrets(),
    logger: LOGGER,
    modelRetry: { maxRetries: 5, baseDelayMs: 20, maxDelayMs: 40, maxRetryAfterMs: 5_000 },
  });
}

function spec(
  current: () => string,
  tools: ToolDefinition[] = [],
  loopType: 'turn' | 'task' = 'turn',
): RunSpec {
  return {
    identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType },
    model: 'one/alpha',
    currentModelRef: current,
    buildSystemPrompt: async () => 'S',
    messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    tools,
    limits: { maxTurns: 8 },
  };
}

/** The user changes the Bot model while this tool runs (between two requests). */
function echoTool(onCall: () => void): ToolDefinition {
  return {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      onCall();
      return { ok: true, content: 'done' };
    },
  };
}

/** Progress texts, plus a hook for reacting to them (countdown / switch). */
function watchProgress(
  handle: ReturnType<PiEngine['startRun']>,
  onText?: (text: string) => void,
): string[] {
  const progress: string[] = [];
  handle.onEvent((event) => {
    if (event.type !== 'progress') return;
    const text = String((event.payload as { text?: string }).text ?? '');
    progress.push(text);
    onText?.(text);
  });
  return progress;
}

function switchOnCountdown(handle: ReturnType<PiEngine['startRun']>, next: () => string): string[] {
  return watchProgress(handle, (text) => {
    if (text.includes('秒后重试')) next();
  });
}

function bodyOf(
  log: FetchLog,
  index: number,
): { messages: Array<{ role: string; content: unknown }> } {
  return JSON.parse(log.bodies[index] ?? '{}') as {
    messages: Array<{ role: string; content: unknown }>;
  };
}

const rolesOf = (log: FetchLog, index: number): string[] =>
  bodyOf(log, index).messages.map((message) => message.role);

const hasText = (log: FetchLog, index: number, text: string): boolean =>
  bodyOf(log, index).messages.some((message) => JSON.stringify(message.content).includes(text));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PiEngine route-change restart', () => {
  it('switches to the new model as soon as the Bot model changes during a 429 backoff', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    stubFetch(log, (url) =>
      url.startsWith('https://one.example/') ? rateLimited() : sseText('OK', 'beta'),
    );

    const handle = engine().startRun(spec(() => current));
    const routeEvents: Array<{ provider: string; model: string }> = [];
    handle.onEvent((event) => {
      if (event.type === 'route_switched') routeEvents.push(event.payload);
    });
    const progress = switchOnCountdown(handle, () => {
      current = 'two/beta';
    });

    const outcome = await handle.done;

    expect(outcome).toMatchObject({ status: 'completed', finalText: 'OK' });
    // The orchestrator turns this into the run row's new provider/model.
    expect(routeEvents).toEqual([{ provider: 'two', model: 'beta' }]);
    // The old provider was tried exactly once; the new one answered.
    expect(log.urls.filter((url) => url.startsWith('https://one.example/'))).toHaveLength(1);
    expect(log.urls.filter((url) => url.startsWith('https://two.example/'))).toHaveLength(1);
    expect(progress.some((text) => text.includes('模型已切换（beta）'))).toBe(true);
    // Usage is attributed to the model that actually produced it.
    expect(outcome.status === 'completed' ? outcome.usage : []).toEqual([
      expect.objectContaining({ provider: 'two', model: 'beta' }),
    ]);
  });

  it('keeps the loop on the old model after a mid-loop change; only the retry moves', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    let oneCalls = 0;
    stubFetch(log, (url) => {
      if (!url.startsWith('https://one.example/')) return sseText('OK', 'beta');
      oneCalls += 1;
      // Turn 1 succeeds (asks for the echo tool); turn 2 hits the rate limit.
      return oneCalls === 1 ? sseToolCall('alpha', 'echo', {}) : rateLimited();
    });

    const handle = engine().startRun(
      spec(
        () => current,
        // 用户在 Loop 进行中（工具执行时）改了模型。
        [echoTool(() => (current = 'two/beta'))],
      ),
    );
    const progress = watchProgress(handle);

    const outcome = await handle.done;

    expect(outcome).toMatchObject({ status: 'completed', finalText: 'OK' });
    // 请求 1/2 都发往旧供应商——改模型不打断正常 Loop（保住提示缓存）；
    // 请求 2 出错进入退避，重试立刻改用新供应商。
    expect(log.urls).toEqual([
      'https://one.example/v1/chat/completions',
      'https://one.example/v1/chat/completions',
      'https://two.example/v1/chat/completions',
    ]);
    // 被中止那次尝试的合成 error 轮没有进入新请求：上下文是
    // [system, user, assistant(toolUse), tool]。
    expect(rolesOf(log, 2)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(progress.some((text) => text.includes('模型已切换（beta）'))).toBe(true);
    expect(outcome.status === 'completed' ? outcome.usage : []).toEqual([
      expect.objectContaining({ provider: 'one', model: 'alpha' }),
      expect.objectContaining({ provider: 'two', model: 'beta' }),
    ]);
  });

  it('a mid-loop change alone never switches: the loop finishes on its starting model', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    let oneCalls = 0;
    stubFetch(log, () => {
      oneCalls += 1;
      return oneCalls === 1 ? sseToolCall('alpha', 'echo', {}) : sseText('done on A', 'alpha');
    });

    const handle = engine().startRun(spec(() => current, [echoTool(() => (current = 'two/beta'))]));
    const progress = watchProgress(handle);

    const outcome = await handle.done;

    expect(outcome).toMatchObject({ status: 'completed', finalText: 'done on A' });
    // 没有出错就没有切换：整个 Loop 都留在旧供应商上。
    expect(log.urls.every((url) => url.startsWith('https://one.example/'))).toBe(true);
    expect(progress.some((text) => text.includes('模型已切换'))).toBe(false);
  });

  it('re-injects the plan after a restart (it only lived in the old loop context)', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    let oneCalls = 0;
    stubFetch(log, (url) => {
      if (!url.startsWith('https://one.example/')) return sseText('done', 'beta');
      oneCalls += 1;
      if (oneCalls === 1) {
        return sseToolCall('alpha', 'update_plan', {
          plan: [{ step: 'step one', status: 'in_progress' }],
        });
      }
      return rateLimited();
    });

    const handle = engine().startRun(spec(() => current, [], 'task'));
    switchOnCountdown(handle, () => {
      current = 'two/beta';
    });

    const outcome = await handle.done;

    expect(outcome).toMatchObject({ status: 'completed', finalText: 'done' });
    // Request 2 (the 429 attempt) carried the plan; request 3 on the new model
    // must carry it again — the plan was not part of state.messages.
    expect(hasText(log, 1, '<current_plan>')).toBe(true);
    expect(hasText(log, 2, '<current_plan>')).toBe(true);
    expect(hasText(log, 2, 'step one')).toBe(true);
  });

  it('a cancel during the restart gap settles cancelled without hitting the new provider', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    stubFetch(log, (url) =>
      url.startsWith('https://one.example/') ? rateLimited() : sseText('OK', 'beta'),
    );

    const handle = engine().startRun(spec(() => current));
    watchProgress(handle, (text) => {
      if (text.includes('秒后重试')) current = 'two/beta';
      if (text.includes('模型已切换')) handle.abort('user cancelled');
    });

    const outcome = await handle.done;

    expect(outcome.status).toBe('cancelled');
    // Only the old provider was contacted.
    expect(log.urls).toEqual(['https://one.example/v1/chat/completions']);
  });

  it('a steer queued during the restart gap is delivered on the new model', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    stubFetch(log, (url) =>
      url.startsWith('https://one.example/') ? rateLimited() : sseText('OK', 'beta'),
    );

    const handle = engine().startRun(spec(() => current));
    let steerAccepted: boolean | null = null;
    watchProgress(handle, (text) => {
      if (text.includes('秒后重试')) current = 'two/beta';
      if (text.includes('模型已切换')) steerAccepted = handle.steer('额外指示');
    });

    const outcome = await handle.done;

    expect(outcome).toMatchObject({ status: 'completed', finalText: 'OK' });
    expect(steerAccepted).toBe(true);
    expect(hasText(log, 1, '额外指示')).toBe(true);
  });

  it('rebuilds trigger images when the new model accepts image input', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    stubFetch(log, (url) =>
      url.startsWith('https://one.example/') ? rateLimited() : sseText('OK', 'beta'),
    );

    const base = spec(() => current);
    const specWithImage: RunSpec = {
      ...base,
      messages: [
        {
          role: 'user',
          content: '看图',
          timestamp: 0,
          images: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }],
        },
      ],
    };
    const handle = engine().startRun(specWithImage);
    switchOnCountdown(handle, () => {
      current = 'two/beta';
    });

    const outcome = await handle.done;

    expect(outcome).toMatchObject({ status: 'completed', finalText: 'OK' });
    // The old model drops image bytes and explains why; after the switch the
    // trigger message is rebuilt for the vision model.
    expect(hasText(log, 0, '当前模型不支持图像输入')).toBe(true);
    expect(hasText(log, 0, 'aGVsbG8=')).toBe(false);
    expect(hasText(log, 1, 'aGVsbG8=')).toBe(true);
  });

  it('a fixed-route caller stops with a readable reason instead of the transport error', async () => {
    let stale = false;
    const log: FetchLog = { urls: [], bodies: [] };
    stubFetch(log, (url) =>
      url.startsWith('https://one.example/') ? rateLimited() : sseText('OK', 'beta'),
    );

    const handle = engine().startRun({
      identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' },
      model: 'one/alpha',
      isRouteCurrent: () => !stale,
      buildSystemPrompt: async () => 'S',
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      tools: [],
      limits: { maxTurns: 8 },
    });
    watchProgress(handle, (text) => {
      if (text.includes('秒后重试')) stale = true;
    });

    const outcome = await handle.done;

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error.message : '').toContain(
      '模型设置已变更，本次执行已停止',
    );
    // Fixed route: it never followed the change to the other provider.
    expect(log.urls).toEqual(['https://one.example/v1/chat/completions']);
  });

  it('stops following changes after 3 restarts and says why', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    // Every provider keeps rate-limiting; the user keeps flipping models.
    stubFetch(log, () => rateLimited());

    const handle = engine().startRun(spec(() => current));
    switchOnCountdown(handle, () => {
      current = current === 'one/alpha' ? 'two/beta' : 'one/alpha';
    });

    const outcome = await handle.done;

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error.message : '').toContain('连续切换多次');
  });

  it('fails with the route reason when the new model is unusable, not with the transport error', async () => {
    let current = 'one/alpha';
    const log: FetchLog = { urls: [], bodies: [] };
    stubFetch(log, (url) =>
      url.startsWith('https://one.example/') ? rateLimited() : sseText('OK', 'beta'),
    );

    const handle = engine().startRun(spec(() => current));
    switchOnCountdown(handle, () => {
      current = 'gone/missing';
    });

    const outcome = await handle.done;

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error.message : '').toContain('没能切换到新模型');
    // No retry was sent to the provider it cannot resolve.
    expect(log.urls).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsSchema, type Settings } from '@kepcup/shared';
import { PiEngine } from '../../src/agent/pi-engine.js';
import type { CompletionRequest } from '../../src/agent/types.js';
import type { SecretsService } from '../../src/domain/secrets.js';
import type { SettingsService } from '../../src/domain/settings.js';

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

function secrets(): SecretsService {
  return {
    getValue: () => 'sk-test',
    hasValue: () => true,
    names: () => ['provider:p'],
    setValue: () => {},
    removeValue: () => {},
    redact: (text: string) => text,
    registerRedactValue: () => {},
    modelSessionKey: () => Buffer.alloc(32, 1),
  } as unknown as SecretsService;
}

function settings(): Settings {
  return settingsSchema.parse({
    modelProviders: [
      {
        id: 'p',
        vendor: null,
        name: 'P',
        baseUrl: 'https://p.example/v1',
        enabled: true,
        api: 'openai-completions',
        builtinCatalog: false,
        models: [{ id: 'm', capabilities: ['chat'], contextWindow: 8_192 }],
      },
    ],
    defaultMainModel: 'p/m',
  });
}

function request(): CompletionRequest {
  return {
    identity: { runId: 'run', botId: null, conversationId: null, loopType: 'reflection' },
    model: 'p/m',
    systemPrompt: 's',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  } as CompletionRequest;
}

function engine(): PiEngine {
  return new PiEngine({
    settings: { get: () => settings() } as unknown as SettingsService,
    secrets: secrets(),
    logger: LOGGER,
    modelRetry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1_000 },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PiEngine.complete provider errors', () => {
  it('把 stopReason=error 的失败转成 AppError：后台结构化调用拿得到真实 429，而不是空回复', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ type: 'GoUsageLimitError', message: 'Go usage limit exceeded' }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await expect(engine().complete(request())).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
  });
});

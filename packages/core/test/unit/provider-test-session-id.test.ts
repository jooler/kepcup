import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsSchema } from '@kepcup/shared';
import { testProvider } from '../../src/agent/models.js';
import { providerTestSessionId } from '../../src/agent/model-session-id.js';
import { ProvidersService } from '../../src/domain/providers.js';
import type { SecretsService } from '../../src/domain/secrets.js';
import type { SettingsService } from '../../src/domain/settings.js';

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Provider "测试连接" requests carry the opaque per-provider session id
 * (`providerTestSessionId`, derivation covered in model-session-id.test.ts);
 * testProvider only forwards whatever it is given.
 */
describe('testProvider', () => {
  it('forwards the session id to the model request', async () => {
    const sessionId = providerTestSessionId(Buffer.alloc(32, 3), 'opencode-go');
    const complete = vi.fn(async (..._args: unknown[]) => ({ stopReason: 'stop', content: [] }));
    await testProvider({
      models: { complete } as never,
      model: { provider: 'opencode-go', id: 'glm-5.3' } as never,
      sessionId,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![2]).toMatchObject({ sessionId });
  });

  it('omits the session id when none is provided', async () => {
    const complete = vi.fn(async (..._args: unknown[]) => ({ stopReason: 'stop', content: [] }));
    await testProvider({
      models: { complete } as never,
      model: { provider: 'x', id: 'y' } as never,
    });
    expect(complete.mock.calls[0]![2]).not.toHaveProperty('sessionId');
  });
});

describe('ProvidersService.test without a session key', () => {
  // An OpenRouter-detected URL: pi-ai sends `x-session-id` whenever it has a session id.
  const BASE = 'http://127.0.0.1:9/openrouter.ai/v1';
  const settings = settingsSchema.parse({
    customProviders: [
      {
        id: 'or',
        name: 'OR',
        baseUrl: BASE,
        models: [{ id: 'm', name: 'M', contextWindow: 8_000 }],
      },
    ],
  });

  async function runTest(modelSessionKey: () => Buffer): Promise<{
    error: unknown;
    sessionHeaders: Array<string | null>;
  }> {
    const sessionHeaders: Array<string | null> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(BASE)) {
        sessionHeaders.push(
          new Headers(init?.headers as HeadersInit | undefined).get('x-session-id'),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
        }),
      );
    });
    const service = new ProvidersService({
      settings: { get: () => settings } as unknown as SettingsService,
      secrets: {
        getValue: () => 'sk-test',
        hasValue: () => true,
        names: () => [],
        redact: (text: string) => text,
        modelSessionKey,
      } as unknown as SecretsService,
      logger: LOGGER,
    });
    const error = await service.test('custom:or').then(
      () => null,
      (e: unknown) => e,
    );
    return { error, sessionHeaders };
  }

  it('control: with a key the request carries the opaque id', async () => {
    const { error, sessionHeaders } = await runTest(() => Buffer.alloc(32, 4));
    expect(error).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect(sessionHeaders.length).toBeGreaterThan(0);
    expect(sessionHeaders[0]).toMatch(/^kep-[0-9a-f]{32}$/);
  });

  it('key unavailable (throws): no fallback id, the header is omitted and the test still runs', async () => {
    const { error, sessionHeaders } = await runTest(() => {
      throw new Error('keystore locked');
    });
    // The provider's answer, not a crash in the session-id code.
    expect(error).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect(sessionHeaders.length).toBeGreaterThan(0);
    expect(sessionHeaders.every((value) => value === null)).toBe(true);
  });
});

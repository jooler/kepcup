import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

/**
 * OpenCode Go requires `x-opencode-session` (a stable per-conversation id) on
 * every request to its endpoints (https://opencode.ai/v2/docs/console/go).
 * The engine passes the conversation-derived session id to pi-ai for every
 * model request; these verify it reaches the wire for OpenCode and is not sent
 * to (and is safely ignored by) other providers.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

const RETRY_ENV = {
  KEPCUP_MODEL_RETRY_BASE_DELAY_MS: '10',
  KEPCUP_MODEL_RETRY_MAX_DELAY_MS: '20',
};

function sessionHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers as HeadersInit | undefined).get('x-opencode-session');
}

function fetchUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
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

describe('OpenCode session header (PiEngine)', () => {
  it('sends x-opencode-session = kep-<conversationId> for opencode-go models', async () => {
    await withStack(RETRY_ENV, async (stack) => {
      const captured: Array<string | null> = [];
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (fetchUrl(input).startsWith('https://opencode.ai/')) {
          captured.push(sessionHeader(init));
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
              status: 401,
              headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
            }),
          );
        }
        return realFetch(input, init);
      });

      await stack.core.rpc.call('providers.setKey', { provider: 'opencode-go', key: 'test-key' });
      await stack.core.rpc.call('settings.update', {
        defaultMainModel: 'opencode-go/glm-5.3',
      });

      const bot = await makeBot(stack.core, '小开');
      const conv = await openDirect(stack.core, bot.id);
      await sendBatch(stack.core, conv.id, ['你好']);
      await waitForRun(stack.core, conv.id, 'failed');

      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0]).toBe(`kep-${conv.id}`);
    });
  }, 30_000);

  it('does not leak the header to non-OpenCode providers, which still succeed', async () => {
    await withStack({}, async (stack) => {
      const captured: Array<string | null> = [];
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (fetchUrl(input).startsWith(stack.llm.url)) captured.push(sessionHeader(init));
        return realFetch(input, init);
      });

      stack.llm.script('mock-main', [step().replyText('收到')]);
      const bot = await makeBot(stack.core, '小普');
      const conv = await openDirect(stack.core, bot.id);
      await sendBatch(stack.core, conv.id, ['你好']);
      await waitForRun(stack.core, conv.id, 'completed');

      expect(captured.length).toBeGreaterThan(0);
      expect(captured.every((value) => value === null)).toBe(true);
    });
  }, 30_000);

  it('sends x-opencode-session on a provider test connection (providers.test)', async () => {
    await withStack(RETRY_ENV, async (stack) => {
      const captured: Array<string | null> = [];
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (fetchUrl(input).startsWith('https://opencode.ai/')) {
          captured.push(sessionHeader(init));
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
              status: 401,
              headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
            }),
          );
        }
        return realFetch(input, init);
      });

      await stack.core.rpc.call('providers.setKey', { provider: 'opencode-go', key: 'test-key' });
      await expect(
        stack.core.rpc.call('providers.test', { provider: 'opencode-go' }),
      ).rejects.toBeTruthy();

      expect(captured.length).toBeGreaterThan(0);
      expect(captured.every((value) => value === 'kep-provider-test:opencode-go')).toBe(true);
    });
  }, 30_000);
});

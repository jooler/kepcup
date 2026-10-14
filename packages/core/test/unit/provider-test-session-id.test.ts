import { describe, expect, it, vi } from 'vitest';
import { providerTestSessionId, testProvider } from '../../src/agent/models.js';

/**
 * Provider "测试连接" requests also carry a session id (OpenCode's
 * `x-opencode-session`); it has no conversation, so it is stable per provider.
 * Other providers ignore it like any other request.
 */
describe('providerTestSessionId', () => {
  it('is prefixed and stable per provider, distinct across providers', () => {
    expect(providerTestSessionId('opencode-go')).toBe('kep-provider-test:opencode-go');
    expect(providerTestSessionId('opencode-go')).toBe(providerTestSessionId('opencode-go'));
    expect(providerTestSessionId('opencode-go')).not.toBe(providerTestSessionId('openai'));
  });
});

describe('testProvider', () => {
  it('forwards the session id to the model request', async () => {
    const complete = vi.fn(async (..._args: unknown[]) => ({ stopReason: 'stop', content: [] }));
    await testProvider({
      models: { complete } as never,
      model: { provider: 'opencode-go', id: 'glm-5.3' } as never,
      sessionId: providerTestSessionId('opencode-go'),
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![2]).toMatchObject({
      sessionId: 'kep-provider-test:opencode-go',
    });
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

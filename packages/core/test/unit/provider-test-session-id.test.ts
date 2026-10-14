import { describe, expect, it, vi } from 'vitest';
import { testProvider } from '../../src/agent/models.js';
import { providerTestSessionId } from '../../src/agent/model-session-id.js';

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

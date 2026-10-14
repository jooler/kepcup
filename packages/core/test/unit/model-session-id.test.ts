import { describe, expect, it } from 'vitest';
import { modelSessionId } from '../../src/agent/models.js';

/**
 * OpenCode Go requires a stable per-conversation session id sent as
 * `x-opencode-session` (routing + prompt caching). The engine derives it from
 * the run identity; these cover the derivation rules.
 */
describe('modelSessionId', () => {
  it('uses the conversation id and stays stable across a conversation’s runs', () => {
    const first = modelSessionId({ conversationId: 'conv_01ABCD', runId: 'run_01AAAA' });
    const later = modelSessionId({ conversationId: 'conv_01ABCD', runId: 'run_01ZZZZ' });
    expect(first).toBe('kep-conv_01ABCD');
    expect(later).toBe(first);
  });

  it('falls back to the run id for conversation-less one-shot calls', () => {
    expect(modelSessionId({ conversationId: null, runId: 'run_01BBBB' })).toBe('kep-run_01BBBB');
  });

  it('distinguishes different conversations', () => {
    expect(modelSessionId({ conversationId: 'conv_A', runId: 'r' })).not.toBe(
      modelSessionId({ conversationId: 'conv_B', runId: 'r' }),
    );
  });
});

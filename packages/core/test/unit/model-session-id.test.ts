import { describe, expect, it } from 'vitest';
import {
  modelSessionId,
  providerTestSessionId,
  type ModelSessionScope,
} from '../../src/agent/model-session-id.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openRealMainDb } from '../support/real-secrets.js';

/**
 * pi-ai turns `sessionId` into provider headers / prompt-cache keys well beyond
 * OpenCode (OpenAI, Azure, Mistral, OpenRouter, any URL containing
 * api.openai.com). The id must therefore be an opaque keyed derivation —
 * stable where caching / routing need it, unrelated across installs, providers
 * and prompt purposes, and never the raw internal id.
 */

const KEY_A = deriveKey(Buffer.alloc(32, 1), KEY_INFO.modelSession);
const KEY_B = deriveKey(Buffer.alloc(32, 2), KEY_INFO.modelSession);
const ID_FORMAT = /^kep-[0-9a-f]{32}$/;

function scope(
  overrides: {
    provider?: string;
    runId?: string;
    botId?: string | null;
    conversationId?: string | null;
    loopType?: ModelSessionScope['identity']['loopType'];
    call?: ModelSessionScope['call'];
  } = {},
): ModelSessionScope {
  return {
    provider: overrides.provider ?? 'openai',
    identity: {
      runId: overrides.runId ?? 'run_01AAAA',
      botId: overrides.botId === undefined ? 'bot_01XYZ' : overrides.botId,
      conversationId:
        overrides.conversationId === undefined ? 'conv_01ABCD' : overrides.conversationId,
      loopType: overrides.loopType ?? 'turn',
    },
    call: overrides.call ?? 'loop',
  };
}

describe('modelSessionId', () => {
  it('is an opaque kep- id that never contains the raw ids', () => {
    const value = modelSessionId(KEY_A, scope());
    expect(value).toMatch(ID_FORMAT);
    expect(value.length).toBeLessThanOrEqual(64); // OpenAI prompt_cache_key limit
    for (const raw of ['conv_01ABCD', '01ABCD', 'run_01AAAA', 'bot_01XYZ', 'openai']) {
      expect(value).not.toContain(raw);
    }
  });

  it('is stable for one conversation + purpose across runs (routing / prompt cache)', () => {
    const first = modelSessionId(KEY_A, scope({ runId: 'run_01AAAA' }));
    const later = modelSessionId(KEY_A, scope({ runId: 'run_01ZZZZ' }));
    expect(later).toBe(first);
    // Deterministic: a second derivation from the same key is identical.
    expect(modelSessionId(Buffer.from(KEY_A), scope())).toBe(first);
  });

  it('separates purposes so unrelated prompt prefixes do not share a cache key', () => {
    const purposes: Array<Partial<Parameters<typeof scope>[0]>> = [
      { loopType: 'turn', call: 'loop' },
      { loopType: 'task', call: 'loop' },
      { loopType: 'turn', call: 'oneshot' },
      { loopType: 'conversation_summary', call: 'oneshot' },
      { loopType: 'triage', call: 'oneshot' },
      { loopType: 'memory_consolidation', call: 'oneshot' },
      { loopType: 'reflection', call: 'oneshot' },
      { loopType: 'wiki_maintenance', call: 'loop' },
      { loopType: 'subagent', call: 'loop' },
      { loopType: 'subagent', call: 'oneshot' },
    ];
    const ids = purposes.map((p) => modelSessionId(KEY_A, scope(p)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('differs across conversations, Bots in one group, providers and installs', () => {
    const base = modelSessionId(KEY_A, scope());
    expect(modelSessionId(KEY_A, scope({ conversationId: 'conv_OTHER' }))).not.toBe(base);
    expect(modelSessionId(KEY_A, scope({ botId: 'bot_OTHER' }))).not.toBe(base);
    expect(modelSessionId(KEY_A, scope({ provider: 'mistral' }))).not.toBe(base);
    expect(modelSessionId(KEY_B, scope())).not.toBe(base);
  });

  it('anchors conversation-less calls on the Bot, and Bot-less ones on the run', () => {
    const botScoped = (runId: string) =>
      modelSessionId(
        KEY_A,
        scope({ conversationId: null, runId, loopType: 'memory_consolidation', call: 'oneshot' }),
      );
    // A Bot's background loop keeps one id across runs (same prompt prefix)…
    expect(botScoped('run_1')).toBe(botScoped('run_2'));
    // …that is not the id of any conversation of that Bot.
    expect(botScoped('run_1')).not.toBe(
      modelSessionId(KEY_A, scope({ loopType: 'memory_consolidation', call: 'oneshot' })),
    );
    // No conversation and no Bot: a fresh id per run (nothing to share).
    const hostScoped = (runId: string) =>
      modelSessionId(
        KEY_A,
        scope({ conversationId: null, botId: null, runId, loopType: 'host', call: 'oneshot' }),
      );
    expect(hostScoped('run_1')).not.toBe(hostScoped('run_2'));
    expect(hostScoped('run_1')).not.toContain('run_1');
  });

  it('does not collide across a large sample of conversations × purposes', () => {
    const seen = new Set<string>();
    let count = 0;
    for (let c = 0; c < 500; c++) {
      for (const loopType of ['turn', 'task', 'triage', 'conversation_summary'] as const) {
        for (const call of ['loop', 'oneshot'] as const) {
          const value = modelSessionId(
            KEY_A,
            scope({ conversationId: `conv_${c}`, loopType, call }),
          );
          expect(value).toMatch(ID_FORMAT);
          seen.add(value);
          count++;
        }
      }
    }
    expect(seen.size).toBe(count);
  });

  it('cannot be confused across anchor kinds that reuse the same raw id', () => {
    // A Bot id that happens to equal a conversation id must not map to the same id.
    const asConversation = modelSessionId(
      KEY_A,
      scope({ conversationId: 'x_1', botId: null, call: 'oneshot', loopType: 'host' }),
    );
    const asBot = modelSessionId(
      KEY_A,
      scope({ conversationId: null, botId: 'x_1', call: 'oneshot', loopType: 'host' }),
    );
    const asRun = modelSessionId(
      KEY_A,
      scope({ conversationId: null, botId: null, runId: 'x_1', call: 'oneshot', loopType: 'host' }),
    );
    expect(new Set([asConversation, asBot, asRun]).size).toBe(3);
  });
});

describe('providerTestSessionId', () => {
  it('is opaque, stable per provider and distinct across providers / installs', () => {
    const value = providerTestSessionId(KEY_A, 'opencode-go');
    expect(value).toMatch(ID_FORMAT);
    expect(value).not.toContain('opencode');
    expect(value).not.toContain('provider-test');
    expect(providerTestSessionId(KEY_A, 'opencode-go')).toBe(value);
    expect(providerTestSessionId(KEY_A, 'openai')).not.toBe(value);
    expect(providerTestSessionId(KEY_B, 'opencode-go')).not.toBe(value);
  });
});

describe('missing key', () => {
  it('omits the id (undefined) when the key getter throws or yields no usable key — no fallback key', () => {
    const throwing = () => {
      throw new Error('keystore locked');
    };
    expect(modelSessionId(throwing, scope())).toBeUndefined();
    expect(providerTestSessionId(throwing, 'opencode-go')).toBeUndefined();
    for (const bad of [Buffer.alloc(0), Buffer.alloc(8, 1)]) {
      expect(modelSessionId(bad, scope())).toBeUndefined();
      expect(modelSessionId(() => bad, scope())).toBeUndefined();
      expect(providerTestSessionId(bad, 'opencode-go')).toBeUndefined();
    }
  });

  it('a key getter derives exactly what the key itself derives', () => {
    expect(modelSessionId(() => KEY_A, scope())).toBe(modelSessionId(KEY_A, scope()));
    expect(providerTestSessionId(() => KEY_A, 'openai')).toBe(
      providerTestSessionId(KEY_A, 'openai'),
    );
  });
});

describe('wire value never carries the derivation inputs', () => {
  it('ids shaped like our own output (hex, kep- prefix) do not pass through', () => {
    const hexLike = 'a'.repeat(32);
    const tricky = [hexLike, `kep-${hexLike}`, 'conv_"]["x', 'ünïcødé-会话'];
    for (const raw of tricky) {
      for (const value of [
        modelSessionId(KEY_A, scope({ conversationId: raw, botId: raw, runId: raw })),
        modelSessionId(KEY_A, scope({ conversationId: null, botId: null, runId: raw })),
        modelSessionId(KEY_A, scope({ provider: raw })),
        providerTestSessionId(KEY_A, raw),
      ]) {
        expect(value).toMatch(ID_FORMAT);
        expect(value).not.toContain(raw);
        expect(value).not.toBe(`kep-${raw}`);
      }
    }
  });
});

describe('SecretsService.modelSessionKey', () => {
  it('is derived from the per-install master key and stable for that install', () => {
    const real = openRealMainDb();
    try {
      const key = real.secrets.modelSessionKey();
      expect(key.length).toBe(32);
      // A fresh service over the same install derives the same key…
      expect(real.makeSecrets().modelSessionKey().equals(key)).toBe(true);
      // …and it is a separate HKDF purpose, not the secrets-table key material.
      expect(key.equals(deriveKey(Buffer.alloc(32, 5), KEY_INFO.secrets))).toBe(false);
      expect(key.equals(deriveKey(Buffer.alloc(32, 5), KEY_INFO.modelSession))).toBe(true);
      // Nothing is stored in the secrets table for it.
      expect(real.secrets.names()).toEqual([]);
    } finally {
      real.dispose();
    }
  });
});

import { createHmac } from 'node:crypto';
import type { RunIdentity } from './types.js';

/**
 * Session ids passed to pi-ai as `sessionId` on every model request.
 *
 * pi-ai does not keep this to OpenCode: depending on the wire API and the
 * endpoint it becomes `x-opencode-session` (OpenCode), `session_id` /
 * `x-client-request-id` / `x-session-id` / `x-session-affinity` headers
 * (OpenAI Responses, OpenRouter, Anthropic-compatible endpoints with session
 * affinity), `x-affinity` (Mistral) and the body keys `prompt_cache_key`
 * (OpenAI Responses, Azure, Chat Completions on any baseUrl containing
 * `api.openai.com`) / `promptCacheKey` (Mistral). So the value reaches third
 * parties, and must not carry our internal ids.
 *
 * Each id is `kep-` + 32 hex chars of HMAC-SHA256 under a per-install key
 * (`SecretsService.modelSessionKey()`), over:
 * - the provider id: the same conversation gets unrelated ids at different
 *   providers, so they cannot be joined across providers;
 * - an anchor: the conversation (+ Bot, since Bots in a group chat have
 *   different prompts) when there is one, else the Bot (background loops of
 *   one Bot repeat the same prompt prefix), else the run (fresh id per run:
 *   nothing to share);
 * - a purpose: loop type plus whether this is a multi-turn agent loop
 *   (`startRun`) or a single `complete()` call, so unrelated prompt prefixes
 *   (turn, task, summary, triage, memory, wiki, subagent, …) do not share one
 *   cache key.
 *
 * Within those it is stable, which is what OpenCode routing and the providers'
 * prompt caches need. Different installs derive unrelated ids for the same
 * conversation, and the input ids cannot be recovered from the output.
 * Length 36 stays under OpenAI's 64-char `prompt_cache_key` limit.
 */

const PREFIX = 'kep-';
const DIGEST_HEX_CHARS = 32;
const DOMAIN = 'kepcup/model-session/v1';

/** `loop` = `PiEngine.startRun` (agent loop); `oneshot` = `PiEngine.complete`. */
export type ModelCallKind = 'loop' | 'oneshot';

export interface ModelSessionScope {
  /** pi-ai provider id of the model the request goes to. */
  provider: string;
  identity: Pick<RunIdentity, 'runId' | 'botId' | 'conversationId' | 'loopType'>;
  call: ModelCallKind;
}

/** Shortest key accepted (HKDF output is 32 bytes). */
const MIN_KEY_BYTES = 16;

/**
 * The per-install key, or a getter for it (`() => secrets.modelSessionKey()`).
 * A getter that throws or yields a short key means "no key": the id is then
 * omitted (undefined) rather than derived from any fallback key — a constant
 * fallback would make ids correlatable across installs — and the request goes
 * out without session id (no OpenCode routing hint, no prompt-cache key) instead
 * of failing.
 */
export type ModelSessionKeySource = Uint8Array | (() => Uint8Array);

function resolveKey(source: ModelSessionKeySource): Uint8Array | null {
  try {
    const key = typeof source === 'function' ? source() : source;
    return key instanceof Uint8Array && key.length >= MIN_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

function keyedId(source: ModelSessionKeySource, parts: readonly string[]): string | undefined {
  const key = resolveKey(source);
  if (key === null) return undefined;
  // JSON array encoding keeps field boundaries unambiguous.
  const digest = createHmac('sha256', key)
    .update(JSON.stringify([DOMAIN, ...parts]))
    .digest('hex');
  return `${PREFIX}${digest.slice(0, DIGEST_HEX_CHARS)}`;
}

/** Session id for a model request made on behalf of a run; undefined without a key. */
export function modelSessionId(
  key: ModelSessionKeySource,
  scope: ModelSessionScope,
): string | undefined {
  const { identity } = scope;
  const anchor =
    identity.conversationId !== null
      ? ['conversation', identity.conversationId, identity.botId ?? '']
      : identity.botId !== null
        ? ['bot', identity.botId]
        : ['run', identity.runId];
  return keyedId(key, [
    'run-request',
    scope.provider,
    ...anchor,
    `${scope.call}:${identity.loopType}`,
  ]);
}

/**
 * Session id for a provider "测试连接" request: no run, so one stable id per
 * provider (repeated tests share OpenCode routing).
 */
export function providerTestSessionId(
  key: ModelSessionKeySource,
  providerId: string,
): string | undefined {
  return keyedId(key, ['provider-test', providerId]);
}

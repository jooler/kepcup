import { createHash } from 'node:crypto';

/**
 * 台账行的稳定键（W2；借 Rakazo approval-effect-key 的 stableJsonValue +
 * sha256 + occurrence）。同一 run 里参数相同（键序无关）的同名工具调用，第 N
 * 次的 occurrence 为 N：重试同一动作得到新键，跨进程 / 续接重放可按键比对。
 */

/**
 * JSON with object keys sorted recursively (key order never changes the
 * text). `undefined` members are dropped like JSON.stringify; non-finite
 * numbers become null; functions / symbols are dropped.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? 'null';
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value === 'bigint') return value.toString();
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalize(item);
      return normalized === undefined ? null : normalized;
    });
  }
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') return normalize((toJson as () => unknown).call(value));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const normalized = normalize((value as Record<string, unknown>)[key]);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Length of the args-hash prefix inside an effect key. */
export const EFFECT_KEY_HASH_CHARS = 16;

/** `runId:tool:argsHash[:16]:occurrence` (occurrence counts from 1). */
export function effectKeyOf(input: {
  runId: string;
  toolName: string;
  argsHash: string;
  occurrence: number;
}): string {
  return `${input.runId}:${input.toolName}:${input.argsHash.slice(0, EFFECT_KEY_HASH_CHARS)}:${input.occurrence}`;
}

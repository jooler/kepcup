import {
  MICRO_APP_BRIDGE_APP_SOURCE,
  MICRO_APP_BRIDGE_MESSAGE_MAX_CHARS,
  microAppImplementedApiMethods,
} from '@kepcup/shared';

/**
 * 微应用能力桥 v2 的渲染端纯校验（D112，设计 55 §6.3）：帧带 `k` 判别（call /
 * stream / cancel / event-ack——微应用 → 宿主方向），来源标记 + 方法白名单 + 尺寸
 * 上限。无 DOM 依赖，可单测。来源防线（`event.source === iframe.contentWindow`）在
 * 宿主类里判，与 v1（widget-bridge-guard.ts）同构。
 */

/** 微应用 → 宿主的帧。 */
export type MicroAppBridgeFrame =
  | { k: 'call'; id: number; method: string; params: Record<string, unknown>; stream: boolean }
  | { k: 'stream'; id: number; streamId: string }
  | { k: 'cancel'; target: number | string }
  | { k: 'event-ack'; subId: string; seq: number };

export type MicroAppBridgeParseResult =
  | { ok: true; frame: MicroAppBridgeFrame }
  | { ok: false };

/** 当前运行时实现的方法白名单（spec 单一事实来源派生；与垫片 / 检查器共用）。 */
export function microAppBridgeMethods(): ReadonlySet<string> {
  return microAppImplementedApiMethods();
}

function intId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseMicroAppBridgeFrame(message: unknown): MicroAppBridgeParseResult {
  if (!plainObject(message)) return { ok: false };
  const record = message;
  if (record['source'] !== MICRO_APP_BRIDGE_APP_SOURCE) return { ok: false };
  const kind = record['k'];
  try {
    if (JSON.stringify(message).length > MICRO_APP_BRIDGE_MESSAGE_MAX_CHARS) return { ok: false };
  } catch {
    return { ok: false };
  }
  if (kind === 'call') {
    const id = intId(record['id']);
    const method = record['method'];
    const params = record['params'];
    if (id === null || typeof method !== 'string' || !microAppBridgeMethods().has(method)) return { ok: false };
    if (!plainObject(params)) return { ok: false };
    return { ok: true, frame: { k: 'call', id, method, params, stream: record['stream'] === true } };
  }
  if (kind === 'stream') {
    const id = intId(record['id']);
    const streamId = record['streamId'];
    if (id === null || typeof streamId !== 'string' || streamId.length === 0 || streamId.length > 64) {
      return { ok: false };
    }
    return { ok: true, frame: { k: 'stream', id, streamId } };
  }
  if (kind === 'cancel') {
    const target = record['target'];
    if (intId(target) !== null) return { ok: true, frame: { k: 'cancel', target: target as number } };
    if (typeof target === 'string' && target.length > 0 && target.length <= 64) {
      return { ok: true, frame: { k: 'cancel', target } };
    }
    return { ok: false };
  }
  if (kind === 'event-ack') {
    const subId = record['subId'];
    const seq = record['seq'];
    if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) return { ok: false };
    if (!intId(seq)) return { ok: false };
    return { ok: true, frame: { k: 'event-ack', subId, seq: seq as number } };
  }
  return { ok: false };
}

/** 尽力提取 call 帧的关联 id（拒收也回执错误，微应用侧 promise 不挂起）。 */
export function microAppBridgeMessageId(message: unknown): number | null {
  if (!plainObject(message)) return null;
  return intId(message['id']);
}

// --- 宿主 → 微应用的帧构造（ack / error / event / close）---------------------------

export interface MicroAppBridgeHostFrame {
  v: 2;
  source: 'kepcup-micro-host';
  k: 'ack' | 'error' | 'event' | 'close';
  [key: string]: unknown;
}

export function microAppAckFrame(id: number, result: unknown): MicroAppBridgeHostFrame {
  return { v: 2, source: 'kepcup-micro-host', k: 'ack', id, result };
}

export function microAppErrorFrame(
  id: number,
  code: string,
  message: string,
  hint?: string,
): MicroAppBridgeHostFrame {
  return {
    v: 2,
    source: 'kepcup-micro-host',
    k: 'error',
    id,
    code,
    message,
    ...(hint !== undefined ? { hint } : {}),
  };
}

export function microAppEventFrame(
  subId: string,
  name: string,
  data: unknown,
  seq: number,
): MicroAppBridgeHostFrame {
  return { v: 2, source: 'kepcup-micro-host', k: 'event', subId, name, data, seq };
}

export function microAppCloseFrame(reason: string): MicroAppBridgeHostFrame {
  return { v: 2, source: 'kepcup-micro-host', k: 'close', reason };
}

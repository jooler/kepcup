import { BOT_WIDGET_HEIGHT_MAX, BOT_WIDGET_HEIGHT_MIN } from '@kepcup/shared';

/**
 * Bot Widget 能力桥的渲染端纯校验（D81 P1，设计 32 §6）：iframe 里的组件是最低信任内容，
 * 宿主在把 postMessage 交给 WidgetBridgeHost（widget-bridge-host.ts）之前先过这里——
 * 来源标记、方法白名单、关联 id、体积上限、高度夹取。无 DOM 依赖，可单测。
 *
 * 来源防线只有一道：`event.source === iframe.contentWindow`（组件在 opaque origin 里，
 * `event.origin` 恒为 "null" 不能当凭据），在宿主类里判；这里做的是消息形状与白名单。
 */

/** 单条桥消息（JSON 序列化后）的字符上限（KV 单值 ≤256KB，留足转义与包装余量）。 */
export const WIDGET_BRIDGE_MESSAGE_MAX_CHARS = 1024 * 1024;

/** 允许组件发给宿主的方法（`setHeight` 是通知，宿主不回执）。 */
export const WIDGET_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.list',
  'openLink',
  'theme.get',
  'setHeight',
]);

export interface WidgetBridgeRequest {
  /** 关联 id（≥0；`setHeight` 固定发 0 且无回执）。 */
  id: number;
  method: string;
  payload: Record<string, unknown>;
}

export type WidgetBridgeParseResult =
  | { ok: true; request: WidgetBridgeRequest }
  | { ok: false };

/** 组件 → 宿主消息的形状与白名单检查。 */
export function parseWidgetBridgeMessage(message: unknown): WidgetBridgeParseResult {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false };
  }
  const record = message as Record<string, unknown>;
  if (record['source'] !== 'kepcup-widget') return { ok: false };
  const id = record['id'];
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return { ok: false };
  const method = record['type'];
  if (typeof method !== 'string' || !WIDGET_BRIDGE_METHODS.has(method)) return { ok: false };
  const payload = record['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false };
  }
  let size: number;
  try {
    size = JSON.stringify(message).length;
  } catch {
    return { ok: false };
  }
  if (size > WIDGET_BRIDGE_MESSAGE_MAX_CHARS) return { ok: false };
  return { ok: true, request: { id, method, payload: payload as Record<string, unknown> } };
}

/** 宿主 → 组件的回执（组件侧垫片按 `source: 'kepcup-host'` + 关联 id 配对）。 */
export interface WidgetBridgeReply {
  source: 'kepcup-host';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function widgetBridgeReply(id: number, reply: { value?: unknown } | { error: string }): WidgetBridgeReply {
  return 'error' in reply
    ? { source: 'kepcup-host', id, ok: false, error: reply.error }
    : { source: 'kepcup-host', id, ok: true, ...(reply.value !== undefined ? { value: reply.value } : {}) };
}

/** 把组件上报的高度夹到 [BOT_WIDGET_HEIGHT_MIN, BOT_WIDGET_HEIGHT_MAX]；非有限数 → null（忽略）。 */
export function clampWidgetHeight(height: unknown): number | null {
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  return Math.min(BOT_WIDGET_HEIGHT_MAX, Math.max(BOT_WIDGET_HEIGHT_MIN, Math.ceil(height)));
}

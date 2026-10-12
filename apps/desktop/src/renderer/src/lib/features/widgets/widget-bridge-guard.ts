import { BOT_WIDGET_HEIGHT_MAX, BOT_WIDGET_HEIGHT_MIN } from '@kepcup/shared';

/**
 * Bot Widget 能力桥的渲染端纯校验（D81 P1，设计 32 §6）：iframe 里的组件是最低信任内容，
 * 宿主在把 postMessage 交给 WidgetBridgeHost（widget-bridge-host.ts）之前先过这里——
 * 来源标记、方法白名单、关联 id、体积上限、高度夹取。无 DOM 依赖，可单测。
 *
 * 来源防线只有一道：`event.source === iframe.contentWindow`（组件在 opaque origin 里，
 * `event.origin` 恒为 "null" 不能当凭据），在宿主类里判；这里做的是消息形状与白名单。
 */

/**
 * 单条桥消息（JSON 序列化后）的字符上限（KV 单值 ≤256KB，留足转义与包装余量）。
 * 按 UTF-16 code units 计（JSON.stringify().length），非 ASCII 值的实际字节可到 ~2 倍。
 * 序列化抛错（如 BigInt 值过桥后无法 stringify）同样拒收——宿主会尽量按 id 回错误回执，
 * 组件侧的 promise 不会因此挂起。
 */
export const WIDGET_BRIDGE_MESSAGE_MAX_CHARS = 1024 * 1024;

/** 允许组件发给宿主的方法（`setHeight` 是通知，宿主不回执）。 */
export const WIDGET_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.list',
  'query',
  'openLink',
  'reply',
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
  const id = widgetBridgeMessageId(message);
  if (id === null) return { ok: false };
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

/** 尽力提取关联 id（非负整数）；宿主用它对被拒收的消息也回执一条错误（防组件侧挂起）。 */
export function widgetBridgeMessageId(message: unknown): number | null {
  if (message === null || typeof message !== 'object') return null;
  const id = (message as Record<string, unknown>)['id'];
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * 宿主 → 组件的回执（组件侧垫片按 `source: 'kepcup-host'` + 关联 id 配对）。
 * 拒绝时 `error` 是人话、`code` 是机器可读错误码（AppError.code，widget 程序化区分用）。
 */
export interface WidgetBridgeReply {
  source: 'kepcup-host';
  id: number;
  ok: boolean;
  value?: unknown;
  code?: string;
  error?: string;
}

export function widgetBridgeReply(
  id: number,
  reply: { value?: unknown; code?: string } | { error: string; code?: string },
): WidgetBridgeReply {
  return 'error' in reply
    ? {
        source: 'kepcup-host',
        id,
        ok: false,
        error: reply.error,
        ...(reply.code !== undefined ? { code: reply.code } : {}),
      }
    : {
        source: 'kepcup-host',
        id,
        ok: true,
        ...(reply.value !== undefined ? { value: reply.value } : {}),
        ...(reply.code !== undefined ? { code: reply.code } : {}),
      };
}

/** 把组件上报的高度夹到 [BOT_WIDGET_HEIGHT_MIN, BOT_WIDGET_HEIGHT_MAX]；非有限数 → null（忽略）。 */
export function clampWidgetHeight(height: unknown): number | null {
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  return Math.min(BOT_WIDGET_HEIGHT_MAX, Math.max(BOT_WIDGET_HEIGHT_MIN, Math.ceil(height)));
}

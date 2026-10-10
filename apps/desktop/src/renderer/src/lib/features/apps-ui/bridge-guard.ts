import { MCP_APP_HEIGHT_MAX, MCP_APP_HEIGHT_MIN } from '@kepcup/shared';

/**
 * MCP Apps 渲染端的纯校验函数（D73 P3 §7.5）：iframe 里的页面是不可信输入，宿主在把消息交给 AppBridge
 * 之前先过这里——方法白名单、体积上限、来源窗口、高度夹取、外链形状。无 DOM / Electron 依赖，可单测。
 */

/** 单条 postMessage 消息（JSON 序列化后）的字符上限。 */
export const APP_BRIDGE_MESSAGE_MAX_CHARS = 512 * 1024;

/**
 * 允许界面发给宿主的方法。其余（`resources/*`、`prompts/*`、`sampling/*`、`ui/download-file` …）宿主不实现，
 * 在这里直接回 `-32601` / 丢弃，不进 AppBridge。`ui/message`、`ui/update-model-context` 在名单内，
 * 由宿主以「P3 不支持」的错误回应（见 {@link UNSUPPORTED_UI_METHODS}）。
 */
export const APP_BRIDGE_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'ui/initialize',
  'ui/notifications/initialized',
  'ui/notifications/size-changed',
  'ui/notifications/request-teardown',
  'ui/open-link',
  'ui/message',
  'ui/update-model-context',
  'tools/call',
  'notifications/message',
  'ping',
]);

/** 允许进入但 P3 以错误回应的方法（不向模型上下文写任何东西）。 */
export const UNSUPPORTED_UI_METHODS: ReadonlySet<string> = new Set([
  'ui/message',
  'ui/update-model-context',
]);

export type GuardVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-object' | 'too-large' | 'not-jsonrpc' | 'method-not-allowed';
      id?: string | number;
    };

/** JSON-RPC 消息的形状与方法白名单检查（响应消息——带 result / error 而无 method——放行给 AppBridge 匹配请求 id）。 */
export function guardIncomingMessage(message: unknown): GuardVerdict {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, reason: 'not-object' };
  }
  const record = message as Record<string, unknown>;
  if (record['jsonrpc'] !== '2.0') return { ok: false, reason: 'not-jsonrpc' };
  let size: number;
  try {
    size = JSON.stringify(message).length;
  } catch {
    return { ok: false, reason: 'not-object' };
  }
  const id =
    typeof record['id'] === 'string' || typeof record['id'] === 'number' ? record['id'] : undefined;
  if (size > APP_BRIDGE_MESSAGE_MAX_CHARS) {
    return { ok: false, reason: 'too-large', ...(id !== undefined ? { id } : {}) };
  }
  const method = record['method'];
  if (method === undefined) {
    // A response to a host→app request (`result` / `error`).
    return 'result' in record || 'error' in record
      ? { ok: true }
      : { ok: false, reason: 'not-jsonrpc' };
  }
  if (typeof method !== 'string' || !APP_BRIDGE_ALLOWED_METHODS.has(method)) {
    return { ok: false, reason: 'method-not-allowed', ...(id !== undefined ? { id } : {}) };
  }
  return { ok: true };
}

/** 事件的来源窗口必须正是这个 iframe 的 `contentWindow`（opaque origin 的 `event.origin` 恒为 "null"，不能当凭据）。 */
export function isFromFrame(source: unknown, frameWindow: unknown): boolean {
  return source !== null && source !== undefined && frameWindow !== null && source === frameWindow;
}

/** 把界面报告的高度夹到 [100, 800] 像素；非有限数 → null（忽略）。 */
export function clampAppHeight(height: unknown): number | null {
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  return Math.min(MCP_APP_HEIGHT_MAX, Math.max(MCP_APP_HEIGHT_MIN, Math.ceil(height)));
}

/** 外链：只接受 https、无凭据、有主机名；返回规范化 URL，否则 null。 */
export function normalizeAppLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.toString();
}

/** 外链确认条里展示的形式：主机名突出，过长的路径截断。 */
export function describeAppLink(url: string): { host: string; display: string } {
  try {
    const parsed = new URL(url);
    const display = url.length > 120 ? `${url.slice(0, 117)}…` : url;
    return { host: parsed.hostname, display };
  } catch {
    return { host: '', display: url.slice(0, 120) };
  }
}

/**
 * Leading + trailing throttle for the app's `ui/notifications/size-changed` flood (an app that
 * resizes every frame must not make the host re-layout every frame). Timers are injectable for tests.
 */
export function createThrottle<T>(
  intervalMs: number,
  emit: (value: T) => void,
  clock: {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
  } = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) },
): (value: T) => void {
  let last = Number.NEGATIVE_INFINITY;
  let scheduled = false;
  let latest: T;
  return (value) => {
    latest = value;
    const wait = intervalMs - (clock.now() - last);
    if (wait <= 0) {
      last = clock.now();
      emit(value);
      return;
    }
    if (scheduled) return;
    scheduled = true;
    clock.setTimeout(() => {
      scheduled = false;
      last = clock.now();
      emit(latest);
    }, wait);
  };
}

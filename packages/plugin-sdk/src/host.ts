import type { PluginRuntimeLogPayload, PluginRuntimeProgressPayload } from '@kepcup/shared';

/**
 * 宿主 API 命名空间（D125 P1，docs/design/61-plugin-runtime-platform.md §4）：
 * `host.net / host.secrets / host.storage / host.log / host.progress / host.signal`。
 *
 * 实现由运行时注入（61 §4「运行时注入实现」）：`runPluginRuntime()` 连上协议通道后
 * 立即接线 progress / log / signal（三者就是 IPC 协议的 event 帧与 cancel 语义，P1
 * 可完整实现）；`net / secrets / storage` 的宿主侧能力桥在 P2 注入——届时桥实现经
 * `wireHostApi()` 补齐，本阶段调用它们抛 {@link HostApiNotConnectedError}。
 *
 * 插件代码只 import `host` 对象本身，不要 import 本文件的接线函数。
 */

export interface HostNetRequestInit {
  method?: string;
  headers?: Record<string, string>;
  /** JSON / 文本直接传字符串；二进制传 Uint8Array（宿主侧限单次 20MB，61 §4）。 */
  body?: string | Uint8Array;
  /**
   * 单次请求超时（毫秒）。**由插件按自己的厂商协议声明**（如同步出图可给 300000）；
   * 宿主只钳制上限（15 分钟）。不传 = 宿主上限兜底，不再有 60s 的隐含限制。
   * 整个调用的总时长另由清单 `runtime.timeouts`（方法级）或契约默认看门狗约束。
   */
  timeoutMs?: number;
}

export interface HostNetResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<Uint8Array>;
}

export interface HostNetApi {
  /** HTTP 客户端（fetch 语义）。域名白名单、SSRF 守卫与审计都在宿主侧强制（61 §4）。 */
  fetch(url: string, init?: HostNetRequestInit): Promise<HostNetResponse>;
}

export interface HostSecretsApi {
  /** 本插件实例键的只读读取（键必须匹配 `plugin:{pluginId}:instance:{instanceId}:*`）。 */
  get(key: string): Promise<string | null>;
}

export interface HostStorageApi {
  /** 插件 KV 读（值是 JSON 兼容数据；配额 10MB / 插件，敏感数据走 secrets）。 */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** 列出键名（可带前缀过滤；值不随列表返回）。 */
  list(prefix?: string): Promise<string[]>;
}

export interface HostLogApi {
  /** 结构化日志（core logger 加插件前缀，限速 100 条/调用，进诊断包）。 */
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface PluginHostApi {
  net: HostNetApi;
  secrets: HostSecretsApi;
  storage: HostStorageApi;
  log: HostLogApi;
  /** 进度上报（≤1 次/秒，SDK 客户端限速后透传进调用所属 run 的进度通道）。 */
  progress(payload: PluginRuntimeProgressPayload): void;
  /** 当前在途调用的取消信号；无在途调用时返回永不中止的信号。 */
  readonly signal: AbortSignal;
}

/** 在宿主运行时之外（或能力桥未注入时）调用 host 能力。 */
export class HostApiNotConnectedError extends Error {
  constructor(api: string, reason: string) {
    super(`host.${api} 不可用：${reason}`);
    this.name = 'HostApiNotConnectedError';
  }
}

/**
 * 运行时注入口（`runPluginRuntime` / P2 能力桥使用）。`progress / log / signal` 是
 * 协议自带的（event 帧 + cancel 帧），SDK 客户端连上即接线；`net / secrets / storage`
 * 由 P2 能力桥补齐，缺省时抛 {@link HostApiNotConnectedError}。
 */
export interface HostApiWiring {
  progress(payload: PluginRuntimeProgressPayload): void;
  log(level: PluginRuntimeLogPayload['level'], message: string, data?: unknown): void;
  signal(): AbortSignal;
  net?: HostNetApi;
  secrets?: HostSecretsApi;
  storage?: HostStorageApi;
}

let wiring: HostApiWiring | null = null;

/** 接线 / 断开（传 null）。运行时内部使用；插件代码不要调用。 */
export function wireHostApi(next: HostApiWiring | null): void {
  wiring = next;
}

function notConnected(api: string): never {
  throw new HostApiNotConnectedError(api, '尚未接入宿主能力桥（P2 注入）');
}

function neverAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

/** 宿主 API 命名空间（固定契约名）：插件代码 `import { host } from '@kepcup/plugin-sdk'`。 */
export const host: PluginHostApi = {
  net: {
    fetch: (url, init) => {
      if (wiring?.net === undefined) notConnected('net');
      return wiring.net.fetch(url, init);
    },
  },
  secrets: {
    get: (key) => {
      if (wiring?.secrets === undefined) notConnected('secrets');
      return wiring.secrets.get(key);
    },
  },
  storage: {
    get: (key) => {
      if (wiring?.storage === undefined) notConnected('storage');
      return wiring.storage.get(key);
    },
    set: (key, value) => {
      if (wiring?.storage === undefined) notConnected('storage');
      return wiring.storage.set(key, value);
    },
    delete: (key) => {
      if (wiring?.storage === undefined) notConnected('storage');
      return wiring.storage.delete(key);
    },
    list: (prefix) => {
      if (wiring?.storage === undefined) notConnected('storage');
      return wiring.storage.list(prefix);
    },
  },
  log: {
    info: (message, data) => wiring?.log('info', message, data),
    warn: (message, data) => wiring?.log('warn', message, data),
    error: (message, data) => wiring?.log('error', message, data),
  },
  progress: (payload) => wiring?.progress(payload),
  get signal(): AbortSignal {
    return wiring === null ? neverAbortSignal() : wiring.signal();
  },
};

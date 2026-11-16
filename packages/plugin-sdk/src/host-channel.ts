import {
  pluginHostApiRequestSchema,
  pluginHostApiResponseSchema,
  type PluginHostApiResponse,
} from '@kepcup/shared';
import type {
  HostNetApi,
  HostNetRequestInit,
  HostNetResponse,
  HostSecretsApi,
  HostStorageApi,
} from './host.js';

/**
 * 宿主 API 通道的插件侧客户端（D125 P2，61 §4）：把 `host.net / host.secrets /
 * host.storage` 的调用编码成 `host-api` 信封，经 fork 内置 IPC 发给宿主能力桥。
 *
 * 信封与调用协议的九帧互不干扰：`isChannelMessage()` 让 `nodeProcessTransport` 跳过
 * 这些消息；通道自己也处理宿主发来的 `ping`（看门狗心跳）并原样回 pong。只在进程入口
 * 模式（`runPluginRuntime(plugin)` 缺省挂 process IPC）自动接线——显式传入测试通道时
 * 由调用方自己决定 `wireHostApi`。
 *
 * 值解码：宿主把 JSON / 文本直接放在 `bodyText`，二进制转 base64；这里组装成
 * fetch 形态的 {@link HostNetResponse}（text / json / arrayBuffer）。
 */

/** 通道需要的最小 IPC 形状（与 client.ts 的 `PluginIpcLike` 结构兼容）。 */
export interface HostChannelIpc {
  send?(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (...args: unknown[]) => void): unknown;
}

export interface HostApiChannel {
  readonly net: HostNetApi;
  readonly secrets: HostSecretsApi;
  readonly storage: HostStorageApi;
  /** 是否是本通道的信封（transport 用它跳过，避免被判为非法帧）。 */
  isChannelMessage(message: unknown): boolean;
  dispose(): void;
}

/** `net.fetch` 的本地等待默认值：与宿主上限（15 分钟）一致，插件可用 `init.timeoutMs` 收窄。 */
const NET_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AtobLike {
  (data: string): string;
}
interface BtoaLike {
  (data: string): string;
}
interface BufferLike {
  from(
    data: string,
    encoding: string,
  ): {
    length: number;
    charCodeAt(index: number): number;
    toString(encoding: string): string;
  };
  from(data: Uint8Array): { toString(encoding: string): string };
}

/** base64 → 字节（Node 18+ 的全局 atob；无则退回 Buffer）。 */
function decodeBase64(text: string): Uint8Array {
  const atobFn = (globalThis as { atob?: AtobLike }).atob;
  if (typeof atobFn === 'function') {
    const binary = atobFn(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const buffer = (globalThis as unknown as { Buffer?: BufferLike }).Buffer;
  if (buffer !== undefined) {
    const decoded = buffer.from(text, 'base64');
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i) & 0xff;
    return bytes;
  }
  throw new Error('当前环境缺少 base64 解码能力');
}

/** 字节 → base64（分块避免超长字符串参数）。 */
function encodeBase64(bytes: Uint8Array): string {
  const atobLike = (globalThis as { btoa?: BtoaLike }).btoa;
  if (typeof atobLike === 'function') {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return atobLike(binary);
  }
  const buffer = (
    globalThis as unknown as {
      Buffer?: { from(data: Uint8Array): { toString(enc: string): string } };
    }
  ).Buffer;
  if (buffer !== undefined) return buffer.from(bytes).toString('base64');
  throw new Error('当前环境缺少 base64 编码能力');
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toNetResponse(raw: unknown): HostNetResponse {
  const value = (raw ?? {}) as {
    status?: unknown;
    ok?: unknown;
    headers?: Record<string, string>;
    bodyText?: string;
    bodyBase64?: string;
  };
  const bodyText = typeof value.bodyText === 'string' ? value.bodyText : '';
  return {
    status: typeof value.status === 'number' ? value.status : 0,
    ok: value.ok === true,
    headers: value.headers ?? {},
    async text() {
      if (value.bodyBase64 !== undefined && value.bodyText === undefined) {
        return decodeText(decodeBase64(value.bodyBase64));
      }
      return bodyText;
    },
    async json() {
      if (value.bodyBase64 !== undefined && value.bodyText === undefined) {
        return JSON.parse(decodeText(decodeBase64(value.bodyBase64))) as unknown;
      }
      return JSON.parse(bodyText) as unknown;
    },
    async arrayBuffer() {
      return value.bodyBase64 !== undefined
        ? decodeBase64(value.bodyBase64)
        : new TextEncoder().encode(bodyText);
    },
  };
}

/** 连接宿主 API 通道（`runPluginRuntime` 的进程入口模式自动调用）。 */
export function connectHostApiChannel(ipc: HostChannelIpc): HostApiChannel {
  const pending = new Map<string, PendingRequest>();
  let seq = 0;
  let disposed = false;

  const sendRaw = (message: unknown): void => {
    if (disposed) return;
    try {
      ipc.send?.(message);
    } catch {
      // 通道已死：宿主侧看门狗会发现进程无响应。
    }
  };

  const request = (payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
    if (disposed) return Promise.reject(new Error('宿主 API 通道已关闭'));
    const requestId = `har_${++seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`宿主 API 调用超时：${String(payload['api'])}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer });
      sendRaw({ type: 'host-api', requestId, ...payload });
    });
  };

  const settle = (message: PluginHostApiResponse): void => {
    const entry = pending.get(message.requestId);
    if (entry === undefined) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.value);
      return;
    }
    const error = new Error(message.message) as Error & { code?: string };
    error.code = message.code;
    entry.reject(error);
  };

  const listener = (message: unknown): void => {
    // 宿主 → 插件的 ping（看门狗）：立即回 pong，证明事件循环还活着。pong 顺带带上
    // 自身 RSS（61 §3.3「RSS > 512MB 记 warn」观测项）：宿主用这条轻量自报代替
    // pidusage 依赖；只用于日志，不参与任何治理判定。
    const request = pluginHostApiRequestSchema.safeParse(message);
    if (request.success) {
      if (request.data.api === 'ping') {
        const memoryUsage = (globalThis as { process?: { memoryUsage?: () => { rss?: number } } })
          .process?.memoryUsage;
        let rssBytes: number | undefined;
        try {
          rssBytes = memoryUsage?.().rss;
        } catch {
          rssBytes = undefined;
        }
        sendRaw({
          type: 'host-api-response',
          requestId: request.data.requestId,
          ok: true,
          value: { pong: true, ...(rssBytes !== undefined ? { rssBytes } : {}) },
        });
      }
      return;
    }
    const response = pluginHostApiResponseSchema.safeParse(message);
    if (response.success) settle(response.data);
  };
  ipc.on('message', listener);

  const net: HostNetApi = {
    async fetch(url: string, init?: HostNetRequestInit): Promise<HostNetResponse> {
      const bodyBase64 =
        init?.body !== undefined && typeof init.body !== 'string'
          ? encodeBase64(init.body)
          : undefined;
      const netTimeoutMs = init?.timeoutMs ?? NET_TIMEOUT_MS;
      const raw = await request(
        {
          api: 'net.fetch',
          url,
          ...(init !== undefined
            ? {
                init: {
                  ...(init.method !== undefined ? { method: init.method } : {}),
                  ...(init.headers !== undefined ? { headers: init.headers } : {}),
                  ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
                  ...(typeof init.body === 'string'
                    ? { body: init.body }
                    : bodyBase64 !== undefined
                      ? { bodyBase64 }
                      : {}),
                },
              }
            : {}),
        },
        // 本地等待比宿主侧超时多 5s：让宿主的超时错误先回来（插件得到「请求超时」
        // 而不是「宿主无响应」，两者的人话与重试语义不同）。
        netTimeoutMs + 5_000,
      );
      return toNetResponse(raw);
    },
  };

  const secrets: HostSecretsApi = {
    async get(key: string): Promise<string | null> {
      const raw = (await request({ api: 'secrets.get', key }, DEFAULT_TIMEOUT_MS)) as {
        value?: string | null;
      };
      return raw.value ?? null;
    },
  };

  const storage: HostStorageApi = {
    async get(key: string): Promise<unknown> {
      const raw = (await request({ api: 'storage.get', key }, DEFAULT_TIMEOUT_MS)) as {
        value?: unknown;
      };
      return raw.value ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      await request({ api: 'storage.set', key, value }, DEFAULT_TIMEOUT_MS);
    },
    async delete(key: string): Promise<void> {
      await request({ api: 'storage.delete', key }, DEFAULT_TIMEOUT_MS);
    },
    async list(prefix?: string): Promise<string[]> {
      const raw = (await request(
        { api: 'storage.list', ...(prefix !== undefined ? { prefix } : {}) },
        DEFAULT_TIMEOUT_MS,
      )) as { keys?: string[] };
      return raw.keys ?? [];
    },
  };

  return {
    net,
    secrets,
    storage,
    isChannelMessage(message: unknown): boolean {
      return (
        pluginHostApiResponseSchema.safeParse(message).success ||
        (pluginHostApiRequestSchema.safeParse(message).success &&
          (message as { type?: unknown }).type === 'host-api')
      );
    },
    dispose(): void {
      disposed = true;
      ipc.off('message', listener);
      for (const [requestId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('宿主 API 通道已关闭'));
        pending.delete(requestId);
      }
    },
  };
}

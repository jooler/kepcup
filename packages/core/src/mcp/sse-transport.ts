import {
  McpConnectionClosedError,
  McpHttpError,
  type JsonRpcMessage,
  parseJsonRpcMessage,
} from '@earendil-works/pi-mcp';
import type { McpTransport } from '@earendil-works/pi-mcp';

/**
 * 旧版「HTTP with SSE」客户端传输（MCP 2024-11-05 协议，pi-mcp 未内置）：
 * GET 端点开 SSE 长连接，首个 `endpoint` 事件给出 POST 地址；之后所有请求
 * POST 到该地址（服务端回 202），响应经 SSE `message` 事件异步送达。
 * 流断开即 emitClose，由上层按「连接已关」走既有重连生命周期。
 */

export interface SseTransportOptions {
  url: string;
  headers?: Record<string, string> | undefined;
  /** 测试注入用；缺省用全局 fetch。 */
  fetch?: typeof globalThis.fetch | undefined;
}

interface SseEvent {
  event?: string;
  data: string;
}

const ENDPOINT_WAIT_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_BYTES = 8 * 1024;

export class SseTransport implements McpTransport {
  readonly #options: SseTransportOptions;
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #controller = new AbortController();
  readonly #messageListeners = new Set<(message: JsonRpcMessage) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #closeListeners = new Set<() => void>();
  #started = false;
  #closed = false;
  /** 握手后拿到的 POST 地址（绝对 URL）。 */
  #endpoint: URL | null = null;
  #resolveEndpoint: ((endpoint: URL) => void) | null = null;
  #rejectEndpoint: ((error: Error) => void) | null = null;

  constructor(options: SseTransportOptions) {
    this.#options = { ...options, headers: options.headers ? { ...options.headers } : undefined };
    this.#url = new URL(options.url);
    // 不带 receiver 调用（对齐 pi-mcp：Workers 等平台 fetch 对 this 敏感）。
    const fetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetch(input, init);
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('MCP SSE transport already started');
    if (this.#closed) throw new McpConnectionClosedError();
    this.#started = true;
    const response = await this.#fetch(this.#url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', ...this.#options.headers },
      signal: this.#controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_BYTES);
      await discard(response);
      throw new McpHttpError(
        response.status,
        `MCP SSE request failed with status ${response.status}${body.trim() ? `: ${body.trim()}` : ''}`,
        body,
      );
    }
    const type = contentType(response);
    if (type !== 'text/event-stream' || !response.body) {
      await discard(response);
      throw new Error(`MCP SSE 端点响应类型不支持：${type ?? '缺失'}`);
    }
    void this.#consume(response.body);
    // endpoint 事件是旧协议握手第一步；没有它无从 POST 请求。
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#rejectEndpoint = null;
        reject(new Error('MCP SSE 握手超时：未收到 endpoint 事件'));
      }, ENDPOINT_WAIT_TIMEOUT_MS);
      timer.unref?.();
      this.#resolveEndpoint = () => {
        clearTimeout(timer);
        this.#resolveEndpoint = null;
        this.#rejectEndpoint = null;
        resolve();
      };
      this.#rejectEndpoint = (error) => {
        clearTimeout(timer);
        this.#resolveEndpoint = null;
        this.#rejectEndpoint = null;
        reject(error);
      };
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.#started || this.#closed || this.#endpoint === null) {
      throw new McpConnectionClosedError();
    }
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#options.headers },
      body: JSON.stringify(message),
      signal: this.#controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_BYTES);
      await discard(response);
      throw new McpHttpError(
        response.status,
        `MCP SSE request failed with status ${response.status}${body.trim() ? `: ${body.trim()}` : ''}`,
        body,
      );
    }
    await discard(response);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    this.#rejectEndpoint?.(new McpConnectionClosedError());
    this.#emitClose();
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** 消费 SSE 长连接：endpoint 事件完成握手，message 事件投递 JSON-RPC。 */
  async #consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let eventName: string | undefined;
    let dataLines: string[] = [];
    const dispatch = () => {
      if (dataLines.length > 0) {
        this.#onEvent({ ...(eventName !== undefined ? { event: eventName } : {}), data: dataLines.join('\n') });
      }
      eventName = undefined;
      dataLines = [];
    };
    const processLine = (rawLine: string) => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        dispatch();
        return;
      }
      if (line.startsWith(':')) return;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventName = value;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          processLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
        }
      }
      buffered += decoder.decode();
      if (buffered !== '') processLine(buffered);
      dispatch();
    } catch (error) {
      if (!this.#closed) this.#emitError(toError(error));
    } finally {
      reader.releaseLock();
      // 服务端断流：按「连接已关」上报，上层下次调用自动重连。
      if (!this.#closed) {
        this.#closed = true;
        this.#rejectEndpoint?.(new Error('MCP SSE 连接在握手完成前被服务端关闭'));
        this.#emitClose();
      }
    }
  }

  #onEvent(event: SseEvent): void {
    if (event.event === 'endpoint') {
      const endpoint = new URL(event.data.trim(), this.#url);
      this.#endpoint = endpoint;
      this.#resolveEndpoint?.(endpoint);
      return;
    }
    // 无 event 名或缺省视为 message；其他事件类型不是 JSON-RPC。
    if (!event.data.trim() || (event.event !== undefined && event.event !== 'message')) return;
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(JSON.parse(event.data));
    } catch (error) {
      this.#emitError(toError(error));
      return;
    }
    this.#emitMessage(message);
  }

  #emitMessage(message: JsonRpcMessage): void {
    for (const listener of [...this.#messageListeners]) listener(message);
  }

  #emitError(error: Error): void {
    for (const listener of [...this.#errorListeners]) listener(error);
  }

  #emitClose(): void {
    for (const listener of [...this.#closeListeners]) listener();
  }
}

function contentType(response: Response): string | undefined {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
}

function discard(response: Response): Promise<void> {
  return response.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

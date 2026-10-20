import {
  inkcopAgentsApiAvailable,
  inkcopBaseUrl,
  readInkcopEndpoint,
  type InkcopEndpoint,
  type ReadEndpointResult,
} from './endpoint.js';
import { readSseStream } from './sse.js';

/**
 * InkCop 同机桥 HTTP 客户端（契约 v0.2）：health / agents / connections / messages SSE。
 * 仅连 `127.0.0.1`；鉴权用 endpoint.token Bearer。
 */

export const INKCOP_OFFLINE_TIP_ZH = '请先启动 InkCop 并打开本机连接';
export const INKCOP_OFFLINE_TIP_EN =
  'Please start InkCop and enable the local connection first';

export type InkcopFetch = typeof globalThis.fetch;

export interface InkcopClientOptions {
  fetch?: InkcopFetch;
  /** 覆盖 endpoint 文件路径（测试用）。 */
  endpointPath?: string;
  /** 直接注入已解析 endpoint（跳过读文件；测试用）。 */
  endpoint?: InkcopEndpoint;
}

export interface InkcopHealthOk {
  ok: true;
  version: number;
  app: string;
  connections: Array<{ id: string; name: string; agentKey: string; status: string }>;
}

export interface InkcopConnectionOk {
  ok: true;
  connectionId: string;
  agentKey: string;
  conversationId: number;
}

/** `GET /v1/agents` 单项（契约 v0.2；main_agent 居首，其余同 Connect 可见过滤）。 */
export interface InkcopAgentInfo {
  key: string;
  name: string;
  kind: 'main' | 'app';
}

export interface InkcopAgentsOk {
  ok: true;
  agents: InkcopAgentInfo[];
}

export interface InkcopStreamHandlers {
  onAccepted?: (data: { turnId: string; connectionId: string }) => void | Promise<void>;
  onChunk?: (data: { turnId: string; text: string }) => void | Promise<void>;
  onComplete?: (data: {
    turnId: string;
    text: string;
    stopReason?: string;
  }) => void | Promise<void>;
  onError?: (data: { turnId?: string; error: string; message?: string }) => void | Promise<void>;
}

export class InkcopOfflineError extends Error {
  readonly code = 'inkcop_offline' as const;
  constructor(message: string = INKCOP_OFFLINE_TIP_ZH) {
    super(message);
    this.name = 'InkcopOfflineError';
  }
}

export class InkcopHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `InkCop bridge HTTP ${status}`);
    this.name = 'InkcopHttpError';
    this.status = status;
    this.body = body;
  }
}

function authHeaders(token: string, withJson = false): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (withJson) headers['Content-Type'] = 'application/json';
  return headers;
}

export class InkcopLocalBridgeClient {
  readonly #fetch: InkcopFetch;
  readonly #endpointPath: string | undefined;
  readonly #fixedEndpoint: InkcopEndpoint | undefined;

  constructor(options: InkcopClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#endpointPath = options.endpointPath;
    this.#fixedEndpoint = options.endpoint;
  }

  resolveEndpoint(): ReadEndpointResult {
    if (this.#fixedEndpoint !== undefined) {
      return { ok: true, endpoint: this.#fixedEndpoint, path: '(injected)' };
    }
    return readInkcopEndpoint(this.#endpointPath);
  }

  /**
   * 读 endpoint → GET /v1/health。任何失败视为离线（契约 §5.4）。
   */
  async health(signal?: AbortSignal): Promise<InkcopHealthOk> {
    const resolved = this.resolveEndpoint();
    if (!resolved.ok) throw new InkcopOfflineError();
    const { endpoint } = resolved;
    const url = `${inkcopBaseUrl(endpoint)}/v1/health`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: authHeaders(endpoint.token),
        signal,
      });
    } catch {
      throw new InkcopOfflineError();
    }
    if (response.status === 401 || response.status === 503) {
      throw new InkcopOfflineError();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new InkcopHttpError(response.status, body);
    }
    const json = (await response.json()) as InkcopHealthOk;
    if (json.ok !== true) throw new InkcopOfflineError();
    return json;
  }


  /**
   * GET /v1/agents（契约 v0.2 / InkCop endpoint.version >= 2）。
   * 形状：`{ ok, agents: [{ key, name, kind: 'main'|'app' }] }`（main_agent 居首）。
   * version < 2 → InkcopHttpError(501)；离线同 health。
   */
  async listAgents(signal?: AbortSignal): Promise<InkcopAgentsOk> {
    const resolved = this.resolveEndpoint();
    if (!resolved.ok) throw new InkcopOfflineError();
    const { endpoint } = resolved;
    if (!inkcopAgentsApiAvailable(endpoint)) {
      throw new InkcopHttpError(
        501,
        '',
        `InkCop agents API requires endpoint.version >= 2 (got ${endpoint.version})`,
      );
    }
    const url = `${inkcopBaseUrl(endpoint)}/v1/agents`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: authHeaders(endpoint.token),
        signal,
      });
    } catch {
      throw new InkcopOfflineError();
    }
    if (response.status === 401 || response.status === 503) {
      throw new InkcopOfflineError();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new InkcopHttpError(response.status, body);
    }
    const json = (await response.json()) as { ok?: boolean; agents?: unknown };
    if (json.ok !== true || !Array.isArray(json.agents)) {
      throw new InkcopHttpError(response.status, JSON.stringify(json), 'InkCop /v1/agents malformed');
    }
    const agents: InkcopAgentInfo[] = [];
    for (const item of json.agents) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (key.length === 0) continue;
      const name = typeof row.name === 'string' && row.name.trim().length > 0 ? row.name.trim() : key;
      const kind: 'main' | 'app' = row.kind === 'app' ? 'app' : 'main';
      agents.push({ key, name, kind });
    }
    return { ok: true, agents };
  }

  /** POST /v1/connections（幂等；同一 externalId 复用 connectionId）。 */
  async ensureConnection(
    input: { externalId: string; name: string; agentKey?: string },
    signal?: AbortSignal,
  ): Promise<InkcopConnectionOk> {
    const resolved = this.resolveEndpoint();
    if (!resolved.ok) throw new InkcopOfflineError();
    const { endpoint } = resolved;
    const url = `${inkcopBaseUrl(endpoint)}/v1/connections`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: authHeaders(endpoint.token, true),
        body: JSON.stringify({
          externalId: input.externalId,
          name: input.name,
          agentKey: input.agentKey ?? 'main_agent',
        }),
        signal,
      });
    } catch {
      throw new InkcopOfflineError();
    }
    if (response.status === 401 || response.status === 503) {
      throw new InkcopOfflineError();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new InkcopHttpError(response.status, body);
    }
    return (await response.json()) as InkcopConnectionOk;
  }

  /**
   * POST /v1/messages（SSE）。handlers 按 event 回调；流以 complete / error 结束。
   */
  async sendMessage(
    input: {
      connectionId: string;
      messageId: string;
      text: string;
      stream?: boolean;
    },
    handlers: InkcopStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const resolved = this.resolveEndpoint();
    if (!resolved.ok) throw new InkcopOfflineError();
    const { endpoint } = resolved;
    const url = `${inkcopBaseUrl(endpoint)}/v1/messages`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          ...authHeaders(endpoint.token, true),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          connectionId: input.connectionId,
          messageId: input.messageId,
          text: input.text,
          stream: input.stream ?? true,
        }),
        signal,
      });
    } catch {
      throw new InkcopOfflineError();
    }
    if (response.status === 401 || response.status === 503) {
      throw new InkcopOfflineError();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new InkcopHttpError(response.status, body);
    }
    if (!response.body) {
      throw new InkcopHttpError(response.status, '', 'InkCop bridge returned empty body');
    }
    let sawTerminal = false;
    await readSseStream(
      response.body,
      async (frame) => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(frame.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (frame.event === 'accepted') {
          await handlers.onAccepted?.({
            turnId: String(data.turnId ?? ''),
            connectionId: String(data.connectionId ?? ''),
          });
          return;
        }
        if (frame.event === 'chunk') {
          await handlers.onChunk?.({
            turnId: String(data.turnId ?? ''),
            text: String(data.text ?? ''),
          });
          return;
        }
        if (frame.event === 'complete') {
          sawTerminal = true;
          await handlers.onComplete?.({
            turnId: String(data.turnId ?? ''),
            text: String(data.text ?? ''),
            ...(typeof data.stopReason === 'string' ? { stopReason: data.stopReason } : {}),
          });
          return;
        }
        if (frame.event === 'error') {
          sawTerminal = true;
          await handlers.onError?.({
            ...(typeof data.turnId === 'string' ? { turnId: data.turnId } : {}),
            error: String(data.error ?? 'error'),
            ...(typeof data.message === 'string' ? { message: data.message } : {}),
          });
        }
      },
      signal,
    );
    if (!sawTerminal) {
      await handlers.onError?.({ error: 'stream_ended', message: 'SSE ended without complete/error' });
    }
  }
}

/** 界面语言为 en 时用英文离线提示，其余中文（与 core 其它 Bot 提示一致）。 */
export function inkcopOfflineTip(language: string | undefined | null): string {
  return language === 'en' ? INKCOP_OFFLINE_TIP_EN : INKCOP_OFFLINE_TIP_ZH;
}

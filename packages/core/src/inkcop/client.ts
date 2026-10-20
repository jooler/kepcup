import {
  inkcopAgentsApiAvailable,
  readInkcopEndpoint,
  resolveInkcopTarget,
  type InkcopAuthOverrides,
  type InkcopEndpoint,
  type ReadEndpointResult,
  type ResolvedInkcopTarget,
} from './endpoint.js';
import { readSseStream } from './sse.js';

/**
 * InkCop Agent Bridge HTTP 客户端（契约 v0.3）：
 * health / agents / connections / messages SSE；Bearer apiKey；可选手动 baseUrl。
 */

export const INKCOP_OFFLINE_TIP_ZH = '请先启动 InkCop 并打开本机连接';
export const INKCOP_OFFLINE_TIP_EN =
  'Please start InkCop and enable the local connection first';

export const INKCOP_AUTH_TIP_ZH = 'InkCop 密钥无效或未配置，请在扩展中心填写 API 密钥';
export const INKCOP_AUTH_TIP_EN =
  'InkCop API key is missing or invalid. Set it in Extension Center.';

export type InkcopFetch = typeof globalThis.fetch;

export interface InkcopClientOptions extends InkcopAuthOverrides {
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

/** `GET /v1/agents` 单项（契约 v0.2+；main_agent 居首；v0.4+ 含 description）。 */
export interface InkcopAgentInfo {
  key: string;
  name: string;
  kind: 'main' | 'app';
  /** 能力说明；主智能体 = 主对话角色定义。缺省（旧桥）时工具描述回落 name/kind。 */
  description?: string;
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

export class InkcopAuthError extends Error {
  readonly code = 'inkcop_auth' as const;
  constructor(message: string = INKCOP_AUTH_TIP_ZH) {
    super(message);
    this.name = 'InkcopAuthError';
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
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string | undefined;

  constructor(options: InkcopClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#endpointPath = options.endpointPath;
    this.#fixedEndpoint = options.endpoint;
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
  }

  /** 读 endpoint 文件（不含设置覆盖）；供 UI 探测预填。 */
  resolveEndpoint(): ReadEndpointResult {
    if (this.#fixedEndpoint !== undefined) {
      return { ok: true, endpoint: this.#fixedEndpoint, path: '(injected)' };
    }
    return readInkcopEndpoint(this.#endpointPath);
  }

  /**
   * 解析最终 baseUrl + apiKey（设置优先，否则 endpoint）。
   * 无地址 → Offline；无密钥 → Auth。
   */
  resolveTarget(): ResolvedInkcopTarget {
    const resolved = resolveInkcopTarget(
      { apiKey: this.#apiKey, baseUrl: this.#baseUrl },
      {
        endpointPath: this.#endpointPath,
        ...(this.#fixedEndpoint !== undefined ? { endpoint: this.#fixedEndpoint } : {}),
      },
    );
    if (!resolved.ok) {
      if (resolved.reason === 'no_api_key') throw new InkcopAuthError();
      throw new InkcopOfflineError();
    }
    return resolved.target;
  }

  #throwForStatus(status: number, body: string): never {
    if (status === 401) throw new InkcopAuthError();
    if (status === 503) throw new InkcopOfflineError();
    throw new InkcopHttpError(status, body);
  }

  /**
   * 读 endpoint/设置 → GET /v1/health。网络失败视为离线；401 视为鉴权失败。
   */
  async health(signal?: AbortSignal): Promise<InkcopHealthOk> {
    const target = this.resolveTarget();
    const url = `${target.baseUrl}/v1/health`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: authHeaders(target.apiKey),
        signal,
      });
    } catch {
      throw new InkcopOfflineError();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.#throwForStatus(response.status, body);
    }
    const json = (await response.json()) as InkcopHealthOk;
    if (json.ok !== true) throw new InkcopOfflineError();
    return json;
  }

  /**
   * GET /v1/agents（契约 v0.2+ / endpoint.version >= 2）。
   * 无 endpoint、仅手动 baseUrl 时直接尝试；501/404 由调用方降级。
   */
  async listAgents(signal?: AbortSignal): Promise<InkcopAgentsOk> {
    const target = this.resolveTarget();
    if (target.endpoint !== null && !inkcopAgentsApiAvailable(target.endpoint)) {
      throw new InkcopHttpError(
        501,
        '',
        `InkCop agents API requires endpoint.version >= 2 (got ${target.endpoint.version})`,
      );
    }
    const url = `${target.baseUrl}/v1/agents`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: authHeaders(target.apiKey),
        signal,
      });
    } catch {
      throw new InkcopOfflineError();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.#throwForStatus(response.status, body);
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
      const description =
        typeof row.description === 'string' && row.description.trim().length > 0
          ? row.description.trim()
          : undefined;
      agents.push({
        key,
        name,
        kind,
        ...(description !== undefined ? { description } : {}),
      });
    }
    return { ok: true, agents };
  }

  /** POST /v1/connections（幂等；同一 externalId 复用 connectionId）。 */
  async ensureConnection(
    input: { externalId: string; name: string; agentKey?: string },
    signal?: AbortSignal,
  ): Promise<InkcopConnectionOk> {
    const target = this.resolveTarget();
    const url = `${target.baseUrl}/v1/connections`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: authHeaders(target.apiKey, true),
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
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.#throwForStatus(response.status, body);
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
    const target = this.resolveTarget();
    const url = `${target.baseUrl}/v1/messages`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          ...authHeaders(target.apiKey, true),
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
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.#throwForStatus(response.status, body);
    }
    if (!response.body) {
      throw new InkcopHttpError(response.status, '', 'InkCop bridge returned empty body');
    }
    let sawTerminal = false;
    await readSseStream(
      response.body,
      async (frame) => {
        let data: Record<string, unknown>;
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

/** 界面语言为 en 时用英文离线提示，其余中文。 */
export function inkcopOfflineTip(language: string | undefined | null): string {
  return language === 'en' ? INKCOP_OFFLINE_TIP_EN : INKCOP_OFFLINE_TIP_ZH;
}

/** 鉴权失败提示。 */
export function inkcopAuthTip(language: string | undefined | null): string {
  return language === 'en' ? INKCOP_AUTH_TIP_EN : INKCOP_AUTH_TIP_ZH;
}

/** 从 settings.inkcopLocalCollab 构造客户端。 */
export function inkcopClientFromSettings(
  settings: { inkcopLocalCollab?: { apiKey?: string; baseUrl?: string } } | null | undefined,
  options: Omit<InkcopClientOptions, 'apiKey' | 'baseUrl'> = {},
): InkcopLocalBridgeClient {
  const collab = settings?.inkcopLocalCollab;
  return new InkcopLocalBridgeClient({
    ...options,
    apiKey: collab?.apiKey,
    baseUrl: collab?.baseUrl,
  });
}

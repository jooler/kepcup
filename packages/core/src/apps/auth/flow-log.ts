import type { AppConnectFlowPayload, AppFlowLogEntry } from '@kepcup/shared';

/**
 * 授权流程事件日志（开发者模式，D73 P2 §6.6）：自定义 server 的 `apps.connect_flow` 事件的
 * 脱敏副本，进程内环形缓冲、不落盘。永不含令牌 / code / state / PKCE：授权地址只保留
 * `scheme://host/path`，错误文案过一遍 {@link scrubLogText}。
 */

export const FLOW_LOG_MAX_PER_SERVER = 100;
/** 同时跟踪的 server 数上限（LRU：最久没有新事件的 server 先被丢弃）。 */
export const FLOW_LOG_MAX_SERVERS = 50;

// `key=value` / `key: value` / `"key":"value"` forms of secret-bearing fields.
const SECRET_KEYS =
  'code|state|access_token|refresh_token|id_token|client_secret|code_verifier|code_challenge|assertion|password|secret|token|authorization|api_key|apikey';
const SECRET_FIELD = new RegExp(
  `(["']?\\b(?:${SECRET_KEYS})["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^&\\s,;"'}\\]]+)`,
  'gi',
);
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// Long opaque runs of base64url / base64 / hex (letters-only included). '.' and ':' are not in the
// class, so hostnames and URL authorities survive; a 32+ character path segment does not.
const OPAQUE_RUN = /[A-Za-z0-9_\-+/=]{32,}/g;

/**
 * 日志文本脱敏：已知形态（`key=value`、JSON / 冒号形态、`Bearer …`、JWT）+ 长不透明串兜底。
 * 调用方还应再过一遍 `SecretsService.redact`（已存机密的精确匹配）。
 */
export function scrubLogText(text: string): string {
  // Order matters: scheme / JWT first so `authorization: Bearer x` is not half-eaten by the field rule.
  return text
    .replace(AUTH_SCHEME, '$1 «redacted»')
    .replace(JWT, '«redacted»')
    .replace(SECRET_FIELD, '$1«redacted»')
    .replace(OPAQUE_RUN, '«redacted»');
}

/** `scheme://host/path`；解析失败 → undefined（宁可不显示）。 */
export function stripUrlQuery(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function redactFlowPayload(
  payload: AppConnectFlowPayload,
  at: number,
  redact: (text: string) => string = (text) => text,
): AppFlowLogEntry {
  const url =
    payload.authorizationUrl !== undefined ? stripUrlQuery(payload.authorizationUrl) : undefined;
  return {
    at,
    flowId: payload.flowId,
    phase: payload.phase,
    ...(payload.authorizationHost !== undefined
      ? { authorizationHost: payload.authorizationHost }
      : {}),
    ...(url !== undefined ? { authorizationUrl: url } : {}),
    ...(payload.error !== undefined
      ? {
          errorCode: payload.error.code,
          errorMessage: redact(scrubLogText(payload.error.message)),
          ...(payload.error.issuer !== undefined ? { issuer: payload.error.issuer } : {}),
        }
      : {}),
  };
}

export class FlowEventLog {
  readonly #max: number;
  readonly #maxServers: number;
  /** Insertion order = recency (a record re-inserts its server at the end). */
  readonly #byServer = new Map<string, AppFlowLogEntry[]>();

  constructor(max = FLOW_LOG_MAX_PER_SERVER, maxServers = FLOW_LOG_MAX_SERVERS) {
    this.#max = max;
    this.#maxServers = maxServers;
  }

  record(serverId: string, entry: AppFlowLogEntry): void {
    const list = this.#byServer.get(serverId) ?? [];
    this.#byServer.delete(serverId);
    list.push(entry);
    if (list.length > this.#max) list.splice(0, list.length - this.#max);
    this.#byServer.set(serverId, list);
    while (this.#byServer.size > this.#maxServers) {
      const oldest = this.#byServer.keys().next().value as string;
      this.#byServer.delete(oldest);
    }
  }

  entries(serverId: string): AppFlowLogEntry[] {
    return [...(this.#byServer.get(serverId) ?? [])];
  }

  clear(serverId: string): void {
    this.#byServer.delete(serverId);
  }

  /** Number of servers currently tracked (tests). */
  get size(): number {
    return this.#byServer.size;
  }
}

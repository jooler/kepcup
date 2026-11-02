import { randomBytes } from 'node:crypto';

import type { CoreLogger } from '../infra/logger.js';

/**
 * iLink Bot API 客户端（D108，54 号文档 §4）——个人微信通道的 transport 隔离点。
 *
 * 协议事实（已核实 2026-11-03，Tencent/openclaw-weixin docs/protocol.md +
 * zhuweiyou/weixinbot）：HTTPS + JSON，`Authorization: Bearer <bot_token>`，
 * `base_info: {channel_version}` 随认证请求携带；登录 `get_bot_qrcode` /
 * `get_qrcode_status`，收 `getupdates` 长轮询（约 35s），发 `sendmessage`。
 * `ret`/`errcode = -14` 是会话失效（一小时暂停 + 重扫）。接口可能演进——
 * 协议变动只改这个文件，不外溢到 session / service（54 §8 风险表）。
 *
 * 仅 core 取用 token 的瞬间经手凭据；日志与错误一律脱敏（不含 token / msgId 全文）。
 */

export const ILINK_DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com';
/** getUpdates 长轮询客户端超时：略大于服务器建议值（响应里 longpolling_timeout_ms）。 */
export const ILINK_POLL_TIMEOUT_MS = 40_000;
/** 普通请求超时。 */
export const ILINK_REQUEST_TIMEOUT_MS = 15_000;
/** 扫码状态轮询超时：get_qrcode_status 是长轮询（服务器挂住到状态变化或 ~30s），
 * 挂住到点空手返回按 wait 处理，调用方继续轮询。 */
const QR_POLL_RESULT_TIMEOUT_MS = 50_000;

/** iLink 原始消息（仅取宿主用到的字段；完整面见 openclaw-weixin src/api/types.ts）。 */
export interface ILinkMessage {
  seq?: number | undefined;
  message_id?: number | string | undefined;
  from_user_id?: string | undefined;
  to_user_id?: string | undefined;
  client_id?: string | undefined;
  session_id?: string | undefined;
  group_id?: string | undefined;
  /** 1 = 用户，2 = Bot。 */
  message_type?: number | undefined;
  /** 0 新消息 / 1 生成中 / 2 完成。 */
  message_state?: number | undefined;
  item_list?:
    | Array<{
        type: number;
        text_item?: { text?: string | undefined } | undefined;
      }>
    | undefined;
  context_token?: string | undefined;
}

export interface ILinkQrcodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type ILinkQrcodePollStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'scaned_but_redirect'
  | 'binded_redirect';

export interface ILinkQrcodeStatusResponse {
  status: ILinkQrcodePollStatus;
  bot_token?: string | undefined;
  ilink_bot_id?: string | undefined;
  baseurl?: string | undefined;
  ilink_user_id?: string | undefined;
  redirect_host?: string | undefined;
}

export interface ILinkUpdatesResponse {
  ret?: number | undefined;
  errcode?: number | undefined;
  errmsg?: string | undefined;
  msgs?: ILinkMessage[] | undefined;
  get_updates_buf?: string | undefined;
  longpolling_timeout_ms?: number | undefined;
}

export interface ILinkSendResult {
  ok: boolean;
  /** 业务错误码（-14 会话失效等）；HTTP 层错误折算成 -1。 */
  code: number;
  errmsg: string;
}

export interface ILinkClientOptions {
  apiBase: string;
  logger: CoreLogger;
  /** 测试注入。 */
  fetchImpl?: typeof fetch | undefined;
  requestTimeoutMs?: number | undefined;
  pollTimeoutMs?: number | undefined;
  qrPollTimeoutMs?: number | undefined;
  channelVersion?: string | undefined;
}

/** 会话失效（-14）：调用方据此停轮询、置 auth_failed / paused。 */
export class ILinkSessionExpiredError extends Error {
  readonly code: number;
  constructor(code: number, errmsg: string) {
    super(`iLink session expired (${code}): ${errmsg}`);
    this.name = 'ILinkSessionExpiredError';
    this.code = code;
  }
}

export class ILinkApiError extends Error {
  readonly code: number;
  readonly errmsg: string;
  constructor(code: number, errmsg: string) {
    super(`iLink api error ${code}: ${errmsg}`);
    this.name = 'ILinkApiError';
    this.code = code;
    this.errmsg = errmsg;
  }
}

const CHANNEL_VERSION = '0.5.6';

export class ILinkClient {
  readonly #apiBase: string;
  readonly #logger: CoreLogger;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #pollTimeoutMs: number;
  readonly #qrPollTimeoutMs: number;

  constructor(options: ILinkClientOptions) {
    this.#apiBase = options.apiBase.replace(/\/$/, '');
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? ILINK_REQUEST_TIMEOUT_MS;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? ILINK_POLL_TIMEOUT_MS;
    this.#qrPollTimeoutMs = options.qrPollTimeoutMs ?? QR_POLL_RESULT_TIMEOUT_MS;
  }

  get apiBase(): string {
    return this.#apiBase;
  }

  #headers(token: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      // 每个请求都要带（PoC/参考实现均如此）：sendmessage 缺它会被服务器以
      // ret -2 "invalid arguments" 打回（比缺 context_token 的 "prepare failed"
      // 更早的校验层）——线上实测 2026-11-03。
      'X-WECHAT-UIN': Buffer.from(String(randomUint32()), 'utf8').toString('base64'),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '256',
    };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async #post<T>(endpoint: string, body: Record<string, unknown>, token: string | null, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(`${this.#apiBase}/${endpoint}`, {
        method: 'POST',
        headers: this.#headers(token),
        body: JSON.stringify(withBaseInfo(body)),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ILinkApiError(-1, `HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async #get<T>(endpoint: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(`${this.#apiBase}/${endpoint}`, {
        headers: this.#headers(null),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ILinkApiError(-1, `HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- 登录（无 token 阶段） ------------------------------------------------------

  async getQrcode(): Promise<ILinkQrcodeResponse> {
    const response = await this.#get<ILinkQrcodeResponse & { ret?: number }>(
      'ilink/bot/get_bot_qrcode?bot_type=3',
      this.#requestTimeoutMs,
    );
    if (typeof response.qrcode !== 'string' || typeof response.qrcode_img_content !== 'string') {
      throw new ILinkApiError(-1, 'get_bot_qrcode 响应缺少 qrcode 字段');
    }
    return response;
  }

  async pollQrcodeStatus(qrcode: string): Promise<ILinkQrcodeStatusResponse> {
    try {
      return await this.#get<ILinkQrcodeStatusResponse>(
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        this.#qrPollTimeoutMs,
      );
    } catch (error) {
      // 服务器把状态轮询当长轮询挂住，到点才空手返回——按「仍在等待」处理，
      // 调用方的轮询循环继续（PoC 实测：挂住 ~30s 属常态）。
      if (isAbort(error)) return { status: 'wait' };
      throw error;
    }
  }

  // --- Bot API（token 阶段） ------------------------------------------------------

  /** 长轮询收信。返回 null = 超时无消息；游标由调用方持久化。 */
  async getUpdates(token: string, cursor: string): Promise<{ cursor: string; msgs: ILinkMessage[] } | null> {
    let response: ILinkUpdatesResponse;
    try {
      response = await this.#post<ILinkUpdatesResponse>(
        'ilink/bot/getupdates',
        { get_updates_buf: cursor },
        token,
        this.#pollTimeoutMs,
      );
    } catch (error) {
      if (error instanceof ILinkApiError && isSessionExpiredCode(error.code)) throw new ILinkSessionExpiredError(error.code, error.errmsg);
      // 客户端长轮询到点（无消息）：回到外层循环再拉，不算失败。
      if (isAbort(error)) return null;
      throw error;
    }
    const code = response.ret ?? response.errcode ?? 0;
    if (isSessionExpiredCode(code)) {
      throw new ILinkSessionExpiredError(code, response.errmsg ?? '');
    }
    if (code !== 0) {
      throw new ILinkApiError(code, response.errmsg ?? '');
    }
    return {
      cursor: typeof response.get_updates_buf === 'string' && response.get_updates_buf !== '' ? response.get_updates_buf : cursor,
      msgs: response.msgs ?? [],
    };
  }

  /**
   * 发文本。`contextToken` 是回复上下文（入站消息携带）；不带是否被服务器接受由
   * PoC §4-1 定案（D110 降级判断）——这里按「尽力带上，缺失照发」实现。
   */
  async sendText(input: {
    token: string;
    toUserId: string;
    text: string;
    contextToken?: string | undefined;
  }): Promise<ILinkSendResult> {
    const msg: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: input.toUserId,
      client_id: `kepcup-${randomUint32().toString(36)}-${Date.now().toString(36)}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: input.text } }],
    };
    if (input.contextToken !== undefined && input.contextToken !== '') {
      msg.context_token = input.contextToken;
    }
    try {
      const response = await this.#post<{ ret?: number; errmsg?: string }>(
        'ilink/bot/sendmessage',
        { msg },
        input.token,
        this.#requestTimeoutMs,
      );
      const code = response.ret ?? 0;
      return { ok: code === 0, code, errmsg: response.errmsg ?? '' };
    } catch (error) {
      if (error instanceof ILinkApiError) {
        if (isSessionExpiredCode(error.code)) throw new ILinkSessionExpiredError(error.code, error.errmsg);
        return { ok: false, code: error.code, errmsg: error.errmsg };
      }
      return { ok: false, code: -1, errmsg: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 生命周期心跳：启动 / 停止时调用（失败只记日志，不阻塞）。 */
  async notify(token: string, kind: 'start' | 'stop'): Promise<void> {
    try {
      await this.#post(`ilink/bot/msg/notify${kind}`, {}, token, this.#requestTimeoutMs);
    } catch (error) {
      this.#logger.debug({ endpoint: `notify${kind}`, error: String(error) }, 'ilink notify failed (non-fatal)');
    }
  }
}

function withBaseInfo(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'KepCup' } };
}

/** -14：iLink 的会话失效码（一小时暂停；D108 / PoC §4-5）。 */
export function isSessionExpiredCode(code: number | undefined): boolean {
  return code === -14;
}

/** fetch 超时中断（AbortController）：长轮询到点的正常形态，不是故障。 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0);
}

/**
 * 提取入站消息的文本（type 1 的 text_item 拼接）。媒体消息返回空串——
 * 首期只处理文本入站（54 §1 非目标：媒体转发 P3）。
 */
export function ilinkMessageText(message: ILinkMessage): string {
  return (message.item_list ?? [])
    .filter((item) => item.type === 1)
    .map((item) => item.text_item?.text ?? '')
    .join('');
}

/** 入站去重键用的稳定消息 id（message_id 缺失时退 client_id / seq）。 */
export function ilinkMessageId(message: ILinkMessage): string {
  if (message.message_id !== undefined) return String(message.message_id);
  if (message.client_id !== undefined && message.client_id !== '') return message.client_id;
  return String(message.seq ?? 0);
}

import { createHash } from 'node:crypto';
import os from 'node:os';
import type { z } from 'zod';
import {
  AppError,
  newId,
  reportPayloadSchema,
  REPORT_ATTACHMENTS_MAX,
  REPORT_BOT_PROFILE_MAX_BYTES,
  REPORT_CONTEXT_ITEM_MAX_BYTES,
  REPORT_CONTEXT_MAX_ITEMS,
  REPORT_CONTENT_DEDUPE_MS,
  REPORT_MESSAGE_CONTENT_MAX_BYTES,
  REPORT_MESSAGE_TEXT_MAX_BYTES,
  REPORT_PAYLOAD_DEDUPE_MS,
  REPORT_PAYLOAD_MAX_BYTES,
  REPORT_REPLY_TO_TEXT_MAX_BYTES,
  REPORT_SCHEMA_VERSION,
  type Conversation,
  type Message,
  type ReportBotRuntime,
  type ReportPayload,
  type ReportTeamSnapshot,
} from '@kepcup/shared';

import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { reportsSubmitInputSchema } from '@kepcup/shared';
import type { BotsService } from './bots.js';
import type { ConversationsService } from './conversations.js';
import type { MessagesService } from './messages.js';
import type { SecretsService } from './secrets.js';
import type { SettingsService } from './settings.js';

/** RPC 输入（packages/shared reportsSubmitInputSchema，§6.5）。 */
export type ReportSubmitInput = z.infer<typeof reportsSubmitInputSchema>;

/** 发送端点；打包产物固定官方域名，测试 / 开发可用 KEPCUP_REPORT_ENDPOINT 覆盖（§6.2）。 */
const DEFAULT_ENDPOINT = 'https://reports.kepcup.com/v1/reports';
/** 同一 client 相邻两条举报的发送间隔（§6.3：1 条/分钟）。 */
const QUEUE_STEP_MS = 60_000;
/** 单次请求（GET challenge / POST report）超时（§6.2）。 */
const SEND_TIMEOUT_MS = 15_000;
/** 429 兜底退避下限（§6.2：max(retryAfter, 60s)）。 */
const RETRY_FLOOR_MS = 60_000;
/** 可重试错误（408/425/5xx/网络）的退避基值与上限：60s × 2^n，上限 1h。 */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;
/** 最多尝试次数，超过置 failed（§6.2）。 */
const MAX_ATTEMPTS = 20;
/** 后台轮询间隔：到期行最多延迟这么久才被拾起。 */
const POLL_INTERVAL_MS = 15_000;

// --- PoW（反滥用任务 5A，协议 v1）----------------------------------------------

/**
 * POST 收到 400 且 error 属于这六个 PoW 原因 → 换新 challenge 重解并重试恰好一次
 * （同 reportId 同 payload）；仍失败按「其他 4xx → failed」处理。challenge 失败
 * 一律 400 且不带 Retry-After，所以这里不读重试头。
 */
const POW_RETRY_REASONS: ReadonlySet<string> = new Set([
  'missing_proof',
  'challenge_invalid',
  'challenge_expired',
  'challenge_ip_mismatch',
  'challenge_reused',
  'proof_invalid',
]);
/** 求解器默认上限：difficulty 20 ≈ 2^20 次；超过视为服务端配置异常，按网络错误退避。 */
const POW_MAX_ITERATIONS = 20_000_000;

/** proof 兄弟键（传输层字段）：POST body 顶层，payload hash 不覆盖它（§5.4 剥离清单）。 */
interface ReportProof {
  challenge: string;
  solution: string;
}

/**
 * 发送端点 → challenge 端点（任务 5A）：把末尾 `/v1/reports` 段换成
 * `/v1/challenge`；端点不以 v1/reports 结尾（自定义路径）时按同源 + /v1/challenge。
 * parse URL 失败时退化为字符串拼接。
 */
export function challengeEndpointOf(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const segments = url.pathname.split('/');
    const last = segments[segments.length - 1] ?? '';
    const prev = segments[segments.length - 2] ?? '';
    if (last === 'reports' && prev === 'v1') {
      segments[segments.length - 1] = 'challenge';
      url.pathname = segments.join('/');
    } else {
      url.pathname = '/v1/challenge';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `${endpoint.replace(/\/+$/, '')}/v1/challenge`;
  }
}

/** sha256 摘要的前导零比特数（难度度量，协议 v1；与 Worker pow.ts 同规则）。 */
export function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while (mask !== 0 && (byte & mask) === 0) {
      bits += 1;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/**
 * PoW 求解器（协议 v1）：找 ASCII 字符串 solution 使
 * `sha256(utf8(n + ':' + solution))` 的前导零比特数 ≥ difficulty。
 * 同步循环（core 的 outbox tick 本就跑在后台 utilityProcess，无 UI 阻塞）；
 * difficulty 20 ≈ 2^20 次 ≈ 0.3s 单核。超过 maxIterations 抛错，由调用方按
 * 网络错误退避处理（保持 pending，等服务端配置恢复）。
 */
export function solveChallenge(
  nonce: string,
  difficulty: number,
  maxIterations: number = POW_MAX_ITERATIONS,
): string {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) {
    throw new Error(`pow: bad difficulty ${difficulty}`);
  }
  for (let i = 0; i < maxIterations; i += 1) {
    const solution = i.toString(36);
    const digest = createHash('sha256').update(Buffer.from(`${nonce}:${solution}`, 'utf8')).digest();
    if (leadingZeroBits(digest) >= difficulty) return solution;
  }
  throw new Error(`pow: unsolved after ${maxIterations} iterations (difficulty ${difficulty})`);
}

/** challenge token 的 payload 段（`v1.<payload>.<hmac>` 中段）：客户端解出 n / d 用于求解。 */
interface ChallengeTokenPayload {
  n: string;
  exp: number;
  d: number;
}

/** 解 token（不验签——验签是服务端的事；客户端只需要 n / d 来求解）。 */
function decodeChallengePayload(token: string): ChallengeTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || parts[1] === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      n?: unknown;
      exp?: unknown;
      d?: unknown;
    };
    if (
      typeof parsed.n !== 'string' ||
      parsed.n.length === 0 ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.d !== 'number'
    ) {
      return null;
    }
    return { n: parsed.n, exp: parsed.exp, d: parsed.d };
  } catch {
    return null;
  }
}

interface OutboxRow {
  id: string;
  client_id: string;
  message_id: string;
  conversation_id: string;
  content_hash: string;
  content_bucket: number;
  payload_hash: string;
  payload_bucket: number;
  payload_json: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

/**
 * canonicalJson（§5.4）：递归按 key 字典序排序、数组保序、JSON.stringify 风格。
 * 与 Workers 侧（crypto.subtle）实现共享 `packages/shared/test/fixtures/
 * report-v1.json` 固定向量，两侧禁止只改一边。
 *
 * 边界值语义与 Workers 实现（infra/cloudflare/reports/src/dedupe.ts）逐点一致：
 * undefined 值的对象键剔除；undefined 数组元素 → null；顶层 undefined /
 * function / symbol → null（JSON.stringify 的数组元素语义，保证恒返回 string）；
 * NaN / ±Infinity → null、-0 → "0"、数字用 V8 Number::toString（Node 与
 * Workers 同为 V8）；字符串转义即 JSON.stringify（非 ASCII 不转义、孤立代理对
 * 按 \uXXXX 转义）。合法 payload 里不会出现这些值（core 构建前已清洗），但两
 * 侧实现必须在这些边界上也产出同一字节串。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  // undefined / function / symbol：数组元素语义（JSON.stringify 中折算为 null）。
  return 'null';
}

/** sha256 小写 hex（§5.4：hash 形状 REPORT_HASH_PATTERN）。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** 去掉 NUL 等 C0 控制字符（保留 \n \t；§5.3），避免 SQLite / JSON 边界问题。 */
function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** UTF-8 字节截断：不劈开多字节字符 / 代理对，返回是否发生截断（§5.3 / §9）。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  let out = bytes.subarray(0, cut).toString('utf8');
  const last = out.codePointAt(out.length - 1) ?? 0;
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return { text: out, truncated: true };
}

/** 时间桶（§5.5）：bucket = floor(now / window)；窗口 0 = 永久去重（bucket 恒 0）。 */
function timeBucket(now: number, windowMs: number): number {
  return windowMs > 0 ? Math.floor(now / windowMs) : 0;
}

/** 指数退避（§6.2）：60s × 2^(attempts-1)，上限 1h，±20% jitter。 */
function backoffDelay(attempts: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** 递归把每个字符串叶截到 budget 字节（#truncateTree 的单轮裁剪）。 */
function clipTree(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') return truncateUtf8(value, maxBytes).text;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => clipTree(item, maxBytes));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = clipTree(item, maxBytes);
    }
    return out;
  }
  return null;
}

/** 字符串叶统计（条数 / 总字节数），#truncateTree 的首轮预算用。 */
function stringStats(value: unknown): { count: number; bytes: number } {
  if (typeof value === 'string') {
    return { count: 1, bytes: Buffer.byteLength(value, 'utf8') };
  }
  if (value === null || typeof value !== 'object') return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const stats = stringStats(item);
    count += stats.count;
    bytes += stats.bytes;
  }
  return { count, bytes };
}

/** 429 的重试等待：先 Retry-After 头（秒），再 JSON body 的 retryAfterMs（§6.2）。 */
async function readRetryAfterMs(response: Response): Promise<number | null> {
  const header = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  if (Number.isFinite(header) && header >= 0) return header * 1000;
  try {
    const body = (await response.json()) as { retryAfterMs?: unknown };
    if (
      typeof body?.retryAfterMs === 'number' &&
      Number.isFinite(body.retryAfterMs) &&
      body.retryAfterMs >= 0
    ) {
      return body.retryAfterMs;
    }
  } catch {
    // body 不是 JSON / 已被消费。
  }
  return null;
}

/** 400 的 JSON body 错误码（`{error}`）；非 JSON / 已消费 / 缺字段返回 null。 */
async function readErrorReason(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/** 消息展示正文（textContent / cardContent 的 text 段；卡片正文可为空）。 */
function messageTextOf(message: Message): string {
  const content = message.content;
  if (content !== null && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

interface Collected {
  conversation: { id: string; type: Conversation['type'] };
  bot: ReportPayload['bot'];
  message: ReportPayload['message'];
  contentSource: string;
  replyTo: ReportPayload['replyTo'];
  context: ReportPayload['context'];
  usage: ReportPayload['usage'];
  tools: ReportPayload['tools'];
  providers: ReportPayload['providers'];
}

export interface ReportServiceDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: Pick<CoreLogger, 'info' | 'warn' | 'error'>;
  bots: BotsService;
  messages: MessagesService;
  conversations: ConversationsService;
  settings: SettingsService;
  secrets: SecretsService;
  /** KEPCUP_APP_VERSION（§5.2 client.appVersion）。 */
  appVersion: string;
  endpoint?: string | undefined;
  /** 测试注入；缺省 globalThis.fetch。 */
  fetch?: typeof globalThis.fetch | undefined;
}

/**
 * AI 生成内容举报的本机核心（todo/ai-content-reporting.md §6.2）：
 *
 * - `submit()` 校验可举报性 → local 用 `messages.getById()` 重读正文（不信任渲染
 *   层；team 用渲染层快照）→ 收集 bot / usage / tools / providers / context /
 *   replyTo → redact + 清洗 + 截断 → 计算 canonicalJson 双 hash → 按时间桶
 *   `INSERT OR IGNORE` 入 `report_outbox`（唯一索引判重，并发安全）→ kick 发送器。
 *   不做网络等待，立即返回 queued / duplicate / rejected。
 * - 发送状态机（`#tickOnce`）：pending → sending（条件 UPDATE 抢占）→ GET
 *   /v1/challenge 并求解 PoW（任务 5A；disabled / 旧版端点缺失 → 无 proof 直发）→
 *   POST（proof 作顶层兄弟键，payload 契约不变）；2xx sent；429 按 Retry-After /
 *   retryAfterMs 退避（下限 60s）；400 且为 PoW 原因 → 换新 challenge 重试恰好
 *   一次；408 / 425 / 5xx / 网络错误指数退避（60s×2^n 上限 1h ±20% jitter）；
 *   其余 4xx/3xx failed（schema 不兼容需要发版修，不自动重试）；最多 20 次。
 * - `start()` 把崩溃残留的 sending 行重置回 pending；定时器 unref()，不阻止退出。
 * - 日志只记 reportId / status / 错误码，禁止正文 / clientId（§8）。
 */
export class ReportService {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;
  readonly #logger: ReportServiceDeps['logger'];
  readonly #bots: BotsService;
  readonly #messages: MessagesService;
  readonly #conversations: ConversationsService;
  readonly #settings: SettingsService;
  readonly #secrets: SecretsService;
  readonly #appVersion: string;
  readonly #endpoint: string;
  readonly #challengeEndpoint: string;
  readonly #fetch: typeof globalThis.fetch;

  #started = false;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #draining: Promise<void> | null = null;
  /** drain 活动期间又有行可能到期（submit / kick）→ 当前轮结束后补一轮。 */
  #recheck = false;

  constructor(deps: ReportServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#bots = deps.bots;
    this.#messages = deps.messages;
    this.#conversations = deps.conversations;
    this.#settings = deps.settings;
    this.#secrets = deps.secrets;
    this.#appVersion = deps.appVersion;
    this.#endpoint = deps.endpoint ?? DEFAULT_ENDPOINT;
    this.#challengeEndpoint = challengeEndpointOf(this.#endpoint);
    this.#fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // --- submit（§6.2 职责 1）--------------------------------------------------

  /**
   * 校验并构建举报 payload、入队。同步返回：`queued`（已入队）/ `duplicate`
   * （同 client 同 hash 同桶已存在）/ `rejected`（不是可举报的 Bot 消息）。
   */
  submit(
    input: ReportSubmitInput,
  ): { status: 'queued' | 'duplicate' | 'rejected'; reason?: string } {
    const now = this.#clock.now();
    // 深嵌套内容（恶意 / 异常卡片 JSON）会让递归清洗或 canonicalJson 触发
    // RangeError：按 rejected 收口，submit 不因内容形状向外抛错（团队快照的
    // content 来自渲染层 / 团队服务端，不可全信）。
    let collected: Collected | null;
    let payload: ReportPayload;
    let payloadJson: string;
    try {
      collected = this.#collect(input);
      if (collected === null) return { status: 'rejected', reason: 'not_reportable' };
      payload = this.#buildPayload(input, collected, now);
      payloadJson = canonicalJson(payload);
    } catch (error) {
      if (error instanceof RangeError) {
        return { status: 'rejected', reason: 'payload_too_deep' };
      }
      throw error;
    }
    if (Buffer.byteLength(payloadJson, 'utf8') > REPORT_PAYLOAD_MAX_BYTES) {
      return { status: 'rejected', reason: 'payload_too_large' };
    }

    // 排队位（§6.3）：该 client 已有行（pending/sending/sent）→ 最后入队的
    // next_attempt_at + 60s 与 now + 60s 取较大者；首条立即。sent 行也在内：
    // 服务端同样 60s/client 限流，紧挨着发只会吃 429。failed 行不计（§6.4：
    // 失败行不重试，也不该把新举报顶到陈旧的未来时间点之后）。
    const last = this.#db
      .prepare(
        "select max(next_attempt_at) as last from report_outbox where client_id = ? and status != 'failed'",
      )
      .get(input.clientId) as { last: number | null };
    const nextAttemptAt =
      last.last === null ? now : Math.max(last.last + QUEUE_STEP_MS, now + QUEUE_STEP_MS);

    const result = this.#db
      .prepare(
        `insert or ignore into report_outbox
           (id, client_id, message_id, conversation_id, content_hash, content_bucket,
            payload_hash, payload_bucket, payload_json, status, attempts, next_attempt_at,
            last_error, created_at, sent_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL)`,
      )
      .run(
        payload.reportId,
        input.clientId,
        payload.message.id,
        payload.conversation.id,
        payload.hashes.content,
        timeBucket(now, REPORT_CONTENT_DEDUPE_MS),
        payload.hashes.payload,
        timeBucket(now, REPORT_PAYLOAD_DEDUPE_MS),
        payloadJson,
        nextAttemptAt,
        now,
      );
    // 唯一索引命中（同 client + hash + bucket，含并发）→ duplicate（§6.2）。
    if (result.changes === 0) return { status: 'duplicate' };

    this.#logger.info({ reportId: payload.reportId, status: 'queued' }, 'report outbox');
    this.kick();
    return { status: 'queued' };
  }

  // --- payload 构建 / 双 hash（§5.4）------------------------------------------

  #buildPayload(input: ReportSubmitInput, collected: Collected, now: number): ReportPayload {
    const payload: ReportPayload = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      reportId: newId('rep'),
      createdAt: now,
      reason: 'inappropriate',
      client: {
        id: input.clientId,
        surface: input.surface ?? 'desktop',
        appVersion: this.#appVersion,
        platform: process.platform,
        arch: process.arch,
        osVersion: os.release(),
        locale: this.#settings.get().appLanguage,
      },
      source: input.source,
      conversation: collected.conversation,
      bot: collected.bot,
      message: collected.message,
      replyTo: collected.replyTo,
      context: collected.context,
      usage: collected.usage,
      tools: collected.tools,
      providers: collected.providers,
      hashes: { content: '', payload: '' },
    };
    // hash（§5.4）：content 用清洗/截断后的正文或卡片 JSON（§9：hash 基于截断后
    // 内容）；payload 去掉 reportId / createdAt / hashes（其余全保留）。bucket
    // 不进 hash（§5.5：两侧时钟独立，避免时钟差异导致 hash 不匹配）。
    const contentSource =
      payload.message.kind === 'text'
        ? payload.message.text
        : canonicalJson(payload.message.content ?? { text: payload.message.text });
    payload.hashes = {
      content: sha256Hex(contentSource),
      payload: sha256Hex(canonicalJson(dedupePayloadOf(payload))),
    };
    // 契约自检：shape 漂移在构建点就暴露（Worker 校验前兜底，测试即报警）。
    const parsed = reportPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('INTERNAL', 'report payload failed schema validation');
    }
    return payload;
  }

  // --- 信息收集 ---------------------------------------------------------------

  #collect(input: ReportSubmitInput): Collected | null {
    return input.source.kind === 'team' ? this.#collectTeam(input) : this.#collectLocal(input);
  }

  /** local 来源：全部字段从本地 DB 重读，渲染层正文只用于定位 id（§5.2）。 */
  #collectLocal(input: ReportSubmitInput): Collected | null {
    const message = this.#messages.getById(input.messageId);
    if (
      message === null ||
      message.conversationId !== input.conversationId ||
      message.senderType !== 'bot' ||
      (message.kind !== 'text' && message.kind !== 'card') ||
      message.status === 'recalled'
    ) {
      return null;
    }
    const conversation = this.#conversations.get(input.conversationId);
    const bot = message.senderBotId !== null ? this.#bots.get(message.senderBotId) : null;
    const runId = message.runId;

    const built = this.#buildMessage(message);
    const usage = runId === null ? [] : this.#usageOf(runId);
    return {
      conversation: { id: input.conversationId, type: conversation?.type ?? 'direct' },
      bot: this.#botOf(bot, message.senderBotId),
      message: built.message,
      contentSource: built.contentSource,
      replyTo: message.replyTo !== null ? this.#replyToOf(message.replyTo) : null,
      context: this.#contextOf(message),
      usage,
      tools: runId === null ? [] : this.#toolsOf(runId),
      providers: this.#providersOf(usage),
    };
  }

  /** team 来源：消息不在本地 DB，只能信渲染层快照（模型信息可能缺失，不阻塞）。 */
  #collectTeam(input: ReportSubmitInput): Collected | null {
    const snapshot: ReportTeamSnapshot | undefined = input.snapshot;
    if (snapshot === undefined) return null;
    const message = snapshot.message;
    if ((message.kind !== 'text' && message.kind !== 'card') || message.status === 'recalled') {
      return null;
    }

    const built = this.#buildMessageFromSnapshot(message);
    // 会话类型：快照带 type 优先（§5.2）；否则本地查（团队会话 id 一般不在本机
    // conversations 表，reaction 用 team:<hash> scope 隔离），最后回退 'dm'。
    const conversationType =
      snapshot.conversation?.type ?? this.#conversations.get(input.conversationId)?.type ?? 'dm';

    const sb = snapshot.bot;
    const runtime: ReportBotRuntime = sb.runtime ?? {
      model: '',
      lightModel: '',
      backgroundModel: '',
      agent: { id: '', model: '', effort: '' },
    };
    return {
      conversation: { id: input.conversationId, type: conversationType },
      bot: {
        id: sb.id ?? '',
        name: sb.name ?? '',
        systemRole: sb.systemRole ?? null,
        runtime,
        profile: this.#truncateTree(this.#cleanTree(sb.profile ?? {}), REPORT_BOT_PROFILE_MAX_BYTES),
      },
      message: built.message,
      contentSource: built.contentSource,
      replyTo:
        snapshot.replyTo === null
          ? null
          : this.#replyToItem(snapshot.replyTo.messageId, snapshot.replyTo.text),
      context: snapshot.context
        .slice(0, REPORT_CONTEXT_MAX_ITEMS)
        .map((item) => ({
          messageId: item.messageId,
          senderType: item.senderType,
          kind: item.kind,
          text: this.#clip(item.text, REPORT_CONTEXT_ITEM_MAX_BYTES).text,
          createdAt: item.createdAt,
        })),
      usage: snapshot.usage ?? [],
      tools: snapshot.tools ?? [],
      providers: snapshot.providers ?? [],
    };
  }

  /** 本地消息 → payload.message（redact → 清洗 → 截断；§5.3）。 */
  #buildMessage(message: Message): { message: ReportPayload['message']; contentSource: string } {
    const isText = message.kind === 'text';
    const text = this.#clip(messageTextOf(message), REPORT_MESSAGE_TEXT_MAX_BYTES);
    const content = isText
      ? null
      : this.#truncateTree(this.#cleanTree(message.content ?? {}), REPORT_MESSAGE_CONTENT_MAX_BYTES);
    const built: ReportPayload['message'] = {
      id: message.id,
      seq: message.seq,
      kind: message.kind as 'text' | 'card',
      status: message.status,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      runId: message.runId,
      text: text.text,
      content,
      truncated: text.truncated,
      attachments: message.attachments.slice(0, REPORT_ATTACHMENTS_MAX).map((a) => ({
        fileName: this.#clean(a.fileName),
        mime: this.#clean(a.mime),
        size: a.size,
      })),
    };
    return { message: built, contentSource: contentSourceOf(built) };
  }

  /** 团队快照消息同样过 redact / 清洗 / 截断（快照来自渲染层，不可全信）。 */
  #buildMessageFromSnapshot(
    message: ReportTeamSnapshot['message'],
  ): { message: ReportPayload['message']; contentSource: string } {
    const isText = message.kind === 'text';
    const text = this.#clip(message.text, REPORT_MESSAGE_TEXT_MAX_BYTES);
    const content = isText
      ? null
      : this.#truncateTree(this.#cleanTree(message.content ?? {}), REPORT_MESSAGE_CONTENT_MAX_BYTES);
    const built: ReportPayload['message'] = {
      id: message.id,
      seq: message.seq,
      kind: message.kind,
      status: message.status,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      runId: message.runId,
      text: text.text,
      content,
      truncated: text.truncated || message.truncated,
      attachments: message.attachments.slice(0, REPORT_ATTACHMENTS_MAX).map((a) => ({
        fileName: this.#clean(a.fileName),
        mime: this.#clean(a.mime),
        size: a.size,
      })),
    };
    return { message: built, contentSource: contentSourceOf(built) };
  }

  /** Bot 段（§5.2）：已删除的 Bot 仍可举报——名字尽力取，profile 为空对象（§9）。 */
  #botOf(bot: ReturnType<BotsService['get']>, senderBotId: string | null): ReportPayload['bot'] {
    if (bot === null || bot.status === 'deleted') {
      return {
        id: bot?.id ?? senderBotId ?? '',
        // markDeleted 会把占位行名字清空 → 尽力回退到消息里的 senderBotId。
        name: bot?.name || senderBotId || '',
        systemRole: null,
        runtime: {
          model: '',
          lightModel: '',
          backgroundModel: '',
          agent: { id: '', model: '', effort: '' },
        },
        profile: {},
      };
    }
    return {
      id: bot.id,
      name: bot.name,
      systemRole: bot.systemRole === 'butler' ? 'butler' : null,
      runtime: {
        model: bot.profile.runtime.model,
        lightModel: bot.profile.runtime.light_model,
        backgroundModel: bot.profile.runtime.background_model,
        agent: {
          id: bot.profile.runtime.agent?.id ?? '',
          model: bot.profile.runtime.agent?.model ?? '',
          effort: bot.profile.runtime.agent?.effort ?? '',
        },
      },
      profile: this.#trimmedProfile(bot.profile),
    };
  }

  /**
   * profile 只留画像五段（identity / persona / role / boundaries / behavior，
   * 与 fixture 一致）：profile_json 的 runtime 段带插件 / 连接 / MCP id 等无关
   * 字段（§5.3 要求去掉），模型信息走 payload.bot.runtime 专段。整树
   * redact + 清洗 + ≤8KB。
   */
  #trimmedProfile(profile: unknown): unknown {
    const source =
      profile !== null && typeof profile === 'object' ? (profile as Record<string, unknown>) : {};
    const trimmed: Record<string, unknown> = {};
    for (const key of ['identity', 'persona', 'role', 'boundaries', 'behavior'] as const) {
      if (key in source) trimmed[key] = this.#cleanTree(source[key] ?? {});
    }
    return this.#truncateTree(trimmed, REPORT_BOT_PROFILE_MAX_BYTES);
  }

  #replyToOf(messageId: string): ReportPayload['replyTo'] {
    const reply = this.#messages.getById(messageId);
    if (reply === null) return null;
    return this.#replyToItem(messageId, messageTextOf(reply));
  }

  #replyToItem(messageId: string, rawText: string): ReportPayload['replyTo'] {
    return { messageId, text: this.#clip(rawText, REPORT_REPLY_TO_TEXT_MAX_BYTES).text };
  }

  /**
   * context（§5.2）：目标消息之前最近的可见消息，跳过 system_event /
   * task_event（listVisible 已在 SQL 层排除 task_event 与内部事件，这里再去掉
   * system 发送者），各截 2KB。多取几条再裁最近 4 条：中间夹系统事件也能凑满。
   */
  #contextOf(message: Message): ReportPayload['context'] {
    const rows = this.#messages
      .listVisible(message.conversationId, { beforeSeq: message.seq, limit: 16 })
      .filter((row) => row.senderType !== 'system')
      .slice(-REPORT_CONTEXT_MAX_ITEMS);
    return rows.map((row) => ({
      messageId: row.id,
      senderType: row.senderType as 'user' | 'bot',
      kind: row.kind,
      text: this.#clip(messageTextOf(row), REPORT_CONTEXT_ITEM_MAX_BYTES).text,
      createdAt: row.createdAt,
    }));
  }

  /** usage（§5.2）：usage_ledger 按 (provider, model, loop_type) 分组。 */
  #usageOf(runId: string): ReportPayload['usage'] {
    return this.#db
      .prepare(
        `select provider, model, loop_type as loopType,
                count(*) as calls, sum(input_tokens) as inputTokens, sum(output_tokens) as outputTokens
         from usage_ledger where run_id = ? group by provider, model, loop_type
         order by provider, model, loop_type`,
      )
      .all(runId) as ReportPayload['usage'];
  }

  /** tools（§5.2）：tool_usage_ledger 只带工具名与次数，不带输出全文。 */
  #toolsOf(runId: string): ReportPayload['tools'] {
    return this.#db
      .prepare(
        `select tool_name as name, sum(calls) as calls
         from tool_usage_ledger where run_id = ? group by tool_name order by tool_name`,
      )
      .all(runId) as ReportPayload['tools'];
  }

  /** providers（§5.2）：usage 命中的 settings.modelProviders 实例，不带 baseUrl / Key。 */
  #providersOf(usage: ReportPayload['usage']): ReportPayload['providers'] {
    if (usage.length === 0) return [];
    const used = new Set(usage.map((row) => row.provider));
    return this.#settings
      .get()
      .modelProviders.filter((provider) => used.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        vendor: provider.vendor ?? '',
        api: provider.api,
      }));
  }

  // --- 清洗 / 截断（顺序：redact → 去控制字符 → 截断，§5.3）--------------------

  #clean(text: string): string {
    return stripControlChars(this.#secrets.redact(text));
  }

  #clip(text: string, maxBytes: number): { text: string; truncated: boolean } {
    return truncateUtf8(this.#clean(text), maxBytes);
  }

  #cleanTree(value: unknown): unknown {
    if (typeof value === 'string') return this.#clean(value);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((item) => this.#cleanTree(item));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.#cleanTree(item);
      }
      return out;
    }
    return null;
  }

  /**
   * 递归截断字符串叶，保证整树 canonicalJson ≤ maxBytes（§5.3）。首轮预算按
   * 「可用字节 / 字符串条数」均摊（长串削得多、短串尽量保留），不收敛再折半，
   * 兜底全部清空（骨架大小 << 上限，实际到不了）。
   */
  #truncateTree(value: unknown, maxBytes: number): unknown {
    if (Buffer.byteLength(canonicalJson(value), 'utf8') <= maxBytes) return value;
    const { count } = stringStats(value);
    let budget = count > 0 ? Math.floor((maxBytes * 0.9) / count) : maxBytes;
    for (let i = 0; i < 10; i += 1) {
      const clipped = clipTree(value, budget);
      if (Buffer.byteLength(canonicalJson(clipped), 'utf8') <= maxBytes) return clipped;
      if (budget === 0) return clipped;
      budget = Math.floor(budget / 2);
    }
    return clipTree(value, 0);
  }

  // --- 发送状态机（§6.2 职责 2）------------------------------------------------

  /** 触发发送（不等待；drain 单飞，重复调用合并）。 */
  kick(): void {
    this.#recheck = true;
    void this.drain();
  }

  /**
   * 处理所有到期行直到没有到期行。测试直接 await 它获得确定性；生产路径走
   * kick() / start() 的轮询定时器。
   */
  drain(): Promise<void> {
    if (this.#draining !== null) return this.#draining;
    this.#draining = this.#drainLoop().finally(() => {
      this.#draining = null;
    });
    return this.#draining;
  }

  async #drainLoop(): Promise<void> {
    do {
      this.#recheck = false;
      for (;;) {
        let processed: boolean;
        try {
          processed = await this.#tickOnce();
        } catch {
          // 单行故障不拖垮整轮；下个轮询周期重试。只记固定码，不带细节。
          // close() 竞态（在途 tick 落在关库之后）时 logger 可能已关闭：不能让
          // 这里的同步抛出变成未处理的 rejection。
          try {
            this.#logger.warn({ status: 'tick_failed' }, 'report outbox');
          } catch {
            // Logger already closed.
          }
          processed = false;
        }
        if (!processed) break;
      }
    } while (this.#recheck);
  }

  /** 取一行到期行并发送；返回是否处理过一行（false = 没有到期行，结束循环）。 */
  async #tickOnce(): Promise<boolean> {
    const now = this.#clock.now();
    const row = this.#db
      .prepare(
        "select * from report_outbox where status = 'pending' and next_attempt_at <= ? " +
          'order by next_attempt_at asc, created_at asc limit 1',
      )
      .get(now) as OutboxRow | undefined;
    if (row === undefined) return false;
    if (row.attempts >= MAX_ATTEMPTS) {
      // 达上限的残留 pending 行：不再发请求，直接落 failed。
      this.#db
        .prepare("update report_outbox set status = 'failed', last_error = 'max_attempts' where id = ?")
        .run(row.id);
      this.#logger.info({ reportId: row.id, status: 'failed', code: 'max_attempts' }, 'report outbox');
      return true;
    }
    // 条件 UPDATE 抢占：并发 tick 已认领 → 跳过（§6.2）。
    const claimed = this.#db
      .prepare("update report_outbox set status = 'sending' where id = ? and status = 'pending'")
      .run(row.id);
    if (claimed.changes === 0) return true;

    try {
      // PoW（任务 5A）：POST 前先 GET challenge 并求解；disabled / 旧版 Worker
      // （无端点 4xx）→ 直接 POST 无 proof。求解超上限抛错 → catch 走网络退避。
      let proof = await this.#solveProofOrNull();
      let response = await this.#postReport(row, proof);
      let powRetried = false;
      for (;;) {
        const code = response.status;
        if (response.ok) {
          this.#finish(row, 'sent', null);
          return true;
        }
        const retryAfterMs = code === 429 ? await readRetryAfterMs(response) : null;
        const errorReason = code === 400 ? await readErrorReason(response) : null;
        try {
          await response.arrayBuffer();
        } catch {
          // body 读取失败不影响状态机。
        }
        if (
          code === 400 &&
          !powRetried &&
          errorReason !== null &&
          POW_RETRY_REASONS.has(errorReason)
        ) {
          // PoW 失败：换新 challenge 重解、重试恰好一次（同 reportId 同 payload）。
          // 仍失败按下方常规分支处理（其他 4xx → failed）。
          powRetried = true;
          proof = await this.#solveProofOrNull();
          response = await this.#postReport(row, proof);
          continue;
        }
        if (code === 429) {
          // 服务端限流：按 Retry-After / retryAfterMs 退避，下限 60s（§6.2）。
          this.#retry(row, Math.max(retryAfterMs ?? 0, RETRY_FLOOR_MS), `HTTP ${code}`);
        } else if (code === 408 || code === 425 || code >= 500) {
          // 可重试：指数退避，保持 pending。
          this.#retry(row, backoffDelay(row.attempts + 1), `HTTP ${code}`);
        } else {
          // 其余 4xx / 3xx：schema 不兼容 / 端点配错，重试无意义 → failed（§6.4）。
          this.#finish(row, 'failed', `HTTP ${code}`);
        }
        return true;
      }
    } catch {
      // 网络错误 / 超时 / challenge GET 5xx·429 / 求解超上限：留在本机队列，
      // 指数退避（§9 离线行为）。
      this.#retry(row, backoffDelay(row.attempts + 1), 'network');
      return true;
    }
  }

  /** POST /v1/reports（proof 非 null 时注入 body 顶层兄弟键；payload 契约不变）。 */
  async #postReport(row: OutboxRow, proof: ReportProof | null): Promise<Response> {
    const body =
      proof === null
        ? row.payload_json
        : JSON.stringify({ ...(JSON.parse(row.payload_json) as Record<string, unknown>), proof });
    return this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  }

  /**
   * GET /v1/challenge 并求解；返回 null 表示无需 proof（响应没有 challenge 字段 =
   * 服务端 PoW 关闭；其他 4xx = 旧版 Worker 没有该端点，直发让 POST 给出裁决）。
   * 可重试错误（429 / 408 / 425 / 5xx）抛出 → 走网络退避保持 pending。challenge /
   * solution 原文永不进日志（§8）。
   */
  async #solveProofOrNull(): Promise<ReportProof | null> {
    const response = await this.#fetch(this.#challengeEndpoint, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      try {
        await response.arrayBuffer();
      } catch {
        // body 读取失败不影响分支判断。
      }
      if (response.status === 429 || response.status === 408 || response.status === 425 || response.status >= 500) {
        throw new Error(`challenge HTTP ${response.status}`);
      }
      return null; // 其他 4xx：服务端无 challenge 端点（旧版本）→ 无 proof 直发。
    }
    const body = (await response.json().catch(() => null)) as {
      challenge?: unknown;
      difficulty?: unknown;
    } | null;
    // enabled:false（PoW 关闭）→ 无 proof 直发（服务端同样不要求）。
    if (body === null || typeof body.challenge !== 'string' || body.challenge === '') return null;
    const token = body.challenge;
    const payload = decodeChallengePayload(token);
    if (payload === null) throw new Error('challenge: unparseable token');
    // 服务端按 token 里绑定的难度校验；响应 difficulty 仅作参考，取两者较大者。
    const difficulty = Math.max(
      typeof body.difficulty === 'number' && Number.isFinite(body.difficulty) ? body.difficulty : 0,
      payload.d,
    );
    const solution = solveChallenge(payload.n, difficulty);
    return { challenge: token, solution };
  }

  /** 失败重试：attempts+1；到上限置 failed，否则保持 pending 定下次时间。 */
  #retry(row: OutboxRow, delayMs: number, errorCode: string): void {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.#finish(row, 'failed', errorCode);
      return;
    }
    const now = this.#clock.now();
    this.#db
      .prepare(
        "update report_outbox set status = 'pending', attempts = ?, last_error = ?, next_attempt_at = ? where id = ?",
      )
      .run(attempts, errorCode, now + delayMs, row.id);
    this.#logger.info({ reportId: row.id, status: 'retry', code: errorCode }, 'report outbox');
  }

  /** 终态（sent / failed）：同样消耗一次尝试（attempts+1）。 */
  #finish(row: OutboxRow, status: 'sent' | 'failed', errorCode: string | null): void {
    const now = this.#clock.now();
    this.#db
      .prepare('update report_outbox set status = ?, attempts = ?, last_error = ?, sent_at = ? where id = ?')
      .run(status, row.attempts + 1, errorCode, status === 'sent' ? now : null, row.id);
    this.#logger.info(
      {
        reportId: row.id,
        status,
        ...(errorCode !== null ? { code: errorCode } : {}),
      },
      'report outbox',
    );
  }

  // --- 生命周期（§6.2 职责 3）--------------------------------------------------

  /** 崩溃恢复（sending → pending）+ 启动轮询 + 立即 tick 一次。 */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#db.prepare("update report_outbox set status = 'pending' where status = 'sending'").run();
    this.#armPoll();
    void this.drain();
  }

  #armPoll(): void {
    if (!this.#started) return;
    const timer = setTimeout(() => {
      void this.drain();
      this.#armPoll();
    }, POLL_INTERVAL_MS);
    timer.unref?.();
    this.#pollTimer = timer;
  }

  stop(): void {
    this.#started = false;
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /** 只清定时器，不等待在途网络（§6.2；在途 DB 写失败由 #drainLoop 兜住）。 */
  close(): void {
    this.stop();
  }

  /** 队列摘要（不含 payload，§6.2 职责 4）。 */
  listPending(): Array<{ id: string; status: string; attempts: number; nextAttemptAt: number }> {
    return (
      this.#db
        .prepare(
          'select id, status, attempts, next_attempt_at from report_outbox order by next_attempt_at asc',
        )
        .all() as Array<Pick<OutboxRow, 'id' | 'status' | 'attempts' | 'next_attempt_at'>>
    ).map((row) => ({
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
    }));
  }
}

/** dedupePayload（§5.4）：去掉 transport-only 字段（reportId / createdAt / hashes）。 */
function dedupePayloadOf(payload: ReportPayload): Record<string, unknown> {
  const dedupe: Record<string, unknown> = { ...payload };
  delete dedupe.reportId;
  delete dedupe.createdAt;
  delete dedupe.hashes;
  return dedupe;
}

/** hash 的 content 源（§5.4）：text 消息用正文，卡片用卡片 JSON（空则 {text}）。 */
function contentSourceOf(message: ReportPayload['message']): string {
  return message.kind === 'text'
    ? message.text
    : canonicalJson(message.content ?? { text: message.text });
}

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import {
  reportPayloadSchema,
  REPORT_CONTENT_DEDUPE_MS,
  REPORT_PAYLOAD_DEDUPE_MS,
  type Bot,
} from '@kepcup/shared';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { BotsService } from '../../src/domain/bots.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { MessagesService } from '../../src/domain/messages.js';
import { SettingsService } from '../../src/domain/settings.js';
import { SecretsService } from '../../src/domain/secrets.js';
import {
  canonicalJson,
  challengeEndpointOf,
  leadingZeroBits,
  ReportService,
  sha256Hex,
  solveChallenge,
} from '../../src/domain/reports.js';
import type { Clock } from '../../src/infra/clock.js';

/**
 * ReportService（todo/ai-content-reporting.md §6.2 / §10.1）：payload 构建、
 * local 重读 / team 快照、拒绝不可举报消息、redact / 截断、双 hash、时间桶
 * 去重、按 client 排队、发送状态机、日志不落正文。hash 固定向量的跨实现
 * 锚点在 report-contract.test.ts（与 Worker 共享）。
 */

const BASE = 1_700_000_000_000;
const ENDPOINT = 'https://reports.test/v1/reports';
const APP_VERSION = '0.6.2-test';

const dir = mkdtempSync(path.join(tmpdir(), 'reports-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface LogEntry {
  obj: unknown;
  msg: string;
}

interface FetchCall {
  url: string | URL | Request;
  init: RequestInit | undefined;
}

type FetchHandler = (url: string | URL | Request, init: RequestInit | undefined) => Response;

interface Rig {
  db: SqliteDatabase;
  reports: ReportService;
  bots: BotsService;
  messages: MessagesService;
  conversations: ConversationsService;
  settings: SettingsService;
  secrets: SecretsService;
  bot: Bot;
  conversationId: string;
  setNow: (ms: number) => void;
  getNow: () => number;
  logs: LogEntry[];
  fetchCalls: FetchCall[];
  setFetch: (handler: FetchHandler) => void;
  /** GET /v1/challenge 的应答；null = 默认 disabled 形状（PoW 关闭，直发无 proof）。 */
  setChallenge: (handler: FetchHandler | null) => void;
}

let rigCount = 0;

function okResponse(body: unknown, status = 201, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function makeRig(): Rig {
  rigCount += 1;
  const db = openDatabase({
    path: path.join(dir, `main-${rigCount}.db`),
    key: deriveKey(Buffer.alloc(32, rigCount + 100), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let now = BASE;
  const clock: Clock = { now: () => now };
  const logs: LogEntry[] = [];
  const logger = {
    info: (obj: unknown, msg: string) => logs.push({ obj, msg }),
    warn: (obj: unknown, msg: string) => logs.push({ obj, msg }),
    error: (obj: unknown, msg: string) => logs.push({ obj, msg }),
  };
  const bots = new BotsService(db, clock);
  const conversations = new ConversationsService(db, clock, {});
  const messages = new MessagesService(db, clock);
  const settings = new SettingsService(db, clock);
  const secrets = new SecretsService({
    db,
    masterKey: Buffer.alloc(32, rigCount + 200),
    clock,
    logger: logger as never,
  });
  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = () => okResponse({ status: 'accepted' }, 201);
  let challengeHandler: FetchHandler | null = null;
  const fetchImpl: typeof globalThis.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    const urlText =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (urlText.includes('/v1/challenge')) {
      return challengeHandler !== null
        ? challengeHandler(url, init)
        : okResponse({ enabled: false, difficulty: 0 }, 200);
    }
    return handler(url, init);
  };
  const reports = new ReportService({
    db,
    clock,
    logger,
    bots,
    messages,
    conversations,
    settings,
    secrets,
    appVersion: APP_VERSION,
    endpoint: ENDPOINT,
    fetch: fetchImpl,
  });
  const bot = bots.create({
    identity: { name: '小助手', bio: '测试 Bot' },
    persona: { tone: '专业、简洁' },
    boundaries: ['不提供投资建议'],
    runtime: {
      model: 'openai/gpt-5.1',
      light_model: 'openai/gpt-5.1-mini',
      background_model: '',
      agent: { id: 'builtin', model: '', effort: '' },
    },
  });
  const conversationId = conversations.openDirect(bot.id).conversation.id;
  return {
    db,
    reports,
    bots,
    messages,
    conversations,
    settings,
    secrets,
    bot,
    conversationId,
    setNow: (ms) => (now = ms),
    getNow: () => now,
    logs,
    fetchCalls,
    setFetch: (next) => (handler = next),
    setChallenge: (next) => (challengeHandler = next),
  };
}

// --- 种数辅助 ---------------------------------------------------------------

function appendBotMessage(
  rig: Rig,
  text: string,
  opts: { runId?: string; replyTo?: string } = {},
): ReturnType<MessagesService['append']> {
  return rig.messages.append({
    conversationId: rig.conversationId,
    senderType: 'bot',
    senderBotId: rig.bot.id,
    kind: 'text',
    text,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
  });
}

function submitText(rig: Rig, messageId: string, clientId = 'client-1'): ReturnType<ReportService['submit']> {
  return rig.reports.submit({
    clientId,
    source: { kind: 'local' },
    messageId,
    conversationId: rig.conversationId,
  });
}

interface OutboxRow {
  id: string;
  client_id: string;
  message_id: string;
  content_hash: string;
  content_bucket: number;
  payload_hash: string;
  payload_bucket: number;
  payload_json: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  sent_at: number | null;
}

function outboxRows(rig: Rig): OutboxRow[] {
  return rig.db.prepare('select * from report_outbox order by created_at, id').all() as OutboxRow[];
}

// --- PoW（任务 5A 协议 v1；node:crypto 镜像 Worker src/pow.ts 的构造） ----------

const POW_SECRET = 'core-test-pow-secret';
const CHALLENGE_URL = challengeEndpointOf(ENDPOINT);

/** 签出 `v1.<payload>.<hmac>` challenge token（HMAC-SHA256，协议 v1）。 */
function signChallengeToken(
  payload: { n: string; exp: number; d: number },
  secret: string = POW_SECRET,
): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(`v1.${payloadPart}`, 'utf8'))
    .digest();
  return `v1.${payloadPart}.${mac.toString('base64url')}`;
}

/** fake challenge 应答（enabled 模式）：随机 nonce + 低难度，测试秒解。 */
function challengeResponse(
  rig: Rig,
  opts: { d?: number; n?: string } = {},
): Response {
  const n = opts.n ?? randomBytes(16).toString('hex');
  const d = opts.d ?? 8;
  return okResponse(
    {
      challenge: signChallengeToken({ n, exp: rig.getNow() + 600_000, d }),
      difficulty: d,
      expiresAt: rig.getNow() + 600_000,
      algorithm: 'sha256',
    },
    200,
  );
}

function payloadOf(row: OutboxRow): ReturnType<typeof reportPayloadSchema.parse> {
  return reportPayloadSchema.parse(JSON.parse(row.payload_json));
}

/** 重算 payload 的两个 hash（与 reports.ts 内部同一算法，§5.4）。 */
function recomputeHashes(row: OutboxRow): { content: string; payload: string } {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const message = payload.message as { kind: string; text: string; content: unknown };
  const contentSource =
    message.kind === 'text'
      ? message.text
      : canonicalJson(message.content ?? { text: message.text });
  const dedupe: Record<string, unknown> = { ...payload };
  delete dedupe.reportId;
  delete dedupe.createdAt;
  delete dedupe.hashes;
  return { content: sha256Hex(contentSource), payload: sha256Hex(canonicalJson(dedupe)) };
}

// --- 用例 -------------------------------------------------------------------

describe('ReportService.submit payload 构建（local）', () => {
  it('builds the full payload: bot/profile/runtime, usage, tools, providers, context, replyTo, client', () => {
    const rig = makeRig();
    try {
      rig.settings.update({
        appLanguage: 'en-US',
        modelProviders: [{ id: 'openai', vendor: null, name: 'OpenAI', api: 'openai-completions' }],
      });
      const userMsg = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '帮我把数据按大区汇总',
      });
      const target = appendBotMessage(rig, '已经汇总好了：华北 +12.3%。', {
        runId: 'run_1',
        replyTo: userMsg.id,
      });
      rig.db
        .prepare(
          "insert into usage_ledger (id, run_id, loop_type, provider, model, input_tokens, output_tokens, created_at) values ('u1','run_1','turn','openai','gpt-5.1',1000,400,1)",
        )
        .run();
      rig.db
        .prepare(
          "insert into usage_ledger (id, run_id, loop_type, provider, model, input_tokens, output_tokens, created_at) values ('u2','run_1','turn','openai','gpt-5.1',234,56,2)",
        )
        .run();
      rig.db
        .prepare(
          "insert into tool_usage_ledger (id, run_id, loop_type, tool_name, calls, created_at) values ('t1','run_1','task','web_search',1,1)",
        )
        .run();

      const result = submitText(rig, target.id);
      expect(result.status).toBe('queued');
      const rows = outboxRows(rig);
      expect(rows).toHaveLength(1);
      const payload = payloadOf(rows[0]!);

      expect(payload.schemaVersion).toBe(1);
      expect(payload.reportId).toMatch(/^rep_/);
      expect(payload.createdAt).toBe(BASE);
      expect(payload.reason).toBe('inappropriate');
      expect(payload.client).toEqual({
        id: 'client-1',
        surface: 'desktop',
        appVersion: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        osVersion: os.release(),
        locale: 'en-US',
      });
      expect(payload.source).toEqual({ kind: 'local' });
      expect(payload.conversation).toEqual({ id: rig.conversationId, type: 'direct' });
      expect(payload.bot).toEqual({
        id: rig.bot.id,
        name: '小助手',
        systemRole: null,
        runtime: {
          model: 'openai/gpt-5.1',
          lightModel: 'openai/gpt-5.1-mini',
          backgroundModel: '',
          agent: { id: 'builtin', model: '', effort: '' },
        },
        profile: {
          identity: { name: '小助手', bio: '测试 Bot' },
          persona: expect.objectContaining({ tone: '专业、简洁' }),
          role: expect.any(Object),
          boundaries: ['不提供投资建议'],
          behavior: expect.any(Object),
        },
      });
      // profile 不带 runtime 段（插件 / 连接 id 不外发，模型走 bot.runtime 专段）。
      expect(payload.bot.profile).not.toHaveProperty('runtime');
      expect(payload.message).toMatchObject({
        id: target.id,
        kind: 'text',
        status: 'normal',
        text: '已经汇总好了：华北 +12.3%。',
        content: null,
        truncated: false,
        runId: 'run_1',
      });
      expect(payload.replyTo).toEqual({ messageId: userMsg.id, text: '帮我把数据按大区汇总' });
      expect(payload.context).toEqual([
        {
          messageId: userMsg.id,
          senderType: 'user',
          kind: 'text',
          text: '帮我把数据按大区汇总',
          createdAt: BASE,
        },
      ]);
      expect(payload.usage).toEqual([
        { provider: 'openai', model: 'gpt-5.1', loopType: 'turn', calls: 2, inputTokens: 1234, outputTokens: 456 },
      ]);
      expect(payload.tools).toEqual([{ name: 'web_search', calls: 1 }]);
      // providers 只带 id/name/vendor/api（不带 baseUrl / Key）。
      expect(payload.providers).toEqual([
        { id: 'openai', name: 'OpenAI', vendor: '', api: 'openai-completions' },
      ]);
      const hashes = recomputeHashes(rows[0]!);
      expect(payload.hashes).toEqual(hashes);
      expect(rows[0]!.content_hash).toBe(hashes.content);
      expect(rows[0]!.payload_hash).toBe(hashes.payload);
      expect(rows[0]!.content_bucket).toBe(Math.floor(BASE / REPORT_CONTENT_DEDUPE_MS));
      expect(rows[0]!.payload_bucket).toBe(Math.floor(BASE / REPORT_PAYLOAD_DEDUPE_MS));
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('collects attachment metadata only (fileName / mime / size, max 20)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '图表已生成。');
      rig.db
        .prepare(
          "insert into attachments (id, conversation_id, message_id, file_name, mime, size, sha256, rel_path, created_at) values ('att_1', ?, ?, 'q3-sales.png', 'image/png', 12345, 'abc', 'files/att_1', 1)",
        )
        .run(rig.conversationId, target.id);
      submitText(rig, target.id);
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.message.attachments).toEqual([
        { fileName: 'q3-sales.png', mime: 'image/png', size: 12345 },
      ]);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('re-reads the message from the local DB (renderer state is not trusted)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, 'DB 里的正文');
      // 模拟渲染层拿到的快照已过期：DB 行在提交前被改写 → payload 以 DB 为准。
      rig.db
        .prepare('update messages set content_json = ? where id = ?')
        .run(JSON.stringify({ text: '改写后的正文' }), target.id);
      submitText(rig, target.id);
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.message.text).toBe('改写后的正文');
      expect(recomputeHashes(outboxRows(rig)[0]!).content).toBe(payload.hashes.content);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('builds context from the last visible messages, skipping system events', () => {
    const rig = makeRig();
    try {
      const u1 = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '第一句',
      });
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'system',
        kind: 'system_event',
        event: 'run_interrupted',
        text: '系统事件不出现在 context',
      });
      const u2 = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '第二句',
      });
      const target = appendBotMessage(rig, '回复');
      submitText(rig, target.id);
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.context.map((item) => item.messageId)).toEqual([u1.id, u2.id]);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('omits renderer-hidden reply/context rows while still reporting the visible target', () => {
    const rig = makeRig();
    try {
      const hidden = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: 'HIDDEN_REPLY_AND_CONTEXT',
      });
      const visible = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: 'visible context',
      });
      const target = appendBotMessage(rig, 'visible report target', { replyTo: hidden.id });
      const result = rig.reports.submit({
        clientId: 'client-1',
        source: { kind: 'local' },
        messageId: target.id,
        conversationId: rig.conversationId,
        excludedMessageIds: [hidden.id, target.id],
      });
      expect(result.status).toBe('queued');
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.message.text).toBe('visible report target');
      expect(payload.replyTo).toBeNull();
      expect(payload.context.map((item) => item.messageId)).toEqual([visible.id]);
      expect(JSON.stringify(payload)).not.toContain('HIDDEN_REPLY_AND_CONTEXT');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('supports card messages: content hash uses the card JSON', () => {
    const rig = makeRig();
    try {
      const card = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: rig.bot.id,
        kind: 'card',
        cardType: 'demo_card',
      });
      submitText(rig, card.id);
      const row = outboxRows(rig)[0]!;
      const payload = payloadOf(row);
      expect(payload.message.kind).toBe('card');
      expect(payload.message.content).toMatchObject({ cardType: 'demo_card' });
      expect(payload.message.text).toBe('');
      // 卡片消息 content hash = canonicalJson(content)。
      expect(row.content_hash).toBe(sha256Hex(canonicalJson(payload.message.content)));
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('ReportService.submit 快照与拒绝', () => {
  it('accepts a team snapshot without any local message (missing model info tolerated)', () => {
    const rig = makeRig();
    try {
      const result = rig.reports.submit({
        clientId: 'client-1',
        source: { kind: 'team', serverHash: '0123456789abcdef' },
        messageId: 'srv_msg_1',
        conversationId: 'srv_conv_1',
        snapshot: {
          message: {
            id: 'srv_msg_1',
            seq: 12,
            kind: 'text',
            status: 'normal',
            createdAt: BASE - 5000,
            editedAt: null,
            runId: null,
            text: '团队 Bot 的回复',
            content: null,
            truncated: false,
            attachments: [],
          },
          replyTo: null,
          context: [
            {
              messageId: 'srv_msg_0',
              senderType: 'user',
              kind: 'text',
              text: '团队里的上一句',
              createdAt: BASE - 6000,
            },
          ],
          bot: { id: 'srv_bot_1', name: '团队小助手' },
          conversation: { type: 'dm' },
        },
      });
      expect(result.status).toBe('queued');
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.source).toEqual({ kind: 'team', serverHash: '0123456789abcdef' });
      // 快照缺 runtime / usage / tools / providers → 尽力而为，不阻塞。
      expect(payload.bot).toMatchObject({ id: 'srv_bot_1', name: '团队小助手', systemRole: null });
      expect(payload.bot.runtime).toEqual({
        model: '',
        lightModel: '',
        backgroundModel: '',
        agent: { id: '', model: '', effort: '' },
      });
      expect(payload.usage).toEqual([]);
      expect(payload.tools).toEqual([]);
      expect(payload.providers).toEqual([]);
      // 快照带 conversation.type → 直接采用（§5.2，团队会话本地查不到）。
      expect(payload.conversation).toEqual({ id: 'srv_conv_1', type: 'dm' });
      expect(payload.message.text).toBe('团队 Bot 的回复');
      expect(payload.context).toHaveLength(1);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('defensively omits excluded hidden rows from a team snapshot', () => {
    const rig = makeRig();
    try {
      const result = rig.reports.submit({
        clientId: 'client-1',
        source: { kind: 'team', serverHash: '0123456789abcdef' },
        messageId: 'srv_visible_target',
        conversationId: 'srv_conv_hidden',
        excludedMessageIds: ['srv_hidden_reply', 'srv_hidden_context'],
        snapshot: {
          message: {
            id: 'srv_visible_target',
            seq: 3,
            kind: 'text',
            status: 'normal',
            createdAt: BASE,
            editedAt: null,
            runId: null,
            text: 'visible team target',
            content: null,
            truncated: false,
            attachments: [],
          },
          replyTo: { messageId: 'srv_hidden_reply', text: 'HIDDEN_TEAM_REPLY' },
          context: [
            {
              messageId: 'srv_hidden_context',
              senderType: 'user',
              kind: 'text',
              text: 'HIDDEN_TEAM_CONTEXT',
              createdAt: BASE - 2,
            },
            {
              messageId: 'srv_visible_context',
              senderType: 'user',
              kind: 'text',
              text: 'visible team context',
              createdAt: BASE - 1,
            },
          ],
          bot: { name: '团队小助手' },
        },
      });
      expect(result.status).toBe('queued');
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.message.text).toBe('visible team target');
      expect(payload.replyTo).toBeNull();
      expect(payload.context.map((item) => item.messageId)).toEqual(['srv_visible_context']);
      expect(JSON.stringify(payload)).not.toContain('HIDDEN_TEAM_');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('team snapshot without conversation.type falls back to local lookup, then dm', () => {
    const rig = makeRig();
    try {
      const snapshotMessage = {
        id: 'srv_msg_2',
        seq: 3,
        kind: 'text' as const,
        status: 'normal' as const,
        createdAt: BASE - 1000,
        editedAt: null,
        runId: null,
        text: '无类型快照',
        content: null,
        truncated: false,
        attachments: [],
      };
      // 快照不带 conversation → 本机 conversations 查不到团队 id → 回退 'dm'。
      const result = rig.reports.submit({
        clientId: 'client-1',
        source: { kind: 'team', serverHash: '0123456789abcdef' },
        messageId: snapshotMessage.id,
        conversationId: 'srv_conv_notype',
        snapshot: {
          message: snapshotMessage,
          replyTo: null,
          context: [],
          bot: { name: '团队小助手' },
        },
      });
      expect(result.status).toBe('queued');
      expect(payloadOf(outboxRows(rig)[0]!).conversation).toEqual({
        id: 'srv_conv_notype',
        type: 'dm',
      });
      // 本机恰好有同 id 会话（本机来源升团队等罕见场景）→ 用本地类型。
      // 文本换一句，避免 content hash 撞唯一索引（同 client 同桶）误判 duplicate。
      const result2 = rig.reports.submit({
        clientId: 'client-1',
        source: { kind: 'team', serverHash: '0123456789abcdef' },
        messageId: 'srv_msg_3',
        conversationId: rig.conversationId,
        snapshot: {
          message: { ...snapshotMessage, id: 'srv_msg_3', text: '无类型快照第二句' },
          replyTo: null,
          context: [],
          bot: { name: '团队小助手' },
        },
      });
      expect(result2.status).toBe('queued');
      const row2 = outboxRows(rig).find((row) => row.message_id === 'srv_msg_3')!;
      expect(payloadOf(row2).conversation).toEqual({
        id: rig.conversationId,
        type: 'direct',
      });
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('rejects user / system / recalled / non-text-card messages and team without snapshot', () => {
    const rig = makeRig();
    try {
      const userMsg = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '用户消息不可举报',
      });
      expect(submitText(rig, userMsg.id).status).toBe('rejected');

      const systemMsg = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'system',
        kind: 'system_event',
        event: 'run_interrupted',
        text: '系统消息不可举报',
      });
      expect(submitText(rig, systemMsg.id).status).toBe('rejected');

      const recalled = appendBotMessage(rig, '已撤回');
      rig.db.prepare("update messages set status = 'recalled' where id = ?").run(recalled.id);
      expect(submitText(rig, recalled.id).status).toBe('rejected');

      const taskEvent = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: rig.bot.id,
        kind: 'task_event',
        ownerBotId: rig.bot.id,
        taskEvent: { taskId: 'run_t', phase: 'result', text: '任务条目不可举报' },
      });
      expect(submitText(rig, taskEvent.id).status).toBe('rejected');

      const target = appendBotMessage(rig, '正常消息');
      // 消息不属于入参对话 → 拒绝（防串会话）。
      expect(
        rig.reports.submit({
          clientId: 'client-1',
          source: { kind: 'local' },
          messageId: target.id,
          conversationId: 'conv_other',
        }).status,
      ).toBe('rejected');

      // 团队来源缺快照 → 拒绝。
      expect(
        rig.reports.submit({
          clientId: 'client-1',
          source: { kind: 'team', serverHash: '0123456789abcdef' },
          messageId: 'srv_msg_x',
          conversationId: 'srv_conv_x',
        }).status,
      ).toBe('rejected');

      // 不存在的消息 → 拒绝。
      expect(submitText(rig, 'msg_missing').status).toBe('rejected');
      expect(outboxRows(rig)).toHaveLength(0);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('rejects (not throws) on pathologically deep card content', () => {
    const rig = makeRig();
    try {
      // 10 万层嵌套的卡片 JSON：递归清洗 / canonicalJson / JSON.parse 都会触发
      // RangeError → submit 按 rejected 收口，不向外抛（§6.5 出参只有三态）。
      const deep = `${'['.repeat(100_000)}1${']'.repeat(100_000)}`;
      const card = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: rig.bot.id,
        kind: 'card',
        cardType: 'deep_card',
      });
      rig.db.prepare('update messages set content_json = ? where id = ?').run(deep, card.id);
      expect(submitText(rig, card.id).status).toBe('rejected');
      expect(outboxRows(rig)).toHaveLength(0);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('still reports when the bot was deleted (name best-effort, empty profile)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, 'Bot 删除前的回复');
      rig.bots.markDeleted(rig.bot.id);
      const result = submitText(rig, target.id);
      expect(result.status).toBe('queued');
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.bot.id).toBe(rig.bot.id);
      // 占位行名字被 markDeleted 清空 → 尽力回退到消息里的 senderBotId。
      expect(payload.bot.name).toBe(rig.bot.id);
      expect(payload.bot.profile).toEqual({});
      expect(payload.bot.runtime).toEqual({
        model: '',
        lightModel: '',
        backgroundModel: '',
        agent: { id: '', model: '', effort: '' },
      });
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('ReportService redact 与截断（§5.3）', () => {
  it('redacts known secrets from text / context / profile before hashing', () => {
    const rig = makeRig();
    try {
      rig.secrets.setValue('provider:openai', 'sk-secret-value-123');
      const u1 = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '我的 key 是 sk-secret-value-123 帮我查账',
      });
      const target = appendBotMessage(rig, '收到，key 是 sk-secret-value-123。');
      submitText(rig, target.id);
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.message.text).toContain('[REDACTED]');
      expect(payload.message.text).not.toContain('sk-secret-value-123');
      expect(payload.context[0]?.text).toContain('[REDACTED]');
      expect(JSON.stringify(payload)).not.toContain('sk-secret-value-123');
      // hash 基于脱敏后的内容。
      expect(payload.hashes.content).toBe(sha256Hex(payload.message.text));
      expect(u1.id).not.toBe('');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('strips C0 control characters but keeps \\n and \\t', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '第一行\n第二行\t制表\u0000NUL\u0007BEL');
      submitText(rig, target.id);
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.message.text).toBe('第一行\n第二行\t制表NULBEL');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('truncates oversized text at a UTF-8 boundary (32KB, truncated flag)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '好'.repeat(20_000)); // 60KB UTF-8
      submitText(rig, target.id);
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(payload.message.truncated).toBe(true);
      expect(Buffer.byteLength(payload.message.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
      // 不劈开多字节字符：截断点落在「好」的边界上。
      expect(Buffer.byteLength(payload.message.text, 'utf8') % 3).toBe(0);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('truncates card content (16KB), context items (2KB) and bot profile (8KB)', () => {
    const rig = makeRig();
    try {
      const bigUser = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: 'x'.repeat(8_000),
      });
      // boundaries 数量无上限（单条 ≤500）：20 条 × 500 字 ≈ 10KB+，超过 8KB 画像上限。
      rig.bots.update(rig.bot.id, {
        identity: { name: '小助手', bio: '测试 Bot' },
        boundaries: Array.from({ length: 20 }, () => 'y'.repeat(500)),
      });
      const card = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: rig.bot.id,
        kind: 'card',
        cardType: 'big_card',
      });
      // 卡内容塞 20KB 字符串（直改 DB 行，绕开 append 的卡片构造器）。
      rig.db
        .prepare('update messages set content_json = ? where id = ?')
        .run(JSON.stringify({ cardType: 'big_card', text: 'z'.repeat(20_000) }), card.id);

      submitText(rig, card.id);
      const payload = payloadOf(outboxRows(rig)[0]!);
      expect(Buffer.byteLength(canonicalJson(payload.message.content), 'utf8')).toBeLessThanOrEqual(
        16 * 1024,
      );
      expect(Buffer.byteLength(payload.context[0]!.text, 'utf8')).toBeLessThanOrEqual(2 * 1024);
      expect(Buffer.byteLength(canonicalJson(payload.bot.profile), 'utf8')).toBeLessThanOrEqual(
        8 * 1024,
      );
      expect(bigUser.id).not.toBe('');
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('ReportService 时间桶去重（§5.5）', () => {
  it('dedupes the same message within the bucket (both hashes hit)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '同一条消息');
      expect(submitText(rig, target.id).status).toBe('queued');
      expect(submitText(rig, target.id).status).toBe('duplicate');
      expect(outboxRows(rig)).toHaveLength(1);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('dedupes different messages with identical text via the content hash', () => {
    const rig = makeRig();
    try {
      const first = appendBotMessage(rig, '常见句式：我无法协助这个请求。');
      const second = appendBotMessage(rig, '常见句式：我无法协助这个请求。');
      expect(submitText(rig, first.id).status).toBe('queued');
      expect(submitText(rig, second.id).status).toBe('duplicate');
      expect(outboxRows(rig)).toHaveLength(1);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('does not dedupe across clients (per-client scopes)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '不同 client 同文');
      expect(submitText(rig, target.id, 'client-1').status).toBe('queued');
      expect(submitText(rig, target.id, 'client-2').status).toBe('queued');
      const rows = outboxRows(rig);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.content_hash).toBe(rows[1]!.content_hash);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('crosses the content bucket via the payload hash, then re-reports past the payload bucket', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '跨桶边界');
      expect(submitText(rig, target.id).status).toBe('queued');
      // +24h：content 桶已翻页，但同一消息 payload hash 不变、payload 桶（90d）未翻 → 仍判重。
      rig.setNow(BASE + REPORT_CONTENT_DEDUPE_MS);
      expect(submitText(rig, target.id).status).toBe('duplicate');
      expect(outboxRows(rig)).toHaveLength(1);
      // +90d：两个桶都翻页 → 允许再报（窗口语义，§9「窗口外可再报」）。
      rig.setNow(BASE + REPORT_PAYLOAD_DEDUPE_MS + 60_000);
      expect(submitText(rig, target.id).status).toBe('queued');
      const rows = outboxRows(rig);
      expect(rows).toHaveLength(2);
      // payload hash 一致（去 reportId / createdAt 后同内容同 hash），桶不同。
      expect(rows[0]!.payload_hash).toBe(rows[1]!.payload_hash);
      expect(rows[0]!.payload_bucket).not.toBe(rows[1]!.payload_bucket);
      expect(rows[0]!.content_bucket).not.toBe(rows[1]!.content_bucket);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('lets identical text re-report once the content window has passed (different message)', () => {
    const rig = makeRig();
    try {
      const first = appendBotMessage(rig, '窗口外的常见句');
      expect(submitText(rig, first.id).status).toBe('queued');
      rig.setNow(BASE + REPORT_CONTENT_DEDUPE_MS);
      // 不同消息同文：content 桶已翻、payload hash 因 message.id 不同而不同 → 可再报。
      const second = appendBotMessage(rig, '窗口外的常见句');
      expect(submitText(rig, second.id).status).toBe('queued');
      expect(outboxRows(rig)).toHaveLength(2);
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('ReportService.cancel（§6.5：撤回未发送的举报）', () => {
  it('cancels a pending row: deleted, and the dedupe slot is released (immediate re-submit queues)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '撤回后重报');
      expect(submitText(rig, target.id).status).toBe('queued');
      // submit 的同步 kick 会立即把行认领为 sending（#tickOnce 首个 await 前的
      // 条件 UPDATE）；显式置回 pending 表示「尚未发出的待发举报」。
      rig.db.prepare("update report_outbox set status = 'pending'").run();
      expect(rig.reports.cancel('client-1', target.id)).toEqual({ status: 'cancelled' });
      expect(outboxRows(rig)).toHaveLength(0);
      // 删除行即释放 (client, hash, bucket) 唯一索引槽位：同内容同窗口立即可重报。
      expect(submitText(rig, target.id).status).toBe('queued');
      expect(outboxRows(rig)).toHaveLength(1);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('cancels a failed row (never delivered; local discard is the correct semantics)', async () => {
    const rig = makeRig();
    try {
      rig.setFetch(() => okResponse({ error: 'bad_request' }, 400));
      const target = appendBotMessage(rig, '失败行撤回');
      submitText(rig, target.id);
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('failed');
      expect(rig.reports.cancel('client-1', target.id)).toEqual({ status: 'cancelled' });
      expect(outboxRows(rig)).toHaveLength(0);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('refuses to cancel a sent row (not_revocable/sent) and keeps it', async () => {
    const rig = makeRig();
    try {
      rig.setFetch(() => okResponse({ status: 'accepted' }, 201));
      const target = appendBotMessage(rig, '已发送不可撤');
      submitText(rig, target.id);
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('sent');
      expect(rig.reports.cancel('client-1', target.id)).toEqual({
        status: 'not_revocable',
        reason: 'sent',
      });
      expect(outboxRows(rig)).toHaveLength(1);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('refuses to cancel a sending row (not_revocable/sending)', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '发送中不可撤');
      submitText(rig, target.id);
      // submit 的同步 kick 已把行认领为 sending（#tickOnce 首个 await 前的
      // 条件 UPDATE）；显式置 sending 保证确定性。
      rig.db.prepare("update report_outbox set status = 'sending'").run();
      expect(rig.reports.cancel('client-1', target.id)).toEqual({
        status: 'not_revocable',
        reason: 'sending',
      });
      expect(outboxRows(rig)).toHaveLength(1);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('returns not_revocable/none when there is no row for the (client, message)', () => {
    const rig = makeRig();
    try {
      expect(rig.reports.cancel('client-1', 'msg_missing')).toEqual({
        status: 'not_revocable',
        reason: 'none',
      });
      // 不同 client 传同一 messageId：按 client 过滤，既删不掉也看不见别人的行。
      const target = appendBotMessage(rig, '别人的举报');
      submitText(rig, target.id, 'client-1');
      expect(rig.reports.cancel('client-2', target.id)).toEqual({
        status: 'not_revocable',
        reason: 'none',
      });
      expect(outboxRows(rig)).toHaveLength(1);
      expect(outboxRows(rig)[0]!.client_id).toBe('client-1');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('a cancelled row is never sent by later kick/tick (fetch counter counts no POST)', async () => {
    const rig = makeRig();
    try {
      // challenge GET 500：行被认领后按网络错误退避回 pending（不发 POST）——
      // 先 settle 到「尚未发出的待发举报」状态再撤回。
      rig.setChallenge(() => okResponse({ error: 'boom' }, 500));
      rig.setFetch(() => okResponse({ status: 'accepted' }, 201));
      const target = appendBotMessage(rig, '撤回后不再发送');
      submitText(rig, target.id);
      await rig.reports.drain();
      const row = outboxRows(rig)[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(rig.reports.cancel('client-1', target.id)).toEqual({ status: 'cancelled' });
      rig.reports.kick();
      await rig.reports.drain();
      const posts = rig.fetchCalls.filter((call) => !String(call.url).includes('/v1/challenge'));
      expect(posts).toHaveLength(0);
      expect(rig.reports.listPending()).toHaveLength(0);
      expect(outboxRows(rig)).toHaveLength(0);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('cancel deletes every revocable row of the (client, message) across dedupe buckets', async () => {
    const rig = makeRig();
    try {
      // 全程离线：第一次举报被同步 kick 认领 sending 后发送失败 → 退回 pending
      // （退避中，next_attempt_at 在未来）。
      rig.setFetch(() => {
        throw new Error('offline');
      });
      const target = appendBotMessage(rig, '跨桶多行撤回', { runId: 'run-x' });
      submitText(rig, target.id);
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('pending');
      // run 结束后 usage 落库 → 第二次举报的 payload hash 变化；时钟跨过 24h
      // 内容桶 → 两个唯一索引都不命中，同 (client, message) 落出第二行。
      rig.db
        .prepare(
          "insert into usage_ledger (id, run_id, loop_type, provider, model, input_tokens, output_tokens, created_at) values ('u1','run-x','turn','openai','gpt-5.1',1000,400,1)",
        )
        .run();
      rig.setNow(BASE + REPORT_CONTENT_DEDUPE_MS + 60_000);
      expect(submitText(rig, target.id).status).toBe('queued');
      // 第二次 submit 的同步 kick 会先认领仍到期的第一行（sending）再按网络
      // 错误退避回 pending；await drain 让在途 tick 落定，两行都是「尚未发出的
      // 待发举报」——cancel 面对的正是这个确定状态。
      await rig.reports.drain();
      const rows = outboxRows(rig);
      expect(rows).toHaveLength(2);
      expect(
        rows.every((row) => row.client_id === 'client-1' && row.message_id === target.id),
      ).toBe(true);
      expect(rows[0]!.content_bucket).not.toBe(rows[1]!.content_bucket);
      expect(rows.every((row) => row.status === 'pending')).toBe(true);
      // cancel 按 (client, message) 全删可撤行（跨桶多行一并清理）。
      expect(rig.reports.cancel('client-1', target.id)).toEqual({ status: 'cancelled' });
      expect(outboxRows(rig)).toHaveLength(0);
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('ReportService 排队（§6.3）', () => {
  it('queues the first report immediately, then +60s per client, clients independent', () => {
    const rig = makeRig();
    try {
      const m1 = appendBotMessage(rig, '第一条');
      const m2 = appendBotMessage(rig, '第二条');
      const m3 = appendBotMessage(rig, '第三条');
      expect(submitText(rig, m1.id).status).toBe('queued');
      expect(submitText(rig, m2.id).status).toBe('queued');
      expect(submitText(rig, m3.id).status).toBe('queued');
      const rows = outboxRows(rig);
      expect(rows.map((row) => row.next_attempt_at)).toEqual([
        BASE,
        BASE + 60_000,
        BASE + 120_000,
      ]);
      // 异 client 独立计时。
      const m4 = appendBotMessage(rig, '第四条');
      expect(submitText(rig, m4.id, 'client-2').status).toBe('queued');
      const rowsAfter = outboxRows(rig);
      expect(rowsAfter[3]!.client_id).toBe('client-2');
      expect(rowsAfter[3]!.next_attempt_at).toBe(BASE);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('listPending returns the queue summary without payloads', () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '摘要用');
      submitText(rig, target.id);
      const pending = rig.reports.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual({
        id: expect.stringMatching(/^rep_/),
        status: expect.stringMatching(/^(pending|sending|sent)$/),
        attempts: expect.any(Number),
        nextAttemptAt: BASE,
      });
      expect(JSON.stringify(pending)).not.toContain('payload_json');
      expect(JSON.stringify(pending)).not.toContain('摘要用');
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('ReportService 发送状态机（§6.2 / §6.4）', () => {
  it('POSTs the stored payload and marks the row sent on 2xx', async () => {
    const rig = makeRig();
    try {
      rig.setFetch(() => okResponse({ status: 'accepted' }, 201));
      const target = appendBotMessage(rig, '发送成功');
      expect(submitText(rig, target.id).status).toBe('queued');
      await rig.reports.drain();
      const row = outboxRows(rig)[0]!;
      expect(row.status).toBe('sent');
      expect(row.sent_at).toBe(BASE);
      expect(row.last_error).toBeNull();
      // PoW（任务 5A）：先 GET /v1/challenge（默认 disabled 应答）→ POST /v1/reports。
      expect(rig.fetchCalls).toHaveLength(2);
      const [challengeCall, call] = rig.fetchCalls;
      expect(challengeCall!.url).toBe(CHALLENGE_URL);
      expect(challengeCall!.init?.method).toBe('GET');
      expect(challengeCall!.init?.redirect).toBe('error');
      expect(call!.url).toBe(ENDPOINT);
      expect(call!.init?.method).toBe('POST');
      expect(call!.init?.redirect).toBe('error');
      expect((call!.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
      // disabled 模式直发：body 就是入队时的 payload_json，无 proof 兄弟键。
      expect(call!.init?.body).toBe(row.payload_json);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('keeps pending when the challenge endpoint 5xx (no POST attempted)', async () => {
    const rig = makeRig();
    try {
      rig.setChallenge(() => new Response('boom', { status: 500 }));
      const target = appendBotMessage(rig, 'challenge 不可达');
      submitText(rig, target.id);
      await rig.reports.drain();
      const row = outboxRows(rig)[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('network');
      // 只有 challenge GET，没有 POST。
      expect(rig.fetchCalls).toHaveLength(1);
      expect(rig.fetchCalls[0]!.init?.method).toBe('GET');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('falls back to a proof-less POST when the challenge endpoint is 404 (old worker)', async () => {
    const rig = makeRig();
    try {
      rig.setChallenge(() => new Response('{}', { status: 404 }));
      rig.setFetch(() => okResponse({ status: 'accepted' }, 201));
      const target = appendBotMessage(rig, '旧版 Worker');
      submitText(rig, target.id);
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('sent');
      const [, call] = rig.fetchCalls;
      expect(call!.init?.method).toBe('POST');
      expect(call!.init?.body).toBe(outboxRows(rig)[0]!.payload_json);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('backs off per Retry-After on 429 and retries until sent', async () => {
    const rig = makeRig();
    try {
      rig.setFetch(() => okResponse({ status: 'rate_limited' }, 429, { 'retry-after': '120' }));
      const target = appendBotMessage(rig, '限流退避');
      submitText(rig, target.id);
      await rig.reports.drain();
      let row = outboxRows(rig)[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).toBe(BASE + 120_000);
      expect(row.last_error).toBe('HTTP 429');

      // Retry-After 也可以是 JSON body 的 retryAfterMs。
      rig.db.prepare('update report_outbox set attempts = 0, next_attempt_at = ?').run(BASE);
      rig.setFetch(() => okResponse({ retryAfterMs: 90_000 }, 429));
      await rig.reports.drain();
      row = outboxRows(rig)[0]!;
      expect(row.next_attempt_at).toBe(BASE + 90_000);

      // 两者都没有 → 60s 兜底。
      rig.db.prepare('update report_outbox set attempts = 0, next_attempt_at = ?').run(BASE);
      rig.setFetch(() => new Response('rate limited', { status: 429 }));
      await rig.reports.drain();
      row = outboxRows(rig)[0]!;
      expect(row.next_attempt_at).toBe(BASE + 60_000);

      // 恢复后发送成功。
      rig.setNow(BASE + 120_000);
      rig.setFetch(() => okResponse({ status: 'accepted' }, 201));
      await rig.reports.drain();
      row = outboxRows(rig)[0]!;
      expect(row.status).toBe('sent');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('backs off exponentially on 5xx (60s × 2^n ±20% jitter) and fails on 4xx', async () => {
    const rig = makeRig();
    try {
      rig.setFetch(() => new Response('boom', { status: 500 }));
      const target = appendBotMessage(rig, '服务端错误');
      submitText(rig, target.id);
      await rig.reports.drain();
      let row = outboxRows(rig)[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      // 60s ±20%。
      expect(row.next_attempt_at).toBeGreaterThanOrEqual(BASE + 48_000);
      expect(row.next_attempt_at).toBeLessThanOrEqual(BASE + 72_000);

      // 第二次失败：120s ±20%。
      const t2 = row.next_attempt_at + 1;
      rig.setNow(t2);
      await rig.reports.drain();
      row = outboxRows(rig)[0]!;
      expect(row.attempts).toBe(2);
      expect(row.next_attempt_at).toBeGreaterThanOrEqual(t2 + 96_000);
      expect(row.next_attempt_at).toBeLessThanOrEqual(t2 + 144_000);

      // 408 / 425 同样走可重试退避；400 直接 failed。
      rig.db.prepare("update report_outbox set next_attempt_at = ?, attempts = 0").run(t2);
      rig.setFetch(() => new Response('bad request', { status: 400 }));
      await rig.reports.drain();
      row = outboxRows(rig)[0]!;
      expect(row.status).toBe('failed');
      expect(row.last_error).toBe('HTTP 400');
      expect(row.attempts).toBe(1);

      // 3xx（redirect:'error' 不跟随）→ failed。
      rig.db
        .prepare("update report_outbox set status = 'pending', attempts = 0, next_attempt_at = ?")
        .run(t2);
      rig.setFetch(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere' } }));
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('failed');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('keeps the row pending on network errors and fails after 20 attempts', async () => {
    const rig = makeRig();
    try {
      rig.setFetch(() => {
        throw new Error('ECONNREFUSED');
      });
      const target = appendBotMessage(rig, '网络错误');
      submitText(rig, target.id);
      await rig.reports.drain();
      let row = outboxRows(rig)[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('network');

      // 第 20 次失败 → failed，不再重试（§6.2 上限）。
      rig.db.prepare('update report_outbox set attempts = 19, next_attempt_at = ?').run(BASE);
      rig.setNow(BASE);
      await rig.reports.drain();
      row = outboxRows(rig)[0]!;
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(20);

      // 已达上限的 pending 行直接 failed，不再发请求。
      rig.db
        .prepare("update report_outbox set status = 'pending', attempts = 20, next_attempt_at = ?")
        .run(BASE);
      const callsBefore = rig.fetchCalls.length;
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('failed');
      expect(rig.fetchCalls.length).toBe(callsBefore);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('recovers rows stuck in sending on start() and resends them', async () => {
    const rig = makeRig();
    try {
      const target = appendBotMessage(rig, '崩溃恢复');
      submitText(rig, target.id);
      // 模拟发送中崩溃：行卡在 sending。
      rig.db.prepare("update report_outbox set status = 'sending'").run();
      rig.setFetch(() => okResponse({ status: 'accepted' }, 201));
      rig.reports.start();
      expect(outboxRows(rig)[0]!.status).toBe('pending');
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('sent');
      rig.reports.stop();
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('ReportService PoW（任务 5A：challenge → solve → proof → 重试一次）', () => {
  it('full flow: fetches the challenge, solves it, POSTs a proof and marks sent', async () => {
    const rig = makeRig();
    try {
      let token = '';
      let nonce = '';
      rig.setChallenge(() => {
        nonce = randomBytes(16).toString('hex');
        token = signChallengeToken({ n: nonce, exp: rig.getNow() + 600_000, d: 8 });
        return okResponse(
          {
            challenge: token,
            difficulty: 8,
            expiresAt: rig.getNow() + 600_000,
            algorithm: 'sha256',
          },
          200,
        );
      });
      rig.setFetch(() => okResponse({ status: 'accepted' }, 201));
      const target = appendBotMessage(rig, '带 proof 发送');
      submitText(rig, target.id);
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('sent');
      expect(rig.fetchCalls).toHaveLength(2);
      const [challengeCall, call] = rig.fetchCalls;
      expect(challengeCall!.url).toBe(CHALLENGE_URL);
      expect(challengeCall!.init?.method).toBe('GET');
      const body = JSON.parse(call!.init?.body as string) as {
        proof?: { challenge: string; solution: string };
        hashes?: { content: string; payload: string };
      };
      // proof 是顶层兄弟键；payload 契约字段原样保留（hashes 在入队时已算好）。
      expect(body.proof).toEqual({ challenge: token, solution: expect.any(String) });
      expect(typeof body.proof?.solution).toBe('string');
      // 求解规则（协议 v1）：sha256(n:solution) 前导零比特 ≥ 8，独立复算。
      const digest = createHash('sha256')
        .update(Buffer.from(`${nonce}:${body.proof!.solution}`, 'utf8'))
        .digest();
      expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(8);
      // proof / challenge / solution 永不进日志。
      // token 足够长可直接排除；solution 可能是短数字（difficulty=8 时常为个位数），
      // 不能对整段 JSON 做 substring 断言，否则会误伤 reportId。
      expect(JSON.stringify(rig.logs)).not.toContain(token);
      expect(rig.logs.length).toBeGreaterThan(0);
      for (const entry of rig.logs) {
        const obj = entry.obj as Record<string, unknown>;
        expect(Object.keys(obj).every((key) => ['reportId', 'status', 'code'].includes(key))).toBe(
          true,
        );
      }
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('retries exactly once with a fresh challenge on a PoW 400, then succeeds', async () => {
    const rig = makeRig();
    try {
      const tokens: string[] = [];
      rig.setChallenge(() => {
        const n = randomBytes(16).toString('hex');
        const token = signChallengeToken({ n, exp: rig.getNow() + 600_000, d: 8 });
        tokens.push(token);
        return challengeResponse(rig, { n, d: 8 });
      });
      let posts = 0;
      rig.setFetch(() => {
        posts += 1;
        return posts === 1
          ? okResponse({ error: 'missing_proof' }, 400)
          : okResponse({ status: 'accepted' }, 201);
      });
      const target = appendBotMessage(rig, '首次 400 重试');
      submitText(rig, target.id);
      await rig.reports.drain();
      const row = outboxRows(rig)[0]!;
      expect(row.status).toBe('sent');
      expect(row.last_error).toBeNull();
      expect(posts).toBe(2);
      expect(rig.fetchCalls).toHaveLength(4); // GET, POST(400), GET, POST(201)
      // 第二次 POST 携带的是新 challenge（同 reportId 同 payload）。
      const secondBody = JSON.parse(rig.fetchCalls[3]!.init?.body as string) as {
        proof: { challenge: string };
      };
      expect(secondBody.proof.challenge).toBe(tokens[1]);
      expect(tokens[0]).not.toBe(tokens[1]);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('marks failed after two PoW 400s (exactly one retry)', async () => {
    const rig = makeRig();
    try {
      rig.setChallenge(() => challengeResponse(rig, { d: 8 }));
      rig.setFetch(() => okResponse({ error: 'proof_invalid' }, 400));
      const target = appendBotMessage(rig, '两次 PoW 失败');
      submitText(rig, target.id);
      await rig.reports.drain();
      const row = outboxRows(rig)[0]!;
      expect(row.status).toBe('failed');
      expect(row.last_error).toBe('HTTP 400');
      // GET + POST + GET + POST：恰好重试一次，不再第三轮。
      expect(rig.fetchCalls).toHaveLength(4);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('does not retry a non-PoW 400', async () => {
    const rig = makeRig();
    try {
      rig.setFetch(() => okResponse({ error: 'hash_mismatch' }, 400));
      const target = appendBotMessage(rig, '普通 400');
      submitText(rig, target.id);
      await rig.reports.drain();
      expect(outboxRows(rig)[0]!.status).toBe('failed');
      expect(rig.fetchCalls).toHaveLength(2); // GET + POST，无重试
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('treats an unparseable challenge token as a network-style failure (stays pending)', async () => {
    const rig = makeRig();
    try {
      rig.setChallenge(() => okResponse({ challenge: 'garbage-token', difficulty: 8 }, 200));
      const target = appendBotMessage(rig, '坏 token');
      submitText(rig, target.id);
      await rig.reports.drain();
      const row = outboxRows(rig)[0]!;
      expect(row.status).toBe('pending');
      expect(row.last_error).toBe('network');
      expect(rig.fetchCalls).toHaveLength(1); // 只有 GET，没有 POST
    } finally {
      closeDatabase(rig.db);
    }
  });
});

describe('solveChallenge 求解器（任务 5A 协议 v1）', () => {
  it.each([4, 6, 8])('finds a solution meeting difficulty %d quickly', (difficulty) => {
    const nonce = randomBytes(16).toString('hex');
    const solution = solveChallenge(nonce, difficulty);
    // ASCII 解。
    expect(solution).toMatch(/^[\x20-\x7e]+$/);
    // 前导零比特规则（协议 v1）：sha256(utf8(n + ':' + solution)) ≥ difficulty。
    const digest = createHash('sha256')
      .update(Buffer.from(`${nonce}:${solution}`, 'utf8'))
      .digest();
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(difficulty);
    // 边界：减一比特的难度对同一解也成立（≥ 语义），但解不该比要求多出太多（首解）。
    expect(leadingZeroBits(digest)).toBeLessThan(difficulty + 8);
  });

  it('throws when maxIterations is exhausted (caller backs off like a network error)', () => {
    const nonce = randomBytes(16).toString('hex');
    expect(() => solveChallenge(nonce, 30, 1000)).toThrow(/unsolved/);
    expect(() => solveChallenge(nonce, -1)).toThrow(/bad difficulty/);
    expect(() => solveChallenge(nonce, 1.5)).toThrow(/bad difficulty/);
  });

  it('derives the challenge endpoint by swapping the trailing /v1/reports segment', () => {
    expect(challengeEndpointOf('https://reports.kepcup.com/v1/reports')).toBe(
      'https://reports.kepcup.com/v1/challenge',
    );
    expect(challengeEndpointOf('http://127.0.0.1:8787/v1/reports')).toBe(
      'http://127.0.0.1:8787/v1/challenge',
    );
    // 不在 v1/reports 结尾：同源 + /v1/challenge。
    expect(challengeEndpointOf('https://example.com/reports')).toBe(
      'https://example.com/v1/challenge',
    );
    expect(challengeEndpointOf('https://example.com')).toBe('https://example.com/v1/challenge');
    // 解析失败：字符串拼接兜底。
    expect(challengeEndpointOf('not-a-url')).toBe('not-a-url/v1/challenge');
  });
});

describe('ReportService 日志与隐私（§8）', () => {
  it('logs only reportId / status / error code — never body text or clientId', async () => {
    const rig = makeRig();
    try {
      const SECRET_TEXT = '绝密正文标记-SHOULD-NOT-LEAK';
      rig.setFetch(() => new Response('boom', { status: 500 }));
      const u1 = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '上下文也不许出现',
      });
      const target = appendBotMessage(rig, SECRET_TEXT, { replyTo: u1.id });
      submitText(rig, target.id, 'client-privacy-check');
      await rig.reports.drain();
      rig.setNow(BASE + 200_000);
      rig.setFetch(() => okResponse({}, 201));
      await rig.reports.drain();

      const serialized = JSON.stringify(rig.logs);
      expect(serialized).not.toContain(SECRET_TEXT);
      expect(serialized).not.toContain('client-privacy-check');
      expect(serialized).not.toContain('上下文也不许出现');
      expect(rig.logs.length).toBeGreaterThan(0);
      for (const entry of rig.logs) {
        const obj = entry.obj as Record<string, unknown>;
        expect(Object.keys(obj).every((key) => ['reportId', 'status', 'code'].includes(key))).toBe(
          true,
        );
      }
    } finally {
      closeDatabase(rig.db);
    }
  });
});

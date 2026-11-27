import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  APP_RPC_METHODS,
  MESSAGE_REACTION_EMOJIS,
  MESSAGE_REACTION_SCOPE_PATTERN,
  PLATFORM_RPC_METHODS,
  REPORT_ATTACHMENTS_MAX,
  REPORT_BOT_PROFILE_MAX_BYTES,
  REPORT_CONTENT_DEDUPE_MS,
  REPORT_CONTEXT_ITEM_MAX_BYTES,
  REPORT_CONTEXT_MAX_ITEMS,
  REPORT_MESSAGE_CONTENT_MAX_BYTES,
  REPORT_MESSAGE_TEXT_MAX_BYTES,
  REPORT_PAYLOAD_DEDUPE_MS,
  REPORT_PAYLOAD_MAX_BYTES,
  REPORT_REPLY_TO_TEXT_MAX_BYTES,
  REPORT_SCHEMA_VERSION,
  rpcMethodSchemas,
  reactionSummarySchema,
  reportPayloadSchema,
  reportsSubmitInputSchema,
  reportsSubmitOutputSchema,
  messagesReactInputSchema,
  messagesReactOutputSchema,
  messagesReactionsInputSchema,
  messagesReactionsOutputSchema,
} from '../../src/index.js';

/**
 * 测试专用 canonicalJson（todo/ai-content-reporting.md §5.4）：递归按 key 字典序
 * 排序、数组保序、JSON.stringify 风格。core 与 Worker 各有一份实现，两侧都以
 * fixtures/report-v1.json 的固定向量为锚点；本文件用同一算法校验 fixture 的
 * hashes，改 fixture 内容而不改 hash 即会在此失败。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** §5.1 完整示例 payload 的具体化（§10.1：core 与 Worker 的共同契约向量）。 */
interface FixtureMessage {
  kind: string;
  status: string;
  text: string;
  content: unknown;
}
interface Fixture {
  schemaVersion: number;
  reportId: string;
  message: FixtureMessage;
  hashes: { content: string; payload: string };
}
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/report-v1.json', import.meta.url)), 'utf8'),
) as Fixture;

/** 团队来源快照的最小合法形状（bot 走 partial，conversation / usage 等可省略）。 */
const teamSnapshot = {
  message: {
    id: 'msg_01JTEAM00000000000000000A',
    seq: 7,
    kind: 'card',
    status: 'normal',
    createdAt: 1764212300000,
    editedAt: null,
    runId: null,
    text: '',
    content: { text: '团队卡片内容', items: [] },
    truncated: false,
    attachments: [],
  },
  replyTo: null,
  context: [],
  bot: { name: '团队 Bot' },
};

describe('举报 RPC 注册（§6.5）', () => {
  it('三个方法都进入 APP_RPC_METHODS（port A，渲染层 → core）', () => {
    for (const name of ['reports.submit', 'messages.react', 'messages.reactions'] as const) {
      expect(APP_RPC_METHODS).toContain(name);
      const io = rpcMethodSchemas[name];
      expect(io.input).toBeDefined();
      expect(io.output).toBeDefined();
    }
    // APP_METHODS.length === APP_RPC_METHODS.length 的全局断言已由
    // team-contracts.test.ts 覆盖（定向命令同时跑两个文件），不重复。
  });

  it('不在平台方法（port B）面上', () => {
    for (const name of ['reports.submit', 'messages.react', 'messages.reactions']) {
      expect(PLATFORM_RPC_METHODS).not.toContain(name);
    }
  });
});

describe('reports.submit 往返', () => {
  const base = {
    clientId: 'client-9f21c7d4a55e',
    source: { kind: 'local' } as const,
    messageId: 'msg_01JDEMOMESSAGE000000000000A',
    conversationId: 'conv_01JDEMOCONVERSATION00000A',
    surface: 'desktop',
  };

  it('local 来源（无 snapshot）parse 通过', () => {
    const parsed = reportsSubmitInputSchema.parse(base);
    expect(parsed.source).toEqual({ kind: 'local' });
    expect(reportsSubmitOutputSchema.parse({ status: 'queued' }).status).toBe('queued');
    expect(reportsSubmitOutputSchema.parse({ status: 'duplicate', reason: 'payload' }).reason).toBe(
      'payload',
    );
  });

  it('team 来源必须带 serverHash，snapshot 的 bot 可为 partial、conversation.type 可选', () => {
    const parsed = reportsSubmitInputSchema.parse({
      ...base,
      source: { kind: 'team', serverHash: 'a'.repeat(16) },
      snapshot: teamSnapshot,
    });
    expect(parsed.source).toEqual({ kind: 'team', serverHash: 'a'.repeat(16) });
    expect(parsed.snapshot?.bot).toEqual({ name: '团队 Bot' });
    // conversation.type 可选：带上时必须是会话类型枚举内的值（core 缺省回退）。
    const withType = reportsSubmitInputSchema.parse({
      ...base,
      source: { kind: 'team', serverHash: 'a'.repeat(16) },
      snapshot: { ...teamSnapshot, conversation: { type: 'dm' } },
    });
    expect(withType.snapshot?.conversation).toEqual({ type: 'dm' });
    expect(
      reportsSubmitInputSchema.safeParse({
        ...base,
        source: { kind: 'team', serverHash: 'a'.repeat(16) },
        snapshot: { ...teamSnapshot, conversation: { type: 'group' } },
      }).success,
    ).toBe(false);
  });

  it('缺字段拒绝', () => {
    expect(
      reportsSubmitInputSchema.safeParse({ ...base, clientId: undefined }).success,
    ).toBe(false);
    expect(reportsSubmitInputSchema.safeParse({ ...base, messageId: undefined }).success).toBe(
      false,
    );
    expect(reportsSubmitInputSchema.safeParse({ ...base, conversationId: '' }).success).toBe(false);
  });

  it('clientId 超过 128 / source 形状非法拒绝', () => {
    expect(
      reportsSubmitInputSchema.safeParse({ ...base, clientId: 'x'.repeat(129) }).success,
    ).toBe(false);
    expect(
      reportsSubmitInputSchema.safeParse({
        ...base,
        source: { kind: 'web', url: 'https://x.example' },
      }).success,
    ).toBe(false);
    expect(
      reportsSubmitInputSchema.safeParse({ ...base, source: { kind: 'team', serverHash: '' } })
        .success,
    ).toBe(false);
    // surface 上限与 Worker 的 client.surface（32 字符）一致。
    expect(reportsSubmitInputSchema.safeParse({ ...base, surface: 'x'.repeat(33) }).success).toBe(
      false,
    );
    expect(reportsSubmitInputSchema.parse({ ...base, surface: 'desktop' }).surface).toBe('desktop');
  });

  it('输出 status 只在三种之间', () => {
    expect(reportsSubmitOutputSchema.safeParse({ status: 'sent' }).success).toBe(false);
    expect(reportsSubmitOutputSchema.safeParse({ status: 'rejected' }).success).toBe(true);
  });
});

describe('messages.react / messages.reactions 往返', () => {
  const base = {
    scope: 'local',
    conversationId: 'conv_01JDEMOCONVERSATION00000A',
    messageId: 'msg_01JDEMOMESSAGE000000000000A',
    clientId: 'client-9f21c7d4a55e',
  };

  it('白名单内的 emoji 全部可点，null = 取消', () => {
    for (const emoji of MESSAGE_REACTION_EMOJIS) {
      expect(messagesReactInputSchema.parse({ ...base, emoji }).emoji).toBe(emoji);
    }
    expect(messagesReactInputSchema.parse({ ...base, emoji: null }).emoji).toBeNull();
    expect(messagesReactOutputSchema.parse({ reactions: [] }).reactions).toEqual([]);
  });

  it('emoji 不在集合 / scope 格式错 / 缺字段拒绝', () => {
    expect(messagesReactInputSchema.safeParse({ ...base, emoji: '🚀' }).success).toBe(false);
    expect(messagesReactInputSchema.safeParse({ ...base, emoji: 'thumb' }).success).toBe(false);
    expect(messagesReactInputSchema.safeParse({ ...base, emoji: undefined }).success).toBe(false);
    for (const scope of ['global', 'team:', 'team:XYZ', 'team:a', 'local:1', '']) {
      expect(messagesReactInputSchema.safeParse({ ...base, scope }).success).toBe(false);
      expect(
        messagesReactionsInputSchema.safeParse({
          scope,
          conversationId: base.conversationId,
          clientId: base.clientId,
        }).success,
      ).toBe(false);
    }
    // team:<serverHash>（sha256 前 16 位小写 hex）合法。
    const teamScope = `team:${'a'.repeat(16)}`;
    expect(MESSAGE_REACTION_SCOPE_PATTERN.test(teamScope)).toBe(true);
    expect(
      messagesReactInputSchema.parse({ ...base, emoji: '👍', scope: teamScope }).scope,
    ).toBe(teamScope);
    expect(messagesReactInputSchema.safeParse({ ...base, messageId: undefined }).success).toBe(
      false,
    );
  });

  it('聚合输出形状：messageId / emoji / count / mine', () => {
    const out = messagesReactionsOutputSchema.parse({
      reactions: [{ messageId: 'msg_1', emoji: '👍', count: 2, mine: true }],
    });
    expect(out.reactions[0]).toEqual({ messageId: 'msg_1', emoji: '👍', count: 2, mine: true });
    expect(
      reactionSummarySchema.safeParse({ messageId: 'msg_1', emoji: '👍', count: 1 }).success,
    ).toBe(false);
  });
});

describe('常量（§5.3 / §5.5 / §5.6）', () => {
  it('去重窗口：内容 24h、payload 90d', () => {
    expect(REPORT_CONTENT_DEDUPE_MS).toBe(86_400_000);
    expect(REPORT_PAYLOAD_DEDUPE_MS).toBe(7_776_000_000);
  });

  it('内容上限与 §5.3 一致', () => {
    expect(REPORT_MESSAGE_TEXT_MAX_BYTES).toBe(32 * 1024);
    expect(REPORT_MESSAGE_CONTENT_MAX_BYTES).toBe(16 * 1024);
    expect(REPORT_REPLY_TO_TEXT_MAX_BYTES).toBe(2 * 1024);
    expect(REPORT_CONTEXT_ITEM_MAX_BYTES).toBe(2 * 1024);
    expect(REPORT_CONTEXT_MAX_ITEMS).toBe(4);
    expect(REPORT_BOT_PROFILE_MAX_BYTES).toBe(8 * 1024);
    expect(REPORT_ATTACHMENTS_MAX).toBe(20);
    expect(REPORT_PAYLOAD_MAX_BYTES).toBe(128 * 1024);
  });

  it('reaction 集合与 §5.6 原样一致（12 个，顺序固定）', () => {
    expect(MESSAGE_REACTION_EMOJIS).toEqual([
      '👍',
      '👎',
      '❤️',
      '😂',
      '🎉',
      '🙏',
      '🔥',
      '👏',
      '😮',
      '😢',
      '🤔',
      '✅',
    ]);
  });
});

describe('reportPayloadSchema 与 fixture（§5.1 / §5.4）', () => {
  it('fixture parse 通过，schemaVersion 与常量一致', () => {
    const parsed = reportPayloadSchema.parse(fixture);
    expect(parsed.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(parsed.reportId).toMatch(/^rep_/);
    expect(parsed.reason).toBe('inappropriate');
    expect(parsed.message.kind).toBe('text');
  });

  it('content hash：text 消息对 message.text 原文取 sha256（utf8，小写 hex）', () => {
    const contentSource =
      fixture.message.kind === 'text'
        ? fixture.message.text
        : canonicalJson(fixture.message.content ?? { text: fixture.message.text });
    expect(sha256Hex(contentSource)).toBe(fixture.hashes.content);
  });

  it('payload hash：dedupePayload（去掉 reportId/createdAt/hashes）的 canonicalJson 取 sha256', () => {
    const body = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
    delete body.reportId;
    delete body.createdAt;
    delete body.hashes;
    expect(sha256Hex(canonicalJson(body))).toBe(fixture.hashes.payload);
  });

  it('hash 形状非法 / reason 非法 / reportId 无 rep_ 前缀 / schemaVersion 非法拒绝', () => {
    const bad = (patch: Record<string, unknown>) =>
      reportPayloadSchema.safeParse({ ...fixture, ...patch }).success;
    expect(bad({ hashes: { content: 'A'.repeat(64), payload: 'a'.repeat(64) } })).toBe(false);
    expect(bad({ hashes: { content: 'a'.repeat(63), payload: 'a'.repeat(64) } })).toBe(false);
    expect(bad({ hashes: { content: 'a'.repeat(64) } })).toBe(false);
    expect(bad({ reportId: 'msg_01JEXAMPLE0000000000000000' })).toBe(false);
    expect(bad({ reason: 'spam' })).toBe(false);
    expect(bad({ schemaVersion: 2 })).toBe(false);
    expect(bad({ schemaVersion: '1' })).toBe(false);
  });

  it('消息状态枚举与 shared Message schema 同一口径', () => {
    expect(
      reportPayloadSchema.safeParse({
        ...fixture,
        message: { ...fixture.message, status: 'edited' },
      }).success,
    ).toBe(true);
    expect(
      reportPayloadSchema.safeParse({
        ...fixture,
        message: { ...fixture.message, status: 'archived' },
      }).success,
    ).toBe(false);
  });
});

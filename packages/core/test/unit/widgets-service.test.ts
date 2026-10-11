import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BOT_WIDGET_CARD_TYPE, type Message, type WidgetCard } from '@kepcup/shared';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { WidgetService } from '../../src/widgets/service.js';
import { WidgetResourceStore, widgetUiHostFor } from '../../src/widgets/resource-store.js';

/**
 * Bot 自制交互组件（D81，docs/design/32-bot-widgets.md）：落库发卡、版本只增、
 * 每 run 卡数上限、审查与资源登记（host 校验 / TTL）、删除级联。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'widgets-service-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_000;
const clock = { now: () => now };

function openDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

interface Harness {
  db: SqliteDatabase;
  service: WidgetService;
  cards: Message[];
  getById(messageId: string): Message | null;
}

function makeHarness(ttlMs?: number, options?: { appendThrows?: boolean }): Harness {
  const db = openDb();
  const cards: Message[] = [];
  const byId = new Map<string, Message>();
  const service = new WidgetService(
    {
      db,
      messages: {
        append: (input) => {
          if (options?.appendThrows === true) throw new Error('messages append unavailable');
          const message: Message = {
            id: `msg_${cards.length + 1}`,
            conversationId: input.conversationId,
            seq: cards.length + 1,
            senderType: 'system',
            senderBotId: null,
            kind: 'card',
            content: {
              cardType: input.cardType,
              approvalId: '',
              widget: input.cardWidget,
            },
            replyTo: null,
            mentions: [],
            batchId: null,
            runId: input.runId ?? null,
            status: 'normal',
            editedAt: null,
            createdAt: clock.now(),
            attachments: [],
            ownerBotId: null,
            taskId: null,
          };
          cards.push(message);
          byId.set(message.id, message);
          return message;
        },
        getById: (id) => byId.get(id) ?? null,
      },
      publishMessage: () => undefined,
      secrets: { redact: (text) => text },
      clock,
      logger: { warn: () => undefined },
    },
    new WidgetResourceStore({ clock, ttlMs }),
  );
  return { db, service, cards, getById: (id) => byId.get(id) ?? null };
}

function seed(db: SqliteDatabase): { botId: string; conversationId: string } {
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_a', 'A', '{}', 'active', 1, 1)",
  ).run();
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_b', 'B', '{}', 'active', 1, 1)",
  ).run();
  db.prepare("insert into conversations (id, type, created_at) values ('conv_1', 'direct', 1)").run();
  db.prepare("insert into conversations (id, type, created_at) values ('conv_2', 'direct', 1)").run();
  return { botId: 'bot_a', conversationId: 'conv_1' };
}

const HTML = '<!DOCTYPE html><html><body><button id="b">1</button></body></html>';

function cardOfLast(cards: Message[]): WidgetCard {
  const content = cards[cards.length - 1]!.content as { cardType: string; widget: WidgetCard };
  expect(content.cardType).toBe(BOT_WIDGET_CARD_TYPE);
  return content.widget;
}

let h: Harness;
beforeEach(() => {
  now = 1_000;
  h = makeHarness();
  seed(h.db);
});

describe('WidgetService create/update', () => {
  it('create：落库 v1 并发描述符卡片（conversation 作用域存会话，bot 作用域存 NULL）', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '计算器',
      description: '四则运算',
      html: HTML,
      scope: 'conversation',
      runId: 'run_1',
    });
    expect(created).toMatchObject({ ok: true, version: 1 });
    if (!created.ok) return;
    const row = h.db.prepare('select * from widgets where id = ?').get(created.widgetId) as {
      conversation_id: string | null;
      scope: string;
      latest_version: number;
    };
    expect(row).toMatchObject({ conversation_id: 'conv_1', scope: 'conversation', latest_version: 1 });
    expect(h.cards).toHaveLength(1);
    expect(cardOfLast(h.cards)).toMatchObject({
      widgetId: created.widgetId,
      version: 1,
      title: '计算器',
      scope: 'conversation',
      sizeBytes: Buffer.byteLength(HTML),
    });

    const botScoped = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '资产',
      description: '',
      html: HTML,
      scope: 'bot',
      runId: 'run_2',
    });
    expect(botScoped.ok).toBe(true);
    if (!botScoped.ok) return;
    const row2 = h.db.prepare('select conversation_id from widgets where id = ?').get(botScoped.widgetId) as {
      conversation_id: string | null;
    };
    expect(row2.conversation_id).toBeNull();
  });

  it('校验：空标题 / 空 html / 超限标题 / 超大 html 拒绝', () => {
    const base = { botId: 'bot_a', conversationId: 'conv_1', scope: 'conversation' as const, runId: 'r' };
    expect(h.service.create({ ...base, title: '', description: '', html: HTML }).ok).toBe(false);
    expect(h.service.create({ ...base, title: 't', description: '', html: '   ' }).ok).toBe(false);
    expect(
      h.service.create({ ...base, title: '長'.repeat(121), description: '', html: HTML }).ok,
    ).toBe(false);
    expect(
      h.service.create({ ...base, title: 't', description: '', html: 'x'.repeat(2 * 1024 * 1024 + 1) })
        .ok,
    ).toBe(false);
    expect(h.cards).toHaveLength(0);
  });

  it('update：版本只增不改，旧版本保留；别人的组件不能改', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '计算器',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'run_1',
    });
    if (!created.ok) throw new Error('create failed');
    const updated = h.service.update({
      botId: 'bot_a',
      widgetId: created.widgetId,
      html: HTML.replace('>1<', '>2<'),
      changeNote: '修按钮',
      runId: 'run_2',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.version).toBe(2);
    const versions = h.db
      .prepare('select version, html from widget_versions where widget_id = ? order by version')
      .all(created.widgetId) as Array<{ version: number; html: string }>;
    expect(versions).toHaveLength(2);
    expect(versions[0]!.html).toBe(HTML);
    expect(versions[1]!.html).toContain('>2<');
    expect(h.cards).toHaveLength(2);
    expect(cardOfLast(h.cards)).toMatchObject({ version: 2, description: '修按钮' });

    expect(
      h.service
        .update({ botId: 'bot_b', widgetId: created.widgetId, html: HTML, changeNote: '', runId: 'r3' })
        .ok,
    ).toBe(false);
    expect(
      h.service.update({ botId: 'bot_a', widgetId: 'wgt_missing', html: HTML, changeNote: '', runId: 'r4' })
        .ok,
    ).toBe(false);
  });

  it('每个 run 最多发 8 张组件卡', () => {
    const base = { botId: 'bot_a', conversationId: 'conv_1', scope: 'conversation' as const };
    for (let i = 0; i < 8; i += 1) {
      expect(h.service.create({ ...base, title: `t${i}`, description: '', html: HTML, runId: 'run_x' }).ok)
        .toBe(true);
    }
    const ninth = h.service.create({ ...base, title: 't9', description: '', html: HTML, runId: 'run_x' });
    expect(ninth.ok).toBe(false);
    expect(h.cards).toHaveLength(8);
  });
});

describe('WidgetService 审查与资源', () => {
  it('source / open / resource：审查取原文、登记资源、host 校验、禁网 CSP', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '计算器',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'run_1',
    });
    if (!created.ok) throw new Error('create failed');
    const card = cardOfLast(h.cards);
    const messageId = h.cards[h.cards.length - 1]!.id;

    const source = h.service.source(messageId);
    expect(source).toMatchObject({ widgetId: card.widgetId, version: 1, html: HTML });

    const opened = h.service.open({ messageId });
    expect(opened.url).toBe(`kepcup-app://${widgetUiHostFor(card.widgetId)}/${opened.resourceId}`);

    const page = h.service.resource({ resourceId: opened.resourceId, host: widgetUiHostFor(card.widgetId) });
    expect(page.html).toBe(HTML);
    expect(page.csp).toContain("connect-src 'none'");
    expect(page.csp).toContain('sandbox allow-scripts');

    expect(() =>
      h.service.resource({ resourceId: opened.resourceId, host: 'widget-aaaaaaaaaaaaaaaaaaaaaaaa' }),
    ).toThrow(/NOT_FOUND|不存在/);

    h.service.close(opened.resourceId);
    expect(() => h.service.resource({ resourceId: opened.resourceId, host: widgetUiHostFor(card.widgetId) })).toThrow();

    // bot 级组件的卡片同样可 open（HTML 从库里来，与会话无关）。
    const botScoped = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '资产',
      description: '',
      html: HTML,
      scope: 'bot',
      runId: 'run_2',
    });
    if (!botScoped.ok) throw new Error('create failed');
    const botMessageId = h.cards[h.cards.length - 1]!.id;
    expect(h.service.open({ messageId: botMessageId }).scope).toBe('bot');
    expect(card.widgetId).toBe(created.widgetId);
  });

  it('非组件消息 / 未知卡片：cardOf 抛 NOT_FOUND', () => {
    expect(() => h.service.source('msg_missing')).toThrow();
  });

  it('资源过期后不可取（TTL）', () => {
    const h2 = makeHarness(50);
    seed(h2.db);
    const created = h2.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    if (!created.ok) throw new Error('create failed');
    const messageId = h2.cards[0]!.id;
    const opened = h2.service.open({ messageId });
    const host = widgetUiHostFor(created.widgetId);
    expect(h2.service.resource({ resourceId: opened.resourceId, host })).toEqual({
      html: HTML,
      csp: expect.any(String),
    });
    now += 100;
    expect(() => h2.service.resource({ resourceId: opened.resourceId, host })).toThrow();
  });

  it('open：卡片 sha256 与版本行不一致 → WIDGET_INVALID（钉版本的完整性校验）', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    if (!created.ok) throw new Error('create failed');
    const messageId = h.cards[0]!.id;
    // 模拟库行被外力改动：版本行的 sha256 与卡片描述符不再一致。
    h.db
      .prepare('update widget_versions set sha256 = ? where widget_id = ?')
      .run('deadbeef', created.widgetId);
    expect(() => h.service.open({ messageId })).toThrow(/WIDGET_INVALID|不一致/);
    // source 同样拒绝（审查者看到的不可能还是这个版本的内容）。
    expect(() => h.service.source(messageId)).toThrow(/WIDGET_INVALID|不一致|已不存在/);
  });
});

describe('WidgetService 发卡失败与资源上限', () => {
  it('发卡失败：组件仍落库（ok:true、无 cardMessageId），不发卡不抛错', () => {
    const h3 = makeHarness(undefined, { appendThrows: true });
    seed(h3.db);
    const created = h3.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r1',
    });
    expect(created).toMatchObject({ ok: true, version: 1 });
    if (!created.ok) return;
    expect(created.cardMessageId).toBeUndefined();
    expect(h3.cards).toHaveLength(0);
    expect(
      h3.db.prepare('select count(*) as n from widgets').get() as { n: number },
    ).toEqual({ n: 1 });
  });

  it('create：botId 不存在（FK 失败）→ ok:false 且不抛出', () => {
    const result = h.service.create({
      botId: 'bot_missing',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    expect(result.ok).toBe(false);
  });

  it('WidgetResourceStore：超过上限淘汰最旧（不存在 → undefined）', () => {
    const store = new WidgetResourceStore({ clock, ttlMs: 60_000, max: 2 });
    const base = {
      version: 1,
      messageId: 'm',
      conversationId: 'c',
      botId: null,
      html: HTML,
      csp: 'csp',
    };
    store.put({ ...base, widgetId: 'wgt_1' });
    store.put({ ...base, widgetId: 'wgt_2' });
    const third = store.put({ ...base, widgetId: 'wgt_3' });
    expect(store.size).toBe(2);
    expect(store.get(third.id)).toBeDefined();
  });
});

describe('WidgetService 删除级联', () => {
  it('删除会话 FK 级联清 conversation 作用域组件；deleteForBot 清该 Bot 全部', () => {
    const conv = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '会话组件',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r1',
    });
    const botLevel = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '资产组件',
      description: '',
      html: HTML,
      scope: 'bot',
      runId: 'r2',
    });
    if (!conv.ok || !botLevel.ok) throw new Error('create failed');

    // 会话删除：conversations 行物理删除，FK 级联只清 conversation 作用域的组件。
    h.db.prepare('delete from conversations where id = ?').run('conv_1');
    expect(h.db.prepare('select count(*) as n from widgets').get() as { n: number }).toEqual({ n: 1 });
    expect((h.db.prepare('select id from widgets').get() as { id: string }).id).toBe(
      botLevel.widgetId,
    );

    // Bot 删除：bots 行改占位、FK 不触发——lifecycle 走 deleteForBot 显式清理。
    expect(h.service.deleteForBot('bot_a')).toBe(1);
    expect(h.db.prepare('select count(*) as n from widgets').get() as { n: number }).toEqual({ n: 0 });
    expect(h.db.prepare('select count(*) as n from widget_versions').get() as { n: number }).toEqual({
      n: 0,
    });
    expect(h.db.prepare('select count(*) as n from widget_docs').get() as { n: number }).toEqual({
      n: 0,
    });
  });
});

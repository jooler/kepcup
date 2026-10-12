import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOT_WIDGET_BOT_BYTES_QUOTA,
  BOT_WIDGET_CALLS_BURST,
  BOT_WIDGET_CARD_TYPE,
  BOT_WIDGET_PER_BOT_MAX,
  BOT_WIDGET_QUERY_RESULT_MAX_BYTES,
  BOT_WIDGET_QUERY_ROWS_MAX,
  BOT_WIDGET_VERSIONS_KEPT,
  type Message,
  type WidgetCard,
  type WidgetScope,
} from '@kepcup/shared';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { WidgetService } from '../../src/widgets/service.js';
import { WidgetQueryRunner } from '../../src/widgets/query-runner.js';
import { WidgetResourceStore, widgetUiHostFor } from '../../src/widgets/resource-store.js';
import { WIDGET_SDK_SHIM, injectWidgetSdk } from '../../src/widgets/sdk-injection.js';

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
/** storage 的每个 op 都计入限速（1 秒滚动窗口、每资源 5 次）：无关用例在调用间推进一个窗口避开它。 */
const RATE_TICK_MS = 1100;
const advance = (ms: number): void => {
  now += ms;
};

const DB_KEY = deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb);

function openDb(): { db: SqliteDatabase; file: string } {
  const file = path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = openDatabase({ path: file, key: DB_KEY });
  runMigrations(db, migrationsUrl('main'));
  return { db, file };
}

/** 每个 harness 的查询子进程（用例结束统一杀掉）。 */
const services: WidgetService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

interface Harness {
  db: SqliteDatabase;
  service: WidgetService;
  cards: Message[];
  getById(messageId: string): Message | null;
  /** shell.openExternal 收到的外链（openLink 用例断言用）。 */
  links: string[];
  /** 发卡失败开关（messages.append 抛错），用例中途可切换。 */
  appendFail: { on: boolean };
}

function makeHarness(ttlMs?: number, options?: { appendThrows?: boolean; queryTimeoutMs?: number }): Harness {
  const { db, file } = openDb();
  const cards: Message[] = [];
  const byId = new Map<string, Message>();
  const links: string[] = [];
  const appendFail = { on: options?.appendThrows === true };
  const service = new WidgetService(
    {
      db,
      messages: {
        append: (input) => {
          if (appendFail.on) throw new Error('messages append unavailable');
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
      shell: {
        openExternal: async (input: { url: string }) => {
          links.push(input.url);
          return { ok: true };
        },
      },
      queryRunner: new WidgetQueryRunner({
        database: { path: file, key: DB_KEY },
        ...(options?.queryTimeoutMs !== undefined ? { timeoutMs: options.queryTimeoutMs } : {}),
      }),
      clock,
      logger: { warn: () => undefined },
    },
    new WidgetResourceStore({ clock, ttlMs }),
  );
  services.push(service);
  return { db, service, cards, getById: (id) => byId.get(id) ?? null, links, appendFail };
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

/** 建一个组件并 open 出 resourceId（storage / openLink 用例的公共前置）。 */
function createAndOpen(
  service: WidgetService,
  cards: Message[],
  html: string = HTML,
): { widgetId: string; resourceId: string } {
  const created = service.create({
    botId: 'bot_a',
    conversationId: 'conv_1',
    title: 't',
    description: '',
    html,
    scope: 'conversation',
    runId: 'r',
  });
  if (!created.ok) throw new Error('create failed');
  const messageId = cards[cards.length - 1]!.id;
  const opened = service.open({ messageId });
  return { widgetId: created.widgetId, resourceId: opened.resourceId };
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
    // P1：登记的是「原文 + 前置 SDK 垫片」的版本；原文本体仍在（doctype 不被顶走）。
    expect(page.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(page.html).toContain('<button id="b">1</button>');
    expect(page.html).toContain("source: 'kepcup-widget'");
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
    const page = h2.service.resource({ resourceId: opened.resourceId, host });
    // P1：登记的是垫片版 HTML（P0 时为原文）；审查态 source 看到的仍是原文。
    expect(page.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(page.html).toContain("source: 'kepcup-widget'");
    expect(page.html).toContain('<button id="b">1</button>');
    expect(page.csp).toEqual(expect.any(String));
    advance(100);
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
  it('发卡失败：组件仍落库（ok:true、cardMessageId=null），不发卡不抛错', () => {
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
    expect(created.cardMessageId).toBeNull();
    expect(h3.cards).toHaveLength(0);
    expect(
      h3.db.prepare('select count(*) as n from widgets').get() as { n: number },
    ).toEqual({ n: 1 });
  });

  it('cardMessageId：create / update / publish 发卡成功都带上卡片消息 id，发卡失败都为 null', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'bot',
      runId: 'r1',
    });
    if (!created.ok) throw new Error('create failed');
    expect(created.cardMessageId).toBe(h.cards[h.cards.length - 1]!.id);
    const updated = h.service.update({
      botId: 'bot_a',
      widgetId: created.widgetId,
      html: HTML,
      changeNote: '',
      conversationId: 'conv_1',
      runId: 'r2',
    });
    if (!updated.ok) throw new Error('update failed');
    // 回归：update 曾丢弃 #emitCard 的返回值，成功更新被工具层当成「发卡失败」。
    expect(updated.cardMessageId).toBe(h.cards[h.cards.length - 1]!.id);
    const published = h.service.publish({ botId: 'bot_a', widgetId: created.widgetId, conversationId: 'conv_2', runId: 'r3' });
    if (!published.ok) throw new Error('publish failed');
    expect(published.cardMessageId).toBe(h.cards[h.cards.length - 1]!.id);

    h.appendFail.on = true;
    const updateFailed = h.service.update({
      botId: 'bot_a',
      widgetId: created.widgetId,
      html: HTML,
      changeNote: '',
      conversationId: 'conv_1',
      runId: 'r4',
    });
    expect(updateFailed).toMatchObject({ ok: true, version: 3, cardMessageId: null });
    expect(
      h.service.publish({ botId: 'bot_a', widgetId: created.widgetId, conversationId: 'conv_2', runId: 'r5' }),
    ).toMatchObject({ ok: true, cardMessageId: null });
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

  it('WidgetResourceStore：超过上限淘汰最久未用的（正在交互的卡不被新开的卡挤掉）', () => {
    const store = new WidgetResourceStore({ clock, ttlMs: 60_000, max: 2 });
    const base = {
      version: 1,
      messageId: 'm',
      conversationId: 'c',
      botId: null,
      html: HTML,
      csp: 'csp',
    };
    const first = store.put({ ...base, widgetId: 'wgt_1' });
    const second = store.put({ ...base, widgetId: 'wgt_2' });
    // 第一张卡最近有桥调用（get 续期并挪到队尾）：再开第三张时淘汰的是第二张。
    expect(store.get(first.id)).toBeDefined();
    const third = store.put({ ...base, widgetId: 'wgt_3' });
    expect(store.size).toBe(2);
    expect(store.get(first.id)).toBeDefined();
    expect(store.get(second.id)).toBeUndefined();
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

describe('WidgetService 能力桥：storage KV（P1）', () => {
  it('set/get/list/delete 往返；两个组件命名空间互不可见；重开后数据仍在', () => {
    const a = createAndOpen(h.service, h.cards);
    const b = createAndOpen(h.service, h.cards);
    // 限速按资源滚动窗口计（每秒 5 次）：用例内多次调用之间推进时钟避开。
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'get', resourceId: a.resourceId, key: 'count' })).toEqual({
      op: 'get',
      found: false,
    });
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'set', resourceId: a.resourceId, key: 'count', value: { n: 42 } })).toEqual({ op: 'set' });
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'get', resourceId: a.resourceId, key: 'count' })).toEqual({
      op: 'get',
      found: true,
      value: { n: 42 },
    });
    // 命名空间隔离：B 读不到 A 的键。
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'get', resourceId: b.resourceId, key: 'count' })).toEqual({
      op: 'get',
      found: false,
    });
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'list', resourceId: b.resourceId })).toEqual({
      op: 'list',
      keys: [],
    });

    advance(RATE_TICK_MS);
    h.service.storage({ op: 'set', resourceId: a.resourceId, key: 'note', value: '第二' });
    advance(RATE_TICK_MS);
    h.service.storage({ op: 'set', resourceId: a.resourceId, key: 'alpha', value: 1 });
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'list', resourceId: a.resourceId })).toEqual({
      op: 'list',
      keys: ['alpha', 'count', 'note'],
    });

    advance(RATE_TICK_MS);
    h.service.storage({ op: 'delete', resourceId: a.resourceId, key: 'note' });
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'get', resourceId: a.resourceId, key: 'note' }).found).toBe(false);
    // 删除不存在的键是幂等的。
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'delete', resourceId: a.resourceId, key: 'nope' }).op).toBe('delete');

    // 资源过期重开（新 resourceId）后数据仍在——数据在 widget_docs，不在内存资源里。
    h.service.close(a.resourceId);
    const reopened = h.service.open({ messageId: h.cards[h.cards.length - 2]!.id });
    expect(h.service.storage({ op: 'get', resourceId: reopened.resourceId, key: 'count' })).toEqual({
      op: 'get',
      found: true,
      value: { n: 42 },
    });
  });

  it('set 拒绝 undefined 与不可序列化值（INVALID_INPUT）', () => {
    const { resourceId } = createAndOpen(h.service, h.cards);
    advance(RATE_TICK_MS);
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'k', value: undefined })).toThrow(
      /INVALID_INPUT|undefined/,
    );
    advance(RATE_TICK_MS);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'k', value: cyclic })).toThrow(
      /INVALID_INPUT|JSON/,
    );
    // null / 0 / 空串等 falsy 值是合法 JSON，可以存。
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'set', resourceId, key: 'zero', value: 0 }).op).toBe('set');
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'get', resourceId, key: 'zero' })).toEqual({
      op: 'get',
      found: true,
      value: 0,
    });
  });

  it('库行 value_json 损坏（外力改动）时 get 按不存在返回，不抛裸异常', () => {
    const { resourceId } = createAndOpen(h.service, h.cards);
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'set', resourceId, key: 'k', value: { a: 1 } }).op).toBe('set');
    h.db.prepare("update widget_docs set value_json = 'not-json{' where key = 'k'").run();
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'get', resourceId, key: 'k' })).toEqual({
      op: 'get',
      found: false,
    });
    // 坏值可被覆盖修复。
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'set', resourceId, key: 'k', value: 2 }).op).toBe('set');
    advance(RATE_TICK_MS);
    expect(h.service.storage({ op: 'get', resourceId, key: 'k' })).toEqual({
      op: 'get',
      found: true,
      value: 2,
    });
  });

  it('配额：单值 / 总字节 / 键数超限 → WIDGET_STORAGE_QUOTA；覆盖旧键不受键数限制', () => {
    const h2 = makeHarness();
    seed(h2.db);
    const { resourceId } = createAndOpen(h2.service, h2.cards);
    // 每次调用前推进时钟，让限速窗口永不命中（本用例只测配额）。
    const set = (key: string, value: unknown): { op: string } => {
      advance(RATE_TICK_MS);
      return h2.service.storage({ op: 'set', resourceId, key, value });
    };

    // 单值上限（256KB 序列化字节，引号也算）。
    advance(RATE_TICK_MS);
    expect(() =>
      h2.service.storage({ op: 'set', resourceId, key: 'big', value: 'x'.repeat(256 * 1024) }),
    ).toThrow(/过大/);

    // 总配额：4 × 220KB 可写，第 5 块触顶。
    const chunk = 'y'.repeat(220_000);
    for (let i = 0; i < 4; i += 1) expect(set(`k${i}`, chunk).op).toBe('set');
    advance(RATE_TICK_MS);
    expect(() => h2.service.storage({ op: 'set', resourceId, key: 'k4', value: chunk })).toThrow(
      /存储空间已用完/,
    );
    // 覆盖已有键：释放旧值体积后可以继续写。
    expect(set('k0', 'small').op).toBe('set');

    // 键数上限：清掉大键后恰好补到 1000 键，新键被拒。
    for (const key of ['k1', 'k2', 'k3']) {
      advance(RATE_TICK_MS);
      h2.service.storage({ op: 'delete', resourceId, key });
    }
    for (let i = 1; i < 1000; i += 1) expect(set(`key-${i}`, 1).op).toBe('set');
    expect(() => set('one-too-many', 1)).toThrow(/键数量/);
    // 满键数时覆盖旧键仍允许。
    expect(set('key-5', 2).op).toBe('set');
  });

  it('限速：令牌桶——突发 20 次放行、之后超限 WIDGET_RATE_LIMITED；按每秒 5 个回填；按资源独立', () => {
    const { resourceId } = createAndOpen(h.service, h.cards);
    for (let i = 0; i < BOT_WIDGET_CALLS_BURST; i += 1) {
      expect(h.service.storage({ op: 'set', resourceId, key: `k${i}`, value: i }).op).toBe('set');
    }
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'more', value: 1 })).toThrow(
      /WIDGET_RATE_LIMITED|频繁/,
    );
    // 另一个资源不受影响（限速按资源计）。
    const other = createAndOpen(h.service, h.cards);
    expect(h.service.storage({ op: 'set', resourceId: other.resourceId, key: 'k', value: 1 }).op).toBe('set');
    // 回填：200ms 回 1 个令牌（每秒 5 个），持续速率受限。
    advance(200);
    expect(h.service.storage({ op: 'set', resourceId, key: 'more', value: 1 }).op).toBe('set');
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'more2', value: 1 })).toThrow(
      expect.objectContaining({ code: 'WIDGET_RATE_LIMITED' }),
    );
  });

  it('resourceId 过期 / 未知 → WIDGET_RESOURCE_EXPIRED（storage 与 openLink 一致）', async () => {
    const h2 = makeHarness(50);
    seed(h2.db);
    const { resourceId } = createAndOpen(h2.service, h2.cards);
    advance(100);
    expect(() => h2.service.storage({ op: 'set', resourceId, key: 'k', value: 1 })).toThrow(
      /WIDGET_RESOURCE_EXPIRED|过期/,
    );
    expect(() => h2.service.storage({ op: 'get', resourceId: 'nope', key: 'k' })).toThrow(
      /WIDGET_RESOURCE_EXPIRED|过期/,
    );
    await expect(h2.service.openLink({ resourceId, url: 'https://a.example/x' })).rejects.toThrow(
      /WIDGET_RESOURCE_EXPIRED|过期/,
    );
  });
});

describe('WidgetService 能力桥：openLink（P1）', () => {
  it('仅 https 无凭据经 shell 打开；http / 非法 URL / 带凭据 → ok:false 且不打扰 shell', async () => {
    const { resourceId } = createAndOpen(h.service, h.cards);
    await expect(
      h.service.openLink({ resourceId, url: 'https://example.com/a?b=1' }),
    ).resolves.toEqual({ ok: true });
    expect(h.links).toEqual(['https://example.com/a?b=1']);

    await expect(h.service.openLink({ resourceId, url: 'http://example.com/' })).resolves.toEqual({
      ok: false,
    });
    await expect(
      h.service.openLink({ resourceId, url: 'https://user:pass@example.com/' }),
    ).resolves.toEqual({ ok: false });
    await expect(h.service.openLink({ resourceId, url: 'javascript:alert(1)' })).resolves.toEqual({
      ok: false,
    });
    await expect(h.service.openLink({ resourceId, url: 'not a url' })).resolves.toEqual({ ok: false });
    expect(h.links).toHaveLength(1);
  });
});

describe('WidgetService SDK 垫片注入（P1）', () => {
  it('open 登记的是垫片版 HTML（doctype 不被顶到垫片后面）；source 仍是原文', () => {
    const { widgetId, resourceId } = createAndOpen(
      h.service,
      h.cards,
      '<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>',
    );
    const host = widgetUiHostFor(widgetId);
    const page = h.service.resource({ resourceId, host });
    // doctype 仍是文档第一个非空内容（quirks-mode 防线），垫片插在 <head> 之后。
    expect(page.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(page.html).toContain('<head><script>');
    expect(page.html).toContain("source: 'kepcup-widget'");
    expect(page.html).toContain('</script><title>t</title>');
    expect(page.html).toContain('<body><p>x</p></body>');
    // 审查态看到的是 Bot 写的原文，不含垫片。
    const source = h.service.source(h.cards[h.cards.length - 1]!.id);
    expect(source.html).toBe('<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>');
  });

  it('injectWidgetSdk：无 head 时退到 doctype 之后；两者都无时前置；幂等', () => {
    const afterDoctype = injectWidgetSdk('<!doctype html><html><body></body></html>');
    expect(afterDoctype.startsWith('<!doctype html><script>')).toBe(true);
    const prepended = injectWidgetSdk('<html><body></body></html>');
    expect(prepended.startsWith('<script>')).toBe(true);
    // 已含垫片（例如重复调用）原样返回。
    expect(injectWidgetSdk(afterDoctype)).toBe(afterDoctype);
    // 垫片自身不含 </script> 以外的意外标签闭合。
    expect(WIDGET_SDK_SHIM.endsWith('</script>')).toBe(true);
  });
});


describe('WidgetService 查询模板登记（P2）', () => {
  const MONTH = "json_extract(value_json, '$.month')";
  const N = "json_extract(value_json, '$.n')";
  const QUERIES = [
    {
      name: 'by_month',
      sql: `select ${MONTH} as month, sum(${N}) as total from widget_kv where ${MONTH} = :month group by month`,
    },
    { name: 'all', sql: `select ${N} as n from widget_kv order by n` },
  ];

  /** 直接往某组件的 KV 里塞数据（查询的数据源是本组件的 widget_kv 视图）。 */
  function seedDocs(db: Harness['db'], widgetId: string, docs: Record<string, unknown>): void {
    const insert = db.prepare(
      'insert into widget_docs (widget_id, key, value_json, updated_at) values (?, ?, ?, 1)',
    );
    db.transaction(() => {
      for (const [key, value] of Object.entries(docs)) insert.run(widgetId, key, JSON.stringify(value));
    })();
  }

  const MONTH_DOCS = {
    a: { month: '2026-01', n: 1, flag: 0 },
    b: { month: '2026-02', n: 2, flag: 1 },
    c: { month: '2026-02', n: 3, flag: 1 },
  };

  function createWith(
    queries: Array<{ name: string; sql: string }>,
    html: string = HTML,
  ): { widgetId: string; messageId: string } {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '报表',
      description: '',
      html,
      queries,
      scope: 'conversation',
      runId: 'r',
    });
    if (!created.ok) throw new Error(`create failed: ${created.message}`);
    return { widgetId: created.widgetId, messageId: h.cards[h.cards.length - 1]!.id };
  }

  /** 审查（展开源码）后加载：带查询模板的版本必须先审查。 */
  function reviewAndOpen(messageId: string): { resourceId: string } {
    h.service.source(messageId);
    return h.service.open({ messageId });
  }

  it('create 带 queries：模板落库、版本行记摘要、卡片带 queriesSha256/queriesCount、source 返回按名字序全文', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '报表',
      description: '',
      html: HTML,
      queries: [QUERIES[1]!, QUERIES[0]!], // 乱序交付
      scope: 'conversation',
      runId: 'r',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rows = h.db
      .prepare('select name, sql from widget_queries where widget_id = ? and version = 1 order by name')
      .all(created.widgetId) as Array<{ name: string; sql: string }>;
    expect(rows.map((r) => r.name)).toEqual(['all', 'by_month']);
    const versionRow = h.db
      .prepare('select queries_sha256 from widget_versions where widget_id = ? and version = 1')
      .get(created.widgetId) as { queries_sha256: string };
    expect(versionRow.queries_sha256).not.toBe('');
    expect(cardOfLast(h.cards)).toMatchObject({
      widgetId: created.widgetId,
      queriesCount: 2,
      queriesSha256: versionRow.queries_sha256,
    });
    const source = h.service.source(h.cards[h.cards.length - 1]!.id);
    expect(source.queries.map((q) => q.name)).toEqual(['all', 'by_month']);
    expect(source.queries[1]!.sql).toContain(':month');
  });

  it('登记校验：非只读 / PRAGMA / ATTACH / 多语句 / 越界读表 / 坏名字 / 重名 / 超量 / 编译失败全部拒绝且不发卡', () => {
    const base = { botId: 'bot_a', conversationId: 'conv_1', scope: 'conversation' as const, runId: 'r' };
    const q = (sql: string) => [{ name: 'q', sql }];
    const cases: Array<{ label: string; sql: string }> = [
      { label: 'insert', sql: "insert into widget_kv values ('k', '1', 1)" },
      { label: 'pragma', sql: 'pragma foreign_keys = off' },
      { label: 'attach', sql: "attach database ':memory:' as x" },
      { label: 'multi', sql: 'select 1; select 2' },
      { label: 'with-insert', sql: "with c as (select 1 as n) insert into widget_kv select 'k', n, 1 from c" },
      // 数据范围：任何物理表（含凭据类）、库结构、pragma 表值函数都不在作用域视图里。
      { label: 'secrets', sql: 'select * from secrets' },
      { label: 'app_connections', sql: 'select * from app_connections' },
      { label: 'raw messages', sql: 'select content_json from messages' },
      { label: 'raw docs', sql: 'select * from widget_docs' },
      { label: 'schema', sql: 'select sql from sqlite_master' },
      { label: 'pragma tvf', sql: 'select name from pragma_table_list' },
    ];
    for (const c of cases) {
      const result = h.service.create({ ...base, title: 't', html: HTML, queries: q(c.sql) });
      expect(result.ok, c.label).toBe(false);
      if (!result.ok) expect(result.message, c.label).toContain('查询「q」');
    }
    expect(
      h.service.create({ ...base, title: 't', html: HTML, queries: [{ name: 'bad name!', sql: 'select 1' }] }).ok,
    ).toBe(false);
    expect(
      h.service
        .create({ ...base, title: 't', html: HTML, queries: [{ name: 'a', sql: 'select 1' }, { name: 'a', sql: 'select 2' }] })
        .ok,
    ).toBe(false);
    expect(
      h.service.create({
        ...base,
        title: 't',
        html: HTML,
        queries: Array.from({ length: 21 }, (_, i) => ({ name: `q${i}`, sql: 'select 1' })),
      }).ok,
    ).toBe(false);
    // 引用不存在表的模板在交付时即被拒（桩库编译校验）。
    expect(
      h.service.create({ ...base, title: 't', html: HTML, queries: [{ name: 'q', sql: 'select * from nope' }] }).ok,
    ).toBe(false);
    expect(h.cards).toHaveLength(0);
  });

  it('预审强制：带查询的版本未展开源码 → open 得 WIDGET_REVIEW_REQUIRED；展开后可加载；新版本要重新审查；无查询的版本不受影响', () => {
    const { widgetId, messageId } = createWith([QUERIES[1]!]);
    expect(() => h.service.open({ messageId })).toThrow(
      expect.objectContaining({ code: 'WIDGET_REVIEW_REQUIRED' }),
    );
    h.service.source(messageId);
    expect(h.service.open({ messageId }).resourceId).toEqual(expect.any(String));
    // 审查记录在库里（重启后仍然有效），按版本记。
    const reviewed = h.db
      .prepare('select queries_reviewed_at from widget_versions where widget_id = ? and version = 1')
      .get(widgetId) as { queries_reviewed_at: number | null };
    expect(reviewed.queries_reviewed_at).not.toBeNull();
    const v2 = h.service.update({
      botId: 'bot_a',
      widgetId,
      html: HTML,
      queries: [QUERIES[0]!],
      changeNote: '',
      runId: 'r2',
    });
    expect(v2.ok).toBe(true);
    const v2MessageId = h.cards[h.cards.length - 1]!.id;
    expect(() => h.service.open({ messageId: v2MessageId })).toThrow(
      expect.objectContaining({ code: 'WIDGET_REVIEW_REQUIRED' }),
    );
    // 无查询的版本：不需要展开源码。
    const plain = h.service.update({ botId: 'bot_a', widgetId, html: HTML, changeNote: '', runId: 'r3' });
    expect(plain.ok).toBe(true);
    expect(h.service.open({ messageId: h.cards[h.cards.length - 1]!.id }).resourceId).toEqual(expect.any(String));
  });

  it('update 换模板：新版本用新模板，旧卡（钉 v1）只能调 v1 的模板；不传 queries = 新版本没有查询', async () => {
    const created = createWith([QUERIES[0]!]);
    seedDocs(h.db, created.widgetId, MONTH_DOCS);
    const v1MessageId = created.messageId;
    const updated = h.service.update({
      botId: 'bot_a',
      widgetId: created.widgetId,
      html: HTML, // HTML 相同、仅模板变化：摘要必须不同（确认指纹覆盖查询）
      queries: [{ name: 'v2_only', sql: `select ${N} * 2 as doubled from widget_kv order by doubled` }],
      changeNote: '换查询',
      runId: 'r2',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const v2Card = cardOfLast(h.cards);
    expect(v2Card.queriesCount).toBe(1);
    expect(v2Card.queriesSha256).not.toBe('');
    const openedV1 = reviewAndOpen(v1MessageId);
    // 旧卡只能用 v1 的模板。
    await expect(
      h.service.query({ resourceId: openedV1.resourceId, name: 'by_month', params: { month: '2026-02' } }),
    ).resolves.toEqual({ rows: [{ month: '2026-02', total: 5 }], truncated: false });
    await expect(h.service.query({ resourceId: openedV1.resourceId, name: 'v2_only', params: {} })).rejects.toThrow(
      /没有在这个组件版本里登记/,
    );
    // 新卡（v2）只能用 v2 的模板；v2 没登记 by_month。
    const openedV2 = reviewAndOpen(h.cards[h.cards.length - 1]!.id);
    await expect(h.service.query({ resourceId: openedV2.resourceId, name: 'v2_only', params: {} })).resolves.toEqual({
      rows: [{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }],
      truncated: false,
    });
    await expect(
      h.service.query({ resourceId: openedV2.resourceId, name: 'by_month', params: { month: 'x' } }),
    ).rejects.toMatchObject({ code: 'WIDGET_QUERY_UNKNOWN' });
    // update 不带 queries：v3 是「没有查询」的完整快照。
    const v3 = h.service.update({
      botId: 'bot_a',
      widgetId: created.widgetId,
      html: HTML.replace('>1<', '>3<'),
      changeNote: '',
      runId: 'r3',
    });
    expect(v3.ok).toBe(true);
    expect(
      h.db.prepare('select count(*) as n from widget_queries where widget_id = ? and version = 3').get(created.widgetId),
    ).toEqual({ n: 0 });
    const v3Row = h.db
      .prepare('select queries_sha256 from widget_versions where widget_id = ? and version = 3')
      .get(created.widgetId) as { queries_sha256: string };
    expect(v3Row.queries_sha256).toBe('');
    expect(cardOfLast(h.cards).queriesSha256).toBe('');
  });

  it('数据范围：只看见本组件的 KV 与卡片所在对话的文字消息', async () => {
    const mine = createWith([
      { name: 'kv', sql: 'select key from widget_kv order by key' },
      { name: 'msgs', sql: 'select text from conversation_messages order by seq' },
    ]);
    const other = createWith([{ name: 'kv', sql: 'select key from widget_kv' }]);
    seedDocs(h.db, mine.widgetId, { mine: 1 });
    seedDocs(h.db, other.widgetId, { theirs: 1 });
    h.db.exec(`
      insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at, status)
      values ('m1', 'conv_1', 101, 'user', 'text', '{"text":"本对话"}', 1, 'normal'),
             ('m2', 'conv_1', 102, 'user', 'text', '{"text":"已撤回"}', 2, 'recalled'),
             ('m3', 'conv_2', 101, 'user', 'text', '{"text":"别的对话"}', 3, 'normal');
    `);
    const { resourceId } = reviewAndOpen(mine.messageId);
    await expect(h.service.query({ resourceId, name: 'kv', params: {} })).resolves.toEqual({
      rows: [{ key: 'mine' }],
      truncated: false,
    });
    await expect(h.service.query({ resourceId, name: 'msgs', params: {} })).resolves.toEqual({
      rows: [{ text: '本对话' }],
      truncated: false,
    });
  });

  it('query：参数绑定（boolean 归一 1/0）、缺参数与坏参数类型报人话 + 机器码、行数上限截断', async () => {
    const { widgetId, messageId } = createWith([
      {
        name: 'by_flag',
        sql: `select ${N} as n from widget_kv where ${MONTH} = :month and json_extract(value_json, '$.flag') = :flag order by n`,
      },
      { name: 'page', sql: `select ${N} as n from widget_kv order by n` },
    ]);
    seedDocs(h.db, widgetId, MONTH_DOCS);
    const { resourceId } = reviewAndOpen(messageId);

    // flag: true → 1，命中两行。
    await expect(
      h.service.query({ resourceId, name: 'by_flag', params: { month: '2026-02', flag: true } }),
    ).resolves.toEqual({ rows: [{ n: 2 }, { n: 3 }], truncated: false });
    // flag: false → 0，命中 flag=0 的行。
    await expect(
      h.service.query({ resourceId, name: 'by_flag', params: { month: '2026-01', flag: false } }),
    ).resolves.toEqual({ rows: [{ n: 1 }], truncated: false });

    await expect(h.service.query({ resourceId, name: 'by_flag', params: { flag: 1 } })).rejects.toMatchObject({
      code: 'WIDGET_QUERY_FAILED',
      message: expect.stringContaining('缺少参数'),
    }); // 缺 :month

    await expect(
      h.service.query({ resourceId, name: 'by_flag', params: { month: { x: 1 }, flag: 1 } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' }); // 对象参数

    const many: Record<string, unknown> = {};
    for (let i = 0; i < BOT_WIDGET_QUERY_ROWS_MAX + 20; i += 1) many[`p${String(i).padStart(4, '0')}`] = { n: 100 + i };
    seedDocs(h.db, widgetId, many);
    const paged = await h.service.query({ resourceId, name: 'page', params: {} });
    expect(paged.truncated).toBe(true);
    expect(paged.rows).toHaveLength(BOT_WIDGET_QUERY_ROWS_MAX);
    expect(paged.rows[0]).toEqual({ n: 1 });
  });

  it('query：未知模板；库行被外力改成写语句 / 越界读表时运行时名字闸再拦', async () => {
    const { messageId } = createWith([{ name: 'all', sql: 'select key from widget_kv' }]);
    const { resourceId } = reviewAndOpen(messageId);
    await expect(h.service.query({ resourceId, name: 'nope', params: {} })).rejects.toMatchObject({
      code: 'WIDGET_QUERY_UNKNOWN',
    });

    h.db.prepare("update widget_queries set sql = 'delete from widget_kv' where name = 'all'").run();
    await expect(h.service.query({ resourceId, name: 'all', params: {} })).rejects.toMatchObject({
      code: 'WIDGET_QUERY_FAILED',
      message: expect.stringContaining('被拒绝执行'),
    });
    h.db.prepare("update widget_queries set sql = 'select * from secrets' where name = 'all'").run();
    await expect(h.service.query({ resourceId, name: 'all', params: {} })).rejects.toMatchObject({
      code: 'WIDGET_QUERY_FAILED',
    });
  });

  it('query：执行超时得 WIDGET_QUERY_TIMEOUT，core 不被拖住', async () => {
    const h2 = makeHarness(undefined, { queryTimeoutMs: 400 });
    seed(h2.db);
    const created = h2.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      queries: [
        { name: 'spin', sql: 'with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c' },
        { name: 'one', sql: 'select 1 as one' },
      ],
      scope: 'conversation',
      runId: 'r',
    });
    if (!created.ok) throw new Error('create failed');
    const messageId = h2.cards[h2.cards.length - 1]!.id;
    h2.service.source(messageId);
    const { resourceId } = h2.service.open({ messageId });
    await h2.service.query({ resourceId, name: 'one', params: {} }); // 热身：子进程就绪
    await expect(h2.service.query({ resourceId, name: 'spin', params: {} })).rejects.toMatchObject({
      code: 'WIDGET_QUERY_TIMEOUT',
    });
    await expect(h2.service.query({ resourceId, name: 'one', params: {} })).resolves.toEqual({
      rows: [{ one: 1 }],
      truncated: false,
    });
  });

  it('query：与 storage 共用令牌桶（突发 20、每秒回填 5）；过期 resourceId → WIDGET_RESOURCE_EXPIRED', async () => {
    const { messageId } = createWith([{ name: 'all', sql: 'select key from widget_kv' }]);
    const opened = reviewAndOpen(messageId);
    // 看板一次性并发拉取：突发额度内全部放行。
    const burst = await Promise.all(
      Array.from({ length: BOT_WIDGET_CALLS_BURST }, () =>
        h.service.query({ resourceId: opened.resourceId, name: 'all', params: {} }),
      ),
    );
    expect(burst.every((out) => out.truncated === false)).toBe(true);
    await expect(h.service.query({ resourceId: opened.resourceId, name: 'all', params: {} })).rejects.toMatchObject({
      code: 'WIDGET_RATE_LIMITED',
    });

    const h3 = makeHarness(50);
    seed(h3.db);
    const c3 = h3.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      queries: [{ name: 'all', sql: 'select key from widget_kv' }],
      scope: 'conversation',
      runId: 'r',
    });
    if (!c3.ok) throw new Error('create failed');
    const m3 = h3.cards[h3.cards.length - 1]!.id;
    h3.service.source(m3);
    const opened3 = h3.service.open({ messageId: m3 });
    advance(100);
    await expect(h3.service.query({ resourceId: opened3.resourceId, name: 'all', params: {} })).rejects.toMatchObject({
      code: 'WIDGET_RESOURCE_EXPIRED',
    });
  });

  it('完整性：版本行的 queries_sha256 与卡片不一致 → WIDGET_INVALID（open 与 source 一致）', () => {
    const { widgetId, messageId } = createWith([{ name: 'all', sql: 'select 1' }]);
    h.db
      .prepare('update widget_versions set queries_sha256 = ? where widget_id = ?')
      .run('deadbeef', widgetId);
    expect(() => h.service.open({ messageId })).toThrow(/WIDGET_INVALID|不一致/);
    expect(() => h.service.source(messageId)).toThrow(/WIDGET_INVALID|不一致/);
  });

  it('deleteForBot 连查询模板一起清（级联），并摘除在途资源', () => {
    const { messageId } = createWith([{ name: 'all', sql: 'select 1' }]);
    const opened = reviewAndOpen(messageId);
    expect(h.service.deleteForBot('bot_a')).toBe(1);
    expect(h.db.prepare('select count(*) as n from widget_queries').get()).toEqual({ n: 0 });
    // 在途资源被摘除：桥调用得 WIDGET_RESOURCE_EXPIRED，而不是打到已消失的库行收裸 SQLite 错误。
    expect(() =>
      h.service.storage({ op: 'set', resourceId: opened.resourceId, key: 'k', value: 1 }),
    ).toThrow(/WIDGET_RESOURCE_EXPIRED|过期/);
  });
});

describe('WidgetService P2 独立审查修复轮', () => {
  function createSingle(sql: string): { widgetId: string; messageId: string } {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      queries: [{ name: 'q', sql }],
      scope: 'conversation',
      runId: 'r',
    });
    if (!created.ok) throw new Error(`create failed: ${created.message}`);
    const messageId = h.cards[h.cards.length - 1]!.id;
    return { widgetId: created.widgetId, messageId };
  }

  it('回执字节上限：宽行在 200 行之前触顶，截断且不返回溢出行', async () => {
    const { widgetId, messageId } = createSingle('select value_json from widget_kv order by key');
    const insert = h.db.prepare(
      'insert into widget_docs (widget_id, key, value_json, updated_at) values (?, ?, ?, 1)',
    );
    h.db.transaction(() => {
      for (let i = 0; i < 200; i += 1) insert.run(widgetId, `k${String(i).padStart(3, '0')}`, JSON.stringify('x'.repeat(16 * 1024)));
    })();
    h.service.source(messageId);
    const { resourceId } = h.service.open({ messageId });
    const out = await h.service.query({ resourceId, name: 'q', params: {} });
    expect(out.truncated).toBe(true);
    expect(out.rows.length).toBeLessThan(200);
    // 溢出的那一行不返回：累计字节在上限之内。
    const total = out.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    expect(total).toBeLessThanOrEqual(BOT_WIDGET_QUERY_RESULT_MAX_BYTES);
    expect(total + 16 * 1024 + 32).toBeGreaterThan(BOT_WIDGET_QUERY_RESULT_MAX_BYTES);
  });

  it('bigint 参数超出 ±2^53 拒绝（better-sqlite3 按 double 绑会静默失真）', async () => {
    const { messageId } = createSingle('select :id as id');
    h.service.source(messageId);
    const { resourceId } = h.service.open({ messageId });
    await expect(h.service.query({ resourceId, name: 'q', params: { id: 42n } })).resolves.toMatchObject({
      rows: [{ id: 42 }],
    });
    await expect(h.service.query({ resourceId, name: 'q', params: { id: 2n ** 60n } })).rejects.toThrow(
      /INVALID_INPUT|安全整数/,
    );
  });

  it('__proto__ 命名参数的模板在交付时即拒（运行时永远绑不上）', () => {
    const base = { botId: 'bot_a', conversationId: 'conv_1', scope: 'conversation' as const, runId: 'r' };
    expect(
      h.service.create({ ...base, title: 't', html: HTML, queries: [{ name: 'q', sql: 'select :__proto__ as p' }] }).ok,
    ).toBe(false);
    expect(
      h.service.create({ ...base, title: 't', html: HTML, queries: [{ name: 'q', sql: 'select :__PROTO__ as p' }] }).ok,
    ).toBe(false);
    // 普通名字不受影响。
    expect(
      h.service.create({ ...base, title: 't', html: HTML, queries: [{ name: 'q', sql: 'select :proto_value as p' }] }).ok,
    ).toBe(true);
    expect(h.cards).toHaveLength(1);
  });

  it('模板内容被外力替换（版本行摘要未变）时 open 拒绝：摘要对现行内容复算', () => {
    const { messageId } = createSingle('select 1 as one');
    // 只改模板内容、版本行 queries_sha256 不动：卡片与版本行的摘要比对发现不了，
    // 靠 open 时对现行内容复算摘要拦截（审查对象不能被偷换）。
    h.db.prepare("update widget_queries set sql = 'select 2 as two' where name = 'q'").run();
    expect(() => h.service.open({ messageId })).toThrow(/WIDGET_INVALID|不一致/);
    expect(() => h.service.source(messageId)).toThrow(/WIDGET_INVALID|不一致/);
  });
});

describe('WidgetService 管理入口（P2）：列表 / 删除 / 跨对话引用', () => {
  function createScoped(
    scope: WidgetScope,
    title: string,
    conversationId = 'conv_1',
  ): { widgetId: string } {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId,
      title,
      description: `${title} 说明`,
      html: HTML,
      scope,
      runId: 'r',
    });
    if (!created.ok) throw new Error('create failed');
    return { widgetId: created.widgetId };
  }

  it('listForBot：全部组件（含会话级）按更新时间倒序，带最新版本信息', () => {
    const a = createScoped('bot', '资产 A');
    advance(10); // updated_at 倒序需要可比较的时间戳
    const conv = createScoped('conversation', '会话 B');
    const list = h.service.listForBot('bot_a');
    expect(list.map((w) => [w.widgetId, w.scope, w.version, w.queriesCount])).toEqual([
      [conv.widgetId, 'conversation', 1, 0],
      [a.widgetId, 'bot', 1, 0],
    ]);
    expect(list[0]).toMatchObject({
      title: '会话 B',
      conversationId: 'conv_1',
      versionCount: 1,
      sizeBytes: Buffer.byteLength(HTML),
      sha256: expect.any(String),
    });
    expect(list[1]!.conversationId).toBeNull();
    // 别的 Bot 的组件不出现。
    expect(h.service.listForBot('bot_b')).toEqual([]);
  });

  it('publish：Bot 级组件发卡到指定对话（钉最新版、带查询摘要）；会话级 / 别人的 / 不存在的拒绝', () => {
    const { widgetId } = createScoped('bot', '资产 A');
    const published = h.service.publish({
      botId: 'bot_a',
      widgetId,
      conversationId: 'conv_2',
      runId: 'run_p',
    });
    expect(published).toMatchObject({ ok: true, version: 1 });
    if (!published.ok) return;
    expect(h.cards).toHaveLength(2);
    const card = cardOfLast(h.cards);
    expect(card).toMatchObject({
      widgetId,
      version: 1,
      scope: 'bot',
      queriesSha256: '',
      queriesCount: 0,
    });
    // 卡片发进了目标对话。
    expect(h.cards[h.cards.length - 1]!.conversationId).toBe('conv_2');
    // publish 不落新版本。
    expect(
      (h.db.prepare('select count(*) as n from widget_versions where widget_id = ?').get(widgetId) as { n: number }).n,
    ).toBe(1);
    // 每 run 卡数上限同样约束 publish（run_p 之前没有发过卡）。
    for (let i = 0; i < 7; i += 1) {
      expect(
        h.service.publish({ botId: 'bot_a', widgetId, conversationId: 'conv_2', runId: 'run_p' }).ok,
      ).toBe(true);
    }
    expect(h.service.publish({ botId: 'bot_a', widgetId, conversationId: 'conv_2', runId: 'run_p' }).ok).toBe(false);

    const convScoped = createScoped('conversation', '会话 C');
    expect(
      h.service.publish({ botId: 'bot_a', widgetId: convScoped.widgetId, conversationId: 'conv_2', runId: 'r2' }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      h.service.publish({ botId: 'bot_b', widgetId, conversationId: 'conv_2', runId: 'r3' }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      h.service.publish({ botId: 'bot_a', widgetId: 'wgt_missing', conversationId: 'conv_2', runId: 'r4' }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('publish 后 widget_update 出新版本：旧 publish 卡钉旧版，新 publish 发新版（含查询摘要）', () => {
    const { widgetId } = createScoped('bot', '资产 A');
    const updated = h.service.update({
      botId: 'bot_a',
      widgetId,
      html: HTML.replace('>1<', '>2<'),
      queries: [{ name: 'all', sql: 'select 1' }],
      changeNote: '',
      conversationId: 'conv_2',
      runId: 'r2',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // Bot 级组件在另一对话更新：新卡发到 conv_2（跨对话引用）。
    expect(h.cards[h.cards.length - 1]!.conversationId).toBe('conv_2');
    expect(cardOfLast(h.cards)).toMatchObject({ version: 2, queriesCount: 1 });

    const published = h.service.publish({
      botId: 'bot_a',
      widgetId,
      conversationId: 'conv_2',
      runId: 'r3',
    });
    expect(published).toMatchObject({ ok: true, version: 2 });
    expect(cardOfLast(h.cards)).toMatchObject({ version: 2, queriesCount: 1 });
    expect(cardOfLast(h.cards).queriesSha256).not.toBe('');
  });

  it('delete：清三表 + 摘除在途资源；别人的组件拒绝；旧卡 open 优雅报错', () => {
    const { widgetId } = createScoped('bot', '资产 A');
    const messageId = h.cards[h.cards.length - 1]!.id;
    const opened = h.service.open({ messageId });
    expect(h.service.delete('bot_b', widgetId)).toBe(false);
    expect(h.service.delete('bot_a', widgetId)).toBe(true);
    expect(h.db.prepare('select count(*) as n from widget_versions').get()).toEqual({ n: 0 });
    expect(h.db.prepare('select count(*) as n from widget_docs').get()).toEqual({ n: 0 });
    expect(h.db.prepare('select count(*) as n from widget_queries').get()).toEqual({ n: 0 });
    // 在途资源被摘除：桥调用得 WIDGET_RESOURCE_EXPIRED（人话「过期」）。
    expect(() =>
      h.service.storage({ op: 'set', resourceId: opened.resourceId, key: 'k', value: 1 }),
    ).toThrow(/WIDGET_RESOURCE_EXPIRED|过期/);
    // 不存在的组件删除返回 false（幂等）。
    expect(h.service.delete('bot_a', widgetId)).toBe(false);
  });
});

describe('WidgetService 审查修复（资源存活 / 存量上限 / 体积列）', () => {
  it('会话删除经 FK 级联带走组件：在途资源的桥调用得 WIDGET_RESOURCE_EXPIRED，不是裸 FOREIGN KEY 错误', async () => {
    const { resourceId, widgetId } = createAndOpen(h.service, h.cards);
    const host = widgetUiHostFor(widgetId);
    // 删除会话不经 WidgetService（lifecycle 直接删 conversations 行），内存资源并不知情。
    h.db.prepare('delete from conversations where id = ?').run('conv_1');
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'k', value: 1 })).toThrow(
      /组件界面已过期/,
    );
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'k', value: 1 })).toThrow(
      expect.objectContaining({ code: 'WIDGET_RESOURCE_EXPIRED' }),
    );
    await expect(h.service.openLink({ resourceId, url: 'https://a.example/' })).rejects.toMatchObject({
      code: 'WIDGET_RESOURCE_EXPIRED',
    });
    await expect(h.service.query({ resourceId, name: 'q', params: {} })).rejects.toMatchObject({
      code: 'WIDGET_RESOURCE_EXPIRED',
    });
    expect(() => h.service.resource({ resourceId, host })).toThrow(/不存在或已过期/);
    expect(h.service.store.get(resourceId)).toBeUndefined();
  });

  it('每 Bot 组件数上限：满了 widget_create 得 WIDGET_LIMIT（不发卡），给出可行动说明', () => {
    const base = { botId: 'bot_a', conversationId: 'conv_1', scope: 'conversation' as const, description: '' };
    for (let i = 0; i < BOT_WIDGET_PER_BOT_MAX; i += 1) {
      // runId '' 不计每 run 卡数（这里只测存量上限）。
      expect(h.service.create({ ...base, title: `t${i}`, html: HTML, runId: '' }).ok).toBe(true);
    }
    const cardsBefore = h.cards.length;
    const over = h.service.create({ ...base, title: 'one more', html: HTML, runId: '' });
    expect(over).toMatchObject({ ok: false, code: 'WIDGET_LIMIT' });
    if (!over.ok) expect(over.message).toContain('widget_update');
    expect(h.cards).toHaveLength(cardsBefore);
    // 别的 Bot 不受影响。
    expect(h.service.create({ ...base, botId: 'bot_b', title: 'b', html: HTML, runId: '' }).ok).toBe(true);
  });

  it('每 Bot 字节配额：超限 create / update 得 WIDGET_LIMIT，库里不落新版本', () => {
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
    // 把已有版本的体积记成接近配额（size_bytes 是配额的唯一来源）。
    h.db
      .prepare('update widget_versions set size_bytes = ? where widget_id = ?')
      .run(BOT_WIDGET_BOT_BYTES_QUOTA - 10, created.widgetId);
    expect(
      h.service.create({ botId: 'bot_a', conversationId: 'conv_1', title: 't2', description: '', html: HTML, scope: 'conversation', runId: 'r' }),
    ).toMatchObject({ ok: false, code: 'WIDGET_LIMIT' });
    expect(
      h.service.update({ botId: 'bot_a', widgetId: created.widgetId, html: HTML, changeNote: '', runId: 'r' }),
    ).toMatchObject({ ok: false, code: 'WIDGET_LIMIT' });
    expect(
      h.db.prepare('select count(*) as n from widget_versions where widget_id = ?').get(created.widgetId),
    ).toEqual({ n: 1 });
  });

  it('版本修剪：只保留最近 N 个版本（含查询模板），被修剪版本的在途资源与旧卡优雅失效', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      queries: [{ name: 'q', sql: 'select 1 as one' }],
      scope: 'conversation',
      runId: '',
    });
    if (!created.ok) throw new Error('create failed');
    const v1MessageId = h.cards[h.cards.length - 1]!.id;
    h.service.source(v1MessageId);
    const v1 = h.service.open({ messageId: v1MessageId });
    for (let i = 0; i < BOT_WIDGET_VERSIONS_KEPT; i += 1) {
      const updated = h.service.update({
        botId: 'bot_a',
        widgetId: created.widgetId,
        html: HTML.replace('>1<', `>${i + 2}<`),
        queries: [{ name: 'q', sql: `select ${i} as n` }],
        changeNote: '',
        runId: '',
      });
      expect(updated.ok).toBe(true);
    }
    const versions = h.db
      .prepare('select version from widget_versions where widget_id = ? order by version')
      .all(created.widgetId) as Array<{ version: number }>;
    expect(versions).toHaveLength(BOT_WIDGET_VERSIONS_KEPT);
    expect(versions[0]!.version).toBe(2);
    expect(
      h.db.prepare('select count(*) as n from widget_queries where widget_id = ? and version = 1').get(created.widgetId),
    ).toEqual({ n: 0 });
    // v1 的在途资源被摘除；v1 旧卡重开得「这个版本的组件已不存在」。
    expect(() => h.service.storage({ op: 'get', resourceId: v1.resourceId, key: 'k' })).toThrow(
      expect.objectContaining({ code: 'WIDGET_RESOURCE_EXPIRED' }),
    );
    expect(() => h.service.open({ messageId: v1MessageId })).toThrow(/已不存在/);
    // 管理列表的版本数与修剪一致。
    expect(h.service.listForBot('bot_a')[0]).toMatchObject({
      version: BOT_WIDGET_VERSIONS_KEPT + 1,
      versionCount: BOT_WIDGET_VERSIONS_KEPT,
    });
  });

  it('listForBot 的体积取 size_bytes 列（不为取字节数把 html 读出来）', () => {
    const created = h.service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'bot',
      runId: 'r',
    });
    if (!created.ok) throw new Error('create failed');
    expect(
      h.db.prepare('select size_bytes from widget_versions where widget_id = ?').get(created.widgetId),
    ).toEqual({ size_bytes: Buffer.byteLength(HTML) });
    // 列值是唯一来源：改掉它，列表跟着变（证明没有再按 html 现算）。
    h.db.prepare('update widget_versions set size_bytes = 12345 where widget_id = ?').run(created.widgetId);
    expect(h.service.listForBot('bot_a')[0]!.sizeBytes).toBe(12345);
  });

  it('迁移 0032：存量版本行按 html 字节数回填 size_bytes，审查时间为空', () => {
    const db = new Database(':memory:');
    // 0028 + 0029 形态的 widget_versions（不带外键，只验证回填语句本身）。
    db.exec(`create table widget_versions (
      widget_id TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL, sha256 TEXT NOT NULL,
      created_by_run TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      queries_sha256 TEXT NOT NULL DEFAULT '', PRIMARY KEY (widget_id, version))`);
    db.prepare("insert into widget_versions (widget_id, version, html, sha256, created_at) values ('w', 1, ?, 's', 1)").run(
      '中文<p>x</p>',
    );
    db.exec(readFileSync(path.join(migrationsUrl('main'), '0032_widget_limits.sql'), 'utf8'));
    expect(db.prepare('select size_bytes, queries_reviewed_at from widget_versions').get()).toEqual({
      size_bytes: Buffer.byteLength('中文<p>x</p>'),
      queries_reviewed_at: null,
    });
    db.close();
  });
});

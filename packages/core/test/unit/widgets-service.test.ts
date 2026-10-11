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
  /** shell.openExternal 收到的外链（openLink 用例断言用）。 */
  links: string[];
}

function makeHarness(ttlMs?: number, options?: { appendThrows?: boolean }): Harness {
  const db = openDb();
  const cards: Message[] = [];
  const byId = new Map<string, Message>();
  const links: string[] = [];
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
      shell: {
        openExternal: async (input: { url: string }) => {
          links.push(input.url);
          return { ok: true };
        },
      },
      clock,
      logger: { warn: () => undefined },
    },
    new WidgetResourceStore({ clock, ttlMs }),
  );
  return { db, service, cards, getById: (id) => byId.get(id) ?? null, links };
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

describe('WidgetService 能力桥：storage KV（P1）', () => {
  it('set/get/list/delete 往返；两个组件命名空间互不可见；重开后数据仍在', () => {
    const a = createAndOpen(h.service, h.cards);
    const b = createAndOpen(h.service, h.cards);
    // 限速按资源滚动窗口计（每秒 5 次）：用例内多次调用之间推进时钟避开。
    const tick = (): void => {
      now += 1100;
    };

    tick();
    expect(h.service.storage({ op: 'get', resourceId: a.resourceId, key: 'count' })).toEqual({
      op: 'get',
      found: false,
    });
    tick();
    expect(h.service.storage({ op: 'set', resourceId: a.resourceId, key: 'count', value: { n: 42 } })).toEqual({ op: 'set' });
    tick();
    expect(h.service.storage({ op: 'get', resourceId: a.resourceId, key: 'count' })).toEqual({
      op: 'get',
      found: true,
      value: { n: 42 },
    });
    // 命名空间隔离：B 读不到 A 的键。
    tick();
    expect(h.service.storage({ op: 'get', resourceId: b.resourceId, key: 'count' })).toEqual({
      op: 'get',
      found: false,
    });
    tick();
    expect(h.service.storage({ op: 'list', resourceId: b.resourceId })).toEqual({
      op: 'list',
      keys: [],
    });

    tick();
    h.service.storage({ op: 'set', resourceId: a.resourceId, key: 'note', value: '第二' });
    tick();
    h.service.storage({ op: 'set', resourceId: a.resourceId, key: 'alpha', value: 1 });
    tick();
    expect(h.service.storage({ op: 'list', resourceId: a.resourceId })).toEqual({
      op: 'list',
      keys: ['alpha', 'count', 'note'],
    });

    tick();
    h.service.storage({ op: 'delete', resourceId: a.resourceId, key: 'note' });
    tick();
    expect(h.service.storage({ op: 'get', resourceId: a.resourceId, key: 'note' }).found).toBe(false);
    // 删除不存在的键是幂等的。
    tick();
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
    now += 1100;
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'k', value: undefined })).toThrow(
      /INVALID_INPUT|undefined/,
    );
    now += 1100;
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'k', value: cyclic })).toThrow(
      /INVALID_INPUT|JSON/,
    );
    // null / 0 / 空串等 falsy 值是合法 JSON，可以存。
    now += 1100;
    expect(h.service.storage({ op: 'set', resourceId, key: 'zero', value: 0 }).op).toBe('set');
    now += 1100;
    expect(h.service.storage({ op: 'get', resourceId, key: 'zero' })).toEqual({
      op: 'get',
      found: true,
      value: 0,
    });
  });

  it('配额：单值 / 总字节 / 键数超限 → WIDGET_STORAGE_QUOTA；覆盖旧键不受键数限制', () => {
    const h2 = makeHarness();
    seed(h2.db);
    const { resourceId } = createAndOpen(h2.service, h2.cards);
    // 每次调用前推进时钟，让限速窗口永不命中（本用例只测配额）。
    const tick = (): void => {
      now += 1100;
    };
    const set = (key: string, value: unknown): { op: string } => {
      tick();
      return h2.service.storage({ op: 'set', resourceId, key, value });
    };

    // 单值上限（256KB 序列化字节，引号也算）。
    tick();
    expect(() =>
      h2.service.storage({ op: 'set', resourceId, key: 'big', value: 'x'.repeat(256 * 1024) }),
    ).toThrow(/过大/);

    // 总配额：4 × 220KB 可写，第 5 块触顶。
    const chunk = 'y'.repeat(220_000);
    for (let i = 0; i < 4; i += 1) expect(set(`k${i}`, chunk).op).toBe('set');
    tick();
    expect(() => h2.service.storage({ op: 'set', resourceId, key: 'k4', value: chunk })).toThrow(
      /存储空间已用完/,
    );
    // 覆盖已有键：释放旧值体积后可以继续写。
    expect(set('k0', 'small').op).toBe('set');

    // 键数上限：清掉大键后恰好补到 1000 键，新键被拒。
    for (const key of ['k1', 'k2', 'k3']) {
      tick();
      h2.service.storage({ op: 'delete', resourceId, key });
    }
    for (let i = 1; i < 1000; i += 1) expect(set(`key-${i}`, 1).op).toBe('set');
    expect(() => set('one-too-many', 1)).toThrow(/键数量/);
    // 满键数时覆盖旧键仍允许。
    expect(set('key-5', 2).op).toBe('set');
  });

  it('限速：每资源每秒 5 次（滚动窗口），超限 WIDGET_RATE_LIMITED；窗口滑过后恢复', () => {
    const { resourceId } = createAndOpen(h.service, h.cards);
    for (let i = 0; i < 5; i += 1) {
      expect(h.service.storage({ op: 'set', resourceId, key: `k${i}`, value: i }).op).toBe('set');
    }
    expect(() => h.service.storage({ op: 'set', resourceId, key: 'k5', value: 5 })).toThrow(
      /WIDGET_RATE_LIMITED|频繁/,
    );
    // 另一个资源不受影响（限速按资源计）。
    const other = createAndOpen(h.service, h.cards);
    expect(h.service.storage({ op: 'set', resourceId: other.resourceId, key: 'k', value: 1 }).op).toBe('set');
    // 窗口滑过：恢复可用。
    now += 1001;
    expect(h.service.storage({ op: 'set', resourceId, key: 'k5', value: 5 }).op).toBe('set');
  });

  it('resourceId 过期 / 未知 → WIDGET_RESOURCE_EXPIRED（storage 与 openLink 一致）', async () => {
    const h2 = makeHarness(50);
    seed(h2.db);
    const { resourceId } = createAndOpen(h2.service, h2.cards);
    now += 100;
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

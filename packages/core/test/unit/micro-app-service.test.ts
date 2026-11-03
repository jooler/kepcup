import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOT_WIDGET_CARD_TYPE,
  MICRO_APP_SDK_MARKER,
  buildWidgetRuntimeCspHeader,
  microAppCapabilityFingerprint,
  type Message,
  type WidgetCard,
} from '@kepcup/shared';
import { WIDGET_SDK_MARKER } from '../../src/widgets/sdk-injection.js';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { WidgetService } from '../../src/widgets/service.js';
import { WidgetResourceStore, widgetUiHostFor } from '../../src/widgets/resource-store.js';
import { runMicroAppPreflight } from '../../src/micro-apps/preflight.js';

/**
 * 微应用（D112，设计 55）：清单落库与卡片描述符、版本双指针（next_version）、
 * 生效版本解析、net 档位 CSP 收紧、微应用垫片注入、预检。存量组件路径的零变化由
 * `widgets-service.test.ts` 既有用例守着，这里只测增量。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'micro-app-service-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_000;
const clock = { now: () => now };
const DB_KEY = deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb);

let db: SqliteDatabase;
let service: WidgetService;
let cards: Message[];
const byId = new Map<string, Message>();

beforeEach(() => {
  const file = path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`);
  db = openDatabase({ path: file, key: DB_KEY });
  runMigrations(db, migrationsUrl('main'));
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_a', 'A', '{}', 'active', 1, 1)",
  ).run();
  db.prepare("insert into conversations (id, type, created_at) values ('conv_1', 'direct', 1)").run();
  cards = [];
  byId.clear();
  service = new WidgetService(
    {
      db,
      messages: {
        append: (input) => {
          const message: Message = {
            id: `msg_${cards.length + 1}`,
            conversationId: input.conversationId,
            seq: cards.length + 1,
            senderType: 'system',
            senderBotId: null,
            kind: 'card',
            content: { cardType: input.cardType, approvalId: '', widget: input.cardWidget },
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
      shell: { openExternal: async () => ({ ok: true }) },
      queryRunner: {
        run: async () => {
          throw new Error('query runner not used in these cases');
        },
        dispose: () => undefined,
      },
      clock,
      logger: { warn: () => undefined },
    },
    new WidgetResourceStore({ clock }),
  );
});

afterEach(() => {
  service.dispose();
  db.close();
});

const HTML = '<!DOCTYPE html><html><head><title>x</title></head><body><button id="b">1</button></body></html>';

const MANIFEST = {
  spec: 'kepcup-micro-app/1',
  slug: 'english-corner',
  name: '小小英语角',
  description: '口语练习',
  entry: 'index.html',
  permissions: ['storage.kv', 'host.reply'],
};

function cardOfLast(): WidgetCard {
  const content = cards[cards.length - 1]!.content as { cardType: string; widget: WidgetCard };
  expect(content.cardType).toBe(BOT_WIDGET_CARD_TYPE);
  return content.widget;
}

function createMicroApp(): { widgetId: string; messageId: string } {
  const created = service.create({
    botId: 'bot_a',
    conversationId: 'conv_1',
    title: '小小英语角',
    description: '',
    html: HTML,
    scope: 'conversation',
    runId: 'r',
    manifest: MANIFEST,
  });
  expect(created.ok).toBe(true);
  const messageId = cards[cards.length - 1]!.id;
  return { widgetId: created.ok ? created.widgetId : '', messageId };
}

describe('清单校验（交付裁决）', () => {
  it('声明未实现的能力 → 拒绝并点名能力与阶段', () => {
    const result = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
      manifest: { ...MANIFEST, permissions: ['storage.kv', 'ai.chat'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('ai.chat');
  });

  it('未知 spec 版本 → 如实拒绝（不静默降级）', () => {
    const result = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
      manifest: { ...MANIFEST, spec: 'kepcup-micro-app/9' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('不认识');
  });

  it('allowlist 缺域名 / 域名形状不对 / entry 非 index.html → 拒绝', () => {
    const base = { botId: 'bot_a', conversationId: 'conv_1', title: 't', description: '', html: HTML, scope: 'conversation' as const, runId: 'r' };
    expect(service.create({ ...base, manifest: { ...MANIFEST, net: { mode: 'allowlist', allowlist: [] } } }).ok).toBe(false);
    expect(service.create({ ...base, manifest: { ...MANIFEST, net: { mode: 'allowlist', allowlist: ['https://a.com/x'] } } }).ok).toBe(false);
    expect(service.create({ ...base, manifest: { ...MANIFEST, entry: 'main.html' } }).ok).toBe(false);
  });

  it('入口 HTML 内嵌旧版组件垫片 → 拒绝（防 v1 垫片覆盖桥 v2 客户端）', () => {
    const result = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: `<!DOCTYPE html><html><body><script>/* kepcup-widget-sdk-v2 */ window.kepcup = {};</script></body></html>`,
      scope: 'conversation',
      runId: 'r',
      manifest: MANIFEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('垫片');
  });
});

describe('落库与卡片描述符', () => {
  it('卡片带清单摘要 / 指纹 / bundle 摘要；同指纹不同代码 bundle 变', () => {
    const { widgetId } = createMicroApp();
    const card = cardOfLast();
    expect(card.microApp?.name).toBe('小小英语角');
    expect(card.microApp?.permissions).toEqual(['storage.kv', 'host.reply']);
    expect(card.microApp?.netMode).toBe('open');
    expect(card.capabilityFingerprint).toBe(
      microAppCapabilityFingerprint(['storage.kv', 'host.reply'], { mode: 'open', allowlist: [] }),
    );
    const firstBundle = card.bundleSha256;
    expect(firstBundle).toMatch(/^[0-9a-f]{64}$/);
    // 只改代码、不动清单：指纹不变，bundle 变（沿用确认的判定基础）。
    const updated = service.update({
      botId: 'bot_a',
      widgetId,
      html: `${HTML}<!-- v2 -->`,
      changeNote: '',
      runId: 'r2',
      manifest: MANIFEST,
    });
    expect(updated.ok).toBe(true);
    const card2 = cardOfLast();
    expect(card2.capabilityFingerprint).toBe(card.capabilityFingerprint);
    expect(card2.bundleSha256).not.toBe(firstBundle);
  });

  it('清单里的查询模板随版本登记，走预审闸门', () => {
    const created = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
      manifest: {
        ...MANIFEST,
        queries: [{ name: 'kv_all', sql: 'select key, value_json from widget_kv order by key' }],
      },
    });
    expect(created.ok).toBe(true);
    const card = cardOfLast();
    expect(card.queriesCount).toBe(1);
    const messageId = cards[cards.length - 1]!.id;
    // 未展开审查 → 拒绝 open（与存量组件同一道闸门）。
    expect(() => service.open({ messageId })).toThrowError(/审查/);
    service.source(messageId);
    expect(() => service.open({ messageId })).not.toThrow();
  });

  it('存量组件路径：卡片无微应用字段，open 输出无清单（零变化）', () => {
    service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    const card = cardOfLast();
    expect(card.microApp).toBeUndefined();
    expect(card.capabilityFingerprint).toBeUndefined();
    const opened = service.open({ messageId: cards[cards.length - 1]!.id });
    expect(opened.microApp).toBeUndefined();
    expect(opened.capabilityFingerprint).toBeUndefined();
  });

  it('形态切换被拒：存量组件不能升级为微应用，微应用不能丢清单', () => {
    const legacy = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    expect(legacy.ok && service.update({ botId: 'bot_a', widgetId: legacy.widgetId, html: HTML, changeNote: '', runId: 'r2', manifest: MANIFEST }).ok).toBe(false);
    const { widgetId } = createMicroApp();
    const dropped = service.update({ botId: 'bot_a', widgetId, html: HTML, changeNote: '', runId: 'r3' });
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.message).toContain('清单');
  });
});

describe('版本双指针（55 §9.1）', () => {
  it('微应用更新置 next_version：旧卡重新打开即生效版本，回退指针即回退', () => {
    const { widgetId, messageId } = createMicroApp();
    const first = service.open({ messageId });
    expect(first.version).toBe(1);
    service.update({
      botId: 'bot_a',
      widgetId,
      html: `${HTML}<!-- v2 -->`,
      changeNote: '',
      runId: 'r2',
      manifest: MANIFEST,
    });
    // 旧卡（钉 v1）重新打开 → 生效 v2（不热替换运行中的实例，重开生效）。
    const reopened = service.open({ messageId });
    expect(reopened.version).toBe(2);
    // 新卡钉 v2，同样开 v2。
    const newCardId = cards[cards.length - 1]!.id;
    expect(service.open({ messageId: newCardId }).version).toBe(2);
    // 回退：指针指回 v1（模拟管理页操作，P2 落 UI 前直接验证语义）。
    db.prepare('update widgets set next_version = 1 where id = ?').run(widgetId);
    expect(service.open({ messageId }).version).toBe(1);
    // 指向被修剪的版本 → 既有「已不存在」口径。
    db.prepare('update widgets set next_version = 99 where id = ?').run(widgetId);
    expect(() => service.open({ messageId })).toThrowError(/不存在/);
  });

  it('存量组件更新不动指针：旧卡永远开旧版（零变化）', () => {
    const legacy = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    expect(legacy.ok).toBe(true);
    const oldCardId = cards[cards.length - 1]!.id;
    service.update({
      botId: 'bot_a',
      widgetId: legacy.ok ? legacy.widgetId : '',
      html: `${HTML}<!-- v2 -->`,
      changeNote: '',
      runId: 'r2',
    });
    const row = db.prepare('select next_version from widgets where id = ?').get(legacy.ok ? legacy.widgetId : '') as {
      next_version: number | null;
    };
    expect(row.next_version).toBeNull();
    expect(service.open({ messageId: oldCardId }).version).toBe(1);
    expect(service.open({ messageId: cards[cards.length - 1]!.id }).version).toBe(2);
  });
});

describe('运行面：垫片与 CSP', () => {
  it('微应用注入桥 v2 垫片 + CSP 按清单 net 档位收紧；存量组件走原垫片原 CSP', () => {
    const { messageId } = createMicroApp();
    const opened = service.open({ messageId });
    const resource = service.resource({ resourceId: opened.resourceId, host: widgetUiHostFor(opened.widgetId) });
    expect(resource.html).toContain(MICRO_APP_SDK_MARKER);
    expect(resource.html).not.toContain(WIDGET_SDK_MARKER);
    expect(resource.csp).toBe(buildWidgetRuntimeCspHeader());

    const tight = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't2',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
      manifest: { ...MANIFEST, net: { mode: 'allowlist', allowlist: ['api.example.com'] } },
    });
    expect(tight.ok).toBe(true);
    const tightOpen = service.open({ messageId: cards[cards.length - 1]!.id });
    const tightRes = service.resource({
      resourceId: tightOpen.resourceId,
      host: widgetUiHostFor(tightOpen.widgetId),
    });
    expect(tightRes.csp).toContain('connect-src https://api.example.com');

    const offline = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't3',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
      manifest: { ...MANIFEST, net: { mode: 'none' } },
    });
    expect(offline.ok).toBe(true);
    const offlineOpen = service.open({ messageId: cards[cards.length - 1]!.id });
    const offlineRes = service.resource({
      resourceId: offlineOpen.resourceId,
      host: widgetUiHostFor(offlineOpen.widgetId),
    });
    expect(offlineRes.csp).toContain("connect-src 'none'");

    // 存量组件：v2 组件垫片 + 未收紧 CSP（既有断言在 widgets-service.test.ts，这里再钉一次分界）。
    service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 'legacy',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    const legacyOpen = service.open({ messageId: cards[cards.length - 1]!.id });
    const legacyRes = service.resource({
      resourceId: legacyOpen.resourceId,
      host: widgetUiHostFor(legacyOpen.widgetId),
    });
    expect(legacyRes.html).toContain(WIDGET_SDK_MARKER);
    expect(legacyRes.csp).toBe(buildWidgetRuntimeCspHeader());
  });

  it('open 输出带清单摘要 / 指纹 / bundle 摘要（渲染端确认记忆的依据）', () => {
    const { messageId } = createMicroApp();
    const opened = service.open({ messageId });
    expect(opened.microApp?.slug).toBe('english-corner');
    expect(opened.capabilityFingerprint).toBe(cardOfLast().capabilityFingerprint);
    expect(opened.bundleSha256).toBe(cardOfLast().bundleSha256);
  });

  it('publish 发卡不丢微应用字段（审查修复 F1：降级回组件运行时 = 双运行时）', () => {
    const { widgetId } = createMicroApp();
    // 升到 bot 级（publish 只接受 bot 级）。
    db.prepare("update widgets set scope = 'bot', conversation_id = null where id = ?").run(widgetId);
    const published = service.publish({ botId: 'bot_a', widgetId, conversationId: 'conv_1', runId: null });
    expect(published.ok).toBe(true);
    const card = cardOfLast();
    expect(card.microApp?.slug).toBe('english-corner');
    expect(card.capabilityFingerprint).toMatch(/storage\.kv/);
    // 发出的卡按微应用路径打开（v2 垫片 + 指纹）。
    const opened = service.open({ messageId: cards[cards.length - 1]!.id });
    expect(opened.microApp).toBeDefined();
    const resource = service.resource({ resourceId: opened.resourceId, host: widgetUiHostFor(opened.widgetId) });
    expect(resource.html).toContain('kepcup-micro-app-sdk-v1');
  });

  it('续期钉住运行中的版本（审查修复 F4：升级不热替换在跑实例）', () => {
    const { widgetId, messageId } = createMicroApp();
    expect(service.open({ messageId }).version).toBe(1);
    service.update({
      botId: 'bot_a',
      widgetId,
      html: `${HTML}<!-- v2 -->`,
      changeNote: '',
      runId: 'r2',
      manifest: MANIFEST,
    });
    // 续期（pinVersion=1）：仍是 v1，即便 next_version 已指向 v2。
    expect(service.open({ messageId, pinVersion: 1 }).version).toBe(1);
    // 全新打开：v2（双指针生效）。
    expect(service.open({ messageId }).version).toBe(2);
    // 存量组件忽略 pinVersion（本来就钉卡片版本）。
    const legacy = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 'legacy',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r3',
    });
    expect(legacy.ok).toBe(true);
    service.update({
      botId: 'bot_a',
      widgetId: legacy.ok ? legacy.widgetId : '',
      html: `${HTML}<!-- v2 -->`,
      changeNote: '',
      runId: 'r4',
    });
    const legacyCardId = cards[cards.length - 1]!.id;
    expect(service.open({ messageId: legacyCardId, pinVersion: 99 }).version).toBe(2);
  });
});

describe('能力可用性预检（microApps.preflight 的服务面）', () => {
  it('生效版本逐能力预检：可用 / 不可用 + 设置深链；未注册探针视为可用', () => {
    const { messageId } = createMicroApp();
    const effective = service.effectiveMicroAppOf(messageId);
    expect(effective?.microApp.manifest.permissions).toEqual(['storage.kv', 'host.reply']);
    const items = runMicroAppPreflight(effective!.microApp.manifest.permissions, {
      'storage.kv': () => ({
        available: false,
        reason: '数据库不可用',
        settingDeepLink: { section: 'storage' },
      }),
    });
    expect(items).toEqual([
      { capability: 'storage.kv', available: false, reason: '数据库不可用', settingDeepLink: { section: 'storage' } },
      { capability: 'host.reply', available: true },
    ]);
  });

  it('存量组件卡没有预检面（null）', () => {
    service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: 't',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: 'r',
    });
    expect(service.effectiveMicroAppOf(cards[cards.length - 1]!.id)).toBeNull();
  });
});

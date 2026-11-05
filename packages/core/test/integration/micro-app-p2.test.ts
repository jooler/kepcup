import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect, step } from '@kepcup/testkit';
import type { CoreHarness, TestStack } from '@kepcup/testkit';
import { buildConversationContext } from '../../src/agent/context/conversation.js';
import { widgetUiHostFor } from '../../src/widgets/resource-store.js';

/**
 * 微应用 P2（D112，设计 55 §4 / §8.5 / §9.4 / §10 / §14）：多文件包与路径子资源、
 * collections、query 分页、context.update（last-wins + 注入 + 手势时机）、运行时诊断
 * （记录 / 去重推送 / 按需读）、管理入口（列表 / 回退 / 清除摘要）。
 */

let stack: TestStack;
let core: CoreHarness;
let botId: string;
let conversationId: string;

beforeAll(async () => {
  stack = await createTestStack();
  core = stack.core;
  const bot = await makeBot(core, 'Emma');
  botId = bot.id;
  const conversation = await openDirect(core, botId);
  conversationId = conversation.id;
});

afterAll(async () => {
  await stack.cleanup();
});

const HTML = '<!DOCTYPE html><html><body><link rel="stylesheet" href="main.css" /></body></html>';

async function createMicroApp(permissions: string[], files?: Array<{ path: string; mime: string; contentBase64: string }>): Promise<{ widgetId: string; messageId: string }> {
  const created = core.services.widgets!.create({
    botId,
    conversationId,
    title: '小小英语角',
    description: '',
    html: HTML,
    scope: 'conversation',
    runId: '',
    manifest: {
      spec: 'kepcup-micro-app/1',
      slug: 'english-corner',
      name: '小小英语角',
      description: '',
      entry: 'index.html',
      permissions,
    },
    ...(files !== undefined ? { files } : {}),
  });
  if (!created.ok) throw new Error(created.message);
  const listed = (await core.rpc.call('messages.list', { conversationId, limit: 30 })) as {
    messages: Array<{ id: string; kind: string }>;
  };
  // list 升序返回：reverse 后取最新的卡（会话累积多张卡时窗口加大保证命中）。
  const card = [...listed.messages].reverse().find((message) => message.kind === 'card');
  if (card === undefined) throw new Error('card message not found');
  return { widgetId: created.widgetId, messageId: card.id };
}

async function openResource(messageId: string): Promise<string> {
  const opened = (await core.rpc.call('widgets.ui.open', { messageId })) as { resourceId: string };
  return opened.resourceId;
}

describe('P2 多文件包', () => {
  it('包内文件按版本落库，子资源经 widgets.ui.resource 的 path 取回（字节一致）', async () => {
    const css = Buffer.from('body{color:red}').toString('base64');
    const app = await createMicroApp(['storage.kv'], [{ path: 'main.css', mime: 'text/css', contentBase64: css }]);
    const resourceId = await openResource(app.messageId);
    const resource = core.services.widgets!.resource({
      resourceId,
      host: widgetUiHostFor(app.widgetId),
      path: 'main.css',
    });
    expect(Buffer.from(resource.contentBase64 ?? '', 'base64').toString()).toBe('body{color:red}');
    expect(resource.mimeType).toBe('text/css');
    // 未登记的路径 / 穿越 → 拒绝。
    expect(() => core.services.widgets!.resource({ resourceId, path: '../x' })).toThrow();
    expect(() => core.services.widgets!.resource({ resourceId, path: 'nope.png' })).toThrow();
  });

  it('不安全路径 / 超限文件在交付时拒绝', async () => {
    const bad = core.services.widgets!.create({
      botId,
      conversationId,
      title: 'x',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: '',
      manifest: { spec: 'kepcup-micro-app/1', slug: 'x', name: 'x', entry: 'index.html', permissions: [] },
      files: [{ path: '../evil.js', mime: 'text/javascript', contentBase64: 'AAAA' }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('P2 collections', () => {
  it('put / get / list / query / delete + 未声明能力拒绝', async () => {
    const app = await createMicroApp(['storage.kv', 'storage.collection']);
    const resourceId = await openResource(app.messageId);
    const ref = { resourceId, instanceId: 'mai_p2_col' };
    await core.rpc.call('microApps.collections.put', {
      ...ref,
      name: 'lessons',
      doc: { id: 'l1', title: 'Greetings', done: true },
    });
    await core.rpc.call('microApps.collections.put', {
      ...ref,
      name: 'lessons',
      doc: { id: 'l2', title: 'Numbers', done: false },
    });
    const got = (await core.rpc.call('microApps.collections.get', { ...ref, name: 'lessons', id: 'l1' })) as {
      doc: { id: string; title: string };
    };
    expect(got.doc.title).toBe('Greetings');
    const listed = (await core.rpc.call('microApps.collections.list', { ...ref, name: 'lessons' })) as {
      docs: Array<{ id: string }>;
    };
    expect(listed.docs.map((doc) => doc.id)).toEqual(['l1', 'l2']);
    const queried = (await core.rpc.call('microApps.collections.query', {
      ...ref,
      name: 'lessons',
      where: [{ field: 'done', op: 'eq', value: true }],
      limit: 10,
    })) as { docs: Array<{ id: string }> };
    expect(queried.docs.map((doc) => doc.id)).toEqual(['l1']);
    await core.rpc.call('microApps.collections.delete', { ...ref, name: 'lessons', id: 'l2' });
    // 未声明 storage.collection 的微应用 → 拒绝。
    const bare = await createMicroApp(['storage.kv']);
    const bareResource = await openResource(bare.messageId);
    await expect(
      core.rpc.call('microApps.collections.put', {
        resourceId: bareResource,
        instanceId: 'mai_p2_bare',
        name: 'lessons',
        doc: { id: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'MICRO_APP_CAPABILITY_NOT_DECLARED' });
  });
});

describe('P2 context.update（55 §8.5）', () => {
  it('结构化摘要 last-wins、进下一轮模型上下文、自由文本字段被拒、可清除', async () => {
    const app = await createMicroApp(['context.update']);
    const resourceId = await openResource(app.messageId);
    const ref = { resourceId, instanceId: 'mai_p2_ctx' };
    await core.rpc.call('microApps.context.update', {
      ...ref,
      summary: { headline: '完成了第 3 课，错 2 个', data: { lesson: 3, wrong: 2 } },
      reason: 'gesture',
    });
    await core.rpc.call('microApps.context.update', {
      ...ref,
      summary: { headline: '完成了第 4 课' },
      reason: 'gesture',
    });
    // 自由文本数组被 schema 拒。
    await expect(
      core.rpc.call('microApps.context.update', {
        ...ref,
        summary: { headline: 'x', data: { blob: 'y' }, extra: 1 } as never,
        reason: 'gesture',
      }),
    ).rejects.toThrow();
    // 注入下一轮：buildConversationContext 的 micro_app_context 段。
    const summaries = core.services.microAppStore!.contextForConversation(conversationId);
    expect(summaries[0]?.headline).toBe('完成了第 4 课');
    const segment = buildConversationContext({
      summary: null,
      recent: [],
      options: { selfBotId: botId } as never,
      microAppSummaries: summaries.map((entry) => ({
        widgetId: entry.widgetId,
        title: '小小英语角',
        headline: entry.headline,
        dataJson: entry.dataJson,
        version: entry.version,
      })),
    });
    expect(segment).toContain('<untrusted source="micro-app-context" meta="');
    expect(segment).toContain(`widget=${app.widgetId},version=`);
    expect(segment).toContain('完成了第 4 课');
    // 撤销能力（清除入口在管理页）。
    await core.rpc.call('microApps.clearContext', { botId, widgetId: app.widgetId });
    expect(core.services.microAppStore!.contextForConversation(conversationId)).toHaveLength(0);
  });
});

describe('P2 诊断回流（55 §9.4）', () => {
  it('记录去重 + 首次推送系统消息（同 code 当天不重复）+ 按需读 + 表里无内容', async () => {
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    const ref = { resourceId, instanceId: 'mai_p2_diag' };
    const before = (await core.rpc.call('messages.list', { conversationId: conversationId, limit: 50 })) as {
      messages: unknown[];
    };
    for (let i = 0; i < 3; i += 1) {
      await core.rpc.call('microApps.diagnostics.record', {
        ...ref,
        phase: 'run',
        code: 'TypeError',
        detail: 'index.html:42:7',
      });
    }
    // 计数聚合为 3；系统消息只推 1 条（同 code 当天）。
    // 工具面不走 RPC；直接读 store。
    const result = core.services.microAppStore!.diagnosticsRead(app.widgetId);
    expect(result.entries[0]?.code).toBe('TypeError');
    expect(result.entries[0]?.count).toBe(3);
    expect(result.entries[0]?.detail).toBe('index.html:42:7');
    const after = (await core.rpc.call('messages.list', { conversationId, limit: 50 })) as {
      messages: Array<{ id: string; kind: string }>;
    };
    expect(after.messages.length).toBe(before.messages.length + 1);
    // 再来一个不同 code → 再推一条；同 code → 不推。
    await core.rpc.call('microApps.diagnostics.record', { ...ref, phase: 'run', code: 'TypeError', detail: '' });
    await core.rpc.call('microApps.diagnostics.record', { ...ref, phase: 'stream', code: 'MICRO_APP_AI_QUOTA', detail: 'ai.chat' });
    const after2 = (await core.rpc.call('messages.list', { conversationId, limit: 50 })) as {
      messages: unknown[];
    };
    expect(after2.messages.length).toBe(after.messages.length + 1);
    // §15.14：表里只有 code / 阶段 / 位置 / 次数——没有 message 列。
    const cols = core.services.mainDb!
      .prepare('pragma table_info(micro_app_diagnostics)')
      .all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).not.toContain('message');
    // 推送去重登记持久化（审查 P1-3）：同 (widget, version, code) 当天一条登记，
    // core 重启 / 标记溢出后仍不重推。
    const pushes = core.services.mainDb!
      .prepare('select code from micro_app_diag_pushes where widget_id = ?')
      .all(app.widgetId) as Array<{ code: string }>;
    expect(pushes.map((row) => row.code).sort()).toEqual(['MICRO_APP_AI_QUOTA', 'TypeError']);
  });
});

describe('P2 管理入口', () => {
  it('microApps.list 带清单 / 用量 / 诊断 / 摘要；rollback 指回旧版本', async () => {
    stack.llm.script('mock-light', [step().replyText('v1 ok')]);
    const app = await createMicroApp(['ai.chat']);
    const first = await openResource(app.messageId);
    await core.rpc.call('microApps.ai.chat', {
      resourceId: first,
      instanceId: 'mai_p2_mgmt',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    // 更新到 v2（next_version 指向 2）。
    core.services.widgets!.update({
      botId,
      widgetId: app.widgetId,
      html: `${HTML}<!-- v2 -->`,
      changeNote: '',
      runId: '',
      manifest: {
        spec: 'kepcup-micro-app/1',
        slug: 'english-corner',
        name: '小小英语角',
        description: '',
        entry: 'index.html',
        permissions: ['ai.chat', 'storage.kv'],
      },
    });
    const list = (await core.rpc.call('microApps.list', { botId })) as {
      items: Array<{ widgetId: string; version: number; nextVersion: number | null; usage: { aiTokens: number }; netMode: string; permissions: string[] }>;
    };
    const mine = list.items.find((item) => item.widgetId === app.widgetId);
    expect(mine?.version).toBe(2);
    expect(mine?.nextVersion).toBe(2);
    expect(mine?.usage.aiTokens).toBeGreaterThan(0);
    expect(mine?.netMode).toBe('open');
    expect(mine?.permissions).toEqual(['ai.chat', 'storage.kv']);
    // 回退到 v1：next_version=1；被修剪的版本拒绝。
    const rollback = (await core.rpc.call('microApps.rollback', { botId, widgetId: app.widgetId, version: 1 })) as {
      ok: boolean;
    };
    expect(rollback.ok).toBe(true);
    const pruned = (await core.rpc.call('microApps.rollback', { botId, widgetId: app.widgetId, version: 99 })) as {
      ok: boolean;
      message?: string;
    };
    expect(pruned.ok).toBe(false);
    expect(pruned.message).toContain('不存在');
    // 回退后 list 按**展示版本**取清单（审查 P2-3）：显示 v1 的权限面，而不是新版。
    const afterRollback = (await core.rpc.call('microApps.list', { botId })) as {
      items: Array<{ widgetId: string; version: number; permissions: string[] }>;
    };
    const rolled = afterRollback.items.find((item) => item.widgetId === app.widgetId);
    expect(rolled?.version).toBe(1);
    expect(rolled?.permissions).toEqual(['ai.chat']);
  });
});

describe('P2 query 分页', () => {
  it('cursor / maxBytes 分页，不传 = 存量行为', async () => {
    const app = await createMicroApp(['storage.kv']);
    const resourceId = await openResource(app.messageId);
    // 预置查询模板（conversation_messages 视图）。
    core.services.mainDb!
      .prepare('insert into widget_queries (widget_id, version, name, sql) values (?, ?, ?, ?)')
      .run(app.widgetId, 1, 'all_texts', 'select id, text from conversation_messages order by seq');
    // 造足够的文本消息（conversation_messages 视图只暴露 kind='text'）。
    const insert = core.services.mainDb!.prepare(
      "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, status, created_at) values (?, ?, ?, 'user', 'text', ?, 'normal', ?)",
    );
    for (let i = 0; i < 12; i += 1) {
      insert.run(`msg_pag_${i}`, conversationId, 9000 + i, JSON.stringify({ text: `分页测试消息 ${i} `.repeat(20) }), 1);
    }
    const base = { resourceId, name: 'all_texts', params: {} };
    const full = (await core.rpc.call('widgets.ui.query', base)) as { rows: Array<{ id: string }> };
    // 全量至少两行才谈得上分页。
    expect(full.rows.length).toBeGreaterThanOrEqual(12);
    const page1 = (await core.rpc.call('widgets.ui.query', { ...base, maxBytes: 1024 })) as {
      rows: Array<{ id: string }>;
      truncated: boolean;
      nextCursor?: string;
    };
    expect(page1.truncated).toBe(true);
    expect(typeof page1.nextCursor).toBe('string');
    const page2 = (await core.rpc.call('widgets.ui.query', {
      ...base,
      maxBytes: 1024,
      cursor: page1.nextCursor,
    })) as { rows: Array<{ id: string }>; truncated: boolean };
    expect(page2.rows.length).toBeGreaterThan(0);
    // 两页不重叠。
    const ids1 = new Set(page1.rows.map((row) => row.id));
    expect(page2.rows.some((row) => ids1.has(row.id))).toBe(false);
    // 不带分页参数：无 nextCursor（存量零变化）。
    const plain = (await core.rpc.call('widgets.ui.query', base)) as { nextCursor?: string };
    expect(plain.nextCursor).toBeUndefined();
  });
});


describe('P2 collections 配额（审查 P1-2：按 UTF-8 字节）', () => {
  it('10 集合上限：第 11 个新名字被拒，既有名字可覆写', async () => {
    const app = await createMicroApp(['storage.kv', 'storage.collection']);
    const resourceId = await openResource(app.messageId);
    const ref = { resourceId, instanceId: 'mai_p2_quota' };
    for (let i = 0; i < 10; i += 1) {
      await core.rpc.call('microApps.collections.put', { ...ref, name: `col_${i}`, doc: { id: 'a' } });
    }
    await expect(
      core.rpc.call('microApps.collections.put', { ...ref, name: 'col_new', doc: { id: 'a' } }),
    ).rejects.toMatchObject({ code: 'WIDGET_STORAGE_QUOTA' });
    // 覆写既有集合不占新名额。
    await core.rpc.call('microApps.collections.put', { ...ref, name: 'col_0', doc: { id: 'a', v: 2 } });
  });

  it('总量按字节计：CJK 文档字符数远小于字节数，超出 5MB 拒绝', async () => {
    const app = await createMicroApp(['storage.kv', 'storage.collection']);
    const resourceId = await openResource(app.messageId);
    const ref = { resourceId, instanceId: 'mai_p2_bytes' };
    // 直接种一个「字符数 < 5M、字节数 ≈ 4.7MB」的 CJK 大文档（旧实现按字符数会漏判）。
    const big = '中'.repeat(1_560_000); // ≈ 4.68MB UTF-8 / 1.56M 字符
    core.services.mainDb!
      .prepare('insert into micro_app_collections (widget_id, name, id, doc_json, updated_at) values (?, ?, ?, ?, ?)')
      .run(app.widgetId, 'huge', 'seed', JSON.stringify({ id: 'seed', v: big }), 1);
    const extra = 'x'.repeat(700_000); // 0.7MB ASCII（叠加上后总字节 > 5MB）
    await expect(
      core.rpc.call('microApps.collections.put', { ...ref, name: 'more', doc: { id: 'e', v: extra } }),
    ).rejects.toMatchObject({ code: 'WIDGET_STORAGE_QUOTA' });
    // 覆写既有大文档为小文档：扣减旧行字节后总量有余量 → 放行。
    await core.rpc.call('microApps.collections.put', { ...ref, name: 'huge', doc: { id: 'seed', v: 'ok' } });
  });
});

describe('P2 诊断推送闸（审查 P1-1 / P2-1）', () => {
  it('推送文本 ≤300 字；换 code 刷不了屏（每日上限）', async () => {
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    const ref = { resourceId, instanceId: 'mai_p2_cap' };
    const countSystem = (): number =>
      Number(
        (
          core.services.mainDb!
            .prepare("select count(*) as n from messages where conversation_id = ? and sender_type = 'system'")
            .get(conversationId) as { n: number | bigint }
        ).n,
      );
    // code 80 + detail 200 + 前缀 ≈ 370 字 → 截到 ≤300（审查 P1-1：slice 对整串生效）。
    const before = countSystem();
    await core.rpc.call('microApps.diagnostics.record', {
      ...ref,
      phase: 'run',
      code: 'E'.repeat(80),
      detail: 'd'.repeat(200),
    });
    const row = core.services.mainDb!
      .prepare(
        "select content_json from messages where conversation_id = ? and sender_type = 'system' order by seq desc limit 1",
      )
      .get(conversationId) as { content_json: string };
    const text = (JSON.parse(row.content_json) as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain('E'.repeat(20));
    expect(countSystem()).toBe(before + 1);
    // 每日上限（每微应用 5 条）：换 4 个新 code 各推一条，第 6 个不再推。
    for (let i = 1; i <= 4; i += 1) {
      await core.rpc.call('microApps.diagnostics.record', {
        ...ref,
        phase: 'run',
        code: `CODE_${i}`,
        detail: '',
      });
    }
    expect(countSystem()).toBe(before + 5);
    await core.rpc.call('microApps.diagnostics.record', { ...ref, phase: 'run', code: 'CODE_6', detail: '' });
    expect(countSystem()).toBe(before + 5);
    const pushes = Number(
      (
        core.services.mainDb!
          .prepare('select count(*) as n from micro_app_diag_pushes where widget_id = ?')
          .get(app.widgetId) as { n: number | bigint }
      ).n,
    );
    expect(pushes).toBe(5);
  });
});

describe('P2 query 分页（审查 P1-5：runner 级截断续页）', () => {
  it('>1000 行时翻页能取到窗口之后的数据，翻完 truncated=false 收口', async () => {
    // 独立 Bot → 独立会话（openDirect 按 (user, bot) 幂等；老 Bot 会复用带旧消息的会话）。
    const pagerBot = await makeBot(core, '分页机器人');
    const conversation = await openDirect(core, pagerBot.id);
    const created = core.services.widgets!.create({
      botId,
      conversationId: conversation.id,
      title: '分页器',
      description: '',
      html: HTML,
      scope: 'conversation',
      runId: '',
      manifest: { spec: 'kepcup-micro-app/1', slug: 'pager', name: '分页器', description: '', entry: 'index.html', permissions: ['storage.kv'] },
    });
    if (!created.ok) throw new Error(created.message);
    const listed = (await core.rpc.call('messages.list', { conversationId: conversation.id, limit: 30 })) as {
      messages: Array<{ id: string; kind: string }>;
    };
    const card = [...listed.messages].reverse().find((message) => message.kind === 'card');
    if (card === undefined) throw new Error('card message not found');
    const opened = (await core.rpc.call('widgets.ui.open', { messageId: card.id })) as { resourceId: string };
    core.services.mainDb!
      .prepare('insert into widget_queries (widget_id, version, name, sql) values (?, ?, ?, ?)')
      .run(created.widgetId, 1, 'big', 'select id, text from conversation_messages order by seq');
    // 1050 行小消息：runner 内部上限 1000 → 必须靠续页游标取完。
    const insert = core.services.mainDb!.prepare(
      "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, status, created_at) values (?, ?, ?, 'user', 'text', ?, 'normal', ?)",
    );
    for (let i = 0; i < 1050; i += 1) {
      insert.run(`msg_big_${i}`, conversation.id, 10000 + i, JSON.stringify({ text: `r${i}` }), 1);
    }
    const base = { resourceId: opened.resourceId, name: 'big', params: {} };
    const page1 = (await core.rpc.call('widgets.ui.query', { ...base, maxBytes: 256 * 1024 })) as {
      rows: Array<{ id: string }>;
      truncated: boolean;
      nextCursor?: string;
    };
    expect(page1.rows).toHaveLength(1000);
    expect(page1.truncated).toBe(true);
    expect(page1.nextCursor).toBe('off:1000');
    expect(page1.rows.at(-1)?.id).toBe('msg_big_999');
    const page2 = (await core.rpc.call('widgets.ui.query', { ...base, maxBytes: 256 * 1024, cursor: page1.nextCursor })) as {
      rows: Array<{ id: string }>;
      truncated: boolean;
      nextCursor?: string;
    };
    expect(page2.rows).toHaveLength(50);
    expect(page2.truncated).toBe(false);
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.rows.at(0)?.id).toBe('msg_big_1000');
    expect(page2.rows.at(-1)?.id).toBe('msg_big_1049');
  });
});

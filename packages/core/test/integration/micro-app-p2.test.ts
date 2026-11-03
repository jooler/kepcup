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
  const listed = (await core.rpc.call('messages.list', { conversationId, limit: 5 })) as {
    messages: Array<{ id: string; kind: string }>;
  };
  const card = [...listed.messages].reverse().find((message) => message.kind === 'card');
  if (card === undefined) throw new Error('card message not found');
  return { widgetId: created.widgetId, messageId: card.id };
}

async function openResource(messageId: string): Promise<string> {
  const opened = (await core.rpc.call('widgets.ui.open', { messageId })) as { resourceId: string };
  return opened.resourceId;
}

const INSTANCE = { resourceId: '', instanceId: 'mai_p2_1' };

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
    expect(segment).toContain('<untrusted source="micro-app-context">');
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
    const read = (await core.rpc.call('microApps.diagnosticsRead' as never, { widgetId: app.widgetId } as never).catch(
      () => null,
    )) as null;
    void read; // 工具面不走 RPC；直接读 store。
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
        permissions: ['ai.chat'],
      },
    });
    const list = (await core.rpc.call('microApps.list', { botId })) as {
      items: Array<{ widgetId: string; version: number; nextVersion: number | null; usage: { aiTokens: number }; netMode: string }>;
    };
    const mine = list.items.find((item) => item.widgetId === app.widgetId);
    expect(mine?.version).toBe(2);
    expect(mine?.nextVersion).toBe(2);
    expect(mine?.usage.aiTokens).toBeGreaterThan(0);
    expect(mine?.netMode).toBe('open');
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

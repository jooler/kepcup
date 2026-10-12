import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Message } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../../src/agent/types.js';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { WidgetService } from '../../src/widgets/service.js';
import type { WidgetQueryExecutor } from '../../src/widgets/query-runner.js';
import {
  buildWidgetTools,
  WIDGET_CREATE_TOOL,
  WIDGET_PUBLISH_TOOL,
  WIDGET_UPDATE_TOOL,
  type WidgetToolFacade,
} from '../../src/tools/widget-tools.js';
import type { WidgetCreateInput, WidgetUpdateInput, WidgetWriteResult } from '../../src/widgets/service.js';

/**
 * Bot 自制交互组件工具（D81）：参数透传与校验、无会话上下文拒绝。
 */

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_a',
  conversationId: 'conv_1',
  loopType: 'task',
};

function fakeFacade(): WidgetToolFacade & {
  creates: WidgetCreateInput[];
  updates: WidgetUpdateInput[];
  publishes: Array<{ botId: string; widgetId: string; conversationId: string; runId: string | null }>;
} {
  const creates: WidgetCreateInput[] = [];
  const updates: WidgetUpdateInput[] = [];
  const publishes: Array<{ botId: string; widgetId: string; conversationId: string; runId: string | null }> = [];
  const ok = (widgetId: string, version: number): WidgetWriteResult => ({
    ok: true,
    widgetId,
    title: '计算器',
    version,
    message: '已发布',
    cardMessageId: 'msg_ok',
  });
  return {
    creates,
    updates,
    publishes,
    create: (input) => {
      creates.push(input);
      return ok('wgt_1', 1);
    },
    update: (input) => {
      updates.push(input);
      return ok(input.widgetId, 2);
    },
    publish: (input) => {
      publishes.push(input);
      return ok(input.widgetId, 1);
    },
  };
}

describe('widget tools', () => {
  it('widget_create：缺参拒绝；成功时带 scope 缺省与 runId 调门面', async () => {
    const facade = fakeFacade();
    const [create] = buildWidgetTools({ identity, widgets: facade });
    if (create === undefined || create.name !== WIDGET_CREATE_TOOL) throw new Error('tool missing');

    const missing = await create.execute({ title: '', html: ' ' }, {} as never);
    expect(missing.ok).toBe(false);

    const ok = await create.execute(
      { title: '计算器', description: '四则', html: '<!DOCTYPE html><html></html>' },
      {} as never,
    );
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain('wgt_1');
    expect(facade.creates[0]).toMatchObject({
      botId: 'bot_a',
      conversationId: 'conv_1',
      scope: 'conversation',
      runId: 'run_1',
    });
  });

  it('widget_create：无会话上下文（群外无 conversationId）拒绝', async () => {
    const facade = fakeFacade();
    const [create] = buildWidgetTools({
      identity: { ...identity, conversationId: null },
      widgets: facade,
    });
    if (create === undefined) throw new Error('tool missing');
    const result = await create.execute({ title: 't', html: '<p></p>' }, {} as never);
    expect(result.ok).toBe(false);
    expect(facade.creates).toHaveLength(0);
  });

  it('widget_create / widget_update：queries 原样带完整清单透传（门面负责登记校验）', async () => {
    const facade = fakeFacade();
    const [create, update] = buildWidgetTools({ identity, widgets: facade });
    if (create === undefined || update === undefined) throw new Error('tool missing');

    const queries = [{ name: 'by_month', sql: 'select 1 where m = :month' }];
    await create.execute({ title: 't', html: '<p></p>', queries }, {} as never);
    expect(facade.creates[0]!.queries).toEqual(queries);
    await create.execute({ title: 't', html: '<p></p>' }, {} as never);
    expect(facade.creates[1]!.queries).toBeUndefined();

    await update.execute({ widget_id: 'wgt_1', html: '<p></p>', queries }, {} as never);
    expect(facade.updates[0]!.queries).toEqual(queries);
    // 残缺条目归一为空串（服务层给可行动的拒绝），不抛异常。
    await update.execute(
      { widget_id: 'wgt_1', html: '<p></p>', queries: [{ sql: 'select 1' }] },
      {} as never,
    );
    expect(facade.updates[1]!.queries).toEqual([{ name: '', sql: 'select 1' }]);
  });

  it('widget_create：门面 cardMessageId=null（发卡失败）→ 提示送达失败而不是谎称已发卡', async () => {
    const facade = fakeFacade();
    facade.create = () => ({
      ok: true,
      widgetId: 'wgt_9',
      title: '计算器',
      version: 1,
      message: '已保存',
      cardMessageId: null,
    });
    const [create] = buildWidgetTools({ identity, widgets: facade });
    if (create === undefined) throw new Error('tool missing');
    const result = await create.execute({ title: 't', description: '', html: '<p></p>' }, {} as never);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('未能送达');
    expect(result.content).toContain('wgt_9');
    expect(result.content).not.toContain('已作为卡片');
  });

  it('widget_create：门面 NOT_FOUND / FORBIDDEN 之外的成功路径正常', async () => {
    const facade = fakeFacade();
    facade.create = () => ({
      ok: true,
      widgetId: 'wgt_1',
      title: '计算器',
      version: 1,
      message: '已发布',
      cardMessageId: 'msg_1',
    });
    const [create] = buildWidgetTools({ identity, widgets: facade });
    if (create === undefined) throw new Error('tool missing');
    const result = await create.execute({ title: 't', description: '', html: '<p></p>' }, {} as never);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已发布');
  });

  it('widget_publish：缺参 / 无对话拒绝；成功时带 runId 调门面；失败透传 code', async () => {
    const facade = fakeFacade();
    const publish = buildWidgetTools({ identity, widgets: facade }).find(
      (tool) => tool.name === WIDGET_PUBLISH_TOOL,
    );
    if (publish === undefined) throw new Error('publish tool missing');

    const missing = await publish.execute({ widget_id: '' }, {} as never);
    expect(missing.ok).toBe(false);
    expect(facade.publishes ?? []).toHaveLength(0);

    const noConversation = buildWidgetTools({
      identity: { ...identity, conversationId: null },
      widgets: facade,
    }).find((tool) => tool.name === WIDGET_PUBLISH_TOOL);
    const refused = await noConversation!.execute({ widget_id: 'wgt_1' }, {} as never);
    expect(refused.ok).toBe(false);

    const ok = await publish.execute({ widget_id: 'wgt_7' }, {} as never);
    expect(ok.ok).toBe(true);
    expect(facade.publishes![0]).toEqual({
      botId: 'bot_a',
      widgetId: 'wgt_7',
      conversationId: 'conv_1',
      runId: 'run_1',
    });

    facade.publish = () => ({ ok: false, message: '只能引用 Bot 级组件', code: 'FORBIDDEN' });
    const failed = await publish.execute({ widget_id: 'wgt_1' }, {} as never);
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe('FORBIDDEN');

    // 落库成功但发卡失败：文案如实（带组件名与 widgetId），不谎称已发卡。
    facade.publish = () => ({
      ok: true,
      widgetId: 'wgt_7',
      title: '报表',
      version: 2,
      message: '已发卡',
      cardMessageId: null,
    });
    const notDelivered = await publish.execute({ widget_id: 'wgt_7' }, {} as never);
    expect(notDelivered.ok).toBe(true);
    expect(notDelivered.content).toContain('报表');
    expect(notDelivered.content).toContain('wgt_7');
    expect(notDelivered.content).toContain('发送失败');
  });

  it('widget_update：无执行身份（botId null）拒绝', async () => {
    const facade = fakeFacade();
    const [, update] = buildWidgetTools({
      identity: { ...identity, botId: null },
      widgets: facade,
    });
    if (update === undefined) throw new Error('tool missing');
    const result = await update.execute({ widget_id: 'wgt_1', html: '<p></p>' }, {} as never);
    expect(result.ok).toBe(false);
    expect(facade.updates).toHaveLength(0);
  });

  it('widget_update：门面失败按 code 透传错误码（NOT_FOUND）', async () => {
    const facade = fakeFacade();
    facade.update = () => ({ ok: false, message: '找不到这个组件', code: 'NOT_FOUND' });
    const [, update] = buildWidgetTools({ identity, widgets: facade });
    if (update === undefined) throw new Error('tool missing');
    const failed = await update.execute({ widget_id: 'wgt_x', html: '<p></p>' }, {} as never);
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe('NOT_FOUND');
  });

  it('widget_update：门面失败原样返回说明', async () => {
    const facade = fakeFacade();
    const [, update] = buildWidgetTools({ identity, widgets: facade });
    if (update === undefined || update.name !== WIDGET_UPDATE_TOOL) throw new Error('tool missing');

    const missingParams = await update.execute({ widget_id: '', html: '' }, {} as never);
    expect(missingParams.ok).toBe(false);

    const ok = await update.execute(
      { widget_id: 'wgt_1', html: '<p></p>', change_note: '修字号' },
      {} as never,
    );
    expect(ok.ok).toBe(true);
    expect(facade.updates[0]).toMatchObject({ widgetId: 'wgt_1', changeNote: '修字号', runId: 'run_1' });

    facade.update = () => ({
      ok: true,
      widgetId: 'wgt_1',
      title: '计算器',
      version: 3,
      message: '已更新',
      cardMessageId: null,
    });
    const undelivered = await update.execute({ widget_id: 'wgt_1', html: '<p></p>' }, {} as never);
    expect(undelivered.ok).toBe(true);
    expect(undelivered.content).toContain('卡片消息发送失败');
    expect(undelivered.content).toContain('v3');

    facade.update = () => ({ ok: false, message: '找不到这个组件' });
    const failed = await update.execute({ widget_id: 'wgt_x', html: '<p></p>' }, {} as never);
    expect(failed.ok).toBe(false);
    expect(failed.content).toContain('找不到这个组件');
  });
});

/**
 * 工具层与真实 WidgetService 的契约（回归 D81 审查 #1）：update 曾丢弃发卡结果，
 * 工具层把每次成功的 widget_update 都报成「卡片发送失败，请重新发布」，模型据此谎报
 * 并反复 update 刷卡。这里三条路径（create / update / publish）都用真实服务跑一遍
 * 发卡成功与发卡失败，断言模型看到的文案。
 */
describe('widget tools × 真实 WidgetService：发卡结果如实传达', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'widget-tools-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function realTools(): {
    tools: ToolDefinition[];
    cards: Message[];
    failAppend: { on: boolean };
  } {
    const db = openDatabase({
      path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
      key: deriveKey(Buffer.alloc(32, 3), KEY_INFO.mainDb),
    });
    runMigrations(db, migrationsUrl('main'));
    db.exec(`
      insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_a', 'A', '{}', 'active', 1, 1);
      insert into conversations (id, type, created_at) values ('conv_1', 'direct', 1);
    `);
    const cards: Message[] = [];
    const failAppend = { on: false };
    const noQueries: WidgetQueryExecutor = {
      run: async () => {
        throw new Error('not used');
      },
      dispose: () => undefined,
    };
    const service = new WidgetService({
      db,
      messages: {
        append: (input) => {
          if (failAppend.on) throw new Error('append unavailable');
          const message = {
            id: `msg_${cards.length + 1}`,
            conversationId: input.conversationId,
            kind: 'card',
            content: { cardType: input.cardType, approvalId: '', widget: input.cardWidget },
          } as unknown as Message;
          cards.push(message);
          return message;
        },
        getById: (id) => cards.find((card) => card.id === id) ?? null,
      },
      publishMessage: () => undefined,
      secrets: { redact: (text) => text },
      shell: { openExternal: async () => ({ ok: true }) },
      queryRunner: noQueries,
      clock: { now: () => 1_000 },
      logger: { warn: () => undefined },
    });
    return { tools: buildWidgetTools({ identity, widgets: service }), cards, failAppend };
  }

  const byName = (tools: ToolDefinition[], name: string): ToolDefinition => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`${name} missing`);
    return tool;
  };

  it('发卡成功：create / update / publish 都如实说已发卡，不出现「发送失败」', async () => {
    const { tools, cards } = realTools();
    const created = await byName(tools, WIDGET_CREATE_TOOL).execute(
      { title: '计算器', description: '', html: '<!DOCTYPE html><p>1</p>', scope: 'bot' },
      {} as never,
    );
    expect(created.ok).toBe(true);
    expect(created.content).toContain('已作为卡片发进对话');
    expect(created.content).not.toContain('发送失败');
    const widgetId = /widgetId: (wgt_[^）)]+)/.exec(created.content)?.[1];
    expect(widgetId).toBeDefined();

    const updated = await byName(tools, WIDGET_UPDATE_TOOL).execute(
      { widget_id: widgetId, html: '<!DOCTYPE html><p>2</p>', change_note: '改数字' },
      {} as never,
    );
    expect(updated.ok).toBe(true);
    expect(updated.content).toContain('已更新到 v2');
    expect(updated.content).not.toContain('发送失败');

    const published = await byName(tools, WIDGET_PUBLISH_TOOL).execute({ widget_id: widgetId }, {} as never);
    expect(published.ok).toBe(true);
    expect(published.content).toContain('已发卡到当前对话');
    expect(published.content).not.toContain('发送失败');
    expect(cards).toHaveLength(3);
  });

  it('发卡失败：create / update / publish 都如实说卡片没送达（组件已保存）', async () => {
    const { tools, cards, failAppend } = realTools();
    const created = await byName(tools, WIDGET_CREATE_TOOL).execute(
      { title: '计算器', description: '', html: '<!DOCTYPE html><p>1</p>', scope: 'bot' },
      {} as never,
    );
    // 先成功建一个，再让后续发卡失败。
    const widgetId = /widgetId: (wgt_[^）)]+)/.exec(created.content)?.[1];
    failAppend.on = true;

    const createFailed = await byName(tools, WIDGET_CREATE_TOOL).execute(
      { title: '另一个', description: '', html: '<!DOCTYPE html><p>x</p>' },
      {} as never,
    );
    expect(createFailed.ok).toBe(true);
    expect(createFailed.content).toContain('未能送达');

    const updateFailed = await byName(tools, WIDGET_UPDATE_TOOL).execute(
      { widget_id: widgetId, html: '<!DOCTYPE html><p>2</p>' },
      {} as never,
    );
    expect(updateFailed.ok).toBe(true);
    expect(updateFailed.content).toContain('卡片消息发送失败');
    expect(updateFailed.content).toContain('v2');

    const publishFailed = await byName(tools, WIDGET_PUBLISH_TOOL).execute({ widget_id: widgetId }, {} as never);
    expect(publishFailed.ok).toBe(true);
    expect(publishFailed.content).toContain('发送失败');
    expect(cards).toHaveLength(1);
  });
});

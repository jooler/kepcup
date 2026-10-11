import { describe, expect, it } from 'vitest';

import type { RunIdentity } from '../../src/agent/types.js';
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

  it('widget_create：门面未带 cardMessageId（发卡失败）→ 提示送达失败而不是谎称已发卡', async () => {
    const facade = fakeFacade();
    facade.create = () => ({ ok: true, widgetId: 'wgt_9', title: '计算器', version: 1, message: '已保存' });
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
    facade.publish = () => ({ ok: true, widgetId: 'wgt_7', title: '报表', version: 2, message: '已发卡' });
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

    facade.update = () => ({ ok: true, widgetId: 'wgt_1', title: '计算器', version: 3, message: '已更新' });
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

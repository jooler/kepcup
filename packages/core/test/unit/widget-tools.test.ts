import { describe, expect, it } from 'vitest';

import type { RunIdentity } from '../../src/agent/types.js';
import {
  buildWidgetTools,
  WIDGET_CREATE_TOOL,
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
} {
  const creates: WidgetCreateInput[] = [];
  const updates: WidgetUpdateInput[] = [];
  const ok = (widgetId: string, version: number): WidgetWriteResult => ({
    ok: true,
    widgetId,
    version,
    message: '已发布',
  });
  return {
    creates,
    updates,
    create: (input) => {
      creates.push(input);
      return ok('wgt_1', 1);
    },
    update: (input) => {
      updates.push(input);
      return ok(input.widgetId, 2);
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

  it('widget_create：门面未带 cardMessageId（发卡失败）→ 提示送达失败而不是谎称已发卡', async () => {
    const facade = fakeFacade();
    facade.create = () => ({ ok: true, widgetId: 'wgt_9', version: 1, message: '已保存' });
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

    facade.update = () => ({ ok: true, widgetId: 'wgt_1', version: 3, message: '已更新' });
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

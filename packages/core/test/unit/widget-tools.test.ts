import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Message } from '@kepcup/shared';
import type {
  RunIdentity,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/agent/types.js';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { WidgetService, type WidgetWriteResult } from '../../src/widgets/service.js';
import type { WidgetQueryExecutor } from '../../src/widgets/query-runner.js';
import type { WidgetCraftParams } from '../../src/widgets/craft/service.js';
import {
  buildWidgetTools,
  WIDGET_CRAFT_TOOL,
  WIDGET_PUBLISH_TOOL,
  type WidgetToolFacade,
} from '../../src/tools/widget-tools.js';

/**
 * Bot 自制交互组件工具（D81 / D87）：任务面只有 widget_craft（制作 loop 的入口，参数原样
 * 交给制作服务）与 widget_publish；widget_create / widget_update 不再是 Bot 的工具。
 */

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_a',
  conversationId: 'conv_1',
  loopType: 'task',
};

interface CraftCall {
  identity: RunIdentity;
  params: WidgetCraftParams;
  signal: AbortSignal;
  progress: (text: string) => void;
}

function fakeFacade(): WidgetToolFacade & {
  crafts: CraftCall[];
  publishes: Array<{
    botId: string;
    widgetId: string;
    conversationId: string;
    runId: string | null;
  }>;
} {
  const crafts: CraftCall[] = [];
  const publishes: Array<{
    botId: string;
    widgetId: string;
    conversationId: string;
    runId: string | null;
  }> = [];
  return {
    crafts,
    publishes,
    craft: async (input) => {
      crafts.push(input);
      input.progress('组件制作：正在整理规格');
      return { ok: true, content: '组件「计算器」v1 已交付' } satisfies ToolResult;
    },
    publish: (input) => {
      publishes.push(input);
      return {
        ok: true,
        widgetId: input.widgetId,
        title: '计算器',
        version: 1,
        message: '已发布',
        cardMessageId: 'msg_ok',
      };
    },
  };
}

function ctx(progress: string[] = []): ToolContext {
  return {
    identity,
    signal: new AbortController().signal,
    terminate: () => undefined,
    progress: (text) => progress.push(text),
  };
}

describe('widget tools', () => {
  it('任务面只有 widget_craft 与 widget_publish（不能绕过制作流程直接塞 HTML）', () => {
    const names = buildWidgetTools({ identity, widgets: fakeFacade() }).map((tool) => tool.name);
    expect(names).toEqual([WIDGET_CRAFT_TOOL, WIDGET_PUBLISH_TOOL]);
    expect(names).not.toContain('widget_create');
    expect(names).not.toContain('widget_update');
  });

  it('widget_craft：参数、执行身份、signal 与进度原样交给制作服务，回执原样返回', async () => {
    const facade = fakeFacade();
    const craft = buildWidgetTools({ identity, widgets: facade }).find(
      (t) => t.name === WIDGET_CRAFT_TOOL,
    )!;
    const progress: string[] = [];
    const context = ctx(progress);
    const params: WidgetCraftParams = {
      brief: '做个费用分摊计算器',
      title: '费用分摊',
      acceptance: ['删除前要确认'],
      scope: 'bot',
    };
    const result = await craft.execute(params, context);
    expect(result).toEqual({ ok: true, content: '组件「计算器」v1 已交付' });
    expect(facade.crafts).toHaveLength(1);
    expect(facade.crafts[0]!.identity).toEqual(identity);
    expect(facade.crafts[0]!.params).toEqual(params);
    expect(facade.crafts[0]!.signal).toBe(context.signal);
    expect(progress).toEqual(['组件制作：正在整理规格']);
  });

  it('widget_craft 的描述不再携带 HTML 指南（瘦身：只讲何时用、brief 写什么）', () => {
    const craft = buildWidgetTools({ identity, widgets: fakeFacade() }).find(
      (t) => t.name === WIDGET_CRAFT_TOOL,
    )!;
    expect(craft.description).toContain('不要自己写 HTML');
    expect(craft.description).not.toContain('localStorage');
    expect(craft.description.length).toBeLessThan(600);
  });

  it('widget_publish：缺参 / 无对话拒绝；成功时带 runId 调门面；失败透传 code', async () => {
    const facade = fakeFacade();
    const publish = buildWidgetTools({ identity, widgets: facade }).find(
      (tool) => tool.name === WIDGET_PUBLISH_TOOL,
    );
    if (publish === undefined) throw new Error('publish tool missing');

    const missing = await publish.execute({ widget_id: '' }, {} as never);
    expect(missing.ok).toBe(false);
    expect(facade.publishes).toHaveLength(0);

    const noConversation = buildWidgetTools({
      identity: { ...identity, conversationId: null },
      widgets: facade,
    }).find((tool) => tool.name === WIDGET_PUBLISH_TOOL);
    const refused = await noConversation!.execute({ widget_id: 'wgt_1' }, {} as never);
    expect(refused.ok).toBe(false);

    const ok = await publish.execute({ widget_id: 'wgt_7' }, {} as never);
    expect(ok.ok).toBe(true);
    expect(facade.publishes[0]).toEqual({
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
});

/**
 * widget_publish 与真实 WidgetService 的契约（回归 D81 审查 #1）：发卡成功与失败两条路径
 * 都如实传达给模型；发出的卡沿用版本的自检状态（D87）。
 */
describe('widget_publish × 真实 WidgetService', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'widget-tools-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function realService(): {
    service: WidgetService;
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
    return { service, cards, failAppend };
  }

  function publishTool(service: WidgetService): ToolDefinition {
    const facade: WidgetToolFacade = {
      craft: async () => ({ ok: false, content: 'not used' }),
      publish: (input) => service.publish(input),
    };
    return buildWidgetTools({ identity, widgets: facade }).find(
      (t) => t.name === WIDGET_PUBLISH_TOOL,
    )!;
  }

  function created(service: WidgetService): Extract<WidgetWriteResult, { ok: true }> {
    const result = service.create({
      botId: 'bot_a',
      conversationId: 'conv_1',
      title: '计算器',
      description: '',
      html: '<!DOCTYPE html><p>1</p>',
      scope: 'bot',
      runId: 'run_0',
      check: {
        status: 'issues',
        summary: {
          craftId: 'wcf_1',
          gateRounds: 2,
          reviewRounds: 0,
          reviewSkipped: false,
          previewed: true,
          knownIssues: ['窄屏下内容横向溢出'],
        },
      },
    });
    if (!result.ok) throw new Error(result.message);
    return result;
  }

  it('发卡成功：如实说已发卡，卡片沿用版本的自检状态与已知问题', async () => {
    const { service, cards } = realService();
    const widget = created(service);
    const published = await publishTool(service).execute(
      { widget_id: widget.widgetId },
      {} as never,
    );
    expect(published.ok).toBe(true);
    expect(published.content).toContain('已发卡到当前对话');
    expect(published.content).not.toContain('发送失败');
    expect(cards).toHaveLength(2);
    const card = (
      cards[1]!.content as unknown as { widget: { checkStatus: string; knownIssues: string[] } }
    ).widget;
    expect(card.checkStatus).toBe('issues');
    expect(card.knownIssues).toEqual(['窄屏下内容横向溢出']);
  });

  it('发卡失败：如实说卡片没送达（组件已保存）', async () => {
    const { service, cards, failAppend } = realService();
    const widget = created(service);
    failAppend.on = true;
    const failed = await publishTool(service).execute({ widget_id: widget.widgetId }, {} as never);
    expect(failed.ok).toBe(true);
    expect(failed.content).toContain('发送失败');
    expect(cards).toHaveLength(1);
  });
});

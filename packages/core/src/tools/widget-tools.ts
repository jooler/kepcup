import { Type } from '@earendil-works/pi-ai';
import { WIDGET_CRAFT_ACCEPTANCE_HINTS_MAX, WIDGET_CRAFT_BRIEF_MAX_CHARS } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { WidgetCraftParams } from '../widgets/craft/service.js';
import type { WidgetWriteResult } from '../widgets/service.js';

/**
 * Bot 自制交互组件工具（D81 / D87，docs/design/32-bot-widgets.md）：任务面只有
 * `widget_craft`（新建与修改的唯一入口——编码在独立制作 loop 里完成，任务只拿到 ≤1500 字的
 * 回执，HTML / diff / 检查报告都不进任务上下文，§11）与 `widget_publish`（把 Bot 级组件的
 * 最新版发卡到当前对话）。`widget_create` / `widget_update` 不再是 Bot 的工具：它们保留为
 * `WidgetService.create` / `update`，只由制作 loop 凭检查回执调用——给模型留一条「直接塞
 * HTML」的捷径，非一线模型就会绕过流程。仅任务面注册（对话轮只读纪律）；副作用是本机库
 * 写入，记 `local`。
 */

export const WIDGET_CRAFT_TOOL = 'widget_craft';
export const WIDGET_PUBLISH_TOOL = 'widget_publish';

/** The slice of the widget services the tools need. */
export interface WidgetToolFacade {
  craft(input: {
    identity: RunIdentity;
    params: WidgetCraftParams;
    signal: AbortSignal;
    progress: (text: string) => void;
  }): Promise<ToolResult>;
  publish(input: {
    botId: string;
    widgetId: string;
    conversationId: string;
    runId: string | null;
  }): WidgetWriteResult;
}

export function buildWidgetTools(input: {
  identity: RunIdentity;
  widgets: WidgetToolFacade;
}): ToolDefinition[] {
  const { identity, widgets } = input;

  const craft: ToolDefinition<WidgetCraftParams> = {
    name: WIDGET_CRAFT_TOOL,
    description:
      '给用户做（或修改）一个可直接操作的交互组件：计算器、追踪表、小工具、小游戏、数据小看板等。用户明确想要「能点的」「做个小工具」「帮我做个页面」时用它；纯文字或一张表能说清的不要做组件。' +
      '组件由独立的制作流程编写、检查并在真实浏览器里试运行，你只需写清 brief，**不要自己写 HTML**。调用会阻塞到制作结束（通常几分钟），返回交付结果：成功时组件已作为卡片发进对话；返回「未交付」时如实告诉用户原因，不要假装成功。' +
      '修改已有组件传 widget_id（以它的最新版为起点）；继续一次未交付的制作传 resume_craft_id（可在 brief 里补充说明）。',
    parameters: Type.Object({
      brief: Type.String({
        description: `组件需求（≤${WIDGET_CRAFT_BRIEF_MAX_CHARS} 字）：目标、主要界面与交互、数据从哪来以及要不要保存（保存在本机）、风格偏好；尽量引用用户原话。修改时写清要改什么`,
      }),
      title: Type.Optional(
        Type.String({
          description: '新建时的组件名，简短（≤120 字），如「费用分摊计算器」；修改时不用给',
        }),
      ),
      widget_id: Type.Optional(
        Type.String({ description: '要修改的已有组件 ID（之前交付回执里的 widgetId）' }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal('conversation'), Type.Literal('bot')], {
          description: '新建时的作用域：仅本对话（默认）或保存为你的跨对话资产',
        }),
      ),
      acceptance: Type.Optional(
        Type.Array(Type.String(), {
          description: `用户明确提出的验收要求（自然语言，≤${WIDGET_CRAFT_ACCEPTANCE_HINTS_MAX} 条），如「删除前要确认」「刷新后数据还在」`,
        }),
      ),
      resume_craft_id: Type.Optional(
        Type.String({ description: '继续一次未交付的制作（之前回执里的 craftId）' }),
      ),
    }),
    execute: (params, ctx) =>
      widgets.craft({
        identity,
        params,
        signal: ctx.signal,
        progress: (text) => ctx.progress(text),
      }),
  };

  const publish: ToolDefinition<{ widget_id?: string }> = {
    name: WIDGET_PUBLISH_TOOL,
    description:
      '把你创建的 Bot 级组件（跨对话资产，widget_craft 时 scope="bot"）的最新版本发卡到当前对话，让本对话的用户加载使用；不产生新版本。组件已在本对话或有会话级组件时不需要用它。',
    parameters: Type.Object({
      widget_id: Type.String({ description: '组件 ID（交付回执里的 widgetId）' }),
    }),
    execute: async (params) => {
      const botId = identity.botId;
      const conversationId = identity.conversationId;
      if (botId === null || conversationId === null) {
        return {
          ok: false,
          content: '组件必须发给一个对话（当前没有对话上下文）',
          errorCode: 'INVALID_INPUT',
        };
      }
      const widgetId = params.widget_id?.trim() ?? '';
      if (widgetId === '') {
        return { ok: false, content: '需要提供 widget_id', errorCode: 'INVALID_INPUT' };
      }
      const result = widgets.publish({ botId, widgetId, conversationId, runId: identity.runId });
      if (!result.ok) {
        return { ok: false, content: result.message, errorCode: result.code ?? 'INVALID_INPUT' };
      }
      if (result.cardMessageId === null) {
        return {
          ok: true,
          content: `组件「${result.title}」（v${result.version}）已引用，但卡片消息发送失败，用户暂时看不到它；请如实告知用户，稍后重试 widget_publish。（widgetId: ${result.widgetId}）`,
        };
      }
      return { ok: true, content: `${result.message}（widgetId: ${result.widgetId}）` };
    },
  };

  return [craft, publish] as ToolDefinition[];
}

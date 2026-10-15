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
export const WIDGET_READ_STATE_TOOL = 'widget_read_state';

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
  /** D87 P4 L3：读本 Bot 组件的 KV（只读；不是代码，是用户在组件里填的数据）。 */
  readState(input: { botId: string; widgetId: string; keys?: string[] }):
    | {
        ok: true;
        json: string;
        truncated: boolean;
        count: number;
        skipped: Array<{ key: string; bytes: number; preview: string }>;
      }
    | { ok: false; message: string; code: 'NOT_FOUND' | 'FORBIDDEN' };
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
        description: `组件需求（≤${WIDGET_CRAFT_BRIEF_MAX_CHARS} 字）：只转述用户要看到的内容、数据从哪来、要不要保存在本机、风格；尽量引用用户原话。不要写入用户没说的点击、展开、查看源码或预览切换。修改时写清要改什么`,
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

  // D87 P4 L3（设计 32 §12.3）：组件里存的数据是用户填的（不可信）——包进 <untrusted> 再交给模型。
  const readState: ToolDefinition<{ widget_id?: string; keys?: string[] }> = {
    name: WIDGET_READ_STATE_TOOL,
    description:
      '读取你创建的某个组件在本机保存的键值数据，用于汇总、分析或接着处理用户在组件里填的内容。只读，不改数据；只能读你自己的组件。',
    parameters: Type.Object({
      widget_id: Type.String({ description: '组件 ID（交付回执里的 widgetId）' }),
      keys: Type.Optional(
        Type.Array(Type.String({ maxLength: 200 }), {
          maxItems: 50,
          description: '只读这些键；不给则读全部（总量有上限，超出会截断）',
        }),
      ),
    }),
    execute: (params) => {
      const botId = identity.botId;
      if (botId === null) {
        return Promise.resolve({
          ok: false,
          content: '当前没有 Bot 身份，不能读组件数据',
          errorCode: 'INVALID_INPUT',
        });
      }
      const widgetId = params.widget_id?.trim() ?? '';
      if (widgetId === '') {
        return Promise.resolve({
          ok: false,
          content: '需要提供 widget_id',
          errorCode: 'INVALID_INPUT',
        });
      }
      const result = widgets.readState({
        botId,
        widgetId,
        ...(params.keys !== undefined ? { keys: params.keys } : {}),
      });
      if (!result.ok) {
        return Promise.resolve({ ok: false, content: result.message, errorCode: result.code });
      }
      // json / preview 里的 `<` 已由服务转成 \u003c，数据闭合不了边界。
      const note = result.truncated ? '（数据较多，已截断；可用 keys 只读需要的键）' : '';
      const skipped =
        result.skipped.length === 0
          ? ''
          : `\n以下键的值太大，没有整体放进来（${result.skipped
              .map((s) => `${s.key}：${s.bytes} 字节`)
              .join('；')}）；开头片段（同样是数据）：\n<untrusted source="widget-state">${JSON.stringify(
              Object.fromEntries(
                result.skipped.filter((s) => s.preview !== '').map((s) => [s.key, s.preview]),
              ),
            ).replace(/</g, '\\u003c')}</untrusted>`;
      return Promise.resolve({
        ok: true,
        content: `组件 ${widgetId} 的数据（${result.count} 个键）${note}：\n<untrusted source="widget-state">${result.json}</untrusted>${skipped}`,
      });
    },
  };

  return [craft, publish, readState] as ToolDefinition[];
}

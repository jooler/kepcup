import type { z } from 'zod';
import {
  AppError,
  okOutputSchema,
  widgetsDeleteInputSchema,
  widgetsDeleteOutputSchema,
  widgetsListInputSchema,
  widgetsListOutputSchema,
  widgetsPublishInputSchema,
  widgetsPublishOutputSchema,
  widgetsUiCloseInputSchema,
  widgetsUiOpenInputSchema,
  widgetsUiOpenLinkInputSchema,
  widgetsUiOpenLinkOutputSchema,
  widgetsUiReplyInputSchema,
  widgetsUiReplyOutputSchema,
  widgetsUiOpenOutputSchema,
  widgetsUiPosterInputSchema,
  widgetsUiPosterOutputSchema,
  widgetsUiQueryInputSchema,
  widgetsUiQueryOutputSchema,
  widgetsUiResourceInputSchema,
  widgetsUiResourceOutputSchema,
  widgetsUiSourceInputSchema,
  widgetsUiSourceOutputSchema,
  widgetsUiStorageInputSchema,
  widgetsUiStorageOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/**
 * `widgets.ui.*` 与 `widgets.*`（D81 Bot 自制交互组件）。renderer → core：`open` /
 * `close` / `source`，以及能力桥：`storage`（KV，命名空间 = widgetId）、`openLink`
 * （https 外链，渲染端已出卡内确认条）与 `query`（P2，按名字执行随版本预审的只读
 * 查询模板）；管理入口（P2）：`widgets.list` / `widgets.delete` / `widgets.publish`
 * （Bot 详情「组件」Tab：列表 / 删除 / 发卡到当前对话）。平台方法（主进程 → core）：
 * `resource`——协议处理器按 host 前缀 `widget-` 分流到这里取已登记的 HTML（含 SDK
 * 垫片）与响应头 CSP（与 `apps.ui.resource` 同形）。
 */
export function bindWidgetsUiMethods(services: CoreServices): {
  app: Record<string, RpcMethodSpec>;
  platform: Record<string, RpcMethodSpec>;
} {
  const ui = () => {
    if (services.widgets === null) throw new AppError('NOT_IMPLEMENTED', '组件模块未就绪');
    return services.widgets;
  };
  return {
    app: {
      'widgets.ui.open': method(widgetsUiOpenInputSchema, widgetsUiOpenOutputSchema, async (input) =>
        ui().open(input),
      ),
      'widgets.ui.close': method(widgetsUiCloseInputSchema, okOutputSchema, async (input) => {
        ui().close(input.resourceId);
        return { ok: true as const };
      }),
      'widgets.ui.source': method(
        widgetsUiSourceInputSchema,
        widgetsUiSourceOutputSchema,
        async (input) => ui().source(input.messageId),
      ),
      'widgets.ui.poster': method(
        widgetsUiPosterInputSchema,
        widgetsUiPosterOutputSchema,
        async (input) => ui().poster(input.messageId),
      ),
      'widgets.ui.storage': method(
        widgetsUiStorageInputSchema,
        widgetsUiStorageOutputSchema,
        async (input) => ui().storage(input),
      ),
      'widgets.ui.openLink': method(
        widgetsUiOpenLinkInputSchema,
        widgetsUiOpenLinkOutputSchema,
        async (input) => ui().openLink(input),
      ),
      // D87 P4 L3：用户确认后，组件文字作为用户消息发进卡片所在对话（带 origin 'widget'）。
      'widgets.ui.reply': method(widgetsUiReplyInputSchema, widgetsUiReplyOutputSchema, async (input) => {
        const reply = ui().prepareReply(input);
        if (services.orchestrator === null) throw new AppError('NOT_IMPLEMENTED', '对话模块未就绪');
        const sent = services.orchestrator.sendMessage(reply.conversationId, {
          text: reply.text,
          widgetOrigin: { widgetId: reply.widgetId, version: reply.version },
        });
        return { ok: true, messageId: sent.message.id };
      }),
      'widgets.ui.query': method(
        widgetsUiQueryInputSchema,
        widgetsUiQueryOutputSchema,
        async (input) => ui().query(input),
      ),
      'widgets.list': method(widgetsListInputSchema, widgetsListOutputSchema, async (input) => ({
        widgets: ui().listForBot(input.botId),
      })),
      'widgets.delete': method(
        widgetsDeleteInputSchema,
        widgetsDeleteOutputSchema,
        async (input) => ({ ok: ui().delete(input.botId, input.widgetId) }),
      ),
      'widgets.publish': method(
        widgetsPublishInputSchema,
        widgetsPublishOutputSchema,
        async (input) => {
          const result = ui().publish({ ...input, runId: null });
          if (!result.ok) return { ok: false, message: result.message };
          const { cardMessageId } = result;
          return {
            ok: true,
            ...(cardMessageId !== null ? { cardMessageId } : {}),
          };
        },
      ),
    },
    platform: {
      'widgets.ui.resource': method(
        widgetsUiResourceInputSchema,
        widgetsUiResourceOutputSchema,
        async (input) => ui().resource(input),
      ),
    },
  };
}

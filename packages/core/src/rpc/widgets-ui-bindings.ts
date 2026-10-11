import type { z } from 'zod';
import {
  AppError,
  okOutputSchema,
  widgetsUiCloseInputSchema,
  widgetsUiOpenInputSchema,
  widgetsUiOpenLinkInputSchema,
  widgetsUiOpenLinkOutputSchema,
  widgetsUiOpenOutputSchema,
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
 * `widgets.ui.*`（D81 Bot 自制交互组件）。renderer → core：`open` / `close` / `source`，
 * 以及能力桥（P1）：`storage`（KV，命名空间 = widgetId）与 `openLink`（https 外链，
 * 渲染端已出卡内确认条）；平台方法（主进程 → core）：`resource`——协议处理器按 host
 * 前缀 `widget-` 分流到这里取已登记的 HTML（含 SDK 垫片）与响应头 CSP（与
 * `apps.ui.resource` 同形）。
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

import type { z } from 'zod';
import {
  AppError,
  okOutputSchema,
  widgetsUiCloseInputSchema,
  widgetsUiOpenInputSchema,
  widgetsUiOpenOutputSchema,
  widgetsUiResourceInputSchema,
  widgetsUiResourceOutputSchema,
  widgetsUiSourceInputSchema,
  widgetsUiSourceOutputSchema,
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
 * `widgets.ui.*`（D81 Bot 自制交互组件）。renderer → core：`open` / `close` / `source`；
 * 平台方法（主进程 → core）：`resource`——协议处理器按 host 前缀 `widget-` 分流到这里
 * 取已登记的 HTML 与响应头 CSP（与 `apps.ui.resource` 同形）。
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

import type { z } from 'zod';
import {
  AppError,
  appsUiCallToolInputSchema,
  appsUiCallToolOutputSchema,
  appsUiCloseInputSchema,
  appsUiOpenInputSchema,
  appsUiOpenLinkInputSchema,
  appsUiOpenLinkOutputSchema,
  appsUiOpenOutputSchema,
  appsUiResourceInputSchema,
  appsUiResourceOutputSchema,
  okOutputSchema,
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
 * `apps.ui.*`（D73 P3 §7.5 MCP Apps 渲染）。renderer → core：`open` / `close` / `callTool` / `openLink`；
 * 平台方法（主进程 → core）：`resource`——自定义协议处理器取已登记的 HTML 与响应头 CSP。
 */
export function bindAppsUiMethods(services: CoreServices): {
  app: Record<string, RpcMethodSpec>;
  platform: Record<string, RpcMethodSpec>;
} {
  const ui = () => {
    if (services.appUi === null) throw new AppError('NOT_IMPLEMENTED', '应用界面模块未就绪');
    return services.appUi;
  };
  return {
    app: {
      'apps.ui.open': method(appsUiOpenInputSchema, appsUiOpenOutputSchema, (input) =>
        ui().open(input),
      ),
      'apps.ui.close': method(appsUiCloseInputSchema, okOutputSchema, async (input) => {
        ui().close(input.resourceId);
        return { ok: true as const };
      }),
      'apps.ui.callTool': method(appsUiCallToolInputSchema, appsUiCallToolOutputSchema, (input) =>
        ui().callTool(input),
      ),
      'apps.ui.openLink': method(appsUiOpenLinkInputSchema, appsUiOpenLinkOutputSchema, (input) =>
        ui().openLink(input),
      ),
    },
    platform: {
      'apps.ui.resource': method(
        appsUiResourceInputSchema,
        appsUiResourceOutputSchema,
        async (input) => ui().resource(input),
      ),
    },
  };
}

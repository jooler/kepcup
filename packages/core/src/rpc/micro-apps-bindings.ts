import type { z } from 'zod';
import {
  AppError,
  microAppCardSummaryOf,
  microAppsPreflightInputSchema,
  microAppsPreflightOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';
import { runMicroAppPreflight, type MicroAppPreflightProbe } from '../micro-apps/preflight.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/**
 * 按能力注册的预检探针（D112 §5.2）。P0 的能力（storage.kv / host.reply / host.openLink）
 * 全在本机、恒可用，不需要探针；P1 落地 `ai.chat` / `media.*` 时在这里接模型解析与
 * ASR / TTS 配置检查（缺什么给 reason + 设置深链）。
 */
function microAppPreflightProbes(
  _services: CoreServices,
): Partial<Record<string, MicroAppPreflightProbe>> {
  return {};
}

export function bindMicroAppsMethods(services: CoreServices): {
  app: Record<string, RpcMethodSpec>;
} {
  return {
    app: {
      'microApps.preflight': method(
        microAppsPreflightInputSchema,
        microAppsPreflightOutputSchema,
        async (input) => {
          if (services.widgets === null) {
            throw new AppError('NOT_IMPLEMENTED', '微应用模块未就绪');
          }
          const effective = services.widgets.effectiveMicroAppOf(input.messageId);
          if (effective === null) {
            throw new AppError('NOT_FOUND', '这张卡片不是微应用（无预检面）');
          }
          return {
            widgetId: effective.widgetId,
            version: effective.version,
            capabilityFingerprint: effective.microApp.fingerprint,
            bundleSha256: effective.bundleSha256,
            microApp: microAppCardSummaryOf(effective.microApp.manifest),
            items: runMicroAppPreflight(
              effective.microApp.manifest.permissions,
              microAppPreflightProbes(services),
            ),
          };
        },
      ),
    },
  };
}

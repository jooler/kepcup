import { z } from 'zod';
import {
  AppError,
  okOutputSchema,
  pluginsInstallInputSchema,
  pluginsInstallOutputSchema,
  pluginsListOutputSchema,
  pluginsSetEnabledInputSchema,
  pluginsSetEnabledOutputSchema,
  pluginsUninstallInputSchema,
  pluginsInspectInputSchema,
  pluginInspectOutputSchema,
  type PluginSource,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import { currentRemoteSource } from '../remote/audit.js';
import type { RpcMethodSpec } from './server.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

const voidInput = z.void();

/**
 * `plugins.*`（D104 P0a-2）：已安装列表、同意面板推导、本地安装、启停、卸载。
 * file / folder 来源是主机本地路径，远程端点上一律拒绝（marketplace 来源 P1 再放开）。
 */
export function bindPluginsMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const registry = () => {
    if (services.plugins === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
    return services.plugins;
  };
  const assertLocalSource = (source: PluginSource): void => {
    // P0a only has file / folder; P1 adds `marketplace` additively (allowed from remote).
    const kind = source.kind as 'file' | 'folder' | 'marketplace';
    if (kind !== 'marketplace' && currentRemoteSource() !== null) {
      throw new AppError('INVALID_INPUT', '远程端点不能从主机本地路径安装插件');
    }
  };
  return {
    'plugins.list': method(voidInput, pluginsListOutputSchema, async () => ({
      plugins: registry().list(),
    })),
    'plugins.inspect': method(
      pluginsInspectInputSchema,
      pluginInspectOutputSchema,
      async (input) => {
        assertLocalSource(input.source);
        return registry().inspect(input.source);
      },
    ),
    'plugins.install': method(
      pluginsInstallInputSchema,
      pluginsInstallOutputSchema,
      async (input) => {
        assertLocalSource(input.source);
        return {
          plugin: await registry().install({
            source: input.source,
            sha256: input.sha256,
            userConfig: input.userConfig,
            via: input.source.kind,
          }),
        };
      },
    ),
    'plugins.setEnabled': method(
      pluginsSetEnabledInputSchema,
      pluginsSetEnabledOutputSchema,
      async (input) => ({ plugin: await registry().setEnabled(input.id, input.enabled) }),
    ),
    'plugins.uninstall': method(pluginsUninstallInputSchema, okOutputSchema, async (input) => {
      await registry().uninstall(input.id);
      return { ok: true as const };
    }),
  };
}

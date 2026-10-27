import { z } from 'zod';
import {
  AppError,
  okOutputSchema,
  pluginsInstallInputSchema,
  pluginsInstallOutputSchema,
  pluginsListOutputSchema,
  pluginsMarketplaceListOutputSchema,
  pluginsMarketplaceRefreshOutputSchema,
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

const RESYNC_AFTER_MS = 10 * 60_000;

/**
 * `plugins.*`（D104 P0a-2）：已安装列表、同意面板推导、本地安装、启停、卸载；
 * `plugins.marketplace.*`（P1-1）：市场视图与手动刷新。file / folder 来源是主机本地路径，
 * 远程端点上一律拒绝（marketplace 来源经 core 下载，允许远程端点使用）。
 */
export function bindPluginsMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const registry = () => {
    if (services.plugins === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
    return services.plugins;
  };
  const marketplace = () => {
    if (services.marketplace === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
    return services.marketplace;
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
    'plugins.marketplace.list': method(voidInput, pluginsMarketplaceListOutputSchema, async () => {
      const market = marketplace();
      const sync = market.current();
      const status = market.status();
      if (sync === null) return { status, entries: [] };
      // 距上次成功同步超过 10 分钟（或从未同步）→ 后台补一次，不等待。
      if (status.lastSync === null || Date.now() - status.lastSync > RESYNC_AFTER_MS) {
        void sync.sync().catch(() => undefined);
      }
      return { status, entries: registry().marketplaceEntries() };
    }),
    'plugins.marketplace.refresh': method(
      voidInput,
      pluginsMarketplaceRefreshOutputSchema,
      async () => {
        const market = marketplace();
        const sync = market.current();
        if (sync === null) return { status: market.status() };
        await sync.sync();
        return { status: market.status() };
      },
    ),
  };
}

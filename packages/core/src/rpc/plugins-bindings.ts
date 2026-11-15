import { z } from 'zod';
import {
  AppError,
  okOutputSchema,
  pluginsConfigGetInputSchema,
  pluginsConfigGetOutputSchema,
  pluginsConfigSetInputSchema,
  pluginsInstallInputSchema,
  pluginsInstallOutputSchema,
  pluginsInstancesCreateInputSchema,
  pluginsInstancesCreateOutputSchema,
  pluginsInstancesDeleteInputSchema,
  pluginsInstancesListInputSchema,
  pluginsInstancesListOutputSchema,
  pluginsInstancesUpdateInputSchema,
  pluginsInstancesUpdateOutputSchema,
  pluginsListCapabilityEntriesOutputSchema,
  pluginsListOutputSchema,
  pluginsMarketplaceListOutputSchema,
  pluginsMarketplaceRefreshOutputSchema,
  pluginsSetBotCapabilityEntriesInputSchema,
  pluginsSetBotPluginsInputSchema,
  pluginsEnableForBotsInputSchema,
  pluginsSetEnabledInputSchema,
  pluginsSetEnabledOutputSchema,
  pluginsTestCapabilityEntryInputSchema,
  pluginsUninstallInputSchema,
  pluginsUpdateInputSchema,
  pluginsUpdateOutputSchema,
  pluginsInspectInputSchema,
  pluginInspectOutputSchema,
  type PluginCapabilityEntryGroup,
  type PluginInstanceKind,
  type PluginSource,
} from '@kepcup/shared';
import { MEDIA_ENGINES } from '../media/engines.js';
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
  const instances = () => {
    if (services.pluginInstances === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
    return services.pluginInstances;
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
    /**
     * P2 注入模型：整体替换 Bot 的插件启用集（`profile_json.runtime.plugin_ids`，其余
     * Profile 字段不动）。远程端点允许（无本地路径语义）。写后广播 `bot.updated` +
     * `plugins.changed`（ids = 去重后的新旧并集，让扩展中心与右栏两侧都刷新）。
     */
    'plugins.setBotPlugins': method(
      pluginsSetBotPluginsInputSchema,
      okOutputSchema,
      async (input) => {
        const domain = services.domain;
        if (domain === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
        const before = new Set(domain.bots.get(input.botId)?.profile.runtime.plugin_ids ?? []);
        const bot = domain.bots.setPluginIds(input.botId, input.pluginIds);
        services.events.emit('bot.updated', { bot });
        services.events.emit('plugins.changed', {
          ids: [...new Set([...before, ...input.pluginIds])],
        });
        return { ok: true as const };
      },
    ),
    /**
     * D105 P5（P4 审查 P2-2 处置）：合并追加一个插件到多个 Bot 的启用集。整批先校验
     * （存在 + 活跃），再逐个写——`addPluginIds` 内的插件已安装校验对每个 Bot 恒定，
     * 因此所有失败都发生在**任何写入之前**（不会落一半）。已启用的 Bot 幂等跳过（不发
     * 事件）；写过的 Bot 各广播 `bot.updated`，`plugins.changed` 只发一次（ids = 该插件）。
     */
    'plugins.enableForBots': method(
      pluginsEnableForBotsInputSchema,
      okOutputSchema,
      async (input) => {
        const domain = services.domain;
        if (domain === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
        // 整批预检必须在任何写入前完成：软删除的 Bot 也在这里拒绝（addPluginIds 内部
        // 才检查 status 的话，排在前面的 Bot 已经被写进去了）。
        for (const botId of input.botIds) {
          const bot = domain.bots.getOrThrow(botId);
          if (bot.status !== 'active') {
            throw new AppError('CONVERSATION_READ_ONLY', `Bot ${botId} has been deleted`);
          }
        }
        let touched = 0;
        for (const botId of input.botIds) {
          const { bot, added } = domain.bots.addPluginIds(botId, [input.pluginId]);
          if (!added) continue;
          touched += 1;
          services.events.emit('bot.updated', { bot });
        }
        if (touched > 0) {
          services.events.emit('plugins.changed', { ids: [input.pluginId] });
        }
        return { ok: true as const };
      },
    ),
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
            acknowledgeDiff: input.acknowledgeDiff,
            via: input.source.kind,
          }),
        };
      },
    ),
    'plugins.update': method(
      pluginsUpdateInputSchema,
      pluginsUpdateOutputSchema,
      async (input) => ({
        plugin: await registry().update({
          id: input.id,
          ...(input.version !== undefined ? { version: input.version } : {}),
          sha256: input.sha256,
          userConfig: input.userConfig,
          acknowledgeDiff: input.acknowledgeDiff,
          via: 'marketplace',
        }),
      }),
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
    // D105 P1：插件配置与实例。值里有敏感项时只进 secrets，出参 / 审计都不带值。
    'plugins.config.get': method(
      pluginsConfigGetInputSchema,
      pluginsConfigGetOutputSchema,
      async (input) => registry().getConfig(input.id),
    ),
    'plugins.config.set': method(pluginsConfigSetInputSchema, okOutputSchema, async (input) => {
      await registry().setConfig(input.id, input.values);
      return { ok: true as const };
    }),
    'plugins.instances.list': method(
      pluginsInstancesListInputSchema,
      pluginsInstancesListOutputSchema,
      async (input) => ({ instances: instances().list(input.pluginId) }),
    ),
    'plugins.instances.create': method(
      pluginsInstancesCreateInputSchema,
      pluginsInstancesCreateOutputSchema,
      async (input) => ({
        instance: await instances().create(
          input.pluginId,
          input.values,
          input.kind as PluginInstanceKind | undefined,
        ),
      }),
    ),
    'plugins.instances.update': method(
      pluginsInstancesUpdateInputSchema,
      pluginsInstancesUpdateOutputSchema,
      async (input) => ({ instance: await instances().update(input.id, input.values) }),
    ),
    'plugins.instances.delete': method(
      pluginsInstancesDeleteInputSchema,
      okOutputSchema,
      async (input) => {
        // 删实例 = 删账号（绑定随之消失）：先记下绑定过该实例的 Bot，删除后补一条激活通报。
        const affected = new Set<string>();
        for (const account of services.im?.listAccounts() ?? []) {
          if (account.instanceId !== input.id) continue;
          for (const botId of account.botIds) affected.add(botId);
        }
        for (const account of services.mail?.list() ?? []) {
          if (account.instanceId !== input.id) continue;
          for (const botId of account.botIds) affected.add(botId);
        }
        await instances().delete(input.id);
        for (const botId of affected) services.pluginBotNotice?.note(botId);
        return { ok: true as const };
      },
    ),
    // --- D124 能力模型条目（60 号文档 §3/§5） ---------------------------------
    /**
     * 已装插件的条目全集（Bot 详情勾选 UI 的数据源）：按插件分组，条目行带
     * 能力 / 模型 / 引擎与实例配置状态（instanceState + configured）。
     * D124 P4 起 builtin 只读目录插件经 `manifestOf` 的 builtin 回退同样入列
     * （生产构建无 builtin 目录）；清单不可读的插件跳过。
     */
    'plugins.listCapabilityEntries': method(
      voidInput,
      pluginsListCapabilityEntriesOutputSchema,
      async () => {
        const pluginRegistry = registry();
        const groups: PluginCapabilityEntryGroup[] = [];
        for (const summary of pluginRegistry.list()) {
          if (summary.state !== 'installed') continue;
          const manifest = await pluginRegistry.manifestOf(summary.id);
          const entries = manifest?.contributions.capabilityModels ?? [];
          if (manifest === null || entries.length === 0) continue;
          const instanceRows = instances().list(summary.id).filter((row) => row.kind === 'capability-model');
          const requiredOf = (engine: string) =>
            (MEDIA_ENGINES[engine]?.credentialFields ?? []).filter((field) => field.required);
          groups.push({
            pluginId: summary.id,
            pluginName: summary.name,
            tier: summary.tier,
            entries: entries.map((entry) => {
              // D125 过渡：执行型条目不填 engine（61 §2），无第一方引擎凭据（required 空，
              // configured 只看实例存在性）；凭据语义由 D125-P2 接管。
              const required = requiredOf(entry.engine ?? '');
              const configured = (row?: { values: Record<string, unknown>; storedSensitiveKeys: string[] }): boolean =>
                row === undefined
                  ? false
                  : required.every((field) =>
                      field.sensitive
                        ? row.storedSensitiveKeys.includes(field.key)
                        : row.values[field.key] !== undefined && row.values[field.key] !== '',
                    );
              const explicit =
                entry.instance !== undefined
                  ? instanceRows.find((row) => row.id === entry.instance)
                  : undefined;
              const instanceState =
                instanceRows.length === 0
                  ? 'none'
                  : instanceRows.length === 1
                    ? 'single'
                    : 'multi';
              return {
                entryId: entry.id,
                capability: entry.capability,
                model: entry.model,
                displayName: entry.displayName ?? null,
                // D125 过渡：执行型条目 engine 为 null（61 §2）；D125-P2 接管。
                engine: entry.engine ?? null,
                instanceState,
                configured:
                  explicit !== undefined
                    ? configured(explicit)
                    : instanceRows.length === 1
                      ? configured(instanceRows[0])
                      : instanceState === 'multi'
                        ? instanceRows.some((row) => configured(row))
                        : false,
              };
            }),
          });
        }
        return { plugins: groups };
      },
    ),
    /**
     * 整集替换 Bot 的启用条目集（`profile_json.runtime.capability_entries`，≤16）。
     * 与 `plugins.setBotPlugins` 同模式：先整批校验（插件已装且条目存在，未知 ref
     * 整批拒绝并列出违规项），再单字段写入；写后广播 `bot.updated` + `plugins.changed`
     * （ids = 新旧并集，让 Bot 详情与插件详情两侧都刷新）。
     */
    'plugins.setBotCapabilityEntries': method(
      pluginsSetBotCapabilityEntriesInputSchema,
      okOutputSchema,
      async (input) => {
        const domain = services.domain;
        if (domain === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
        const pluginRegistry = registry();
        // 整批预检在任何写入之前：按插件聚合条目声明，未知 ref 一次性列出。
        const byPlugin = new Map<string, Set<string>>();
        for (const ref of input.entries) {
          if (!byPlugin.has(ref.plugin)) {
            const manifest = await pluginRegistry.manifestOf(ref.plugin);
            byPlugin.set(
              ref.plugin,
              new Set((manifest?.contributions.capabilityModels ?? []).map((entry) => entry.id)),
            );
          }
        }
        const invalid: string[] = [];
        for (const ref of input.entries) {
          if (byPlugin.get(ref.plugin) === undefined) {
            invalid.push(`${ref.plugin}/${ref.entry}（插件未安装）`);
            continue;
          }
          if (!byPlugin.get(ref.plugin)!.has(ref.entry)) {
            invalid.push(`${ref.plugin}/${ref.entry}（条目不存在）`);
          }
        }
        if (invalid.length > 0) {
          throw new AppError('INVALID_INPUT', `未知的模型条目引用：${invalid.join('；')}`, {
            invalid,
          });
        }
        const bot = domain.bots.get(input.botId);
        const before = new Set((bot?.profile.runtime.capability_entries ?? []).map((r) => r.plugin));
        domain.bots.setCapabilityEntries(input.botId, input.entries);
        const updated = domain.bots.getOrThrow(input.botId);
        services.events.emit('bot.updated', { bot: updated });
        services.events.emit('plugins.changed', {
          ids: [
            ...new Set([
              ...before,
              ...input.entries.map((ref) => ref.plugin),
            ]),
          ],
        });
        return { ok: true as const };
      },
    ),
    /** 条目级连通性测试：凭据取实例（keyOverride 支持未保存先测），探针同 testCapability。 */
    'plugins.testCapabilityEntry': method(
      pluginsTestCapabilityEntryInputSchema,
      okOutputSchema,
      async (input) => {
        const media = services.media;
        if (media === null) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
        await media.testCapabilityEntry(input.pluginId, input.entryId, {
          ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
          ...(input.keyOverride !== undefined ? { keyOverride: input.keyOverride } : {}),
        });
        return { ok: true as const };
      },
    ),
  };
}

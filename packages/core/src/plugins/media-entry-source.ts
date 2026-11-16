import type { BotProfile, CapabilityModelEntry, PluginFieldValue } from '@kepcup/shared';
import {
  pluginInstanceSecretName,
  type PluginInstanceRow,
  type PluginInstanceStore,
} from './instances.js';
import { effectivePluginIds } from './effective.js';
import type { PluginRegistry } from './registry.js';
import type { MediaEntrySource, ResolvedEntry } from '../media/service.js';
import type { VendorAdapter } from '../media/types.js';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * 条目仓库实现（D124，60 号文档 §4）：MediaEntrySource 的 plugins 侧实现——
 * media 网关不反向依赖插件模块，start.ts 在插件装配后把它注入 MediaService。
 *
 * 有效集 = `botRuntime.capability_entries` ∩ `effectivePluginIds`（plugin_ids；
 * 条目仓库只有 botId 没有 conversationId，项目叠加授权不在此处）∩ 插件已装
 * 且启用（registry.isConsumable：state installed + enabled）。软引用语义与
 * `plugin_ids` 现状一致：插件卸载 / 停用 / 条目移除的残留引用解析时静默跳过
 * （60 §5），不报错。输出序（60 §4 ① 内排序）：插件级按 Bot 勾选序，插件内
 * 按条目声明序——回退默认条目 = 声明序首个（DEV-099）。
 *
 * 实例维度：条目显式 `instance`（且行存在）或插件恰好一个实例时填
 * `instanceId`；多实例未指定留空并携带全集（MediaService 判 INSTANCE_AMBIGUOUS）；
 * 零实例留空（CAPABILITY_NOT_CONFIGURED，payload 带条目定位）。
 */
export function createMediaEntrySource(deps: {
  registry: PluginRegistry;
  instances: PluginInstanceStore;
  secrets: Pick<SecretsService, 'getValue'>;
  /** Bot 的 runtime 读取（botId → profile.runtime；null = Bot 不存在）。 */
  botRuntimeOf: (botId: string) => BotProfile['runtime'] | null;
  logger: CoreLogger;
  /**
   * D125：执行型插件的托管适配器（PluginHost.adapterFor）。可选——未装配运行时
   * （单测 / 旧装配）时条目仍按 source 分类，但调用会得到「运行时未装配」。
   */
  hostedAdapterOf?: ((pluginId: string) => VendorAdapter) | undefined;
}): MediaEntrySource {
  /** 插件的 capability-model 实例行（创建序，保序）。 */
  const instanceRowsOf = (pluginId: string): PluginInstanceRow[] =>
    deps.instances.list(pluginId).filter((row) => row.kind === 'capability-model');

  const entriesOf = async (pluginId: string): Promise<CapabilityModelEntry[]> => {
    const manifest = await deps.registry.manifestOf(pluginId);
    if (manifest === null) return [];
    return manifest.contributions.capabilityModels ?? [];
  };

  return {
    async entriesFor(botId, capability) {
      // Bot 上下文缺省（渲染层直连等无 bot 面）= 不走条目路径，恒回全局槽位。
      if (botId === undefined || botId === '') return [];
      const runtime = deps.botRuntimeOf(botId);
      if (runtime === null) return [];
      const enabled = effectivePluginIds({ runtime });
      // 有效集第三闸（60 决策 5「插件已安装启用」）：全局停用 / 卸载中 / 已卸载
      // 的插件，残留引用一律静默跳过（与 `plugin_ids` 现状一致）。
      // refs 按插件聚合（Bot 勾选序 = 插件序，与「按插件分组勾选」的 UI 语义一致）。
      const refsByPlugin = new Map<string, string[]>();
      for (const ref of runtime.capability_entries ?? []) {
        if (!enabled.has(ref.plugin)) continue;
        if (!deps.registry.isConsumable(ref.plugin)) continue;
        const refs = refsByPlugin.get(ref.plugin);
        if (refs !== undefined) {
          if (!refs.includes(ref.entry)) refs.push(ref.entry);
        } else {
          refsByPlugin.set(ref.plugin, [ref.entry]);
        }
      }
      const resolved: ResolvedEntry[] = [];
      for (const [pluginId, refs] of refsByPlugin) {
        const rows = instanceRowsOf(pluginId);
        const manifest = await deps.registry.manifestOf(pluginId);
        const manifestEntries = manifest?.contributions.capabilityModels ?? [];
        // ① 内排序（60 §4）：插件内按条目声明序——回退默认条目 = 声明序首个。
        const matched = refs
          .map((refEntry) => {
            const declarationIndex = manifestEntries.findIndex(
              (candidate) => candidate.id === refEntry,
            );
            return declarationIndex >= 0
              ? { entry: manifestEntries[declarationIndex]!, declarationIndex }
              : null;
          })
          .filter(
            (hit): hit is { entry: CapabilityModelEntry; declarationIndex: number } => hit !== null,
          )
          .sort((a, b) => a.declarationIndex - b.declarationIndex);
        for (const { entry } of matched) {
          // embedding / rerank 条目本期不消费（60 §10 Q4：记忆管线绑定全局槽位）；
          // media 网关不会用这两个能力调 entriesFor，这里再挡一层（防御直调）。
          if (entry.capability === 'embedding' || entry.capability === 'rerank') continue;
          if (entry.capability !== capability) continue;
          // D125：执行体来源**逐条判定**（61 §5 / 60 §2「数据型条目（有 engine）语义
          // 不变」）——执行型插件里的数据型条目仍绑定第一方引擎（混合插件），只有
          // 不填 engine 的条目才解析到托管适配器。按插件整体判定会把混合插件的
          // engine 条目错误送进插件子进程，engine 绑定被静默忽略。
          const source: 'engine' | 'plugin' = entry.engine !== undefined ? 'engine' : 'plugin';
          const explicit =
            entry.instance !== undefined
              ? (rows.find((row) => row.id === entry.instance)?.id ?? undefined)
              : undefined;
          resolved.push({
            pluginId,
            entryId: entry.id,
            model: entry.model,
            engine: entry.engine ?? '',
            source,
            displayName: entry.displayName ?? entry.model,
            ...(entry.params !== undefined ? { params: entry.params } : {}),
            ...(explicit !== undefined
              ? { instanceId: explicit }
              : rows.length === 1
                ? { instanceId: rows[0]!.id }
                : {}),
            instances: rows.map((row) => row.id),
          });
        }
      }
      return resolved;
    },

    async entryOf(pluginId, entryId) {
      const entries = await entriesOf(pluginId);
      // D125：执行型条目（不填 engine）照常返回——探测经托管适配器同一 invoke 路径。
      return entries.find((entry) => entry.id === entryId) ?? null;
    },

    instancesOf(pluginId) {
      return instanceRowsOf(pluginId).map((row) => row.id);
    },

    async sensitiveFieldKeysOf(pluginId) {
      // D125：执行型实例的敏感字段声明（`runtime.instanceFields`，DEV-123）——条目级
      // 「未保存先测」把 keyOverride 映射到这些键。数据型插件的引擎凭据键由
      // `#resolvePluginInstance` 从引擎声明读取，不经过这里。
      const manifest = await deps.registry.manifestOf(pluginId);
      return (manifest?.runtime?.instanceFields ?? [])
        .filter((field) => field.sensitive)
        .map((field) => field.key);
    },

    instanceCredential(pluginId, instanceId, key, keyOverride) {
      // 未保存先测：覆盖值优先（与 providers.test 的 keyOverride 同语义）。
      if (keyOverride !== undefined) return keyOverride;
      return deps.secrets.getValue(pluginInstanceSecretName(pluginId, instanceId, key));
    },

    instanceConfig(pluginId, instanceId) {
      const row = deps.instances.get(instanceId);
      if (row === null || row.pluginId !== pluginId) return null;
      try {
        return JSON.parse(row.configJson) as Record<string, PluginFieldValue>;
      } catch {
        return {};
      }
    },

    async capabilityInstanceOf(instanceId) {
      const row = deps.instances.get(instanceId);
      if (row === null || row.kind !== 'capability-model') return null;
      // 插件粒度 = 平台协议族（60 号 §术语）：videoStatus 往返只认提交任务的插件。
      // 数据型插件保持 D124 口径（条目取声明序首个，不因 video 条目改道）；含 runtime
      // 段的插件优先取首个视频条目（执行型 videoStatus 需要 video 条目的 entryId /
      // model），无视频条目则首个。来源按选中条目自身是否绑定 engine 判定。
      const entries = await entriesOf(row.pluginId);
      const manifest = await deps.registry.manifestOf(row.pluginId);
      const entry =
        manifest?.runtime !== undefined
          ? (entries.find((candidate) => candidate.capability === 'video') ?? entries[0])
          : entries[0];
      const source: 'engine' | 'plugin' = entry?.engine !== undefined ? 'engine' : 'plugin';
      return {
        pluginId: row.pluginId,
        engine: entry?.engine ?? '',
        source,
        entryId: entry?.id ?? 'unknown',
        model: entry?.model ?? 'unknown',
      };
    },

    async hostedAdapterOf(pluginId) {
      const manifest = await deps.registry.manifestOf(pluginId);
      if (manifest?.runtime === undefined) return null;
      return deps.hostedAdapterOf?.(pluginId) ?? null;
    },
  };
}

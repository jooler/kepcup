import type {
  CapabilityEntryRef,
  McpServer,
  PluginCapabilityEntryGroup,
  PluginContributionKind,
  PluginSummary,
} from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * Bot 详情「插件」区块（P2 注入模型）的纯逻辑：插件启用集（`runtime.plugin_ids`）
 * 的整集写入计算、插件类别徽标推导（协议不可见：mcp 显示「工具」）、展开细选里
 * 手动工具服务的筛选。组件只负责渲染。
 */

/**
 * 勾选 / 取消一个插件后的启用集：保持其余 id 顺序、去重（`plugins.setBotPlugins`
 * 整体替换，写入端以此为准）。缺失（= 未启用任何插件）视作空集。
 */
export function togglePluginId(
  current: readonly string[] | undefined,
  pluginId: string,
  enabled: boolean,
): string[] {
  const kept = dedupePluginIds(current ?? []).filter((id) => id !== pluginId);
  return enabled ? [...kept, pluginId] : kept;
}

/** 去重（保序）：整集写入前的统一出口。 */
export function dedupePluginIds(ids: readonly string[]): string[] {
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

/** 与已安装清单求交后的启用数（卸载残留的 id 不计入摘要）。 */
export function enabledPluginCount(
  current: readonly string[] | undefined,
  installed: readonly { id: string }[],
): number {
  const ids = new Set(installed.map((plugin) => plugin.id));
  return dedupePluginIds(current ?? []).filter((id) => ids.has(id)).length;
}

/** 添加弹框的搜索口径：名称 / id / 描述 / 作者的任一字段包含全部关键词（空查询恒命中）。 */
export function matchesPluginQuery(
  plugin: Pick<PluginSummary, 'id' | 'name' | 'description' | 'author'>,
  query: string,
): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = [plugin.name, plugin.id, plugin.description, plugin.author ?? '']
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** 该 Bot 已添加、且仍在已安装清单里的插件（保持已安装清单的顺序）。 */
export function addedPlugins(
  installed: readonly PluginSummary[],
  current: readonly string[] | undefined,
): PluginSummary[] {
  const ids = new Set(dedupePluginIds(current ?? []));
  return installed.filter((plugin) => ids.has(plugin.id));
}

/** 类别徽标的文案键（`mcp` 的显示名即 i18n `plugins.kind.mcp` =「工具」）。 */
export const PLUGIN_KIND_LABEL_KEYS: Readonly<Record<PluginContributionKind, MessageKey>> = {
  skill: 'plugins.kind.skill',
  connector: 'plugins.kind.connector',
  mcp: 'plugins.kind.mcp',
  mail: 'plugins.kind.mail',
  im: 'plugins.kind.im',
  'capability-model': 'plugins.kind.capabilityModel',
};

/**
 * 插件类别徽标（技能 / 连接 / 工具 / 邮件 / 即时通讯 / 模型，顺序固定）：按贡献
 * 计数与实例声明推导。`mcp` 一律显示「工具」类说法（显示名在 i18n
 * `plugins.kind.mcp`，协议词不出现在界面）；纯实例插件（`providesInstances`）
 * 没有贡献计数也能被标出类别。D124：能力模型条目显示「模型」（counts 无该键，
 * 条目数走 capability-entries store，这里只按 `providesInstances` 判定出徽标）。
 */
export function pluginKindBadges(
  plugin: Pick<PluginSummary, 'counts' | 'providesInstances'>,
): PluginContributionKind[] {
  const kinds: PluginContributionKind[] = [];
  if (plugin.counts.skills > 0) kinds.push('skill');
  if (plugin.counts.connectors > 0) kinds.push('connector');
  if (plugin.counts.mcp > 0 || plugin.providesInstances.includes('mcp')) kinds.push('mcp');
  if (plugin.counts.mail > 0 || plugin.providesInstances.includes('mail')) kinds.push('mail');
  if (plugin.counts.im > 0 || plugin.providesInstances.includes('im')) kinds.push('im');
  if (plugin.providesInstances.includes('capability-model')) kinds.push('capability-model');
  return kinds;
}

/**
 * 插件是否提供某类能力（徽标 + 展开细选都按它判定）：贡献计数或实例声明任一命中。
 */
export function pluginProvides(
  plugin: Pick<PluginSummary, 'counts' | 'providesInstances'>,
  kind: 'connector' | 'mcp' | 'mail' | 'im',
): boolean {
  return kind === 'connector'
    ? plugin.counts.connectors > 0
    : plugin.counts[kind] > 0 || plugin.providesInstances.includes(kind);
}

/**
 * 展开细选里可勾选的工具服务（现 bot-mcp 控件）：应用级已启用，且**不是**插件承载的
 * server——固定投影（`plugin` 来源）随插件启用集自动可用（P2 §3.3，历史勾选读时忽略）；
 * 实例来源（`instance`，P4-M2）移到插件卡展开区逐个勾选授权，同样不在这里；只剩手动 /
 * mcpb 独立安装的 server 维持 `mcp_server_ids` 勾选。
 */
export function manualToolServers(servers: readonly McpServer[]): McpServer[] {
  return servers.filter(
    (server) =>
      server.enabled &&
      (server.source?.kind ?? 'manual') !== 'plugin' &&
      server.source?.kind !== 'instance',
  );
}

// --- D124：模型条目勾选（`runtime.capability_entries` 整集替换） -----------------

/** 条目分组的展示顺序（schema 七能力；embedding / rerank 本期不消费，声明了也照常展示）。 */
export const ENTRY_GROUP_ORDER = [
  'image',
  'video',
  'tts',
  'asr',
  'multimodal',
  'embedding',
  'rerank',
] as const;

/** 能力 → 分组标题文案键（图片生成 / 视频生成 / 语音合成 / 语音识别 / 图文理解…）。 */
export const ENTRY_GROUP_LABEL_KEYS: Readonly<
  Record<(typeof ENTRY_GROUP_ORDER)[number], MessageKey>
> = {
  image: 'botPanel.plugins.entryGroup.image',
  video: 'botPanel.plugins.entryGroup.video',
  tts: 'botPanel.plugins.entryGroup.tts',
  asr: 'botPanel.plugins.entryGroup.asr',
  multimodal: 'botPanel.plugins.entryGroup.multimodal',
  embedding: 'botPanel.plugins.entryGroup.embedding',
  rerank: 'botPanel.plugins.entryGroup.rerank',
};

/** 去重（保序）：`capability_entries` 与 `plugin_ids` 同一套整集写入前的出口。 */
export function dedupeEntryRefs(refs: readonly CapabilityEntryRef[]): CapabilityEntryRef[] {
  return refs.filter(
    (ref, index) =>
      refs.findIndex(
        (candidate) => candidate.plugin === ref.plugin && candidate.entry === ref.entry,
      ) === index,
  );
}

/** 条目引用的稳定键（plugin + entry；`\0` 不会出现在任一字段里）。 */
export function entryRefKey(ref: CapabilityEntryRef): string {
  return `${ref.plugin}\u0000${ref.entry}`;
}

/** 已装插件的当前条目集合（`plugins.listCapabilityEntries` 投影）→ 可引用的键集合。 */
export function knownEntryRefKeys(groups: readonly PluginCapabilityEntryGroup[]): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    for (const entry of group.entries) keys.add(`${group.pluginId}\u0000${entry.entryId}`);
  }
  return keys;
}

/**
 * 只保留条目仍存在的引用（插件更新删掉条目后，Bot profile 里的残留引用会让
 * `setBotCapabilityEntries` 整批拒绝，而卡上已没有可取消的勾选框——保存 / 上限计数
 * 前剪掉）。调用方只在条目清单已成功加载时使用；未加载时不能把未知当不存在。
 */
export function entryRefsStillKnown(
  refs: readonly CapabilityEntryRef[],
  knownKeys: ReadonlySet<string>,
): CapabilityEntryRef[] {
  return refs.filter((ref) => knownKeys.has(entryRefKey(ref)));
}

/**
 * 勾选 / 取消一个条目后的引用集：保持其余引用顺序、去重（`plugins.setBotCapabilityEntries`
 * 整体替换，写入端以此为准）。缺失视作空集。
 */
export function toggleEntryRef(
  current: readonly CapabilityEntryRef[] | undefined,
  pluginId: string,
  entryId: string,
  enabled: boolean,
): CapabilityEntryRef[] {
  const kept = dedupeEntryRefs(current ?? []).filter(
    (ref) => !(ref.plugin === pluginId && ref.entry === entryId),
  );
  return enabled ? [...kept, { plugin: pluginId, entry: entryId }] : kept;
}

/**
 * 该插件在清单里的条目按能力分组（能力标题用固定顺序；空能力不出组）。Bot 展开
 * 区的「模型条目」区按组渲染复选。
 */
export function groupEntriesByCapability(
  entries: readonly PluginCapabilityEntryGroup['entries'][number][],
): Array<{ capability: (typeof ENTRY_GROUP_ORDER)[number]; entries: typeof entries }> {
  const groups: Array<{
    capability: (typeof ENTRY_GROUP_ORDER)[number];
    entries: typeof entries;
  }> = [];
  for (const capability of ENTRY_GROUP_ORDER) {
    const matched = entries.filter((entry) => entry.capability === capability);
    if (matched.length > 0) groups.push({ capability, entries: matched });
  }
  return groups;
}

/**
 * 只保留来源插件仍在「该 Bot 的启用集」里的引用（去重、保序）。`capability_entries`
 * 的有效集 = 本字段 ∩ `plugin_ids`（core `entriesFor`）：插件被移出 Bot / 已卸载的
 * 引用永不生效，但会占满 shared 契约的 16 条上限且卡上没有可取消的勾选框（死路）。
 * 因此上限计数与保存都以启用集为准——移出 Bot 的插件条目在下次条目保存时清理。
 */
export function entryRefsOfEnabledPlugins(
  refs: readonly CapabilityEntryRef[] | undefined,
  pluginIds: readonly string[],
): CapabilityEntryRef[] {
  const enabled = new Set(pluginIds);
  return dedupeEntryRefs(refs ?? []).filter((ref) => enabled.has(ref.plugin));
}

/**
 * 保存（整集替换）前剔除不生效的残留引用：插件已卸载 / 已移出本 Bot。core 的
 * `setBotCapabilityEntries` 对未知 ref 整批拒绝（INVALID_INPUT），渲染端不发送；
 * 传入 Bot 的 `plugin_ids`（启用集）而不是全部已装插件——已装但不在本 Bot 的插件
 * 条目同属不可达，留在字段里只会占上限（见 {@link entryRefsOfEnabledPlugins}）。
 */
export function saveableEntryRefs(
  current: readonly CapabilityEntryRef[] | undefined,
  activePluginIds: readonly string[],
): CapabilityEntryRef[] {
  return entryRefsOfEnabledPlugins(current, activePluginIds);
}

/**
 * 条目行的次级文案（`model · engine`）。执行型条目（不填 engine，`source:'plugin'`）
 * 没有第一方引擎——不能把 `null` 拼进文案；只显示 model（所属插件卡已表明执行型）。
 */
export function entryDetailText(
  entry: Pick<PluginCapabilityEntryGroup['entries'][number], 'model' | 'engine'>,
): string {
  return entry.engine === null || entry.engine === ''
    ? entry.model
    : `${entry.model} · ${entry.engine}`;
}

/** `capability_entries` 上限（shared 契约 ≤16）：超出时勾选不再追加。 */
export const CAPABILITY_ENTRIES_MAX = 16;

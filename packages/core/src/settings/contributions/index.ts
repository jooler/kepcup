import type { SettingItem } from '@kepcup/shared';
import {
  READONLY_ITEM_ADAPTER,
  RENDERER_ADAPTER,
  viaToolAdapter,
  type AdapterDeps,
  type ItemAdapter,
} from '../adapters.js';
import { snapshot } from '../adapters.js';
import { genericSettingsAdapter } from '../generic-adapter.js';
import { botContribution } from './bot.js';
import { capabilityContribution } from './capability.js';
import { environmentContribution } from './environment.js';
import { generalContribution } from './general.js';
import { legacyContribution } from './legacy.js';
import { modelsContribution } from './models.js';
import { remoteContribution } from './remote.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * core 适配器贡献表（todo/settings-catalog-registry.md §4.2）：新功能在这里加一行
 * barrel（或并入 legacy），闭合检查见 `settingsAdapterCoverageProblems`。
 */
export const SETTING_ADAPTER_CONTRIBUTIONS: readonly SettingAdapterContribution[] = [
  capabilityContribution,
  modelsContribution,
  botContribution,
  generalContribution,
  environmentContribution,
  remoteContribution,
  legacyContribution,
];

/**
 * 明确接受「没有适配器」的条目及理由。只能在这里登记，不能靠静默兜底；条目一旦有了
 * 适配器（或不再需要），覆盖测试会点名要求删掉。
 */
export const EXPLICIT_ADAPTER_FALLBACK: Readonly<Record<string, string>> = {
  'profile.user-facts': '没有不含画像原文的安全信号，读状态以设置页为准',
};

/** 贡献表登记的全部条目 id（覆盖测试的 `adapterIds`）。 */
export function settingAdapterContributionIds(): string[] {
  return SETTING_ADAPTER_CONTRIBUTIONS.flatMap((contribution) =>
    Object.keys(contribution.adapters),
  );
}

/** 漏登记条目的读法：`unknown`（不是 `configured`），Bot 不会误判能力可用。 */
const UNREGISTERED_ITEM_ADAPTER: ItemAdapter = {
  read: () => snapshot('unknown', null, '未接入设置目录适配器'),
};

function assembleAdapters(
  contributions: readonly SettingAdapterContribution[],
  deps: AdapterDeps,
): Map<string, ItemAdapter> {
  const byId = new Map<string, ItemAdapter>();
  for (const contribution of contributions) {
    for (const [id, factory] of Object.entries(contribution.adapters)) {
      if (byId.has(id)) throw new Error(`重复的设置适配器：${id}（贡献 ${contribution.name}）`);
      byId.set(id, factory(deps));
    }
  }
  return byId;
}

/**
 * 全部条目的适配器（按 id，原 `adapters.ts` 的同名函数）。短路顺序与改造前一致：
 * 只读 → 渲染层 → 贡献表（含 via-tool 条目自己的读适配器）→ via-tool → 通用标量 →
 * 未登记（unknown）。
 */
export function buildItemAdapters(deps: AdapterDeps): (item: SettingItem) => ItemAdapter {
  const byId = assembleAdapters(SETTING_ADAPTER_CONTRIBUTIONS, deps);
  return (item) => {
    if (item.readOnly) return READONLY_ITEM_ADAPTER;
    if (item.owner === 'renderer') return RENDERER_ADAPTER;
    const adapter = byId.get(item.id);
    if (adapter !== undefined) return adapter;
    if (item.write.via !== 'catalog') return viaToolAdapter(item.write.via.tool);
    if (item.store.kind === 'settings' && item.store.generic === true) {
      return genericSettingsAdapter(deps, item);
    }
    return UNREGISTERED_ITEM_ADAPTER;
  };
}

export { assembleAdapters };

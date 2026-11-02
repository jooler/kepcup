import type {
  CapabilityModelKey,
  ModelCapability,
  ProviderInstance,
  Settings,
} from '@kepcup/shared';
import { VENDOR_DESCRIPTORS } from '@kepcup/shared';

/**
 * 供应商实例（settings.modelProviders）的设置页纯逻辑：左栏导航投影、
 * 状态点、能力槽位候选与实例增删改的落盘。组件只做渲染；这里全部是
 * 可单测的纯函数。
 */

/** 左栏供应商条目的状态点：绿 = 可用，黄 = 配置不完整，灰 = 已停用。 */
export type ProviderNavStatus = 'ready' | 'incomplete' | 'disabled';

/** 状态点判定：停用 = 灰；有 Key 且登记了模型 = 绿；其余 = 黄（不完整）。 */
export function providerNavStatus(
  instance: ProviderInstance,
  hasKey: boolean,
): ProviderNavStatus {
  if (!instance.enabled) return 'disabled';
  return hasKey && instance.models.length > 0 ? 'ready' : 'incomplete';
}

/** 左栏导航条目：实例 + 展示所需的派生状态。 */
export interface ProviderNavItem {
  instance: ProviderInstance;
  status: ProviderNavStatus;
}

/** 左栏导航分组（分组能力保留，当前不开放编辑）。 */
export interface ProviderNavGroup {
  /** 分组 id（= 实例的 group 字段；隐式分组为 ''）。 */
  id: string;
  /** 分组标题；隐式分组不渲染标题。 */
  title: string | null;
  items: ProviderNavItem[];
}

/**
 * 实例 → 左栏分组投影：按 `group` 字段聚合（保持出现顺序），未设分组的
 * 归入隐式分组（不渲染标题）。未来自有供应商 = 给实例写 group，并在此处
 * 登记分组标题（常量表）。
 */
export function buildProviderNavGroups(
  instances: readonly ProviderInstance[],
  hasKeyById: ReadonlyMap<string, boolean>,
): ProviderNavGroup[] {
  const groups: ProviderNavGroup[] = [{ id: '', title: null, items: [] }];
  const byId = new Map<string, ProviderNavGroup>([['', groups[0]!]]);
  for (const instance of instances) {
    const key = instance.group ?? '';
    let group = byId.get(key);
    if (group === undefined) {
      group = { id: key, title: key, items: [] };
      byId.set(key, group);
      groups.push(group);
    }
    group.items.push({
      instance,
      status: providerNavStatus(instance, hasKeyById.get(instance.id) ?? false),
    });
  }
  return groups.filter((group) => group.items.length > 0);
}

/**
 * 能力槽位候选：声明了该能力的供应商实例（内置厂商实例还要求描述符能力
 * 矩阵开放该能力；自定义实例只有向量有跨厂商事实标准）。与 core 侧
 * capabilityAdapter 的 capableProviders 同一语义；hasKeyById 用于把
 * 已配 Key 的实例排前面。
 */
export function capabilityProviderCandidates(
  providers: readonly ProviderInstance[],
  capability: CapabilityModelKey,
  hasKeyById: ReadonlyMap<string, boolean> = new Map(),
): ProviderInstance[] {
  return providers
    .filter((instance) => {
      if (!instance.enabled) return false;
      if (instance.vendor !== null) {
        return VENDOR_DESCRIPTORS[instance.vendor].capabilities.includes(capability);
      }
      // Anthropic 协议端点没有 OpenAI 兼容的 /embeddings；pi 目录实例同理不进。
      if (instance.api === 'anthropic-messages' || instance.builtinCatalog) return false;
      return capability === 'embedding';
    })
    .sort(
      (a, b) => Number(hasKeyById.get(b.id) ?? false) - Number(hasKeyById.get(a.id) ?? false),
    );
}

/** 一个实例在某能力下的模型候选：登记的声明模型优先，预置 id 补后（排重）。 */
export function capabilityModelChoices(
  instance: ProviderInstance,
  capability: CapabilityModelKey,
): string[] {
  const declared = instance.models
    .filter((m) => m.capabilities.includes(capability))
    .map((m) => m.id);
  const presets =
    instance.vendor !== null ? VENDOR_DESCRIPTORS[instance.vendor].presets[capability] : [];
  return [...new Set([...declared, ...presets])];
}

/** 上下文窗口的紧凑展示（1M / 128K / 4096）。 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(tokens);
}

/** 实例上单个模型的能力 badge（chat 不显示 badge，模型列表默认即对话）。 */
export function modelCapabilityBadges(capabilities: readonly ModelCapability[]): ModelCapability[] {
  return capabilities.filter((c) => c !== 'chat');
}

/**
 * 删除实例的联动清理：引用它的能力槽位置空（在传入的最新设置上生成补丁，
 * 不动兄弟能力）；Key 由调用方走 providers.removeKey 一并删除。
 */
export function settingsWithoutInstance(settings: Settings, id: string): Partial<Settings> {
  const capabilityModels = { ...settings.capabilityModels };
  for (const key of Object.keys(capabilityModels) as CapabilityModelKey[]) {
    if (capabilityModels[key]?.provider === id) capabilityModels[key] = null;
  }
  return {
    modelProviders: settings.modelProviders.filter((p) => p.id !== id),
    capabilityModels,
  };
}

/** 模板卡的首字母头像配色（按 id 稳定取色）。 */
const AVATAR_STYLES = [
  'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
  'bg-orange-500/15 text-orange-600 dark:text-orange-400',
] as const;

export function templateAvatarStyle(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_STYLES[hash % AVATAR_STYLES.length]!;
}

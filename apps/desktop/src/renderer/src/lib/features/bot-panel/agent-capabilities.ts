import {
  HOST_CAPABILITIES,
  defaultCapabilities,
  type HostCapabilityCategory,
  type HostCapabilityId,
  type HostCapabilityPrerequisite,
  type NativeCapabilityKey,
} from '@kepcup/shared';

/**
 * Bot 运行配置「注入 KepCup 能力」勾选清单的纯逻辑（D72 §4.1，
 * docs/design/28-external-agents-acp.md）：默认值 = 必选 + 默认注入 − Agent
 * 原生已有；`capabilities` 为 null 表示跟随默认值。组件只负责渲染。
 */

/** 按前缀归包的工具在 UI 上的预估数量（`browser_*` 共 9 个，见 core tools）。 */
const PREFIX_TOOL_ESTIMATE: Record<string, number> = { browser_: 9 };

export interface CapabilityRow {
  id: HostCapabilityId;
  category: HostCapabilityCategory;
  required: boolean;
  checked: boolean;
  /** Agent 自带的同类原生工具名（非空 = 「自带此能力，注入后仅作兜底」）。 */
  nativeTools: string[];
  /** 前置配置缺失（仍可勾选，调用时走对话内设置卡）。 */
  unconfigured: boolean;
  /** 该包的工具数；null = 动态（用户 MCP）。 */
  toolCount: number | null;
}

export interface CapabilityContext {
  nativeCapabilities: Partial<Record<NativeCapabilityKey, readonly string[]>>;
  /** 前置配置是否就绪（检索供应商 / 能力模型）。 */
  prerequisiteReady(prerequisite: HostCapabilityPrerequisite): boolean;
}

export function toolCountOf(id: HostCapabilityId): number | null {
  const pack = HOST_CAPABILITIES.find((capability) => capability.id === id)!;
  if (pack.default === 'follow_bot') return null;
  return (
    pack.tools.length +
    pack.toolPrefixes.reduce((sum, prefix) => sum + (PREFIX_TOOL_ESTIMATE[prefix] ?? 1), 0)
  );
}

/** 生效的勾选集合（null = 默认值）；`core` 恒在。 */
export function effectiveCapabilities(
  stored: readonly string[] | null,
  context: Pick<CapabilityContext, 'nativeCapabilities'>,
): HostCapabilityId[] {
  const base = stored === null ? defaultCapabilities(context) : stored;
  const known = new Set<string>(HOST_CAPABILITIES.map((capability) => capability.id));
  const set = new Set(base.filter((id) => known.has(id)) as HostCapabilityId[]);
  set.add('core');
  return HOST_CAPABILITIES.map((capability) => capability.id).filter((id) => set.has(id));
}

export function capabilityRows(
  stored: readonly string[] | null,
  context: CapabilityContext,
): CapabilityRow[] {
  const selected = new Set(effectiveCapabilities(stored, context));
  return HOST_CAPABILITIES.map((capability) => {
    const native =
      capability.overlapsNative !== null
        ? [...(context.nativeCapabilities[capability.overlapsNative] ?? [])]
        : [];
    return {
      id: capability.id,
      category: capability.category,
      required: capability.default === 'required',
      checked: selected.has(capability.id),
      nativeTools: native,
      unconfigured:
        capability.prerequisite !== null && !context.prerequisiteReady(capability.prerequisite),
      toolCount: toolCountOf(capability.id),
    };
  });
}

/** 勾选 / 取消一个包后的显式集合（`core` 不可取消）。 */
export function toggleCapability(
  stored: readonly string[] | null,
  id: HostCapabilityId,
  checked: boolean,
  context: Pick<CapabilityContext, 'nativeCapabilities'>,
): HostCapabilityId[] {
  const current = effectiveCapabilities(stored, context);
  if (id === 'core') return current;
  const next = checked ? [...current, id] : current.filter((item) => item !== id);
  return effectiveCapabilities(next, context);
}

/** 与默认值相同则回到 null（跟随默认，日后目录声明变化时自动更新）。 */
export function normalizeCapabilities(
  selected: readonly HostCapabilityId[],
  context: Pick<CapabilityContext, 'nativeCapabilities'>,
): HostCapabilityId[] | null {
  const defaults = effectiveCapabilities(null, context);
  const same =
    defaults.length === selected.length && defaults.every((id, index) => selected[index] === id);
  return same ? null : [...selected];
}

/** 预计注入的工具数（不含用户 MCP 服务器的动态工具）及是否含 MCP。 */
export function estimatedTools(rows: readonly CapabilityRow[]): { count: number; mcp: boolean } {
  let count = 0;
  let mcp = false;
  for (const row of rows) {
    if (!row.checked) continue;
    if (row.toolCount === null) mcp = true;
    else count += row.toolCount;
  }
  return { count, mcp };
}

/** 主选择器的取值编码：内置模型 = 模型 ref；智能体 = `@agent:{id}`。 */
export const AGENT_OPTION_PREFIX = '@agent:';

export function engineValue(runtime: { model: string; agent: { id: string } }): string {
  return runtime.agent.id.length > 0 ? `${AGENT_OPTION_PREFIX}${runtime.agent.id}` : runtime.model;
}

export function parseEngineValue(value: string): { agentId: string } | { model: string } {
  return value.startsWith(AGENT_OPTION_PREFIX)
    ? { agentId: value.slice(AGENT_OPTION_PREFIX.length) }
    : { model: value };
}

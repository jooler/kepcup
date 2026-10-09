import { z } from 'zod';

/**
 * 宿主能力包登记表（docs/design/28-external-agents-acp.md §4.1，D72）。
 *
 * Bot 改由外部智能体（Agent）驱动时，KepCup 的宿主能力按「能力包」经宿主
 * MCP 桥注入；core 的桥 / 提示词与 desktop 的勾选 UI 共用这一份事实。
 * 内置 pi 引擎不受影响（仍拿到全部工具）。
 */

export const hostCapabilityIdSchema = z.enum([
  'core',
  'memory',
  'wiki',
  'schedule',
  'collaboration',
  'browser',
  'web',
  'image_generation',
  'image_understanding',
  'speech',
  'transcription',
  'video',
  'skills',
  'host_ops',
  'mcp',
  'apps',
]);
export type HostCapabilityId = z.infer<typeof hostCapabilityIdSchema>;

/**
 * 与 Agent 原生能力重叠的键：目录条目的 `nativeCapabilities` 以这些键声明
 * 「自带能力 → 原生工具名」，用于默认值计算与 `<tool_policy>` 点名（§4.2）。
 */
export const nativeCapabilityKeySchema = z.enum([
  'browser',
  'web',
  'image_generation',
  'vision',
  'tts',
  'asr',
  'video',
]);
export type NativeCapabilityKey = z.infer<typeof nativeCapabilityKeySchema>;

/**
 * 类别（§4.2）：`host` 宿主语义类以 KepCup 工具为准（宿主优先）；
 * `supplement` 补位类原生优先，注入工具只作兜底。
 */
export type HostCapabilityCategory = 'host' | 'supplement';

/**
 * 默认策略：`required` 必选（不可取消）；`inject` 默认注入，但 Agent 原生
 * 具备重叠能力时不勾选；`follow_bot` 跟随 Bot 既有勾选（用户 MCP 的
 * `mcp_server_ids`）。
 */
export type HostCapabilityDefault = 'required' | 'inject' | 'follow_bot';

/** 前置配置（缺失时包仍可勾选，调用时走既有 SETUP_REQUIRED → 对话内设置卡）。 */
export type HostCapabilityPrerequisite =
  | { kind: 'web-search' }
  | { kind: 'capability-model'; capability: 'image' | 'multimodal' | 'tts' | 'asr' | 'video' };

export interface HostCapabilityDescriptor {
  id: HostCapabilityId;
  category: HostCapabilityCategory;
  /** 包内工具名（`toolPrefixes` 之外的精确名）。 */
  tools: readonly string[];
  /** 按前缀归入本包的工具（`browser_*`）。 */
  toolPrefixes: readonly string[];
  /** 仅管家（D70）额外拿到、且对管家必选的专属工具。 */
  butlerTools: readonly string[];
  default: HostCapabilityDefault;
  /** 与 Agent 原生能力的重叠键；null = 无重叠（宿主语义类）。 */
  overlapsNative: NativeCapabilityKey | null;
  prerequisite: HostCapabilityPrerequisite | null;
  /** 界面文案 key（名称 `{i18nKey}.name`、说明 `{i18nKey}.description`）。 */
  i18nKey: string;
}

function pack(
  input: Pick<HostCapabilityDescriptor, 'id' | 'category' | 'default'> &
    Partial<Omit<HostCapabilityDescriptor, 'id' | 'category' | 'default' | 'i18nKey'>>,
): HostCapabilityDescriptor {
  return {
    tools: [],
    toolPrefixes: [],
    butlerTools: [],
    overlapsNative: null,
    prerequisite: null,
    ...input,
    i18nKey: `agents.capabilities.${input.id}`,
  };
}

export const HOST_CAPABILITIES: readonly HostCapabilityDescriptor[] = [
  pack({
    id: 'core',
    category: 'host',
    default: 'required',
    tools: [
      'send_message',
      'skip_reply',
      'search_messages',
      'get_messages_around',
      'get_attachment',
      'list_my_runs',
      'get_run',
    ],
  }),
  pack({
    id: 'memory',
    category: 'host',
    default: 'inject',
    tools: [
      'remember',
      'recall_memory',
      'get_user_profile',
      'list_commitments',
      'memory_feedback',
      'forget',
      'propose_profile_change',
    ],
  }),
  pack({
    id: 'wiki',
    category: 'host',
    default: 'inject',
    tools: ['wiki_search', 'wiki_read', 'wiki_enqueue'],
  }),
  pack({
    id: 'schedule',
    category: 'host',
    default: 'inject',
    tools: ['schedule', 'list_schedules', 'cancel_schedule'],
  }),
  pack({
    id: 'collaboration',
    category: 'host',
    default: 'inject',
    tools: ['list_bots', 'delegate_to_bot', 'cancel_delegation'],
    butlerTools: ['propose_bot', 'propose_group', 'propose_team', 'suggest_route'],
  }),
  pack({
    id: 'browser',
    category: 'supplement',
    default: 'inject',
    toolPrefixes: ['browser_'],
    overlapsNative: 'browser',
  }),
  pack({
    id: 'web',
    category: 'supplement',
    default: 'inject',
    tools: ['web_search', 'web_fetch'],
    overlapsNative: 'web',
    prerequisite: { kind: 'web-search' },
  }),
  pack({
    id: 'image_generation',
    category: 'supplement',
    default: 'inject',
    tools: ['generate_image'],
    overlapsNative: 'image_generation',
    prerequisite: { kind: 'capability-model', capability: 'image' },
  }),
  pack({
    id: 'image_understanding',
    category: 'supplement',
    default: 'inject',
    tools: ['understand_image'],
    overlapsNative: 'vision',
    prerequisite: { kind: 'capability-model', capability: 'multimodal' },
  }),
  pack({
    id: 'speech',
    category: 'supplement',
    default: 'inject',
    tools: ['generate_speech'],
    overlapsNative: 'tts',
    prerequisite: { kind: 'capability-model', capability: 'tts' },
  }),
  pack({
    id: 'transcription',
    category: 'supplement',
    default: 'inject',
    tools: ['transcribe_audio'],
    overlapsNative: 'asr',
    prerequisite: { kind: 'capability-model', capability: 'asr' },
  }),
  pack({
    id: 'video',
    category: 'supplement',
    default: 'inject',
    tools: ['generate_video'],
    overlapsNative: 'video',
    prerequisite: { kind: 'capability-model', capability: 'video' },
  }),
  pack({
    id: 'skills',
    category: 'host',
    default: 'inject',
    tools: ['install_skill', 'create_skill'],
  }),
  pack({
    id: 'host_ops',
    category: 'host',
    default: 'inject',
    tools: ['request_environment', 'git_remote'],
  }),
  // 工具集合 = 该 Bot 勾选的用户 MCP server（D65 `mcp_server_ids`），动态；
  // 包装后的工具名为 `mcp_{serverId}_{tool}`（core `mcpToolName`）。
  pack({ id: 'mcp', category: 'supplement', default: 'follow_bot', toolPrefixes: ['mcp_'] }),
  // 连接应用（D73，design 29 §10）：工具集合 = 该 Bot 勾选的目录连接（`app_connection_ids`），
  // 动态；工具名 `app_{slug}_{tool}`，宿主自有的 `app_request_connection` 同前缀。
  // 工具在宿主执行（令牌留在宿主、审批 / 风险策略与内置引擎同一网关）。
  pack({ id: 'apps', category: 'supplement', default: 'follow_bot', toolPrefixes: ['app_'] }),
];

/**
 * 外部 Agent 下**永不注入**的工具（§4.1）：与 Agent 原生文件 / 命令工具或
 * 宿主机制（授权、租约、宿主 SubAgent）冲突。
 */
export const NEVER_INJECTED_TOOLS: readonly string[] = [
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'bash',
  'request_access',
  'request_unsandboxed',
  'acquire_project_write',
  'delegate_task',
  // D66 后台分支的取回（D75 §1.2）：与 delegate_task 成对，外部 Agent 无分支可取。
  'collect_delegate_results',
];

export function hostCapability(id: HostCapabilityId): HostCapabilityDescriptor {
  return HOST_CAPABILITIES.find((entry) => entry.id === id)!;
}

/**
 * 能力包默认值（§4.1「默认值计算」）：`core` 必选；其余 = 默认注入的包 −
 * Agent 原生能力覆盖的包（`nativeCapabilities` 声明了非空工具名列表才算
 * 具备；未声明视为不具备）。纯函数，结果按登记表顺序。
 */
export function defaultCapabilities(entry: {
  nativeCapabilities: Partial<Record<NativeCapabilityKey, readonly string[]>>;
}): HostCapabilityId[] {
  return HOST_CAPABILITIES.filter((capability) => {
    if (capability.default === 'required' || capability.default === 'follow_bot') return true;
    if (capability.overlapsNative === null) return true;
    const native = entry.nativeCapabilities[capability.overlapsNative];
    return native === undefined || native.length === 0;
  }).map((capability) => capability.id);
}

/**
 * 工具所属的能力包（精确名优先，其次前缀；管家专属工具归 `collaboration`）。
 * 不属于任何包（如访谈专用工具）返回 null——外部 Agent 下不注入。
 */
export function capabilityOfTool(toolName: string): HostCapabilityDescriptor | null {
  return (
    HOST_CAPABILITIES.find(
      (capability) =>
        capability.tools.includes(toolName) || capability.butlerTools.includes(toolName),
    ) ??
    HOST_CAPABILITIES.find((capability) =>
      capability.toolPrefixes.some((prefix) => toolName.startsWith(prefix)),
    ) ??
    null
  );
}

/**
 * 一个 Bot 实际注入的能力包（§4.1）：`selected` 为 null 时用
 * `defaultCapabilities(entry)`；未知 id 丢弃；`core` 恒加入（不可取消）；
 * 管家（D70）恒加入 `collaboration`（其专属工具在该包内）。结果按登记表
 * 顺序、去重。纯函数（desktop 勾选 UI 与 core 共用）。
 */
export function resolveCapabilities(
  selected: readonly string[] | null,
  entry: { nativeCapabilities: Partial<Record<NativeCapabilityKey, readonly string[]>> },
  options: { isButler?: boolean } = {},
): HostCapabilityId[] {
  const chosen = new Set<string>(selected ?? defaultCapabilities(entry));
  chosen.add('core');
  if (options.isButler === true) chosen.add('collaboration');
  return HOST_CAPABILITIES.filter((capability) => chosen.has(capability.id)).map(
    (capability) => capability.id,
  );
}

/**
 * 补位类工具在桥上的描述前缀（§4.2「原生优先」）：Agent 自带同类能力时
 * 优先用自带的，注入工具只作兜底。
 */
export const SUPPLEMENT_TOOL_DESCRIPTION_PREFIX =
  '[补充能力] 若你自带同类能力，优先使用自带能力；仅当其不存在、不可用或失败时调用本工具。';

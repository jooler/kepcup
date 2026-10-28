import { z } from 'zod';
import {
  SETTINGS_CHANGE_TOOL,
  SETTINGS_READ_TOOL,
  SETTINGS_SEARCH_TOOL,
} from '../settings-catalog/cards.js';

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
  'mail',
  'settings',
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

/**
 * 包内的单独开关（按 Bot 在能力包选项里开启）：选项 id 与包 id 一起存在 Bot 的
 * `runtime.agent.capabilities` 里（`包id:名字`，`resolveCapabilities` 只认包 id，不受影响）；
 * 选项未开时，`tools` 里的工具即使所属包已选中也不注入（`isHostToolInjected`）。
 */
export interface HostCapabilityOptIn {
  /** 选项 id，形如 `settings:change`。 */
  id: string;
  /** 选项开启才注入的工具（仍列在所属包的 `tools` 里，归包不变）。 */
  tools: readonly string[];
  /** 界面文案 key（名称 `{i18nKey}.name`、说明 `{i18nKey}.description`）。 */
  i18nKey: string;
}

export interface HostCapabilityDescriptor {
  id: HostCapabilityId;
  category: HostCapabilityCategory;
  /** 包内工具名（`toolPrefixes` 之外的精确名）。 */
  tools: readonly string[];
  /** 按前缀归入本包的工具（`browser_*`）。 */
  toolPrefixes: readonly string[];
  /**
   * 与别的包共有的精确名（D91：`capability_search` / `capability_call` 为 `mcp` 与 `apps` 共有）：
   * 任一共有它的包被选中即注入。`capabilityOfTool` 以登记表里第一个包为准（类别 / 描述前缀用）。
   */
  sharedTools: readonly string[];
  /** 仅管家（D70）额外拿到、且对管家必选的专属工具。 */
  butlerTools: readonly string[];
  default: HostCapabilityDefault;
  /** 与 Agent 原生能力的重叠键；null = 无重叠（宿主语义类）。 */
  overlapsNative: NativeCapabilityKey | null;
  prerequisite: HostCapabilityPrerequisite | null;
  /** 包内默认不注入、按 Bot 单独开启的工具组；空 = 包内工具随包注入。 */
  optIns: readonly HostCapabilityOptIn[];
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
    sharedTools: [],
    butlerTools: [],
    overlapsNative: null,
    prerequisite: null,
    optIns: [],
    ...input,
    i18nKey: `agents.capabilities.${input.id}`,
  };
}

/**
 * 能力目录的按需发现两件套（D91，design 40 §3 / §7）：对话轮与任务里取用外部能力（连接应用 /
 * 自定义 MCP）的稳定入口，归 `mcp` 与 `apps` 两包共有。
 */
export const CAPABILITY_SEARCH_TOOL = 'capability_search';
export const CAPABILITY_CALL_TOOL = 'capability_call';
export const CAPABILITY_DISCOVERY_TOOLS: readonly string[] = [
  CAPABILITY_SEARCH_TOOL,
  CAPABILITY_CALL_TOOL,
];

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
    // D92 T1b WP10: wiki_remove_source is project-conversation-only (its
    // registration is decided per run by tools/wiki-tools.ts).
    tools: ['wiki_search', 'wiki_read', 'wiki_enqueue', 'wiki_remove_source'],
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
    // D88 P1：移交工具人人有（普通 Bot 只能交出自己的资产）。
    tools: [
      'list_bots',
      'delegate_to_bot',
      'cancel_delegation',
      'inspect_bot_assets',
      'propose_handover',
    ],
    butlerTools: ['propose_bot', 'propose_project', 'propose_bots', 'suggest_route'],
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
    tools: ['create_skill'],
  }),
  pack({
    id: 'host_ops',
    category: 'host',
    default: 'inject',
    tools: ['request_environment', 'git_remote'],
  }),
  // 工具集合 = 该 Bot 勾选的用户 MCP server（D65 `mcp_server_ids`），动态；
  // 包装后的工具名为 `mcp_{serverId}_{tool}`（core `mcpToolName`）。
  pack({
    id: 'mcp',
    category: 'supplement',
    default: 'follow_bot',
    toolPrefixes: ['mcp_'],
    sharedTools: CAPABILITY_DISCOVERY_TOOLS,
  }),
  // 连接应用（D73，design 29 §10）：工具集合 = 该 Bot 勾选的目录连接（`app_connection_ids`），
  // 动态；工具名 `app_{slug}_{tool}`，宿主自有的 `app_request_connection` 同前缀。
  // 工具在宿主执行（令牌留在宿主、审批 / 风险策略与内置引擎同一网关）。
  pack({
    id: 'apps',
    category: 'supplement',
    default: 'follow_bot',
    toolPrefixes: ['app_'],
    sharedTools: CAPABILITY_DISCOVERY_TOOLS,
  }),
  // 邮件通道（D84）：IMAP/SMTP，不是 MCP。工具只作用于该 Bot 已绑定的邮箱。
  pack({
    id: 'mail',
    category: 'host',
    default: 'inject',
    tools: ['mail_list', 'mail_read', 'mail_search', 'mail_send', 'mail_accounts', 'mail_request_setup'],
  }),
  // 对话内应用设置（todo/conversational-app-setup.md §5.3 第 7 条，已定）：默认只注入
  // settings_search / settings_read；settings_change 按 Bot 在能力包选项里单独开启
  // （`settings:change`），开启后同样受宿主档位裁定约束。
  pack({
    id: 'settings',
    category: 'host',
    default: 'inject',
    tools: [SETTINGS_SEARCH_TOOL, SETTINGS_READ_TOOL, SETTINGS_CHANGE_TOOL],
    optIns: [
      {
        id: 'settings:change',
        tools: [SETTINGS_CHANGE_TOOL],
        i18nKey: 'agents.capabilities.settings.change',
      },
    ],
  }),
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
  'acquire_workdir_write',
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
        capability.tools.includes(toolName) ||
        capability.butlerTools.includes(toolName) ||
        capability.sharedTools.includes(toolName),
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

/** 全部包内选项（登记表顺序）。 */
export const HOST_CAPABILITY_OPT_INS: readonly HostCapabilityOptIn[] = HOST_CAPABILITIES.flatMap(
  (capability) => capability.optIns,
);

/** 工具所属的包内选项；不受选项控制（随包注入）返回 null。 */
export function optInOfTool(toolName: string): HostCapabilityOptIn | null {
  return HOST_CAPABILITY_OPT_INS.find((optIn) => optIn.tools.includes(toolName)) ?? null;
}

/**
 * 一个 Bot 开启的包内选项：`selected`（Bot 的 `runtime.agent.capabilities`）里认得的选项 id，
 * 且所属包在 `capabilities`（`resolveCapabilities` 的结果）里。`selected` 为 null（跟随默认）
 * = 一个都不开——选项都是默认关闭的。纯函数，结果按登记表顺序。
 */
export function resolveCapabilityOptIns(
  selected: readonly string[] | null,
  capabilities: readonly HostCapabilityId[],
): string[] {
  if (selected === null) return [];
  const chosen = new Set(selected);
  return HOST_CAPABILITIES.filter((capability) => capabilities.includes(capability.id)).flatMap(
    (capability) =>
      capability.optIns.filter((optIn) => chosen.has(optIn.id)).map((optIn) => optIn.id),
  );
}

/**
 * 外部 Agent 下某个宿主工具是否注入：所属包已选中，且（不受选项控制，或其选项已开启）。
 * 不属于任何包的工具返回 false（`NEVER_INJECTED_TOOLS` 由调用方另行排除）。
 */
export function isHostToolInjected(
  toolName: string,
  capabilities: readonly HostCapabilityId[],
  optIns: readonly string[],
): boolean {
  const capability = capabilityOfTool(toolName);
  if (capability === null) return false;
  // D91：共有工具（capability_search / capability_call）任一所属包选中即注入。
  const selected = HOST_CAPABILITIES.some(
    (entry) =>
      capabilities.includes(entry.id) &&
      (entry.id === capability.id || entry.sharedTools.includes(toolName)),
  );
  if (!selected) return false;
  const optIn = optInOfTool(toolName);
  return optIn === null || optIns.includes(optIn.id);
}

/**
 * 补位类工具在桥上的描述前缀（§4.2「原生优先」）：Agent 自带同类能力时
 * 优先用自带的，注入工具只作兜底。
 */
export const SUPPLEMENT_TOOL_DESCRIPTION_PREFIX =
  '[补充能力] 若你自带同类能力，优先使用自带能力；仅当其不存在、不可用或失败时调用本工具。';

// --- D96 远程遥控：端点能力（design 46 §1.2 / §3.2）----------------------------
//
// 端点（endpoint）= 本机 renderer（desktop）或遥控端点（remote，renderer 的 web
// 构建）。本机 UI 与远程端点功能完全对等、走同一份 RPC 目录、不做只读门；
// 下面登记的是**物理上只能落在桌面**的动作：动作照常在桌面执行（弹通知、
// shell.openExternal、浏览器控制），远程端点的 UI 把对应入口显示为不可用
// （「仅桌面」态），不隐藏入口造成「功能消失」错觉。
// 远程端点不新增暴露面，core 不按端点裁剪 RPC（secrets 卫生规则对端点统一适用）。

/** 端点形态。 */
export const endpointKindSchema = z.enum(['desktop', 'remote']);
export type EndpointKind = z.infer<typeof endpointKindSchema>;

/**
 * desktop-only 能力项。粒度是 UI 入口（不是 RPC 方法名）：渲染层据此置灰，
 * 未来物理桌面动作增多按需追加（追加只影响远程端的显示，不影响桌面）。
 */
export const endpointCapabilityIdSchema = z.enum([
  /** 附件选择本地文件（本地文件选择对话框；手机相册上行 P1）。 */
  'local-file-dialog',
  /** 系统浏览器打开链接（shell.openExternal，链接仍可复制）。 */
  'open-external',
  /** 在文件管理器中打开（日志目录、附件落盘位置）。 */
  'reveal-in-file-manager',
  /** 桌面系统通知。 */
  'desktop-notification',
  /** 安装应用更新（重启桌面进程）。 */
  'install-update',
  /** 关闭 / 重启桌面应用。 */
  'shutdown-app',
  /** 开机自启设置（OS 登录项）。 */
  'launch-at-login',
  /** 沙箱准备向导（WSL 安装等 OS 级操作）。 */
  'sandbox-wizard',
]);
export type EndpointCapabilityId = z.infer<typeof endpointCapabilityIdSchema>;

/** desktop-only 全集（remote 端点一项都没有）。 */
export const DESKTOP_ONLY_CAPABILITIES: readonly EndpointCapabilityId[] = [
  'local-file-dialog',
  'open-external',
  'reveal-in-file-manager',
  'desktop-notification',
  'install-update',
  'shutdown-app',
  'launch-at-login',
  'sandbox-wizard',
];

/**
 * 端点是否具备某能力：desktop 恒全量（登记表外的未知 id 也按桌面可用处理），
 * remote 只有 DESKTOP_ONLY_CAPABILITIES 之外的。纯函数，两种构建共用。
 */
export function endpointHasCapability(
  kind: EndpointKind,
  id: EndpointCapabilityId,
): boolean {
  if (kind === 'desktop') return true;
  return !DESKTOP_ONLY_CAPABILITIES.includes(id);
}

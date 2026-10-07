import {
  capabilityOfTool,
  NEVER_INJECTED_TOOLS,
  SUPPLEMENT_TOOL_DESCRIPTION_PREFIX,
  type AgentCatalogEntry,
  type HostCapabilityId,
} from '@kepcup/shared';
import { createHash, randomBytes } from 'node:crypto';
import type { ToolDefinition } from '../types.js';
import { HOST_MCP_SERVER_PREFIX } from './acp/client.js';
import type { AgentProvider } from './types.js';

/**
 * 能力包落地（docs/design/28-external-agents-acp.md §4，D72）：外部智能体 run
 * 的宿主工具 = `buildResponseTools` 的结果 → 去掉永不注入的工具 → 只留所属
 * 能力包被选中的工具（不属于任何包的一律不注入）→ 补位类工具描述加
 * 「[补充能力]」前缀（原生优先，§4.2）。`capabilities` 由 shared 的
 * `resolveCapabilities` 算出（null 用默认、core 必选、管家必含协作包）；
 * 用户 MCP 工具已按 Bot 的 `mcp_server_ids` 构建，归 `mcp` 包。
 */
export function buildExternalAgentTools(input: {
  responseTools: readonly ToolDefinition[];
  capabilities: readonly HostCapabilityId[];
  /**
   * Longest tool name the agent can see once prefixed
   * (`MAX_AGENT_TOOL_NAME - namer('').length`); longer names (user MCP tools)
   * are shortened with a hash suffix. Omitted = no limit.
   */
  maxNameLength?: number;
}): ToolDefinition[] {
  const selected = new Set<string>(input.capabilities);
  const tools: ToolDefinition[] = [];
  for (const tool of input.responseTools) {
    if (NEVER_INJECTED_TOOLS.includes(tool.name)) continue;
    const capability = capabilityOfTool(tool.name);
    if (capability === null || !selected.has(capability.id)) continue;
    const name =
      input.maxNameLength !== undefined ? fitToolName(tool.name, input.maxNameLength) : tool.name;
    tools.push({
      ...tool,
      name,
      description:
        capability.category === 'supplement'
          ? `${SUPPLEMENT_TOOL_DESCRIPTION_PREFIX}${tool.description}`
          : tool.description,
    });
  }
  return tools;
}

/** Tool name limit of the agents' model APIs (Anthropic / OpenAI: 64). */
export const MAX_AGENT_TOOL_NAME = 64;

/** `name` within `max` chars: truncated + `_` + 8 hex of its hash when too long. */
export function fitToolName(name: string, max: number): string {
  if (name.length <= max) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, Math.max(0, max - 9))}_${hash}`;
}

/**
 * MCP tool annotations for `tools/list` (Codex and others decide approval /
 * parallelism from them): read-only queries, and tools whose effect cannot be
 * undone. Everything else is a non-destructive write (send_message, remember…).
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'search_messages',
  'get_messages_around',
  'list_my_runs',
  'get_run',
  'recall_memory',
  'get_user_profile',
  'list_commitments',
  'wiki_search',
  'wiki_read',
  'list_schedules',
  'list_bots',
  'web_search',
  'web_fetch',
  'browser_snapshot',
  'browser_screenshot',
  'understand_image',
  'transcribe_audio',
]);
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'forget',
  'cancel_schedule',
  'cancel_delegation',
  'git_remote',
]);

export function toolAnnotations(toolName: string): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
} {
  const readOnly = READ_ONLY_TOOLS.has(toolName);
  return { readOnlyHint: readOnly, destructiveHint: !readOnly && DESTRUCTIVE_TOOLS.has(toolName) };
}

/**
 * 桥调用的 `tool_call` 步骤标记（§4.2 遵守度统计）：所属能力包，以及 Agent
 * 是否声明了同类原生工具（声明了还调用注入工具 = 未遵守原生优先，或原生
 * 能力不可用 / 失败）。
 */
export function bridgeToolMeta(
  toolName: string,
  entry: Pick<AgentCatalogEntry, 'nativeCapabilities'>,
): { capability: HostCapabilityId | null; nativeOverlap: boolean } {
  const capability = capabilityOfTool(toolName);
  if (capability === null) return { capability: null, nativeOverlap: false };
  const native =
    capability.overlapsNative !== null
      ? entry.nativeCapabilities[capability.overlapsNative]
      : undefined;
  return { capability: capability.id, nativeOverlap: native !== undefined && native.length > 0 };
}

/**
 * A fresh bridge server name for one agent session (`kepcup_<8hex>`): a user /
 * project MCP server called `kepcup` cannot pose as the host bridge.
 */
/**
 * The bridge server name of a reusable agent session (P5): derived from its
 * `agent_sessions` row id (random ULID), so it persists with the row and a
 * replaced session gets a new one.
 */
export function hostServerNameFor(sessionRowId: string): string {
  return `${HOST_MCP_SERVER_PREFIX}_${createHash('sha256').update(sessionRowId).digest('hex').slice(0, 8)}`;
}

export function newHostServerName(): string {
  return `${HOST_MCP_SERVER_PREFIX}_${randomBytes(4).toString('hex')}`;
}

/** How the agent spells a host-bridge tool (`mcp__kepcup_ab12cd34__send_message`). */
export function hostToolNamer(
  provider: Pick<AgentProvider, 'toolName'>,
  serverName: string,
): (tool: string) => string {
  return (tool) => provider.toolName(serverName, tool);
}

import { Type } from '@earendil-works/pi-ai';
import { toLlmContent, type Tool as McpTool } from '@earendil-works/pi-mcp';
import { TOOL_OUTPUT_MAX_CHARS, TURN_MCP_READ_TOOLS_MAX, type McpServer } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { ToolGateway } from '../gateway/index.js';
import type { SecretsService } from '../domain/secrets.js';
import { mcpToolName, type McpService } from './service.js';
import { classifyRiskDetailed } from './risk.js';
import { allowedOnReadOnlySurface, decideMcpTool, type McpToolDecision } from './policy.js';

/**
 * MCP tool → KepCup ToolDefinition 包装（D65）：调用与内置工具同管道——
 * 审批（网关 mcpToolCall：tool policy > server autoApprove > 风险档默认）、
 * 审计、结果 `<untrusted>` 包裹 + 脱敏 + 截断、图片块走 ToolResult.images。
 *
 * W5：两种工具面——任务（全部已启用的工具）与只读工具面（对话轮 / 只读子
 * 代理：只放风险 read 且有效审批 auto 的工具，最多 TURN_MCP_READ_TOOLS_MAX
 * 个）。`enabled:false` 的工具两边都不注册。调用时网关重新解析风险与策略。
 */

export interface McpToolFacade {
  /** Orchestrator 预先解析并构建好的 MCP 包装工具（ready to register）。 */
  readonly tools: ToolDefinition[];
  /**
   * 只读工具面上没放进来的已启用 MCP 工具数（非只读 / 需确认 / 超出上限）；
   * > 0 时对话轮系统提示说明「更多 MCP 工具在任务中可用」。任务面恒为 0。
   */
  readonly omitted?: number;
}

/** 一个已解析的 MCP 工具：所属 server、原始定义、模型侧名字与构建时的决定。 */
export interface McpToolEntry {
  server: McpServer;
  tool: McpTool;
  name: string;
  decision: McpToolDecision;
}

/**
 * 列出各 server 的工具（懒连接 + 缓存），去重并跳过 `enabled:false`。单个
 * server 连不上不拖垮整个 run：跳过并在 mcp.server_status 事件里可见。
 */
export async function resolveMcpToolEntries(input: {
  servers: McpServer[];
  mcp: McpService;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
  /**
   * 连接失败是否计入重连预算（默认 true = 任务）。对话轮传 false：对话轮每轮
   * 都会解析，不能把任务的预算耗光。
   */
  countFailures?: boolean;
}): Promise<McpToolEntry[]> {
  const { servers, mcp, logger } = input;
  const entries: McpToolEntry[] = [];
  const taken = new Set<string>();
  for (const server of servers) {
    let tools;
    try {
      tools = await mcp.listTools(server, { countFailure: input.countFailures ?? true });
    } catch (error) {
      logger.warn(
        { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
        'mcp server unavailable; skipping its tools',
      );
      continue;
    }
    for (const tool of tools) {
      const decision = decideMcpTool(
        server,
        tool.name,
        classifyRiskDetailed({ name: tool.name, annotations: tool.annotations }),
      );
      if (!decision.enabled) continue;
      const name = mcpToolName(server.id, tool.name);
      if (taken.has(name)) {
        logger.warn({ name, serverId: server.id }, 'duplicate mcp tool name; skipping');
        continue;
      }
      taken.add(name);
      entries.push({ server, tool, name, decision });
    }
  }
  return entries;
}

/**
 * 只读工具面（对话轮 / 只读子代理）的工具：只读且有效审批为 auto（被用户改成
 * ask 的只读工具不进——对话轮是秒级的，不在对话轮里等审批），按 server 顺序取
 * 前 `max` 个。`omitted` = 其余已启用工具数。
 */
export function selectReadOnlyMcpEntries(
  entries: McpToolEntry[],
  max: number = TURN_MCP_READ_TOOLS_MAX,
): { entries: McpToolEntry[]; omitted: number } {
  const eligible = entries.filter((entry) => allowedOnReadOnlySurface(entry.decision));
  const selected = eligible.slice(0, Math.max(0, max));
  return { entries: selected, omitted: entries.length - selected.length };
}

/** 为某个 run 身份包装已解析的工具。 */
export function wrapMcpToolEntries(input: {
  identity: RunIdentity;
  entries: McpToolEntry[];
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
}): ToolDefinition[] {
  const { identity, entries, mcp, gateway, secrets } = input;
  return entries.map((entry) =>
    wrapMcpTool({
      identity,
      server: entry.server,
      tool: entry.tool,
      name: entry.name,
      decision: entry.decision,
      mcp,
      gateway,
      secrets,
    }),
  );
}

/**
 * 解析 + 包装。`surface: 'readOnly'` 只取只读工具面的工具（对话轮 / 只读子
 * 代理）；默认 'task' 取全部已启用工具。
 */
export async function buildMcpTools(input: {
  identity: RunIdentity;
  servers: McpServer[];
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
  surface?: 'task' | 'readOnly';
}): Promise<ToolDefinition[]> {
  const all = await resolveMcpToolEntries(input);
  const entries = input.surface === 'readOnly' ? selectReadOnlyMcpEntries(all).entries : all;
  return wrapMcpToolEntries({ ...input, entries });
}

function wrapMcpTool(input: {
  identity: RunIdentity;
  server: McpServer;
  tool: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown> };
  name: string;
  decision: McpToolDecision;
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
}): ToolDefinition {
  const { identity, server, tool, name, decision, mcp, gateway, secrets } = input;
  const riskLabel =
    decision.risk === 'read' ? '只读' : decision.risk === 'write' ? '写入' : '可能有破坏性';
  return {
    name,
    description:
      `MCP 工具（来自服务器「${server.name}」，${riskLabel}）：${tool.description ?? tool.title ?? tool.name}。` +
      (decision.approval === 'auto' ? '调用无需用户批准。' : '调用会请求用户批准。'),
    parameters: Type.Unsafe({
      ...tool.inputSchema,
      type: 'object',
      properties: tool.inputSchema.properties ?? {},
    }),
    execute: async (params, ctx): Promise<ToolResult> => {
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        await gateway.mcpToolCall(identity, server, tool.name, args, { signal: ctx.signal });
      } catch (error) {
        return gatewayMcpErrorResult(error);
      }
      let result;
      try {
        result = await mcp.callTool(server, tool.name, args, { signal: ctx.signal });
      } catch (error) {
        return {
          ok: false,
          content: `MCP 调用失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: error instanceof Error && 'code' in error ? String(error.code) : 'MCP_CALL_FAILED',
        };
      }
      const content = toLlmContent(result);
      const textParts: string[] = [];
      const images: Array<{ mimeType: string; base64: string }> = [];
      for (const block of content) {
        if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
          textParts.push((block as { text: string }).text);
        } else if (block.type === 'image') {
          const image = block as { data?: string; mimeType?: string };
          if (image.data !== undefined && image.mimeType !== undefined) {
            images.push({ base64: image.data, mimeType: image.mimeType });
          }
        } else {
          textParts.push(`（${block.type} 内容已省略）`);
        }
      }
      const redacted = secrets.redact(textParts.join('\n'));
      const truncated = truncateToBudget(redacted, TOOL_OUTPUT_MAX_CHARS);
      const suffix = truncated.truncated ? '\n[输出已截断]' : '';
      return {
        ok: result.isError !== true,
        content: `<untrusted>\n${truncated.text || '（无输出）'}${suffix}\n</untrusted>`,
        ...(images.length > 0 ? { images } : {}),
        ...(result.isError === true ? { errorCode: 'MCP_CALL_FAILED' } : {}),
      };
    },
  };
}

/** 审批环节的错误映射（拒绝要可继续，模型能调整做法）。 */
function gatewayMcpErrorResult(error: unknown): ToolResult {
  const code = (error as { code?: string })?.code;
  // W5：只读工具面上调用时已不再是「只读 + 免审批」，或工具已被停用。
  if (code === 'RUN_READ_ONLY' || code === 'MCP_TOOL_NOT_FOUND') {
    return {
      ok: false,
      content: error instanceof Error ? error.message : String(error),
      errorCode: code,
    };
  }
  if (code === 'APPROVAL_DENIED') {
    return {
      ok: false,
      content: '用户拒绝或取消了该 MCP 工具调用的审批。不要反复重试；调整做法或询问用户。',
      errorCode: 'APPROVAL_DENIED',
    };
  }
  return {
    ok: false,
    content: `MCP 调用审批失败：${error instanceof Error ? error.message : String(error)}`,
    errorCode: typeof code === 'string' ? code : 'INTERNAL',
  };
}

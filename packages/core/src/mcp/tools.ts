import { Type } from '@earendil-works/pi-ai';
import { toLlmContent } from '@earendil-works/pi-mcp';
import { TOOL_OUTPUT_MAX_CHARS, type McpServer } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { ToolGateway } from '../gateway/index.js';
import type { SecretsService } from '../domain/secrets.js';
import { mcpToolName, type McpService } from './service.js';

/**
 * MCP tool → KepCup ToolDefinition 包装（D65）：调用与内置工具同管道——
 * 审批（网关 mcpToolCall，autoApprove 的 server 免卡）、审计、结果
 * `<untrusted>` 包裹 + 脱敏 + 截断、图片块走 ToolResult.images。
 */

export interface McpToolFacade {
  /** Orchestrator 预先解析并构建好的 MCP 包装工具（ready to register）。 */
  readonly tools: ToolDefinition[];
}

export async function buildMcpTools(input: {
  identity: RunIdentity;
  servers: McpServer[];
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
}): Promise<ToolDefinition[]> {
  const { identity, servers, mcp, gateway, secrets, logger } = input;
  const definitions: ToolDefinition[] = [];
  const taken = new Set<string>();
  for (const server of servers) {
    let tools;
    try {
      tools = await mcp.listTools(server);
    } catch (error) {
      // 单个 server 连不上不拖垮整个 run：跳过并在 mcp.server_status 事件里可见。
      logger.warn(
        { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
        'mcp server unavailable; skipping its tools',
      );
      continue;
    }
    for (const tool of tools) {
      const name = mcpToolName(server.id, tool.name);
      if (taken.has(name)) {
        logger.warn({ name, serverId: server.id }, 'duplicate mcp tool name; skipping');
        continue;
      }
      taken.add(name);
      definitions.push(wrapMcpTool({ identity, server, tool, name, mcp, gateway, secrets }));
    }
  }
  return definitions;
}

function wrapMcpTool(input: {
  identity: RunIdentity;
  server: McpServer;
  tool: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown> };
  name: string;
  mcp: McpService;
  gateway: ToolGateway;
  secrets: SecretsService;
}): ToolDefinition {
  const { identity, server, tool, name, mcp, gateway, secrets } = input;
  return {
    name,
    description:
      `MCP 工具（来自服务器「${server.name}」）：${tool.description ?? tool.title ?? tool.name}。` +
      '调用会请求用户批准（除非该服务器已开启免审批）。',
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

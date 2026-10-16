import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '../agent/types.js';
import { formatCapabilitySearch, type CapabilityDiscovery } from '../capabilities/discovery.js';

/**
 * 能力按需发现两件套（D91，design 40 §3；由 D73 P2 的 `app_search_tools` / `app_call_tool` 泛化）：
 * `capability_search` 在 `<capabilities>` 列出的能力（连接应用 / 自定义 MCP）里查工具，
 * `capability_call` 转调与直接暴露时同一个包装工具。工具名登记在 shared 的 `mcp` / `apps` 两包共有
 * （外部智能体任一包选中即注入）。
 */

/**
 * 工具名在 shared 的 `CAPABILITY_SEARCH_TOOL` / `CAPABILITY_CALL_TOOL`（能力包登记用）；这里写字面量
 * 以便效果分级表的源码扫描（tool-effects.test.ts）认得它们，由 capability-discovery.test.ts 断言一致。
 */

/** `capability_search` + `capability_call`。 */
export function buildCapabilityTools(discovery: CapabilityDiscovery): ToolDefinition[] {
  const searchTools: ToolDefinition<{ query?: string; capability?: string }> = {
    name: 'capability_search',
    description:
      '在你接入的外部能力（<capabilities> 里列出的应用 / MCP 服务器）里按关键词查找工具：按工具名、标题和说明匹配，返回工具的完整名称、所属能力、说明、风险、是否需要用户批准和参数 schema（最多 20 个）。query 留空 = 浏览；capability 填能力 id（如 app:github）可限定在一个能力内。对话轮只查得到只读、免审批的工具。找到后用 capability_call 调用。',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: '关键词，如「create issue」「创建 日程」；多个词用空格分隔' }),
      ),
      capability: Type.Optional(
        Type.String({ description: '限定能力的 id，如 app:github、mcp:fs-notes（见 <capabilities>）' }),
      ),
    }),
    execute: async (params, ctx) => {
      const result = await discovery.search(
        { query: params.query ?? '', capability: params.capability },
        ctx.signal,
      );
      if (result.cancelled === true) {
        return { ok: false, content: '执行已取消，未完成能力查找。', errorCode: 'CANCELLED' };
      }
      if (result.unknownCapability !== undefined) {
        return {
          ok: false,
          content: `没有能力「${result.unknownCapability.wanted}」：capability 必须是 <capabilities> 里的 id${
            result.unknownCapability.available.length > 0
              ? `（当前可查：${result.unknownCapability.available.join('、')}）`
              : ''
          }。`,
          errorCode: 'INVALID_INPUT',
        };
      }
      return { ok: true, content: formatCapabilitySearch(result) };
    },
  };
  const callTool: ToolDefinition<{ name?: string; arguments?: Record<string, unknown> }> = {
    name: 'capability_call',
    description:
      '调用 capability_search 找到的外部工具：name 是搜索结果里的完整工具名，arguments 按其 inputSchema 填写。审批、权限与账号与直接调用该工具完全一致（写入类工具会请求用户批准，卡片显示真实的工具与账号）；未批准、被停用、不在你授权范围内或本场景不可用的工具会被拒绝。',
    parameters: Type.Object({
      name: Type.String({ description: 'capability_search 返回的完整工具名' }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: '工具参数（对象），按该工具的 inputSchema',
        }),
      ),
    }),
    mcpOf: (params) => discovery.originOf(params.name ?? ''),
    execute: async (params, ctx) => {
      const name = params.name?.trim() ?? '';
      if (name.length === 0) {
        return {
          ok: false,
          content: '需要提供 name（capability_search 返回的完整工具名）',
          errorCode: 'INVALID_INPUT',
        };
      }
      const args = params.arguments;
      if (
        args !== undefined &&
        (args === null || typeof args !== 'object' || Array.isArray(args))
      ) {
        return { ok: false, content: 'arguments 必须是对象', errorCode: 'INVALID_INPUT' };
      }
      return discovery.call(name, args ?? {}, ctx);
    },
  };
  return [searchTools, callTool] as ToolDefinition[];
}

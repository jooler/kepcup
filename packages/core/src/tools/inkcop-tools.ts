import { Type } from '@earendil-works/pi-ai';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { InkcopAgentInfo } from '../inkcop/client.js';
import type { InkcopHandoffResult } from '../inkcop/handoff.js';

/**
 * InkCop 同机协作工具（契约 v0.4）：关联智能体以工具形式暴露给 Bot。
 * Bot 维持原 LLM 逻辑；仅在用户点名或模型判断需要时调用，结果经工具回传再由 Bot 回复。
 */

export interface InkcopToolFacade {
  botId: string;
  botName: string;
  /** Bot 详情已勾选的 agentKey（非空）。 */
  agentKeys: string[];
  /** 列表 API enrichment（含 description）；缺项时按 key 回落。 */
  agents: InkcopAgentInfo[];
  handoff(
    input: { agentKey: string; task: string },
    signal: AbortSignal,
  ): Promise<InkcopHandoffResult>;
}

function agentKeyParamSchema(keys: string[]) {
  if (keys.length === 1) {
    return Type.Literal(keys[0]!, { description: `已关联的 InkCop 智能体：${keys[0]}` });
  }
  return Type.Union(
    keys.map((key) => Type.Literal(key)),
    { description: `已关联的 InkCop 智能体之一：${keys.join('、')}` },
  );
}

function describeAgents(agents: InkcopAgentInfo[], keys: string[]): string {
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  return keys
    .map((key) => {
      const info = byKey.get(key);
      const name = info?.name?.trim() || key;
      const kind = info?.kind === 'main' ? '主智能体' : '应用智能体';
      const desc = info?.description?.trim();
      if (desc !== undefined && desc.length > 0) {
        return `- \`${key}\`（${name}，${kind}）：${desc}`;
      }
      return `- \`${key}\`（${name}，${kind}）`;
    })
    .join('\n');
}

function handoffToToolResult(result: InkcopHandoffResult): ToolResult {
  if (result.ok) {
    return {
      ok: true,
      content:
        `InkCop 智能体已完成任务，原文如下（请整理后回复用户，不要隐瞒关键结论）：\n\n${result.text}`,
    };
  }
  const code =
    result.errorCode === 'auth'
      ? 'INKCOP_AUTH'
      : result.errorCode === 'offline'
        ? 'INKCOP_OFFLINE'
        : 'INKCOP_HANDOFF_FAILED';
  return { ok: false, content: result.message, errorCode: code };
}

/**
 * 对话轮注册：单个 `call_inkcop_agent`（agent_key 枚举为已关联 keys）。
 * 任务面同样可用（写任务里需要 InkCop 能力时）。
 */
export function buildInkcopAgentTools(input: {
  identity: RunIdentity;
  inkcop: InkcopToolFacade;
}): ToolDefinition[] {
  const { inkcop } = input;
  const keys = inkcop.agentKeys.filter((key) => key.trim().length > 0);
  if (keys.length === 0) return [];

  const listing = describeAgents(inkcop.agents, keys);
  const tool: ToolDefinition<{ agent_key: string; task: string }> = {
    name: 'call_inkcop_agent',
    description:
      '【默认禁止调用】把任务交给已关联的本机 InkCop 智能体（可选移交，不是默认回复通道）。' +
      '你必须先用自己的能力直接回复用户；绝大多数轮次都不要调用本工具。' +
      '仅当同时满足时才可调用：（1）用户本轮消息明确点名 InkCop、某个已关联智能体名称，' +
      '或明确说「交给 / 让 / 用 … 智能体」；（2）该任务确实需要对方专长。' +
      '禁止：把普通闲聊、寒暄、问答、调度、确认类消息转交；禁止把用户原话原样当 task 整轮直通。' +
      '调用后根据工具返回整理成你的回复，不要假装自己直连了 InkCop。\n' +
      `可选智能体（仅供上述移交场景参考）：\n${listing}`,
    parameters: Type.Object(
      {
        agent_key: agentKeyParamSchema(keys),
        task: Type.String({
          description:
            '交给该智能体的完整任务说明（要什么产出、约束、素材）。可转述用户原话并补充上下文，不要只写「帮我处理」。',
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (params, ctx) => {
      ctx.progress('正在调用 InkCop 智能体…');
      const agentKey = (params.agent_key ?? '').trim();
      if (!keys.includes(agentKey)) {
        return {
          ok: false,
          content: `智能体「${agentKey}」未关联：请只使用 ${keys.join('、')}`,
          errorCode: 'INVALID_INPUT',
        };
      }
      const task = (params.task ?? '').trim();
      if (task.length === 0) {
        return { ok: false, content: 'task 不能为空', errorCode: 'INVALID_INPUT' };
      }
      const result = await inkcop.handoff({ agentKey, task }, ctx.signal);
      return handoffToToolResult(result);
    },
  };

  return [tool] as ToolDefinition[];
}

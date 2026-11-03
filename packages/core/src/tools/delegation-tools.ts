import { Type } from '@earendil-works/pi-ai';
import { DELEGATION_TASK_MAX_CHARS, type DelegationIntent } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 跨 Bot 委派工具（D71 v2 / D113，docs/design/27-butler-and-delegation.md §3）：
 * `delegate_to_bot` 把任务交给通讯录里的另一个 Bot（你们在专属的委托交换
 * 对话里直接沟通，B 用自己的完整工具面处理），**异步**——工具立即返回，
 * B 的结果稍后以内部通知唤醒你，由你转述给用户。
 * 与 `delegate_task`（D66，同一个 Bot 的只读子代理）不是一回事。
 * W6：`intent` 区分请求（要结果；B 派出的任务结束后取任务结果）、提问（取
 * B 的答复）与告知（不需要回复）。
 */

/** The slice of the host the delegation tools need. */
export interface DelegationToolFacade {
  delegate(
    identity: RunIdentity,
    input: { botId: string; task: string; intent?: DelegationIntent | undefined },
  ): { ok: boolean; message: string };
  cancelFromTool(identity: RunIdentity, delegationId: string): { ok: boolean; message: string };
  /** D114: appends a supplement to the caller's own in-flight delegation. */
  updateFromTool(
    identity: RunIdentity,
    delegationId: string,
    message: string,
  ): { ok: boolean; message: string };
  /** D114: the caller's sent + received delegations (filtered summaries). */
  listFromTool(
    identity: RunIdentity,
    input: { status?: string; botId?: string },
  ): { ok: boolean; message: string };
}

function result(outcome: { ok: boolean; message: string }): ToolResult {
  return outcome.ok
    ? { ok: true, content: outcome.message }
    : { ok: false, content: outcome.message, errorCode: 'INVALID_INPUT' };
}

export function buildDelegationTools(input: {
  identity: RunIdentity;
  delegation: DelegationToolFacade;
}): ToolDefinition[] {
  const { identity, delegation } = input;

  const delegateToBot: ToolDefinition<{ bot_id: string; task: string; intent?: DelegationIntent }> = {
    name: 'delegate_to_bot',
    description:
      '把一件事转交给通讯录里更合适的另一个 Bot（用 list_bots 查 bot_id）：你们会在一个专属的委托对话里直接沟通（用户可点开查看往来），它用它自己的能力处理；用户留在当前对话。' +
      'intent 说明你要什么：request（默认）——请它办事并要结果，它的回复、或它为此派出的后台任务完成后的结果，会以内部通知告诉你，由你转述给用户；question——向它提问，它的答复以内部通知告诉你，由你转述给用户；fyi——只是告知，不需要回复，送达即结束，不会有结果贴回。' +
      '适合：事情明显属于另一个 Bot 的专长、用户希望留在当前对话看结果，或需要让它知道某件事。不适合：项目组里（直接 @ 成员）、你自己能做的事（用 start_task 派任务）。' +
      '在回复里写「我已经告诉 B 了」不会发给 B；要发给 B 必须调用 delegate_to_bot。' +
      '委派不会改变谁负责什么：要把邮箱、连接应用、定时任务等长期交给对方负责，是移交（管家用 propose_handover），不是委派。' +
      `task 要写成可以直接交给对方的完整内容（背景、要什么结果、约束），≤ ${DELEGATION_TASK_MAX_CHARS} 字。` +
      '这是异步的：调用后简短告诉用户已转交，然后结束本轮，不要等待、不要轮询、不要对同一件事重复委派。',
    parameters: Type.Object(
      {
        bot_id: Type.String({ description: '接手的 Bot 的 id（list_bots 查到的 bot_…）' }),
        task: Type.String({ description: '交给对方的完整请求 / 问题 / 告知内容' }),
        intent: Type.Optional(
          Type.Union([Type.Literal('request'), Type.Literal('question'), Type.Literal('fyi')], {
            description:
              'request（默认）：请它办事并要结果；question：向它提问、要答复；fyi：只是告知，不需要回复',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      result(
        delegation.delegate(identity, {
          botId: params.bot_id,
          task: params.task,
          intent: params.intent,
        }),
      ),
  };

  const cancelDelegation: ToolDefinition<{ delegation_id: string }> = {
    name: 'cancel_delegation',
    description:
      '取消你发起的、还没完成的委派（例如用户改主意了）。对方正在处理时会被中止，它为此派出的后台任务也会一并停止。',
    parameters: Type.Object(
      { delegation_id: Type.String({ description: 'delegate_to_bot 返回的 delegation_id（dlg_…）' }) },
      { additionalProperties: false },
    ),
    execute: async (params) => result(delegation.cancelFromTool(identity, params.delegation_id)),
  };

  const updateDelegation: ToolDefinition<{ delegation_id: string; message: string }> = {
    name: 'update_delegation',
    description:
      '向你发起的、还没结束的委派追加补充（用户改了需求、补充了材料或约束）。' +
      '对方正在执行的任务会直接收到注入（即时生效）；没有在跑的任务时，补充会在它当前步骤结束后专门处理一轮（必要时它会派新任务），委派要等补充处理完才给出最终结果。' +
      '排队中（免打扰）的委派会把补充并进任务内容一起送达。已经结束的委派不能追加：用 list_delegations 查看结果后发起新委派。' +
      '补充合并成一条说清楚，不要连续多条；调用后简短告诉用户即可，不要等待。',
    parameters: Type.Object(
      {
        delegation_id: Type.String({ description: 'delegate_to_bot 返回的 delegation_id（dlg_…）' }),
        message: Type.String({
          description: `补充内容（要改什么 / 补充什么），≤ ${DELEGATION_TASK_MAX_CHARS} 字`,
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      result(delegation.updateFromTool(identity, params.delegation_id, params.message)),
  };

  const listDelegations: ToolDefinition<{ status?: 'active' | 'done' | 'all'; bot_id?: string }> = {
    name: 'list_delegations',
    description:
      '列出与你有关的委派（你发出的和你收到的，最多 20 条、新→旧）：id、方向、对方、状态、时间、任务摘要、结果摘要。' +
      '用途：回答「我委托过谁做过什么」、拿 delegation_id 做追加（update_delegation）/ 取消（cancel_delegation）、' +
      '根据历史结果发起新委派（把需要的上下文写进新 task）。',
    parameters: Type.Object(
      {
        status: Type.Optional(
          Type.Union(
            [Type.Literal('active'), Type.Literal('done'), Type.Literal('all')],
            { description: 'active=进行中；done=已结束；all=全部（默认）' },
          ),
        ),
        bot_id: Type.Optional(
          Type.String({ description: '只看与这个 Bot 之间的委派（可选）' }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      result(
        delegation.listFromTool(identity, {
          ...(params.status !== undefined ? { status: params.status } : {}),
          ...(params.bot_id !== undefined ? { botId: params.bot_id } : {}),
        }),
      ),
  };

  return [delegateToBot, cancelDelegation, updateDelegation, listDelegations] as ToolDefinition[];
}

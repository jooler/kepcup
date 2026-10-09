import { Type } from '@earendil-works/pi-ai';
import { DELEGATION_TASK_MAX_CHARS, type DelegationIntent } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 跨 Bot 委派工具（D71，docs/design/27-butler-and-delegation.md §3）：
 * `delegate_to_bot` 把任务交给通讯录里的另一个 Bot（B 的私聊里出现一条
 * 「由你代用户发出」的消息，B 用自己的完整工具面处理），**异步**——工具立即
 * 返回，B 的结果稍后以结果卡展示给用户并以内部通知唤醒你。
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
      '把一件事转交给通讯录里更合适的另一个 Bot（用 list_bots 查 bot_id）：它会在自己和用户的私聊里收到一条「由你代用户发出」的消息，用它自己的能力处理；用户留在当前对话。' +
      'intent 说明你要什么：request（默认）——请它办事并要结果，它的回复、或它为此派出的后台任务完成后的结果，会以结果卡贴回这里并以内部通知告诉你；question——向它提问，它的答复贴回这里；fyi——只是告知，不需要回复，送达即结束，不会有结果贴回。' +
      '适合：事情明显属于另一个 Bot 的专长、用户希望留在当前对话看结果，或需要让它知道某件事。不适合：群聊里（直接 @ 群成员）、你自己能做的事（用 start_task 派任务）。' +
      '在回复里写「我已经告诉 B 了」不会发给 B；要发给 B 必须调用 delegate_to_bot。' +
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

  return [delegateToBot, cancelDelegation] as ToolDefinition[];
}

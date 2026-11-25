import type { Message } from '@kepcup/shared';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';

/**
 * 访谈调用的来源路由（member-bots B4 子域 A）：`bots.interview.{start,answer,
 * answerPath}` 按会话所属 SourceId 分流——`local` 经 `connections.get('local')`
 * 恒为本机 core 单例视图（与直调 `core.call` 完全一致，本机行为零变化）；
 * 团队来源经该来源连接（服务端 botInterview resolver 做 owner 判定）。
 */

/**
 * 会话里是否已有未作答的访谈问题（问题卡 / 目录卡）。团队来源的
 * interview.start 自动触发用它预检：B2 服务端的成员访谈会话是普通直聊会话
 *（team.bots.create 服务端已开好并启动），重复 start 会被拒 INVALID_INPUT——
 * 已有进行中的问题时直接渲染作答、不盲目重发。
 */
export function hasUnansweredSetupQuestion(messages: readonly Message[]): boolean {
  let pendingSeq: number | null = null;
  for (const message of messages) {
    const isSetup =
      message.senderType === 'system' &&
      message.kind === 'system_event' &&
      'event' in message.content &&
      (message.content.event === 'bot_setup_question' ||
        message.content.event === 'bot_setup_path_question');
    if (isSetup) {
      pendingSeq = message.seq;
      continue;
    }
    // 问题之后的第一条未撤回用户文本消息即回答（setupAnswer 标记消息 / 自由输入）。
    if (
      pendingSeq !== null &&
      message.seq > pendingSeq &&
      message.senderType === 'user' &&
      message.kind === 'text' &&
      message.status !== 'recalled'
    ) {
      pendingSeq = null;
    }
  }
  return pendingSeq !== null;
}

/**
 * 打开未完成访谈的 Bot 会话时的 start 触发（chat.select 收尾调用，错误由
 * 调用方 warn）。本机 = 现行为；团队来源仅在「会话里没有进行中的 setup
 * 问题」时发。
 */
export async function startSetupInterview(
  source: SourceId,
  botId: string,
  messages: readonly Message[],
): Promise<void> {
  if (source !== 'local' && hasUnansweredSetupQuestion(messages)) return;
  await connections.get(source).call('bots.interview.start', { id: botId });
}

/** 访谈问题作答（SetupQuestionCard 提交口）。 */
export async function answerSetupInterview(
  source: SourceId,
  conversationId: string,
  text: string,
): Promise<void> {
  await connections.get(source).call('bots.interview.answer', { conversationId, text });
}

/**
 * 访谈目录卡作答（19/D59）：path 为 null 表示「暂不设置」；团队来源的 path
 * 来自 TeamWorkdirPicker 选项（服务端按调用者允许集合校验越界 →
 * WORKDIR_NOT_ALLOWED）。
 */
export async function answerSetupPath(
  source: SourceId,
  conversationId: string,
  path: string | null,
): Promise<void> {
  await connections.get(source).call('bots.interview.answerPath', { conversationId, path });
}

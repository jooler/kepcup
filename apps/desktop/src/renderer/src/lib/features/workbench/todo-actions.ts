import type { ScheduleEntry, TodoEntry } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { workbench } from './workbench.svelte';

/** 事项状态迁移与「打开对话」——卡片和详情抽屉共用，错误统一 toast。 */

export type TodoTransition = 'start' | 'complete' | 'cancel' | 'reopen' | 'toDraft';

const DONE_TEXT = {
  start: 'workbench.action.started',
  complete: 'workbench.action.completed',
  cancel: 'workbench.action.cancelled',
  reopen: 'workbench.action.reopened',
  toDraft: 'workbench.action.toDrafted',
} as const;

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/**
 * RPC 错误的展示文案：INVALID_INPUT 带服务端的具体原因（如「时间在过去」「项目组已只读」），
 * 直接展示；其余按错误码映射。
 */
export function rpcErrorText(error: unknown, fallback: string): string {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (code === 'CONVERSATION_READ_ONLY') return t('workbench.error.projectReadOnly');
  if (code === 'NOT_FOUND') return t('workbench.error.targetGone');
  if (code === 'INVALID_INPUT' && typeof message === 'string' && message.trim().length > 0) {
    return message.trim();
  }
  return errorText(code, fallback);
}

/**
 * 迁移一条事项，成功返回最新条目（已写入 store），失败 toast 后返回 null。
 * 「退回草案」没有独立 RPC：已排期的事项清掉 `when` 即退回草案（`todos.update`）。
 */
export async function transitionTodo(kind: TodoTransition, id: string): Promise<TodoEntry | null> {
  try {
    const result =
      kind === 'toDraft'
        ? ((await core.call('todos.update', { id, when: null })) as { todo: TodoEntry })
        : ((await core.call(`todos.${kind}`, { id })) as { todo: TodoEntry });
    workbench.upsertTodo(result.todo);
    toast.success(t(DONE_TEXT[kind]));
    return result.todo;
  } catch (error) {
    toast.error(rpcErrorText(error, t('workbench.actionFailed')));
    return null;
  }
}

/** 打开对话；对话已删除（或不存在）时提示而不是静默。 */
export async function openConversation(
  conversationId: string,
  messageId: string | null = null,
): Promise<void> {
  try {
    if (messageId !== null) {
      if (!(await chat.jumpToMessage(conversationId, messageId))) {
        toast.error(t('workbench.drawer.conversationGone'));
      }
      return;
    }
    if (!chat.conversations.some((conversation) => conversation.id === conversationId)) {
      toast.error(t('workbench.drawer.conversationGone'));
      return;
    }
    await chat.select(conversationId);
  } catch (error) {
    toast.error(errorText(codeOf(error), t('workbench.actionFailed')));
  }
}

/** 事项对应的对话：最近一次派发的对话；否则项目执行者的项目组、Bot 执行者的私聊（幂等打开）。 */
export async function openTodoConversation(todo: TodoEntry): Promise<void> {
  if (todo.lastRun !== null) {
    await openConversation(todo.lastRun.conversationId);
    return;
  }
  const assignee = todo.assignee;
  if (assignee === null) return;
  if (assignee.kind === 'project') {
    await openConversation(assignee.projectId);
    return;
  }
  try {
    await chat.openDirect(assignee.botId);
  } catch (error) {
    toast.error(errorText(codeOf(error), t('workbench.actionFailed')));
  }
}

/** 「查看结果」：跳到最近一次交付的回复；没有回复就打开对话。 */
export async function openTodoResult(todo: TodoEntry): Promise<void> {
  const run = todo.lastRun;
  if (run !== null && run.resultMessageId !== null) {
    await openConversation(run.conversationId, run.resultMessageId);
    return;
  }
  await openTodoConversation(todo);
}

export async function openScheduleConversation(schedule: ScheduleEntry): Promise<void> {
  await openConversation(schedule.conversationId);
}

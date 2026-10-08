<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { Check, MessageCircleQuestion } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { isActiveTask } from './task-view';

  /**
   * 任务提问卡（D75，docs/design/30-supervisor-and-tasks.md §2.4.6）：任务需要
   * 用户拍板时出现，绑定任务（message.taskId）。点选候选答案 → 答案直接注入
   * 该任务（tasks.answer，不经对话轮）；用户也可以在输入框里自由回答，由对话
   * 轮从 <tasks> 看到哪条任务在等并转交。回答后卡片收起为「问题 + 已答行」。
   */
  let { message }: { message: Message } = $props();

  const content = $derived(
    message.kind === 'system_event'
      ? (message.content as { text?: string; options?: string[]; answer?: string })
      : {},
  );
  const taskId = $derived(message.taskId ?? '');
  $effect(() => {
    void tasks.ensure(taskId);
  });
  const task = $derived(tasks.byId[taskId] ?? null);
  const answer = $derived(typeof content.answer === 'string' ? content.answer : null);
  /** The task stopped before an answer came: the question is void. */
  const expired = $derived(answer === null && task !== null && !isActiveTask(task));
  const ownerName = $derived(task?.botId != null ? chat.botName(task.botId) : '');
  let submitting = $state(false);

  async function pick(option: string): Promise<void> {
    if (submitting || answer !== null || expired) return;
    submitting = true;
    try {
      await tasks.answer(message.id, option);
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('task.answerFailed')),
      );
    } finally {
      submitting = false;
    }
  }
</script>

<div
  class="flex w-full max-w-[85%] flex-col gap-2 rounded-lg border bg-background/80 p-3 text-sm"
  data-testid="task-question-card"
  data-task-id={taskId}
  data-answered={answer === null ? 'false' : 'true'}
>
  <div class="flex items-center gap-2 text-xs text-muted-foreground">
    <MessageCircleQuestion class="size-3.5 text-sky-600" aria-hidden="true" />
    <span class="min-w-0 truncate"
      >{task !== null
        ? t('task.questionFrom', { title: task.title })
        : t('task.questionFromBot', { name: ownerName })}</span
    >
  </div>
  <div class="font-medium whitespace-pre-wrap" data-testid="task-question-text">
    {content.text ?? ''}
  </div>
  {#if answer !== null}
    <div
      class="flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-background px-3 py-2"
      data-testid="task-question-answer"
    >
      <span class="min-w-0 truncate">{answer}</span>
      <Check class="size-4 shrink-0 text-primary" aria-hidden="true" />
    </div>
  {:else if expired}
    <p class="text-xs text-muted-foreground" data-testid="task-question-expired">
      {t('task.questionExpired')}
    </p>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each content.options ?? [] as option, index (option)}
        <button
          type="button"
          class="flex items-center rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-60"
          disabled={submitting}
          onclick={() => void pick(option)}
          data-testid={`task-question-option-${index}`}
        >
          <span class="min-w-0 truncate">{option}</span>
        </button>
      {/each}
    </div>
    <p class="text-xs text-muted-foreground">{t('task.questionFreeText')}</p>
  {/if}
</div>

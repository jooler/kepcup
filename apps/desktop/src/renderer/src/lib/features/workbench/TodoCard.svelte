<script lang="ts">
  import type { TodoEntry, TodoStatus } from '@kepcup/shared';
  import { CircleAlert, Clock, Sparkles } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import MemberAvatar from './MemberAvatar.svelte';
  import { describeAt, describeTodoWhen } from './describe';
  import { blockedNotice, effectiveStatus } from './workbench-model';
  import { openTodoConversation, openTodoResult, transitionTodo } from './todo-actions';
  import { workbench } from './workbench.svelte';

  /**
   * 事项卡（D90 §5.2）：标题、执行者、人话时间、状态胶囊、来源（管家）徽标、退回原因警示；
   * 主操作随状态变化——草案：指派 / 立即开始；已排期：改期；进行中：打开对话；
   * 待验收：查看结果 / 完成；已结束：恢复。点卡片本体打开详情抽屉。
   */
  let { todo, showAssignee = false }: { todo: TodoEntry; showAssignee?: boolean } = $props();

  const PILL: Record<TodoStatus, string> = {
    draft: 'bg-muted text-muted-foreground',
    scheduled: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
    in_progress: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    delivered: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    done: 'bg-muted text-muted-foreground',
    cancelled: 'bg-muted text-muted-foreground',
  };

  const whenText = $derived(describeTodoWhen(todo.schedule));
  const nextText = $derived(
    todo.schedule?.kind === 'cron' && todo.schedule.nextFireAt !== null
      ? describeAt(todo.schedule.nextFireAt)
      : null,
  );
  const blocked = $derived(blockedNotice(todo));
  const closed = $derived(todo.status === 'done' || todo.status === 'cancelled');
  // 周期事项自身停在已排期，最近一次执行另有进行中 / 已交付：胶囊仍显示事项状态，下面补一行执行摘要。
  const runStatus = $derived(effectiveStatus(todo));
  const periodicRun = $derived(
    todo.status === 'scheduled' && (runStatus === 'in_progress' || runStatus === 'delivered')
      ? runStatus
      : null,
  );
  // 取消后排期已清掉、无法再判断是否周期；有过派发记录的取消按「已停止」呈现。
  const statusText = $derived(
    todo.status === 'cancelled' && todo.lastRun !== null
      ? t('workbench.status.stopped')
      : t(`workbench.status.${todo.status}`),
  );
  const lastRunNote = $derived(
    todo.lastRun?.status === 'unclaimed'
      ? t('workbench.card.lastRunUnclaimed')
      : todo.lastRun?.status === 'failed'
        ? t('workbench.card.lastRunFailed')
        : null,
  );
  let busy = $state(false);

  async function act(run: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
  }

  function open(): void {
    workbench.openTodo(todo.id);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  }
</script>

<div
  role="button"
  tabindex="0"
  class="cursor-pointer rounded-lg border bg-card p-3 text-sm transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {closed
    ? 'opacity-70'
    : ''}"
  onclick={open}
  onkeydown={onKeydown}
  data-testid="todo-card"
  data-todo-id={todo.id}
  data-status={todo.status}
>
  <div class="flex items-start gap-2">
    <p
      class="min-w-0 flex-1 font-medium break-words {todo.status === 'cancelled'
        ? 'line-through'
        : ''}"
      data-testid="todo-card-title"
    >
      {todo.title}
    </p>
    {#if todo.source === 'butler'}
      <span
        class="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-700 dark:text-violet-400"
        title={t('workbench.card.byButlerHint')}
        data-testid="todo-card-butler"
      >
        <Sparkles class="size-3" aria-hidden="true" />{t('workbench.card.byButler')}
      </span>
    {/if}
    <span
      class="shrink-0 rounded-md px-1.5 py-0.5 text-xs {PILL[todo.status]}"
      data-testid="todo-card-status"
    >
      {statusText}
    </span>
  </div>

  <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
    {#if showAssignee}
      <span class="inline-flex items-center gap-1" data-testid="todo-card-assignee">
        {#if todo.assignee !== null}
          <MemberAvatar
            kind={todo.assignee.kind}
            id={todo.assignee.kind === 'bot' ? todo.assignee.botId : todo.assignee.projectId}
            name={todo.assigneeName ?? ''}
            class="size-4"
          />
          {todo.assigneeName ?? ''}
          {#if todo.assignee.kind === 'project' && todo.leadBotName !== null}
            · {t('workbench.card.leadBot', { name: todo.leadBotName })}
          {/if}
        {:else}
          {t('workbench.card.unassigned')}
        {/if}
      </span>
    {:else if todo.assignee?.kind === 'project' && todo.leadBotName !== null}
      <span data-testid="todo-card-assignee">
        {t('workbench.card.leadBot', { name: todo.leadBotName })}
      </span>
    {/if}
    {#if whenText !== null}
      <span class="inline-flex items-center gap-1" data-testid="todo-card-when">
        <Clock class="size-3" aria-hidden="true" />
        {whenText}{#if nextText !== null}
          · {t('schedules.nextFire', { time: nextText })}{/if}
      </span>
    {:else if todo.status === 'draft' && todo.assignee !== null}
      <span data-testid="todo-card-when">{t('workbench.card.noTime')}</span>
    {/if}
  </div>

  {#if periodicRun !== null}
    <p
      class="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs {periodicRun === 'delivered'
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-emerald-700 dark:text-emerald-400'}"
      data-testid="todo-card-last-run"
      data-run-status={todo.lastRun?.status}
    >
      {periodicRun === 'delivered'
        ? t('workbench.card.lastRunDelivered')
        : t('workbench.card.lastRunInProgress')}
    </p>
  {/if}

  {#if blocked !== null}
    <p
      class="mt-1.5 flex items-start gap-1 rounded-md px-2 py-0.5 text-xs {blocked.kind === 'error'
        ? 'bg-destructive/10 text-destructive'
        : blocked.kind === 'warn'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'text-muted-foreground'}"
      data-testid="todo-card-blocked"
      data-blocked-kind={blocked.kind}
    >
      {#if blocked.kind !== 'note'}
        <CircleAlert class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      {/if}
      {todo.status === 'draft'
        ? t('workbench.card.blocked', { reason: blocked.reason })
        : blocked.reason}
    </p>
  {:else if lastRunNote !== null && todo.status === 'scheduled'}
    <p class="mt-1.5 text-xs text-amber-700 dark:text-amber-400">{lastRunNote}</p>
  {/if}

  <!-- 主操作：stopPropagation，不触发卡片本体的「打开抽屉」 -->
  <div
    class="mt-2 flex flex-wrap justify-end gap-1"
    role="presentation"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => event.stopPropagation()}
  >
    {#if todo.status === 'draft'}
      {#if todo.assignee === null}
        <Button size="xs" variant="outline" onclick={open} data-testid="todo-card-assign">
          {t('workbench.action.assign')}
        </Button>
      {:else}
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onclick={() => void act(() => transitionTodo('start', todo.id))}
          data-testid="todo-card-start"
        >
          {t('workbench.action.start')}
        </Button>
      {/if}
    {:else if todo.status === 'scheduled'}
      {#if periodicRun !== null}
        <Button
          size="xs"
          variant="outline"
          onclick={() =>
            void (periodicRun === 'delivered' ? openTodoResult(todo) : openTodoConversation(todo))}
          data-testid="todo-card-run-open"
        >
          {periodicRun === 'delivered'
            ? t('workbench.action.viewResult')
            : t('workbench.action.openChat')}
        </Button>
      {/if}
      <Button size="xs" variant="outline" onclick={open} data-testid="todo-card-reschedule">
        {t('workbench.action.reschedule')}
      </Button>
    {:else if todo.status === 'in_progress'}
      <Button
        size="xs"
        variant="outline"
        onclick={() => void openTodoConversation(todo)}
        data-testid="todo-card-open-chat"
      >
        {t('workbench.action.openChat')}
      </Button>
    {:else if todo.status === 'delivered'}
      <Button
        size="xs"
        variant="outline"
        onclick={() => void openTodoResult(todo)}
        data-testid="todo-card-view-result"
      >
        {t('workbench.action.viewResult')}
      </Button>
      <Button
        size="xs"
        disabled={busy}
        onclick={() => void act(() => transitionTodo('complete', todo.id))}
        data-testid="todo-card-complete"
      >
        {t('workbench.action.complete')}
      </Button>
    {:else}
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onclick={() => void act(() => transitionTodo('reopen', todo.id))}
        data-testid="todo-card-reopen"
      >
        {t('workbench.action.reopen')}
      </Button>
    {/if}
  </div>
</div>

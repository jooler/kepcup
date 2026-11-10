<script lang="ts">
  import {
    CircleCheck,
    CircleSlash,
    CircleX,
    Clock,
    Loader2,
    ListTodo,
  } from '@lucide/svelte';
  import type { TaskView } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { isActiveTask } from '$lib/features/tasks/task-view';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import { Button } from '$lib/components/ui/button';
  import { botTasks } from './bot-tasks.svelte';

  /**
   * D116 Bot 详情「任务」tab（docs/design/56 §2）：该 Bot 拉起的全部任务（跨
   * 对话全集），进行中 / 已完成分组；行点击在主区打开任务详情页（右栏不动）。
   * 数据来自共享的 botTasks store（RightPanel 的 tab 徽标读同一份），面板内只
   * 提供手动刷新；实时续期由 store 的 `task.updated` 订阅承担。
   */
  let {
    botId,
    testid = 'bot-tasks-panel',
  }: {
    botId: string;
    testid?: string;
  } = $props();

  const items = $derived(botTasks.botId === botId ? botTasks.items : []);
  const loading = $derived(botTasks.loading);
  const activeItems = $derived(items.filter((entry) => isActiveTask(entry)));
  const doneItems = $derived(items.filter((entry) => !isActiveTask(entry)));

  function open(task: TaskView, event: Event): void {
    // 覆盖层形态（窄屏 / 宽屏放不下并排右栏）：右栏就是全屏覆盖层，任务详情页
    // 在它背后——先收起覆盖层再打开，否则点击「没有任何可见反馈」。
    if (sidebarLayout.panelAsOverlay) narrowLayout.closeBotDetail();
    const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    // 台账记任务自己的会话：切回该会话时任务页原位恢复（与任务卡打开同语义）。
    tasks.openDetail(task.taskId, trigger, task.conversationId);
  }

  function whenText(task: TaskView): string {
    return new Date(task.startedAt ?? task.createdAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** 进行中行内联的状态提示：排队原因 / 等待用户输入（与详情页 hint 行同口径）。 */
  function hintOf(task: TaskView): string {
    if (task.queueReason !== null) return task.queueReason.length > 0
      ? t('task.queued', { reason: task.queueReason })
      : t('task.waitingStart');
    if (task.awaitingInput) return t('task.awaitingInput');
    return '';
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid={testid}>
  <div class="flex items-center justify-between gap-2">
    <p class="text-xs text-muted-foreground">{t('rightPanel.tasksHint')}</p>
    <Button
      size="sm"
      variant="outline"
      disabled={loading}
      onclick={() => void botTasks.load(botId)}
      data-testid={`${testid}-refresh`}
    >
      {t('common.refresh')}
    </Button>
  </div>

  {#if loading && items.length === 0}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-loading`}>…</p>
  {:else if items.length === 0}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-empty`}>
      {t('rightPanel.tasksEmpty')}
    </p>
  {:else}
    <ul class="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1" data-testid={`${testid}-list`}>
      {#if activeItems.length > 0}
        <li
          class="flex items-center gap-1 px-1 pt-1 text-[11px] font-medium text-muted-foreground"
          data-testid={`${testid}-active-label`}
        >
          <ListTodo class="size-3" aria-hidden="true" />
          {t('rightPanel.tasksActiveGroup', { count: activeItems.length })}
        </li>
      {/if}
      {#each activeItems as task (task.taskId)}
        <li>
          <button
            type="button"
            class="w-full rounded-md border p-2 text-left transition-colors hover:bg-accent/50"
            onclick={(event) => open(task, event)}
            data-testid={`bot-task-item-${task.taskId}`}
          >
            <div class="flex min-w-0 items-center gap-1.5">
              {#if task.state === 'running'}
                <Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
              {:else}
                <Clock class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {/if}
              <span class="min-w-0 flex-1 truncate text-sm" data-testid="bot-task-title">
                {task.title.length > 0 ? task.title : t('task.run.taskId', { id: task.taskId })}
              </span>
              {#if task.writes}
                <span
                  class="shrink-0 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-400"
                  >{t('task.run.writes')}</span
                >
              {/if}
            </div>
            <p class="mt-0.5 truncate text-xs text-muted-foreground" data-testid="bot-task-meta">
              {t(`task.state.${task.state}`)}
              · {whenText(task)}{#if hintOf(task).length > 0}
                · <span class="text-amber-700 dark:text-amber-400">{hintOf(task)}</span>{/if}
            </p>
          </button>
        </li>
      {/each}
      {#if doneItems.length > 0}
        <li
          class="flex items-center gap-1 px-1 pt-2 text-[11px] font-medium text-muted-foreground"
          data-testid={`${testid}-done-label`}
        >
          {t('rightPanel.tasksDoneGroup', { count: doneItems.length })}
        </li>
      {/if}
      {#each doneItems as task (task.taskId)}
        <li>
          <button
            type="button"
            class="w-full rounded-md border p-2 text-left transition-colors hover:bg-accent/50"
            onclick={(event) => open(task, event)}
            data-testid={`bot-task-item-${task.taskId}`}
          >
            <div class="flex min-w-0 items-center gap-1.5">
              {#if task.state === 'completed'}
                <CircleCheck class="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              {:else if task.state === 'failed' || task.state === 'interrupted'}
                <CircleX class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
              {:else}
                <CircleSlash class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {/if}
              <span class="min-w-0 flex-1 truncate text-sm" data-testid="bot-task-title">
                {task.title.length > 0 ? task.title : t('task.run.taskId', { id: task.taskId })}
              </span>
              {#if task.writes}
                <span
                  class="shrink-0 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-400"
                  >{t('task.run.writes')}</span
                >
              {/if}
            </div>
            <p class="mt-0.5 truncate text-xs text-muted-foreground" data-testid="bot-task-meta">
              {t(`task.state.${task.state}`)}
              · {whenText(task)}
            </p>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

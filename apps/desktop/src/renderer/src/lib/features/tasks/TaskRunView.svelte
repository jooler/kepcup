<script lang="ts">
  import type { RunStep } from '@kepcup/shared';
  import {
    ArrowLeft,
    CircleCheck,
    CircleSlash,
    CircleX,
    Clock,
    CornerDownRight,
    Loader2,
  } from '@lucide/svelte';
  import { t, listSeparator } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { registerEscapeLayer, ESCAPE_PRIORITY } from '$lib/features/shell/escape-layers';
  import { Button } from '$lib/components/ui/button';
  import Markdown from '$lib/features/chats/Markdown.svelte';
  import TaskRunToolCard from './TaskRunToolCard.svelte';
  import TaskPlanPanel from './TaskPlanPanel.svelte';
  import {
    buildTaskRunTimeline,
    formatElapsed,
    latestPlan,
    taskElapsedMs,
    type TaskRunEntry,
  } from './task-run-view';
  import { isActiveTask } from './task-view';

  /**
   * 任务执行过程页（docs/design/42-task-run-view.md）：对话里的任务卡打开它，
   * 原对话（含右栏）以 display:none 留在 DOM 里，本页占满主区。顶部是返回、
   * 任务名、状态与 metadata；正文把该任务的 run_steps 渲染成 Agent 消息
   * 时间线——助手说明、工具调用 + 结果、进度与追加指令。
   *
   * 运行中经 `run.progress` / `run.status` / `task.updated` 事件触发增量重读
   * `runs.steps`，另以 1.2s 轮询兜底；任务终态后停止轮询。
   */
  let { taskId }: { taskId: string } = $props();

  let steps = $state<RunStep[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);
  let taskChecked = $state(false);
  let now = $state(Date.now());
  let scrollContainer = $state<HTMLElement>();
  let backButton = $state<HTMLElement | null>(null);
  let follow = $state(true);

  const task = $derived(tasks.byId[taskId] ?? null);
  const entries = $derived(buildTaskRunTimeline(steps));
  const plan = $derived(latestPlan(steps));
  const active = $derived(task !== null && isActiveTask(task));
  const title = $derived(
    task?.title ?? (taskChecked ? t('task.run.taskId', { id: taskId }) : t('task.run.loading')),
  );
  const ownerName = $derived(task?.botId != null ? chat.botName(task.botId) : '');
  const elapsed = $derived(task !== null ? formatElapsed(taskElapsedMs(task, now)) : '');
  const narrow = $derived(narrowLayout.narrow);
  const isMac = /Mac/i.test(navigator.platform);

  $effect(() => {
    const id = taskId;
    taskChecked = false;
    void tasks.ensure(id).finally(() => {
      if (id === taskId) taskChecked = true;
    });
  });

  $effect(() => {
    const id = taskId;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // Latest-wins: a slow response must not overwrite a newer transcript
    // (notably the final steps after the terminal event stopped the poll).
    let latest = 0;
    loading = true;
    loadFailed = false;
    steps = [];

    const refresh = async (silent: boolean): Promise<void> => {
      const seq = (latest += 1);
      try {
        const result = (await core.call('runs.steps', { runId: id })) as { steps: RunStep[] };
        if (cancelled || id !== taskId || seq !== latest) return;
        steps = result.steps;
        loadFailed = false;
      } catch {
        if (cancelled || id !== taskId || seq !== latest) return;
        if (!silent) loadFailed = true;
      } finally {
        if (!cancelled && id === taskId && seq === latest) loading = false;
      }
    };

    const schedule = (): void => {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void refresh(true);
      }, 180);
    };

    void refresh(false);
    const offProgress = core.onEvent('run.progress', (payload) => {
      if ((payload as { runId?: string }).runId === id) schedule();
    });
    const offStatus = core.onEvent('run.status', (payload) => {
      if ((payload as { run?: { id?: string } }).run?.id === id) schedule();
    });
    const offTask = core.onEvent('task.updated', (payload) => {
      if ((payload as { task?: { taskId?: string } }).task?.taskId === id) schedule();
    });
    const poll = setInterval(() => {
      const view = tasks.byId[id];
      if (view !== undefined && isActiveTask(view)) void refresh(true);
    }, 1200);

    return () => {
      cancelled = true;
      if (debounce !== null) clearTimeout(debounce);
      clearInterval(poll);
      offProgress();
      offStatus();
      offTask();
    };
  });

  $effect(() => {
    // Only a running task's elapsed time changes; freeze it after the end.
    if (!active) return;
    const ticker = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(ticker);
  });

  $effect(() => {
    // 进入执行过程页时焦点落在返回键：原任务卡仍在 DOM 里但已 display:none。
    queueMicrotask(() => backButton?.focus({ preventScroll: true }));
  });

  $effect(() => {
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.overlay,
      onEscape: () => tasks.closeDetail({ restoreFocus: true }),
    });
  });

  $effect(() => {
    void steps;
    if (!follow) return;
    queueMicrotask(() => {
      const element = scrollContainer;
      if (element !== undefined) element.scrollTop = element.scrollHeight;
    });
  });

  function onScroll(): void {
    const element = scrollContainer;
    if (element === undefined) return;
    follow = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  }

  function timeOf(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function isTool(entry: TaskRunEntry): entry is Extract<TaskRunEntry, { kind: 'tool' }> {
    return entry.kind === 'tool';
  }
</script>

<div
  class="relative flex min-h-0 flex-1 flex-col bg-background"
  data-testid="task-run-view"
  data-task-id={taskId}
  data-task-state={task?.state ?? 'unknown'}
>
  <header
    class="app-drag flex shrink-0 items-start gap-2 border-b px-3 py-2.5 {narrow && isMac
      ? 'pl-20'
      : ''}"
  >
    <Button
      bind:ref={backButton}
      variant="ghost"
      size="icon"
      class="app-no-drag mt-0.5 size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
      onclick={() => tasks.closeDetail({ restoreFocus: true })}
      aria-label={t('task.run.back')}
      title={t('task.run.back')}
      data-testid="task-run-back"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
    </Button>

    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <h2 class="min-w-0 truncate text-sm font-medium" data-testid="task-run-title">
          {title}
        </h2>
        {#if task !== null}
          <span
            class="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] {task.state ===
            'completed'
              ? 'border-emerald-600/30 text-emerald-700 dark:text-emerald-400'
              : task.state === 'failed' || task.state === 'interrupted'
                ? 'border-destructive/30 text-destructive'
                : 'text-muted-foreground'}"
            data-testid="task-run-state"
          >
            {#if task.state === 'running'}
              <Loader2 class="size-3 animate-spin" aria-hidden="true" />
            {:else if task.state === 'submitted'}
              <Clock class="size-3" aria-hidden="true" />
            {:else if task.state === 'completed'}
              <CircleCheck class="size-3" aria-hidden="true" />
            {:else if task.state === 'cancelled'}
              <CircleSlash class="size-3" aria-hidden="true" />
            {:else}
              <CircleX class="size-3" aria-hidden="true" />
            {/if}
            {t(`task.state.${task.state}`)}
          </span>
        {/if}
      </div>
      {#if task !== null}
        <div
          class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground"
          data-testid="task-run-meta"
        >
          {#if ownerName.length > 0}<span>{ownerName}</span>{/if}
          <span>{t('task.run.startedAt', { time: timeOf(task.startedAt ?? task.createdAt) })}</span>
          <span aria-hidden="true">·</span>
          <span class:font-medium={active} data-testid="task-run-duration"
            >{t('task.run.duration', { time: elapsed })}</span
          >
          {#if task.cwdKind !== null}
            <span aria-hidden="true">·</span>
            <span
              >{task.cwdKind === 'workdir' ? t('task.run.workdir') : t('task.run.workspace')}</span
            >
          {/if}
          <span aria-hidden="true">·</span>
          <span>{task.writes ? t('task.run.writes') : t('task.run.readOnly')}</span>
          <span aria-hidden="true">·</span>
          <span class="font-mono">{t('task.run.taskId', { id: task.taskId })}</span>
          {#if (task.capabilities ?? []).length > 0}
            <span aria-hidden="true">·</span>
            <span class="truncate"
              >{t('task.capabilities', {
                list: (task.capabilities ?? []).join(listSeparator()),
              })}</span
            >
          {/if}
        </div>
      {/if}
    </div>
  </header>

  {#if task !== null}
    {@const hint =
      task.queueReason !== null
        ? task.queueReason.length > 0
          ? t('task.queued', { reason: task.queueReason })
          : t('task.waitingStart')
        : task.awaitingInput
          ? t('task.awaitingInput')
          : task.state === 'failed' || task.state === 'interrupted'
            ? (task.error ?? '')
            : task.state === 'cancelled'
              ? (task.cancelReason ?? '')
              : (task.lastProgress ?? '')}
    {#if hint.length > 0}
      <div
        class="shrink-0 border-b px-4 py-1.5 text-xs {task.state === 'failed' ||
        task.state === 'interrupted'
          ? 'text-destructive'
          : 'text-muted-foreground'}"
        data-testid="task-run-hint"
      >
        {hint}
      </div>
    {/if}
  {/if}

  {#if plan !== null}
    <div class="shrink-0 border-b px-4 py-2">
      <div class="mx-auto w-full max-w-3xl">
        <TaskPlanPanel {plan} />
      </div>
    </div>
  {/if}

  <div
    bind:this={scrollContainer}
    onscroll={onScroll}
    class="min-h-0 flex-1 overflow-y-auto px-4 py-4"
    data-testid="task-run-scroll"
  >
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {#if loading || (!taskChecked && task === null && !loadFailed)}
        <div class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
          {t('task.run.loading')}
        </div>
      {:else if loadFailed}
        <p
          class="py-10 text-center text-sm text-muted-foreground"
          data-testid="task-run-load-failed"
        >
          {t('task.run.loadFailed')}
        </p>
      {:else if task === null && entries.length === 0}
        <p class="py-10 text-center text-sm text-muted-foreground" data-testid="task-run-missing">
          {t('task.run.missing')}
        </p>
      {:else if entries.length === 0}
        <p class="py-10 text-center text-sm text-muted-foreground" data-testid="task-run-empty">
          {t('task.run.empty')}
        </p>
      {:else}
        {#each entries as entry (entry.id)}
          {#if entry.kind === 'assistant'}
            <div class="text-sm" data-testid="task-run-assistant">
              {#if entry.text.length > 0}
                <Markdown content={entry.text} />
              {/if}
              {#if entry.error !== null}
                <p class="mt-1 text-xs text-destructive">{entry.error}</p>
              {/if}
            </div>
          {:else if isTool(entry)}
            <TaskRunToolCard {entry} {active} />
          {:else if entry.kind === 'steer'}
            <div class="flex justify-end" data-testid="task-run-steer">
              <div class="max-w-[85%] rounded-2xl bg-muted px-3 py-2 text-sm">
                <p
                  class="mb-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground"
                >
                  <CornerDownRight class="size-3" aria-hidden="true" />
                  {t('task.run.steer')}
                </p>
                <p class="whitespace-pre-wrap" data-testid="task-run-steer-text">{entry.text}</p>
              </div>
            </div>
          {:else if entry.kind === 'progress'}
            <div
              class="flex items-start gap-1.5 px-1 text-xs text-muted-foreground"
              data-testid="task-run-progress"
            >
              <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-50"></span>
              <span class="min-w-0 whitespace-pre-wrap">{entry.text}</span>
            </div>
          {:else}
            <p class="px-1 text-xs text-muted-foreground" data-testid="task-run-system">
              {entry.text}
            </p>
          {/if}
        {/each}
        {#if active}
          <div
            class="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground"
            data-testid="task-run-live"
          >
            <Loader2 class="size-3 animate-spin" aria-hidden="true" />
            {t('task.run.live')}
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { RunStep } from '@kepcup/shared';
  import {
    ArrowLeft,
    ChevronDown,
    ChevronRight,
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
  import { ChatSession } from '$lib/stores/chat-session.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { registerEscapeLayer, ESCAPE_PRIORITY } from '$lib/features/shell/escape-layers';
  import { Button } from '$lib/components/ui/button';
  import Markdown from '$lib/features/chats/Markdown.svelte';
  import ApprovalDock from '$lib/features/approvals/ApprovalDock.svelte';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import TaskRunToolCard from './TaskRunToolCard.svelte';
  import TaskPlanPanel from './TaskPlanPanel.svelte';
  import TaskQuestionCard from './TaskQuestionCard.svelte';
  import {
    approvalConversationIdOf,
    buildTaskRunTimeline,
    formatElapsed,
    latestPlan,
    pendingTaskQuestionOf,
    taskElapsedMs,
    type TaskRunEntry,
  } from './task-run-view';
  import { isActiveTask } from './task-view';

  /**
   * 任务详情页（docs/design/42-task-run-view.md）：对话里的任务卡打开它，
   * 原对话（含右栏）以 display:none 留在 DOM 里，本页占满主区。顶部是返回、
   * 任务名、状态与 metadata；正文是**执行报告**（终态条目原文，用户在这里读
   * 报告——对话里不再转发原文，design 30 §6.1 2026-11 修订）与折叠的
   * **执行过程**（run_steps 渲染成 Agent 消息时间线：助手说明、工具调用 +
   * 结果、进度与追加指令）。运行中的任务默认展开执行过程（实时进度就是主
   * 内容），已结算的任务默认折叠——页面一打开先看到报告。
   *
   * 运行中经 `run.progress` / `run.status` / `task.updated` 事件触发增量重读
   * `runs.steps`，另以 1.2s 轮询兜底；任务终态后停止轮询。
   *
   * 本会话的待审批卡（权限请求）在时间线下方固定渲染：详情页打开期间原对话
   * （含输入坞上方的 ApprovalDock）是 display:none，任务停在 waiting_approval
   * 时用户在页内毫无感知——这里给出同源的卡片，批准 / 拒绝可直接在页内完成。
   * 任务提问卡（ask_user，D75 §2.4.6）同理：它是会话消息而非 run step，对话
   * 被隐藏时用户在页内看不到提问——从会话消息里取该任务未答的卡固定在时间线
   * 下方，点选回答直接注入任务（与对话里的卡同源，答完即收起）。
   */
  let {
    taskId,
    onBack,
    approvalConversationId: approvalConversationIdProp = undefined,
  }: {
    taskId: string;
    /** Dialog sessions pass this so Back does not close the main task page. */
    onBack?: () => void;
    /**
     * Conversation whose approval cards belong on this page. Omitted on the
     * main task page, which falls back to the open chat.
     */
    approvalConversationId?: string | null;
  } = $props();

  let steps = $state<RunStep[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);
  let taskChecked = $state(false);
  let now = $state(Date.now());
  let scrollContainer = $state<HTMLElement>();
  let backButton = $state<HTMLElement | null>(null);
  let follow = $state(true);
  /** 执行过程是否展开：首次看到任务时按状态定格（运行中展开、已结算折叠）。 */
  let processOpen = $state(true);
  let processInitialized = false;

  const task = $derived(tasks.byId[taskId] ?? null);
  const reportText = $derived((task?.result?.text ?? '').trim());
  const entries = $derived(buildTaskRunTimeline(steps));
  const plan = $derived(latestPlan(steps));
  const active = $derived(task !== null && isActiveTask(task));
  // 会话消息随打开详情页的对话而来（主页对话回退 chat.main，卡片弹层是自己的
  // session）：提问卡从它取，message.created / updated 事件保持同源实时。
  const chatSession = getChatSession();
  // D113 执行归属映射：委派产生的任务住在 B 的私聊——详情页从别处打开（如委派
  // 详情视图）时上下文会话不是任务的归属会话，为任务自己的会话开一个后台
  // session 供提问卡（ask_user）取数（审批条走 task.conversationId 不受影响）。
  let homeSession = $state<ChatSession | null>(null);
  $effect(() => {
    const convId = task?.conversationId;
    if (convId === null || convId === undefined || chatSession.conversation?.id === convId) return;
    const bg = new ChatSession(undefined, { foreground: false });
    homeSession = bg;
    void bg.open(convId);
    return () => bg.dispose();
  });
  const questionSession = $derived(
    chatSession.conversation?.id !== undefined && chatSession.conversation?.id === task?.conversationId
      ? chatSession
      : homeSession,
  );
  const pendingQuestion = $derived(pendingTaskQuestionOf(questionSession?.messages ?? [], taskId));
  const title = $derived(
    task?.title ?? (taskChecked ? t('task.run.taskId', { id: taskId }) : t('task.run.loading')),
  );
  const ownerName = $derived(task?.botId != null ? chat.botName(task.botId) : '');
  const elapsed = $derived(task !== null ? formatElapsed(taskElapsedMs(task, now)) : '');
  const narrow = $derived(narrowLayout.narrow);
  const isMac = /Mac/i.test(navigator.platform);
  // 审批条归属的会话（approvalConversationIdOf）：任务自带；任务视图还没读
  // 到时回退当前会话——详情页只在本会话内打开，切会话即关闭。
  const approvalConversationId = $derived(
    approvalConversationIdOf(
      task,
      approvalConversationIdProp !== undefined
        ? approvalConversationIdProp
        : chat.current?.conversation.id,
    ),
  );

  function goBack(): void {
    if (onBack !== undefined) onBack();
    else tasks.closeDetail({ restoreFocus: true });
  }
  const pendingApprovals = $derived(permissions.pendingOf(approvalConversationId));

  $effect(() => {
    const id = taskId;
    taskChecked = false;
    void tasks.ensure(id).finally(() => {
      if (id === taskId) taskChecked = true;
    });
  });

  $effect(() => {
    // 打开详情页时补拉一次会话审批：连接中断期间的 approval.created 事件
    // 会丢，只靠事件会让审批条漏卡。只并入审批记录，不动右栏数据。
    const id = approvalConversationId;
    if (id !== null) void permissions.reloadApprovals(id);
  });

  $effect(() => {
    // 首次拿到任务视图时定格执行过程的展开状态，之后不随终态翻转——正在看
    // 运行中任务的人不会被结算打断。
    const current = task;
    if (processInitialized || current === null) return;
    processInitialized = true;
    processOpen = isActiveTask(current);
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
    // 挂载那一刻已有待审批卡则不抢焦点，让审批条按「逐张聚焦」把焦点交给
    // 队首卡片（untrack：只看打开那一刻，不随待审批集合变化重触发）。
    const pendingOnEnter = untrack(() => pendingApprovals.length > 0);
    if (pendingOnEnter) return;
    queueMicrotask(() => backButton?.focus({ preventScroll: true }));
  });

  $effect(() => {
    const back = onBack;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.overlay,
      onEscape: () => {
        if (back !== undefined) back();
        else tasks.closeDetail({ restoreFocus: true });
      },
    });
  });

  $effect(() => {
    void steps;
    // 只有运行中的任务跟随新步骤滚到底部：已结算任务的正文是执行报告，打开的
    // 落点应当是报告开头，滚到末尾会让人只看到最后一屏。
    if (!follow || !active) return;
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
      onclick={goBack}
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

    {#if plan !== null}
      <!-- 右上角「任务清单」入口：清单内容在浮层里，不再占正文顶部。 -->
      <TaskPlanPanel {plan} {narrow} />
    {/if}
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
      {:else}
        <!--
          执行过程（折叠）：运行中的任务默认展开——实时进度就是主内容；已结算
          的任务默认折叠，页面一打开先看到下方的执行报告。用户点标题栏可随时
          展开 / 收起。
        -->
        <section data-testid="task-run-process" data-open={processOpen ? 'true' : 'false'}>
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={processOpen}
            onclick={() => (processOpen = !processOpen)}
            data-testid="task-run-process-toggle"
          >
            {#if processOpen}
              <ChevronDown class="size-3.5" aria-hidden="true" />
            {:else}
              <ChevronRight class="size-3.5" aria-hidden="true" />
            {/if}
            {t('task.run.process')}
          </button>
          {#if processOpen}
            <div class="mt-1 flex flex-col gap-3" data-testid="task-run-process-body">
              {#if entries.length === 0}
                <p
                  class="py-6 text-center text-sm text-muted-foreground"
                  data-testid="task-run-empty"
                >
                  {t('task.run.empty')}
                </p>
              {/if}
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
                      <p class="whitespace-pre-wrap" data-testid="task-run-steer-text">
                        {entry.text}
                      </p>
                    </div>
                  </div>
                {:else if entry.kind === 'progress'}
                  <div
                    class="flex items-start gap-1.5 px-1 text-xs text-muted-foreground"
                    data-testid="task-run-progress"
                  >
                    <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-50"
                    ></span>
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
            </div>
          {/if}
        </section>

        {#if reportText.length > 0}
          <!-- 执行报告：终态条目原文，用户在这里读；对话里不再出现原文。 -->
          <section
            class="rounded-lg border bg-muted/20 px-4 py-3"
            data-testid="task-run-report"
            data-report-status={task?.result?.status ?? ''}
          >
            <h3 class="mb-2 text-xs font-medium text-muted-foreground">
              {t('task.run.reportTitle')}
            </h3>
            <div class="text-sm">
              <Markdown content={reportText} />
            </div>
          </section>
        {/if}
      {/if}
    </div>
  </div>

  {#if active && pendingQuestion !== null}
    <!--
      任务提问条：任务等用户拍板时（awaiting_input），把该任务未答的提问卡
      固定在时间线下方（与审批条同思路）。卡片与对话完全同源（session.messages
      随 message.created / updated 实时增改），点选 / 表单回答直接注入任务，
      答完卡带上 answer，这里随之收起；任务已终态时不再渲染（提问已作废，
      时间线里有终态说明）。
    -->
    <div
      class="shrink-0 border-t px-4 py-2"
      data-testid="task-run-question"
      data-question-message-id={pendingQuestion.id}
    >
      <div class="mx-auto flex w-full max-w-3xl justify-center">
        <TaskQuestionCard message={pendingQuestion} />
      </div>
    </div>
  {/if}

  {#if approvalConversationId !== null && pendingApprovals.length > 0}
    <!--
      权限请求条：对话被 display:none 隐藏期间任务触发的审批卡改在这里出现
      （与对话输入坞上方同一份 permissions 数据）。固定在时间线之下、始终
      可见；卡片获得焦点后 Enter 批准 / Esc 拒绝，Esc 先被卡片消费，不会
      误退详情页。
    -->
    <div class="shrink-0 border-t" data-testid="task-run-approvals">
      <ApprovalDock conversationId={approvalConversationId} />
    </div>
  {/if}
</div>

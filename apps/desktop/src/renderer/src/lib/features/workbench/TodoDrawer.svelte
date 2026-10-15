<script lang="ts">
  import { untrack } from 'svelte';
  import type { Bot, TodoAssignee, TodoEntry, TodoRun } from '@kepcup/shared';
  import { TODO_NOTES_MAX_CHARS, TODO_TITLE_MAX_CHARS } from '@kepcup/shared';
  import { CircleAlert, X } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import * as Select from '$lib/components/ui/select';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';
  import WhenPicker from './WhenPicker.svelte';
  import { describeAt } from './describe';
  import { openConversation, rpcErrorText, transitionTodo } from './todo-actions';
  import {
    draftFromSchedule,
    emptyWhenDraft,
    fromLocalInput,
    isPastOnce,
    nextFireOfPreset,
    sameWhen,
    whenFromDraft,
    type WhenDraft,
  } from './when-presets';
  import { buildUpdateInput, isInfoWarning, type TodoFormValues } from './todo-form';
  import { blockedNotice, botMembers, groupMembers, type MemberInfo } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 事项详情抽屉（D90 §5.2）：在工作台内从右侧滑出，新建与编辑共用。
   * 标题 / 说明 / 执行者（active Bot、非只读群、管家；群可选负责 Bot）/ 时间（WhenPicker）/
   * 执行记录 / 底部状态迁移。保存后把 `warnings` 就地显示；没有提示就直接关闭。
   * 已开始执行（进行中 / 待验收）的事项锁定执行者与时间，已结束的整体只读（恢复后再改）。
   */
  const drawer = $derived(workbench.drawer);
  /** Select 的「空」选项不能用空串（bits-ui 把 '' 当未选择），用哨兵值。 */
  const NONE = '__none__';

  let entry = $state<TodoEntry | null>(null);
  let runs = $state<TodoRun[]>([]);
  let runsFailed = $state(false);
  let loading = $state(false);
  let notFound = $state(false);
  /** 编辑态下 todos.get 失败（非 NOT_FOUND）且还没拿到过事项：只显示错误与重试，不渲染表单。 */
  let loadFailed = $state(false);
  /** 脏表单上的破坏性操作先确认：`message` 是提示，`run` 是确认后执行的动作。 */
  let pendingDiscard = $state.raw<{ message: string; run: () => void | Promise<void> } | null>(
    null,
  );
  let titleEl = $state<HTMLInputElement | null>(null);
  let asideEl = $state<HTMLElement | null>(null);

  let title = $state('');
  let notes = $state('');
  /** '' = 未指派；`bot:<id>` / `group:<conversationId>`。 */
  let assigneeKey = $state('');
  let leadBotId = $state('');
  let whenDraft = $state<WhenDraft>(emptyWhenDraft());
  let memoId = $state<string | null>(null);
  /** 载入 / 重置时的快照，用来判断脏与计算要提交的差异。 */
  let base = $state<{
    title: string;
    notes: string;
    assigneeKey: string;
    leadBotId: string;
    when: WhenDraft;
  }>({ title: '', notes: '', assigneeKey: '', leadBotId: '', when: emptyWhenDraft() });

  let warnings = $state<string[]>([]);
  let saving = $state(false);
  let formError = $state<string | null>(null);
  let confirmCancel = $state(false);
  let groupMembersOf = $state<Record<string, MemberInfo[]>>({});

  const isNew = $derived(drawer?.kind === 'new');
  const status = $derived(entry?.status ?? 'draft');
  const closed = $derived(status === 'done' || status === 'cancelled');
  const started = $derived(status === 'in_progress' || status === 'delivered');
  const planLocked = $derived(closed || started);
  /** 已开始 / 已结束事项的时间说明：最近一次派发的时刻；没派发过就说明没有。 */
  const lockedWhenText = $derived.by(() => {
    const dispatchedAt = entry?.lastRun?.dispatchedAt ?? null;
    return dispatchedAt === null
      ? t('workbench.drawer.whenNeverDispatched')
      : t('workbench.drawer.whenDispatchedAt', { when: describeAt(dispatchedAt) });
  });
  const dirty = $derived(
    title !== base.title ||
      notes !== base.notes ||
      assigneeKey !== base.assigneeKey ||
      leadBotId !== base.leadBotId ||
      !sameWhen(whenDraft, base.when),
  );

  // --- 名单 -----------------------------------------------------------------
  const botOptions = $derived(botMembers(contacts.bots));
  const groupOptions = $derived(groupMembers(chat.conversations, true));
  /** 事项上已有、但已不在可选名单里的执行者（Bot 已删 / 群只读）：保留原值，标注不可用。 */
  const goneAssignee = $derived.by((): { key: string; name: string } | null => {
    const assignee = entry?.assignee;
    if (assignee === null || assignee === undefined) return null;
    const key = keyOf(assignee);
    const known =
      assignee.kind === 'bot'
        ? botOptions.some((bot) => bot.id === assignee.botId)
        : groupOptions.some((group) => group.id === assignee.conversationId);
    return known ? null : { key, name: entry?.assigneeName ?? '' };
  });
  const selectedGroupId = $derived(assigneeKey.startsWith('group:') ? assigneeKey.slice(6) : null);
  const leadOptions = $derived(
    selectedGroupId === null ? [] : (groupMembersOf[selectedGroupId] ?? []),
  );

  function keyOf(assignee: TodoAssignee | null): string {
    if (assignee === null) return '';
    return assignee.kind === 'bot' ? `bot:${assignee.botId}` : `group:${assignee.conversationId}`;
  }

  function assigneeFromForm(): TodoAssignee | null {
    if (assigneeKey.startsWith('bot:')) return { kind: 'bot', botId: assigneeKey.slice(4) };
    if (assigneeKey.startsWith('group:')) {
      return {
        kind: 'group',
        conversationId: assigneeKey.slice(6),
        leadBotId: leadBotId === '' ? null : leadBotId,
      };
    }
    return null;
  }

  const assigneeLabel = $derived.by(() => {
    if (assigneeKey === '') return t('workbench.drawer.assigneeNone');
    if (goneAssignee !== null && goneAssignee.key === assigneeKey) {
      return t('workbench.drawer.assigneeGone', { name: goneAssignee.name });
    }
    const id = assigneeKey.slice(assigneeKey.indexOf(':') + 1);
    const pool = assigneeKey.startsWith('bot:') ? botOptions : groupOptions;
    const member = pool.find((item) => item.id === id);
    return member === undefined ? id : memberLabel(member);
  });

  function memberLabel(member: MemberInfo): string {
    return member.isButler === true
      ? `${member.name}${t('workbench.drawer.butlerSuffix')}`
      : member.name;
  }

  const leadLabel = $derived(
    leadBotId === ''
      ? t('workbench.drawer.leadNone')
      : (leadOptions.find((member) => member.id === leadBotId)?.name ??
          entry?.leadBotName ??
          leadBotId),
  );

  // --- 载入 / 重置 -------------------------------------------------------------
  function applyForm(source: {
    title: string;
    notes: string;
    assignee: TodoAssignee | null;
    schedule: TodoEntry['schedule'];
  }): void {
    title = source.title;
    notes = source.notes;
    assigneeKey = keyOf(source.assignee);
    leadBotId = source.assignee?.kind === 'group' ? (source.assignee.leadBotId ?? '') : '';
    whenDraft = draftFromSchedule(source.schedule);
    base = {
      title,
      notes,
      assigneeKey,
      leadBotId,
      when: structuredClone($state.snapshot(whenDraft)),
    };
  }

  /**
   * 读一条事项（+ 执行记录）。`initial` = 打开时的首次载入（直接填表）；否则是刷新：
   * 响应回来时表单仍没被改过才覆盖（等待期间用户开始编辑了就只更新事项与执行记录）。
   */
  async function load(todoId: string, initial: boolean): Promise<void> {
    loading = entry === null;
    try {
      const result = (await core.call('todos.get', { id: todoId })) as {
        todo: TodoEntry;
        runs: TodoRun[];
      };
      // 期间抽屉已切到别的事项：丢弃。
      if (workbench.drawer?.kind !== 'edit' || workbench.drawer.todoId !== todoId) return;
      entry = result.todo;
      runs = result.runs;
      runsFailed = false;
      loadFailed = false;
      memoId = result.todo.memoId;
      if (initial || (!dirty && !saving)) applyForm(result.todo);
    } catch (error) {
      if (workbench.drawer?.kind !== 'edit' || workbench.drawer.todoId !== todoId) return;
      if ((error as { code?: string } | undefined)?.code === 'NOT_FOUND') notFound = true;
      else if (entry === null) loadFailed = true;
      else runsFailed = true;
    } finally {
      loading = false;
    }
  }

  function reset(): void {
    entry = null;
    runs = [];
    runsFailed = false;
    notFound = false;
    loadFailed = false;
    pendingDiscard = null;
    groupMembersOf = {};
    warnings = [];
    formError = null;
    confirmCancel = false;
    memoId = null;
  }

  // 抽屉打开 / 切换事项：重置并载入。
  let shownDrawer: unknown = null;
  $effect(() => {
    const current = drawer;
    if (current === shownDrawer) return;
    shownDrawer = current;
    untrack(() => {
      if (current === null) return;
      const carried = pendingWarnings;
      pendingWarnings = [];
      reset();
      warnings = carried;
      if (current.kind === 'new') {
        applyForm({
          title: current.prefill.title ?? '',
          notes: current.prefill.notes ?? '',
          assignee: current.prefill.assignee ?? null,
          schedule: null,
        });
        memoId = current.prefill.memoId ?? null;
      } else {
        void load(current.todoId, true);
      }
    });
  });

  // 事项数据在别处变了（事件 / 卡片上的操作）：重读；表单没改过就跟着刷新。
  let seenVersion = workbench.todosVersion;
  $effect(() => {
    const version = workbench.todosVersion;
    if (version === seenVersion) return;
    seenVersion = version;
    untrack(() => {
      const current = workbench.drawer;
      if (current?.kind === 'edit') void load(current.todoId, false);
    });
  });

  // 选了群：取成员给「负责 Bot」用（取不到退回会话上的成员预览）。
  $effect(() => {
    const groupId = selectedGroupId;
    if (groupId === null || groupMembersOf[groupId] !== undefined) return;
    untrack(() => void loadGroupMembers(groupId));
  });

  // 群成员变了（会话更新 / Bot 增删）：丢掉缓存的成员名单，选着的群重新取。
  $effect(() => {
    if (drawer === null) return;
    const invalidate = (): void => {
      groupMembersOf = {};
    };
    const offs = [
      core.onEvent('conversation.updated', invalidate),
      core.onEvent('bot.updated', invalidate),
      core.onEvent('bot.deleted', invalidate),
    ];
    return () => offs.forEach((off) => off());
  });

  async function loadGroupMembers(groupId: string): Promise<void> {
    let members: MemberInfo[];
    try {
      const result = (await core.call('conversations.members', { conversationId: groupId })) as {
        members: Array<{ bot: Bot }>;
      };
      members = result.members.map((member) => ({ id: member.bot.id, name: member.bot.name }));
    } catch {
      const previews =
        chat.conversations.find((conversation) => conversation.id === groupId)?.memberPreviews ??
        [];
      members = previews.map((member) => ({ id: member.id, name: member.name }));
    }
    groupMembersOf = { ...groupMembersOf, [groupId]: members };
  }

  $effect(() => {
    if (drawer === null) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.overlay,
      onEscape: () => requestClose(),
    });
  });

  /** 关闭（遮罩 / Esc / 关闭按钮）：表单脏了先确认；确认条开着时 Esc 只收起确认条。 */
  function requestClose(): void {
    if (pendingDiscard !== null) {
      pendingDiscard = null;
      return;
    }
    if (dirty && !saving) {
      pendingDiscard = {
        message: t('workbench.drawer.discardTitle'),
        run: () => workbench.closeDrawer(),
      };
      return;
    }
    workbench.closeDrawer();
  }

  // --- 焦点 -------------------------------------------------------------------
  // 打开时记住触发元素，关闭后还原焦点；打开后焦点进标题框；Tab 在抽屉内循环。
  let opener: HTMLElement | null = null;
  let wasOpen = false;
  let focusedFor: unknown = null;
  $effect(() => {
    const open = drawer !== null;
    untrack(() => {
      if (open && !wasOpen) opener = document.activeElement as HTMLElement | null;
      if (!open && wasOpen) {
        const target = opener;
        opener = null;
        focusedFor = null;
        queueMicrotask(() => {
          if (target?.isConnected) target.focus();
        });
      }
      wasOpen = open;
    });
  });
  $effect(() => {
    const el = titleEl;
    const current = drawer;
    if (el === null || current === null || focusedFor === current) return;
    focusedFor = current;
    el.focus();
  });

  const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || asideEl === null) return;
    const items = [...asideEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0,
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !asideEl.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !asideEl.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  // --- 时间提示 ----------------------------------------------------------------
  const nextText = $derived.by((): string => {
    const draft = whenDraft;
    if (draft.mode === 'none') return t('workbench.drawer.nextNone');
    if (draft.mode === 'now') return t('workbench.drawer.nextNow');
    if (draft.mode === 'once') {
      const at = fromLocalInput(draft.onceLocal);
      return at === null
        ? t('workbench.drawer.nextUnknown')
        : t('workbench.drawer.next', { when: describeAt(at) });
    }
    if (draft.customCron !== null) {
      const schedule = entry?.schedule;
      return schedule?.cron === draft.customCron && schedule.nextFireAt !== null
        ? t('workbench.drawer.next', { when: describeAt(schedule.nextFireAt) })
        : t('workbench.drawer.nextUnknown');
    }
    const at = nextFireOfPreset(draft.preset, Date.now());
    return at === null
      ? t('workbench.drawer.nextUnknown')
      : t('workbench.drawer.next', { when: describeAt(at) });
  });

  const whenValue = $derived(whenFromDraft(whenDraft));
  const whenDirty = $derived(!sameWhen(whenDraft, base.when));
  const fieldsDirty = $derived(
    title !== base.title ||
      notes !== base.notes ||
      assigneeKey !== base.assigneeKey ||
      leadBotId !== base.leadBotId,
  );

  function formValues(): TodoFormValues {
    return {
      title,
      notes,
      assigneeKey,
      leadBotId,
      assignee: assigneeFromForm(),
      when: whenDraft,
    };
  }

  /** 保存前的校验；`omitWhen`：这次保存不带时间（「立即开始」只存其余字段）。 */
  function problemOf(omitWhen: boolean): string | null {
    if (title.trim().length === 0) return t('workbench.drawer.titleRequired');
    if (omitWhen) return null;
    if (whenDraft.mode !== 'none' && assigneeKey === '') return t('workbench.drawer.needAssignee');
    if (whenValue === undefined) return t('workbench.drawer.whenIncomplete');
    // 只在用户改了时间时拦「已过去」；没改的旧时间（比如已过期未触发的）不拦其它字段的保存。
    if (whenDirty && isPastOnce(whenDraft, Date.now())) return t('workbench.drawer.whenPast');
    return null;
  }
  // --- 保存 --------------------------------------------------------------------
  /** 创建后抽屉要从「新建」切到「编辑」，期间把 warnings 带过去。 */
  let pendingWarnings: string[] = [];

  /**
   * 返回 true = 保存成功（或没有改动）。`quiet`：不关抽屉、不 toast（保存后紧接别的操作）；
   * `omitWhen`：不带时间（「立即开始」只存标题 / 说明 / 执行者）。
   */
  async function save(options: { quiet?: boolean; omitWhen?: boolean } = {}): Promise<boolean> {
    const quiet = options.quiet === true;
    const omitWhen = options.omitWhen === true;
    if (saving) return false;
    const blocking = problemOf(omitWhen);
    if (blocking !== null) {
      formError = blocking;
      return false;
    }
    formError = null;
    saving = true;
    try {
      let result: { todo: TodoEntry; warnings: string[] };
      const assignee = assigneeFromForm();
      if (drawer?.kind === 'new') {
        const input: Record<string, unknown> = { title: title.trim() };
        if (notes.trim().length > 0) input.notes = notes;
        if (assignee !== null) input.assignee = assignee;
        // 「立即」也走 create 的 when:'now'（创建即派发）。
        if (!omitWhen && whenValue !== null && whenValue !== undefined) input.when = whenValue;
        if (memoId !== null) input.memoId = memoId;
        result = (await core.call('todos.create', input)) as typeof result;
      } else if (entry !== null) {
        const input = buildUpdateInput(entry.id, base, formValues(), { planLocked, omitWhen });
        if (input === null) {
          if (!quiet) workbench.closeDrawer();
          return true;
        }
        result = (await core.call('todos.update', input)) as typeof result;
      } else {
        return false;
      }
      workbench.upsertTodo(result.todo);
      const created = drawer?.kind === 'new';
      if (result.warnings.length > 0) {
        // 有提示：留在抽屉里给用户看；新建的转成编辑态。
        warnings = result.warnings;
        if (created) {
          pendingWarnings = result.warnings;
          workbench.openTodo(result.todo.id);
        } else {
          entry = result.todo;
          applyForm(result.todo);
        }
        return true;
      }
      if (!quiet) {
        toast.success(t('workbench.drawer.saved'));
        workbench.closeDrawer();
      } else if (created) {
        workbench.openTodo(result.todo.id);
      } else {
        entry = result.todo;
        applyForm(result.todo);
      }
      return true;
    } catch (error) {
      const message = rpcErrorText(error, t('workbench.drawer.saveFailed'));
      if (drawer?.kind === 'new' && whenValue === 'now') {
        // 创建即派发失败：事项已按草案保留（core 的约定）。刷新列表让草案出现，提示原因，
        // 关掉「新建」抽屉——留着再点保存会重复创建。
        void workbench.refreshTodos();
        toast.error(message);
        workbench.closeDrawer();
        return false;
      }
      // 失败也可能已改变事项的状态（如旧排期已取消、退回草案）：刷新让列表与抽屉跟上。
      if (drawer?.kind === 'edit') void workbench.refreshTodos();
      formError = message;
      return false;
    } finally {
      saving = false;
    }
  }

  /** 状态迁移。表单脏了先确认（取消事项本身已有两步确认，不再叠一层）。 */
  async function transition(
    kind: 'complete' | 'cancel' | 'reopen' | 'toDraft',
    confirmed = false,
  ): Promise<void> {
    if (entry === null) return;
    if (!confirmed && dirty && kind !== 'cancel') {
      pendingDiscard = {
        message: t('workbench.drawer.discardTitle'),
        run: () => transition(kind, true),
      };
      return;
    }
    pendingDiscard = null;
    confirmCancel = false;
    const next = await transitionTodo(kind, entry.id);
    if (next === null) return;
    entry = next;
    applyForm(next);
    if (kind === 'complete' || kind === 'cancel') workbench.closeDrawer();
  }

  /**
   * 底部「立即开始」：只保存标题 / 说明 / 执行者，再调 `todos.start`——不带时间草稿，
   * 否则会把「某时」先存成排期、或「立即」派两次。时间草稿有未保存的修改时先确认放弃。
   */
  async function startNow(confirmed = false): Promise<void> {
    if (entry === null) return;
    if (!confirmed && whenDirty) {
      pendingDiscard = {
        message: t('workbench.drawer.discardTimeOnly'),
        run: () => startNow(true),
      };
      return;
    }
    pendingDiscard = null;
    if (fieldsDirty && !(await save({ quiet: true, omitWhen: true }))) return;
    const next = await transitionTodo('start', entry.id);
    if (next === null) return;
    entry = next;
    applyForm(next);
  }

  function onAssigneeChange(value: string): void {
    assigneeKey = value;
    leadBotId = '';
    // 清掉执行者时时间也一并清掉（有时间必有执行者）。
    if (value === '') whenDraft = { ...whenDraft, mode: 'none' };
  }

  function runStatusText(run: TodoRun): string {
    return t(`workbench.run.${run.status}`);
  }
</script>

{#if drawer !== null}
  <div class="absolute inset-0 z-30 flex justify-end" data-testid="todo-drawer-layer">
    <button
      type="button"
      class="absolute inset-0 cursor-default bg-black/20"
      aria-label={t('workbench.drawer.close')}
      onclick={requestClose}
      tabindex="-1"
    ></button>
    <div
      bind:this={asideEl}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      class="relative flex h-full w-full max-w-md flex-col border-l bg-background shadow-xl"
      aria-labelledby="todo-drawer-heading"
      onkeydown={trapTab}
      data-testid="todo-drawer"
      data-todo-id={entry?.id ?? ''}
      data-status={isNew ? 'new' : status}
    >
      <header class="flex items-center gap-2 border-b px-4 py-3">
        <h2 id="todo-drawer-heading" class="min-w-0 flex-1 truncate text-sm font-medium">
          {isNew ? t('workbench.drawer.titleNew') : t('workbench.drawer.titleEdit')}
        </h2>
        {#if !isNew}
          <span class="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {t(`workbench.status.${status}`)}
          </span>
        {/if}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('workbench.drawer.close')}
          onclick={requestClose}
          data-testid="todo-drawer-close"
        >
          <X class="size-4" />
        </Button>
      </header>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {#if notFound}
          <p class="text-sm text-muted-foreground" data-testid="todo-drawer-notfound">
            {t('workbench.drawer.notFound')}
          </p>
        {:else if loading && entry === null && !isNew}
          <p class="text-sm text-muted-foreground">…</p>
        {:else if loadFailed && entry === null && !isNew}
          <div class="space-y-2" data-testid="todo-drawer-load-failed">
            <p class="text-sm text-muted-foreground">{t('workbench.drawer.loadFailed')}</p>
            <Button
              size="sm"
              variant="outline"
              onclick={() => {
                const current = workbench.drawer;
                if (current?.kind === 'edit') void load(current.todoId, true);
              }}
              data-testid="todo-drawer-retry"
            >
              {t('workbench.retry')}
            </Button>
          </div>
        {:else}
          {#if warnings.length > 0}
            {@const problems = warnings.filter((warning) => !isInfoWarning(warning))}
            {@const infos = warnings.filter(isInfoWarning)}
            <div class="space-y-2" role="status" data-testid="todo-warnings">
              {#if problems.length > 0}
                <div
                  class="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                  data-testid="todo-warnings-problems"
                >
                  <p class="mb-1 flex items-center gap-1 font-medium">
                    <CircleAlert class="size-3.5" aria-hidden="true" />{t(
                      'workbench.drawer.warnings',
                    )}
                  </p>
                  <ul class="list-disc space-y-0.5 pl-4">
                    {#each problems as warning, index (index)}
                      <li>{warning}</li>
                    {/each}
                  </ul>
                </div>
              {/if}
              {#if infos.length > 0}
                <ul
                  class="space-y-0.5 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
                  data-testid="todo-warnings-info"
                >
                  {#each infos as note, index (index)}
                    <li>{note}</li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
          {#if entry !== null && blockedNotice(entry) !== null}
            {@const blocked = blockedNotice(entry)!}
            <p
              class="rounded-lg px-3 py-2 text-xs {blocked.kind === 'error'
                ? 'bg-destructive/10 text-destructive'
                : blocked.kind === 'warn'
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'bg-muted/50 text-muted-foreground'}"
              data-testid="todo-drawer-blocked"
              data-blocked-kind={blocked.kind}
            >
              {status === 'draft'
                ? t('workbench.card.blocked', { reason: blocked.reason })
                : blocked.reason}
            </p>
          {/if}
          {#if memoId !== null}
            <p class="text-xs text-muted-foreground" data-testid="todo-drawer-memo">
              {t('workbench.drawer.fromMemo')}
            </p>
          {/if}
          {#if closed}
            <p class="text-xs text-muted-foreground">{t('workbench.drawer.closedLocked')}</p>
          {/if}

          <div class="space-y-1.5">
            <label class="text-xs font-medium" for="todo-title">
              {t('workbench.drawer.fieldTitle')}
            </label>
            <Input
              id="todo-title"
              bind:ref={titleEl}
              bind:value={title}
              maxlength={TODO_TITLE_MAX_CHARS}
              disabled={closed}
              data-testid="todo-title"
            />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium" for="todo-notes">
              {t('workbench.drawer.fieldNotes')}
            </label>
            <Textarea
              id="todo-notes"
              bind:value={notes}
              maxlength={TODO_NOTES_MAX_CHARS}
              disabled={closed}
              rows={4}
              data-testid="todo-notes"
            />
          </div>

          <div class="space-y-1.5">
            <span class="text-xs font-medium">{t('workbench.drawer.fieldAssignee')}</span>
            <Select.Root
              type="single"
              value={assigneeKey === '' ? NONE : assigneeKey}
              onValueChange={(value) => onAssigneeChange(value === NONE ? '' : value)}
              disabled={planLocked}
            >
              <Select.Trigger
                class="w-full"
                aria-label={`${t('workbench.drawer.fieldAssignee')}：${assigneeLabel}`}
                data-testid="todo-assignee"
              >
                {assigneeLabel}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={NONE}>{t('workbench.drawer.assigneeNone')}</Select.Item>
                {#if goneAssignee !== null}
                  <Select.Item value={goneAssignee.key}>
                    {t('workbench.drawer.assigneeGone', { name: goneAssignee.name })}
                  </Select.Item>
                {/if}
                {#if botOptions.length > 0}
                  <Select.Group>
                    <Select.GroupHeading>{t('workbench.drawer.assigneeBots')}</Select.GroupHeading>
                    {#each botOptions as bot (bot.id)}
                      <Select.Item
                        value={`bot:${bot.id}`}
                        data-testid={`todo-assignee-bot-${bot.id}`}
                      >
                        {memberLabel(bot)}
                      </Select.Item>
                    {/each}
                  </Select.Group>
                {/if}
                {#if groupOptions.length > 0}
                  <Select.Group>
                    <Select.GroupHeading>{t('workbench.drawer.assigneeGroups')}</Select.GroupHeading
                    >
                    {#each groupOptions as group (group.id)}
                      <Select.Item
                        value={`group:${group.id}`}
                        data-testid={`todo-assignee-group-${group.id}`}
                      >
                        {group.name}
                      </Select.Item>
                    {/each}
                  </Select.Group>
                {/if}
              </Select.Content>
            </Select.Root>
            {#if selectedGroupId !== null}
              <div class="space-y-1.5 pt-1">
                <span class="text-xs font-medium">{t('workbench.drawer.fieldLead')}</span>
                <Select.Root
                  type="single"
                  value={leadBotId === '' ? NONE : leadBotId}
                  onValueChange={(value) => (leadBotId = value === NONE ? '' : value)}
                  disabled={planLocked}
                >
                  <Select.Trigger
                    class="w-full"
                    aria-label={`${t('workbench.drawer.fieldLead')}：${leadLabel}`}
                    data-testid="todo-lead-bot"
                  >
                    {leadLabel}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value={NONE}>{t('workbench.drawer.leadNone')}</Select.Item>
                    {#each leadOptions as member (member.id)}
                      <Select.Item value={member.id}>{member.name}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}
          </div>

          <div class="space-y-1.5">
            <span class="text-xs font-medium">{t('workbench.drawer.fieldWhen')}</span>
            {#if planLocked}
              <!-- 已开始 / 已结束的事项：时间不可改，只读显示实际情况，不再摆一个选不了的选择器。 -->
              {#if started}
                <p class="text-xs text-muted-foreground">{t('workbench.drawer.whenLocked')}</p>
              {/if}
              <p class="text-sm" data-testid="todo-when-readonly">{lockedWhenText}</p>
            {:else}
              <WhenPicker
                bind:draft={whenDraft}
                disabled={planLocked}
                hasAssignee={assigneeKey !== ''}
                next={nextText}
              />
            {/if}
          </div>

          {#if !isNew}
            <div class="space-y-1.5" data-testid="todo-runs">
              <span class="text-xs font-medium">{t('workbench.drawer.runs')}</span>
              {#if runsFailed}
                <p class="text-xs text-muted-foreground">{t('workbench.drawer.runsFailed')}</p>
              {:else if runs.length === 0}
                <p class="text-xs text-muted-foreground" data-testid="todo-runs-empty">
                  {t('workbench.drawer.runsEmpty')}
                </p>
              {:else}
                <ul class="space-y-1.5">
                  {#each runs as run (run.id)}
                    <li
                      class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs"
                      data-testid="todo-run"
                      data-run-status={run.status}
                    >
                      <span class="text-muted-foreground">{describeAt(run.dispatchedAt)}</span>
                      <span class="min-w-0 flex-1">{runStatusText(run)}</span>
                      <Button
                        size="xs"
                        variant="ghost"
                        onclick={() => void openConversation(run.conversationId)}
                        data-testid="todo-run-open"
                      >
                        {t('workbench.drawer.runOpen')}
                      </Button>
                      {#if run.resultMessageId !== null}
                        <Button
                          size="xs"
                          variant="ghost"
                          onclick={() =>
                            void openConversation(run.conversationId, run.resultMessageId)}
                          data-testid="todo-run-result"
                        >
                          {t('workbench.drawer.runResult')}
                        </Button>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}

          {#if formError !== null}
            <p class="text-xs text-destructive" role="alert" data-testid="todo-form-error">
              {formError}
            </p>
          {/if}
        {/if}
      </div>

      <footer class="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        {#if pendingDiscard !== null}
          <div
            class="flex w-full flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            role="alertdialog"
            aria-label={pendingDiscard.message}
            data-testid="todo-discard"
          >
            <span class="min-w-0 flex-1">{pendingDiscard.message}</span>
            <Button
              size="xs"
              variant="ghost"
              onclick={() => (pendingDiscard = null)}
              data-testid="todo-discard-back"
            >
              {t('workbench.drawer.discardBack')}
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onclick={() => {
                const action = pendingDiscard;
                pendingDiscard = null;
                void action?.run();
              }}
              data-testid="todo-discard-continue"
            >
              {t('workbench.drawer.discardContinue')}
            </Button>
          </div>
        {/if}
        {#if !isNew && entry !== null}
          {#if status === 'draft'}
            {#if whenDraft.mode !== 'now'}
              <Button
                size="sm"
                variant="outline"
                disabled={saving || assigneeKey === ''}
                onclick={() => void startNow()}
                data-testid="todo-drawer-start"
              >
                {t('workbench.action.start')}
              </Button>
            {/if}
          {:else if status === 'scheduled'}
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onclick={() => void transition('toDraft')}
              data-testid="todo-drawer-to-draft"
            >
              {t('workbench.action.toDraft')}
            </Button>
          {:else if status === 'in_progress' || status === 'delivered'}
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onclick={() => void transition('complete')}
              data-testid="todo-drawer-complete"
            >
              {t('workbench.action.complete')}
            </Button>
          {/if}
          {#if status === 'done' || status === 'cancelled'}
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onclick={() => void transition('reopen')}
              data-testid="todo-drawer-reopen"
            >
              {t('workbench.action.reopen')}
            </Button>
          {:else if confirmCancel}
            <Button
              size="sm"
              variant="ghost"
              onclick={() => (confirmCancel = false)}
              data-testid="todo-drawer-cancel-dismiss"
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={saving}
              onclick={() => void transition('cancel')}
              data-testid="todo-drawer-cancel-confirm"
            >
              {t('workbench.action.confirmCancel')}
            </Button>
          {:else}
            <Button
              size="sm"
              variant="ghost"
              class="text-destructive"
              disabled={saving}
              onclick={() => (confirmCancel = true)}
              data-testid="todo-drawer-cancel"
            >
              {t('workbench.action.cancel')}
            </Button>
          {/if}
        {/if}
        <span class="flex-1"></span>
        {#if !closed && (isNew || entry !== null)}
          <Button
            size="sm"
            disabled={saving || (!isNew && !dirty)}
            onclick={() => void save()}
            data-testid="todo-save"
          >
            {t('workbench.drawer.save')}
          </Button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

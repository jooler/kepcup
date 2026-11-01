<script lang="ts">
  import { ChevronDown, ChevronRight, MoreHorizontal } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Input } from '$lib/components/ui/input';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import TodoCard from './TodoCard.svelte';
  import TodoLane from './TodoLane.svelte';
  import {
    botMembers,
    buildLanes,
    closedTodos,
    projectMembers,
    runningBotSet,
  } from './workbench-model';
  import { rpcErrorText } from './todo-actions';
  import { workbench } from './workbench.svelte';
  import type { TodoEntry } from '@kepcup/shared';
  import { TODO_TITLE_MAX_CHARS } from '@kepcup/shared';

  /**
   * 事项栏（D90 §5.2，P0 只有「按成员」视图）：快速新建（回车存为草案）→ 成员道
   * （未指派在前，其后有事的 Bot 与项目组）→ 最近结束。
   *
   * 快速新建的草稿存在 `workbench` store 里（不是组件 `$state`）：切到对话会把工作台
   * 整棵卸载，放组件里切回来就没了（见 workbench.svelte.ts 的字段注释）。
   */
  const bots = $derived(botMembers(contacts.bots));
  // 会话列表每条消息都会换新数组：只取成员签名（项目组 id / 标题、在跑的 Bot），签名不变就不重算分道。
  const SEP = '\u0001';
  const projectSig = $derived(
    projectMembers(chat.conversations)
      .map((project) => `${project.id}${SEP}${project.name}`)
      .join(SEP + SEP),
  );
  const projects = $derived(
    projectSig === ''
      ? []
      : projectSig.split(SEP + SEP).map((entry) => {
          const [id = '', name = ''] = entry.split(SEP);
          return { id, name };
        }),
  );
  const runningSig = $derived([...runningBotSet(chat.conversations)].sort().join(','));
  const running = $derived(new Set(runningSig === '' ? [] : runningSig.split(',')));

  /**
   * 排序方式（设置 `workbenchTodoCustomOrder`）：false = 按开始时间（默认，禁拖拽）；
   * true = 自定义排序（手动拖拽顺序）。点击后的乐观值，store 跟上后清掉。
   * 声明放在 `lanes` 之前：派生值在渲染时才求值，但不要依赖声明顺序。
   */
  let customOrderOverride = $state<boolean | null>(null);
  const customOrder = $derived(
    customOrderOverride !== null
      ? customOrderOverride
      : settingsStore.settings?.workbenchTodoCustomOrder === true,
  );
  let orderBusy = $state(false);
  const lanes = $derived(
    buildLanes({
      todos: workbench.todos,
      schedules: workbench.schedules,
      bots,
      projects,
      customOrder,
    }),
  );
  const closed = $derived(closedTodos(workbench.todos));

  $effect(() => {
    const settings = settingsStore.settings;
    if (settings !== null && customOrderOverride !== null) {
      if (settings.workbenchTodoCustomOrder === customOrderOverride) customOrderOverride = null;
    }
  });

  /**
   * 切换排序方式。只写设置，**不碰 `position`**：切回自定义排序要回到原来的手动顺序。
   * 写入失败（或 core 未落库）时回滚乐观值并提示。
   */
  async function setCustomOrder(next: boolean): Promise<void> {
    if (orderBusy || next === customOrder) return;
    orderBusy = true;
    customOrderOverride = next;
    try {
      const saved = await settingsStore.update({ workbenchTodoCustomOrder: next });
      if (saved.workbenchTodoCustomOrder !== next) {
        customOrderOverride = null;
        toast.error(t('workbench.todos.customOrderFailed'));
      }
    } catch (error) {
      customOrderOverride = null;
      toast.error(rpcErrorText(error, t('workbench.todos.customOrderFailed')));
    } finally {
      orderBusy = false;
    }
  }

  let saving = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let closedOpen = $state(false);

  async function quickAdd(): Promise<void> {
    const title = workbench.todoDraft.trim();
    if (title.length === 0 || saving) return;
    saving = true;
    try {
      const result = (await core.call('todos.create', { title })) as { todo: TodoEntry };
      workbench.upsertTodo(result.todo);
      workbench.todoDraft = '';
    } catch (error) {
      toast.error(rpcErrorText(error, t('workbench.todos.quickAddFailed')));
    } finally {
      saving = false;
      input?.focus();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // 输入法选词时的回车不算提交。
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void quickAdd();
  }
</script>

<div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3" data-testid="todo-pane">
  <!-- 栏头：标题 + 「更多」菜单（宽屏双栏与窄屏 tab 共用这一份，不重复渲染）。 -->
  <div class="flex shrink-0 items-center gap-2 border-b border-border pb-2">
    <h2 class="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
      {t('workbench.todos.title')}
    </h2>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label={t('workbench.todos.more')}
        title={t('workbench.todos.more')}
        data-testid="todo-more-menu"
      >
        <MoreHorizontal class="size-4" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-56">
        <DropdownMenu.CheckboxItem
          checked={customOrder}
          disabled={orderBusy}
          onCheckedChange={(value) => void setCustomOrder(value === true)}
          data-testid="todo-custom-order-toggle"
        >
          {t('workbench.todos.customOrder')}
        </DropdownMenu.CheckboxItem>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  <Input
    bind:ref={input}
    bind:value={workbench.todoDraft}
    maxlength={TODO_TITLE_MAX_CHARS}
    placeholder={t('workbench.todos.quickAddPlaceholder')}
    class="h-9 shrink-0"
    onkeydown={onKeydown}
    data-testid="todo-quick-add"
  />

  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
    {#if lanes.length === 0 && closed.length === 0}
      {#if workbench.loadState === 'loading' || workbench.loadState === 'idle'}
        <p class="py-6 text-center text-sm text-muted-foreground" data-testid="todo-loading">
          {t('workbench.loading')}
        </p>
      {:else if workbench.loadState !== 'error'}
        <p class="py-6 text-center text-sm text-muted-foreground" data-testid="todo-empty">
          {t('workbench.todos.empty')}
        </p>
      {/if}
    {/if}

    {#each lanes as lane (lane.id)}
      <TodoLane
        {lane}
        draggable={customOrder}
        running={lane.kind === 'bot' && running.has(lane.memberId ?? '')}
      />
    {/each}

    {#if closed.length > 0}
      <div data-testid="todo-closed">
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={closedOpen}
          onclick={() => (closedOpen = !closedOpen)}
          data-testid="todo-closed-toggle"
        >
          {#if closedOpen}<ChevronDown class="size-3.5" />{:else}<ChevronRight
              class="size-3.5"
            />{/if}
          {t('workbench.closed.title', { n: closed.length })}
        </button>
        {#if closedOpen}
          <div class="mt-1 flex flex-col gap-2">
            {#each closed as todo (todo.id)}
              <TodoCard {todo} showAssignee />
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

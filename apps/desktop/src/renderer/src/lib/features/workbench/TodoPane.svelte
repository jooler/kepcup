<script lang="ts">
  import { ChevronDown, ChevronRight } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Input } from '$lib/components/ui/input';
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
  const lanes = $derived(
    buildLanes({ todos: workbench.todos, schedules: workbench.schedules, bots, projects }),
  );
  const closed = $derived(closedTodos(workbench.todos));

  let draft = $state('');
  let saving = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let closedOpen = $state(false);

  async function quickAdd(): Promise<void> {
    const title = draft.trim();
    if (title.length === 0 || saving) return;
    saving = true;
    try {
      const result = (await core.call('todos.create', { title })) as { todo: TodoEntry };
      workbench.upsertTodo(result.todo);
      draft = '';
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

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="todo-pane">
  <Input
    bind:ref={input}
    bind:value={draft}
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
      <TodoLane {lane} running={lane.kind === 'bot' && running.has(lane.memberId ?? '')} />
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

<script lang="ts">
  import { ChevronDown, ChevronRight } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Input } from '$lib/components/ui/input';
  import MemberAvatar from './MemberAvatar.svelte';
  import TodoCard from './TodoCard.svelte';
  import TodoLane from './TodoLane.svelte';
  import {
    botMembers,
    buildLanes,
    closedTodos,
    groupMembers,
    idleMembers,
    runningBotSet,
  } from './workbench-model';
  import { workbench } from './workbench.svelte';
  import type { TodoEntry } from '@kepcup/shared';
  import { TODO_TITLE_MAX_CHARS } from '@kepcup/shared';

  /**
   * 事项栏（D90 §5.2，P0 只有「按成员」视图）：快速新建（回车存为草案）→ 成员道
   * （未指派在前，其后有事的 Bot 与群）→ 空闲成员条 → 最近结束。
   */
  const bots = $derived(botMembers(contacts.bots));
  const groups = $derived(groupMembers(chat.conversations));
  const lanes = $derived(
    buildLanes({ todos: workbench.todos, schedules: workbench.schedules, bots, groups }),
  );
  const idle = $derived(
    idleMembers({ todos: workbench.todos, schedules: workbench.schedules, bots, groups }),
  );
  const closed = $derived(closedTodos(workbench.todos));
  const running = $derived(runningBotSet(chat.conversations));

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
      toast.error(
        errorText(
          (error as { code?: string } | undefined)?.code,
          t('workbench.todos.quickAddFailed'),
        ),
      );
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
      <p class="py-6 text-center text-sm text-muted-foreground" data-testid="todo-empty">
        {t('workbench.todos.empty')}
      </p>
    {/if}

    {#each lanes as lane (lane.id)}
      <TodoLane {lane} running={lane.kind === 'bot' && running.has(lane.memberId ?? '')} />
    {/each}

    {#if idle.length > 0}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1" data-testid="todo-idle">
        <span class="text-xs text-muted-foreground">
          {t('workbench.idle.title')}
          <span class="opacity-70">· {t('workbench.idle.hint')}</span>
        </span>
        {#each idle as member (member.id)}
          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1 rounded-full border bg-background py-0.5 pr-2 pl-0.5 text-xs transition-colors hover:bg-accent"
            title={t('workbench.idle.assign', { name: member.name })}
            onclick={() => workbench.newTodo({ assignee: { kind: 'bot', botId: member.id } })}
            data-testid="todo-idle-member"
            data-bot-id={member.id}
          >
            <MemberAvatar kind="bot" id={member.id} name={member.name} class="size-5" />
            {member.name}
            {#if running.has(member.id)}
              <span class="size-1.5 animate-pulse rounded-full bg-emerald-500"></span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

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

<script lang="ts">
  import { ChevronDown, ChevronRight, Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import MemberAvatar from './MemberAvatar.svelte';
  import SelfScheduleCard from './SelfScheduleCard.svelte';
  import TodoCard from './TodoCard.svelte';
  import { describeAt } from './describe';
  import type { WorkbenchLane } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 一条成员道（D90 §5.2）：道头 = 头像 + 名称 + 忙闲（待验收 / 进行中 / 已排期 / 草案计数、
   * 正在执行的圆点、下次时间）；道内先事项卡、后自排卡。点道头折叠。
   * `running`：该 Bot 此刻有 loop 在跑（侧栏 runningBotIds 同源）；群道没有。
   */
  let { lane, running = false }: { lane: WorkbenchLane; running?: boolean } = $props();

  let collapsed = $state(false);

  const counts = $derived(
    (
      [
        ['delivered', lane.counts.delivered],
        ['inProgress', lane.counts.inProgress],
        ['scheduled', lane.counts.scheduled],
        ['draft', lane.counts.draft],
      ] as const
    ).filter(([, n]) => n > 0),
  );
  const title = $derived(lane.kind === 'unassigned' ? t('workbench.lane.unassigned') : lane.name);
  const total = $derived(lane.todos.length + lane.selfSchedules.length);

  function addTodo(): void {
    if (lane.memberId === null) {
      workbench.newTodo();
      return;
    }
    workbench.newTodo({
      assignee:
        lane.kind === 'bot'
          ? { kind: 'bot', botId: lane.memberId }
          : { kind: 'group', conversationId: lane.memberId, leadBotId: null },
    });
  }
</script>

<section
  class="rounded-xl border bg-muted/20"
  data-testid="todo-lane"
  data-lane-id={lane.id}
  data-lane-kind={lane.kind}
>
  <div class="flex items-center gap-2 px-3 py-2">
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
      aria-expanded={!collapsed}
      aria-label={t('workbench.lane.toggleNamed', { name: title })}
      onclick={() => (collapsed = !collapsed)}
      data-testid="todo-lane-toggle"
    >
      {#if collapsed}
        <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {:else}
        <ChevronDown class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      {#if lane.memberId !== null && lane.kind !== 'unassigned'}
        <MemberAvatar kind={lane.kind} id={lane.memberId} name={lane.name} class="size-6" />
      {/if}
      <span class="min-w-0 truncate text-sm font-medium" data-testid="todo-lane-name">{title}</span>
      <span class="shrink-0 text-xs text-muted-foreground" data-testid="todo-lane-total">
        · {total}
      </span>
      {#if running}
        <span
          class="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
          title={t('workbench.lane.running')}
          data-testid="todo-lane-running"
        ></span>
      {/if}
    </button>
    <div
      class="hidden min-w-0 shrink items-center gap-2 text-xs text-muted-foreground sm:flex"
      data-testid="todo-lane-summary"
    >
      {#each counts as [key, n] (key)}
        <span class={key === 'delivered' ? 'text-amber-700 dark:text-amber-400' : ''}>
          {t(`workbench.lane.${key}`, { n })}
        </span>
      {/each}
      {#if lane.nextAt !== null}
        <span class="truncate">{t('workbench.lane.next', { when: describeAt(lane.nextAt) })}</span>
      {/if}
    </div>
    <button
      type="button"
      class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={t('workbench.lane.addTodo', { name: title })}
      title={t('workbench.lane.addTodo', { name: title })}
      onclick={addTodo}
      data-testid="todo-lane-add"
    >
      <Plus class="size-4" aria-hidden="true" />
    </button>
  </div>
  {#if !collapsed}
    <div class="flex flex-col gap-2 px-3 pb-3">
      {#each lane.todos as todo (todo.id)}
        <TodoCard {todo} showAssignee={lane.kind === 'unassigned'} />
      {/each}
      {#each lane.selfSchedules as schedule (schedule.id)}
        <SelfScheduleCard {schedule} />
      {/each}
    </div>
  {/if}
</section>

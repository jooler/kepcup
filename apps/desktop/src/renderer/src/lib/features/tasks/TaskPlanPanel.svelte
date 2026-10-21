<script lang="ts">
  import { Circle, CircleCheck, Loader2 } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import type { TaskPlan } from './task-run-view';

  /**
   * 任务执行过程页的结构化计划（D93 §6.2）：数据来自 run_steps 里最后一个
   * `update_plan` 调用，不新增字段 / RPC；运行中随现有轮询自动更新。
   */
  let { plan }: { plan: TaskPlan } = $props();

  const completed = $derived(plan.plan.filter((entry) => entry.status === 'completed').length);
  const total = $derived(plan.plan.length);
</script>

<details
  class="group rounded-md border bg-muted/20 px-3 py-2"
  open
  data-testid="task-run-plan"
>
  <summary
    class="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium"
  >
    <span class="flex items-center gap-2">
      {t('task.run.plan.title')}
      <span class="text-muted-foreground" data-testid="task-run-plan-count">
        {t('task.run.plan.count', { done: completed, total })}
      </span>
    </span>
    <span class="text-muted-foreground group-open:hidden">{t('task.run.plan.expand')}</span>
    <span class="hidden text-muted-foreground group-open:inline">{t('task.run.plan.collapse')}</span>
  </summary>
  <ol class="mt-2 grid gap-1.5">
    {#each plan.plan as entry, index (index)}
      <li
        class="flex items-start gap-2 text-xs {entry.status === 'in_progress'
          ? 'font-medium text-foreground'
          : entry.status === 'completed'
            ? 'text-muted-foreground'
            : ''}"
        data-testid="task-run-plan-item"
        data-plan-status={entry.status}
      >
        {#if entry.status === 'completed'}
          <CircleCheck class="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
        {:else if entry.status === 'in_progress'}
          <Loader2 class="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        {:else}
          <Circle class="mt-0.5 size-3.5 shrink-0 opacity-50" aria-hidden="true" />
        {/if}
        <span class="min-w-0 whitespace-pre-wrap">{entry.step}</span>
      </li>
    {/each}
  </ol>
  {#if plan.explanation.length > 0}
    <p class="mt-2 text-[11px] text-muted-foreground">{plan.explanation}</p>
  {/if}
</details>

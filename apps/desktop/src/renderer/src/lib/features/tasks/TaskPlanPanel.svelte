<script lang="ts">
  import { Circle, CircleCheck, ListChecks, Loader2 } from '@lucide/svelte';
  import { Popover } from 'bits-ui';
  import { t } from '$lib/i18n';
  import type { TaskPlan } from './task-run-view';

  /**
   * 任务执行过程页的结构化计划（D93 §6.2）：数据来自 run_steps 里最后一个
   * `update_plan` 调用，不新增字段 / RPC；运行中随现有轮询自动更新。
   *
   * 呈现方式是 header 右上角的绿色「任务清单」按钮 + 浮层：清单不再是顶部
   * 固定区块，避免长清单挤压时间线；按钮本身即开关，没有展开 / 收起第二层
   * 交互。浮层用 bits-ui Popover（而不是 dropdown-menu）：内容是只读清单，
   * 不该有 menu item 的聚焦与选中行为。Popover 自带 portal，header 的
   * overflow / 拖拽区都裁不到它。
   */
  let { plan, narrow = false }: { plan: TaskPlan; narrow?: boolean } = $props();

  const completed = $derived(plan.plan.filter((entry) => entry.status === 'completed').length);
  const total = $derived(plan.plan.length);
  const count = $derived(t('task.run.plan.count', { done: completed, total }));
  const label = $derived(`${t('task.run.plan.button')} · ${count}`);
</script>

<Popover.Root>
  <Popover.Trigger
    class="app-no-drag mt-0.5 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-emerald-600/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 focus-visible:ring-2 focus-visible:ring-emerald-600/40 focus-visible:outline-none data-[state=open]:bg-emerald-500/25 dark:text-emerald-400 dark:hover:bg-emerald-400/20 dark:data-[state=open]:bg-emerald-400/25"
    aria-label={label}
    title={label}
    data-testid="task-run-plan-trigger"
  >
    <ListChecks class="size-3.5 shrink-0" aria-hidden="true" />
    {#if !narrow}
      <span class="whitespace-nowrap">{t('task.run.plan.button')}</span>
    {/if}
    <span class="font-mono tabular-nums" data-testid="task-run-plan-trigger-count">
      {completed}/{total}
    </span>
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      class="z-[70] max-h-[60vh] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl"
      side="bottom"
      align="end"
      sideOffset={6}
      collisionPadding={8}
      data-testid="task-run-plan"
    >
      <div class="flex items-center justify-between gap-2 text-xs font-medium">
        <span>{t('task.run.plan.title')}</span>
        <span class="text-muted-foreground" data-testid="task-run-plan-count">{count}</span>
      </div>
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
        <p class="mt-2 border-t pt-2 text-[11px] whitespace-pre-wrap text-muted-foreground">
          {plan.explanation}
        </p>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

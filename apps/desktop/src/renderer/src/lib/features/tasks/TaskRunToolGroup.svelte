<script lang="ts">
  import { ChevronDown, ChevronRight, CircleX, Loader2 } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { toolRowDisplay, type TaskRunEntry } from './task-run-view';
  import TaskRunToolCard from './TaskRunToolCard.svelte';

  /**
   * 连续的工具调用收成一张卡（docs/design/42-task-run-view.md）：组内每行只显示
   * 命令标题（降低亮度），点行展开该次调用的原始命令与结果；失败的调用默认展开。
   */
  let {
    tools,
    active,
  }: { tools: Array<Extract<TaskRunEntry, { kind: 'tool' }>>; active: boolean } = $props();

  let open = $state(true);
  /** Manual per-row overrides; unset rows follow the failed-auto-expand default. */
  let overrides = $state<Record<string, boolean>>({});

  const running = $derived(active && tools.some((tool) => tool.result === null));
  const failedCount = $derived(
    tools.filter((tool) => tool.result !== null && !tool.result.ok).length,
  );

  function isOpen(tool: Extract<TaskRunEntry, { kind: 'tool' }>): boolean {
    return overrides[tool.id] ?? (tool.result !== null && !tool.result.ok);
  }
</script>

<div class="overflow-hidden rounded-xl border bg-background/70" data-testid="task-run-tool-group">
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40"
    aria-expanded={open}
    onclick={() => (open = !open)}
    data-testid="task-run-tool-group-toggle"
  >
    {#if open}
      <ChevronDown class="size-3.5 shrink-0" aria-hidden="true" />
    {:else}
      <ChevronRight class="size-3.5 shrink-0" aria-hidden="true" />
    {/if}
    <span class="min-w-0 flex-1 truncate">{t('task.run.toolGroup', { count: tools.length })}</span>
    {#if failedCount > 0}
      <span class="shrink-0 text-[11px] text-destructive">
        {t('task.run.toolGroupFailed', { count: failedCount })}
      </span>
    {/if}
    {#if running}
      <Loader2 class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
    {/if}
  </button>

  {#if open}
    <div class="border-t" data-testid="task-run-tool-group-body">
      {#each tools as tool (tool.id)}
        {@const row = toolRowDisplay(tool)}
        <div class="border-b last:border-b-0" data-testid="task-run-tool-row">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40"
            aria-expanded={isOpen(tool)}
            onclick={() => (overrides = { ...overrides, [tool.id]: !isOpen(tool) })}
            data-testid="task-run-tool-toggle"
          >
            {#if isOpen(tool)}
              <ChevronDown class="size-3 shrink-0" aria-hidden="true" />
            {:else}
              <ChevronRight class="size-3 shrink-0" aria-hidden="true" />
            {/if}
            <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
              {#if row.actionKey !== null}
                <span class="shrink-0 text-muted-foreground/60">{t(row.actionKey)}</span>
              {:else if row.verb.length > 0}
                <span class="shrink-0 text-muted-foreground/60">{row.verb}</span>
              {/if}
              {#if row.target.length > 0}
                <span
                  class="min-w-0 truncate text-foreground {row.mono ? 'font-mono' : ''}"
                  title={row.target}>{row.target}</span
                >
              {/if}
              {#if row.added !== null && row.added > 0}
                <span class="shrink-0 font-mono text-[10px] text-emerald-600/90">+{row.added}</span>
              {/if}
              {#if row.removed !== null && row.removed > 0}
                <span class="shrink-0 font-mono text-[10px] text-destructive/80"
                  >−{row.removed}</span
                >
              {/if}
            </span>
            {#if tool.result === null}
              {#if active}
                <Loader2 class="size-3 shrink-0 animate-spin" aria-hidden="true" />
              {/if}
            {:else if !tool.result.ok}
              <CircleX class="size-3 shrink-0 text-destructive" aria-hidden="true" />
            {/if}
          </button>
          {#if isOpen(tool)}
            <div class="px-2 pb-2">
              <TaskRunToolCard entry={tool} {active} />
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

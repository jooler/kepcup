<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    CircleCheck,
    CircleSlash,
    CircleX,
    Loader2,
    Wrench,
  } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import {
    formatToolArgs,
    resultPreview,
    toolCallSummary,
    type TaskRunEntry,
  } from './task-run-view';

  /**
   * One tool call of the task execution timeline (docs/design/42-task-run-view.md):
   * a compact row with the call summary and its outcome; expanding shows the
   * full arguments and result. Failed results start expanded.
   */
  let { entry, active }: { entry: Extract<TaskRunEntry, { kind: 'tool' }>; active: boolean } =
    $props();

  let manual = $state<boolean | null>(null);
  const summary = $derived(toolCallSummary(entry));
  const preview = $derived(entry.result !== null ? resultPreview(entry.result.content) : '');
  const expanded = $derived(manual ?? (entry.result !== null && !entry.result.ok));
  const args = $derived(formatToolArgs(entry.args));
</script>

<div class="overflow-hidden rounded-xl border bg-background/70" data-testid="task-run-tool">
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/40"
    aria-expanded={expanded}
    onclick={() => (manual = !expanded)}
    data-testid="task-run-tool-toggle"
  >
    {#if expanded}
      <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    {:else}
      <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    {/if}
    <Wrench class="size-3.5 shrink-0 text-sky-600" aria-hidden="true" />
    <span class="shrink-0 font-mono text-[11px] text-muted-foreground">{entry.name}</span>
    {#if summary.length > 0}
      <span class="min-w-0 flex-1 truncate font-mono text-foreground/80" title={summary}
        >{summary}</span
      >
    {:else}
      <span class="min-w-0 flex-1"></span>
    {/if}
    {#if entry.result === null}
      {#if active}
        <span
          class="flex shrink-0 items-center gap-1 text-muted-foreground"
          data-testid="task-run-tool-running"
        >
          <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
          {t('task.run.runningTool')}
        </span>
      {:else}
        <CircleSlash class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
    {:else if entry.result.ok}
      <span
        class="flex shrink-0 items-center gap-1 text-emerald-600"
        data-testid="task-run-tool-ok"
      >
        <CircleCheck class="size-3.5" aria-hidden="true" />
        {t('task.run.toolOk')}
      </span>
    {:else}
      <span
        class="flex shrink-0 items-center gap-1 text-destructive"
        data-testid="task-run-tool-failed"
      >
        <CircleX class="size-3.5" aria-hidden="true" />
        {t('task.run.toolFailed')}
      </span>
    {/if}
  </button>
  {#if !expanded && preview.length > 0}
    <p class="truncate border-t px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
      {preview}
    </p>
  {/if}
  {#if expanded}
    <div class="space-y-2 border-t px-3 py-2 text-xs" data-testid="task-run-tool-detail">
      {#if args.length > 0}
        <div>
          <p class="mb-1 text-[11px] text-muted-foreground">{t('task.run.args')}</p>
          <pre
            class="max-h-60 overflow-auto rounded-lg bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">{args}</pre>
        </div>
      {/if}
      <div>
        <p class="mb-1 text-[11px] text-muted-foreground">{t('task.run.result')}</p>
        {#if entry.result === null}
          <p class="text-muted-foreground">
            {active ? t('task.run.runningTool') : t('task.run.noResult')}
          </p>
        {:else if entry.result.content.length > 0}
          <pre
            class="max-h-80 overflow-auto rounded-lg bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">{entry
              .result.content}</pre>
        {:else}
          <p class="text-muted-foreground">{t('task.run.noOutput')}</p>
        {/if}
        {#if entry.result?.errorCode !== undefined}
          <p class="mt-1 font-mono text-[11px] text-destructive">{entry.result.errorCode}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>

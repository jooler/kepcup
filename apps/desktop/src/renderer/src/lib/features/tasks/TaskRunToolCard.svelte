<script lang="ts">
  import {
    Check,
    CircleCheck,
    CircleSlash,
    CircleStop,
    CircleX,
    Copy,
    Loader2,
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { toolCommandText, type TaskRunEntry } from './task-run-view';

  /**
   * One tool call expanded inside a tool group (docs/design/42-task-run-view.md):
   * the raw invocation with a hover copy button, and its output underneath.
   * The collapsed one-line row lives in TaskRunToolGroup.
   * 运行中的 shell 命令卡右上角有「停止」：终止当前命令并取消任务
   * （runs.cancel 会经 abort signal 杀掉命令进程树）。
   */
  let {
    entry,
    active,
    taskId,
  }: { entry: Extract<TaskRunEntry, { kind: 'tool' }>; active: boolean; taskId?: string } =
    $props();

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = $state(false);
  const command = $derived(toolCommandText(entry));
  const isShell = $derived(entry.name === 'bash' || entry.name === 'powershell');
  const stoppable = $derived(taskId !== undefined && isShell && entry.result === null && active);

  async function copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard unavailable (permissions / non-secure context): leave the label.
    }
  }

  function codeOf(error: unknown): string | undefined {
    return (error as { code?: string } | undefined)?.code;
  }

  async function stop(): Promise<void> {
    if (taskId === undefined || stopping) return;
    stopping = true;
    try {
      await tasks.cancel(taskId);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
    } finally {
      stopping = false;
    }
  }

  $effect(() => () => {
    if (copyTimer !== null) clearTimeout(copyTimer);
  });
</script>

<div
  class="group/tool relative overflow-hidden rounded-lg border bg-muted/20"
  data-testid="task-run-tool-detail"
>
  <div class="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
    {#if stoppable}
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-destructive/40 bg-background/90 px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        onclick={() => void stop()}
        disabled={stopping}
        aria-label={t('task.run.stop')}
        title={t('task.run.stopHint')}
        data-testid="task-run-tool-stop"
      >
        {#if stopping}
          <Loader2 class="size-3 animate-spin" aria-hidden="true" />
        {:else}
          <CircleStop class="size-3" aria-hidden="true" />
        {/if}
        {t('task.run.stop')}
      </button>
    {/if}
    <button
      type="button"
      class="flex items-center gap-1 rounded-md border bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/tool:opacity-100 hover:text-foreground focus-visible:opacity-100"
      onclick={() => void copyCommand()}
      aria-label={t('task.run.copy')}
      title={copied ? t('task.run.copied') : t('task.run.copy')}
      data-testid="task-run-tool-copy"
    >
      {#if copied}
        <Check class="size-3 text-emerald-600" aria-hidden="true" />
        {t('task.run.copied')}
      {:else}
        <Copy class="size-3" aria-hidden="true" />
        {t('task.run.copy')}
      {/if}
    </button>
  </div>

  <div class="flex items-center gap-2 border-b px-2.5 py-1.5 {stoppable ? 'pr-32' : 'pr-20'}">
    <span class="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
      {entry.name}
    </span>
    {#if entry.result === null}
      {#if active}
        <span class="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 class="size-3 animate-spin" aria-hidden="true" />
          {t('task.run.runningTool')}
        </span>
      {:else}
        <CircleSlash class="size-3 text-muted-foreground" aria-hidden="true" />
      {/if}
    {:else if entry.result.ok}
      <span class="flex items-center gap-1 text-[10px] text-emerald-600">
        <CircleCheck class="size-3" aria-hidden="true" />
        {t('task.run.toolOk')}
      </span>
    {:else}
      <span class="flex items-center gap-1 text-[10px] text-destructive">
        <CircleX class="size-3" aria-hidden="true" />
        {t('task.run.toolFailed')}
      </span>
    {/if}
  </div>

  {#if command.length > 0}
    <div>
      <pre
        class="max-h-60 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{isShell
          ? `$ ${command}`
          : command}</pre>
    </div>
  {:else}
    <p class="px-2.5 py-2 text-[11px] text-muted-foreground">{t('task.run.noArgs')}</p>
  {/if}

  <div class="border-t px-2.5 py-2" data-testid="task-run-tool-result">
    <p class="mb-1 text-[10px] text-muted-foreground">{t('task.run.result')}</p>
    {#if entry.result === null}
      <p class="text-[11px] text-muted-foreground">
        {active ? t('task.run.runningTool') : t('task.run.noResult')}
      </p>
    {:else if entry.result.content.length > 0}
      <pre
        class="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80">{entry
          .result.content}</pre>
    {:else}
      <p class="text-[11px] text-muted-foreground">{t('task.run.noOutput')}</p>
    {/if}
    {#if entry.result?.errorCode !== undefined}
      <p class="mt-1 font-mono text-[11px] text-destructive">{entry.result.errorCode}</p>
    {/if}
  </div>
</div>

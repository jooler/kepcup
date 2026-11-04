<script lang="ts">
  import { Check, CircleCheck, CircleSlash, CircleX, Copy, Loader2 } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { toolCommandText, type TaskRunEntry } from './task-run-view';

  /**
   * One tool call expanded inside a tool group (docs/design/42-task-run-view.md):
   * the raw invocation with a hover copy button, and its output underneath.
   * The collapsed one-line row lives in TaskRunToolGroup.
   */
  let { entry, active }: { entry: Extract<TaskRunEntry, { kind: 'tool' }>; active: boolean } =
    $props();

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  const command = $derived(toolCommandText(entry));
  const isShell = $derived(entry.name === 'bash' || entry.name === 'powershell');

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

  $effect(() => () => {
    if (copyTimer !== null) clearTimeout(copyTimer);
  });
</script>

<div
  class="group/tool relative overflow-hidden rounded-lg border bg-muted/20"
  data-testid="task-run-tool-detail"
>
  <button
    type="button"
    class="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded-md border bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/tool:opacity-100 hover:text-foreground focus-visible:opacity-100"
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

  <div class="flex items-center gap-2 border-b px-2.5 py-1.5 pr-20">
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

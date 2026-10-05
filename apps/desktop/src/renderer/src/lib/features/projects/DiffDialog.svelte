<script lang="ts">
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import type { RunChange } from '@kepcup/shared';

  let { open = $bindable(false), runId }: { open: boolean; runId: string | null } = $props();

  let loading = $state(true);
  let unavailable = $state(false);
  let errorMessage = $state('');
  let change = $state<RunChange | null>(null);
  let hostEl = $state<HTMLDivElement | undefined>();
  /** Set while a viewer is mounted (cleaned up on close / rerender). */
  let cleanup: (() => void) | null = null;
  /** Diff text that arrived before its host element existed. */
  let pendingText = $state<string | null>(null);

  $effect(() => {
    if (open && runId !== null) {
      void load(runId);
    } else if (!open) {
      cleanup?.();
      cleanup = null;
    }
  });

  // The host div only exists after `loading` turned false, so mounting waits
  // for both signals here instead of rendering inside load().
  $effect(() => {
    const text = pendingText;
    if (!open || text === null || hostEl === undefined) return;
    pendingText = null;
    void renderDiff(text);
  });

  async function load(id: string): Promise<void> {
    loading = true;
    unavailable = false;
    errorMessage = '';
    change = null;
    pendingText = null;
    try {
      const result = (await core.call('projects.diff', { runId: id })) as {
        change: RunChange | null;
        diffText: string;
      };
      change = result.change;
      if (result.diffText.trim().length === 0) {
        unavailable = true;
        return;
      }
      pendingText = result.diffText;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      unavailable = true;
    } finally {
      loading = false;
    }
  }

  /**
   * Mounts the unified diff with @pierre/diffs (docs/design/09 白名单):
   * parsePatchFiles → CodeView (virtualized diff items) → render.
   */
  async function renderDiff(diffText: string): Promise<void> {
    try {
      const diffs = await import('@pierre/diffs');
      const patches = diffs.parsePatchFiles(diffText);
      const files = patches.flatMap((patch) => patch.files);
      if (hostEl === undefined || files.length === 0) {
        errorMessage = files.length === 0 ? 'no files parsed from patch' : 'host missing';
        unavailable = true;
        return;
      }
      cleanup?.();
      // @pierre/diffs is an imperative web-component library; the mount target
      // is a plain non-Svelte host div, so direct DOM work here cannot desync
      // the Svelte runtime.
      // eslint-disable-next-line svelte/no-dom-manipulating
      hostEl.innerHTML = '';
      const container = document.createElement('diffs-container');
      container.style.display = 'block';
      container.style.height = '100%';
      // eslint-disable-next-line svelte/no-dom-manipulating
      hostEl.appendChild(container);
      // getSharedHighlighter 的 langs 为预载语言列表（空 = 不预载、按需解析）；
      // 不传 preferredHighlighter = 库默认 'shiki-js' 引擎。此前的写法把
      // highlighter 实例传给了字符串枚举参数（运行时恒按默认引擎处理，
      // 属 @pierre/diffs 1.5.1 的类型误用，行为保持不变）。
      await diffs.getSharedHighlighter({
        themes: ['pierre-light', 'pierre-dark'],
        langs: [],
      });
      const view = new diffs.CodeView({
        theme: { light: 'pierre-light', dark: 'pierre-dark' },
        diffStyle: 'unified',
      });
      view.setup(container);
      view.setItems(files.map((fileDiff, index) => ({ id: `f${index}`, type: 'diff' as const, fileDiff })));
      view.render();
      cleanup = () => {
        view.cleanUp();
        container.remove();
      };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      unavailable = true;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="flex max-h-[85vh] max-w-3xl flex-col" data-testid="diff-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('changes.diffTitle', { runId: runId ?? '' })}</Dialog.Title>
      {#if change !== null && change.revertedAt !== null}
        <Dialog.Description>{t('changes.reverted')}</Dialog.Description>
      {/if}
    </Dialog.Header>
    <div class="min-h-0 flex-1 overflow-auto rounded-md border bg-background" data-testid="diff-body">
      {#if loading}
        <p class="p-4 text-sm text-muted-foreground">…</p>
      {:else if unavailable}
        <p class="p-4 text-sm text-muted-foreground" data-testid="diff-unavailable">
          {t('changes.diffUnavailable')}
          {#if errorMessage.length > 0}
            <span class="block font-mono text-[10px] opacity-70">{errorMessage}</span>
          {/if}
        </p>
      {:else}
        <div bind:this={hostEl} class="min-h-40 text-xs"></div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

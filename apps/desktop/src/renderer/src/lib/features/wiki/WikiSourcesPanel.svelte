<script lang="ts">
  import type { WikiOwner } from '@kepcup/shared';
  import { wikiOwnerKey } from '@kepcup/shared';
  import { Trash2 } from '@lucide/svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { wikiStore } from '$lib/stores/wiki.svelte';
  import {
    formatSourceBytes,
    isValidSourceText,
    isValidSourceUrl,
    sortSourceRows,
    stepSourceDelete,
    WIKI_SOURCE_DELETE_TIMEOUT_MS,
    type PendingWikiSourceDelete,
    type WikiSourceRow,
  } from './wiki-sources-model';

  /**
   * The project wiki's source ledger (D92 T1b WP10 §4 步骤 5): every source
   * with its creator badge, the user-facing add area (URL / pasted text) and
   * deletion — the USER may delete every entry (the RPC actor is the user).
   * Deletions are async: the row shows 「删除中…」 until the wiki_changed
   * reload drops it, or restores with a failure toast after 30 seconds.
   */
  let { owner }: { owner: WikiOwner } = $props();

  let rows = $state<WikiSourceRow[]>([]);
  let loading = $state(false);
  let pendingDelete = $state<PendingWikiSourceDelete | null>(null);
  let urlDraft = $state('');
  let textDraft = $state('');
  let addingUrl = $state(false);
  let addingText = $state(false);
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;

  async function reload(): Promise<void> {
    loading = true;
    try {
      const fresh = sortSourceRows(
        (await wikiStore.sources(owner)).map((source) => ({
          id: source.id,
          fileName: source.fileName,
          bytes: source.bytes,
          createdAt: source.createdAt,
          creator: source.createdBy,
        })),
      );
      rows = fresh;
      const step = stepSourceDelete(pendingDelete, {
        type: 'reloaded',
        presentIds: fresh.map((row) => row.id),
        now: Date.now(),
      });
      applyStep(step);
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
    } finally {
      loading = false;
    }
  }

  function applyStep(step: { pending: PendingWikiSourceDelete | null; outcome: 'confirmed' | 'timeout' | null }): void {
    pendingDelete = step.pending;
    if (step.outcome === 'confirmed') {
      clearTimeout(deleteTimer);
      toast.success(t('wiki.sources.deleted'));
    } else if (step.outcome === 'timeout') {
      clearTimeout(deleteTimer);
      toast.error(t('wiki.actionFailed'));
    }
  }

  function armTimeout(): void {
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      applyStep(stepSourceDelete(pendingDelete, { type: 'timeout', now: Date.now() }));
    }, WIKI_SOURCE_DELETE_TIMEOUT_MS);
  }

  $effect(() => {
    void reload();
    const unsubscribe = core.onEvent('wiki_changed', (payload) => {
      const data = payload as { owner?: { kind: string; id: string } };
      const changed = data.owner;
      if (changed !== undefined && `${changed.kind}:${changed.id}` === wikiOwnerKey(owner)) {
        void reload();
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(deleteTimer);
    };
  });

  async function submitUrl(): Promise<void> {
    if (addingUrl || !isValidSourceUrl(urlDraft)) return;
    addingUrl = true;
    try {
      await wikiStore.addSource(owner, { sourceType: 'url', ref: urlDraft.trim() });
      urlDraft = '';
      toast.success(t('wiki.sources.queued'));
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
    } finally {
      addingUrl = false;
    }
  }

  async function submitText(): Promise<void> {
    if (addingText || !isValidSourceText(textDraft)) return;
    addingText = true;
    try {
      await wikiStore.addSource(owner, { sourceType: 'text', ref: textDraft.trim() });
      textDraft = '';
      toast.success(t('wiki.sources.queued'));
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
    } finally {
      addingText = false;
    }
  }

  async function deleteRow(row: WikiSourceRow): Promise<void> {
    const step = stepSourceDelete(pendingDelete, { type: 'begin', id: row.id, now: Date.now() });
    if (step.pending === pendingDelete) return; // one deletion at a time
    applyStep(step);
    try {
      await wikiStore.deleteSource(owner, row.id);
      armTimeout();
    } catch (error) {
      // The registration itself failed (unknown source, ...) — restore now.
      pendingDelete = null;
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
    }
  }

  function creatorLabel(row: WikiSourceRow): string {
    return row.creator.kind === 'user'
      ? t('wiki.sources.byUser')
      : t('wiki.sources.by', { name: row.creator.name ?? row.creator.id });
  }

  function onUrlKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitUrl();
    }
  }

  function onTextKeydown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitText();
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="wiki-sources-panel">
  <!-- 添加区：网址 + 粘贴文本（仅用户；文件入库走「对 Bot 说」） -->
  <div class="space-y-2">
    <div class="flex gap-1">
      <Input
        placeholder={t('wiki.sources.addUrlPlaceholder')}
        bind:value={urlDraft}
        onkeydown={onUrlKeydown}
        data-testid="wiki-source-add-url"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={addingUrl || !isValidSourceUrl(urlDraft)}
        onclick={() => void submitUrl()}
        data-testid="wiki-source-add-url-submit"
      >
        {t('wiki.sources.addUrl')}
      </Button>
    </div>
    <div class="flex gap-1">
      <Textarea
        rows={3}
        placeholder={t('wiki.sources.addTextPlaceholder')}
        bind:value={textDraft}
        onkeydown={onTextKeydown}
        data-testid="wiki-source-add-text"
      />
      <Button
        size="sm"
        variant="outline"
        class="self-start"
        disabled={addingText || !isValidSourceText(textDraft)}
        onclick={() => void submitText()}
        data-testid="wiki-source-add-text-submit"
      >
        {t('wiki.sources.submit')}
      </Button>
    </div>
  </div>

  {#if loading && rows.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="wiki-sources-loading">…</p>
  {:else if rows.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="wiki-sources-empty">
      {t('wiki.sources.empty')}
    </p>
  {:else}
    <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="wiki-sources-list">
      {#each rows as row (row.id)}
        <li class="rounded-md border p-2 text-sm" data-testid="wiki-source-row-{row.id}">
          <p class="break-words font-medium">{row.fileName}</p>
          <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {#if row.creator.kind === 'bot'}
              <BotAvatar botId={row.creator.id} name={row.creator.name ?? row.creator.id} avatar={null} class="size-4" />
            {/if}
            <span data-testid="wiki-source-creator-{row.id}">{creatorLabel(row)}</span>
            <span>{formatSourceBytes(row.bytes)}</span>
            <span>{new Date(row.createdAt).toLocaleString()}</span>
            {#if pendingDelete?.id === row.id}
              <span class="ml-auto" data-testid="wiki-source-deleting-{row.id}">
                {t('wiki.sources.deleting')}
              </span>
            {:else}
              <Button
                size="sm"
                variant="ghost"
                class="ml-auto h-6 px-2 text-xs text-destructive hover:text-destructive"
                disabled={pendingDelete !== null}
                title={t('wiki.sources.deleteHint')}
                onclick={() => void deleteRow(row)}
                data-testid="wiki-source-delete-{row.id}"
              >
                <Trash2 class="size-3.5" aria-hidden="true" />
                {t('wiki.sources.delete')}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

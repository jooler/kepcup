<script lang="ts">
  import type { WikiHistoryEntry, WikiSearchHit } from '@kepcup/shared';
  import { ArrowLeft, History, Trash2 } from '@lucide/svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { lazyMarkdown } from '$lib/features/chats/markdown-lazy.svelte';
  import { wikiStore } from '$lib/stores/wiki.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  let { botId, active }: { botId: string; active: boolean } = $props();

  /** Search box content; empty string means "not searching" (tree shown). */
  let search = $state('');
  /** Search results of the current query (null = no search running). */
  let hits = $state<WikiSearchHit[] | null>(null);
  let searching = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Opened page content (null = list view). */
  let selected = $state<{ path: string; title: string; content: string } | null>(null);
  let pageLoading = $state(false);

  /** Change history dialog (null = closed). */
  let historyOpen = $state(false);
  let history = $state<WikiHistoryEntry[]>([]);
  let historyLoading = $state(false);
  /** Two-step rollback: the entry awaiting confirmation. */
  let rollbackTarget = $state<WikiHistoryEntry | null>(null);
  let rollingBack = $state(false);

  /** Two-step delete inside the page view (pages/ pages only). */
  let deleteArmed = $state(false);
  let deleting = $state(false);

  // bits-ui keeps inactive tab content mounted (hidden): fetch only while the
  // tab is visible, and refetch on every activation (MemoryTab precedent).
  $effect(() => {
    wikiStore.start();
    if (active) void wikiStore.load(botId, true);
  });

  // P13 任务 7: markdown pipeline loads on first page view (startup cost).
  $effect(() => {
    if (selected !== null) lazyMarkdown.start();
  });

  const pages = $derived(wikiStore.pages);

  function queueSearch(): void {
    clearTimeout(searchTimer);
    const query = search.trim();
    if (query.length === 0) {
      hits = null;
      searching = false;
      return;
    }
    searching = true;
    // wiki.search is a server-side FTS query: debounce instead of per-keystroke.
    searchTimer = setTimeout(() => void runSearch(query), 250);
  }

  async function runSearch(query: string): Promise<void> {
    try {
      const result = await wikiStore.search(botId, query);
      // A newer edit superseded this request; keep its pending result.
      if (query !== search.trim()) return;
      hits = result;
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
    } finally {
      if (query === search.trim()) searching = false;
    }
  }

  async function openPage(path: string): Promise<void> {
    pageLoading = true;
    deleteArmed = false;
    selected = { path, title: '', content: '' };
    try {
      selected = await wikiStore.page(botId, path);
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
      selected = null;
    } finally {
      pageLoading = false;
    }
  }

  /** wiki.deletePage: a NEW commit on the append-only history (recoverable). */
  async function deletePage(): Promise<void> {
    if (selected === null) return;
    deleting = true;
    try {
      await wikiStore.deletePage(botId, selected.path);
      toast.success(t('wiki.deleteDone'));
      deleteArmed = false;
      selected = null;
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
    } finally {
      deleting = false;
    }
  }

  /** A search hit opens the page and returns to the tree on back. */
  function openHit(hit: WikiSearchHit): void {
    search = '';
    hits = null;
    searching = false;
    void openPage(hit.path);
  }

  async function openHistory(): Promise<void> {
    historyOpen = true;
    historyLoading = true;
    rollbackTarget = null;
    try {
      history = await wikiStore.history(botId);
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
      history = [];
    } finally {
      historyLoading = false;
    }
  }

  async function rollback(): Promise<void> {
    const target = rollbackTarget;
    if (target === null) return;
    rollingBack = true;
    try {
      // wiki.rollback records a NEW commit — history grows by one entry.
      await wikiStore.rollback(botId, target.oid);
      toast.success(t('wiki.rollbackDone'));
      rollbackTarget = null;
      history = await wikiStore.history(botId);
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('wiki.actionFailed')));
    } finally {
      rollingBack = false;
    }
  }

  /** e2e-friendly test id: `pages/deploy.md` → `wiki-page-pages-deploy-md`. */
  function slug(path: string): string {
    return path.replaceAll(/[^a-zA-Z0-9]+/g, '-');
  }

  function shortOid(oid: string): string {
    return oid.slice(0, 10);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="wiki-tab">
  <div class="flex items-center justify-between">
    <p class="text-xs text-muted-foreground">{t('wiki.tabHint')}</p>
    <Button size="sm" variant="outline" onclick={() => void openHistory()} data-testid="wiki-history">
      <History class="size-3.5" aria-hidden="true" />
      {t('wiki.history')}
    </Button>
  </div>

  {#if selected}
    <!-- 页面内容：markdown 渲染（与消息气泡同一 Streamdown 先例） -->
    <div class="flex min-h-0 flex-1 flex-col gap-2" data-testid="wiki-page-view">
      <div class="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={() => (selected = null)}
          data-testid="wiki-page-back"
        >
          <ArrowLeft class="size-3.5" aria-hidden="true" />
          {t('wiki.back')}
        </Button>
        {#if selected.path.startsWith('pages/')}
          {#if deleteArmed}
            <span class="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => (deleteArmed = false)}
                data-testid="wiki-page-delete-cancel"
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                class="h-6 px-2 text-xs"
                disabled={deleting}
                onclick={() => void deletePage()}
                data-testid="wiki-page-delete-confirm"
              >
                {t('wiki.deleteConfirm')}
              </Button>
            </span>
          {:else}
            <Button
              size="sm"
              variant="ghost"
              class="ml-auto h-6 px-2 text-xs text-destructive hover:text-destructive"
              onclick={() => (deleteArmed = true)}
              data-testid="wiki-page-delete"
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
              {t('wiki.delete')}
            </Button>
          {/if}
        {/if}
      </div>
      <h3 class="text-sm font-medium" data-testid="wiki-page-title">{selected.title}</h3>
      <div
        class="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm"
        data-testid="wiki-page-content"
      >
        {#if pageLoading}
          <p class="text-muted-foreground">…</p>
        {:else if lazyMarkdown.component}
          {@const Markdown = lazyMarkdown.component}
          <Markdown content={selected.content} />
        {:else}
          <div class="whitespace-pre-wrap">{selected.content}</div>
        {/if}
      </div>
    </div>
  {:else}
    <Input
      placeholder={t('wiki.searchPlaceholder')}
      bind:value={search}
      oninput={() => queueSearch()}
      data-testid="wiki-search"
    />
    {#if hits !== null || searching}
      <!-- 搜索结果（wiki.search：FTS 全文检索） -->
      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="wiki-search-results">
        {#if hits !== null && hits.length === 0}
          <p class="text-sm text-muted-foreground" data-testid="wiki-search-empty">
            {t('wiki.searchEmpty')}
          </p>
        {:else}
          {#each hits ?? [] as hit (hit.path)}
            <button
              class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
              onclick={() => openHit(hit)}
              data-testid={`wiki-search-hit-${slug(hit.path)}`}
              data-hit-path={hit.path}
            >
              <p class="font-medium">{hit.title}</p>
              <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</p>
            </button>
          {/each}
        {/if}
      </div>
    {:else if wikiStore.loading && pages.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="wiki-loading">…</p>
    {:else if pages.length === 0}
      <!-- 页面树（wiki.tree）为空：Bot 还没有整理过任何资料 -->
      <p class="text-sm text-muted-foreground" data-testid="wiki-empty">{t('wiki.empty')}</p>
    {:else}
      <!-- 页面树（wiki.tree：pages/ 下的页面）+ 目录入口 -->
      <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="wiki-tree">
        <li>
          <button
            class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
            onclick={() => void openPage('index.md')}
            data-testid="wiki-page-index"
            data-page-path="index.md"
          >
            <p class="font-medium">{t('wiki.index')}</p>
            <p class="text-xs text-muted-foreground">index.md</p>
          </button>
        </li>
        {#each pages as page (page.path)}
          <li>
            <button
              class="w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50"
              onclick={() => void openPage(page.path)}
              data-testid={`wiki-page-${slug(page.path)}`}
              data-page-path={page.path}
            >
              <p class="font-medium">{page.title}</p>
              <p class="text-xs text-muted-foreground">{page.path}</p>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<!-- 变更历史 + 回滚（回滚为新提交，不改写历史——历史列表会多一条） -->
<Dialog
  bind:open={historyOpen}
  onOpenChange={(value) => {
    if (!value) rollbackTarget = null;
  }}
>
  <DialogContent class="flex max-h-[80vh] max-w-lg flex-col" data-testid="wiki-history-dialog">
    <DialogHeader>
      <DialogTitle>{t('wiki.historyTitle')}</DialogTitle>
      <DialogDescription>{t('wiki.historyHint')}</DialogDescription>
    </DialogHeader>
    <div class="min-h-0 flex-1 overflow-auto" data-testid="wiki-history-body">
      {#if historyLoading}
        <p class="text-sm text-muted-foreground">…</p>
      {:else if history.length === 0}
        <p class="text-sm text-muted-foreground" data-testid="wiki-history-empty">
          {t('wiki.historyEmpty')}
        </p>
      {:else}
        <ul class="space-y-2">
          {#each history as entry (entry.oid)}
            <li class="rounded-md border p-2 text-sm" data-testid={`wiki-history-item-${entry.oid}`}>
              <p class="break-words" data-testid="wiki-history-message">{entry.message}</p>
              <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <code data-testid="wiki-history-oid">{shortOid(entry.oid)}</code>
                <span>{new Date(entry.createdAt).toLocaleString()}</span>
                {#if rollbackTarget?.oid === entry.oid}
                  <span class="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-6 px-2 text-xs"
                      onclick={() => (rollbackTarget = null)}
                      data-testid="wiki-rollback-cancel"
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      class="h-6 px-2 text-xs"
                      disabled={rollingBack}
                      onclick={() => void rollback()}
                      data-testid="wiki-rollback-confirm"
                    >
                      {t('wiki.rollbackConfirm')}
                    </Button>
                  </span>
                {:else}
                  <Button
                    size="sm"
                    variant="ghost"
                    class="ml-auto h-6 px-2 text-xs"
                    onclick={() => (rollbackTarget = entry)}
                    data-testid={`wiki-rollback-${entry.oid}`}
                  >
                    {t('wiki.rollback')}
                  </Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <DialogFooter>
      <Button variant="outline" onclick={() => (historyOpen = false)} data-testid="wiki-history-close">
        {t('common.close')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

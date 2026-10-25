<script lang="ts">
  /**
   * 记忆 Tab：分类目录菜单（docs/design/04-memory.md「私有层」：大分类 → kind
   * 小分类）逐层下钻，没有下级分类的叶子才展示条目；叶子内有效条目在上、
   * 「已过时」折叠区在下（折叠只是展开收起，不是再一层菜单）。下钻位置存在
   * memoryNav（与右栏 DetailHeader 的面包屑共享）；搜索时忽略菜单层级，跨
   * 分类平铺结果。
   */
  import type { MemoryEvidence, MemoryItem } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { ChevronRight } from '@lucide/svelte';
  import { memoryStore } from '$lib/stores/memory.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Badge } from '$lib/components/ui/badge';
  import { Textarea } from '$lib/components/ui/textarea';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import {
    CATEGORY_TREE,
    KIND_KEYS,
    OTHER_NODE,
    findNode,
    memoryNav,
    nodeEntries,
    type MemoryCategoryNode,
  } from './memory-categories.svelte';

  let { botId, active }: { botId: string; active: boolean } = $props();

  const STATUS_KEYS: Record<MemoryItem['status'], MessageKey> = {
    active: 'memory.status.active',
    superseded: 'memory.status.superseded',
    retracted: 'memory.status.retracted',
    void: 'memory.status.void',
  };

  let search = $state('');
  let outdatedOpen = $state(false);
  let editingId = $state<string | null>(null);
  let editText = $state('');
  let confirmTarget = $state<MemoryItem | null>(null);
  let deleteDialogOpen = $state(false);
  let deleting = $state(false);
  /** Item ids whose evidence conversation turned out to be deleted. */
  let deletedEvidence = $state<Record<string, boolean>>({});

  // bits-ui keeps inactive tab content mounted (hidden): fetch only while the
  // tab is visible, and refetch on every activation so the list is never a
  // stale hidden-mount snapshot.
  $effect(() => {
    if (active) void memoryStore.load(botId, true);
  });

  // 离开记忆详情即归位顶层目录（面包屑状态不跨 Bot / 跨下次打开残留）。
  $effect(() => {
    return () => memoryNav.reset();
  });

  // 任何下钻跳转（菜单或面包屑）都收起「已过时」折叠区。
  $effect(() => {
    void memoryNav.id;
    outdatedOpen = false;
  });

  const items = $derived(memoryStore.items);
  const searching = $derived(search.trim().length > 0);
  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return items;
    return items.filter((item) => item.content.toLowerCase().includes(needle));
  });

  /** 当前层级要展示的子分类：没有任何条目的分类不进菜单。 */
  const visibleNodes = $derived.by(() => {
    const pool =
      memoryNav.id === null ? [...CATEGORY_TREE, OTHER_NODE] : (findNode(memoryNav.id)?.children ?? []);
    return pool.filter((node) => nodeEntries(node, items).length > 0);
  });
  const selectedNode = $derived(memoryNav.id === null ? null : findNode(memoryNav.id));
  const leafEntries = $derived.by(() => {
    if (selectedNode === null || selectedNode.children.length > 0) return [];
    return nodeEntries(selectedNode, items);
  });
  const activeEntries = $derived(leafEntries.filter((item) => item.status === 'active'));
  const outdatedEntries = $derived(leafEntries.filter((item) => item.status !== 'active'));

  /** One jump link per distinct message: several evidence entries may cite the same one. */
  function evidenceLinks(item: MemoryItem): MemoryEvidence[] {
    const seen: string[] = [];
    const links: MemoryEvidence[] = [];
    for (const entry of item.evidence) {
      if (entry.messageId === null || entry.conversationId === null) continue;
      if (seen.includes(entry.messageId)) continue;
      seen.push(entry.messageId);
      links.push(entry);
    }
    return links;
  }

  function startEdit(item: MemoryItem): void {
    editingId = item.id;
    editText = item.content;
  }

  async function saveEdit(item: MemoryItem): Promise<void> {
    const content = editText.trim();
    if (content.length === 0) {
      toast.error(t('memory.contentRequired'));
      return;
    }
    try {
      await memoryStore.update(botId, item.id, { content });
      editingId = null;
      toast.success(t('memory.saved'));
    } catch {
      toast.error(t('common.actionFailed'));
    }
  }

  async function remove(): Promise<void> {
    const target = confirmTarget;
    if (target === null) return;
    deleting = true;
    try {
      await memoryStore.retract(botId, target.id);
      toast.success(t('memory.deleted'));
      deleteDialogOpen = false;
      confirmTarget = null;
    } catch {
      toast.error(t('common.actionFailed'));
    } finally {
      deleting = false;
    }
  }

  /** Jump to the evidence message; report when its conversation is gone. */
  async function viewEvidence(
    item: MemoryItem,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const ok = await chat.jumpToMessage(conversationId, messageId);
    if (!ok) {
      deletedEvidence = { ...deletedEvidence, [item.id]: true };
      toast.error(t('memory.evidenceDeleted'));
    }
  }
</script>

{#snippet menuRow(node: MemoryCategoryNode)}
  <li class="border-b last:border-b-0">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
      onclick={() => memoryNav.select(node.id)}
      data-testid={`memory-menu-${node.id}`}
    >
      <span class="flex-1">{t(node.labelKey)}</span>
      <span class="tabular-nums text-xs text-muted-foreground">
        {nodeEntries(node, items).length}
      </span>
      <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  </li>
{/snippet}

{#snippet memoryRow(item: MemoryItem, showKind: boolean)}
  {@const inactive = item.status !== 'active'}
  <li
    class="rounded-md border p-2 text-sm {inactive ? 'opacity-60' : ''}"
    data-testid={`memory-item-${item.id}`}
    data-memory-kind={item.kind}
    data-memory-status={item.status}
  >
    {#if editingId === item.id}
      <Textarea bind:value={editText} rows={3} data-testid="memory-edit-input" />
      <div class="mt-1 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onclick={() => (editingId = null)}
          data-testid="memory-edit-cancel"
        >
          {t('common.cancel')}
        </Button>
        <Button size="sm" onclick={() => void saveEdit(item)} data-testid="memory-edit-save">
          {t('common.save')}
        </Button>
      </div>
    {:else}
      <p class="break-words whitespace-pre-wrap" data-testid="memory-item-content">
        {item.content}
      </p>
      <div
        class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      >
        {#if showKind}
          <span data-testid="memory-item-kind">{t(KIND_KEYS[item.kind])}</span>
        {/if}
        {#if inactive}
          <Badge variant="outline" data-testid="memory-item-status"
            >{t(STATUS_KEYS[item.status])}</Badge
          >
        {/if}
        {#if item.dueAt !== null}
          <span data-testid="memory-item-due">{new Date(item.dueAt).toLocaleDateString()}</span>
        {/if}
      </div>
      {#if deletedEvidence[item.id]}
        <p class="mt-1 text-xs text-muted-foreground italic" data-testid="memory-evidence-deleted">
          {t('memory.evidenceDeleted')}
        </p>
      {/if}
      {#if !inactive}
        {@const links = evidenceLinks(item)}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          {#if links.length > 0}
            <span class="text-xs text-muted-foreground">{t('memory.viewEvidence')}</span>
            {#each links as evidence, index (evidence.messageId)}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() =>
                  void viewEvidence(item, evidence.conversationId!, evidence.messageId!)}
                data-testid={`memory-evidence-${item.id}`}
                data-message-id={evidence.messageId}
                title={`${t('memory.viewEvidence')} ${index + 1}`}
              >
                {index + 1}
              </Button>
            {/each}
          {/if}
          <div class="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              class="h-6 px-2 text-xs"
              onclick={() => startEdit(item)}
              data-testid={`memory-edit-${item.id}`}
            >
              {t('common.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              class="h-6 px-2 text-xs text-destructive"
              onclick={() => {
                confirmTarget = item;
                deleteDialogOpen = true;
              }}
              data-testid={`memory-delete-${item.id}`}
            >
              {t('common.delete')}
            </Button>
          </div>
        </div>
      {/if}
    {/if}
  </li>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="memory-tab">
  <Input
    placeholder={t('memory.searchPlaceholder')}
    bind:value={search}
    data-testid="memory-search"
  />

  {#if memoryStore.loading && items.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="memory-loading">…</p>
  {:else if items.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="memory-empty">{t('memory.empty')}</p>
  {:else if searching}
    <!-- 搜索跨分类平铺：每行带上所属小分类，忽略菜单选中状态。 -->
    {#if filtered.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="memory-search-empty">
        {t('memory.searchEmpty')}
      </p>
    {:else}
      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        <ul class="space-y-2">
          {#each filtered as item (item.id)}
            {@render memoryRow(item, true)}
          {/each}
        </ul>
      </div>
    {/if}
  {:else if selectedNode === null}
    <div class="min-h-0 flex-1 overflow-y-auto pr-1">
      <ul class="overflow-hidden rounded-md border" data-testid="memory-menu">
        {#each visibleNodes as node (node.id)}
          {@render menuRow(node)}
        {/each}
      </ul>
    </div>
  {:else if selectedNode.children.length > 0}
    <div
      class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
      data-testid={`memory-detail-${selectedNode.id}`}
    >
      {#if visibleNodes.length === 0}
        <p class="text-sm text-muted-foreground" data-testid="memory-category-empty">
          {t('memory.categoryEmpty')}
        </p>
      {:else}
        <ul class="overflow-hidden rounded-md border" data-testid="memory-submenu">
          {#each visibleNodes as node (node.id)}
            {@render menuRow(node)}
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <div
      class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
      data-testid={`memory-detail-${selectedNode.id}`}
    >
      {#if leafEntries.length === 0}
        <p class="text-sm text-muted-foreground" data-testid="memory-category-empty">
          {t('memory.categoryEmpty')}
        </p>
      {:else}
        {#if activeEntries.length > 0}
          <ul class="space-y-2">
            {#each activeEntries as item (item.id)}
              {@render memoryRow(item, false)}
            {/each}
          </ul>
        {/if}
        {#if outdatedEntries.length > 0}
          <div class="space-y-2">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              onclick={() => (outdatedOpen = !outdatedOpen)}
              data-testid="memory-outdated-toggle"
            >
              <ChevronRight
                class="size-3.5 shrink-0 transition-transform {outdatedOpen ? 'rotate-90' : ''}"
                aria-hidden="true"
              />
              {t('memory.status.superseded')}
              <span class="tabular-nums">({outdatedEntries.length})</span>
            </button>
            {#if outdatedOpen}
              <ul class="space-y-2" data-testid="memory-outdated-section">
                {#each outdatedEntries as item (item.id)}
                  {@render memoryRow(item, false)}
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<Dialog bind:open={deleteDialogOpen}>
  <DialogContent data-testid="memory-delete-dialog">
    <DialogHeader>
      <DialogTitle>{t('memory.deleteTitle')}</DialogTitle>
      <DialogDescription>{t('memory.deleteBody')}</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={() => (deleteDialogOpen = false)}
        >{t('common.cancel')}</Button
      >
      <Button
        variant="destructive"
        disabled={deleting}
        onclick={() => void remove()}
        data-testid="memory-delete-confirm"
      >
        {t('common.delete')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

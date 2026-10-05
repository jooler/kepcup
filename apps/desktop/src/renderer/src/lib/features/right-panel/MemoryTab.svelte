<script lang="ts">
  import type { MemoryItem, MemoryKind } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { memoryStore } from '$lib/stores/memory.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Textarea } from '$lib/components/ui/textarea';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  let { botId, active }: { botId: string; active: boolean } = $props();

  const KIND_ORDER: MemoryKind[] = [
    'commitment',
    'fact',
    'preference',
    'feedback',
    'episode',
    'lesson',
    'self_note',
  ];
  const KIND_KEYS: Record<MemoryKind, MessageKey> = {
    commitment: 'memory.kind.commitment',
    fact: 'memory.kind.fact',
    preference: 'memory.kind.preference',
    feedback: 'memory.kind.feedback',
    episode: 'memory.kind.episode',
    lesson: 'memory.kind.lesson',
    self_note: 'memory.kind.self_note',
  };
  const STATUS_KEYS: Record<MemoryItem['status'], MessageKey> = {
    active: 'memory.status.active',
    superseded: 'memory.status.superseded',
    retracted: 'memory.status.retracted',
    void: 'memory.status.void',
  };

  let search = $state('');
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

  const items = $derived(memoryStore.items);
  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return items;
    return items.filter((item) => item.content.toLowerCase().includes(needle));
  });
  const groups = $derived.by(() => {
    return KIND_ORDER.map((kind) => ({
      kind,
      label: t(KIND_KEYS[kind]),
      entries: filtered.filter((item) => item.kind === kind),
    })).filter((group) => group.entries.length > 0);
  });

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

  async function togglePrivate(item: MemoryItem, value: boolean): Promise<void> {
    try {
      await memoryStore.update(botId, item.id, { privateToBot: value });
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
  async function viewEvidence(item: MemoryItem, conversationId: string, messageId: string): Promise<void> {
    const ok = await chat.jumpToMessage(conversationId, messageId);
    if (!ok) {
      deletedEvidence = { ...deletedEvidence, [item.id]: true };
      toast.error(t('memory.evidenceDeleted'));
    }
  }
</script>

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
  {:else if groups.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="memory-search-empty">
      {t('memory.searchEmpty')}
    </p>
  {:else}
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      {#each groups as group (group.kind)}
        <section class="space-y-2">
          <h4 class="text-xs font-medium text-muted-foreground">
            {group.label}
            <span class="tabular-nums">({group.entries.length})</span>
          </h4>
          <ul class="space-y-2">
            {#each group.entries as item (item.id)}
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
                    <Button size="sm" variant="ghost" onclick={() => (editingId = null)} data-testid="memory-edit-cancel">
                      {t('common.cancel')}
                    </Button>
                    <Button size="sm" onclick={() => void saveEdit(item)} data-testid="memory-edit-save">
                      {t('common.save')}
                    </Button>
                  </div>
                {:else}
                  <p class="whitespace-pre-wrap break-words" data-testid="memory-item-content">{item.content}</p>
                  <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {#if inactive}
                      <Badge variant="outline" data-testid="memory-item-status">{t(STATUS_KEYS[item.status])}</Badge>
                    {/if}
                    {#if item.privateToBot}
                      <Badge variant="secondary" data-testid="memory-item-private">{t('memory.privateBadge')}</Badge>
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
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                      <label class="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid={`memory-private-label-${item.id}`}>
                        <Checkbox
                          checked={item.privateToBot}
                          onCheckedChange={(value) => void togglePrivate(item, value === true)}
                          data-testid={`memory-private-${item.id}`}
                        />
                        {t('memory.privateToggle')}
                      </label>
                      {#each item.evidence.filter((e) => e.messageId !== null && e.conversationId !== null) as evidence, index (evidence.messageId ?? index)}
                        <Button
                          size="sm"
                          variant="ghost"
                          class="h-6 px-2 text-xs"
                          onclick={() => void viewEvidence(item, evidence.conversationId!, evidence.messageId!)}
                          data-testid={`memory-evidence-${item.id}`}
                          data-message-id={evidence.messageId}
                        >
                          {t('memory.viewEvidence')}
                        </Button>
                      {/each}
                      <div class="ml-auto flex gap-1">
                        <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" onclick={() => startEdit(item)} data-testid={`memory-edit-${item.id}`}>
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
            {/each}
          </ul>
        </section>
      {/each}
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
      <Button variant="outline" onclick={() => (deleteDialogOpen = false)}>{t('common.cancel')}</Button>
      <Button variant="destructive" disabled={deleting} onclick={() => void remove()} data-testid="memory-delete-confirm">
        {t('common.delete')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<script lang="ts">
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * Danger zone card of the project details page (D92 §11.3): two-step delete
   * with the wiki inventory preview (D92 T1b WP10).
   */
  let { conversationId }: { conversationId: string } = $props();

  let confirmDelete = $state(false);
  let deleting = $state(false);
  /** Wiki inventory of the project (null = not fetched / hidden). */
  let wikiCounts = $state<{ sources: number; pages: number } | null>(null);

  // Expanding the confirmation loads the counts in parallel; collapsing resets
  // them so reopening refetches (sources may have changed meanwhile).
  $effect(() => {
    if (!confirmDelete) {
      wikiCounts = null;
      return;
    }
    const id = conversationId;
    void (async () => {
      try {
        const [sourcesResult, treeResult] = await Promise.all([
          core.call('wiki.sources', { owner: { kind: 'project', id } }),
          core.call('wiki.tree', { owner: { kind: 'project', id } }),
        ]);
        wikiCounts = {
          sources: (sourcesResult as { sources: unknown[] }).sources.length,
          pages: (treeResult as { pages: unknown[] }).pages.length,
        };
      } catch {
        wikiCounts = null;
      }
    })();
  });

  async function deleteProject(): Promise<void> {
    if (deleting) return;
    deleting = true;
    try {
      // The store's close() clears current; the view invariant folds the
      // shell back to the conversation list.
      await chat.deleteConversation(conversationId);
    } finally {
      deleting = false;
    }
  }
</script>

<div class="space-y-2">
  <p class="text-sm font-medium text-destructive">{t('projectSettings.dangerTitle')}</p>
  {#if !confirmDelete}
    <Button
      variant="ghost"
      class="text-destructive hover:bg-destructive/10"
      onclick={() => (confirmDelete = true)}
      data-testid="project-delete-begin"
    >
      {t('projectSettings.delete')}
    </Button>
  {:else}
    <div
      class="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
      data-testid="project-delete-confirm-box"
    >
      <p class="text-xs text-muted-foreground">{t('projectSettings.deleteBody')}</p>
      {#if wikiCounts !== null && (wikiCounts.sources > 0 || wikiCounts.pages > 0)}
        <p class="text-xs text-muted-foreground" data-testid="project-delete-wiki-count">
          {t('projectSettings.deleteWikiCount', {
            sources: wikiCounts.sources,
            pages: wikiCounts.pages,
          })}
        </p>
      {/if}
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" onclick={() => (confirmDelete = false)}>
          {t('projectSettings.cancel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={deleting}
          onclick={() => void deleteProject()}
          data-testid="project-delete-confirm"
        >
          {t('projectSettings.deleteConfirm')}
        </Button>
      </div>
    </div>
  {/if}
</div>

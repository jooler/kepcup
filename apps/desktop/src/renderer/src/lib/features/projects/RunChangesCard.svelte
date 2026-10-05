<script lang="ts">
  import { FilePlus2, FilePen, FileX2, GitCompare, Undo2 } from '@lucide/svelte';
  import type { RunChange } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import DiffDialog from './DiffDialog.svelte';

  let { runId }: { runId: string } = $props();

  let change = $state<RunChange | null>(null);
  let diffOpen = $state(false);
  let conflictOpen = $state(false);
  let conflicts = $state<string[]>([]);
  let reverting = $state(false);

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    try {
      const result = (await core.call('projects.diff', { runId })) as { change: RunChange | null };
      change = result.change;
    } catch {
      change = null;
    }
  }

  async function revert(force: boolean): Promise<void> {
    reverting = true;
    try {
      const result = (await core.call('projects.revert', { runId, force })) as {
        ok: boolean;
        conflicts: string[];
        reverted: string[];
      };
      if (!result.ok) {
        conflicts = result.conflicts;
        conflictOpen = true;
        return;
      }
      toast.success(t('changes.reverted'));
      conflictOpen = false;
      await load();
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
    } finally {
      reverting = false;
    }
  }

  function codeOf(error: unknown): string | undefined {
    return (error as { code?: string } | undefined)?.code;
  }

  const badgeOf = (changeType: 'added' | 'modified' | 'deleted') =>
    changeType === 'added' ? t('changes.added') : changeType === 'modified' ? t('changes.modified') : t('changes.deleted');
</script>

{#if change !== null && change.files.length > 0 && change.revertedAt === null}
  <div class="w-full max-w-[85%] p-3 text-sm" data-testid="run-changes-card" data-run-id={runId}>
    <div class="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <GitCompare class="size-3.5" aria-hidden="true" />
      <span>{t('changes.title')}</span>
    </div>
    <ul class="mb-2 space-y-1" data-testid="run-changes-files">
      {#each change.files as file (file.path)}
        <li class="flex items-center gap-2 text-xs">
          {#if file.change === 'added'}
            <FilePlus2 class="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          {:else if file.change === 'deleted'}
            <FileX2 class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          {:else}
            <FilePen class="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          {/if}
          <code class="min-w-0 flex-1 truncate">{file.path}</code>
          <Badge variant="outline" class="shrink-0 text-[10px]">{badgeOf(file.change)}</Badge>
        </li>
      {/each}
    </ul>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => (diffOpen = true)} data-testid="run-changes-diff">
        <GitCompare class="size-3.5" aria-hidden="true" />
        {t('changes.viewDiff')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="h-7 px-2 text-xs"
        disabled={reverting}
        onclick={() => void revert(false)}
        data-testid="run-changes-revert"
      >
        <Undo2 class="size-3.5" aria-hidden="true" />
        {t('changes.revert')}
      </Button>
    </div>
  </div>
{/if}

<DiffDialog bind:open={diffOpen} runId={runId} />

<Dialog.Root bind:open={conflictOpen}>
  <Dialog.Content class="max-w-md" data-testid="revert-conflict-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('changes.revertConflictTitle')}</Dialog.Title>
      <Dialog.Description>
        {t('changes.revertConflictBody', { files: conflicts.join('、') })}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="gap-2">
      <Button variant="outline" size="sm" onclick={() => (conflictOpen = false)}>
        {t('contacts.cancel')}
      </Button>
      <Button variant="destructive" size="sm" disabled={reverting} onclick={() => void revert(true)} data-testid="revert-force">
        {t('changes.revertForce')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<script lang="ts">
  import type { Grant } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat, type ProjectMemberView } from '$lib/stores/chat.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * Grants card of the project details page (D92 §11.3): grouped per bot,
   * revoking stays one step away (a security control).
   */
  let { members }: { members: ProjectMemberView[] } = $props();

  const grants = $derived(permissions.grants);
  const grantGroups = $derived.by(() => {
    const groups: Array<{ botId: string; list: Grant[] }> = [];
    for (const grant of grants) {
      const entry = groups.find((group) => group.botId === grant.botId);
      if (entry) entry.list.push(grant);
      else groups.push({ botId: grant.botId, list: [grant] });
    }
    return groups;
  });

  function botName(botId: string): string {
    return members.find((m) => m.bot.id === botId)?.bot.name ?? chat.botName(botId);
  }
</script>

<div class="space-y-2">
  <p class="text-sm font-medium">{t('projectSettings.grantsTitle')}</p>
  {#if grants.length === 0}
    <p class="text-muted-foreground" data-testid="project-grants-empty">
      {t('projectSettings.grantsEmpty')}
    </p>
  {:else}
    <ul class="space-y-2" data-testid="project-grants-list">
      {#each grantGroups as group (group.botId)}
        <li class="rounded-md border p-2">
          <p class="text-xs font-medium">{botName(group.botId)}</p>
          {#each group.list as grant (grant.id)}
            <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <code class="min-w-0 flex-1 truncate">{grant.path}</code>
              <span>
                {t(
                  grant.access === 'write'
                    ? 'projectSettings.grantWrite'
                    : 'projectSettings.grantRead',
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                class="h-5 px-1.5 text-xs text-destructive"
                onclick={() => void permissions.revokeGrant(grant.id)}
                data-testid={`project-grant-revoke-${grant.id}`}
              >
                {t('projectSettings.revoke')}
              </Button>
            </div>
          {/each}
        </li>
      {/each}
    </ul>
  {/if}
</div>

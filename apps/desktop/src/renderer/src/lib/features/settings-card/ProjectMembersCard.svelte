<script lang="ts">
  import type { SettingValues } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { composePool } from '$lib/features/chats/project-compose';
  import { projectMemberPlan, proposedMemberIds } from './project-members';

  /**
   * "Project members" embed of the in-conversation setting card (D92 WP7 step
   * 5, ported from the old dialog's embedded members branch): the checkbox
   * plan comes from `project-members.ts` — current members default to
   * checked, prefill only adds checks, removals only come from the user's own
   * unchecking, and "will add / will remove" are listed separately. The
   * roster never contains butlers.
   */
  let {
    conversationId,
    prefill = null,
    onSaved,
  }: {
    conversationId: string;
    prefill?: SettingValues | null;
    onSaved?: () => void;
  } = $props();

  /** Bots the user explicitly (un)checked; untouched ones follow membership and the bot's proposal. */
  let memberChoices = $state<Record<string, boolean>>({});
  let cardBusy = $state(false);

  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );

  // The bot's prefill only suggests bots to pull in: current members stay
  // checked by default, prefill only adds checks.
  const proposedIds = $derived(proposedMemberIds(prefill));
  const memberIds = $derived(members.map((member) => member.bot.id));
  const memberPlan = $derived(projectMemberPlan(memberIds, proposedIds, memberChoices));

  // Roster: the contact list without butlers (they never join a project),
  // plus bots still present in the member table.
  const roster = $derived.by(() => {
    const rows = composePool(contacts.bots).map((bot) => ({ id: bot.id, name: bot.name }));
    for (const member of members) {
      if (!rows.some((row) => row.id === member.bot.id)) {
        rows.push({ id: member.bot.id, name: member.bot.name });
      }
    }
    return rows;
  });

  function rosterNames(ids: readonly string[]): string {
    return ids.map((id) => roster.find((row) => row.id === id)?.name ?? id).join('、');
  }

  function toggleMember(id: string, on: boolean): void {
    memberChoices = { ...memberChoices, [id]: on };
  }

  async function applyCardMembers(): Promise<void> {
    if (cardBusy) return;
    cardBusy = true;
    try {
      // Recompute against live membership: a bot pulled in elsewhere while the
      // card hangs around is not removed; removals only come from the user's
      // own unchecking.
      const { toAdd, toRemove } = memberPlan;
      if (toAdd.length > 0 && !(await chat.addProjectMembers(conversationId, toAdd))) return;
      for (const id of toRemove) {
        if (!(await chat.removeProjectMember(conversationId, id))) return;
      }
      onSaved?.();
    } finally {
      cardBusy = false;
    }
  }
</script>

<div class="grid gap-2">
  <p class="text-sm font-medium">{t('project.members.count', { count: memberPlan.count })}</p>
  {#if roster.length === 0}
    <p class="text-xs text-muted-foreground">{t('settingCard.project.noBots')}</p>
  {:else}
    <div class="max-h-44 space-y-1.5 overflow-y-auto">
      {#each roster as bot (bot.id)}
        <label class="flex items-center gap-2 text-sm">
          <Checkbox
            checked={memberPlan.checked(bot.id)}
            onCheckedChange={(checked) => toggleMember(bot.id, checked === true)}
            data-testid={`project-card-member-${bot.id}`}
          />
          <span class="min-w-0 truncate">{bot.name}</span>
        </label>
      {/each}
    </div>
  {/if}
  {#if memberPlan.toAdd.length > 0}
    <p class="text-xs text-muted-foreground" data-testid="project-card-will-add">
      {t('settingCard.project.willAdd', { names: rosterNames(memberPlan.toAdd) })}
    </p>
  {/if}
  {#if memberPlan.toRemove.length > 0}
    <p class="text-xs text-destructive" data-testid="project-card-will-remove">
      {t('settingCard.project.willRemove', { names: rosterNames(memberPlan.toRemove) })}
    </p>
  {/if}
  <div class="flex justify-end">
    <Button
      size="sm"
      disabled={cardBusy || (memberPlan.toAdd.length === 0 && memberPlan.toRemove.length === 0)}
      onclick={() => void applyCardMembers()}
      data-testid="project-card-members-save"
    >
      {t('settingCard.apply')}
    </Button>
  </div>
</div>

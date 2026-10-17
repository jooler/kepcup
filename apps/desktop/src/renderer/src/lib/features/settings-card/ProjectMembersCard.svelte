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
   * 对话内设置卡的「项目成员」内嵌（D92 WP7 §4 步骤 5，迁自 GroupSettingsDialog 的
   * embedded 成员分支）：勾选计划由 `project-members.ts` 算——现有成员默认勾选、预填
   * 只会多勾、移出只来自用户亲手取消勾选；「将加入 / 将移出」分列。名册不含管家。
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

  /** 用户在卡上亲手勾 / 不勾的 Bot（没碰过的跟随当前成员与 Bot 的建议）。 */
  let memberChoices = $state<Record<string, boolean>>({});
  let cardBusy = $state(false);

  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );

  // Bot 的预填只表示「建议拉进项目组的 Bot」：现有成员默认勾选，预填只会多勾。
  const proposedIds = $derived(proposedMemberIds(prefill));
  const memberIds = $derived(members.map((member) => member.bot.id));
  const memberPlan = $derived(projectMemberPlan(memberIds, proposedIds, memberChoices));

  // 名册：通讯录去管家（管家不加入项目组），并上还在成员表里的 Bot。
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
      // 按当前成员重新算：卡片挂着期间别处拉进项目组的 Bot 不会被移出，移出只来自用户亲手取消勾选。
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

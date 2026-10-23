<script lang="ts">
  import type { SettingValues } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import { applySettingItem } from './apply';

  /**
   * "Project lead" embed of the in-conversation setting card (D92 WP7 step 5):
   * a single-choice member list with the current lead preselected and the
   * prefilled `botId` taking precedence. The lead must be a member, so the
   * roster is exactly the current member table.
   */
  let {
    conversationId,
    prefill = null,
    expected = null,
    messageId = undefined,
    onSaved,
    onConflict,
  }: {
    conversationId: string;
    prefill?: SettingValues | null;
    expected?: SettingValues | null;
    messageId?: string | undefined;
    onSaved?: () => void;
    onConflict?: (current: SettingValues | null) => void;
  } = $props();

  let selected = $state<string | null>(null);
  let selectedReady = false;
  let cardBusy = $state(false);

  const conversation = $derived(chat.conversations.find((c) => c.id === conversationId) ?? null);
  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );

  // Prefill (the bot's suggestion) first; fall back to the current lead.
  $effect(() => {
    if (selectedReady) return;
    const wanted = prefill?.botId;
    if (typeof wanted === 'string' && wanted.length > 0) {
      selected = wanted;
      selectedReady = true;
      return;
    }
    if (conversation === null) return;
    selected = conversation.leadBotId ?? null;
    selectedReady = true;
  });

  async function applyCardLead(): Promise<void> {
    if (selected === null || cardBusy) return;
    cardBusy = true;
    try {
      const out = await applySettingItem({
        itemId: 'project.lead',
        values: { botId: selected },
        expected,
        target: { conversationId },
        messageId,
      });
      if (out.status === 'conflict') {
        onConflict?.(out.current);
        return;
      }
      toast.success(t('settingCard.appliedToast'));
      onSaved?.();
    } catch (error) {
      toast.error(
        t('settingCard.actionFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      cardBusy = false;
    }
  }
</script>

<div class="grid gap-2">
  <p class="text-sm">{t('projectSettings.lead')}</p>
  {#if members.length === 0}
    <p class="text-xs text-muted-foreground">{t('settingCard.project.noBots')}</p>
  {:else}
    <div class="max-h-44 space-y-1.5 overflow-y-auto">
      {#each members as member (member.bot.id)}
        <label
          class="flex items-center gap-2 text-sm"
          data-testid={`project-card-lead-${member.bot.id}`}
        >
          <input
            type="radio"
            name="project-card-lead-{conversationId}"
            value={member.bot.id}
            checked={selected === member.bot.id}
            onchange={() => (selected = member.bot.id)}
            class="size-4 accent-foreground"
          />
          <BotAvatar
            botId={member.bot.id}
            name={member.bot.name}
            avatar={member.bot.avatar}
            class="size-6"
            animated={false}
          />
          <span class="min-w-0 truncate">{member.bot.name}</span>
        </label>
      {/each}
    </div>
  {/if}
  <p class="text-xs text-muted-foreground">{t('settingCard.project.leadHint')}</p>
  <div class="flex justify-end">
    <Button
      size="sm"
      disabled={cardBusy || selected === null}
      onclick={() => void applyCardLead()}
      data-testid="project-card-lead-save"
    >
      {t('settingCard.apply')}
    </Button>
  </div>
</div>

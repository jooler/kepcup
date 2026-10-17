<script lang="ts">
  import type { SettingValues } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { applySettingItem } from './apply';

  /**
   * "Project title" embed of the in-conversation setting card (D89 / D92 WP7
   * step 5, ported from the old dialog's embedded branch): the `expected` /
   * `onConflict` / `messageId` concurrency semantics are unchanged.
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

  let cardTitle = $state('');
  let cardTitleReady = false;
  let cardBusy = $state(false);

  const conversation = $derived(chat.conversations.find((c) => c.id === conversationId) ?? null);

  // Prefill (the bot's suggestion) first; fall back to the current title.
  $effect(() => {
    if (cardTitleReady) return;
    const wanted = prefill?.title;
    if (typeof wanted === 'string' && wanted.trim().length > 0) {
      cardTitle = wanted.trim();
      cardTitleReady = true;
      return;
    }
    if (conversation === null) return;
    cardTitle = conversation.title ?? '';
    cardTitleReady = true;
  });

  async function applyCardTitle(): Promise<void> {
    const next = cardTitle.trim();
    if (next.length === 0 || cardBusy) return;
    cardBusy = true;
    try {
      const out = await applySettingItem({
        itemId: 'project.title',
        values: { title: next },
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

<div class="grid gap-2" data-testid="project-card-embedded">
  <label class="grid gap-1.5 text-sm" for="project-card-title">
    {t('projectSettings.name')}
    <Input id="project-card-title" bind:value={cardTitle} data-testid="project-card-title" />
  </label>
  <div class="flex justify-end">
    <Button
      size="sm"
      disabled={cardBusy || cardTitle.trim().length === 0}
      onclick={() => void applyCardTitle()}
      data-testid="project-card-title-save"
    >
      {t('settingCard.apply')}
    </Button>
  </div>
</div>

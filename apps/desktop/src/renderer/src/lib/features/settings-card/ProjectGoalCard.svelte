<script lang="ts">
  import type { SettingValues } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { applySettingItem } from './apply';

  /**
   * 对话内设置卡的「项目目标」内嵌（D92 WP7 §4 步骤 5；WP4 时暂由成员段代管）。
   * 目标不能经卡清空（core 的 adapter 拒绝空目标）——清空走详情页。
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

  let cardGoal = $state('');
  let cardGoalReady = false;
  let cardBusy = $state(false);

  const conversation = $derived(chat.conversations.find((c) => c.id === conversationId) ?? null);

  // 预填（Bot 建议）优先；没有就用当前目标。
  $effect(() => {
    if (cardGoalReady) return;
    const wanted = prefill?.goal;
    if (typeof wanted === 'string' && wanted.trim().length > 0) {
      cardGoal = wanted.trim();
      cardGoalReady = true;
      return;
    }
    if (conversation === null) return;
    cardGoal = conversation.goal ?? '';
    cardGoalReady = true;
  });

  async function applyCardGoal(): Promise<void> {
    const next = cardGoal.trim();
    if (next.length === 0 || cardBusy) return;
    cardBusy = true;
    try {
      const out = await applySettingItem({
        itemId: 'project.goal',
        values: { goal: next },
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
  <label class="grid gap-1.5 text-sm" for="project-card-goal">
    {t('projectSettings.goal')}
    <Textarea
      id="project-card-goal"
      bind:value={cardGoal}
      rows={3}
      class="min-h-0 resize-y"
      data-testid="project-card-goal"
    />
  </label>
  <div class="flex justify-end">
    <Button
      size="sm"
      disabled={cardBusy || cardGoal.trim().length === 0}
      onclick={() => void applyCardGoal()}
      data-testid="project-card-goal-save"
    >
      {t('settingCard.apply')}
    </Button>
  </div>
</div>

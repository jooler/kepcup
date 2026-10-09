<script lang="ts">
  import {
    describeScheduleWhen,
    type ScheduleReceiptSnapshot,
  } from '@kepcup/shared';
  import { AlarmClock } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 定时任务回执（D80，todo/schedule-nudges.md §3.3）：回执卡与已接受的提议卡
   * 共用。快照来自创建时，`status` 随取消 / 完成由 core 回写（message.updated）。
   * 取消两步确认；「全部定时任务」打开右栏定时任务标签。
   */
  let {
    schedule,
    testid,
    showBot = false,
  }: { schedule: ScheduleReceiptSnapshot; testid: string; showBot?: boolean } = $props();

  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = $derived(describeScheduleWhen(schedule, { localTimeZone, now: Date.now() }));
  let confirming = $state(false);
  let cancelling = $state(false);

  async function cancel(): Promise<void> {
    cancelling = true;
    try {
      await core.call('schedules.cancel', { id: schedule.id });
      toast.success(t('schedules.cancelled'));
      confirming = false;
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('schedules.actionFailed')));
    } finally {
      cancelling = false;
    }
  }
</script>

<div data-testid={testid} data-schedule-status={schedule.status}>
  <div class="flex items-start gap-2">
    <AlarmClock
      class="mt-0.5 size-4 shrink-0 {schedule.status === 'active'
        ? 'text-sky-600'
        : 'text-muted-foreground'}"
      aria-hidden="true"
    />
    <div class="min-w-0 flex-1">
      <p class="font-medium {schedule.status === 'cancelled' ? 'line-through opacity-60' : ''}">
        {schedule.title}
      </p>
      <p class="text-xs text-muted-foreground" data-testid="schedule-receipt-when">
        {when}{#if showBot} · {chat.botName(schedule.botId)}{/if}
        {#if schedule.status === 'cancelled'} · {t('schedules.receiptCancelled')}{/if}
        {#if schedule.status === 'done'} · {t('schedules.receiptDone')}{/if}
        {#if schedule.origin === 'commitment'} · {t('schedules.commitment')}{/if}
      </p>
    </div>
  </div>
  <div class="mt-2 flex flex-wrap justify-end gap-1">
    <Button
      size="sm"
      variant="ghost"
      class="h-6 px-2 text-xs"
      onclick={() => shell.openSchedules()}
      data-testid="schedule-receipt-all">{t('schedules.viewAll')}</Button
    >
    {#if schedule.status === 'active'}
      {#if confirming}
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={() => (confirming = false)}>{t('common.cancel')}</Button
        >
        <Button
          size="sm"
          class="h-6 px-2 text-xs"
          disabled={cancelling}
          onclick={() => void cancel()}
          data-testid="schedule-receipt-cancel-confirm">{t('schedules.cancelConfirm')}</Button
        >
      {:else}
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs text-destructive"
          onclick={() => (confirming = true)}
          data-testid="schedule-receipt-cancel">{t('schedules.cancel')}</Button
        >
      {/if}
    {/if}
  </div>
</div>

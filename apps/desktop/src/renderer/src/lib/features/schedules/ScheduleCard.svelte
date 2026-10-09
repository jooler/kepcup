<script lang="ts">
  import {
    SCHEDULE_OFFER_EVENT,
    describeScheduleWhen,
    type Message,
    type ScheduleOfferContent,
    type ScheduleReceiptSnapshot,
  } from '@kepcup/shared';
  import { AlarmClockPlus } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import ScheduleReceipt from './ScheduleReceipt.svelte';

  /**
   * 定时任务卡（D80）：event = schedule_created 的回执卡，或 event =
   * schedule_offer 的提议卡（Bot 用 offer_schedule 提出的具体时间：「设置」
   * 由 core 确定性创建，卡片转为回执；「不用了」计入拒绝退避；被新提议取代 /
   * 时间已过时只留一行说明）。两种都不唤醒 Bot，状态经 message.updated 重绘。
   */
  let { message }: { message: Message } = $props();

  const content = $derived(
    message.content as {
      event?: string;
      text?: string;
      schedule?: ScheduleReceiptSnapshot;
      offer?: ScheduleOfferContent;
    },
  );
  const isOffer = $derived(content.event === SCHEDULE_OFFER_EVENT);
  const offer = $derived(content.offer ?? null);
  const isGroup = $derived(chat.current?.conversation.type === 'group');
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ISO = /^\d{4}-\d{2}-\d{2}/;
  const offerWhen = $derived.by(() => {
    if (offer === null) return '';
    const iso = ISO.test(offer.when) ? Date.parse(offer.when.replace(' ', 'T')) : NaN;
    return Number.isNaN(iso)
      ? describeScheduleWhen(
          { kind: 'cron', cron: offer.when, runAt: null, timezone: offer.timezone ?? localTimeZone },
          { localTimeZone },
        )
      : describeScheduleWhen(
          { kind: 'once', runAt: iso, cron: null, timezone: localTimeZone },
          { now: Date.now() },
        );
  });
  /** A pending one-shot offer whose time has passed can only expire (core agrees on click). */
  const offerStatus = $derived.by(() => {
    if (offer === null) return null;
    if (offer.status !== 'pending' || !ISO.test(offer.when)) return offer.status;
    const at = Date.parse(offer.when.replace(' ', 'T'));
    return Number.isNaN(at) || at > Date.now() ? 'pending' : 'expired';
  });
  let busy = $state(false);

  async function act(method: 'schedules.acceptOffer' | 'schedules.declineOffer'): Promise<void> {
    busy = true;
    try {
      await core.call(method, { messageId: message.id });
      if (method === 'schedules.acceptOffer') toast.success(t('schedules.offerAccepted'));
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('schedules.actionFailed')));
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="w-full max-w-[85%] rounded-lg border bg-background/80 p-3 text-sm"
  data-testid={isOffer ? `schedule-offer-${message.id}` : `schedule-receipt-${message.id}`}
>
  {#if !isOffer && content.schedule !== undefined}
    <ScheduleReceipt schedule={content.schedule} testid="schedule-receipt" showBot={isGroup} />
  {:else if offer !== null}
    {#if offer.status === 'accepted' && content.schedule !== undefined}
      <ScheduleReceipt schedule={content.schedule} testid="schedule-receipt" showBot={isGroup} />
    {:else}
      <div class="flex items-start gap-2" data-offer-status={offerStatus}>
        <AlarmClockPlus
          class="mt-0.5 size-4 shrink-0 {offerStatus === 'pending'
            ? 'text-sky-600'
            : 'text-muted-foreground'}"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <p class="whitespace-pre-wrap">{offer.question}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {offerWhen} · {offer.title}{#if isGroup} · {chat.botName(offer.botId)}{/if}
          </p>
          {#if offerStatus !== 'pending'}
            <p class="mt-1 text-xs text-muted-foreground" data-testid="schedule-offer-result">
              {t(`schedules.offer.${offerStatus ?? 'pending'}`)}
            </p>
          {/if}
        </div>
      </div>
      {#if offerStatus === 'pending'}
        <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
          <span class="mr-auto text-xs text-muted-foreground">{t('schedules.offerHint')}</span>
          <Button
            size="sm"
            variant="outline"
            class="h-7"
            disabled={busy}
            onclick={() => void act('schedules.declineOffer')}
            data-testid="schedule-offer-decline">{t('schedules.offerDecline')}</Button
          >
          <Button
            size="sm"
            class="h-7"
            disabled={busy}
            onclick={() => void act('schedules.acceptOffer')}
            data-testid="schedule-offer-accept">{t('schedules.offerAccept')}</Button
          >
        </div>
      {/if}
    {/if}
  {:else}
    <p class="text-xs text-muted-foreground">{content.text ?? ''}</p>
  {/if}
</div>

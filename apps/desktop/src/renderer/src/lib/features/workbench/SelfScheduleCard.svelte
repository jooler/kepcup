<script lang="ts">
  import { describeScheduleWhen, scheduleDisplayTitle, type ScheduleEntry } from '@kepcup/shared';
  import { AlarmClock, CircleAlert } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import { describeAt, localTimeZone } from './describe';
  import { selfScheduleSource } from './workbench-model';
  import { openScheduleConversation } from './todo-actions';
  import { workbench } from './workbench.svelte';

  /**
   * 自排卡（D90 §3.3）：员工自己的日程（自排 / 例行 / 承诺 / 提议），不是用户派的活——
   * 只读展示来源标签、人话时间与推迟原因，可取消（两步确认，复用 `schedules.cancel`）、
   * 可打开对话。
   */
  let { schedule }: { schedule: ScheduleEntry } = $props();

  const source = $derived(selfScheduleSource(schedule.origin));
  const whenText = $derived(
    describeScheduleWhen(schedule, { localTimeZone: localTimeZone(), now: Date.now() }),
  );
  const nextText = $derived(
    schedule.kind === 'cron' && schedule.nextFireAt !== null
      ? describeAt(schedule.nextFireAt)
      : null,
  );
  /** 在群里安排的任务：标注来源群（私聊里的不标）。 */
  const groupName = $derived.by(() => {
    const conversation = chat.conversations.find((item) => item.id === schedule.conversationId);
    return conversation?.type === 'project' ? (conversation.title ?? conversation.id) : null;
  });
  let confirming = $state(false);
  let cancelling = $state(false);

  async function cancel(): Promise<void> {
    cancelling = true;
    try {
      await core.call('schedules.cancel', { id: schedule.id });
      toast.success(t('schedules.cancelled'));
      confirming = false;
      await workbench.refreshSchedules();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('schedules.actionFailed')),
      );
    } finally {
      cancelling = false;
    }
  }
</script>

<div
  class="rounded-lg border border-dashed bg-background p-3 text-sm"
  data-testid="self-schedule-card"
  data-schedule-id={schedule.id}
  data-origin={schedule.origin}
>
  <div class="flex items-start gap-2">
    <AlarmClock class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <p class="min-w-0 flex-1 font-medium break-words">{scheduleDisplayTitle(schedule)}</p>
    <span
      class="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
      title={t('workbench.self.hint')}
      data-testid="self-schedule-source"
    >
      {t(`workbench.self.${source}`)}
    </span>
  </div>
  <p class="mt-1 text-xs text-muted-foreground" data-testid="self-schedule-when">
    {whenText}{#if nextText !== null}
      · {t('schedules.nextFire', { time: nextText })}{/if}{#if groupName !== null}
      · <span data-testid="self-schedule-group"
        >{t('workbench.self.fromGroup', { name: groupName })}</span
      >{/if}
  </p>
  {#if schedule.deferredReason !== null}
    <p
      class="mt-1.5 flex items-start gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
      data-testid="self-schedule-deferred"
    >
      <CircleAlert class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      {t('schedules.deferred', { reason: schedule.deferredReason })}
    </p>
  {/if}
  <div class="mt-2 flex flex-wrap justify-end gap-1">
    {#if confirming}
      <Button
        size="xs"
        variant="ghost"
        onclick={() => (confirming = false)}
        data-testid="self-schedule-cancel-dismiss"
      >
        {t('common.cancel')}
      </Button>
      <Button
        size="xs"
        disabled={cancelling}
        onclick={() => void cancel()}
        data-testid="self-schedule-cancel-confirm"
      >
        {t('schedules.cancelConfirm')}
      </Button>
    {:else}
      <Button
        size="xs"
        variant="ghost"
        class="text-destructive"
        onclick={() => (confirming = true)}
        data-testid="self-schedule-cancel"
      >
        {t('schedules.cancel')}
      </Button>
    {/if}
    <Button
      size="xs"
      variant="outline"
      onclick={() => void openScheduleConversation(schedule)}
      data-testid="self-schedule-open-chat"
    >
      {t('workbench.action.openChat')}
    </Button>
  </div>
</div>

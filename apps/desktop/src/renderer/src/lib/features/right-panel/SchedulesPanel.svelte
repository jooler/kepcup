<script lang="ts">
  import { describeScheduleWhen, scheduleDisplayTitle, type ScheduleEntry } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * P10 scheduled-task list (docs/dev/phases/P10-proactive.md 任务 7). One
   * component, three surfaces: the direct-chat right-panel tab (current
   * conversation), the group-info section (every member bot's tasks) and the
   * settings overview (no conversationId = all schedules).
   */
  let {
    conversationId = undefined,
    active = true,
    testid = 'schedules-panel',
  }: {
    /** Omitted = every schedule (settings overview, schedules.list 全局口径). */
    conversationId?: string | undefined;
    /** bits-ui keeps inactive tab content mounted (hidden): fetch only when visible. */
    active?: boolean;
    testid?: string;
  } = $props();

  let entries = $state<ScheduleEntry[]>([]);
  let loading = $state(false);
  /** Two-step cancel: the entry awaiting confirmation (WikiTab rollback precedent). */
  let cancelTarget = $state<string | null>(null);
  let cancelling = $state(false);

  // Load on every activation and via the refresh button; D80 adds the
  // schedules.changed event, so visible lists also follow creations / cancels.
  $effect(() => {
    if (active) void refresh();
  });
  $effect(() => {
    if (!active) return;
    return core.onEvent('schedules.changed', (payload) => {
      const changed = (payload as { conversationId?: string }).conversationId;
      if (conversationId === undefined || changed === conversationId) void refresh();
    });
  });

  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function refresh(): Promise<void> {
    loading = true;
    try {
      // Plain object literal — $state Proxy values never cross postMessage.
      const input = conversationId === undefined ? {} : { conversationId };
      const result = (await core.call('schedules.list', input)) as {
        schedules: ScheduleEntry[];
      };
      entries = result.schedules;
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('schedules.actionFailed')),
      );
    } finally {
      loading = false;
    }
  }

  async function cancel(): Promise<void> {
    const id = cancelTarget;
    if (id === null) return;
    cancelling = true;
    try {
      await core.call('schedules.cancel', { id });
      toast.success(t('schedules.cancelled'));
      cancelTarget = null;
      await refresh();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('schedules.actionFailed')),
      );
    } finally {
      cancelling = false;
    }
  }

  function fireTime(entry: ScheduleEntry): string {
    if (entry.nextFireAt === null) return '—';
    return describeScheduleWhen(
      { kind: 'once', runAt: entry.nextFireAt, cron: null, timezone: localTimeZone },
      { now: Date.now() },
    );
  }

  function whenText(entry: ScheduleEntry): string {
    return describeScheduleWhen(entry, { localTimeZone, now: Date.now() });
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid={testid}>
  <div class="flex items-center justify-between gap-2">
    <p class="text-xs text-muted-foreground">{t('schedules.hint')}</p>
    <Button
      size="sm"
      variant="outline"
      disabled={loading}
      onclick={() => void refresh()}
      data-testid={`${testid}-refresh`}
    >
      {t('common.refresh')}
    </Button>
  </div>

  {#if loading && entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-loading`}>…</p>
  {:else if entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-empty`}>
      {conversationId === undefined ? t('schedules.emptyAll') : t('schedules.emptyConversation')}
    </p>
  {:else}
    <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid={`${testid}-list`}>
      {#each entries as entry (entry.id)}
        <li class="rounded-md border p-2 text-sm" data-testid={`schedule-item-${entry.id}`}>
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1 font-medium" data-testid="schedule-title">
              {scheduleDisplayTitle(entry)}
            </p>
            {#if entry.commitmentId !== null}
              <span
                class="shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400"
                title={t('schedules.commitmentHint')}
                data-testid="schedule-commitment"
              >
                {t('schedules.commitment')}
              </span>
            {/if}
          </div>
          {#if entry.title.trim().length > 0}
            <p class="mt-0.5 text-xs text-muted-foreground" data-testid="schedule-note">
              {entry.note}
            </p>
          {/if}
          <p class="mt-0.5 text-xs text-muted-foreground" data-testid="schedule-bot">
            {entry.botName ?? entry.botId}
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground" data-testid="schedule-when">
            {whenText(entry)}{#if entry.kind === 'cron'} · {t('schedules.nextFire', {
                time: fireTime(entry),
              })}{/if}
          </p>
          {#if entry.deferredReason !== null}
            <p
              class="mt-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
              data-testid="schedule-deferred"
            >
              {t('schedules.deferred', { reason: entry.deferredReason })}
            </p>
          {/if}
          <div class="mt-1 flex justify-end gap-1">
            {#if cancelTarget === entry.id}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => (cancelTarget = null)}
                data-testid="schedule-cancel-dismiss"
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                class="h-6 px-2 text-xs"
                disabled={cancelling}
                onclick={() => void cancel()}
                data-testid="schedule-cancel-confirm"
              >
                {t('schedules.cancelConfirm')}
              </Button>
            {:else}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs text-destructive"
                onclick={() => (cancelTarget = entry.id)}
                data-testid={`schedule-cancel-${entry.id}`}
              >
                {t('schedules.cancel')}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<script lang="ts">
  import { ChevronDown, ChevronRight, Hourglass } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { chat, type ActiveRunView } from '$lib/stores/chat.svelte';
  import { projects } from '$lib/stores/projects.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { toolVerb } from '../chats/tool-labels';
  import { taskStatusSummary, type TaskActivity } from './task-view';

  /**
   * 执行状态行（D55 → D75，docs/design/30-supervisor-and-tasks.md §6.3）：
   * 显示本对话**进行中任务**的活动——一条任务时是它的标题与当前活动；多条
   * 时是条数与最近活动，点击展开逐条列表。与对话轮的状态行同处消息流末尾、
   * 同样只有绿点与文字；任务的消息落库时整行让位，下一个活动再出现。
   * 不在这里取消（取消在任务卡上）；等待项目租约时附「强制收回」。
   */
  let { entries }: { entries: ActiveRunView[] } = $props();

  let expanded = $state(false);

  function activityOf(entry: ActiveRunView): string {
    const view = tasks.byId[entry.run.id];
    if (entry.run.status === 'queued') {
      const reason = view?.queueReason ?? '';
      return reason.length > 0 ? t('task.queued', { reason }) : t('runStatus.queued');
    }
    if (view?.awaitingInput === true) return t('task.awaitingInput');
    if (entry.progress.length > 0) return entry.progress;
    const verb = toolVerb(entry.toolName);
    if (verb !== null) return t('runStatus.callingVerb', { verb });
    if (entry.toolName.length > 0) return t('runStatus.callingTool', { tool: entry.toolName });
    return t('runStatus.pleaseWait');
  }

  const activities = $derived(
    entries.map((entry): TaskActivity => ({
      taskId: entry.run.id,
      title: entry.run.taskTitle ?? tasks.byId[entry.run.id]?.title ?? '',
      activity: activityOf(entry),
      queued: entry.run.status === 'queued',
      at: entry.at,
    })),
  );
  const summary = $derived(taskStatusSummary(activities));
  /** Every task's latest message landed and nothing happened since: yield the spot. */
  const muted = $derived(entries.length > 0 && entries.every((entry) => entry.muted));
  const leaseEntry = $derived(
    entries.find(
      (entry) =>
        (entry.run.status === 'waiting_lease' || entry.run.status === 'queued') &&
        projects.leaseWaiting[entry.run.id] !== undefined,
    ) ?? null,
  );
  const lease = $derived(
    leaseEntry !== null ? projects.leaseWaiting[leaseEntry.run.id] : undefined,
  );
  const holderName = $derived(
    lease !== undefined
      ? (chat.conversations.find((c) => c.id === lease.holderConversationId)?.bot?.name ??
          lease.holderBotId ??
          '')
      : '',
  );

  async function revokeLease(): Promise<void> {
    const conversationId = leaseEntry?.run.conversationId ?? null;
    if (conversationId === null) return;
    const revoked = await projects.revokeLease(conversationId);
    if (revoked) toast.success(t('projects.leaseRevoked'));
    else toast.info(t('projects.leaseNothing'));
  }
</script>

{#if summary.latest !== null && !muted}
  {@const latest = summary.latest}
  <div class="flex flex-col py-1 text-sm text-muted-foreground">
    <div
      class="flex items-center gap-2"
      data-testid="run-status"
      data-run-id={latest.taskId}
      data-task-count={summary.count}
    >
      <span class="relative flex size-2.5 shrink-0">
        <span
          class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"
        ></span>
        <span class="relative inline-flex size-2.5 rounded-full bg-emerald-500"></span>
      </span>
      {#if summary.count > 1}
        <button
          type="button"
          class="flex min-w-0 items-center gap-1 truncate text-left"
          onclick={() => (expanded = !expanded)}
          aria-expanded={expanded}
          data-testid="task-status-toggle"
        >
          {#if expanded}
            <ChevronDown class="size-3.5 shrink-0" aria-hidden="true" />
          {:else}
            <ChevronRight class="size-3.5 shrink-0" aria-hidden="true" />
          {/if}
          <span class="min-w-0 truncate" data-testid="run-status-text"
            >{t('task.statusMany', {
              count: summary.count,
              title: latest.title,
              activity: latest.activity,
            })}</span
          >
        </button>
      {:else}
        <span class="min-w-0 truncate" data-testid="run-status-text">
          {#if lease !== undefined}
            <span class="inline-flex items-center gap-1.5" data-testid="lease-waiting-text">
              <Hourglass class="size-3.5 animate-pulse" aria-hidden="true" />
              {t('projects.leaseWaiting', { name: holderName })}
            </span>
          {:else}
            {t('task.statusOne', { title: latest.title, activity: latest.activity })}
          {/if}
        </span>
      {/if}
      {#if lease !== undefined}
        <Button
          variant="outline"
          size="sm"
          class="h-7 shrink-0 gap-1 px-2"
          onclick={() => void revokeLease()}
          data-testid="lease-revoke"
        >
          {t('projects.leaseRevoke')}
        </Button>
      {/if}
    </div>
    {#if expanded && summary.count > 1}
      <ul class="mt-1 ml-4 space-y-0.5 text-xs" data-testid="task-status-list">
        {#each activities as item (item.taskId)}
          <li class="truncate" data-testid="task-status-item" data-run-id={item.taskId}>
            {t('task.statusOne', { title: item.title, activity: item.activity })}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

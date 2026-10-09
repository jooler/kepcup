<script lang="ts">
  import { ArrowUpRight, CircleCheck, CircleX, Clock, Loader2, Send } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { delegations } from '$lib/stores/delegations.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 跨 Bot 委派卡（D71，docs/design/27 §3.2）：A 的对话里的两种卡——
   * 发出卡（delegation_sent：交给了谁、任务摘要、实时状态、可取消）与结果卡
   * （delegation_result：B 的回复截断 + 「查看原文」跳到 B 的对话，或失败 /
   * 取消原因）。用户留在 A 的对话，**不**自动切换到 B。
   * W6：发出卡显示 intent（请求 / 提问 / 告知）；B 派了后台任务时显示
   * 「等待 B 的任务…」并可取消（一并停止那些任务）；告知送达即结束、没有结果卡。
   */
  let { cardType, delegationId }: { cardType: string; delegationId: string } = $props();

  $effect(() => {
    void delegations.ensure(delegationId);
  });

  const delegation = $derived(delegations.byId[delegationId] ?? null);
  const toName = $derived(delegation !== null ? chat.botName(delegation.toBotId) : '');
  const active = $derived(
    delegation !== null &&
      (delegation.status === 'submitted' ||
        delegation.status === 'working' ||
        delegation.status === 'awaiting_tasks'),
  );
  const sentTitle = $derived(
    delegation === null
      ? ''
      : delegation.intent === 'question'
        ? t('delegation.sentTitleQuestion', { name: toName })
        : delegation.intent === 'fyi'
          ? t('delegation.sentTitleFyi', { name: toName })
          : t('delegation.sentTitle', { name: toName }),
  );
  const statusText = $derived(
    delegation === null
      ? ''
      : delegation.intent === 'fyi' && delegation.status === 'completed'
        ? t('delegation.fyiDelivered')
        : t(`delegation.status.${delegation.status}`),
  );
  const resultTitle = $derived(
    delegation === null
      ? ''
      : delegation.taskIds.length > 0 && delegation.resultMessageId === null
        ? t('delegation.taskResultTitle', { name: toName })
        : delegation.intent === 'question'
          ? t('delegation.answerTitle', { name: toName })
          : t('delegation.resultTitle', { name: toName }),
  );
  let cancelling = $state(false);
  let expanded = $state(false);

  async function cancel(): Promise<void> {
    cancelling = true;
    try {
      await delegations.cancel(delegationId);
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('chats.errorCode.INTERNAL')));
    } finally {
      cancelling = false;
    }
  }

  async function openOriginal(): Promise<void> {
    if (delegation === null || delegation.toConversationId === null) return;
    const target = delegation.resultMessageId ?? delegation.toMessageId;
    const ok =
      target !== null
        ? await chat.jumpToMessage(delegation.toConversationId, target)
        : (await chat.select(delegation.toConversationId), true);
    if (!ok) toast.error(t('delegation.conversationGone'));
  }
</script>

{#if delegation === null}
  <span class="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground"
    >{t('delegation.loading')}</span
  >
{:else if cardType === 'delegation_sent'}
  <div
    class="w-full max-w-[85%] rounded-lg border bg-background/80 p-3 text-sm"
    data-testid={`delegation-sent-${delegationId}`}
    data-delegation-status={delegation.status}
    data-delegation-intent={delegation.intent}
  >
    <div class="flex items-center gap-2 font-medium">
      <Send class="size-4 text-sky-600" aria-hidden="true" />
      <span>{sentTitle}</span>
      <span
        class="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
        data-testid="delegation-intent">{t(`delegation.intent.${delegation.intent}`)}</span
      >
      <span class="ml-auto flex items-center gap-1 text-xs font-normal text-muted-foreground">
        {#if delegation.status === 'working' || delegation.status === 'awaiting_tasks'}
          <Loader2 class="size-3 animate-spin" aria-hidden="true" />
        {:else if delegation.status === 'submitted'}
          <Clock class="size-3" aria-hidden="true" />
        {/if}
        {statusText}
      </span>
    </div>
    <p class="mt-1.5 line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
      {delegation.taskText}
    </p>
    {#if delegation.status === 'submitted'}
      <p class="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
        {delegation.intent === 'fyi' ? t('delegation.fyiQueuedHint') : t('delegation.queuedHint')}
      </p>
    {:else if delegation.status === 'awaiting_tasks'}
      <p class="mt-1.5 text-xs text-muted-foreground" data-testid="delegation-awaiting-tasks">
        {t('delegation.awaitingTasksHint', { name: toName, count: delegation.taskIds.length })}
      </p>
    {/if}
    {#if active}
      <div class="mt-2 flex justify-end">
        <Button
          size="sm"
          variant="outline"
          class="h-7"
          disabled={cancelling}
          onclick={() => void cancel()}
          data-testid="delegation-cancel">{t('delegation.cancel')}</Button
        >
      </div>
    {/if}
  </div>
{:else}
  <div
    class="w-full max-w-[85%] rounded-lg border p-3 text-sm {delegation.status === 'completed'
      ? 'bg-background/80'
      : 'border-destructive/40 bg-destructive/5'}"
    data-testid={`delegation-result-${delegationId}`}
    data-delegation-status={delegation.status}
  >
    <div class="flex items-center gap-2 font-medium">
      {#if delegation.status === 'completed'}
        <CircleCheck class="size-4 text-emerald-600" aria-hidden="true" />
        <span>{resultTitle}</span>
      {:else}
        <CircleX class="size-4 text-destructive" aria-hidden="true" />
        <span>{t('delegation.failedTitle', { name: toName })}</span>
      {/if}
    </div>
    {#if delegation.status === 'completed'}
      <p
        class="mt-1.5 text-sm whitespace-pre-wrap {expanded ? '' : 'line-clamp-6'}"
        data-testid="delegation-result-text"
      >
        {delegation.resultExcerpt}
      </p>
    {:else}
      <p
        class="mt-1.5 text-xs whitespace-pre-wrap text-muted-foreground {expanded
          ? ''
          : 'line-clamp-6'}"
        data-testid="delegation-error-text"
      >
        {delegation.errorText}
      </p>
    {/if}
    <div class="mt-2 flex items-center justify-end gap-2">
      {#if (delegation.status === 'completed' ? (delegation.resultExcerpt?.length ?? 0) : (delegation.errorText?.length ?? 0)) > 200}
        <Button size="sm" variant="ghost" class="h-7" onclick={() => (expanded = !expanded)}>
          {expanded ? t('delegation.collapse') : t('delegation.expand')}
        </Button>
      {/if}
      {#if delegation.toConversationId !== null}
        <Button
          size="sm"
          variant="outline"
          class="h-7 gap-1"
          onclick={() => void openOriginal()}
          data-testid="delegation-open-original"
        >
          {t('delegation.openOriginal', { name: toName })}
          <ArrowUpRight class="size-3.5" aria-hidden="true" />
        </Button>
      {/if}
    </div>
  </div>
{/if}

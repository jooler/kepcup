<script lang="ts">
  import { ArrowUpRight, CircleCheck, CircleX, Clock, Loader2, Send } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { delegations } from '$lib/stores/delegations.svelte';
  import { Button } from '$lib/components/ui/button';
  import { lazyMarkdown } from '../chats/markdown-lazy.svelte';
  import Markdown from '../chats/Markdown.svelte';

  /**
   * 跨 Bot 委派卡（D71 v2 / D113，docs/design/27-butler-and-delegation.md §3.2）：
   * 用户对话里只有**药丸**——A 侧发出药丸（delegation_sent：已委托 {B} 处理 ·
   * 状态 · 查看详情，活动期可取消），B 侧接收药丸（delegation_received：已开始
   * 处理来自 {A} 的委托 · 查看详情）。点击「查看详情」打开 A ⇄ B 的交换会话
   * 详情视图（ChatsArea 整区替换，无输入框）；任务与授权卡按执行归属映射落在
   * B 的私聊。用户留在自己的对话，**不**自动切换。
   * 存量（v1）：delegation_result 结果卡分支原样保留，只服务升级前的历史行。
   */
  let { cardType, delegationId }: { cardType: string; delegationId: string } = $props();

  $effect(() => {
    void delegations.ensure(delegationId);
  });
  // 结果卡（存量）的正文是 B 的回复原文（markdown 源文本），与 Bot 气泡共用
  // 同一条 streamdown 懒加载管线；结果卡可能先于任何 Bot 气泡出现，这里自己触发加载。
  $effect(() => {
    if (cardType === 'delegation_result') lazyMarkdown.start();
  });

  const delegation = $derived(delegations.byId[delegationId] ?? null);
  const toName = $derived(delegation !== null ? chat.botName(delegation.toBotId) : '');
  const fromName = $derived(delegation !== null ? chat.botName(delegation.fromBotId) : '');
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

  function openDetail(): void {
    delegations.openDetail(delegationId);
  }

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
{:else if cardType === 'delegation_result'}
  <!-- 存量（v1）结果卡：升级前的历史行仍以卡片形态展示原文与「查看原文」跳转。 -->
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
      <!-- 折叠态不能用 line-clamp：它要求内容参与 -webkit-box 的行布局，而
           streamdown-wrap 是 display:grid（独立格式化上下文），行数截断不生效，
           折叠/展开看起来毫无变化；改用高度裁剪，对任意 markdown 块都可靠 -->
      <div
        class="mt-1.5 text-sm {expanded ? '' : 'max-h-32 overflow-hidden'}"
        data-testid="delegation-result-text"
      >
        <div class="streamdown-wrap min-w-0 [&_pre]:rounded-md">
          <Markdown content={delegation.resultExcerpt ?? ''} />
        </div>
      </div>
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
{:else if cardType === 'delegation_received'}
  <!-- B 侧接收药丸：已开始处理来自 A 的委托 · 查看详情。 -->
  <button
    type="button"
    class="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/40 bg-background/80 px-3 py-1 text-xs shadow-sm transition-colors hover:bg-accent/40"
    onclick={openDetail}
    data-testid={`delegation-received-${delegationId}`}
    data-delegation-status={delegation.status}
  >
    <Send class="size-3.5 shrink-0 text-sky-600" aria-hidden="true" />
    <span class="min-w-0 truncate font-medium">{t('delegation.receivedTitle', { name: fromName })}</span>
    <span class="shrink-0 text-muted-foreground">·</span>
    <span class="shrink-0 text-muted-foreground">{t('delegation.viewDetail')}</span>
    <ArrowUpRight class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
  </button>
{:else}
  <!-- A 侧发出药丸：已委托 {B} 处理 · 状态 · 查看详情（活动期可取消）。 -->
  <span
    class="flex max-w-full items-center gap-1.5 rounded-full border border-border/40 bg-background/80 py-1 pr-1.5 pl-3 text-xs shadow-sm"
    data-testid={`delegation-sent-${delegationId}`}
    data-delegation-status={delegation.status}
    data-delegation-intent={delegation.intent}
    title={delegation.status === 'submitted'
      ? (delegation.intent === 'fyi' ? t('delegation.fyiQueuedHint') : t('delegation.queuedHint'))
      : delegation.taskText}
  >
    {#if delegation.status === 'working' || delegation.status === 'awaiting_tasks'}
      <Loader2 class="size-3.5 shrink-0 animate-spin text-sky-600" aria-hidden="true" />
    {:else if delegation.status === 'submitted'}
      <Clock class="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
    {:else if delegation.status === 'completed'}
      <CircleCheck class="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
    {:else}
      <CircleX
        class="size-3.5 shrink-0 text-destructive"
        aria-hidden="true"
      />
    {/if}
    <span class="min-w-0 truncate font-medium">{sentTitle}</span>
    <span class="shrink-0 text-muted-foreground">·</span>
    <span
      class="shrink-0 text-muted-foreground"
      data-testid="delegation-status-text">{statusText}</span
    >
    <button
      type="button"
      class="ml-0.5 flex cursor-pointer items-center gap-0.5 rounded-full px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      onclick={openDetail}
      data-testid="delegation-open-detail"
    >
      {t('delegation.viewDetail')}
      <ArrowUpRight class="size-3" aria-hidden="true" />
    </button>
    {#if active}
      <button
        type="button"
        class="cursor-pointer rounded-full px-2 py-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-50"
        disabled={cancelling}
        onclick={() => void cancel()}
        data-testid="delegation-cancel"
      >
        {t('delegation.cancelShort')}
      </button>
    {/if}
  </span>
{/if}

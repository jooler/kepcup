<script lang="ts">
import { onDestroy } from 'svelte';
import { ArrowLeft } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { ChatSession } from '$lib/stores/chat-session.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { delegations } from '$lib/stores/delegations.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
import { setChatSession } from '$lib/features/chats/chat-session-context';
import { contacts } from '$lib/stores/contacts.svelte';
import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import MessageList from '$lib/features/chats/MessageList.svelte';
  import { Button } from '$lib/components/ui/button';
  import { detailViewState } from './delegation-detail-view';

  /**
   * 委派交换会话详情视图（D71 v2 / D113，docs/design/27-butler-and-delegation.md
   * §3.2）：A ⇄ B 的直连对话，消息 UI 与普通对话一致（复用 MessageList 的
   * 后台会话模式，同看板卡片对话），底部没有输入框——交换会话由宿主写入，
   * 用户不可发言。由 ChatsArea 在 `delegations.openDetailId` 非空时整区替换
   * 对话区（任务执行过程页范式），关闭后返回原对话。
   */
  let { delegationId }: { delegationId: string } = $props();

  const session = new ChatSession(undefined, { foreground: false });
  setChatSession(session);
  // 交换会话里的任务卡点击 → 全局任务详情页（ChatsArea 里任务页压上时本视图
  // 只是隐藏，关闭任务页后回到这里）。
  session.openTask = (id: string) => {
    tasks.openDetail(id);
  };

  onDestroy(() => session.dispose());

  const delegation = $derived(delegations.byId[delegationId] ?? null);
  const fromName = $derived(
    delegation !== null ? (chat.botName(delegation.fromBotId) || delegation.fromBotId) : '',
  );
  const toName = $derived(
    delegation !== null ? (chat.botName(delegation.toBotId) || delegation.toBotId) : '',
  );
  // BotAvatar 的头像（预置 / 上传）取自 bot 记录的 avatar 字段，只传 botId 会
  // 落到首字母占位——这里从通讯录解析出两个 Bot 对象，把头像字段一并传入。
  const fromBot = $derived(
    delegation !== null ? (contacts.bots.find((b) => b.id === delegation.fromBotId) ?? null) : null,
  );
  const toBot = $derived(
    delegation !== null ? (contacts.bots.find((b) => b.id === delegation.toBotId) ?? null) : null,
  );
  const statusText = $derived(
    delegation === null
      ? ''
      : delegation.intent === 'fyi' && delegation.status === 'completed'
        ? t('delegation.fyiDelivered')
        : t(`delegation.status.${delegation.status}`),
  );
  const narrow = $derived(narrowLayout.narrow);
  const isMac = /Mac/i.test(navigator.platform);

  /** 打开中的会话 id：委派状态翻转密集时防止同一会话并发重复 open。 */
  let openingId: string | null = null;
  /** 交换会话已不存在（委派在、会话被清理）：正文退到不可用文案。 */
  let openFailed = $state(false);
  let openSettled = $state(false);

  $effect(() => {
    const id = delegation?.exchangeConversationId;
    if (id === null || id === undefined) return;
    if (openingId === id || session.conversation?.id === id) return;
    openingId = id;
    openFailed = false;
    openSettled = false;
    void session.open(id, { markOnOpen: true }).then((ok) => {
      if (openingId !== id) return;
      openSettled = true;
      if (ok === false) openFailed = true;
    });
  });

  const detailView = $derived(
    detailViewState({
      hasDelegation: delegation !== null,
      exchangeConversationId: delegation?.exchangeConversationId ?? null,
      openSettled,
      openFailed,
      messageCount: session.view?.messages.length ?? 0,
    }),
  );
</script>

<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="delegation-detail-view">
  <header
    class="app-drag flex h-14 shrink-0 items-center gap-2 border-b px-3 {narrow && isMac
      ? 'pl-20'
      : ''}"
    data-testid="delegation-detail-header"
  >
    <!-- 左侧圆形返回（样式同任务详情页左上角的返回按钮）：关掉详情回到原对话。 -->
    <Button
      variant="ghost"
      size="icon"
      class="app-no-drag size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
      onclick={() => delegations.closeDetail()}
      aria-label={t('delegation.backToChat')}
      title={t('delegation.backToChat')}
      data-testid="delegation-detail-back"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
    </Button>
    <span class="min-w-0 flex-1"></span>
    <!-- 标题药丸：与 Bot 消息顶部的药丸按钮同一外形（rounded-full + 描边 +
         阴影 + 毛玻璃），双 Bot 头像 + 名称；两侧 flex-1 让它严格居中。 -->
    <div
      class="app-no-drag flex h-10 min-w-0 items-center gap-1.5 rounded-full border border-border/25 bg-background py-0 pr-2.5 pl-1.5 text-sm font-medium shadow-xl backdrop-blur dark:border-input/25 dark:bg-background"
      data-testid="delegation-detail-title"
    >
      <BotAvatar
        botId={delegation?.fromBotId ?? ''}
        name={fromName}
        avatar={fromBot?.avatar ?? null}
        accentColor={fromBot?.accentColor ?? null}
        mask={fromBot?.avatarMask ?? null}
        padding={fromBot?.avatarPadding ?? null}
        class="size-7"
        fallbackClass="text-[10px]"
      />
      <span class="max-w-36 truncate">{fromName}</span>
      <span class="text-xs text-muted-foreground">⇄</span>
      <BotAvatar
        botId={delegation?.toBotId ?? ''}
        name={toName}
        avatar={toBot?.avatar ?? null}
        accentColor={toBot?.accentColor ?? null}
        mask={toBot?.avatarMask ?? null}
        padding={toBot?.avatarPadding ?? null}
        class="size-7"
        fallbackClass="text-[10px]"
      />
      <span class="max-w-36 truncate">{toName}</span>
      <span
        class="ml-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
        data-testid="delegation-detail-status">{statusText}</span
      >
    </div>
    <span class="min-w-0 flex-1"></span>
    <!-- 与左侧返回按钮对称的占位：标题药丸居中不被长名称挤偏。 -->
    <span class="size-8 shrink-0" aria-hidden="true"></span>
  </header>
  <div class="relative min-h-0 flex-1">
    {#if detailView === 'unavailable'}
      <div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {t('delegation.detailUnavailable')}
      </div>
    {:else if detailView === 'loading'}
      <div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {t('delegation.detailLoading')}
      </div>
    {:else if detailView === 'empty'}
      <!-- 免打扰 parked 的委派尚未投递：交换会话还没有任何消息。 -->
      <div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {t('delegation.detailEmpty')}
      </div>
    {:else}
      <MessageList topInset={4} />
    {/if}
  </div>
</div>

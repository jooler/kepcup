<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ArrowUp, Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { ChatSession } from '$lib/stores/chat-session.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { setChatSession } from '$lib/features/chats/chat-session-context';
  import ChatBanners from '$lib/features/chats/ChatBanners.svelte';
  import Composer from '$lib/features/chats/Composer.svelte';
  import MessageList from '$lib/features/chats/MessageList.svelte';
  import ApprovalDock from '$lib/features/approvals/ApprovalDock.svelte';
  import TaskRunView from '$lib/features/tasks/TaskRunView.svelte';
  import { board, type BoardCardView } from './board.svelte';

  /**
   * The card's own chat. A background session: it does not call `chat.select`
   * and does not touch the main task page. `openTask` shows the run inside
   * this column.
   */
  let {
    card,
    taskId = $bindable(null),
    highlightId = null,
  }: {
    card: BoardCardView;
    taskId?: string | null;
    highlightId?: string | null;
  } = $props();

  const session = new ChatSession(undefined, { foreground: false });
  setChatSession(session);
  session.openTask = (id: string) => {
    taskId = id;
  };

  let dockHeight = $state(0);
  const view = $derived(session.view);
  const hasMessages = $derived((view?.messages.length ?? 0) > 0);
  const name = $derived(card.todo.assignee?.name ?? '');

  onDestroy(() => session.dispose());

  $effect(() => {
    const id = card.conversationId;
    // A departed executor leaves a read-only thread and no assignee. Re-open
    // it if this session still has the writable copy, so the banner appears
    // without presenting that thread as the current chat.
    const blocked =
      card.todo.assignee === null && (card.todo.blockedReason?.trim().length ?? 0) > 0;
    if (id === null) return;
    const current = session.conversation;
    if (current?.id === id && (!blocked || current.readOnly === true)) return;
    void session.open(id, { markOnOpen: false }).then(() => markIfFocused());
  });

  $effect(() => {
    if (highlightId === null) return;
    session.highlightMessageId = highlightId;
  });

  $effect(() => {
    const onFocus = (): void => {
      void markIfFocused();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  async function markIfFocused(): Promise<void> {
    if (typeof document !== 'undefined' && !document.hasFocus()) return;
    if (shell.workbenchShown) return;
    await session.markRead();
    // `ChatSession.markRead` skips read-only rows. This thread is on screen,
    // so the cursor still moves; otherwise the badge comes back on reassign.
    const view = session.view;
    if (view?.conversation.readOnly) {
      const lastSeq = view.messages.at(-1)?.seq;
      if (lastSeq !== undefined && lastSeq > view.conversation.lastReadSeq) {
        await core.call('conversations.markRead', {
          conversationId: view.conversation.id,
          seq: lastSeq,
        });
        view.conversation = { ...view.conversation, lastReadSeq: lastSeq, unreadCount: 0 };
      }
    }
    board.noteCardRead(card.id);
  }
</script>

<div
  class="relative h-full min-h-0"
  data-testid="board-dialog-chat"
  data-conversation-id={card.conversationId ?? ''}
>
  {#if card.conversationId === null}
    <!-- 未指派：输入区照常渲染成只读占位，上层蒙层压住并给出提示。
         蒙层用 background 令牌，明暗主题各自动适配。 -->
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex-1" aria-hidden="true"></div>
      <div class="px-4 pb-3" aria-hidden="true">
        <div
          class="mx-auto flex w-full max-w-3xl items-center gap-1 rounded-3xl border bg-surface-raised px-1.5 py-0.5"
        >
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-50"
          >
            <Plus class="size-4" />
          </span>
          <span class="min-w-0 flex-1 px-1 py-2"></span>
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-muted-foreground"
          >
            <ArrowUp class="size-4" />
          </span>
        </div>
      </div>
    </div>
    <div
      class="absolute inset-0 z-30 flex items-center justify-center bg-background/60 px-6"
      data-testid="board-dialog-chat-mask"
    >
      <p class="text-center text-sm text-muted-foreground">
        {t('board.dialog.chat.emptyUnassigned')}
      </p>
    </div>
  {:else}
    <div class="relative h-full min-h-0" class:hidden={taskId !== null}>
      {#if view}
        <ChatBanners topClass="top-2" />
        {#if hasMessages}
          <MessageList topInset={8} bottomInset={dockHeight} />
        {/if}
        <div
          class="absolute inset-x-0 z-30 {hasMessages ? 'bottom-0' : 'top-1/2 -translate-y-1/2'}"
          bind:clientHeight={dockHeight}
        >
          <ApprovalDock conversationId={view.conversation.id} />
          <Composer
            readOnly={view.conversation.readOnly}
            centered={!hasMessages}
            placeholderText={t('board.dialog.chat.placeholder', { name })}
          />
        </div>
      {/if}
    </div>
    {#if taskId !== null}
      <div class="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
        <TaskRunView
          {taskId}
          onBack={() => (taskId = null)}
          approvalConversationId={card.conversationId}
        />
      </div>
    {/if}
  {/if}
</div>

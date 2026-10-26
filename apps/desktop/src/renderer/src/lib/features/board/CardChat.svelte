<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { ChatSession } from '$lib/stores/chat-session.svelte';
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
    if (id === null) return;
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
    await session.markRead();
    board.noteCardRead(card.id);
  }
</script>

<div class="relative h-full min-h-0" data-testid="board-dialog-chat">
  {#if card.todo.assignee === null}
    <p class="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {t('board.dialog.chat.emptyUnassigned')}
    </p>
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

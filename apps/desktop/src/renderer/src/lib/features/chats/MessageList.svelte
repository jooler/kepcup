<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { ChevronDown } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import GroupTurnStatusLine from './GroupTurnStatusLine.svelte';
  import MessageBubble from './MessageBubble.svelte';
  import RunStatusLine from './RunStatusLine.svelte';
  import SelectionPinToolbar from './SelectionPinToolbar.svelte';
  import TaskStatusLine from '$lib/features/tasks/TaskStatusLine.svelte';

  let { bottomInset = 0 }: { bottomInset?: number } = $props();

  let scrollContainer: HTMLElement | undefined = $state();
  let pinnedToBottom = $state(true);
  let showNewMessages = $state(false);
  let suppressScrollHandler = false;

  // 初始化问询的用户回答（setupAnswer）不渲染气泡——回答由问题卡片的已答行
  // 展示；消息本身仍在（上下文/引用/记忆证据都用得到）。
  const messages = $derived(
    (chat.current?.messages ?? []).filter(
      (m) => !(m.kind === 'text' && 'setupAnswer' in m.content && m.content.setupAnswer === true),
    ),
  );
  // 状态行签名：出现/让位/工具名切换都会改变列表末尾的排版。
  const statusSignature = $derived(
    (chat.current?.activeRuns ?? [])
      .map((e) => `${e.run.id}:${e.run.status}:${e.muted ? 1 : 0}:${e.toolName}:${e.progress}`)
      .join('|'),
  );

  /**
   * 连排键：同一发送者相邻的消息条目在视觉上拼成一组（对齐侧圆角缩小，
   * docs/design/12-ui-layout.md）。键相同且相邻才连排；居中的卡片/系统
   * pill/已撤回小字都断开连排。初始化访谈问题卡按 bot 侧气泡形态渲染，
   * 视作当前对话 bot 的发言参与连排。
   */
  function chainKey(message: Message): string | null {
    if (message.status === 'recalled') return null;
    if (message.kind === 'text') {
      if (message.senderType === 'user') return 'user';
      if (message.senderType === 'bot') return `bot:${message.senderBotId ?? ''}`;
      return null;
    }
    if (
      message.kind === 'system_event' &&
      'event' in message.content &&
      (message.content.event === 'bot_setup_question' ||
        message.content.event === 'bot_setup_path_question')
    ) {
      return `bot:${chat.current?.conversation.directBotId ?? ''}`;
    }
    return null;
  }
  const chainKeys = $derived(messages.map(chainKey));

  // D75 §6.3: turns keep their own (short) status line; tasks share one line.
  const turnEntries = $derived(
    (chat.current?.activeRuns ?? []).filter((entry) => entry.run.loopType !== 'task'),
  );
  const taskEntries = $derived(
    (chat.current?.activeRuns ?? []).filter((entry) => entry.run.loopType === 'task'),
  );

  // New message handling: follow when pinned, otherwise surface a hint.
  $effect(() => {
    void messages.length;
    if (suppressScrollHandler) {
      suppressScrollHandler = false;
      return;
    }
    if (pinnedToBottom) {
      queueMicrotask(() => scrollToBottom());
    } else {
      showNewMessages = true;
    }
    void chat.markRead();
  });

  // 输入坞高度变化（多行输入）时，若已贴底则保持贴底。
  $effect(() => {
    void bottomInset;
    if (pinnedToBottom) queueMicrotask(() => scrollToBottom());
  });

  // 状态行出现/让位/换文案改变列表末尾高度，贴底时保持贴底（下一条消息的
  // 位置就是状态行所在——docs/design/12-ui-layout.md 焦点二）。
  $effect(() => {
    void statusSignature;
    if (pinnedToBottom) queueMicrotask(() => scrollToBottom());
  });

  function scrollToBottom(): void {
    const el = scrollContainer;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function onScroll(): void {
    const el = scrollContainer;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const wasPinned = pinnedToBottom;
    pinnedToBottom = distance < 40;
    if (pinnedToBottom) {
      showNewMessages = false;
      void chat.markRead();
    } else if (wasPinned && distance > 40) {
      showNewMessages = true;
    }
  }

  function jumpToBottom(): void {
    pinnedToBottom = true;
    showNewMessages = false;
    scrollToBottom();
  }

  // Memory evidence jump: scroll to the highlighted message once it is
  // rendered, then clear the highlight after a short flash.
  $effect(() => {
    const id = chat.highlightMessageId;
    if (!id || !messages.some((message) => message.id === id)) return;
    queueMicrotask(() => {
      scrollContainer
        ?.querySelector(`[data-testid="message-${id}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
    const timer = setTimeout(() => {
      if (chat.highlightMessageId === id) chat.highlightMessageId = null;
    }, 4000);
    return () => clearTimeout(timer);
  });
</script>

<!-- 全高滚动：顶部药丸与底部输入坞都浮在本层之上，padding 让出其空间 -->
<div class="absolute inset-0 z-10">
  <div
    bind:this={scrollContainer}
    onscroll={onScroll}
    class="flex h-full flex-col gap-1 overflow-y-auto px-4 pt-14"
    style="padding-bottom: {bottomInset + 12}px;"
    data-testid="message-list"
  >
    {#if chat.current?.hasEarlier}
      <button
        type="button"
        class="mx-auto mb-2 rounded-md border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
        onclick={() => void chat.loadEarlier()}
        data-testid="load-earlier"
      >
        {chat.current?.loadingEarlier ? '…' : t('chats.loadEarlier')}
      </button>
    {/if}
    <!-- 内容区限宽居中，与输入药丸（max-w-3xl）同轴 -->
    <div class="mx-auto flex w-full max-w-3xl flex-col">
      {#each messages as message, index (message.id)}
        {@const showEdit = index === messages.length - 1}
        {@const key = chainKeys[index]}
        {@const merge = {
          above: key !== null && chainKeys[index - 1] === key,
          below: key !== null && chainKeys[index + 1] === key,
        }}
        <MessageBubble {message} editing={showEdit} {merge} />
      {/each}
      <!--
        执行状态行（12-ui-layout 焦点二）：排在消息流末尾——它的位置就是下
        一条消息会出现的位置；本 run 的消息落库时让位隐藏，下一个工具活动
        再出现（todo/loop-interim-updates.md）。
      -->
      {#if chat.current}
        {#if chat.current.conversation.type === 'group'}
          <GroupTurnStatusLine conversationId={chat.current.conversation.id} />
        {/if}
        {#each turnEntries as entry (entry.run.id)}
          <RunStatusLine {entry} />
        {/each}
        <TaskStatusLine entries={taskEntries} />
      {/if}
    </div>
  </div>

  {#if showNewMessages}
    <button
      type="button"
      class="absolute left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:bg-accent"
      style="bottom: {bottomInset + 12}px;"
      onclick={jumpToBottom}
      data-testid="new-messages-pill"
    >
      <ChevronDown class="size-4" />
    </button>
  {/if}

  <!-- 选中文本的浮动工具栏（浮层自身 portal 到 body）：container 限定只在消息列表内触发 -->
  <SelectionPinToolbar container={scrollContainer ?? null} />
</div>

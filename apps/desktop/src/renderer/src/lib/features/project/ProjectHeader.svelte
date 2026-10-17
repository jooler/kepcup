<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronLeft, Settings } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { episodes } from '$lib/stores/episodes.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { Button } from '$lib/components/ui/button';
  import { chatTabBadge } from './project-chat-badge';
  import ProjectMembersMenu from './ProjectMembersMenu.svelte';
  import ProjectTabs from './ProjectTabs.svelte';

  /**
   * 项目组两行实心顶栏（WP6 §4 步骤 4）：左两行（项目名 / 模块 tab），右一行
   * （成员头像堆叠 + 设置按钮）。整块是拖拽区，交互子元素 no-drag。
   */
  const current = $derived(chat.current);
  const narrow = $derived(narrowLayout.narrow);
  const isMac = /Mac/i.test(navigator.platform);
  const settingsActive = $derived(shell.projectView === 'settings');

  /**
   * 沟通 tab 的「已看到」游标（视图层概念，不动 conversations.markRead——当前会话
   * 的新消息仍照旧立刻已读）。在沟通视图时随用户所见推进；会话切换时重置为新会话
   * 的 lastSeq（chat.select() 已把视图收回 'chat'，这里按会话兜底）。
   */
  let seenSeq = $state(0);
  let seenConversationId: string | null = null;

  $effect(() => {
    const chatState = current;
    if (!chatState) return;
    if (chatState.conversation.id !== seenConversationId) {
      seenConversationId = chatState.conversation.id;
      seenSeq = untrack(() => chatState.conversation.lastSeq);
    }
    if (shell.projectView !== 'chat') return;
    // 用户正在看沟通：游标推进到已加载消息的最大 seq（新消息经事件实时进入列表）。
    let last = untrack(() => chatState.conversation.lastSeq);
    for (const message of chatState.messages) {
      if (message.seq > last) last = message.seq;
    }
    if (last > seenSeq) seenSeq = last;
  });

  const badge = $derived(
    chatTabBadge({
      messages: current?.messages ?? [],
      seenSeq,
      // 暂停中的协作回合也需要用户处理（WP8）：与待审批一起计入沟通徽标。
      pendingApprovals:
        permissions.pendingOf(current?.conversation.id).length +
        episodes.pausedCount(current?.conversation.id),
    }),
  );

  function toggleSettings(): void {
    if (shell.projectView === 'settings') shell.projectView = 'chat';
    else shell.openProjectSettings();
  }
</script>

<header
  class="app-drag flex shrink-0 items-center justify-between gap-3 border-b bg-background py-2 {narrow
    ? isMac
      ? 'pl-20 pr-3'
      : 'px-3'
    : 'px-4'}"
  data-testid="project-header"
>
  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
    <div class="flex min-w-0 items-center gap-1">
      {#if narrow}
        <Button
          variant="ghost"
          size="icon"
          class="app-no-drag size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          onclick={() => chat.leaveCurrent()}
          aria-label={t('narrow.back')}
          title={t('narrow.back')}
          data-testid="narrow-back-button"
        >
          <ChevronLeft class="size-5" aria-hidden="true" />
        </Button>
      {/if}
      <h1 class="truncate text-base font-medium" data-testid="project-title">
        {current?.conversation.title ?? t('project.untitled')}
      </h1>
    </div>
    <!-- tab 行窄屏横向滚动（overflow-x-auto 在 ProjectTabs 根上），不换行。 -->
    <ProjectTabs {badge} />
  </div>
  <div class="app-no-drag flex shrink-0 items-center gap-2">
    <ProjectMembersMenu />
    <Button
      variant="ghost"
      size="icon"
      class="size-8 {settingsActive ? 'bg-accent' : ''}"
      onclick={toggleSettings}
      aria-pressed={settingsActive}
      title={t('project.header.settings')}
      data-testid="project-settings-button"
    >
      <Settings class="size-4" aria-hidden="true" />
    </Button>
  </div>
</header>

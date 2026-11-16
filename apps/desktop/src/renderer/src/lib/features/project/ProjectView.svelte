<script lang="ts">
  import type { Snippet } from 'svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { composerDrafts } from '$lib/features/chats/composer-drafts.svelte';
  import { createFileDropZone } from '$lib/features/chats/file-drop.svelte';
  import FileDropOverlay from '$lib/features/chats/FileDropOverlay.svelte';
  import ModulePlaceholder from './ModulePlaceholder.svelte';
  import ProjectBoardView from './ProjectBoardView.svelte';
  import ProjectHeader from './ProjectHeader.svelte';
  import ProjectSettingsPage from './ProjectSettingsPage.svelte';
  import ProjectWikiView from './ProjectWikiView.svelte';

  /**
   * 项目组外壳（WP6 §1）：实心两行顶栏 + 内容区。沟通内容（chatBody snippet，由
   * ChatView 传入一份、两处渲染）**始终挂载**——其它视图显示时用 `hidden` 类隐
   * 藏而非卸载，保住输入草稿、滚动位置与未发送附件（§8 陷阱①）。
   */
  let { chatBody }: { chatBody: Snippet<[number, string]> } = $props();

  const current = $derived(chat.current);
  const view = $derived(shell.projectView);

  /**
   * 父视图级文件拖拽附加（file-drop.svelte.ts）：项目组整片区域（含顶栏与
   * 看板 / Wiki 页）拖入文件即附加到项目组会话——chatBody 里的输入坞始终挂载
   * （其它页只是 hidden），待发送 chips 回到对话页即见。门禁与输入坞一致：
   * 只读会话不收；拖到看板卡片自己的输入坞上时由药丸 drop 让位规则归卡片会话。
   */
  const fileDropZone = createFileDropZone({
    enabled: () => current !== null && !current.conversation.readOnly,
    onFiles: (files) => {
      const conversationId = current?.conversation.id;
      if (conversationId !== undefined) composerDrafts.uploadFiles(conversationId, files);
    },
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions --><!-- 整片 drop 区无指针交互语义；键盘路径走输入坞的 + 键 -->
<div
  class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
  data-testid="chat-view"
  data-project="true"
  data-readonly={current?.conversation.readOnly}
  ondragover={fileDropZone.onDragOver}
  ondragleave={fileDropZone.onDragLeave}
  ondrop={fileDropZone.onDrop}
>
  <ProjectHeader />
  <div class="relative min-h-0 min-w-0 flex-1" data-testid="project-view" data-view={view}>
    <div class="absolute inset-0 {view === 'chat' ? '' : 'hidden'}">
      {@render chatBody(12, 'top-3')}
    </div>
    {#if view === 'settings'}
      <ProjectSettingsPage conversationId={current?.conversation.id ?? ''} />
    {:else if view === 'wiki'}
      <!-- D92 T1b WP10: the Wiki tab's real view replaces the WP6 placeholder. -->
      <ProjectWikiView conversationId={current?.conversation.id ?? ''} />
    {:else if view === 'board'}
      <ProjectBoardView conversationId={current?.conversation.id ?? ''} />
    {:else if view !== 'chat'}
      <ModulePlaceholder module={view} />
    {/if}
  </div>
  <!-- 拖拽提示浮层：文件拖到视图上方时整片加罩（pointer-events-none）。 -->
  <FileDropOverlay active={fileDropZone.dragActive} />
</div>

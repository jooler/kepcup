<script lang="ts">
  import type { Snippet } from 'svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import ModulePlaceholder from './ModulePlaceholder.svelte';
  import ProjectHeader from './ProjectHeader.svelte';
  import ProjectSettingsPage from './ProjectSettingsPage.svelte';

  /**
   * 项目组外壳（WP6 §1）：实心两行顶栏 + 内容区。沟通内容（chatBody snippet，由
   * ChatView 传入一份、两处渲染）**始终挂载**——其它视图显示时用 `hidden` 类隐
   * 藏而非卸载，保住输入草稿、滚动位置与未发送附件（§8 陷阱①）。
   */
  let { chatBody }: { chatBody: Snippet<[number, string]> } = $props();

  const current = $derived(chat.current);
  const view = $derived(shell.projectView);
</script>

<div
  class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
  data-testid="chat-view"
  data-project="true"
  data-readonly={current?.conversation.readOnly}
>
  <ProjectHeader />
  <div class="relative min-h-0 flex-1" data-testid="project-view" data-view={view}>
    <div class="absolute inset-0 {view === 'chat' ? '' : 'hidden'}">
      {@render chatBody(12, 'top-3')}
    </div>
    {#if view === 'settings'}
      <ProjectSettingsPage conversationId={current?.conversation.id ?? ''} />
    {:else if view !== 'chat'}
      <ModulePlaceholder module={view} />
    {/if}
  </div>
</div>

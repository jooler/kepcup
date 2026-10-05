<script lang="ts">
  import * as Resizable from '$lib/components/ui/resizable';
  import ChatView from './ChatView.svelte';
  import RightPanel from '$lib/features/right-panel/RightPanel.svelte';
  import { shell } from '$lib/stores/shell.svelte';

  // 右栏的开合由聊天区顶部的 Bot 药丸接管（收起时药丸内出现「>」提示）。
  const rightCollapsed = $derived(shell.rightPanelCollapsed);
</script>

<div class="relative flex min-h-0 flex-1">
  <Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
    <Resizable.Pane defaultSize={65} minSize={40}>
      <ChatView />
    </Resizable.Pane>
    {#if !rightCollapsed}
      <!-- 分割线即 1px border（w-px bg-border），不再渲染拖拽手柄；拖拽热区由
           paneforge 的 after 扩展区保证 -->
      <Resizable.Handle />
      <Resizable.Pane defaultSize={41} minSize={20}>
        <RightPanel />
      </Resizable.Pane>
    {/if}
  </Resizable.PaneGroup>
</div>

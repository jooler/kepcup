<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as Resizable from '$lib/components/ui/resizable';
  import ChatView from './ChatView.svelte';
  import RightPanel from '$lib/features/right-panel/RightPanel.svelte';
  import TaskRunView from '$lib/features/tasks/TaskRunView.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';

  // 右栏的开合由聊天区顶部的 Bot 药丸接管（收起时药丸内出现「>」提示）。
  // 并排右栏放不下时（窗口窄于 聊天区最小宽 + 右栏最小宽 + 侧栏，sidebar-layout.ts）一律不
  // 渲染：Bot 药丸改开全屏 Bot 详情覆盖层（BotDetailOverlay），聊天区永远留得出可用宽度。
  // While the project compose is open the main area is not any conversation:
  // do not mount the previous conversation's right panel (collapse pref unchanged).
  // 项目组不渲染右栏（WP6 §4 步骤 5）：详情与成员都在项目外壳里，右栏只服务单聊。
  const rightCollapsed = $derived(
    shell.rightPanelCollapsed ||
      !sidebarLayout.panelFits ||
      chat.composingProject ||
      chat.current?.conversation.type === 'project',
  );
  // 窄屏（33-narrow-layout）：单栏，右栏不常驻——Bot 详情经顶部药丸以全屏
  // 覆盖层呈现（NarrowShell 渲染，不走这里的 Resizable 分栏）。
  const narrow = $derived(narrowLayout.narrow);

  // 离开本主区（切工作台 / 窄屏换 tab / 宽窄切换重挂载）即退出任务执行过程页；
  // 会话切换由 chat.select / leaveCurrent / close 收起。
  onDestroy(() => tasks.closeDetail());
</script>

<!-- 任务执行过程页（docs/design/42-task-run-view.md）：原对话组件保留在 DOM
     里（display:none），避免卸载导致草稿、滚动位置与右栏状态丢失。 -->
<div
  class="relative flex min-h-0 flex-1"
  style:display={tasks.openTaskId !== null ? 'none' : 'flex'}
>
  {#if narrow}
    <ChatView />
  {:else}
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
  {/if}
</div>

{#if tasks.openTaskId !== null}
  {#key tasks.openTaskId}
    <TaskRunView taskId={tasks.openTaskId} />
  {/key}
{/if}

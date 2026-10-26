<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { PaneAPI } from 'paneforge';
  import * as Resizable from '$lib/components/ui/resizable';
  import ChatView from './ChatView.svelte';
  import RightPanel from '$lib/features/right-panel/RightPanel.svelte';
  import TaskRunView from '$lib/features/tasks/TaskRunView.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import { motionMs, MOTION } from '$lib/motion';

  /**
   * 右栏（Bot 详情）按抽屉方式开合：pane 常驻、宽度在 0 与 41% 之间过渡
   * （paneforge 折叠时会等元素上 flex-grow 的 transitionend）；内容只在展开时
   * 挂载，收起后等动画结束再卸载，避免收起期间还在跑订阅与数据加载。
   *
   * 右栏的开合由聊天区顶部的 Bot 药丸接管（收起时药丸内出现「>」提示）。
   * 并排右栏放不下时（窗口窄于 聊天区最小宽 + 右栏最小宽 + 侧栏，sidebar-layout.ts）一律
   * 不渲染：Bot 药丸改开全屏 Bot 详情覆盖层（BotDetailOverlay），聊天区永远留得出可用宽度。
   * While the project compose is open the main area is not any conversation:
   * do not mount the previous conversation's right panel (collapse pref unchanged).
   * 项目组不渲染右栏（WP6 §4 步骤 5）：详情与成员都在项目外壳里，右栏只服务单聊。
   */
  const rightCollapsed = $derived(
    shell.rightPanelCollapsed ||
      !sidebarLayout.panelFits ||
      chat.composingProject ||
      chat.current?.conversation.type === 'project',
  );
  // 窄屏（33-narrow-layout）：单栏，右栏不常驻——Bot 详情经顶部药丸以全屏
  // 覆盖层呈现（NarrowShell 渲染，不走这里的 Resizable 分栏）。
  const narrow = $derived(narrowLayout.narrow);

  /** 展开后的默认占比；也是每次收起后 expand() 恢复的目标宽度。 */
  const PANEL_DEFAULT_SIZE = 41;

  let rightPane = $state<PaneAPI | null>(null);
  /**
   * 内容是否挂载：展开即挂载；收起时保留到折叠动画结束再卸载，抽屉才有东西可滑出。
   * 卸载而不是常驻——收起后不再运行 RightPanel 的订阅与数据加载。
   */
  let panelPresent = $state(false);
  /** 当前 pane 实例是否已经按默认宽度摆过一次（重新挂载时 expand() 只会给 minSize）。 */
  let sizedPane: PaneAPI | null = null;
  /** 拖拽手柄时关掉过渡，宽度逐帧跟手。 */
  let resizing = $state(false);
  /** 分组在挂载后一帧才归一化初始布局，那一帧不能过渡，否则启动时两栏会滑一下。 */
  let motionReady = $state(false);

  $effect(() => {
    if (!rightCollapsed) {
      panelPresent = true;
      return;
    }
    if (!panelPresent) return;
    // 折叠动作在下一帧才下发，卸载比过渡多留一帧。
    const timer = setTimeout(() => (panelPresent = false), motionMs(MOTION.enter) + 40);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const pane = rightPane;
    const collapsed = rightCollapsed;
    if (pane === null || !motionReady) return;
    // 再等一帧：registerPane 在子组件 onMount 里登记，分组要到本批次 effect
    // 结算后才算出 layout，这里直接 resize 会拿到空布局。
    const frame = requestAnimationFrame(() => {
      if (collapsed) {
        if (!pane.isCollapsed()) pane.collapse();
        return;
      }
      if (sizedPane !== pane) {
        sizedPane = pane;
        pane.resize(PANEL_DEFAULT_SIZE);
        return;
      }
      pane.expand();
    });
    return () => cancelAnimationFrame(frame);
  });

  onMount(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => (motionReady = true));
    });
    return () => cancelAnimationFrame(frame);
  });

  const paneTransition = $derived(
    motionReady && !resizing ? 'transition-[flex-grow] duration-200 ease-out' : '',
  );

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
      <Resizable.Pane defaultSize={65} minSize={40} class={paneTransition}>
        <ChatView />
      </Resizable.Pane>
      {#if !rightCollapsed}
        <!-- 分割线即 1px border（w-px bg-border），不再渲染拖拽手柄；拖拽热区由
             paneforge 的 after 扩展区保证。拖拽中关掉 flex-grow 过渡才能跟手。 -->
        <Resizable.Handle onDraggingChange={(dragging) => (resizing = dragging)} />
      {/if}
      <!-- 收起态 defaultSize 0：挂载即闭合，展开时 resize 到 41% 才有动画。 -->
      <Resizable.Pane
        bind:this={rightPane}
        defaultSize={0}
        minSize={20}
        collapsible
        collapsedSize={0}
        class={paneTransition}
      >
        {#if panelPresent}
          <!-- 收起时宽度为 0，内容留到折叠动画结束；inert 防止焦点落到不可见控件上。 -->
          <div class="h-full min-h-0" inert={rightCollapsed}>
            <RightPanel />
          </div>
        {/if}
      </Resizable.Pane>
    </Resizable.PaneGroup>
  {/if}
</div>

{#if tasks.openTaskId !== null}
  {#key tasks.openTaskId}
    <TaskRunView taskId={tasks.openTaskId} />
  {/key}
{/if}

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import type { PaneAPI } from 'paneforge';
  import * as Resizable from '$lib/components/ui/resizable';
  import ChatView from './ChatView.svelte';
  import RightPanel from '$lib/features/right-panel/RightPanel.svelte';
  import TaskRunView from '$lib/features/tasks/TaskRunView.svelte';
  import DelegationDetailView from '$lib/features/delegations/DelegationDetailView.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { delegations } from '$lib/stores/delegations.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import {
    PANEL_DRAWER_WIDTH,
    WIDE_RIGHT_PANEL_DEFAULT_SHARE,
  } from '$lib/features/sidebar/sidebar-layout';
  import {
    blurEditableTarget,
    ESCAPE_PRIORITY,
    registerEscapeLayer,
  } from '$lib/features/shell/escape-layers';
  import { motionMs, MOTION } from '$lib/motion';
  import { t } from '$lib/i18n';

  /**
   * 右栏（Bot 详情）在宽屏下的两种形态 + 窄屏第三种（33-narrow-layout）：
   * - 窗口够宽（对话可用宽 ≥ 舒适线，带滞回见 nextPanelDrawer）：PaneGroup 并排
   *   ——pane 常驻、宽度在 0 与默认占比之间过渡（paneforge 折叠时会等元素上
   *   flex-grow 的 transitionend）；内容只在展开时挂载，收起后等动画结束再卸载。
   * - 宽屏中窄：并排会把对话区挤到舒适宽以下，右栏 pane 收起、对话占满剩余宽度，
   *   右栏内容以固定宽覆盖抽屉浮在右侧（遮罩点击 / Esc 关闭）。抽屉与并排共用
   *   同一个宿主 div（只换 class，不换 {#if} 分支）：跨阈值拖窗口时 RightPanel
   *   不重挂载，未提交的草稿 / 下钻状态不丢；开合仍归 shell.rightPanelCollapsed，
   *   药丸 / 深链（openBotPanel / openSchedules）在两种形态下行为一致。
   * - 窄屏：单栏，右栏不常驻——Bot 详情经顶部药丸以全屏覆盖层呈现
   *   （NarrowShell 渲染，不走这里的 Resizable 分栏）。
   * 右栏的开合由聊天区顶部的 Bot 药丸接管（收起时药丸内出现「>」提示）。
   * While the project compose is open the main area is not any conversation:
   * do not mount the previous conversation's right panel (collapse pref unchanged).
   * 项目组不渲染右栏（WP6 §4 步骤 5）：详情与成员都在项目外壳里，右栏只服务单聊。
   */
  const rightCollapsed = $derived(
    shell.rightPanelCollapsed ||
      chat.composingProject ||
      chat.current?.conversation.type === 'project',
  );
  const narrow = $derived(narrowLayout.narrow);
  /** 宽屏中窄：右栏改覆盖抽屉（见 sidebarLayout.panelAsDrawer）。 */
  const drawerMode = $derived(sidebarLayout.panelAsDrawer);
  /** 抽屉形态下右栏是否可见（开着）。 */
  const drawerOpen = $derived(drawerMode && !rightCollapsed);

  /** 展开后的默认占比；也是每次收起后 expand() 恢复的目标宽度（单一来源见 sidebar-layout）。 */
  const PANEL_DEFAULT_SIZE = Math.round(WIDE_RIGHT_PANEL_DEFAULT_SHARE * 100);

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

  /** 抽屉滑入 / 滑出参数；并排形态时长 0（显隐由 pane 的 flex-grow 过渡承担）。 */
  const panelFlyIn = $derived(
    drawerMode ? { x: 48, duration: motionMs(MOTION.enter) } : { x: 0, duration: 0 },
  );
  const panelFlyOut = $derived(
    drawerMode ? { x: 48, duration: motionMs(MOTION.exit) } : { x: 0, duration: 0 },
  );

  $effect(() => {
    if (!rightCollapsed) {
      panelPresent = true;
      return;
    }
    if (!panelPresent) return;
    // 折叠动作在下一帧才下发，卸载比过渡多留一帧（抽屉滑出 140ms，足够）。
    const timer = setTimeout(() => (panelPresent = false), motionMs(MOTION.enter) + 40);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const pane = rightPane;
    const collapsed = rightCollapsed;
    const drawer = drawerMode;
    if (pane === null || !motionReady) return;
    // 再等一帧：registerPane 在子组件 onMount 里登记，分组要到本批次 effect
    // 结算后才算出 layout，这里直接 resize 会拿到空布局。
    const frame = requestAnimationFrame(() => {
      // 抽屉形态：pane 恒收起（对话占满，右栏由宿主 div 浮层定位渲染）。
      if (drawer || collapsed) {
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

  // 抽屉开着时 Esc 收抽屉（escape-layers 仲裁：行内编辑 / bits-ui 弹层已处理的
  // Esc 不再关抽屉；优先级对齐 BotDetailOverlay 的全屏覆盖层）。
  $effect(() => {
    if (!drawerOpen) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.overlay,
      onEscape: (event) => {
        if (blurEditableTarget(event)) return;
        shell.rightPanelCollapsed = true;
      },
    });
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

  // 离开本主区（切工作台 / 窄屏换 tab / 宽窄切换重挂载）即退出任务执行过程页与
  // 委派详情视图，但按会话保留任务记忆：重新进入该会话时恢复（切会话由 chat.select
  // 处理关详情）。
  onDestroy(() => {
    tasks.enterConversation(null);
    delegations.closeDetail();
  });
</script>

<!-- 中间区的三个互斥视图（对话 / 委派详情 / 任务详情，docs/design/42、27 §3.2）：
     原对话组件保留在 DOM 里（display:none），避免卸载导致草稿、滚动位置丢失。
     委派详情同样常驻：详情里的任务卡点击进入任务页时详情只是隐藏（不卸载，返回
     后滚动位置与会话状态都在），离开聊天区或切会话才关闭。
     D116 修订：任务详情页不再占满除左栏外的整区——三个视图都收进中间对话 pane，
     右栏（Bot 详情）保持可见；窄屏仍是单栏全屏层。 -->
{#snippet mainViews()}
  <div
    class="relative flex min-h-0 min-w-0 flex-1"
    style:display={tasks.openTaskId !== null || delegations.openDetailId !== null ? 'none' : 'flex'}
  >
    <ChatView />
  </div>
  {#if delegations.openDetailId !== null}
    <div
      class="relative flex min-h-0 min-w-0 flex-1"
      style:display={tasks.openTaskId !== null ? 'none' : 'flex'}
    >
      {#key delegations.openDetailId}
        <DelegationDetailView delegationId={delegations.openDetailId} />
      {/key}
    </div>
  {/if}
  {#if tasks.openTaskId !== null}
    {#key tasks.openTaskId}
      <TaskRunView taskId={tasks.openTaskId} />
    {/key}
  {/if}
{/snippet}

{#if narrow}
  <!-- 窄屏（33-narrow-layout）：单栏，视图互斥占满；Bot 详情走全屏覆盖层。 -->
  <div class="relative flex min-h-0 min-w-0 flex-1">
    {@render mainViews()}
  </div>
{:else}
  <!-- 宽屏：relative 定位上下文供抽屉（absolute）与遮罩取位。 -->
  <div class="relative flex min-h-0 min-w-0 flex-1">
    <Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
      <!-- 抽屉开着时对话区在遮罩（z-30）之下：inert 挡住焦点与点击落到被盖住的控件。 -->
      <Resizable.Pane defaultSize={65} minSize={40} class={paneTransition}>
        <div class="flex h-full min-h-0 flex-col" inert={drawerOpen}>
          {@render mainViews()}
        </div>
      </Resizable.Pane>
      {#if !rightCollapsed && !drawerMode}
        <!-- 分割线即右栏 border-l（1px）；hover / 拖拽时 Handle 组件内的高亮
             分隔线条会盖住它并亮出指示胶囊与提示气泡。拖拽中关掉 flex-grow
             过渡才能跟手。抽屉形态没有并排分割线：手柄只在并排形态渲染。 -->
        <Resizable.Handle
          label={t('chats.resizeHandleDrag')}
          onDraggingChange={(dragging) => (resizing = dragging)}
        />
      {/if}
      <!-- 收起态 defaultSize 0：挂载即闭合，展开时 resize 到默认占比才有动画；
           抽屉形态下 pane 恒收起（对话占满），右栏由宿主 div 浮层渲染。 -->
      <Resizable.Pane
        bind:this={rightPane}
        defaultSize={0}
        minSize={20}
        collapsible
        collapsedSize={0}
        class={paneTransition}
      >
        {#if panelPresent}
          <!-- 收起时宽度为 0，内容留到折叠动画结束；inert 防止焦点落到不可见控件上。
               抽屉形态：同一宿主 div 只换 class（absolute 贴右、固定宽、投影），
               深链「打开后切到任务详情」也不丢 RightPanel 内的未提交草稿。
               border-l 由 RightPanel 自身的 aside 提供（非覆盖层形态），这里不重复。 -->
          <div
            class="h-full min-h-0 bg-background {drawerMode
              ? 'absolute inset-y-0 right-0 z-40 shadow-2xl'
              : ''}"
            style:width={drawerMode ? `${PANEL_DRAWER_WIDTH}px` : undefined}
            inert={rightCollapsed}
            in:fly={panelFlyIn}
            out:fly={panelFlyOut}
          >
            <RightPanel />
          </div>
        {/if}
      </Resizable.Pane>
    </Resizable.PaneGroup>
    {#if drawerOpen}
      <!-- 背板遮罩：点击关闭（Esc 走 escape-layers，见上方 effect）。DOM 在
           PaneGroup 之后：与主区内的浮层同 z-30 时后者先出现、遮罩盖住它们。
           抽屉本体 z-40，压在遮罩之上（右侧 360px 不受遮罩影响）。 -->
      <button
        type="button"
        class="absolute inset-0 z-30 bg-black/30"
        onclick={() => (shell.rightPanelCollapsed = true)}
        transition:fade={{ duration: motionMs(MOTION.enter) }}
        aria-label={t('shell.rightPanelHide')}
      ></button>
    {/if}
  </div>
{/if}

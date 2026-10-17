<script lang="ts">
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import RightPanel from '$lib/features/right-panel/RightPanel.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import { narrowLayout } from './narrow-layout.svelte';
  import { blurEditableTarget, ESCAPE_PRIORITY, registerEscapeLayer } from './escape-layers';

  /**
   * Bot 详情全屏覆盖层（宽屏右栏的 RightPanel 内容）。挂在 App 根而不是 NarrowShell：
   * 宽屏但窗口放不下并排右栏时（sidebarLayout.panelAsOverlay）Bot 药丸同样开这一层，
   * 且覆盖层不随宽 / 窄分支的整树重挂载而丢失（RightPanel 里未提交的 draft 保留）。
   *
   * 不变量（本组件负责维护，调用方无需操心）：
   * - 仅在「需要覆盖层」的形态下存在：并排右栏放得下时（宽屏、窗口够宽）自动收起。
   * - 没有打开的会话时不存在：在覆盖层里「移除 Bot」、或会话被其他端删除后 chat.currentId
   *   变 null，覆盖层不能留成空壳（tab 栏因覆盖层被隐藏，用户只能点 ✕）。
   * - Esc：经 escape-layers 仲裁——内部控件（行内改名 / 简介、头像选择器）和 bits-ui 弹层
   *   已处理的 Esc 不再关覆盖层；输入框里的 Esc 只失焦。
   *
   * z-40，低于设置页 / 搜索层（z-50）；根节点声明 app-no-drag，盖掉下层会话头部
   *（h-16 的 app-drag）延伸到头像按钮上方的 drag 矩形——RightPanel 自己的顶栏（h-12）再声明 drag。
   */
  const open = $derived(narrowLayout.botDetailOpen);
  // 其上还有全屏层（设置页 / 搜索层，z-50）时本层不可聚焦，Tab 不会跑到被盖住的控件上。
  const covered = $derived(shell.narrowSettingsOpen || (narrowLayout.narrow && shell.searchOpen));

  $effect(() => {
    if (open && !sidebarLayout.panelAsOverlay) narrowLayout.closeBotDetail();
  });

  $effect(() => {
    if (open && chat.currentId === null) narrowLayout.closeBotDetail();
  });

  // 项目组会话没有药丸，也不打开 Bot 详情覆盖层（WP6 §4 步骤 5）：切换到项目组
  // 时开着的话立即收起，不留空壳。
  $effect(() => {
    if (open && chat.current?.conversation.type === 'project') narrowLayout.closeBotDetail();
  });

  $effect(() => {
    if (!open) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.overlay,
      onEscape: (event) => {
        if (blurEditableTarget(event)) return;
        narrowLayout.closeBotDetail();
      },
    });
  });
</script>

{#if open}
  <Tooltip.Provider delayDuration={0}>
    <div
      class="app-no-drag fixed inset-0 z-40 bg-background"
      inert={covered}
      data-testid="narrow-bot-detail"
    >
      <RightPanel />
    </div>
  </Tooltip.Provider>
{/if}

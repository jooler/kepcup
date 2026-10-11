<script lang="ts">
  import ExtensionCenterBody from '$lib/features/extension-center/ExtensionCenterBody.svelte';
  import NarrowPage from './NarrowPage.svelte';

  /**
   * 窄屏「扩展」tab 页（33-narrow-layout）：扩展中心的三个分组（Skills / 连接 /
   * MCP）以整页呈现，不再是弹框——分组主体与弹框共用 ExtensionCenterBody，当前
   * 分组在 shell store 里互通。各分组内容自己管理滚动（页面骨架不滚动）。
   * 顶部只有红绿灯拖拽带（不渲染标题，见 NarrowPage）。
   *
   * 水平内边距在这里补：弹框形态由 DialogContent 的 p-4 提供，ExtensionSkills
   * 等分组内容自身不带内边距，直接平铺会顶到窗口边缘。
   */
</script>

<NarrowPage testid="narrow-extensions-page" scroll={false}>
  <div class="flex min-h-0 flex-1 flex-col px-4">
    <ExtensionCenterBody />
  </div>
</NarrowPage>

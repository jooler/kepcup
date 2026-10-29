<script lang="ts">
  import McpSection from '$lib/features/settings/McpSection.svelte';

  /**
   * 扩展中心 →「工具」内容视图：MCP 的完整管理（新建 stdio / HTTP / SSE、启停、
   * 逐工具策略、编辑、删除、BYO OAuth 客户端、原始工具定义 / 授权日志）+ MCPB 本地包安装。
   * （MCP 精选清单空壳已随 D104 删除；预置 MCP 的发现与分发由插件市场承担。）
   * D105 P4：从插件卡「管理 · 工具」进入时带 `pluginId`——列表只显示该插件投影的
   * server，新建 / .mcpb 安装等全局入口隐藏（那是无圈定时的全局能力）。
   */
  let {
    embedded = false,
    pluginId = undefined,
  }: { embedded?: boolean; pluginId?: string | undefined } = $props();
</script>

<div
  class={embedded ? 'pt-3' : 'min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5'}
  data-testid="extension-mcp"
>
  <!-- McpSection 不收 embedded：它的 embedded 是设置卡片段形态（只改一个开关），
       扩展中心内容视图要的是完整管理区（pluginId 圈定）。 -->
  <McpSection {pluginId} />
</div>

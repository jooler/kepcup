<script lang="ts">
  import McpSection from '$lib/features/settings/McpSection.svelte';

  /**
   * 扩展中心 →「MCP」分组：已安装 MCP 的完整管理（新建 stdio / HTTP / SSE、启停、
   * 逐工具策略、编辑、删除、BYO OAuth 客户端、原始工具定义 / 授权日志）+ MCPB 本地包安装。
   * （MCP 精选清单空壳已随 D104 删除；预置 MCP 的发现与分发由插件市场承担。）
   */
  /** embedded：嵌进「已安装」的 MCP 筛选视图（不再是独立页签），去掉自带的滚动容器。 */
  let { embedded = false }: { embedded?: boolean } = $props();
</script>

<div
  class={embedded ? 'pt-3' : 'min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5'}
  data-testid="extension-mcp"
>
  <McpSection />
</div>

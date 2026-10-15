<script lang="ts">
  import McpSection from '$lib/features/settings/McpSection.svelte';

  /**
   * 扩展中心 →「MCP」分组：已安装 MCP 的完整管理（新建 stdio / HTTP / SSE、启停、
   * 逐工具策略、编辑、删除、BYO OAuth 客户端、原始工具定义 / 授权日志）+ MCPB 本地包安装。
   * 精选清单（`resources/mcp-presets/catalog.json`）首期为空；有预置条目后再在此处渲染卡片。
   */
</script>

<div class="min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5" data-testid="extension-mcp">
  <McpSection variant="full" />
</div>

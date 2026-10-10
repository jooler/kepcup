<script lang="ts">
  import McpSection from '$lib/features/settings/McpSection.svelte';

  /**
   * 扩展中心 →「MCP」分组（X4，设计 29 §16，决定 C）：首期 = 已安装 MCP 的管理（启停 / 状态 /
   * 逐工具策略 / 编辑 / 删除）+ MCPB 本地包安装，复用设置里的 McpSection（`manage` 形态：
   * 没有「新建 server」入口）。精选清单（`resources/mcp-presets/catalog.json`，schema 与
   * 加载器见 core `mcp/presets.ts`）首期为空；等有第一个值得预置的无 OAuth MCP 再填，
   * 届时在此处按清单渲染卡片——清单为空时只显示管理视图。
   */
</script>

<div class="min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5" data-testid="extension-mcp">
  <McpSection variant="manage" />
</div>

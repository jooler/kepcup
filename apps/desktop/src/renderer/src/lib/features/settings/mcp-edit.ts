/**
 * 扩展中心「MCP」分组（`manage` 形态）里编辑已安装 server 的限制（设计 29 §16.2）：开发者模式
 * 关闭时，连接目标——传输方式 / 命令 / 参数 / URL——只读（名称、启停、密钥值照常可改），
 * 这样普通界面不能把一个已有 server 悄悄改指向任意地址或命令。开发者模式开启，或在设置 →
 * 开发者模式分区里编辑（`full` 形态）时不受限；新建（无 editingId）只在 `full` 形态存在。
 */
export function mcpTargetLocked(input: {
  variant: 'manage' | 'full';
  developerMode: boolean;
  editing: boolean;
}): boolean {
  return input.editing && input.variant === 'manage' && !input.developerMode;
}

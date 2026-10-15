/**
 * 扩展中心「MCP」分组编辑已安装 server 时是否锁定连接目标（命令 / 参数 / URL）。
 * 自定义 MCP 已整体迁到扩展中心、不再挂开发者模式门禁后，编辑一律可改目标。
 * 保留函数与 `manage`/`full` 入参是为了调用方与旧单测形状稳定；恒返回 false。
 */
export function mcpTargetLocked(_input: {
  variant: 'manage' | 'full';
  developerMode: boolean;
  editing: boolean;
}): boolean {
  return false;
}

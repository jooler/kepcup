/**
 * 扩展中心（原技能市场）的分组：Skills / 连接 / MCP。纯函数，便于单测；shell store、
 * 弹框与各入口（`openExtensionCenter(tab)`）共用。
 */
export type ExtensionCenterTab = 'skills' | 'connections' | 'mcp';

export const EXTENSION_CENTER_TABS: readonly ExtensionCenterTab[] = [
  'skills',
  'connections',
  'mcp',
];

/** WAI-ARIA tabs 的键盘导航：左右方向键循环，Home / End 到两端；其他键返回 null（不处理）。 */
export function extensionTabForKey(
  current: ExtensionCenterTab,
  key: string,
): ExtensionCenterTab | null {
  const last = EXTENSION_CENTER_TABS.length - 1;
  const index = Math.max(0, EXTENSION_CENTER_TABS.indexOf(current));
  switch (key) {
    case 'ArrowRight':
      return EXTENSION_CENTER_TABS[index >= last ? 0 : index + 1]!;
    case 'ArrowLeft':
      return EXTENSION_CENTER_TABS[index <= 0 ? last : index - 1]!;
    case 'Home':
      return EXTENSION_CENTER_TABS[0]!;
    case 'End':
      return EXTENSION_CENTER_TABS[last]!;
    default:
      return null;
  }
}

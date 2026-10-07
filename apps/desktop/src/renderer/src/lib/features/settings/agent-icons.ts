/**
 * 智能体目录图标（D72 §2.1「图标随应用打包，不在运行时拉 CDN」）：
 * `apps/desktop/resources/agents/*.svg` 经 Vite 打进渲染层，按目录条目的
 * `icon` 文件名查找；缺图标时组件回落为名称首字母。
 */
const icons = import.meta.glob('../../../../../../resources/agents/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export function agentIconUrl(icon: string): string | null {
  const hit = Object.entries(icons).find(([file]) => file.endsWith(`/${icon}`));
  return hit?.[1] ?? null;
}

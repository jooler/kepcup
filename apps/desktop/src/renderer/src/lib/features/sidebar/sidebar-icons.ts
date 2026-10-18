/**
 * 侧栏图标：`apps/desktop/resources/sidebar/*.svg` 经 Vite 打进渲染层。
 * 工作台入口图标（与 D72 智能体图标同口径）与品牌 logo 都提供明 / 暗两套
 * 实色稿，按 `html.dark` 切换。
 */
const icons = import.meta.glob('../../../../../../resources/sidebar/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function urlEndingWith(suffix: string): string {
  const hit = Object.entries(icons).find(([file]) => file.endsWith(suffix));
  if (hit === undefined) {
    throw new Error(`sidebar icon missing: ${suffix}`);
  }
  return hit[1];
}

/** 亮色主题用的工作台图标（深色字形）。 */
export const workbenchIconLightUrl = urlEndingWith('/workbench-light.svg');
/** 暗色主题用的工作台图标（浅色字形）。 */
export const workbenchIconDarkUrl = urlEndingWith('/workbench-dark.svg');

/** 亮色主题用的品牌 logo（深色字形，无背景）。 */
export const logoLightUrl = urlEndingWith('/logo-light.svg');
/** 暗色主题用的品牌 logo（浅色字形，无背景）。 */
export const logoDarkUrl = urlEndingWith('/logo-dark.svg');

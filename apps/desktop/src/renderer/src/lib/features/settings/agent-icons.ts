import claudeColor from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import codexColor from '@lobehub/icons-static-svg/icons/codex-color.svg?url';
import deepseekColor from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import antigravityColor from '@lobehub/icons-static-svg/icons/antigravity-color.svg?url';
import qwenColor from '@lobehub/icons-static-svg/icons/qwen-color.svg?url';
import devinColor from '@lobehub/icons-static-svg/icons/devin-color.svg?url';
import opencodeMono from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import cursorMono from '@lobehub/icons-static-svg/icons/cursor.svg?url';
import clineMono from '@lobehub/icons-static-svg/icons/cline.svg?url';
import githubCopilotMono from '@lobehub/icons-static-svg/icons/githubcopilot.svg?url';
import gooseMono from '@lobehub/icons-static-svg/icons/goose.svg?url';
import kimiMono from '@lobehub/icons-static-svg/icons/kimi.svg?url';
import grokMono from '@lobehub/icons-static-svg/icons/grok.svg?url';

/**
 * 智能体目录图标（D72 §2.1「图标随应用打包，不在运行时拉 CDN」）。
 *
 * 品牌图标取自 `@lobehub/icons-static-svg`（@lobehub/icons 的静态 SVG 包，
 * 随应用打包）：有品牌色的用 `*-color`；只有单色标记的用 mono（`currentColor`
 * 在 `<img>` 里会退化成黑色，暗色主题下不可见），由 `AgentIcon` 以 CSS mask
 * 按前景色渲染，跟随明暗主题。目录里自己的条目（fake / InkCop）仍用
 * `apps/desktop/resources/agents/*.svg`，按 `icon` 文件名查找；缺图标时
 * 组件回落为名称首字母。
 */
export interface AgentIconAsset {
  url: string;
  /** true = 单色标记，按当前文字颜色渲染（CSS mask），不能用 <img>。 */
  mono: boolean;
}

const BRAND_ICONS: Record<string, AgentIconAsset> = {
  'claude-acp.svg': { url: claudeColor, mono: false },
  'codex-acp.svg': { url: codexColor, mono: false },
  'dsh.svg': { url: deepseekColor, mono: false },
  'antigravity-acp.svg': { url: antigravityColor, mono: false },
  'qwen-code.svg': { url: qwenColor, mono: false },
  'devin.svg': { url: devinColor, mono: false },
  'opencode.svg': { url: opencodeMono, mono: true },
  'cursor.svg': { url: cursorMono, mono: true },
  'cline.svg': { url: clineMono, mono: true },
  'github-copilot-cli.svg': { url: githubCopilotMono, mono: true },
  'goose.svg': { url: gooseMono, mono: true },
  'kimi.svg': { url: kimiMono, mono: true },
  'grok-build.svg': { url: grokMono, mono: true },
};

const bundled = import.meta.glob('../../../../../../resources/agents/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export function agentIcon(icon: string): AgentIconAsset | null {
  const brand = BRAND_ICONS[icon];
  if (brand !== undefined) return brand;
  const hit = Object.entries(bundled).find(([file]) => file.endsWith(`/${icon}`));
  return hit === undefined ? null : { url: hit[1], mono: false };
}

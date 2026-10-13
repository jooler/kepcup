import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SettingsUiScan } from '../../src/index.js';

/**
 * 扫渲染层源码得到设置界面位置（设置目录覆盖率测试用，todo/conversational-app-setup.md §4.3）。
 * 宽松解析：只认 `data-settings-anchor` / `data-settings-section` 属性、扩展中心
 * `EXTENSION_CENTER_TABS` 与 RightPanel `tabItems` 的字面量；HTML / 块注释先剥掉；
 * 模板串里的动态锚点（`agent-${id}`）记成「静态前缀*」。
 */

export const FEATURES_DIR = fileURLToPath(
  new URL('../../../../apps/desktop/src/renderer/src/lib/features/', import.meta.url),
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const ANCHOR_ATTR =
  /data-settings-anchor\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*`([^`]*)`\s*\}|\{\s*['"]([^'"]+)['"]\s*\})/g;
const SECTION_ATTR = /data-settings-section\s*=\s*(?:"([^"]+)"|'([^']+)')/g;

/** 合法锚点值：小写字母、数字、短横线（动态锚点末尾带 `*`）。 */
const ANCHOR_VALUE = /^[a-z0-9-]+\*?$/;

/**
 * 一个属性值：模板串里有 `${` 时取静态前缀加 `*`。不像锚点的值（脚本里拼选择器的
 * `[data-settings-anchor="${anchor}"]` 之类）丢弃。
 */
function anchorValue(match: RegExpMatchArray): string | null {
  const value = rawAnchorValue(match);
  return value !== null && ANCHOR_VALUE.test(value) ? value : null;
}

function rawAnchorValue(match: RegExpMatchArray): string | null {
  const literal = match[1] ?? match[2] ?? match[4];
  if (literal !== undefined) return literal;
  const template = match[3];
  if (template === undefined) return null;
  const dynamic = template.indexOf('${');
  return dynamic === -1 ? template : `${template.slice(0, dynamic)}*`;
}

function quoted(list: string): string[] {
  return [...list.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

export function scanSettingsUi(featuresDir: string = FEATURES_DIR): SettingsUiScan {
  const anchors = new Set<string>();
  for (const file of walk(featuresDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(ANCHOR_ATTR)) {
      const value = anchorValue(match);
      if (value !== null) anchors.add(value);
    }
  }

  // 分区与「锚点 → 分区」：SettingsSectionView 里锚点在最近的 data-settings-section 之下。
  const view = stripComments(
    readFileSync(join(featuresDir, 'settings', 'SettingsSectionView.svelte'), 'utf8'),
  );
  const settingsSections: string[] = [];
  const anchorSections: Record<string, string> = {};
  let current: string | null = null;
  for (const line of view.split('\n')) {
    for (const match of line.matchAll(SECTION_ATTR)) {
      current = match[1] ?? match[2]!;
      if (!settingsSections.includes(current)) settingsSections.push(current);
    }
    for (const match of line.matchAll(ANCHOR_ATTR)) {
      const value = anchorValue(match);
      if (value !== null && current !== null) anchorSections[value] = current;
    }
  }

  const tabsSource = readFileSync(join(featuresDir, 'extension-center', 'tabs.ts'), 'utf8');
  const tabsList = /EXTENSION_CENTER_TABS[^=]*=\s*\[([^\]]*)\]/.exec(tabsSource)?.[1] ?? '';

  const panel = readFileSync(join(featuresDir, 'right-panel', 'RightPanel.svelte'), 'utf8');
  const botPanelTabs = [...panel.matchAll(/\{\s*value:\s*['"]([^'"]+)['"]\s*,\s*labelKey:/g)].map(
    (match) => match[1]!,
  );

  return {
    settingsSections,
    anchors: [...anchors].sort(),
    anchorSections,
    extensionCenterTabs: quoted(tabsList),
    botPanelTabs,
  };
}

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SettingsUiScan } from '../../src/index.js';

/**
 * 扫渲染层源码得到设置界面位置（设置目录覆盖率测试用，todo/conversational-app-setup.md §4.3）。
 * 宽松解析：只认 `data-settings-anchor` / `data-settings-section` 属性、扩展中心
 * `EXTENSION_CENTER_TABS` 与 RightPanel `PanelDetail` 的 `kind` 字面量；HTML / 块注释先剥掉；
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

  // 分区与「锚点 → 分区」：锚点属于同文件里最近的 data-settings-section——
  // 分区本体在 SettingsSectionView，分区拆出的子组件（如模型分区的
  // ModelConfigDetail）在自己根节点上声明同一分区属性。
  const settingsSections: string[] = [];
  const anchorSections: Record<string, string> = {};
  for (const file of walk(featuresDir)) {
    if (!file.endsWith('.svelte')) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    let current: string | null = null;
    for (const line of source.split('\n')) {
      for (const match of line.matchAll(SECTION_ATTR)) {
        current = match[1] ?? match[2]!;
        if (!settingsSections.includes(current)) settingsSections.push(current);
      }
      for (const match of line.matchAll(ANCHOR_ATTR)) {
        const value = anchorValue(match);
        if (value !== null && current !== null) anchorSections[value] = current;
      }
    }
  }

  const tabsSource = readFileSync(join(featuresDir, 'extension-center', 'tabs.ts'), 'utf8');
  const tabsList = /EXTENSION_CENTER_TABS[^=]*=\s*\[([^\]]*)\]/.exec(tabsSource)?.[1] ?? '';

  const panel = readFileSync(join(featuresDir, 'right-panel', 'RightPanel.svelte'), 'utf8');
  // Bot 详情的顶层可深链位置（D116 起为两部分并集）：下钻详情的 kind（只认
  // PanelDetail 联合类型的成员行 `| { kind: '…'`，不误捕 `owner={{ kind: 'bot' }}`
  // 之类）+ 三 tab 条的 `PANEL_TABS`（详情 / 组件 / 任务）。
  const drillKinds = [
    ...panel.matchAll(/^\s*\|\s*\{\s*kind:\s*['"]([a-z-]+)['"]/gm),
  ].map((match) => match[1]!);
  const panelTabsMatch = /const PANEL_TABS[^=]*=\s*\[([^\]]*)\]/.exec(panel);
  const panelTabs = panelTabsMatch !== null ? quoted(panelTabsMatch[1]!) : [];
  const botPanelTabs = [...new Set([...drillKinds, ...panelTabs])];

  return {
    settingsSections,
    anchors: [...anchors].sort(),
    anchorSections,
    extensionCenterTabs: quoted(tabsList),
    botPanelTabs,
  };
}

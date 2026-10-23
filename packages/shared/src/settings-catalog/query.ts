import { SETTING_ITEMS } from './items.js';
import type { SettingGroup, SettingItem } from './types.js';

/** `settings_search` 有 query 时最多返回的条目数（§5.2）。 */
export const SETTINGS_SEARCH_MAX_RESULTS = 10;
/** `settings_read` 未知 id 时给出的最接近候选数。 */
export const SETTINGS_READ_CANDIDATES_MAX = 3;
/** `settings_read` 返回的可选值上限（如已配置厂商下的模型）。 */
export const SETTINGS_READ_OPTIONS_MAX = 30;
/** 三个工具返回体的字节上限（§5.2）：search ≤2KB、read ≤4KB。 */
export const SETTINGS_SEARCH_MAX_BYTES = 2048;
export const SETTINGS_READ_MAX_BYTES = 4096;

/** 分组标题与顺序（`settings_search` 无 query 时每组一行）。 */
export const SETTING_GROUP_TITLES: Readonly<Record<SettingGroup, string>> = {
  models: '模型',
  search: '联网检索',
  connections: '连接应用',
  mcp: 'MCP',
  mail: '邮件',
  agents: '外部智能体',
  bot: 'Bot 配置',
  skills: '技能',
  schedules: '定时与监看',
  profile: '用户画像',
  browser: '浏览器',
  project: '项目组设置',
  workdir: '工作目录设置',
  hardware: '硬件',
  general: '通用',
  background: '后台任务',
  unattended: '无人值守',
  environment: '环境',
  developer: '开发者',
  diagnostics: '诊断与用量',
  remote: '远程遥控',
};

const BY_ID: ReadonlyMap<string, SettingItem> = new Map(
  SETTING_ITEMS.map((entry) => [entry.id, entry]),
);

/** 全部条目（登记顺序）。 */
export function listSettingItems(): readonly SettingItem[] {
  return SETTING_ITEMS;
}

/** 按 id 取条目；未知 id 返回 null（`settings_read` 再用 `closestSettingItemIds` 给候选）。 */
export function getSettingItem(id: string): SettingItem | null {
  return BY_ID.get(id) ?? null;
}

export interface SettingGroupOverview {
  group: SettingGroup;
  title: string;
  /** 本组条目 id（登记顺序）；就绪状态由 core 适配器逐项读取后汇总。 */
  itemIds: string[];
}

/** 概览元数据：有条目的组，按 `SETTING_GROUP_TITLES` 的顺序。 */
export function groupOverview(): SettingGroupOverview[] {
  return (Object.keys(SETTING_GROUP_TITLES) as SettingGroup[]).flatMap((group) => {
    const itemIds = SETTING_ITEMS.filter((entry) => entry.group === group).map((entry) => entry.id);
    return itemIds.length > 0 ? [{ group, title: SETTING_GROUP_TITLES[group], itemIds }] : [];
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 查询拆词：按空白与常见中英文标点切；整句也保留（中文需求描述通常不带空格）。 */
function queryTerms(query: string): string[] {
  const whole = normalize(query);
  const parts = whole.split(/[\s,，。.!！?？、;；:：/|]+/).filter((part) => part.length > 0);
  return [...new Set([whole, ...parts])].filter((term) => term.length > 0);
}

/**
 * 两段文本是否命中：一方包含另一方（「我想让你帮我生成图片」包含 enables 里的「生成图片」；
 * 「图片」被「生成图片」包含）。单字只做「文本包含查询」方向，避免一个字到处命中。
 */
function hits(text: string, term: string): boolean {
  const target = normalize(text);
  if (target.length === 0) return false;
  if (target.includes(term)) return true;
  return target.length >= 2 && term.includes(target);
}

function score(entry: SettingItem, terms: readonly string[]): number {
  let total = 0;
  for (const term of terms) {
    if (entry.id === term) total += 100;
    else if (entry.id.includes(term)) total += 20;
    if (hits(entry.title, term)) total += 10;
    for (const enable of entry.enables) if (hits(enable, term)) total += 8;
    for (const keyword of entry.keywords) if (hits(keyword, term)) total += 6;
    if (normalize(entry.summary).includes(term)) total += 2;
  }
  return total;
}

/**
 * 按需求或关键词搜条目（§5.2）：匹配 id / 标题 / enables / keywords / 一句作用，
 * 按得分降序、同分按登记顺序，最多 `SETTINGS_SEARCH_MAX_RESULTS` 个。空 query 返回 []
 * （无 query 时工具走 `groupOverview`）。
 */
export function searchSettingItems(query: string): SettingItem[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  return SETTING_ITEMS.map((entry, index) => ({ entry, index, value: score(entry, terms) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .slice(0, SETTINGS_SEARCH_MAX_RESULTS)
    .map((row) => row.entry);
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

/**
 * `settings_read` 遇到未知 id 时的候选（§5.2「未知 id 返回最接近的几个候选」）：先按搜索
 * 命中，不够再按 id 的编辑距离补齐，最多 `SETTINGS_READ_CANDIDATES_MAX` 个。
 */
export function closestSettingItemIds(id: string): string[] {
  const found = searchSettingItems(id.replace(/[._-]+/g, ' ')).map((entry) => entry.id);
  const byDistance = [...SETTING_ITEMS]
    .map((entry, index) => ({ id: entry.id, index, distance: editDistance(entry.id, id) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map((row) => row.id);
  return [...new Set([...found, ...byDistance])].slice(0, SETTINGS_READ_CANDIDATES_MAX);
}

/** 条目的敏感字段名（`settings_change` 的 `values` 带上即拒绝，§七）。 */
export function sensitiveFieldNames(entry: SettingItem): string[] {
  return entry.fields.filter((spec) => spec.sensitive).map((spec) => spec.name);
}

/**
 * 校验 Bot 给的 `values`：敏感字段（拒绝整次调用）与目录里没有的字段（同样拒绝，避免
 * 适配器收到意料之外的键）。两者都空 = 可以交给适配器。
 */
export function checkProposedValues(
  entry: SettingItem,
  values: Readonly<Record<string, unknown>>,
): { sensitive: string[]; unknown: string[] } {
  const known = new Map(entry.fields.map((spec) => [spec.name, spec]));
  const sensitive: string[] = [];
  const unknown: string[] = [];
  for (const key of Object.keys(values)) {
    const spec = known.get(key);
    if (spec === undefined) unknown.push(key);
    else if (spec.sensitive) sensitive.push(key);
  }
  return { sensitive, unknown };
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * 设置变化 → 受影响的条目（`settings.changed` 补发用，§4.1「设置页原有的保存路径也补发」）：
 * `changed` 是 settings 的点路径（`capabilityModels`、`capabilityModels.image`、`apps.taintGuard`），
 * 父子路径互相命中。结果按登记顺序、去重。
 */
export function itemIdsForSettingsPaths(changed: readonly string[]): string[] {
  return SETTING_ITEMS.filter(
    (entry) =>
      entry.store.kind === 'settings' &&
      entry.store.paths.some((path) => changed.some((other) => pathsOverlap(path, other))),
  ).map((entry) => entry.id);
}

/** 同上，针对 Bot Profile 的点路径（`runtime.model`、`runtime`）。 */
export function itemIdsForBotPaths(changed: readonly string[]): string[] {
  return SETTING_ITEMS.filter(
    (entry) =>
      entry.store.kind === 'bot' &&
      entry.store.paths.some((path) => changed.some((other) => pathsOverlap(path, other))),
  ).map((entry) => entry.id);
}

/** 同上，针对只经专用 RPC 写的条目（`unattended.enable` → `unattended.enable`）。 */
export function itemIdsForServiceMethod(method: string): string[] {
  return SETTING_ITEMS.filter(
    (entry) => entry.store.kind === 'service' && entry.store.methods.includes(method),
  ).map((entry) => entry.id);
}

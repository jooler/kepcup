import { PLUGIN_RUNTIME_HOST_API_VERSION } from '@kepcup/shared';

/**
 * `runtime.hostApi` 的 semver 范围解析（D125 P2，61 §2 / §3.1）。
 *
 * 清单用 npm 风格的窄范围声明它需要的 Host API 版本（如 `'^1'`）；安装管线与握手
 * 都拿同一份判定：不匹配 → 复用既有 `PLUGIN_UPGRADE_REQUIRED`（提示升级 KepCup /
 * 安装兼容版本），语法无法解析 → `PLUGIN_INVALID`。
 *
 * 支持面刻意很小（执行型插件只需要锁 major）：`^` / `~` / 比较符序列
 * （`>=1.0.0 <2.0.0`）/ 裸版本（`1`、`1.2`、`1.2.3`）/ `*`。其余一律视为语法错误。
 */

type Version = readonly [number, number, number];

const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/** 缺省段按 0 补齐的「部分版本」：`1` / `1.2` 的补全由调用方决定上界。 */
function parsePartial(text: string): { version: Version; parts: number } | null {
  const trimmed = text.trim();
  const match = VERSION_PATTERN.exec(trimmed);
  if (match === null) return null;
  const parts = match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1;
  return { version: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)], parts };
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

type Comparator = { op: '>=' | '>' | '<=' | '<' | '='; version: Version };

/** 解析后的范围 = 全部比较器的合取；`null` = 语法无法解析。 */
type ParsedRange = readonly Comparator[] | null;

export function parseHostApiRange(range: string): ParsedRange {
  const text = range.trim();
  if (text.length === 0) return null;
  if (text === '*' || text.toLowerCase() === 'x') return [];
  if (text.startsWith('^')) {
    const partial = parsePartial(text.slice(1));
    if (partial === null) return null;
    const [major, minor, patch] = partial.version;
    // npm caret：允许改动最左侧非零段（major > 0 时锁 major；0.x 锁 minor；0.0.x 锁
    // patch；`^0.0` / `^0.0.x` 锁到 <0.1.0）。
    const upper: Version =
      major > 0
        ? [major + 1, 0, 0]
        : partial.parts === 1
          ? [1, 0, 0]
          : minor > 0
            ? [0, minor + 1, 0]
            : partial.parts === 3
              ? [0, 0, patch + 1]
              : [0, 1, 0];
    return [
      { op: '>=', version: partial.version },
      { op: '<', version: upper },
    ];
  }
  if (text.startsWith('~')) {
    const partial = parsePartial(text.slice(1));
    if (partial === null) return null;
    const [major, minor] = partial.version;
    // npm tilde：`~1` → 1.x；`~1.2` / `~1.2.3` → 1.2.x。
    const upper: Version = partial.parts === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0];
    return [
      { op: '>=', version: partial.version },
      { op: '<', version: upper },
    ];
  }
  const tokens = text.split(/\s+/);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
    if (match === null) return null;
    const op = (match[1] ?? '=') as Comparator['op'];
    const partial = parsePartial(match[2] ?? '');
    if (partial === null) return null;
    if (op !== '=') {
      comparators.push({ op, version: partial.version });
      continue;
    }
    // 裸版本 = 该前缀内的任意补丁（`1` → 1.x、`1.2` → 1.2.x）；完整版本
    // `1.2.3` 是精确匹配（npm 语义——不能把 `1.2.3` 当成「>=1.2.3 无上界」）。
    const [major, minor] = partial.version;
    if (partial.parts === 3) {
      comparators.push({ op: '=', version: partial.version });
      continue;
    }
    comparators.push({ op: '>=', version: partial.version });
    if (partial.parts === 1) comparators.push({ op: '<', version: [major + 1, 0, 0] });
    else comparators.push({ op: '<', version: [major, minor + 1, 0] });
  }
  return comparators.length === 0 ? null : comparators;
}

/** 范围语法是否可解析（安装管线的 PLUGIN_INVALID 判定）。 */
export function isHostApiRangeValid(range: string): boolean {
  return parseHostApiRange(range) !== null;
}

/**
 * 宿主当前 Host API 版本是否满足清单范围。`version` 缺省为协议常量
 * （`PLUGIN_RUNTIME_HOST_API_VERSION`，v1 = 1）。
 */
export function satisfiesHostApiRange(
  range: string,
  version: number = PLUGIN_RUNTIME_HOST_API_VERSION,
): boolean {
  const parsed = parseHostApiRange(range);
  if (parsed === null || parsed.length === 0) return parsed !== null;
  const target: Version = [version, 0, 0];
  return parsed.every(({ op, version: bound }) => {
    const order = compare(target, bound);
    switch (op) {
      case '>=':
        return order >= 0;
      case '>':
        return order > 0;
      case '<=':
        return order <= 0;
      case '<':
        return order < 0;
      case '=':
        return order === 0;
    }
  });
}

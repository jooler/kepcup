/**
 * 展示文本清洗（不可信来源的标题 / 描述 / 范围名 / 账号名等；本机连接安全评审 A3）。
 *
 * 唯一的清洗实现，core（确认卡、`<available_apps>`、连接标签）与渲染端共用：
 * - 空白类控制字符（`\p{Cc}` 里的换行 / 制表等、行 / 段分隔符）→ 单个空格；
 * - 其余**不可见 / 格式**字符一律删除：`\p{Cf}`（零宽、双向控制 / 隔离、软连字符、BOM、
 *   Unicode 标签字符 U+E0000–E007F……）、U+061C、U+115F / 1160、U+3164、U+FFA0、U+180E、U+034F、
 *   变体选择符（FE00–FE0F、E0100–E01EF）；
 * - 折叠空白、去首尾空白，按码点截断。
 * 源文件里只写码点数字（不写 `\\u` 转义的字面量），便于审阅和避免编辑器吞字符。
 */

/** 额外的不可见 / 填充字符区间（`\p{Cf}` 之外的，以及为明确起见重复列出的）。 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xad, 0xad], // 软连字符
  [0x34f, 0x34f], // 组合字符连接符
  [0x61c, 0x61c], // 阿拉伯字母标记
  [0x115f, 0x1160], // 谚文填充
  [0x180e, 0x180e], // 蒙古文元音分隔符
  [0x200b, 0x200f], // 零宽 / 方向标记
  [0x202a, 0x202e], // 双向嵌入 / 覆盖
  [0x2060, 0x206f], // 词连接符、双向隔离等
  [0x3164, 0x3164], // 谚文填充字符
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfeff, 0xfeff], // BOM / 零宽不换行空格
  [0xffa0, 0xffa0], // 半角谚文填充
  [0xe0000, 0xe007f], // Unicode 标签字符
  [0xe0100, 0xe01ef], // 变体选择符补充
];

/** 折叠为空格的字符：控制字符（含换行 / 制表）与行 / 段分隔符。 */
const SPACE_LIKE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const FORMAT = /\p{Cf}/u;

function isInvisible(char: string, code: number): boolean {
  return FORMAT.test(char) || INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** 文本里是否含需要清洗掉的控制 / 不可见字符（普通空格不算）。 */
export function containsUnsafeText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (SPACE_LIKE.test(char) || isInvisible(char, code)) return true;
  }
  return false;
}

/**
 * 清洗不可信的展示文本；结果可能为空串。`max` 按码点计。
 */
export function sanitizeDisplayText(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (SPACE_LIKE.test(char)) out += ' ';
    else if (!isInvisible(char, code)) out += char;
  }
  const cleaned = out.replace(/\s+/g, ' ').trim();
  const points = Array.from(cleaned);
  return points.length <= max ? cleaned : points.slice(0, max).join('').trimEnd();
}

/** RFC 6749 §3.3 scope-token：`%x21 / %x23-5B / %x5D-7E`（可见 ASCII，不含空格、双引号、反斜杠）。 */
const SCOPE_TOKEN = /^[!#-[\]-~]+$/;
/** 单个范围名与范围个数的上限（防止用超长 / 海量范围撑爆确认卡与授权 URL）。 */
export const SCOPE_TOKEN_MAX = 200;
export const SCOPES_MAX = 50;

export function isScopeToken(value: string): boolean {
  return value.length > 0 && value.length <= SCOPE_TOKEN_MAX && SCOPE_TOKEN.test(value);
}

/** 过滤范围列表：只留合法 scope-token，去重、限个数。 */
export function sanitizeScopes(values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!isScopeToken(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length >= SCOPES_MAX) break;
  }
  return out;
}

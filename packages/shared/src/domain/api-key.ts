/**
 * API Key 展示掩码：设置页只回掩码预览，永不回明文。
 *
 * - 前 10 个字符里有 `-`：保留到该 `-`（含）为止的前缀；
 * - 否则保留前 4 个字符；
 * - 中间固定 `.......`，末尾保留最后 4 个字符。
 * 前缀与后缀会重叠（key 太短）时整体掩掉，避免等于或接近明文。
 */
const MASK_SEPARATOR = '.......';
const DASH_SCAN_LENGTH = 10;
const SHORT_PREFIX_LENGTH = 4;
const TAIL_LENGTH = 4;

export function maskApiKey(key: string): string {
  const head = key.slice(0, DASH_SCAN_LENGTH);
  const dashIndex = head.indexOf('-');
  const prefix = dashIndex >= 0 ? head.slice(0, dashIndex + 1) : key.slice(0, SHORT_PREFIX_LENGTH);
  const tail = key.slice(-TAIL_LENGTH);
  if (key.length <= prefix.length + TAIL_LENGTH) return MASK_SEPARATOR;
  return `${prefix}${MASK_SEPARATOR}${tail}`;
}

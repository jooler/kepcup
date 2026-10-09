import { createHash } from 'node:crypto';
import { APP_TOOL_NAME_MAX } from '@kepcup/shared';

/**
 * 连接应用的工具命名（D73，design 29 §7）：`app_{slug}_{tool}`，字符集 `[A-Za-z0-9_-]`，
 * 长度 ≤ {@link APP_TOOL_NAME_MAX}（外部智能体经宿主桥看到 `mcp__kepcup…__{name}`，要给前缀
 * 留出位置）。`slug` 不含下划线（`[a-z0-9]{2,16}`），所以名字不含账号：同一 Bot 对同一
 * Connector 至多勾选一个连接，模型看到的是稳定的 `app_github_*`。
 *
 * 超长截断时一律追加 `_` + 8 位哈希（哈希取自**未截断、未 sanitize 的原始名字**），因此
 * 前缀相同的两个长名字也不会撞名；`disambiguate` 用于 sanitize 之后仍撞名的少见情况
 * （如 `a.b` 与 `a_b`），强制带哈希后缀。
 */
export function appToolName(
  slug: string,
  toolName: string,
  options: { disambiguate?: boolean } = {},
): string {
  const raw = `app_${slug}_${toolName}`;
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (sanitized.length <= APP_TOOL_NAME_MAX && options.disambiguate !== true) return sanitized;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  // 9 = `_` + 8 hex.
  return `${sanitized.slice(0, APP_TOOL_NAME_MAX - 9)}_${hash}`;
}

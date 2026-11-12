/**
 * MCP http header 的凭据方案（`auth: 'headers'` 的 header 模板可声明 `scheme`）。
 *
 * 背景：一部分服务商（腾讯文档、Notion 等）硬要求 `Authorization: Bearer <token>`，
 * 而用户习惯直接粘贴裸 token。插件声明 `scheme: 'bearer'` 后：
 * - 保存时（mcp 实例 materializer 写 `mcp:{serverId}:header:{name}`）：去掉用户可能
 *   自己粘的 `Bearer ` 前缀，只存裸凭据，存储形态单一；
 * - 发送时（McpService 组 header）：缺前缀就补，已带前缀不重复叠加。
 *
 * 只有清单里显式声明了 `scheme` 的 header 走这两条归一化 —— 通用 MCP / 其他 header /
 * API key 类 secret 完全不受影响（不做「按 header 名 = Authorization 就加前缀」的硬编码）。
 */
export const MCP_HEADER_SCHEMES = ['bearer'] as const;
export type McpHeaderScheme = (typeof MCP_HEADER_SCHEMES)[number];

/** `Bearer` 前缀（大小写不敏感，容忍前缀后任意空白 / 换行）。 */
const BEARER_PREFIX = /^bearer[ \t]*(?:\r?\n[ \t]*)?/i;

/**
 * 去掉 `Bearer ` 前缀，只留裸凭据。大小写不敏感（`bearer` / `BEARER` / `Bearer`），
 * 容忍前缀后的多余空格 / 换行；首尾空白一并去掉（paste 时最常见的噪声）。
 * 幂等；去掉后为空（用户只粘了 `Bearer` 这个词）时原样返回，绝不把凭据清空。
 */
export function stripBearerPrefix(value: string): string {
  const trimmed = value.trim();
  const match = BEARER_PREFIX.exec(trimmed);
  if (match === null) return trimmed;
  const rest = trimmed.slice(match[0].length).trim();
  return rest === '' ? trimmed : rest;
}

/**
 * 确保带 `Bearer ` 前缀：`Bearer <裸凭据>`（前缀后固定一个空格）。
 * 已带前缀（任意大小写 / 多余空白）时只做规范化，不会叠加成 `Bearer Bearer`；
 * 空值 / 纯空白不补成 `Bearer `。幂等。
 */
export function ensureBearerPrefix(value: string): string {
  const token = stripBearerPrefix(value);
  return token === '' ? value : `Bearer ${token}`;
}

/** 保存（写 secret）前的归一化：声明了方案才 strip，未声明时原样返回。 */
export function normalizeMcpHeaderValueForStorage(
  scheme: McpHeaderScheme | undefined,
  value: string,
): string {
  return scheme === 'bearer' ? stripBearerPrefix(value) : value;
}

/** 发送（组请求头）前的归一化：声明了方案才补前缀，未声明时原样返回。 */
export function normalizeMcpHeaderValueForWire(
  scheme: McpHeaderScheme | undefined,
  value: string,
): string {
  return scheme === 'bearer' ? ensureBearerPrefix(value) : value;
}

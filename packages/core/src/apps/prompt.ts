import type { AppAuthReason, ConnectorCatalogEntry } from '@kepcup/shared';
import { connectorMetaOf, sanitizeDisplayText } from '@kepcup/shared';

/**
 * 系统提示词里的连接应用段（D73，design 29 §7）：`<available_apps>`——目录里该 Bot 还没有授权
 * 连接的已发行应用（名称 + 一句话，≤30 条）。已授权连接 / 自定义 MCP 的 `<capabilities>` 段
 * （D91）在 `capabilities/prompt.ts`。没有内容的段返回空串（整段省略）。
 */

export const REASON_TEXT = {
  not_connected: '尚未连接',
  expired: '授权已失效',
  scope: '需要追加权限',
} as const satisfies Record<AppAuthReason, string>;

/**
 * 进提示词的一行文本。标题 / 描述可能来自远端目录（不可信）：折叠空白、去掉 `<` `>`（不能借
 * `</available_apps>` 之类的标签逃出本段）、控制字符与方向 / 零宽标记，再截断。
 */
export function oneLine(text: string, max = 80): string {
  // 共用的展示文本清洗（shared `sanitizeDisplayText`：控制 / 格式 / 不可见 / 标签字符、填充字符、
  // 变体选择符）；先去掉 `<` `>`，再清洗并按码点截断。
  return sanitizeDisplayText(text.replace(/[<>]/g, ''), max);
}

/**
 * `<available_apps>` 段正文：目录里该 Bot 还没有授权连接的应用（调用方已按门禁过滤并限量）。
 * 空 → 空串。
 */
export function availableAppsPromptBody(entries: readonly ConnectorCatalogEntry[]): string {
  if (entries.length === 0) return '';
  return [
    '以下应用可以连接，但你目前没有可用的账号：',
    ...entries.map(
      (entry) =>
        `- ${oneLine(entry.title, 40)}（connector: ${connectorMetaOf(entry).slug}）—— ${oneLine(entry.description)}`,
    ),
    '用户的请求需要其中某个应用时，调用 app_request_connection({ connector, reason }) 请用户在对话里连接（连接后会自动继续）。',
  ].join('\n');
}

/** 平台规则里补的一句（两种引擎共用）：有应用相关段落时才出现。 */
export const APP_REQUEST_CONNECTION_RULE =
  '需要未连接或需重连的应用时调用 app_request_connection，由用户在对话里完成连接；不要让用户去别处粘贴令牌或密钥。';

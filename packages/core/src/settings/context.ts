import { SETTING_DIRECT_TRIGGERS, type Message, type TriggerReason } from '@kepcup/shared';

/**
 * 档位裁定的 run 上下文（todo/conversational-app-setup.md §5.3 第 1、2 条）：本 run 的触发是否
 * 来自用户本人、本 run 是否接触过不可信内容。纯函数，orchestrator 在 run 开始时 / 工具调用时用。
 */

/**
 * 触发批是否「用户本人发起」：批里每条消息都是用户本人发的普通消息——不是组件回传
 * （`origin: 'widget'`）、不是跨 Bot 代发（`origin: 'delegation'`），也没有系统事件或其他 Bot
 * 的发言（群聊里其他 Bot 的 mention / reply、邮件 / 监看 / 定时唤醒的内部事件都会让它为 false）。
 * 合并批（D75 §3.2）的每一部分的触发原因也都必须在直改白名单里。空批 = false。
 */
export function triggerFromUser(input: {
  messages: readonly Message[];
  /** 合并批各部分的触发原因（缺省 = 单批，只看 `reason`）。 */
  partReasons?: readonly TriggerReason[] | undefined;
}): boolean {
  if (input.messages.length === 0) return false;
  if (
    input.partReasons !== undefined &&
    !input.partReasons.every((r) => SETTING_DIRECT_TRIGGERS.has(r))
  ) {
    return false;
  }
  return input.messages.every((message) => {
    if (message.senderType !== 'user' || message.kind !== 'text') return false;
    return (message.content as { origin?: string } | undefined)?.origin === undefined;
  });
}

/**
 * 读取不可信内容的工具（§5.3 第 2 条）：网页、邮件、浏览器页面、MCP / 连接应用的读取、附件正文，
 * 以及会把这些内容带回来的子代理委派。调用（tool_call）一发生就置位——同一步里并行发出的调用，
 * 模型在决定它们时还没看到返回内容。
 */
const UNTRUSTED_READ_TOOLS: ReadonlySet<string> = new Set([
  'web_fetch',
  'web_search',
  'mail_read',
  'mail_search',
  'mail_list',
  'get_attachment',
  'understand_image',
  'transcribe_audio',
  'app_search_tools',
  'app_call_tool',
  'delegate_task',
  'collect_delegate_results',
  'widget_read_state',
]);

/** 前缀命中即算：浏览器（页面内容）、用户 MCP 工具、连接应用工具。 */
const UNTRUSTED_TOOL_PREFIXES = ['browser_', 'mcp_', 'app_'] as const;

/** 宿主自己的 `app_*` 工具（请求连接、本机连接手册 / 提议）：不读外部内容。 */
const HOST_APP_TOOLS: ReadonlySet<string> = new Set([
  'app_request_connection',
  'app_local_connector_guide',
  'app_propose_local_connector',
]);

/** 这次工具调用会不会把不可信内容带进本 run。 */
export function isUntrustedReadTool(toolName: string): boolean {
  if (UNTRUSTED_READ_TOOLS.has(toolName)) return true;
  if (HOST_APP_TOOLS.has(toolName)) return false;
  return UNTRUSTED_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

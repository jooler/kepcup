export {
  inkcopEndpointPath,
  inkcopEndpointSchema,
  inkcopBaseUrl,
  readInkcopEndpoint,
  inkcopAgentsApiAvailable,
  INKCOP_AGENTS_API_MIN_VERSION,
  type InkcopEndpoint,
  type ReadEndpointResult,
} from './endpoint.js';
export { consumeSseBuffer, readSseStream, type SseFrame } from './sse.js';
export {
  InkcopLocalBridgeClient,
  InkcopOfflineError,
  InkcopHttpError,
  INKCOP_OFFLINE_TIP_ZH,
  INKCOP_OFFLINE_TIP_EN,
  inkcopOfflineTip,
  type InkcopClientOptions,
  type InkcopHealthOk,
  type InkcopConnectionOk,
  type InkcopAgentInfo,
  type InkcopAgentsOk,
  type InkcopStreamHandlers,
} from './client.js';

/** Bot Profile `runtime.message_transport` 取值：同机 InkCop 桥（与 inkcop_agent_keys 联动）。 */
export const INKCOP_LOCAL_TRANSPORT = 'inkcop-local' as const;

/** Bot 是否勾选了至少一个 InkCop 智能体。 */
export function botHasInkcopAgents(bot: {
  profile?: { runtime?: { inkcop_agent_keys?: string[] } };
} | null): boolean {
  const keys = bot?.profile?.runtime?.inkcop_agent_keys;
  if (!Array.isArray(keys)) return false;
  return keys.some((key) => typeof key === 'string' && key.trim().length > 0);
}

/**
 * Bot 是否具备 InkCop 同机桥绑定（legacy `message_transport` 或已勾选 agent）。
 * 实际发信还需扩展中心协作开关，见 `shouldUseInkcopBridge`。
 */
export function isInkcopLocalBot(bot: {
  profile?: {
    runtime?: { message_transport?: string; inkcop_agent_keys?: string[] };
  };
} | null): boolean {
  if (bot?.profile?.runtime?.message_transport === INKCOP_LOCAL_TRANSPORT) return true;
  return botHasInkcopAgents(bot);
}

/** 协作已启用且 Bot 已关联智能体时，对话轮走本机桥（不经内置 LLM / ACP）。 */
export function shouldUseInkcopBridge(
  bot: {
    profile?: {
      runtime?: { message_transport?: string; inkcop_agent_keys?: string[] };
    };
  } | null,
  settings: { inkcopLocalCollab?: { enabled?: boolean } } | null | undefined,
): boolean {
  return settings?.inkcopLocalCollab?.enabled === true && isInkcopLocalBot(bot);
}

/**
 * 契约 §3.2 / v0.2：KepCup 侧稳定 externalId。
 * 同一 Bot 绑多个 InkCop agent 时带上 agentKey，避免连接冲突。
 */
export function inkcopExternalId(botId: string, agentKey?: string): string {
  const key = (agentKey ?? '').trim();
  if (key.length === 0 || key === 'main_agent') return `kepcup-bot-${botId}`;
  return `kepcup-bot-${botId}--${key}`;
}

/** 未勾选智能体时的默认 agentKey。 */
export const INKCOP_DEFAULT_AGENT_KEY = 'main_agent' as const;

/** 从 Bot profile 解析要移交的 agentKey（首个勾选项，否则 main_agent）。 */
export function inkcopAgentKeyForBot(bot: {
  profile?: { runtime?: { inkcop_agent_keys?: string[] } };
} | null): string {
  const keys = bot?.profile?.runtime?.inkcop_agent_keys;
  if (!Array.isArray(keys)) return INKCOP_DEFAULT_AGENT_KEY;
  for (const key of keys) {
    if (typeof key === 'string' && key.trim().length > 0) return key.trim();
  }
  return INKCOP_DEFAULT_AGENT_KEY;
}

/** 契约 §3.3：消息幂等键。 */
export function inkcopMessageId(uuid: string): string {
  return `kepcup-msg-${uuid}`;
}

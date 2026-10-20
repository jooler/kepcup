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

/** Bot Profile `runtime.message_transport` 取值：同机 InkCop 桥。 */
export const INKCOP_LOCAL_TRANSPORT = 'inkcop-local' as const;

export function isInkcopLocalBot(bot: {
  profile?: { runtime?: { message_transport?: string } };
} | null): boolean {
  return bot?.profile?.runtime?.message_transport === INKCOP_LOCAL_TRANSPORT;
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

/** 系统 InkCop Bot 发信默认 agent（无勾选时）。 */
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

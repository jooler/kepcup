export {
  inkcopEndpointPath,
  inkcopEndpointSchema,
  inkcopBaseUrl,
  readInkcopEndpoint,
  resolveInkcopTarget,
  inkcopAgentsApiAvailable,
  inkcopAgentDescriptionsAvailable,
  INKCOP_AGENTS_API_MIN_VERSION,
  INKCOP_AGENT_DESCRIPTION_MIN_VERSION,
  type InkcopEndpoint,
  type ReadEndpointResult,
  type InkcopAuthOverrides,
  type ResolvedInkcopTarget,
  type ResolveInkcopTargetResult,
} from './endpoint.js';
export { consumeSseBuffer, readSseStream, type SseFrame } from './sse.js';
export {
  InkcopLocalBridgeClient,
  InkcopOfflineError,
  InkcopAuthError,
  InkcopHttpError,
  InkcopAgentNotExposedError,
  INKCOP_OFFLINE_TIP_ZH,
  INKCOP_OFFLINE_TIP_EN,
  INKCOP_AUTH_TIP_ZH,
  INKCOP_AUTH_TIP_EN,
  INKCOP_AGENT_NOT_EXPOSED_TIP_ZH,
  INKCOP_AGENT_NOT_EXPOSED_TIP_EN,
  inkcopOfflineTip,
  inkcopAuthTip,
  inkcopAgentNotExposedTip,
  inkcopClientFromSettings,
  type InkcopClientOptions,
  type InkcopHealthOk,
  type InkcopConnectionOk,
  type InkcopAgentInfo,
  type InkcopAgentsOk,
  type InkcopStreamHandlers,
} from './client.js';
export {
  handoffToInkcopAgent,
  type InkcopHandoffInput,
  type InkcopHandoffResult,
} from './handoff.js';

/**
 * Legacy Bot Profile `runtime.message_transport` 取值。
 * v0.4 起关联智能体不再切换整轮 transport；字段仅兼容旧配置，读写应清空。
 */
export const INKCOP_LOCAL_TRANSPORT = 'inkcop-local' as const;

/** Bot 是否勾选了至少一个 InkCop 智能体。 */
export function botHasInkcopAgents(bot: {
  profile?: { runtime?: { inkcop_agent_keys?: string[] } };
} | null): boolean {
  return inkcopAgentKeys(bot).length > 0;
}

/** 已勾选的 InkCop agentKey 列表（去空、保序去重）。 */
export function inkcopAgentKeys(bot: {
  profile?: { runtime?: { inkcop_agent_keys?: string[] } };
} | null): string[] {
  const keys = bot?.profile?.runtime?.inkcop_agent_keys;
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const trimmed = key.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Bot 是否「曾」被标为 InkCop 直连（legacy transport 或已勾选 agent）。
 * 仅用于旧数据识别；整轮发信不再走桥，见 `shouldUseInkcopBridge`。
 */
export function isInkcopLocalBot(bot: {
  profile?: {
    runtime?: { message_transport?: string; inkcop_agent_keys?: string[] };
  };
} | null): boolean {
  if (bot?.profile?.runtime?.message_transport === INKCOP_LOCAL_TRANSPORT) return true;
  return botHasInkcopAgents(bot);
}

/**
 * 整轮对话是否改走本机桥（绕过 LLM）。
 * **v0.4 起恒为 false**：关联智能体只注册工具 / 任务移交，普通聊天始终走内置 LLM。
 */
export function shouldUseInkcopBridge(
  _bot: {
    profile?: {
      runtime?: { message_transport?: string; inkcop_agent_keys?: string[] };
    };
  } | null,
  _settings: { inkcopLocalCollab?: { enabled?: boolean } } | null | undefined,
): boolean {
  return false;
}

/**
 * 是否应给该 Bot 注册 `call_inkcop_agent`：
 * 扩展中心协作已启用，且 Bot 详情已勾选至少一个智能体。
 */
export function inkcopAgentToolsEnabled(
  bot: {
    profile?: {
      runtime?: { message_transport?: string; inkcop_agent_keys?: string[] };
    };
  } | null,
  settings: { inkcopLocalCollab?: { enabled?: boolean } } | null | undefined,
): boolean {
  return settings?.inkcopLocalCollab?.enabled === true && botHasInkcopAgents(bot);
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

/** 从 Bot profile 解析默认 agentKey（首个勾选项，否则 main_agent）。 */
export function inkcopAgentKeyForBot(bot: {
  profile?: { runtime?: { inkcop_agent_keys?: string[] } };
} | null): string {
  const keys = inkcopAgentKeys(bot);
  return keys[0] ?? INKCOP_DEFAULT_AGENT_KEY;
}

/** 契约 §3.3：消息幂等键。 */
export function inkcopMessageId(uuid: string): string {
  return `kepcup-msg-${uuid}`;
}

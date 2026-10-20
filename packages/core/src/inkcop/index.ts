export {
  inkcopEndpointPath,
  inkcopEndpointSchema,
  inkcopBaseUrl,
  readInkcopEndpoint,
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
  type InkcopStreamHandlers,
} from './client.js';

/** Bot Profile `runtime.message_transport` 取值：同机 InkCop 桥。 */
export const INKCOP_LOCAL_TRANSPORT = 'inkcop-local' as const;

export function isInkcopLocalBot(bot: {
  profile?: { runtime?: { message_transport?: string } };
} | null): boolean {
  return bot?.profile?.runtime?.message_transport === INKCOP_LOCAL_TRANSPORT;
}

/** 契约 §3.2：KepCup 侧稳定 externalId。 */
export function inkcopExternalId(botId: string): string {
  return `kepcup-bot-${botId}`;
}

/** 契约 §3.3：消息幂等键。 */
export function inkcopMessageId(uuid: string): string {
  return `kepcup-msg-${uuid}`;
}

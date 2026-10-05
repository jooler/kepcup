import type { MemoryItem } from '@kepcup/shared';
import type {
  PlatformEventsMap,
  RpcEventName,
  RpcEventPayload,
} from '@kepcup/shared';

/** Event bus map inside the core service; mirrors the RPC event payloads
 * (port A) plus the platform events the process entry forwards to port B. */
export type CoreEventsMap = {
  [K in RpcEventName]: RpcEventPayload<K>;
} & PlatformEventsMap &
  InternalCoreEvents;

/**
 * Internal domain events (P10 commitment linkage). They ride the same bus as
 * RPC events but are NOT part of rpcEventSchemas / PLATFORM_EVENT_NAMES, so
 * neither port A nor port B forwards them — they are for in-process wiring
 * (memory → schedule) only.
 */
export interface InternalCoreEvents {
  'memory.commitment_created': {
    botId: string;
    /** Conversation the commitment was made in (schedule target). */
    conversationId: string | null;
    item: MemoryItem;
  };
  'memory.commitment_invalidated': {
    botId: string;
    commitmentId: string;
  };
}

import { collabColorForClient } from '@kepcup/shared';
import { clientNameState } from './client-name.svelte';

/**
 * 当前客户端的稳定身份（D119，docs/design/57-multi-client-collaboration.md §2.2）。
 *
 * - 配对模式复用 WsTransport 已持久化的 deviceId（服务端按它识别同一台设备）；
 * - 账号密码模式生成并持久化 clientId；localStorage 不可用（隐私模式）时退化为
 *   会话级随机 id，协作仍可用，只是每次打开都是新身份；
 * - connectionId 每次页面加载生成，用于同一客户端多标签页的连接级清理。
 */

const CLIENT_ID_KEY = 'kepcup.collab.clientId';
/** 与 ws-transport 的 DEVICE_ID_KEY 保持一致（配对模式的稳定设备身份）。 */
const PAIRING_DEVICE_ID_KEY = 'kepcup.remote.deviceId.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function resolveClientId(): string {
  const store = storage();
  const pairingDeviceId = store?.getItem(PAIRING_DEVICE_ID_KEY);
  if (pairingDeviceId !== null && pairingDeviceId !== undefined && pairingDeviceId.length > 0) {
    return pairingDeviceId;
  }
  const existing = store?.getItem(CLIENT_ID_KEY);
  if (existing !== null && existing !== undefined && existing.length > 0) return existing;
  const created = newId('client');
  try {
    store?.setItem(CLIENT_ID_KEY, created);
  } catch {
    // 隐私模式：本次会话内仍稳定。
  }
  return created;
}

const id = resolveClientId();

export const clientIdentity = {
  id,
  /** 可改的显示名（localStorage；多客户端协作里其他设备看到的就是它）。 */
  get name(): string {
    return clientNameState.name;
  },
  setName(next: string): void {
    clientNameState.setName(next);
  },
  connectionId: newId('conn'),
  color: collabColorForClient(id),
};

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

/**
 * 团队来源的客户端身份（T7 融合视图，62.08 §3）：每个团队连接的 clientIdentity
 * 独立——localStorage 键带 serverHash 与成员 id（同设备多账号登录不同成员时
 * 各自稳定，62.10 §4）；connectionId 每次页面加载为该来源单独生成。显示名与
 * 本机共用一份（同一个用户在同一窗口里的设备名）。
 *
 * 'local' 原样返回上面的单例（既有测试与调用点零改动）。
 */
export interface ClientIdentityView {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly color: string;
}

const teamIdentities = new Map<string, ClientIdentityView>();

function teamIdentityKey(serverHash: string, memberId: string | null): string {
  return `kepcup.collab.clientId.team.${serverHash}.${memberId ?? 'anon'}`;
}

function teamIdentityOf(serverHash: string, memberId: string | null): ClientIdentityView {
  const key = teamIdentityKey(serverHash, memberId);
  const cached = teamIdentities.get(key);
  if (cached !== undefined) return cached;
  const store = storage();
  let clientId: string | null = null;
  try {
    clientId = store?.getItem(key) ?? null;
  } catch {
    // localStorage 不可用：按未存过处理（下面生成新 id）。
  }
  if (clientId === null || clientId.length === 0) {
    clientId = newId('client');
    try {
      store?.setItem(key, clientId);
    } catch {
      // 隐私模式：本次会话内仍稳定。
    }
  }
  const identity: ClientIdentityView = {
    id: clientId,
    get name(): string {
      return clientNameState.name;
    },
    connectionId: newId('conn'),
    color: collabColorForClient(clientId),
  };
  teamIdentities.set(key, identity);
  return identity;
}

export function clientIdentityFor(source: 'local' | { serverHash: string; memberId: string | null }): ClientIdentityView {
  if (source === 'local') return clientIdentity;
  return teamIdentityOf(source.serverHash, source.memberId);
}

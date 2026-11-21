/**
 * 「在此窗口融合」的渲染层本机偏好（T7 任务书钉死契约）：按 serverHash 存
 * localStorage，缺省 = 开（融合是 P1 的默认形态；关闭后仍保留服务器配置，
 * 可用「在独立窗口打开」走 T5 的远程进程窗口）。
 *
 * 纯函数（localStorage 注入），node 单测可直接覆盖；存储不可用时回退默认开。
 */

const FUSION_KEY = 'kepcup.teamServers.fusion.v1';

export type FusionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): FusionStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** 读某服务器的融合偏好；未写过 = 默认开。 */
export function fusionEnabledFor(
  store: FusionStorage | null,
  serverHash: string,
): boolean {
  if (store === null) return true;
  try {
    const raw = store.getItem(FUSION_KEY);
    if (raw === null) return true;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    const value = (parsed as Record<string, unknown>)[serverHash];
    return typeof value === 'boolean' ? value : true;
  } catch {
    return true;
  }
}

/** 写某服务器的融合偏好（尽力而为：配额满不阻塞调用方）。 */
export function setFusionEnabledFor(
  store: FusionStorage | null,
  serverHash: string,
  enabled: boolean,
): void {
  if (store === null) return;
  try {
    const raw = store.getItem(FUSION_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    const base =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    base[serverHash] = enabled;
    store.setItem(FUSION_KEY, JSON.stringify(base));
  } catch {
    // 持久化失败只影响下次启动的默认值。
  }
}

/** 当前渲染环境的融合偏好读写（生产入口）。 */
export function fusionPref(): {
  isEnabled(serverHash: string): boolean;
  setEnabled(serverHash: string, enabled: boolean): void;
} {
  const store = storage();
  return {
    isEnabled: (serverHash: string) => fusionEnabledFor(store, serverHash),
    setEnabled: (serverHash: string, enabled: boolean) =>
      setFusionEnabledFor(store, serverHash, enabled),
  };
}

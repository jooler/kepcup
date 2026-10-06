/**
 * 麦克风 TCC 授权门（docs/design/26-voice-input.md）。
 *
 * 为什么不直接 getUserMedia：macOS 的 TCC 弹框只出现一次——首次请求被拒
 * （或用户顺手关掉弹框）之后，后续 getUserMedia 会立刻抛 NotAllowedError 且
 * **系统永远不再弹框**，表现就是「只有一条失败提示、没有系统反馈」。所以按
 * 录前先走主进程显式查询：not-determined 时用 systemPreferences.askForMediaAccess
 * 主动拉起系统授权弹框；已拒绝时返回 denied，由调用方引导用户深链到系统设置
 * （系统设置是唯一的去路）。
 *
 * 非 macOS 没有 TCC（Windows 用自己的隐私指示器，Linux 无此机制），主进程
 * 直接返回 granted；无桥环境（单测 / 非 Electron 宿主）同样放行。
 */

export type MicAccess = 'granted' | 'denied' | 'unavailable';

export async function ensureMicrophoneAccess(): Promise<MicAccess> {
  const bridge = window.kepcup;
  if (bridge === undefined) return 'granted';
  const status = await bridge.micStatus();
  if (status === 'granted') return 'granted';
  if (status === 'not-determined') {
    // 系统授权弹框在这里被拉起；用户拒绝 → denied（之后只能去系统设置）。
    return (await bridge.micRequestAccess()) ? 'granted' : 'denied';
  }
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'unavailable';
}

/** 深链系统设置的麦克风面板（denied 后引导用户手动打开开关）。 */
export function openMicrophoneSettings(): void {
  void window.kepcup?.micOpenSettings();
}

// --- 输入设备选择（设置页「硬件」分区，docs/design/26-voice-input.md）--------

const MIC_DEVICE_STORAGE_KEY = 'kepcup.micDeviceId';

export interface MicDeviceInfo {
  deviceId: string;
  label: string;
}

/** 选定的输入设备 id；空串 = 系统默认（跟随系统）。localStorage 持久化——
 * 这是渲染层本机硬件偏好，不属于 core 的用户数据。 */
export function loadMicDeviceId(): string {
  try {
    return globalThis.localStorage.getItem(MIC_DEVICE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveMicDeviceId(deviceId: string): void {
  try {
    if (deviceId.length === 0) globalThis.localStorage.removeItem(MIC_DEVICE_STORAGE_KEY);
    else globalThis.localStorage.setItem(MIC_DEVICE_STORAGE_KEY, deviceId);
  } catch {
    // 存储不可用时静默：只影响跨会话记忆，当次仍生效。
  }
}

/** 枚举麦克风输入设备。尚未授权过麦克风时浏览器返回空 label（调用方兜底展示）。 */
export async function listMicrophones(): Promise<MicDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({ deviceId: device.deviceId, label: device.label }));
  } catch {
    return [];
  }
}

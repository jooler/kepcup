import { remoteDevicesAdapter } from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * 远程遥控组（D96）。`remote.enabled` / `remote.relay` 声明了 `store.generic`，
 * 由通用标量适配器负责（零 core 改动的路径，见 `generic-adapter.ts`）；这里只有
 * 设备管理的只读概要。
 */
export const remoteContribution: SettingAdapterContribution = {
  name: 'remote',
  adapters: {
    'remote.devices': remoteDevicesAdapter,
  },
};

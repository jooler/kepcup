import { CAPABILITY_SETTING_IDS } from '@kepcup/shared';
import { capabilityAdapter } from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * 能力模型条目（`capability.{能力}`）共用一个适配器：read/write 按条目 id 推导能力键。
 * 显式列全七个 id（不再用 `startsWith('capability.')` 前缀匹配），漏加能力时覆盖测试会点名。
 */
export const capabilityContribution: SettingAdapterContribution = {
  name: 'capability',
  adapters: Object.fromEntries(
    Object.values(CAPABILITY_SETTING_IDS).map((id) => [id, capabilityAdapter]),
  ),
};

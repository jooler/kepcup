import { launchAtLoginAdapter, taskLoopAdapter } from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * 通用组。`general.workbench` 不在这里：它声明了 `store.generic`，由通用标量适配器负责
 * （简单全局标量设置的推荐路径，见 `generic-adapter.ts`）。
 */
export const generalContribution: SettingAdapterContribution = {
  name: 'general',
  adapters: {
    'general.launch-at-login': launchAtLoginAdapter,
    'general.task-loop': taskLoopAdapter,
  },
};

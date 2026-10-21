import {
  environmentAllowlistAdapter,
  environmentSandboxAdapter,
  environmentToolchainsAdapter,
} from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/** 环境组：工具链、沙箱、命令白名单（三个都是 user-only 的只读概要 + 组件内写入）。 */
export const environmentContribution: SettingAdapterContribution = {
  name: 'environment',
  adapters: {
    'environment.toolchains': environmentToolchainsAdapter,
    'environment.sandbox': environmentSandboxAdapter,
    'environment.allowlist': environmentAllowlistAdapter,
  },
};

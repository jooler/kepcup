import { snapshot, type ItemAdapter } from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * 个人资料（Profile）组。`profile.user-name` 声明了 `store.generic`，由通用标量适配器负责；
 * `profile.user-facts` 在 `EXPLICIT_ADAPTER_FALLBACK` 里登记（没有不含画像原文的安全信号）。
 * 这里只有头像：读「已设置 / 未设置」这一个不含图的状态，写入走 `user.avatar.upload` RPC，
 * 不经目录适配器。
 */
export const profileContribution: SettingAdapterContribution = {
  name: 'profile',
  adapters: {
    'profile.user-avatar': (deps): ItemAdapter => ({
      read: () => {
        const avatar = deps.settings.get().userProfileAvatar;
        return avatar.length > 0
          ? snapshot('configured', null, '已设置头像')
          : snapshot('unconfigured', null, '未设置头像');
      },
    }),
  },
};

import {
  isChatDisplayKeyEnabled,
  loadChatDisplayPrefs,
  saveChatDisplayPrefs,
  type ChatDisplayToggleKey,
  type ChatDisplayPrefs,
} from './chat-display';

/**
 * 对话信息展示的响应式包装：启动时从 localStorage 载入，勾选即写盘。
 * 消息列表（MessageList，覆盖 ChatView / CardChat / 委派详情等全部会话面）
 * 与项目组沟通 tab 未读徽标共用同一份 prefs——可开关类目按各自默认值呈现
 * （任务卡默认显示，其余通知类默认隐藏），显式勾选覆盖默认。
 */
class ChatDisplayState {
  prefs = $state<ChatDisplayPrefs>(loadChatDisplayPrefs(globalThis.localStorage ?? null));

  /** 该可开关类目当前是否显示（显式勾选优先，缺省按各项默认值）。 */
  isEnabled(key: ChatDisplayToggleKey): boolean {
    return isChatDisplayKeyEnabled(this.prefs, key);
  }

  /** 勾选 / 取消勾选：更新内存态并落 localStorage（只落与默认不同的键）。 */
  set(key: ChatDisplayToggleKey, visible: boolean): void {
    this.prefs = { ...this.prefs, [key]: visible };
    saveChatDisplayPrefs(globalThis.localStorage ?? null, this.prefs);
  }
}

export const chatDisplay = new ChatDisplayState();

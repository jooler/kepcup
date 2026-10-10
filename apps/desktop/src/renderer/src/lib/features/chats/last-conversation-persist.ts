/**
 * 「上次查看的会话」持久化（纯函数，便于 node 环境单测）：
 * 单键存当前打开会话的 id，localStorage 落盘，应用重启/刷新后由
 * restoreLast 精确恢复（私聊或群聊）；id 已失效（会话被删、Bot 被删后
 * 转只读）时由调用方退回「最近消息」启发式。
 *
 * 渲染层本机偏好（与侧栏宽度、composer 草稿同层）：不进 core 用户数据，
 * localStorage 不可用 / 配额满时尽力而为，不阻塞选择。
 */

export const LAST_CONVERSATION_STORAGE_KEY = 'kepcup.chat.lastConversation.v1';

export type LastConversationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadLastConversationId(storage: LastConversationStorage | null): string | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(LAST_CONVERSATION_STORAGE_KEY);
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function saveLastConversationId(storage: LastConversationStorage | null, id: string): void {
  if (storage === null) return;
  try {
    storage.setItem(LAST_CONVERSATION_STORAGE_KEY, id);
  } catch {
    // 尽力而为：恢复不到就退回启发式。
  }
}

export function clearLastConversationId(storage: LastConversationStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(LAST_CONVERSATION_STORAGE_KEY);
  } catch {
    // 同上。
  }
}

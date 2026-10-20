/**
 * 「上次查看的主视图」持久化（纯函数，便于 node 环境单测）：
 * 单键存 `chats` / `workbench`，localStorage 落盘，应用重启/刷新后由 bootstrap
 * 恢复上次的落点。存储不可用 / 内容无法识别时返回 null，调用方按默认对话处理。
 *
 * 渲染层本机偏好（与上次会话、侧栏宽度、composer 草稿同层）：不进 core 用户数据，
 * localStorage 不可用 / 配额满时尽力而为，不阻塞启动。
 */

export type PersistedMainView = 'chats' | 'workbench';

export const LAST_MAIN_VIEW_STORAGE_KEY = 'kepcup.shell.lastMainView.v1';

export type LastMainViewStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadLastMainView(storage: LastMainViewStorage | null): PersistedMainView | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(LAST_MAIN_VIEW_STORAGE_KEY);
    return raw === 'chats' || raw === 'workbench' ? raw : null;
  } catch {
    return null;
  }
}

export function saveLastMainView(
  storage: LastMainViewStorage | null,
  view: PersistedMainView,
): void {
  if (storage === null) return;
  try {
    storage.setItem(LAST_MAIN_VIEW_STORAGE_KEY, view);
  } catch {
    // 尽力而为：恢复不到就退回默认对话。
  }
}

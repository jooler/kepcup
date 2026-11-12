/**
 * 「右栏 Bot 详情当前 tab」持久化（纯函数，便于 node 环境单测）：按对话 id
 * 记住每个对话上次打开的 tab，localStorage 落盘，应用重启 / 面板重新挂载 /
 * 切回对话时恢复该对话上次停留的 tab。
 *
 * 渲染层本机偏好（与上次会话、侧栏宽度同层）：不进 core 用户数据，localStorage
 * 不可用 / 配额满时尽力而为，恢复不到就退回「详情」。
 */

/** 右栏 tab 的合法取值（与 RightPanel 的 PANEL_TABS 顺序一致）。 */
const PANEL_TAB_IDS = ['detail', 'widgets', 'tasks', 'notes'] as const;
export type PanelTab = (typeof PANEL_TAB_IDS)[number];

export const PANEL_TAB_STORAGE_KEY = 'kepcup.rightPanel.tabByConversation.v1';
/**
 * 单键里最多记多少个对话：写入即刷新访问顺序，超出按最久未访问淘汰，
 * 长期使用（对话越积越多）也不会让这个键无限增长。
 */
export const PANEL_TAB_MAX_CONVERSATIONS = 100;

export type PanelTabStorage = Pick<Storage, 'getItem' | 'setItem'>;

function isPanelTab(value: unknown): value is PanelTab {
  return typeof value === 'string' && (PANEL_TAB_IDS as readonly string[]).includes(value);
}

/** 读整张表；损坏 / 非对象 / 非法值一律丢弃（不阻塞恢复）。 */
function readTabs(storage: PanelTabStorage): Map<string, PanelTab> {
  const tabs = new Map<string, PanelTab>();
  try {
    const raw = storage.getItem(PANEL_TAB_STORAGE_KEY);
    if (raw === null) return tabs;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return tabs;
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (isPanelTab(value)) tabs.set(conversationId, value);
    }
  } catch {
    // 尽力而为：解析失败按没有记录处理。
  }
  return tabs;
}

/** 该对话上次打开的 tab；没有记录 / 存储不可用时返回 null，由调用方回退详情。 */
export function loadPanelTab(
  storage: PanelTabStorage | null,
  conversationId: string,
): PanelTab | null {
  if (storage === null) return null;
  return readTabs(storage).get(conversationId) ?? null;
}

export function savePanelTab(
  storage: PanelTabStorage | null,
  conversationId: string,
  tab: PanelTab,
): void {
  if (storage === null) return;
  try {
    const tabs = readTabs(storage);
    // 重写键位置 = 最近访问；淘汰从最久未访问的对话删起。
    tabs.delete(conversationId);
    tabs.set(conversationId, tab);
    for (const stale of [...tabs.keys()].slice(
      0,
      Math.max(0, tabs.size - PANEL_TAB_MAX_CONVERSATIONS),
    )) {
      tabs.delete(stale);
    }
    storage.setItem(PANEL_TAB_STORAGE_KEY, JSON.stringify(Object.fromEntries(tabs)));
  } catch {
    // 同上：写不进去就只影响下次恢复。
  }
}

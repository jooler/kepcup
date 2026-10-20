/**
 * 左栏对话分组的纯逻辑（rune store 在 sidebar-sections.svelte.ts，本文件可在
 * node 环境单测）：分组目录、归属、排序、折叠，以及 localStorage 编解码。
 *
 * 渲染层本机偏好（与侧栏宽度同层）：不进 core 用户数据。缺省所有对话都在
 * 「未指定」；只有这一组时界面不画组名。建了自定义分组后，「未指定」也作为
 * 可折叠、可拖拽排序的一组留在列表里。
 */

export const SIDEBAR_SECTIONS_STORAGE_KEY = 'kepcup.sidebar.sections.v1';

/** 默认分组。不进 sections 目录，归属表里缺省即它。 */
export const UNASSIGNED_SECTION_ID = 'unassigned';

export const SECTION_NAME_MAX = 40;

export interface SidebarSection {
  id: string;
  name: string;
}

export interface SidebarSectionsState {
  /** 自定义分组。显示顺序看 order，不看这个数组。 */
  sections: SidebarSection[];
  /** 显示顺序，始终包含 UNASSIGNED_SECTION_ID。 */
  order: string[];
  /** conversationId → 自定义分组 id。缺省 = 未指定。 */
  assignments: Record<string, string>;
  /** 值为 true 的分组处于折叠。缺省 = 展开。 */
  collapsed: Record<string, boolean>;
  /** 置顶的 conversationId（值为 true）。缺省 = 未置顶。 */
  pinned: Record<string, boolean>;
}

export interface SectionGroup<T> {
  id: string;
  conversations: T[];
  collapsed: boolean;
  count: number;
}

export interface SectionLayout<T> {
  /** 除「未指定」外还有自定义分组时才画组名。 */
  showHeaders: boolean;
  groups: SectionGroup<T>[];
}

export interface DragRow {
  id: string;
  top: number;
  bottom: number;
}

export type SectionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function emptySidebarSections(): SidebarSectionsState {
  return {
    sections: [],
    order: [UNASSIGNED_SECTION_ID],
    assignments: {},
    collapsed: {},
    pinned: {},
  };
}

function newSectionId(): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `sec_${uuid}`;
}

function cleanName(name: string): string {
  return name.trim().slice(0, SECTION_NAME_MAX);
}

/** 丢掉坏数据、补上「未指定」、去掉指向已删除分组的归属。 */
export function normalizeSidebarSections(input: unknown): SidebarSectionsState {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return emptySidebarSections();
  }
  const raw = input as Partial<SidebarSectionsState>;

  const sections: SidebarSection[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.sections)) {
    for (const item of raw.sections) {
      if (item === null || typeof item !== 'object') continue;
      const id = (item as { id?: unknown }).id;
      const name = (item as { name?: unknown }).name;
      if (typeof id !== 'string' || id.length === 0 || id === UNASSIGNED_SECTION_ID) continue;
      if (typeof name !== 'string') continue;
      const trimmed = cleanName(name);
      if (trimmed.length === 0 || seen.has(id)) continue;
      seen.add(id);
      sections.push({ id, name: trimmed });
    }
  }

  const known = new Set(sections.map((section) => section.id));
  const order: string[] = [];
  const push = (id: string): void => {
    if (order.includes(id)) return;
    if (id !== UNASSIGNED_SECTION_ID && !known.has(id)) return;
    order.push(id);
  };
  if (Array.isArray(raw.order)) {
    for (const id of raw.order) {
      if (typeof id === 'string') push(id);
    }
  }
  for (const section of sections) push(section.id);
  push(UNASSIGNED_SECTION_ID);

  const assignments: Record<string, string> = {};
  if (
    raw.assignments !== null &&
    typeof raw.assignments === 'object' &&
    !Array.isArray(raw.assignments)
  ) {
    for (const [conversationId, sectionId] of Object.entries(raw.assignments)) {
      if (conversationId.length === 0 || typeof sectionId !== 'string') continue;
      if (!known.has(sectionId)) continue;
      assignments[conversationId] = sectionId;
    }
  }

  const collapsed: Record<string, boolean> = {};
  if (
    raw.collapsed !== null &&
    typeof raw.collapsed === 'object' &&
    !Array.isArray(raw.collapsed)
  ) {
    for (const [sectionId, value] of Object.entries(raw.collapsed)) {
      if (value !== true) continue;
      if (sectionId !== UNASSIGNED_SECTION_ID && !known.has(sectionId)) continue;
      collapsed[sectionId] = true;
    }
  }

  const pinned: Record<string, boolean> = {};
  if (raw.pinned !== null && typeof raw.pinned === 'object' && !Array.isArray(raw.pinned)) {
    for (const [conversationId, value] of Object.entries(raw.pinned)) {
      if (value !== true || conversationId.length === 0) continue;
      pinned[conversationId] = true;
    }
  }

  return { sections, order, assignments, collapsed, pinned };
}

export function loadSidebarSections(storage: SectionStorage | null): SidebarSectionsState {
  if (storage === null) return emptySidebarSections();
  try {
    const raw = storage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY);
    if (raw === null || raw.length === 0) return emptySidebarSections();
    return normalizeSidebarSections(JSON.parse(raw) as unknown);
  } catch {
    return emptySidebarSections();
  }
}

export function saveSidebarSections(
  storage: SectionStorage | null,
  state: SidebarSectionsState,
): void {
  if (storage === null) return;
  try {
    storage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(normalizeSidebarSections(state)));
  } catch {
    // 配额满或存储不可用：这次排序下次启动会回到缺省，不阻塞操作。
  }
}

export function sectionIdOf(state: SidebarSectionsState, conversationId: string): string {
  const assigned = state.assignments[conversationId];
  if (assigned !== undefined && state.sections.some((section) => section.id === assigned)) {
    return assigned;
  }
  return UNASSIGNED_SECTION_ID;
}

export interface SidebarActivityItem {
  id: string;
  lastMessageAt?: number | null;
  createdAt?: number;
}

/** 会话活跃时间：最后一条消息，没有消息时用创建时间。 */
export function conversationActivityOf(item: SidebarActivityItem): number {
  const at = item.lastMessageAt ?? item.createdAt ?? 0;
  return Number.isFinite(at) ? at : 0;
}

export function isConversationPinned(state: SidebarSectionsState, conversationId: string): boolean {
  return state.pinned[conversationId] === true;
}

/**
 * 组内排序：置顶的在前，置顶内部与其余条目都按最后消息时间倒序。
 * 时间相同时保持传入顺序（Array.prototype.sort 稳定），避免无意义的重排。
 */
function sortConversations<T extends { id: string }>(
  items: readonly T[],
  pinned: Record<string, boolean>,
  activityOf: (item: T) => number,
): T[] {
  return [...items].sort((a, b) => {
    const aPinned = pinned[a.id] === true;
    const bPinned = pinned[b.id] === true;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return activityOf(b) - activityOf(a);
  });
}

/**
 * 按分组装桶。桶内先按置顶、再按最后消息时间倒序（管家由调用方排除，不进任何一组）。
 * `activityOf` 可传入一个已去抖的时间快照：频繁更新时布局保持稳定，只在快照提交后
 * 重排一次；缺省直接读条目自身的 lastMessageAt / createdAt。
 * 只有「未指定」时不标折叠，避免组名隐藏后列表被收起且无法展开。
 */
export function layoutSidebarSections<T extends { id: string }>(
  items: readonly T[],
  state: SidebarSectionsState,
  activityOf: (item: T) => number = (item) => conversationActivityOf(item),
): SectionLayout<T> {
  const normalized = normalizeSidebarSections(state);
  const sorted = sortConversations(items, normalized.pinned, activityOf);
  if (normalized.sections.length === 0) {
    return {
      showHeaders: false,
      groups: [
        {
          id: UNASSIGNED_SECTION_ID,
          conversations: sorted,
          collapsed: false,
          count: sorted.length,
        },
      ],
    };
  }

  const buckets = new Map<string, T[]>();
  for (const id of normalized.order) buckets.set(id, []);
  for (const item of sorted) {
    const sectionId = sectionIdOf(normalized, item.id);
    const bucket = buckets.get(sectionId) ?? buckets.get(UNASSIGNED_SECTION_ID);
    bucket?.push(item);
  }

  return {
    showHeaders: true,
    groups: normalized.order.map((id) => {
      const conversations = buckets.get(id) ?? [];
      return {
        id,
        conversations,
        collapsed: normalized.collapsed[id] === true,
        count: conversations.length,
      };
    }),
  };
}

function expanded(state: SidebarSectionsState, sectionId: string): SidebarSectionsState {
  if (state.collapsed[sectionId] !== true) return state;
  const collapsed = { ...state.collapsed };
  delete collapsed[sectionId];
  return { ...state, collapsed };
}

/**
 * 新建分组并插到顺序最前。名称为空（或只有空白）时返回 null。
 * id 冲突或是「未指定」时改用新 id。
 */
export function createSection(
  state: SidebarSectionsState,
  name: string,
  id?: string,
): { state: SidebarSectionsState; id: string } | null {
  const trimmed = cleanName(name);
  if (trimmed.length === 0) return null;
  const normalized = normalizeSidebarSections(state);
  const sectionId =
    id !== undefined &&
    id.length > 0 &&
    id !== UNASSIGNED_SECTION_ID &&
    !normalized.sections.some((section) => section.id === id)
      ? id
      : newSectionId();
  return {
    id: sectionId,
    state: {
      ...normalized,
      sections: [...normalized.sections, { id: sectionId, name: trimmed }],
      order: [sectionId, ...normalized.order.filter((existing) => existing !== sectionId)],
    },
  };
}

/** 把对话放进分组。目标不存在时视为「未指定」。目标若正折叠则展开，方便看见移动结果。 */
export function assignConversation(
  state: SidebarSectionsState,
  conversationId: string,
  sectionId: string,
): SidebarSectionsState {
  if (conversationId.length === 0) return normalizeSidebarSections(state);
  const normalized = normalizeSidebarSections(state);
  const target =
    sectionId !== UNASSIGNED_SECTION_ID &&
    normalized.sections.some((section) => section.id === sectionId)
      ? sectionId
      : UNASSIGNED_SECTION_ID;
  const current = sectionIdOf(normalized, conversationId);
  let next = normalized;
  if (current !== target) {
    const assignments = { ...normalized.assignments };
    if (target === UNASSIGNED_SECTION_ID) delete assignments[conversationId];
    else assignments[conversationId] = target;
    next = { ...normalized, assignments };
  }
  return expanded(next, target);
}

/** 把对话移回「未指定」，不改任何折叠状态（用于后台清理，例如管家被移入过分组）。 */
export function unassignConversation(
  state: SidebarSectionsState,
  conversationId: string,
): SidebarSectionsState {
  const normalized = normalizeSidebarSections(state);
  if (normalized.assignments[conversationId] === undefined) return normalized;
  const assignments = { ...normalized.assignments };
  delete assignments[conversationId];
  return { ...normalized, assignments };
}

/** 切换置顶。置顶只影响所在分组内的先后，不改变分组归属。 */
export function togglePinned(
  state: SidebarSectionsState,
  conversationId: string,
): SidebarSectionsState {
  const normalized = normalizeSidebarSections(state);
  if (conversationId.length === 0) return normalized;
  const pinned = { ...normalized.pinned };
  if (pinned[conversationId] === true) delete pinned[conversationId];
  else pinned[conversationId] = true;
  return { ...normalized, pinned };
}

/**
 * 丢掉指向已不存在对话的归属与置顶（对话被删、Bot 被删后直聊不再列出）。
 * existingConversationIds 必须是完整列表：调用方只在列表刷新完成后调用。
 */
export function pruneSidebarSections(
  state: SidebarSectionsState,
  existingConversationIds: Iterable<string>,
): SidebarSectionsState {
  const normalized = normalizeSidebarSections(state);
  const existing = new Set(existingConversationIds);
  const stale = Object.keys(normalized.assignments).filter((id) => !existing.has(id));
  const stalePinned = Object.keys(normalized.pinned).filter((id) => !existing.has(id));
  if (stale.length === 0 && stalePinned.length === 0) return normalized;
  const assignments = { ...normalized.assignments };
  for (const id of stale) delete assignments[id];
  const pinned = { ...normalized.pinned };
  for (const id of stalePinned) delete pinned[id];
  return { ...normalized, assignments, pinned };
}

export function renameSection(
  state: SidebarSectionsState,
  sectionId: string,
  name: string,
): SidebarSectionsState | null {
  if (sectionId === UNASSIGNED_SECTION_ID) return null;
  const trimmed = cleanName(name);
  if (trimmed.length === 0) return null;
  const normalized = normalizeSidebarSections(state);
  const index = normalized.sections.findIndex((section) => section.id === sectionId);
  if (index < 0) return null;
  if (normalized.sections[index]?.name === trimmed) return normalized;
  const sections = normalized.sections.slice();
  sections[index] = { id: sectionId, name: trimmed };
  return { ...normalized, sections };
}

/** 删除自定义分组。里面的对话回到「未指定」。 */
export function deleteSection(
  state: SidebarSectionsState,
  sectionId: string,
): SidebarSectionsState {
  if (sectionId === UNASSIGNED_SECTION_ID) return normalizeSidebarSections(state);
  const normalized = normalizeSidebarSections(state);
  if (!normalized.sections.some((section) => section.id === sectionId)) return normalized;
  const assignments = { ...normalized.assignments };
  for (const [conversationId, assigned] of Object.entries(assignments)) {
    if (assigned === sectionId) delete assignments[conversationId];
  }
  const collapsed = { ...normalized.collapsed };
  delete collapsed[sectionId];
  const sections = normalized.sections.filter((section) => section.id !== sectionId);
  // 没有自定义分组时组名不显示、「未指定」不可折叠；残留的折叠标记会在下次
  // 新建分组时让「未指定」一出现就是收起的。
  if (sections.length === 0) delete collapsed[UNASSIGNED_SECTION_ID];
  return normalizeSidebarSections({
    ...normalized,
    sections,
    order: normalized.order.filter((id) => id !== sectionId),
    assignments,
    collapsed,
  });
}

export function toggleSectionCollapsed(
  state: SidebarSectionsState,
  sectionId: string,
): SidebarSectionsState {
  const normalized = normalizeSidebarSections(state);
  const known =
    sectionId === UNASSIGNED_SECTION_ID ||
    normalized.sections.some((section) => section.id === sectionId);
  if (!known) return normalized;
  const collapsed = { ...normalized.collapsed };
  if (collapsed[sectionId] === true) delete collapsed[sectionId];
  else collapsed[sectionId] = true;
  return { ...normalized, collapsed };
}

/**
 * 拖拽落点是否等于当前顺序。beforeId 为 null 表示放到末尾。
 * 比较的是「抽走再插入」之后的下标，插到自己的下一项之前也算没动。
 */
export function isSectionMoveNoop(
  order: readonly string[],
  sectionId: string,
  beforeId: string | null,
): boolean {
  const from = order.indexOf(sectionId);
  if (from < 0) return true;
  if (beforeId === sectionId) return true;
  const without = order.filter((id) => id !== sectionId);
  const to = beforeId === null ? without.length : without.indexOf(beforeId);
  if (to < 0) return false;
  return to === from;
}

/** 把分组挪到 beforeId 之前；beforeId 为 null 时挪到末尾。 */
export function moveSectionBefore(
  state: SidebarSectionsState,
  sectionId: string,
  beforeId: string | null,
): SidebarSectionsState {
  const normalized = normalizeSidebarSections(state);
  if (isSectionMoveNoop(normalized.order, sectionId, beforeId)) return normalized;
  const order = normalized.order.filter((id) => id !== sectionId);
  const index = beforeId === null ? -1 : order.indexOf(beforeId);
  if (beforeId === null || index < 0) order.push(sectionId);
  else order.splice(index, 0, sectionId);
  return { ...normalized, order };
}

/**
 * 键盘排序（分组右键菜单「上移 / 下移」）：返回交给 moveSectionBefore 的 beforeId；
 * 已在顶端 / 末端或分组不存在时返回 undefined（菜单项置灰）。
 */
export function sectionStepTarget(
  order: readonly string[],
  sectionId: string,
  direction: 'up' | 'down',
): string | null | undefined {
  const index = order.indexOf(sectionId);
  if (index < 0) return undefined;
  if (direction === 'up') return index === 0 ? undefined : order[index - 1];
  if (index === order.length - 1) return undefined;
  return order[index + 2] ?? null;
}

/** 指针落在哪条分组标题的上半区，就插到它前面；都过了中线则落到末尾。跳过正在拖的那条。 */
export function dropBeforeId(
  rows: readonly DragRow[],
  clientY: number,
  draggingId: string,
): string | null {
  for (const row of rows) {
    if (row.id === draggingId) continue;
    const mid = (row.top + row.bottom) / 2;
    if (clientY < mid) return row.id;
  }
  return null;
}

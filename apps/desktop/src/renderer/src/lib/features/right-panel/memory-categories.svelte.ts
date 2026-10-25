import type { MemoryItem, MemoryKind } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 记忆 Tab 的分类树（docs/design/04-memory.md「私有层」：大分类 → kind 小分类）
 * 与下钻位置状态。树 + 位置都放在模块里：MemoryTab 负责渲染，RightPanel 的
 * DetailHeader 用位置画面包屑（根 = 「记忆」，点击回顶层目录）。
 */

export const KIND_KEYS: Record<MemoryKind, MessageKey> = {
  commitment: 'memory.kind.commitment',
  fact: 'memory.kind.fact',
  preference: 'memory.kind.preference',
  feedback: 'memory.kind.feedback',
  episode: 'memory.kind.episode',
  lesson: 'memory.kind.lesson',
  self_note: 'memory.kind.self_note',
};

/** 分类树节点：叶子 = 一个 kind；分支 = 下级分类菜单（kinds 由子级聚合）。 */
export interface MemoryCategoryNode {
  id: string;
  labelKey: MessageKey;
  /** 该节点及其全部后代覆盖的 kind。 */
  kinds: MemoryKind[];
  children: MemoryCategoryNode[];
}

function leaf(kind: MemoryKind): MemoryCategoryNode {
  return { id: kind, labelKey: KIND_KEYS[kind], kinds: [kind], children: [] };
}

function branch(
  id: string,
  labelKey: MessageKey,
  children: MemoryCategoryNode[],
): MemoryCategoryNode {
  return { id, labelKey, kinds: children.flatMap((child) => child.kinds), children };
}

export const CATEGORY_TREE: MemoryCategoryNode[] = [
  branch('relationship', 'memory.group.relationship', [
    leaf('commitment'),
    leaf('feedback'),
    leaf('episode'),
  ]),
  branch('self', 'memory.group.self', [leaf('lesson'), leaf('self_note')]),
  branch('user', 'memory.group.user', [leaf('fact'), leaf('preference')]),
];
/** 树还没覆盖的 kind 的兜底分类（正常为空，不出现在菜单里）。 */
export const OTHER_NODE: MemoryCategoryNode = {
  id: 'other',
  labelKey: 'memory.group.other',
  kinds: [],
  children: [],
};
const TREE_KINDS: ReadonlySet<MemoryKind> = new Set(CATEGORY_TREE.flatMap((n) => n.kinds));

const ROOT_NODES: MemoryCategoryNode[] = [...CATEGORY_TREE, OTHER_NODE];

export function findNode(
  id: string,
  nodes: MemoryCategoryNode[] = ROOT_NODES,
): MemoryCategoryNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(id, node.children);
    if (found !== null) return found;
  }
  return null;
}

export function findParent(
  id: string,
  nodes: MemoryCategoryNode[] = CATEGORY_TREE,
): MemoryCategoryNode | null {
  for (const node of nodes) {
    if (node.children.some((child) => child.id === id)) return node;
    const found = findParent(id, node.children);
    if (found !== null) return found;
  }
  return null;
}

export function nodeEntries(node: MemoryCategoryNode, all: MemoryItem[]): MemoryItem[] {
  if (node.id === 'other') return all.filter((item) => !TREE_KINDS.has(item.kind));
  return all.filter((item) => node.kinds.includes(item.kind));
}

/** 当前下钻到的分类（null = 顶层目录）；MemoryTab 与右栏面包屑共享。 */
class MemoryNav {
  id = $state<string | null>(null);

  select(id: string | null): void {
    this.id = id;
  }

  reset(): void {
    this.id = null;
  }
}

export const memoryNav = new MemoryNav();

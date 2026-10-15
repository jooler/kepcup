import {
  assignConversation,
  createSection,
  deleteSection,
  loadSidebarSections,
  moveSectionBefore,
  renameSection,
  saveSidebarSections,
  toggleSectionCollapsed,
  type SidebarSectionsState,
} from './sidebar-sections';

/**
 * 左栏对话分组（响应式状态必须在 .svelte.ts 中，$state 才会被编译）。
 * 每次变更都落 localStorage。
 */
class SidebarSectionsStore {
  state = $state<SidebarSectionsState>(loadSidebarSections(globalThis.localStorage ?? null));

  #write(next: SidebarSectionsState): void {
    this.state = next;
    saveSidebarSections(globalThis.localStorage ?? null, next);
  }

  assign(conversationId: string, sectionId: string): void {
    this.#write(assignConversation(this.state, conversationId, sectionId));
  }

  /** 新建分组并把当前对话立刻放进去。名称无效时返回 null。 */
  createAndAssign(name: string, conversationId: string): string | null {
    const created = createSection(this.state, name);
    if (created === null) return null;
    this.#write(assignConversation(created.state, conversationId, created.id));
    return created.id;
  }

  rename(sectionId: string, name: string): void {
    const next = renameSection(this.state, sectionId, name);
    if (next === null) return;
    this.#write(next);
  }

  remove(sectionId: string): void {
    this.#write(deleteSection(this.state, sectionId));
  }

  toggle(sectionId: string): void {
    this.#write(toggleSectionCollapsed(this.state, sectionId));
  }

  move(sectionId: string, beforeId: string | null): void {
    const next = moveSectionBefore(this.state, sectionId, beforeId);
    if (
      next.order.length === this.state.order.length &&
      next.order.every((id, index) => id === this.state.order[index])
    ) {
      return;
    }
    this.#write(next);
  }
}

export const sidebarSections = new SidebarSectionsStore();

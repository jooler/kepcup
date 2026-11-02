import type { RpcMethodName, SidebarLayout } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import {
  assignConversation,
  clearLegacySidebarSections,
  createSection,
  deleteSection,
  emptySidebarSections,
  hasSidebarState,
  loadSidebarSections,
  moveSectionBefore,
  renameSection,
  isConversationPinned,
  togglePinned,
  toggleSectionCollapsed,
  unassignConversation,
  UNASSIGNED_SECTION_ID,
  type SidebarSectionsState,
} from './sidebar-sections';

interface SidebarMutation {
  method: RpcMethodName;
  input: Record<string, unknown>;
}

function layoutOf(raw: unknown): SidebarLayout | null {
  const layout = (raw as { layout?: SidebarLayout } | null)?.layout;
  return layout ?? null;
}

/**
 * 左栏对话分组（响应式状态必须在 .svelte.ts 中，$state 才会被编译）。
 *
 * 数据存在 main.db（`sidebar.*` RPC），不再写 localStorage：开发版与发行版共享
 * 同一个数据目录，分组不会再按 origin 分成两份。交互仍先本地乐观更新，写入
 * 串行排队；任何一次写入失败就从服务端重读，界面不会停在假状态上。升级时
 * 旧键 `kepcup.sidebar.sections.v1` 读一次、`sidebar.import` 成功后删掉。
 */
class SidebarSectionsStore {
  state = $state<SidebarSectionsState>(emptySidebarSections());

  #started = false;
  /** 乐观状态的版本号：迟到的写入响应不能盖掉更新的本地状态。 */
  #version = 0;
  /** 写入串行化：保证服务端按用户操作顺序落库。 */
  #writes: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const storage = globalThis.localStorage ?? null;
    try {
      const initial = layoutOf(await core.call('sidebar.get', {}));
      if (initial === null) return;
      let layout = initial;
      const legacy = loadSidebarSections(storage);
      if (!hasSidebarState(layout) && hasSidebarState(legacy)) {
        // 旧版 localStorage 分组一次性搬进 main.db；导入后删键，之后以库为准。
        const imported = await core.call('sidebar.import', { layout: legacy });
        layout = layoutOf(imported) ?? layout;
        clearLegacySidebarSections(storage);
      } else {
        clearLegacySidebarSections(storage);
      }
      this.state = layout;
    } catch {
      // 读取失败保持缺省（全部「未指定」）；旧键留着，下次启动再试。
    }
  }

  assign(conversationId: string, sectionId: string): void {
    if (conversationId.length === 0) return;
    const target = sectionId === UNASSIGNED_SECTION_ID ? null : sectionId;
    this.#commit(assignConversation(this.state, conversationId, sectionId), {
      method: 'sidebar.assign',
      input: { conversationId, sectionId: target },
    });
  }

  /** 移回「未指定」且不展开它（后台清理用，不是用户的移动操作）。 */
  unassign(conversationId: string): void {
    if (this.state.assignments[conversationId] === undefined) return;
    this.#commit(unassignConversation(this.state, conversationId), {
      method: 'sidebar.unassign',
      input: { conversationId },
    });
  }

  /** 置顶 / 取消置顶；排序立即生效（只有消息驱动的重排需要去抖）。 */
  togglePin(conversationId: string): void {
    if (conversationId.length === 0) return;
    const pinned = !isConversationPinned(this.state, conversationId);
    this.#commit(togglePinned(this.state, conversationId), {
      method: 'sidebar.pin',
      input: { conversationId, pinned },
    });
  }

  /** 新建分组并把当前对话立刻放进去。名称无效时返回 null。 */
  createAndAssign(name: string, conversationId: string): string | null {
    const created = createSection(this.state, name);
    if (created === null) return null;
    const section = created.state.sections.find((entry) => entry.id === created.id);
    this.#commit(assignConversation(created.state, conversationId, created.id), {
      method: 'sidebar.sections.create',
      input: {
        id: created.id,
        name: section?.name ?? name,
        conversationId,
      },
    });
    return created.id;
  }

  rename(sectionId: string, name: string): void {
    const next = renameSection(this.state, sectionId, name);
    if (next === null) return;
    const section = next.sections.find((entry) => entry.id === sectionId);
    this.#commit(next, {
      method: 'sidebar.sections.rename',
      input: { id: sectionId, name: section?.name ?? name },
    });
  }

  remove(sectionId: string): void {
    this.#commit(deleteSection(this.state, sectionId), {
      method: 'sidebar.sections.delete',
      input: { id: sectionId },
    });
  }

  toggle(sectionId: string): void {
    const next = toggleSectionCollapsed(this.state, sectionId);
    this.#commit(next, {
      method: 'sidebar.sections.collapse',
      input: { id: sectionId, collapsed: next.collapsed[sectionId] === true },
    });
  }

  move(sectionId: string, beforeId: string | null): void {
    const next = moveSectionBefore(this.state, sectionId, beforeId);
    if (
      next.order.length === this.state.order.length &&
      next.order.every((id, index) => id === this.state.order[index])
    ) {
      return;
    }
    this.#commit(next, {
      method: 'sidebar.sections.move',
      input: { id: sectionId, beforeId },
    });
  }

  /** 写入失败后从服务端重读（期间没有更新的本地写入才应用）。 */
  async reload(): Promise<void> {
    const version = this.#version;
    try {
      const layout = layoutOf(await core.call('sidebar.get', {}));
      if (layout !== null && version === this.#version) this.state = layout;
    } catch {
      // 保持现状：下次启动或下一次写入会再对齐。
    }
  }

  #commit(next: SidebarSectionsState, mutation: SidebarMutation): void {
    this.state = next;
    const version = ++this.#version;
    this.#writes = this.#writes.then(async () => {
      const layout = layoutOf(await core.call(mutation.method, mutation.input));
      if (layout !== null && version === this.#version) this.state = layout;
    });
    this.#writes = this.#writes.catch(async (error: unknown) => {
      const code = (error as { code?: string } | null)?.code;
      toast.error(errorText(code, t('sidebar.sectionSaveFailed')));
      await this.reload();
    });
  }
}

export const sidebarSections = new SidebarSectionsStore();

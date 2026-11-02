import { z } from 'zod';

/**
 * 左栏对话分组（design/12-ui-layout.md「对话分组」）：分组目录、显示顺序、
 * 会话归属、折叠与置顶。行在 main.db `sidebar_sections` / `conversation_sidebar`
 * （data-model.md），渲染层经 `sidebar.*` RPC 读写；每台机器只有一份数据目录，
 * 开发版与发行版共享同一份，不再按 localStorage origin 隔离。
 */

/** 内置「未指定」分组的 id（不是用户建的组，不能重命名 / 删除）。 */
export const SIDEBAR_UNASSIGNED_ID = 'unassigned';

/** 分组名称长度上限（code points）。 */
export const SIDEBAR_SECTION_NAME_MAX_CHARS = 40;

/** 分组顺序键的步长（与看板 / 工作台同一套分数排序，升序）。 */
export const SIDEBAR_POSITION_STEP = 1024;

/** 相邻顺序键小于该值时整表重排，避免中点塌缩。 */
export const SIDEBAR_POSITION_MIN_GAP = 1e-3;

export const sidebarSectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(SIDEBAR_SECTION_NAME_MAX_CHARS),
});
export type SidebarSection = z.infer<typeof sidebarSectionSchema>;

/**
 * 左栏分组投影（`sidebar.get` / 每次写入后的返回值）。
 * 形状与渲染层 `SidebarSectionsState` 一致：`sections` 只放用户建的分组，
 * 显示顺序看 `order`（始终包含内置「未指定」）。
 */
export const sidebarLayoutSchema = z.object({
  /** 自定义分组（顺序看 order）。 */
  sections: z.array(sidebarSectionSchema),
  /** 显示顺序；始终包含 SIDEBAR_UNASSIGNED_ID。 */
  order: z.array(z.string().min(1)),
  /** conversationId → 自定义分组 id；缺省 = 未指定。 */
  assignments: z.record(z.string(), z.string().min(1)),
  /** 值为 true 的分组处于折叠；缺省 = 展开。 */
  collapsed: z.record(z.string(), z.boolean()),
  /** 置顶的 conversationId（true = 置顶）；缺省 = 未置顶。 */
  pinned: z.record(z.string(), z.boolean()),
});
export type SidebarLayout = z.infer<typeof sidebarLayoutSchema>;

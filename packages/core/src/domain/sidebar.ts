import {
  AppError,
  SIDEBAR_POSITION_MIN_GAP,
  SIDEBAR_POSITION_STEP,
  SIDEBAR_SECTION_NAME_MAX_CHARS,
  SIDEBAR_UNASSIGNED_ID,
  newId,
  type SidebarLayout,
  type SidebarSection,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import { placeItem } from '../board/positions.js';

/** 分组顺序键参数（与看板 / 工作台同一套 placeItem，步长用左栏自己的常量）。 */
const POSITION_OPTS = { step: SIDEBAR_POSITION_STEP, minGap: SIDEBAR_POSITION_MIN_GAP };

/** 客户端可自带 id（乐观上屏）；只接受常规 id 字符，避免拼进任何标识时出意外。 */
const SECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface SidebarSectionRow {
  id: string;
  name: string | null;
  position: number;
  collapsed: 0 | 1;
  created_at: number;
  updated_at: number;
}

interface ConversationSidebarRow {
  conversation_id: string;
  section_id: string;
  pinned: 0 | 1;
  created_at: number;
  updated_at: number;
}

function cleanName(name: string): string {
  return [...name.trim()].slice(0, SIDEBAR_SECTION_NAME_MAX_CHARS).join('');
}

export interface CreateSidebarSectionInput {
  /** 渲染层乐观上屏时已生成的 id；缺省由 core 生成。 */
  id?: string | undefined;
  name: string;
  /** 同时把这条会话移进新分组。 */
  conversationId?: string | undefined;
}

/**
 * 左栏对话分组的持久化（main.db `sidebar_sections` / `conversation_sidebar`，
 * design/12-ui-layout.md「对话分组」）。服务只做数据与顺序；渲染是语义化写入
 * 后重读整份投影（`layout`）。
 *
 * 语义要点：
 * - 内置「未指定」是 `sidebar_sections` 的一行（`name IS NULL`），因此它和自定义
 *   分组一样有顺序与折叠状态，但不能重命名 / 删除。
 * - 会话归属与置顶存在 `conversation_sidebar`：没有偏好时没有行。删分组由 FK
 *   `ON DELETE SET DEFAULT` 把归属落回「未指定」；删会话由 FK 级联清掉偏好。
 * - 新建分组插到最前；移进一个折叠中的分组会自动展开（与旧版 localStorage 行为一致）。
 */
export class SidebarService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /** 完整投影：分组目录、顺序、归属、折叠、置顶。 */
  layout(): SidebarLayout {
    const sections = this.#sections();
    const prefs = this.db
      .prepare('select * from conversation_sidebar order by conversation_id')
      .all() as ConversationSidebarRow[];
    const assignments: Record<string, string> = {};
    const pinned: Record<string, boolean> = {};
    for (const row of prefs) {
      if (row.section_id !== SIDEBAR_UNASSIGNED_ID)
        assignments[row.conversation_id] = row.section_id;
      if (row.pinned === 1) pinned[row.conversation_id] = true;
    }
    const collapsed: Record<string, boolean> = {};
    for (const row of sections) {
      if (row.collapsed === 1) collapsed[row.id] = true;
    }
    return {
      sections: sections
        .filter((row) => row.id !== SIDEBAR_UNASSIGNED_ID)
        .map((row) => ({ id: row.id, name: row.name ?? '' })),
      order: sections.map((row) => row.id),
      assignments,
      collapsed,
      pinned,
    };
  }

  /** 新建分组并排到最前；给了 conversationId 时同事务把会话移进去。 */
  create(input: CreateSidebarSectionInput): { layout: SidebarLayout; sectionId: string } {
    const name = cleanName(input.name);
    if (name.length === 0) throw new AppError('INVALID_INPUT', '分组名称不能为空');
    const id = input.id ?? newId('ssc');
    if (!SECTION_ID_PATTERN.test(id) || id === SIDEBAR_UNASSIGNED_ID) {
      throw new AppError('INVALID_INPUT', '分组 id 不合规');
    }
    if (this.#sectionRow(id) !== null) throw new AppError('INVALID_INPUT', '分组已存在');
    if (input.conversationId !== undefined) this.#conversationOrThrow(input.conversationId);

    const now = this.clock.now();
    this.db.transaction(() => {
      const max = this.db.prepare('select max(position) as p from sidebar_sections').get() as {
        p: number | null;
      };
      this.db
        .prepare(
          'insert into sidebar_sections (id, name, position, collapsed, created_at, updated_at) values (?, ?, ?, 0, ?, ?)',
        )
        .run(id, name, (max.p ?? 0) + POSITION_OPTS.step, now, now);
      // 插到最前（旧行为）：第一行之前；没有任何行时落在末尾。
      const first = this.#sections()[0]?.id ?? null;
      this.#place(id, first);
      if (input.conversationId !== undefined) this.#assign(input.conversationId, id);
    })();
    return { layout: this.layout(), sectionId: id };
  }

  rename(id: string, name: string): SidebarLayout {
    this.#namedSectionOrThrow(id);
    const cleaned = cleanName(name);
    if (cleaned.length === 0) throw new AppError('INVALID_INPUT', '分组名称不能为空');
    this.db
      .prepare('update sidebar_sections set name = ?, updated_at = ? where id = ?')
      .run(cleaned, this.clock.now(), id);
    return this.layout();
  }

  /** 删除分组；组内会话回到「未指定」（FK ON DELETE SET DEFAULT）。 */
  remove(id: string): SidebarLayout {
    this.#namedSectionOrThrow(id);
    this.db.transaction(() => {
      this.db.prepare('delete from sidebar_sections where id = ?').run(id);
      // 没有自定义分组时不画组名，「未指定」也不可折叠；顺手清掉折叠标记，
      // 否则下次新建分组时它会一出现就是收起的。
      const remaining = this.db
        .prepare('select count(*) as n from sidebar_sections where id != ?')
        .get(SIDEBAR_UNASSIGNED_ID) as { n: number };
      if (remaining.n === 0) {
        this.db
          .prepare('update sidebar_sections set collapsed = 0, updated_at = ? where id = ?')
          .run(this.clock.now(), SIDEBAR_UNASSIGNED_ID);
      }
    })();
    return this.layout();
  }

  /** 拖拽 / 键盘重排；beforeId 为 null = 末尾。内置「未指定」同样参与排序。 */
  move(id: string, beforeId: string | null): SidebarLayout {
    const row = this.#sectionRow(id);
    if (row === null) throw new AppError('NOT_FOUND', '分组不存在');
    if (beforeId === id) throw new AppError('INVALID_INPUT', '不能拖到自己前面');
    if (beforeId !== null && this.#sectionRow(beforeId) === null) {
      throw new AppError('INVALID_INPUT', '目标分组不存在');
    }
    this.db.transaction(() => {
      this.#place(id, beforeId);
    })();
    return this.layout();
  }

  setCollapsed(id: string, collapsed: boolean): SidebarLayout {
    this.#sectionOrThrow(id);
    this.db
      .prepare('update sidebar_sections set collapsed = ?, updated_at = ? where id = ?')
      .run(collapsed ? 1 : 0, this.clock.now(), id);
    return this.layout();
  }

  /** 用户把会话移进分组（null = 未指定）；目标折叠时展开，方便看见移动结果。 */
  assign(conversationId: string, sectionId: string | null): SidebarLayout {
    this.#conversationOrThrow(conversationId);
    const target = sectionId ?? SIDEBAR_UNASSIGNED_ID;
    if (this.#sectionRow(target) === null) throw new AppError('INVALID_INPUT', '目标分组不存在');
    this.db.transaction(() => {
      this.#assign(conversationId, target);
      this.db
        .prepare('update sidebar_sections set collapsed = 0 where id = ? and collapsed = 1')
        .run(target);
    })();
    return this.layout();
  }

  /**
   * 后台清理：把会话移回「未指定」，不展开它（不是用户的移动操作，
   * 例如管家被移入过分组后自动纠正）。
   */
  unassign(conversationId: string): SidebarLayout {
    this.#conversationOrThrow(conversationId);
    this.db.transaction(() => {
      this.#assign(conversationId, SIDEBAR_UNASSIGNED_ID);
    })();
    return this.layout();
  }

  setPinned(conversationId: string, pinned: boolean): SidebarLayout {
    this.#conversationOrThrow(conversationId);
    const existing = this.#prefRow(conversationId);
    if (existing === null) {
      if (!pinned) return this.layout();
      const now = this.clock.now();
      this.db
        .prepare(
          'insert into conversation_sidebar (conversation_id, section_id, pinned, created_at, updated_at) values (?, ?, 1, ?, ?)',
        )
        .run(conversationId, SIDEBAR_UNASSIGNED_ID, now, now);
      return this.layout();
    }
    if (!pinned && existing.section_id === SIDEBAR_UNASSIGNED_ID) {
      // 只为了置顶才存在的行：取消置顶后连行一起删掉。
      this.db
        .prepare('delete from conversation_sidebar where conversation_id = ?')
        .run(conversationId);
      return this.layout();
    }
    this.db
      .prepare(
        'update conversation_sidebar set pinned = ?, updated_at = ? where conversation_id = ?',
      )
      .run(pinned ? 1 : 0, this.clock.now(), conversationId);
    return this.layout();
  }

  /**
   * 旧版渲染层 localStorage 分组的一次性导入。只在库里还没有任何分组状态时生效
   * （否则 `imported: false` 并返回现状）。坏条目丢弃：未知 / 重复的分组 id、
   * 指向已不存在会话或分组的归属、不存在的折叠标记；顺序缺「未指定」时补到末尾。
   */
  importLayout(layout: SidebarLayout): { layout: SidebarLayout; imported: boolean } {
    if (!this.#isEmpty()) return { layout: this.layout(), imported: false };

    const sections: SidebarSection[] = [];
    const known = new Set<string>();
    for (const entry of layout.sections) {
      const id = entry.id;
      const name = cleanName(entry.name);
      if (id === SIDEBAR_UNASSIGNED_ID || name.length === 0) continue;
      if (!SECTION_ID_PATTERN.test(id) || known.has(id)) continue;
      if (this.#sectionRow(id) !== null) continue;
      known.add(id);
      sections.push({ id, name });
    }
    const order: string[] = [];
    for (const id of layout.order) {
      if (id === SIDEBAR_UNASSIGNED_ID) {
        if (!order.includes(id)) order.push(id);
        continue;
      }
      if (known.has(id) && !order.includes(id)) order.push(id);
    }
    for (const section of sections) {
      if (!order.includes(section.id)) order.push(section.id);
    }
    if (!order.includes(SIDEBAR_UNASSIGNED_ID)) order.push(SIDEBAR_UNASSIGNED_ID);

    const collapsed = new Set<string>();
    for (const [id, value] of Object.entries(layout.collapsed)) {
      if (value === true && order.includes(id)) collapsed.add(id);
    }

    const now = this.clock.now();
    this.db.transaction(() => {
      const insert = this.db.prepare(
        'insert into sidebar_sections (id, name, position, collapsed, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
      );
      order.forEach((id, index) => {
        const position = POSITION_OPTS.step * (index + 1);
        if (id === SIDEBAR_UNASSIGNED_ID) {
          this.db
            .prepare(
              'update sidebar_sections set position = ?, collapsed = ?, updated_at = ? where id = ?',
            )
            .run(position, collapsed.has(id) ? 1 : 0, now, id);
          return;
        }
        const section = sections.find((entry) => entry.id === id);
        if (section === undefined) return;
        insert.run(id, section.name, position, collapsed.has(id) ? 1 : 0, now, now);
      });

      const upsert = this.db.prepare(
        `insert into conversation_sidebar (conversation_id, section_id, pinned, created_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(conversation_id) do update set
           section_id = excluded.section_id,
           pinned = excluded.pinned,
           updated_at = excluded.updated_at`,
      );
      const existingConversation = this.db.prepare(
        'select 1 as ok from conversations where id = ?',
      );
      const conversationIds = new Set([
        ...Object.keys(layout.assignments),
        ...Object.keys(layout.pinned),
      ]);
      for (const conversationId of conversationIds) {
        if (existingConversation.get(conversationId) === undefined) continue;
        const assigned = layout.assignments[conversationId];
        const sectionId =
          assigned !== undefined && order.includes(assigned) ? assigned : SIDEBAR_UNASSIGNED_ID;
        const pinned = layout.pinned[conversationId] === true;
        if (sectionId === SIDEBAR_UNASSIGNED_ID && !pinned) continue;
        upsert.run(conversationId, sectionId, pinned ? 1 : 0, now, now);
      }
    })();

    return { layout: this.layout(), imported: true };
  }

  #sections(): SidebarSectionRow[] {
    return this.db
      .prepare('select * from sidebar_sections order by position asc, id asc')
      .all() as SidebarSectionRow[];
  }

  #sectionRow(id: string): SidebarSectionRow | null {
    const row = this.db.prepare('select * from sidebar_sections where id = ?').get(id) as
      SidebarSectionRow | undefined;
    return row ?? null;
  }

  #sectionOrThrow(id: string): void {
    if (this.#sectionRow(id) === null) throw new AppError('NOT_FOUND', '分组不存在');
  }

  #namedSectionOrThrow(id: string): void {
    if (id === SIDEBAR_UNASSIGNED_ID)
      throw new AppError('INVALID_INPUT', '「未指定」不能重命名或删除');
    this.#sectionOrThrow(id);
  }

  #prefRow(conversationId: string): ConversationSidebarRow | null {
    const row = this.db
      .prepare('select * from conversation_sidebar where conversation_id = ?')
      .get(conversationId) as ConversationSidebarRow | undefined;
    return row ?? null;
  }

  #conversationOrThrow(conversationId: string): void {
    const row = this.db
      .prepare('select 1 as ok from conversations where id = ?')
      .get(conversationId);
    if (row === undefined) throw new AppError('NOT_FOUND', '会话不存在');
  }

  /**
   * 把会话放进 target 分组。没有行时只在目标不是「未指定」才落行；
   * 目标为「未指定」且没有置顶时删行（缺行即未指定）。
   */
  #assign(conversationId: string, target: string): void {
    const existing = this.#prefRow(conversationId);
    const now = this.clock.now();
    if (existing === null) {
      if (target === SIDEBAR_UNASSIGNED_ID) return;
      this.db
        .prepare(
          'insert into conversation_sidebar (conversation_id, section_id, pinned, created_at, updated_at) values (?, ?, 0, ?, ?)',
        )
        .run(conversationId, target, now, now);
      return;
    }
    if (target === SIDEBAR_UNASSIGNED_ID && existing.pinned === 0) {
      this.db
        .prepare('delete from conversation_sidebar where conversation_id = ?')
        .run(conversationId);
      return;
    }
    this.db
      .prepare(
        'update conversation_sidebar set section_id = ?, updated_at = ? where conversation_id = ?',
      )
      .run(target, now, conversationId);
  }

  /**
   * 把一行挪到 beforeId 之前（null = 末尾）。顺序键不够用时整表重排；
   * 落点和现在一致时不写库。
   */
  #place(id: string, beforeId: string | null): void {
    const rows = this.#sections();
    const placed = placeItem(
      rows.map((row) => ({ id: row.id, position: row.position })),
      id,
      beforeId,
      POSITION_OPTS,
    );
    if (!placed.changed) return;
    const now = this.clock.now();
    const statement = this.db.prepare(
      'update sidebar_sections set position = ?, updated_at = ? where id = ?',
    );
    for (const item of placed.items) {
      if (!placed.renumbered && item.id !== id) continue;
      statement.run(item.position, now, item.id);
    }
  }

  #isEmpty(): boolean {
    const custom = this.db
      .prepare('select count(*) as n from sidebar_sections where id != ?')
      .get(SIDEBAR_UNASSIGNED_ID) as { n: number };
    if (custom.n > 0) return false;
    const prefs = this.db.prepare('select count(*) as n from conversation_sidebar').get() as {
      n: number;
    };
    if (prefs.n > 0) return false;
    const collapsed = this.db
      .prepare('select count(*) as n from sidebar_sections where collapsed = 1')
      .get() as { n: number };
    return collapsed.n === 0;
  }
}

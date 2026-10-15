import { describe, expect, test } from 'vitest';
import {
  SECTION_NAME_MAX,
  SIDEBAR_SECTIONS_STORAGE_KEY,
  UNASSIGNED_SECTION_ID,
  assignConversation,
  createSection,
  deleteSection,
  dropBeforeId,
  emptySidebarSections,
  isSectionMoveNoop,
  layoutSidebarSections,
  loadSidebarSections,
  moveSectionBefore,
  normalizeSidebarSections,
  pruneSidebarSections,
  renameSection,
  saveSidebarSections,
  sectionIdOf,
  sectionStepTarget,
  toggleSectionCollapsed,
  unassignConversation,
  type SectionStorage,
} from './sidebar-sections';

function fakeStorage(initial: Record<string, string> = {}): SectionStorage & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

const items = [{ id: 'butler' }, { id: 'a' }, { id: 'b' }];

describe('layoutSidebarSections', () => {
  test('只有未指定时不显示组名，并保持传入顺序', () => {
    const layout = layoutSidebarSections(items, emptySidebarSections());
    expect(layout.showHeaders).toBe(false);
    expect(layout.groups).toEqual([
      { id: UNASSIGNED_SECTION_ID, conversations: items, collapsed: false, count: 3 },
    ]);
  });

  test('未指定曾被折叠，但自定义分组都删掉后列表仍展开', () => {
    const collapsed = toggleSectionCollapsed(emptySidebarSections(), UNASSIGNED_SECTION_ID);
    const layout = layoutSidebarSections(items, collapsed);
    expect(layout.showHeaders).toBe(false);
    expect(layout.groups[0]?.collapsed).toBe(false);
    expect(layout.groups[0]?.conversations).toHaveLength(3);
  });

  test('自定义分组在前，未指定即使为空也留在顺序里；桶内保持原顺序', () => {
    const created = createSection(emptySidebarSections(), '项目', 'sec_projects');
    expect(created).not.toBeNull();
    const assigned = assignConversation(created!.state, 'a', 'sec_projects');
    const layout = layoutSidebarSections(items, assigned);
    expect(layout.showHeaders).toBe(true);
    expect(layout.groups.map((group) => group.id)).toEqual(['sec_projects', UNASSIGNED_SECTION_ID]);
    expect(layout.groups[0]?.conversations.map((item) => item.id)).toEqual(['a']);
    expect(layout.groups[1]?.conversations.map((item) => item.id)).toEqual(['butler', 'b']);
    expect(layout.groups[0]?.count).toBe(1);
  });

  test('折叠只改标志，对话仍留在分组数据里', () => {
    const created = createSection(emptySidebarSections(), '项目', 'sec_projects')!;
    const assigned = assignConversation(created.state, 'a', 'sec_projects');
    const collapsed = toggleSectionCollapsed(assigned, 'sec_projects');
    const layout = layoutSidebarSections(items, collapsed);
    expect(layout.groups[0]?.collapsed).toBe(true);
    expect(layout.groups[0]?.conversations.map((item) => item.id)).toEqual(['a']);
    expect(layout.groups[0]?.count).toBe(1);
  });
});

describe('分组变更', () => {
  test('空名称不建分组；名称去掉首尾空白并截断', () => {
    expect(createSection(emptySidebarSections(), '   ')).toBeNull();
    const created = createSection(
      emptySidebarSections(),
      `  ${'项'.repeat(SECTION_NAME_MAX + 5)}  `,
      'sec_long',
    );
    expect(created?.state.sections[0]?.name).toHaveLength(SECTION_NAME_MAX);
    expect(created?.state.order[0]).toBe('sec_long');
  });

  test('新建后立刻归入，并在目标折叠时展开', () => {
    const created = createSection(emptySidebarSections(), '项目', 'sec_projects')!;
    const collapsed = toggleSectionCollapsed(created.state, 'sec_projects');
    const assigned = assignConversation(collapsed, 'a', 'sec_projects');
    expect(sectionIdOf(assigned, 'a')).toBe('sec_projects');
    expect(assigned.collapsed.sec_projects).toBeUndefined();
  });

  test('未知分组与空对话 id 都不会制造归属', () => {
    const state = emptySidebarSections();
    expect(sectionIdOf(assignConversation(state, 'a', 'missing'), 'a')).toBe(UNASSIGNED_SECTION_ID);
    expect(assignConversation(state, '', 'missing').assignments).toEqual({});
  });

  test('移回未指定会清掉归属', () => {
    const created = createSection(emptySidebarSections(), '项目', 'sec_projects')!;
    const assigned = assignConversation(created.state, 'a', 'sec_projects');
    const back = assignConversation(assigned, 'a', UNASSIGNED_SECTION_ID);
    expect(back.assignments.a).toBeUndefined();
    expect(sectionIdOf(back, 'a')).toBe(UNASSIGNED_SECTION_ID);
  });

  test('重命名；未指定与空名称拒绝', () => {
    const created = createSection(emptySidebarSections(), '项目', 'sec_projects')!;
    expect(renameSection(created.state, UNASSIGNED_SECTION_ID, '别的')).toBeNull();
    expect(renameSection(created.state, 'sec_projects', '  ')).toBeNull();
    const renamed = renameSection(created.state, 'sec_projects', ' 客户 ');
    expect(renamed?.sections[0]?.name).toBe('客户');
  });

  test('删除分组后对话回到未指定；未指定删不掉', () => {
    const created = createSection(emptySidebarSections(), '项目', 'sec_projects')!;
    const assigned = assignConversation(created.state, 'a', 'sec_projects');
    const removed = deleteSection(assigned, 'sec_projects');
    expect(removed.sections).toEqual([]);
    expect(sectionIdOf(removed, 'a')).toBe(UNASSIGNED_SECTION_ID);
    expect(layoutSidebarSections(items, removed).showHeaders).toBe(false);
    expect(deleteSection(created.state, UNASSIGNED_SECTION_ID).sections).toHaveLength(1);
  });

  test('拖拽排序，插到自己下一项之前视为没动', () => {
    let state = createSection(emptySidebarSections(), '甲', 'sec_a')!.state;
    state = createSection(state, '乙', 'sec_b')!.state;
    expect(state.order).toEqual(['sec_b', 'sec_a', UNASSIGNED_SECTION_ID]);
    expect(isSectionMoveNoop(state.order, 'sec_b', 'sec_a')).toBe(true);
    const moved = moveSectionBefore(state, 'sec_a', null);
    expect(moved.order).toEqual(['sec_b', UNASSIGNED_SECTION_ID, 'sec_a']);
    expect(isSectionMoveNoop(moved.order, 'sec_a', null)).toBe(true);
    expect(moveSectionBefore(moved, 'sec_b', 'sec_a').order).toEqual([
      UNASSIGNED_SECTION_ID,
      'sec_b',
      'sec_a',
    ]);
  });
});

describe('清理与键盘排序', () => {
  function twoSections() {
    let state = createSection(emptySidebarSections(), '甲', 'sec_a')!.state;
    state = createSection(state, '乙', 'sec_b')!.state;
    state = assignConversation(state, 'a', 'sec_a');
    state = assignConversation(state, 'b', 'sec_b');
    return state;
  }

  test('pruneSidebarSections 丢掉已不存在对话的归属，其余不动', () => {
    const state = twoSections();
    const pruned = pruneSidebarSections(state, ['a', 'other']);
    expect(pruned.assignments).toEqual({ a: 'sec_a' });
    expect(pruned.sections).toEqual(state.sections);
    expect(pruned.order).toEqual(state.order);
    expect(pruneSidebarSections(state, new Set(['a', 'b'])).assignments).toEqual(state.assignments);
    expect(pruneSidebarSections(state, []).assignments).toEqual({});
  });

  test('unassignConversation 移回未指定但不展开它', () => {
    let state = twoSections();
    state = toggleSectionCollapsed(state, UNASSIGNED_SECTION_ID);
    const back = unassignConversation(state, 'a');
    expect(sectionIdOf(back, 'a')).toBe(UNASSIGNED_SECTION_ID);
    expect(back.collapsed[UNASSIGNED_SECTION_ID]).toBe(true);
    // 对照：assignConversation 是用户的移动操作，会展开目标
    expect(assignConversation(state, 'a', UNASSIGNED_SECTION_ID).collapsed).toEqual({});
    expect(unassignConversation(back, 'a').assignments).toEqual({ b: 'sec_b' });
  });

  test('删掉最后一个自定义分组时清掉未指定的折叠标记', () => {
    let state = createSection(emptySidebarSections(), '甲', 'sec_a')!.state;
    state = toggleSectionCollapsed(state, UNASSIGNED_SECTION_ID);
    const removed = deleteSection(state, 'sec_a');
    expect(removed.collapsed).toEqual({});
    // 再建分组时未指定不会一出现就是收起的
    const again = createSection(removed, '乙', 'sec_b')!.state;
    expect(layoutSidebarSections(items, again).groups[1]?.collapsed).toBe(false);
    // 仍有其它分组时保留
    let two = twoSections();
    two = toggleSectionCollapsed(two, UNASSIGNED_SECTION_ID);
    expect(deleteSection(two, 'sec_a').collapsed[UNASSIGNED_SECTION_ID]).toBe(true);
  });

  test('sectionStepTarget 给出上移 / 下移的 beforeId，两端为 undefined', () => {
    const order = ['sec_b', 'sec_a', UNASSIGNED_SECTION_ID];
    expect(sectionStepTarget(order, 'sec_b', 'up')).toBeUndefined();
    expect(sectionStepTarget(order, 'sec_a', 'up')).toBe('sec_b');
    expect(sectionStepTarget(order, 'sec_b', 'down')).toBe(UNASSIGNED_SECTION_ID);
    expect(sectionStepTarget(order, 'sec_a', 'down')).toBeNull();
    expect(sectionStepTarget(order, UNASSIGNED_SECTION_ID, 'down')).toBeUndefined();
    expect(sectionStepTarget(order, 'missing', 'up')).toBeUndefined();

    const state = twoSections();
    const down = moveSectionBefore(
      state,
      'sec_b',
      sectionStepTarget(state.order, 'sec_b', 'down')!,
    );
    expect(down.order).toEqual(['sec_a', 'sec_b', UNASSIGNED_SECTION_ID]);
    const toEnd = moveSectionBefore(down, 'sec_b', sectionStepTarget(down.order, 'sec_b', 'down')!);
    expect(toEnd.order).toEqual(['sec_a', UNASSIGNED_SECTION_ID, 'sec_b']);
    const up = moveSectionBefore(toEnd, 'sec_b', sectionStepTarget(toEnd.order, 'sec_b', 'up')!);
    expect(up.order).toEqual(['sec_a', 'sec_b', UNASSIGNED_SECTION_ID]);
  });
});

describe('normalizeSidebarSections', () => {
  test('非对象输入回到缺省', () => {
    for (const input of [null, undefined, 42, 'x', [], true]) {
      expect(normalizeSidebarSections(input)).toEqual(emptySidebarSections());
    }
  });

  test('丢掉坏条目、重复 id、未指定冒名与空名，名称去空白截断', () => {
    const state = normalizeSidebarSections({
      sections: [
        { id: 'sec_a', name: ' 甲 ' },
        { id: 'sec_a', name: '重复' },
        { id: UNASSIGNED_SECTION_ID, name: '冒名' },
        { id: 'sec_empty', name: '   ' },
        { id: '', name: '无 id' },
        { id: 'sec_num', name: 7 },
        null,
        'sec_str',
        { id: 'sec_long', name: '长'.repeat(SECTION_NAME_MAX + 3) },
      ],
    });
    expect(state.sections.map((section) => section.id)).toEqual(['sec_a', 'sec_long']);
    expect(state.sections[0]?.name).toBe('甲');
    expect(state.sections[1]?.name).toHaveLength(SECTION_NAME_MAX);
  });

  test('order 去重、丢未知 id、补齐遗漏的分组与未指定', () => {
    const state = normalizeSidebarSections({
      sections: [
        { id: 'sec_a', name: '甲' },
        { id: 'sec_b', name: '乙' },
      ],
      order: ['sec_b', 'sec_b', 'ghost', 3, UNASSIGNED_SECTION_ID, UNASSIGNED_SECTION_ID],
    });
    expect(state.order).toEqual(['sec_b', UNASSIGNED_SECTION_ID, 'sec_a']);
  });

  test('归属与折叠只保留指向已知分组的合法值', () => {
    const state = normalizeSidebarSections({
      sections: [{ id: 'sec_a', name: '甲' }],
      assignments: { a: 'sec_a', b: 'ghost', c: 5, '': 'sec_a', d: UNASSIGNED_SECTION_ID },
      collapsed: { sec_a: true, ghost: true, [UNASSIGNED_SECTION_ID]: true, sec_b: 'yes' },
    });
    expect(state.assignments).toEqual({ a: 'sec_a' });
    expect(state.collapsed).toEqual({ sec_a: true, [UNASSIGNED_SECTION_ID]: true });
    expect(normalizeSidebarSections({ assignments: [], collapsed: null }).assignments).toEqual({});
  });
});

describe('dropBeforeId', () => {
  const rows = [
    { id: 'a', top: 0, bottom: 20 },
    { id: 'b', top: 20, bottom: 40 },
    { id: 'c', top: 40, bottom: 60 },
  ];

  test('落在标题上半区则插到它前面，过了中线落到更下面，末尾为 null', () => {
    expect(dropBeforeId(rows, 5, 'x')).toBe('a');
    expect(dropBeforeId(rows, 15, 'x')).toBe('b');
    expect(dropBeforeId(rows, 50, 'x')).toBe(null);
  });

  test('跳过正在拖的标题', () => {
    expect(dropBeforeId(rows, 5, 'a')).toBe('b');
  });
});

describe('localStorage', () => {
  test('往返后丢掉指向已删分组的归属，并补上缺失的未指定', () => {
    const storage = fakeStorage();
    const created = createSection(emptySidebarSections(), '项目', 'sec_projects')!;
    const assigned = assignConversation(created.state, 'a', 'sec_projects');
    saveSidebarSections(storage, assigned);
    const raw = JSON.parse(storage.store.get(SIDEBAR_SECTIONS_STORAGE_KEY) ?? '{}') as {
      assignments: Record<string, string>;
      order: string[];
    };
    raw.assignments.ghost = 'missing';
    raw.order = raw.order.filter((id) => id !== UNASSIGNED_SECTION_ID);
    storage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(raw));

    const loaded = loadSidebarSections(storage);
    expect(loaded.assignments.ghost).toBeUndefined();
    expect(loaded.assignments.a).toBe('sec_projects');
    expect(loaded.order).toContain(UNASSIGNED_SECTION_ID);
    expect(loaded.sections[0]?.name).toBe('项目');
  });

  test('损坏的存储、空存储、抛错都回到缺省', () => {
    expect(loadSidebarSections(null).order).toEqual([UNASSIGNED_SECTION_ID]);
    expect(loadSidebarSections(fakeStorage()).sections).toEqual([]);
    expect(
      loadSidebarSections(fakeStorage({ [SIDEBAR_SECTIONS_STORAGE_KEY]: 'not-json' })).sections,
    ).toEqual([]);
    expect(normalizeSidebarSections([1, 2]).order).toEqual([UNASSIGNED_SECTION_ID]);
    const throwing: SectionStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadSidebarSections(throwing).sections).toEqual([]);
    expect(() => saveSidebarSections(throwing, emptySidebarSections())).not.toThrow();
    expect(() => saveSidebarSections(null, emptySidebarSections())).not.toThrow();
  });
});

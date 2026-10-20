import { describe, expect, it } from 'vitest';
import {
  emptySidebarSections,
  UNASSIGNED_SECTION_ID,
  type SidebarSectionsState,
} from '../sidebar/sidebar-sections';
import { buildAssigneeSections, type AssigneeConversation } from './assignee-sections';
import type { MemberInfo } from './workbench-model';

const bots: MemberInfo[] = [
  { id: 'butler', name: '管家', isButler: true },
  { id: 'a', name: '阿时' },
  { id: 'b', name: '小贝' },
  { id: 'orphan', name: '未聊过' },
];
const projects: MemberInfo[] = [
  { id: 'g1', name: '产品组' },
  { id: 'g2', name: '只读项目组' },
];

function conv(partial: Partial<AssigneeConversation> & Pick<AssigneeConversation, 'id' | 'type'>): AssigneeConversation {
  return {
    title: partial.title ?? partial.id,
    directBotId: partial.directBotId ?? null,
    bot: partial.bot ?? null,
    readOnly: partial.readOnly ?? false,
    ...partial,
  };
}

describe('buildAssigneeSections', () => {
  it('无自定义分组：管家并进唯一列表，会话顺序保留，孤儿 Bot 进未指定', () => {
    const conversations: AssigneeConversation[] = [
      conv({
        id: 'c-butler',
        type: 'direct',
        directBotId: 'butler',
        bot: { systemRole: 'butler' },
      }),
      conv({ id: 'c-a', type: 'direct', directBotId: 'a', bot: { systemRole: null } }),
      conv({ id: 'g1', type: 'project', title: '产品组' }),
      conv({ id: 'c-b', type: 'direct', directBotId: 'b', bot: { systemRole: null } }),
    ];
    const layout = buildAssigneeSections({
      bots,
      projects: [projects[0]!],
      conversations,
      sectionsState: emptySidebarSections(),
    });
    expect(layout.showHeaders).toBe(false);
    expect(layout.butler).toEqual([]);
    expect(layout.sections).toHaveLength(1);
    expect(layout.sections[0]!.items.map((item) => item.key)).toEqual([
      'bot:butler',
      'bot:a',
      'project:g1',
      'bot:b',
      'bot:orphan',
    ]);
  });

  it('有自定义分组：管家置顶，条目按左栏归属分桶', () => {
    const state: SidebarSectionsState = {
      sections: [{ id: 'sec_work', name: '工作' }],
      order: ['sec_work', UNASSIGNED_SECTION_ID],
      assignments: { 'c-a': 'sec_work', g1: 'sec_work' },
      collapsed: {},
      pinned: {},
    };
    const conversations: AssigneeConversation[] = [
      conv({
        id: 'c-butler',
        type: 'direct',
        directBotId: 'butler',
        bot: { systemRole: 'butler' },
      }),
      conv({ id: 'c-a', type: 'direct', directBotId: 'a', bot: { systemRole: null } }),
      conv({ id: 'g1', type: 'project', title: '产品组' }),
      conv({ id: 'c-b', type: 'direct', directBotId: 'b', bot: { systemRole: null } }),
    ];
    const layout = buildAssigneeSections({
      bots,
      projects: [projects[0]!],
      conversations,
      sectionsState: state,
    });
    expect(layout.showHeaders).toBe(true);
    expect(layout.butler.map((item) => item.key)).toEqual(['bot:butler']);
    expect(layout.sections.map((section) => section.id)).toEqual(['sec_work', UNASSIGNED_SECTION_ID]);
    expect(layout.sections[0]!.items.map((item) => item.key)).toEqual(['bot:a', 'project:g1']);
    expect(layout.sections[1]!.items.map((item) => item.key)).toEqual(['bot:b', 'bot:orphan']);
  });

  it('只读项目组不在 projects 名单里时不会出现', () => {
    const conversations: AssigneeConversation[] = [
      conv({ id: 'g2', type: 'project', title: '只读项目组', readOnly: true }),
    ];
    const layout = buildAssigneeSections({
      bots: [],
      projects: [],
      conversations,
      sectionsState: emptySidebarSections(),
    });
    expect(layout.sections).toEqual([]);
  });
});

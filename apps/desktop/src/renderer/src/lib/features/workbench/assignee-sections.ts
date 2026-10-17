/**
 * 事项详情「执行者」下拉：按左栏 Bot 列表的分组装桶（不再拆 Bot / 群两组）。
 * 管家置顶规则与 AppSidebar 一致；无自定义分组时管家并进唯一列表。
 */
import {
  layoutSidebarSections,
  UNASSIGNED_SECTION_ID,
  type SidebarSectionsState,
} from '../sidebar/sidebar-sections';
import type { MemberInfo } from './workbench-model';

export type AssigneeOption = {
  key: string;
  kind: 'bot' | 'group';
  memberId: string;
  name: string;
  isButler?: boolean;
};

export type AssigneeSectionGroup = {
  id: string;
  items: AssigneeOption[];
};

export type AssigneeSectionLayout = {
  showHeaders: boolean;
  /** 有分组标题时管家单独置顶；无标题时已并进 sections[0]。 */
  butler: AssigneeOption[];
  sections: AssigneeSectionGroup[];
};

export type AssigneeConversation = {
  id: string;
  type: string;
  title: string | null;
  directBotId?: string | null;
  bot?: { systemRole?: string | null } | null;
  readOnly: boolean;
};

function isButlerConversation(conversation: AssigneeConversation): boolean {
  return conversation.type === 'direct' && conversation.bot?.systemRole === 'butler';
}

export function buildAssigneeSections(input: {
  bots: readonly MemberInfo[];
  groups: readonly MemberInfo[];
  conversations: readonly AssigneeConversation[];
  sectionsState: SidebarSectionsState;
}): AssigneeSectionLayout {
  const botById = new Map(input.bots.map((bot) => [bot.id, bot]));
  const groupById = new Map(input.groups.map((group) => [group.id, group]));
  const seenBot = new Set<string>();
  const seenGroup = new Set<string>();

  function fromConversation(conversation: AssigneeConversation): AssigneeOption | null {
    if (conversation.type === 'direct') {
      const botId = conversation.directBotId;
      if (botId === null || botId === undefined) return null;
      const bot = botById.get(botId);
      if (bot === undefined) return null;
      seenBot.add(botId);
      return {
        key: `bot:${botId}`,
        kind: 'bot',
        memberId: botId,
        name: bot.name,
        isButler: bot.isButler,
      };
    }
    if (conversation.type === 'project') {
      const group = groupById.get(conversation.id);
      if (group === undefined) return null;
      seenGroup.add(conversation.id);
      return {
        key: `group:${conversation.id}`,
        kind: 'group',
        memberId: conversation.id,
        name: group.name,
      };
    }
    return null;
  }

  const butler: AssigneeOption[] = [];
  for (const conversation of input.conversations) {
    if (!isButlerConversation(conversation)) continue;
    const pick = fromConversation(conversation);
    if (pick !== null) butler.push(pick);
  }
  for (const bot of input.bots) {
    if (bot.isButler !== true || seenBot.has(bot.id)) continue;
    seenBot.add(bot.id);
    butler.push({
      key: `bot:${bot.id}`,
      kind: 'bot',
      memberId: bot.id,
      name: bot.name,
      isButler: true,
    });
  }

  const layout = layoutSidebarSections(
    input.conversations.filter((conversation) => !isButlerConversation(conversation)),
    input.sectionsState,
  );

  const sections: AssigneeSectionGroup[] = layout.groups.map((group) => ({
    id: group.id,
    items: group.conversations.flatMap((conversation) => {
      const pick = fromConversation(conversation);
      return pick === null ? [] : [pick];
    }),
  }));

  let unassigned = sections.find((section) => section.id === UNASSIGNED_SECTION_ID);
  if (unassigned === undefined) {
    unassigned = { id: UNASSIGNED_SECTION_ID, items: [] };
    sections.push(unassigned);
  }

  for (const bot of input.bots) {
    if (bot.isButler === true || seenBot.has(bot.id)) continue;
    seenBot.add(bot.id);
    unassigned.items.push({
      key: `bot:${bot.id}`,
      kind: 'bot',
      memberId: bot.id,
      name: bot.name,
    });
  }
  for (const group of input.groups) {
    if (seenGroup.has(group.id)) continue;
    seenGroup.add(group.id);
    unassigned.items.push({
      key: `group:${group.id}`,
      kind: 'group',
      memberId: group.id,
      name: group.name,
    });
  }

  if (!layout.showHeaders) {
    const only = sections[0];
    if (only !== undefined && butler.length > 0) {
      only.items = [...butler, ...only.items];
    }
    return {
      showHeaders: false,
      butler: [],
      sections: sections.filter((section) => section.items.length > 0),
    };
  }

  return {
    showHeaders: true,
    butler,
    sections: sections.filter((section) => section.items.length > 0),
  };
}

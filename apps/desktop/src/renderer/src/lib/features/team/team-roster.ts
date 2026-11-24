/**
 * 团队来源的「通讯录行」计算（侧栏团队分组用）。
 *
 * 设计目标（62.01 S03/S04、62.04 §1）：连接团队服务器后，同一份列表里既有
 * 会话，也能看到服务端的 Bot / 真人 / 项目组。侧栏的团队分组以会话为主；
 * 还没有会话的 Bot / 好友 / 项目组在这里补成「可点击开始对话」的名册行，
 * 已经打开过的条目不再重复出现（点开后会变成普通会话行）。
 *
 * 纯函数，node 环境可直接单测。
 */

export interface RosterBotLike {
  id: string;
}

export interface RosterMemberLike {
  id: string;
}

export interface RosterProjectLike {
  id: string;
}

/** 会话行只需要判定「属于哪个 Bot / 哪个成员 / 哪个项目组」的字段。 */
export interface RosterConversationLike {
  id: string;
  type: string;
  directBotId?: string | null;
  peerPrincipalIds?: readonly string[] | null;
}

export interface TeamRosterInput<
  B extends RosterBotLike,
  M extends RosterMemberLike,
  P extends RosterProjectLike,
> {
  bots: readonly B[];
  members: readonly M[];
  projects: readonly P[];
  conversations: readonly RosterConversationLike[];
}

export interface TeamRoster<
  B extends RosterBotLike,
  M extends RosterMemberLike,
  P extends RosterProjectLike,
> {
  bots: B[];
  members: M[];
  projects: P[];
}

/**
 * 从名册与会话里挑出「还没有对应会话」的条目：
 * - Bot：已有 `type='direct'` 且 `directBotId` 相同的会话；
 * - 成员：已有包含该成员的对端 `type='dm'` 会话；
 * - 项目组：已有同 id 的 `type='project'` 会话。
 */
export function teamRosterOf<
  B extends RosterBotLike,
  M extends RosterMemberLike,
  P extends RosterProjectLike,
>(input: TeamRosterInput<B, M, P>): TeamRoster<B, M, P> {
  const directBotIds = new Set<string>();
  const dmPeerIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const conversation of input.conversations) {
    if (conversation.type === 'direct' && typeof conversation.directBotId === 'string') {
      directBotIds.add(conversation.directBotId);
    } else if (conversation.type === 'dm') {
      for (const peerId of conversation.peerPrincipalIds ?? []) dmPeerIds.add(peerId);
    } else if (conversation.type === 'project') {
      projectIds.add(conversation.id);
    }
  }
  return {
    bots: input.bots.filter((bot) => !directBotIds.has(bot.id)),
    members: input.members.filter((member) => !dmPeerIds.has(member.id)),
    projects: input.projects.filter((project) => !projectIds.has(project.id)),
  };
}

import { describe, expect, it } from 'vitest';
import { teamRosterOf } from './team-roster';

/**
 * 侧栏团队分组的名册补全：会话已有的 Bot / 好友 / 项目组不重复列出，
 * 没有会话的条目成为可点击开始对话的名册行。
 */

describe('teamRosterOf', () => {
  const bots = [{ id: 'bot_butler' }, { id: 'bot_new' }];
  const members = [{ id: 'mbr_alice' }, { id: 'mbr_bob' }];
  const projects = [{ id: 'conv_project_1' }, { id: 'conv_project_2' }];

  it('去掉已有 direct / dm / project 会话的条目', () => {
    const roster = teamRosterOf({
      bots,
      members,
      projects,
      conversations: [
        { id: 'conv_direct_butler', type: 'direct', directBotId: 'bot_butler' },
        { id: 'conv_dm_bob', type: 'dm', peerPrincipalIds: ['mbr_self', 'mbr_bob'] },
        { id: 'conv_project_1', type: 'project' },
      ],
    });
    expect(roster.bots.map((bot) => bot.id)).toEqual(['bot_new']);
    expect(roster.members.map((member) => member.id)).toEqual(['mbr_alice']);
    expect(roster.projects.map((project) => project.id)).toEqual(['conv_project_2']);
  });

  it('没有任何会话时三类名册都保留', () => {
    const roster = teamRosterOf({ bots, members, projects, conversations: [] });
    expect(roster.bots).toEqual(bots);
    expect(roster.members).toEqual(members);
    expect(roster.projects).toEqual(projects);
  });

  it('direct 会话缺 directBotId / dm 缺对端 id 时不误伤', () => {
    const roster = teamRosterOf({
      bots,
      members,
      projects,
      conversations: [
        { id: 'conv_direct_x', type: 'direct', directBotId: null },
        { id: 'conv_dm_unknown', type: 'dm', peerPrincipalIds: null },
      ],
    });
    expect(roster.bots).toEqual(bots);
    expect(roster.members).toEqual(members);
  });

  it('其它类型（card / bot_direct）不参与判定', () => {
    const roster = teamRosterOf({
      bots,
      members,
      projects,
      conversations: [{ id: 'bot_new', type: 'bot_direct', directBotId: 'bot_new' }],
    });
    expect(roster.bots).toEqual(bots);
  });
});

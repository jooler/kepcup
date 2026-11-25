import type { TeamBotView } from '@kepcup/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「+」面板团队分组与 Bot 行 per-bot 菜单的判定层（B4 子域 B，B-4 / B-12）：
 * - 团队上下文判定：web 团队端点 = 'local'；桌面融合 = 当前选中会话的团队
 *   来源（未连接则隐藏分组，不静默切到别的服务器），否则首个已连接团队
 *   来源；非团队上下文恒 null（分组整体不渲染，本地条目零变化）。
 * - per-bot 菜单：成员面 Bot 按 canEdit 出团队编辑；团队端点名单外 / 名单
 *   未决一律无入口（core bots.update 对成员恒拒）；非团队上下文走本地重命名
 *   分支（surface / 状态门控，与现状逐项一致）。
 *
 * teamContext / chat / connections 全 mock（无网络、无 DOM——渲染分支以
 * 判定输出覆盖，AppSidebar 只做接线）。
 */

const h = vi.hoisted(() => ({
  teamActive: false,
  currentSource: null as string | null,
  sources: [] as Array<{ source: string; connected: boolean }>,
}));

vi.mock('$lib/features/team/team-context.svelte', () => ({
  teamContext: {
    get active() {
      return h.teamActive;
    },
  },
}));

vi.mock('$lib/stores/chat.svelte', () => ({
  chat: {
    get currentRef() {
      return h.currentSource === null ? null : { source: h.currentSource, id: 'conv_1' };
    },
  },
}));

vi.mock('$lib/rpc/connections.svelte', () => ({
  connections: {
    sources: () => h.sources.map((entry) => entry.source),
    get: (source: string) => ({
      get status() {
        return h.sources.find((entry) => entry.source === source)?.connected
          ? 'connected'
          : 'offline';
      },
    }),
  },
}));

const { teamPlusSource, botRowMenuAction } = await import('./sidebar-team-group.svelte');

beforeEach(() => {
  h.teamActive = false;
  h.currentSource = null;
  h.sources = [];
});

describe('团队上下文判定 teamPlusSource', () => {
  it('web 团队端点：同源 core 即团队服务器 → local（融合来源不干扰）', () => {
    h.teamActive = true;
    h.sources = [{ source: 'team:h1', connected: true }];
    expect(teamPlusSource()).toBe('local');
  });

  it('桌面融合：当前选中会话的团队来源优先', () => {
    h.currentSource = 'team:h2';
    h.sources = [
      { source: 'team:h1', connected: true },
      { source: 'team:h2', connected: true },
    ];
    expect(teamPlusSource()).toBe('team:h2');
  });

  it('桌面融合：选中本机会话（或未选中）→ 首个已连接团队来源', () => {
    h.currentSource = 'local';
    h.sources = [
      { source: 'team:h1', connected: false },
      { source: 'team:h2', connected: true },
    ];
    expect(teamPlusSource()).toBe('team:h2');
    h.currentSource = null;
    expect(teamPlusSource()).toBe('team:h2');
  });

  it('当前团队来源掉线：分组隐藏（null），不静默切到另一台已连接服务器', () => {
    h.currentSource = 'team:h2';
    h.sources = [
      { source: 'team:h1', connected: true },
      { source: 'team:h2', connected: false },
    ];
    expect(teamPlusSource()).toBe(null);
  });

  it('非团队上下文（无团队来源 / 全未连接）恒 null——分组不渲染、现状一致', () => {
    expect(teamPlusSource()).toBe(null);
    h.sources = [{ source: 'team:h1', connected: false }];
    expect(teamPlusSource()).toBe(null);
  });
});

describe('per-bot 菜单 botRowMenuAction（B-12）', () => {
  const base = {
    memberBots: [],
    memberBotsResolved: true,
    botId: 'bot_1',
    botActive: true,
    editSurfaceHidden: false,
  };

  it('非团队上下文：本地重命名分支与现状逐项一致（surface 门控 / 状态门控）', () => {
    expect(botRowMenuAction({ ...base, teamActive: false })).toEqual({ kind: 'localRename' });
    expect(botRowMenuAction({ ...base, teamActive: false, editSurfaceHidden: true })).toEqual({
      kind: 'none',
    });
    expect(botRowMenuAction({ ...base, teamActive: false, botActive: false })).toEqual({
      kind: 'none',
    });
    expect(botRowMenuAction({ ...base, teamActive: false, botId: null })).toEqual({ kind: 'none' });
  });

  it('成员面 Bot：canEdit → teamEdit（携带视图，转交 / 删除收进编辑框）', () => {
    const view: TeamBotView = {
      id: 'bot_1',
      name: '甲的私有 Bot',
      mode: 'private',
      canEdit: true,
      canDelete: true,
    };
    expect(botRowMenuAction({ ...base, teamActive: true, memberBots: [view] })).toEqual({
      kind: 'teamEdit',
      bot: view,
    });
  });

  it('成员面 Bot：非 owner（canEdit false）无入口——bot-edit surface 不再整体屏蔽', () => {
    const view: TeamBotView = {
      id: 'bot_1',
      name: '共享 Bot',
      mode: 'public',
      canEdit: false,
      canDelete: false,
    };
    expect(botRowMenuAction({ ...base, teamActive: true, memberBots: [view] })).toEqual({
      kind: 'none',
    });
  });

  it('名单外（旧服务器 / 非成员面 Bot，如管家）：团队端点一律无入口（core bots.update 对成员恒拒）', () => {
    // pre-B2 服务器：bot-edit 在 hidden 名单里 → 无入口（与改造前一致）。
    expect(
      botRowMenuAction({ ...base, teamActive: true, editSurfaceHidden: true }),
    ).toEqual({ kind: 'none' });
    // B2 服务器名单外的 Bot（surface 已放开）：本地重命名也必拒 → 不出。
    expect(botRowMenuAction({ ...base, teamActive: true })).toEqual({ kind: 'none' });
  });

  it('名单未决（team.bots.list 在途）：不给会被服务端拒绝的本地入口', () => {
    expect(
      botRowMenuAction({ ...base, teamActive: true, memberBotsResolved: false }),
    ).toEqual({ kind: 'none' });
    expect(
      botRowMenuAction({ ...base, teamActive: true, memberBotsResolved: false, botId: null }),
    ).toEqual({ kind: 'none' });
  });
});

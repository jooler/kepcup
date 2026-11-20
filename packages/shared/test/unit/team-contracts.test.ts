import { describe, expect, it } from 'vitest';
import type {
  AppMethodName,
  RpcMethodName} from '../../src/index.js';
import {
  APP_METHODS,
  APP_RPC_METHODS,
  TEAM_EVENT_NAMES,
  TEAM_RPC_METHODS,
  TEAM_SURFACE_IDS,
  teamBootstrapSchema,
  teamEventSchemas,
  teamMemberSchema,
  teamRpcMethodSchemas,
  teamResolutionViewSchema,
  teamSettingsSchema,
  teamSurfaceIdSchema,
  teamUsageSummarySchema,
  teamVisibilityModeSchema,
  rpcEventSchemas,
  rpcMethodSchemas,
} from '../../src/index.js';

/**
 * 62-team-server T3：团队契约冻结测试 —— README「固定契约」的 shared 团队节。
 * 名字逐字一致（方法 / 事件 / surfaces）；与个人版 RPC 面零交集；strictObject。
 */

/** Compile-time probe: AppMethodName must be a literal union assignable to RpcMethodName. */
const APP_METHOD_NAMES_ARE_LITERAL: AppMethodName extends RpcMethodName
  ? 'team.bootstrap' extends AppMethodName
    ? true
    : never
  : never = true;
void APP_METHOD_NAMES_ARE_LITERAL;

const METHOD_COUNT = 20; // README 固定契约清单逐项枚举（P0×5 + P1×9 + P2×5）+ T7 名册读口 roster，名字不得改动。
const EXPECTED_METHODS = [
  'team.bootstrap',
  'team.members.list',
  'team.dm.open',
  'team.projects.addMembers',
  'team.projects.removeMember',
  'team.projects.roster',
  'team.presence.setAway',
  'team.profile.push',
  'team.projects.transferLead',
  'team.bots.createPrivate',
  'team.bots.updatePrivate',
  'team.bots.deletePrivate',
  'team.settings.get',
  'team.settings.update',
  'team.usage.mine',
  'team.memory.share',
  'team.resolutions.list',
  'team.resolutions.approve',
  'team.resolutions.revoke',
  'team.resolutions.withdraw',
];

const MBR = 'mbr_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MBR2 = 'mbr_01ARZ3NDEKTSV4RRFFQ69G5FBS';

function member(overrides: Record<string, unknown> = {}) {
  return { id: MBR, displayName: '阿李', state: 'online', ...overrides };
}

describe('team rpc method registry', () => {
  it('freezes the fixed contract method names verbatim', () => {
    expect([...TEAM_RPC_METHODS]).toEqual(EXPECTED_METHODS);
    expect(TEAM_RPC_METHODS.length).toBe(METHOD_COUNT);
    expect(Object.keys(teamRpcMethodSchemas).length).toBe(METHOD_COUNT);
    for (const name of EXPECTED_METHODS) {
      const io = teamRpcMethodSchemas[name as keyof typeof teamRpcMethodSchemas];
      expect(io, name).toBeDefined();
      expect(io.input, `${name}.input`).toBeDefined();
      expect(io.output, `${name}.output`).toBeDefined();
    }
  });

  it('team methods never overlap the personal-edition app surface', () => {
    const app = new Set<string>(APP_RPC_METHODS);
    for (const name of TEAM_RPC_METHODS) expect(app.has(name), name).toBe(false);
    // `APP_METHODS` remains the complete port-A surface (as const export, T3).
    expect(APP_METHODS.length).toBe(APP_RPC_METHODS.length);
    expect(APP_METHODS).toContain('messages.send');
    expect(APP_METHODS).not.toContain('team.bootstrap');
    for (const name of APP_METHODS) expect(rpcMethodSchemas[name as keyof typeof rpcMethodSchemas]).toBeDefined();
  });

  it('strict inputs reject unknown fields (samples)', () => {
    expect(
      teamRpcMethodSchemas['team.settings.update'].input.safeParse({
        settings: { quietHours: { enabled: true, startMinute: 0, endMinute: 480 } },
        sneaky: 1,
      }).success,
    ).toBe(false);
    expect(
      teamRpcMethodSchemas['team.dm.open'].input.safeParse({ targetMemberId: MBR2, extra: true })
        .success,
    ).toBe(false);
    expect(
      teamRpcMethodSchemas['team.resolutions.approve'].input.safeParse({
        resolutionId: 'res_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        version: 2,
      }).success,
    ).toBe(true);
  });

  it('T6 P1 shapes: setAway extension, profile.push counts, usage range', () => {
    // setAway 扩展（62.06 §2 薄契约）：note / avatar 可选，avatar 只带 botName。
    expect(
      teamRpcMethodSchemas['team.presence.setAway'].input.safeParse({
        away: true,
        note: '下午回',
        avatar: { botName: '管家' },
      }).success,
    ).toBe(true);
    expect(
      teamRpcMethodSchemas['team.presence.setAway'].input.safeParse({
        away: true,
        avatar: { botName: '管家', botId: 'bot_x' },
      }).success,
    ).toBe(false);
    expect(
      teamRpcMethodSchemas['team.presence.setAway'].input.safeParse({ away: false }).success,
    ).toBe(true);

    // profile.push 返回 {added, skipped}（T6 实现口径）。
    const pushed = teamRpcMethodSchemas['team.profile.push'].output.parse({
      added: 3,
      skipped: 1,
    });
    expect(pushed).toEqual({ added: 3, skipped: 1 });
    expect(
      teamRpcMethodSchemas['team.profile.push'].output.safeParse({ ok: true }).success,
    ).toBe(false);

    // usage.mine 可选 range（UTC ms 闭开区间）。
    expect(
      teamRpcMethodSchemas['team.usage.mine'].input.safeParse({
        range: { from: 1736870400000, to: 1736956800000 },
      }).success,
    ).toBe(true);
    expect(teamRpcMethodSchemas['team.usage.mine'].input.safeParse({}).success).toBe(true);
    expect(
      teamRpcMethodSchemas['team.usage.mine'].input.safeParse({
        range: { from: 2, to: 1 },
      }).success,
    ).toBe(false);
  });

  it('T7 roster shape: card + role, strict, leadMemberId nullable', () => {
    // 输入：只收 conversationId（strict）。
    expect(
      teamRpcMethodSchemas['team.projects.roster'].input.safeParse({
        conversationId: 'cnv_proj',
      }).success,
    ).toBe(true);
    expect(
      teamRpcMethodSchemas['team.projects.roster'].input.safeParse({
        conversationId: 'cnv_proj',
        memberIds: [MBR],
      }).success,
    ).toBe(false);

    // 输出：成员卡（team.members.list 同形）+ role；leadMemberId 可空；多余字段拒。
    const roster = teamRpcMethodSchemas['team.projects.roster'].output.parse({
      members: [
        { id: MBR, displayName: '阿李', state: 'online', role: 'lead' },
        { id: MBR2, displayName: 'Bob', avatar: null, state: 'away', role: 'member', avatarBotName: '管家' },
      ],
      leadMemberId: MBR,
    });
    expect(roster.members[0]).toMatchObject({ id: MBR, role: 'lead' });
    expect(roster.members[1]).toMatchObject({ id: MBR2, role: 'member', avatarBotName: '管家' });
    expect(
      teamRpcMethodSchemas['team.projects.roster'].output.safeParse({
        members: [{ id: MBR, displayName: '阿李', state: 'online', role: 'owner' }],
        leadMemberId: null,
      }).success,
    ).toBe(false);
    expect(
      teamRpcMethodSchemas['team.projects.roster'].output.safeParse({
        members: [],
        leadMemberId: null,
        callerEnrolled: true,
      }).success,
    ).toBe(false);
    expect(
      teamRpcMethodSchemas['team.projects.roster'].output.safeParse({
        members: [{ id: MBR, displayName: '阿李', state: 'online', role: 'member' }],
        leadMemberId: null,
      }).success,
    ).toBe(true);
  });
});

describe('team event registry', () => {
  it('freezes the fixed event names and never collides with core events', () => {
    expect([...TEAM_EVENT_NAMES]).toEqual([
      'member.presenceChanged',
      'member.updated',
      'member.disabled',
      'team.avatarRevoked',
    ]);
    const core = new Set<string>(Object.keys(rpcEventSchemas));
    for (const name of TEAM_EVENT_NAMES) expect(core.has(name), name).toBe(false);
  });

  it('event payloads are strict (samples)', () => {
    const presence = teamEventSchemas['member.presenceChanged'].parse({
      memberId: MBR,
      state: 'away',
      lastSeenAt: 1736937000000,
    });
    expect(presence.state).toBe('away');
    expect(
      teamEventSchemas['member.presenceChanged'].safeParse({ memberId: MBR, state: 'busy' })
        .success,
    ).toBe(false);
    expect(
      teamEventSchemas['member.disabled'].safeParse({ memberId: MBR, reason: 'x' }).success,
    ).toBe(false);
    expect(
      teamEventSchemas['team.avatarRevoked'].safeParse({ memberId: MBR, botId: 'bot_x' }).success,
    ).toBe(true);
    // T6：presenceChanged 增 avatar / note（可选，仅离开态出现）。
    const awayWithAvatar = teamEventSchemas['member.presenceChanged'].parse({
      memberId: MBR,
      state: 'away',
      avatar: { botName: '管家' },
      note: '下午回',
    });
    expect(awayWithAvatar.avatar).toEqual({ botName: '管家' });
    expect(
      teamEventSchemas['member.presenceChanged'].safeParse({
        memberId: MBR,
        state: 'away',
        avatar: { botName: '管家', extra: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('team domain schemas', () => {
  it('bootstrap accepts the full payload and rejects unknown fields', () => {
    const bootstrap = teamBootstrapSchema.parse({
      member: member({ avatar: null, lastSeenAt: 1736937000000 }),
      server: { name: 'KepCup 团队服务器', version: '0.1.0' },
      surfaces: { hidden: ['unattended', 'open-external', 'workdir-pick'] },
      conversations: [
        {
          id: 'conv_1',
          type: 'dm',
          title: null,
          directBotId: null,
          workdirId: null,
          readOnly: false,
          summary: null,
          summaryUptoSeq: 0,
          lastSeq: 0,
          lastReadSeq: 0,
          lastMessageAt: null,
          createdAt: 1,
          peerPrincipalIds: [MBR, MBR2],
        },
      ],
      permissionCeiling: 'auto',
    });
    expect(bootstrap.member.state).toBe('online');
    expect(bootstrap.surfaces.hidden).toEqual(['unattended', 'open-external', 'workdir-pick']);
    expect(
      teamBootstrapSchema.safeParse({
        member: member(),
        server: { name: 's', version: 'v' },
        surfaces: { hidden: [] },
        conversations: [],
        permissionCeiling: 'auto',
        extra: 1,
      }).success,
    ).toBe(false);
    // Ceiling is a PermissionMode enum, not a free string.
    expect(
      teamBootstrapSchema.safeParse({
        member: member(),
        server: { name: 's', version: 'v' },
        surfaces: { hidden: [] },
        conversations: [],
        permissionCeiling: 'unlimited',
      }).success,
    ).toBe(false);
  });

  it('members, visibility and surfaces keep their fixed shapes', () => {
    expect(teamMemberSchema.safeParse(member({ ghost: true })).success).toBe(false);
    expect(teamMemberSchema.parse(member({ state: 'offline' })).state).toBe('offline');
    expect(teamVisibilityModeSchema.safeParse('open').success).toBe(false);
    expect(teamVisibilityModeSchema.safeParse('restricted').success).toBe(true);
    // Surface domain = SettingsSectionId ∪ EndpointCapabilityId ∪ team-only ids.
    for (const id of TEAM_SURFACE_IDS) expect(teamSurfaceIdSchema.safeParse(id).success).toBe(true);
    expect(teamSurfaceIdSchema.safeParse('not-a-surface').success).toBe(false);
    const ids = new Set<string>(TEAM_SURFACE_IDS);
    expect(ids.size).toBe(TEAM_SURFACE_IDS.length); // sync mistakes surface as duplicates
    expect(ids.has('computer-use')).toBe(true); // in both source unions, listed once
    expect(ids.has('extension-center')).toBe(true);
    expect(ids.has('diagnostics')).toBe(true);
    expect(ids.has('local-file-dialog')).toBe(true);
  });

  it('P1 member-domain settings and usage keep minimal strict shapes', () => {
    const settings = teamSettingsSchema.parse({
      quietHours: { enabled: true, startMinute: 1320, endMinute: 480 },
    });
    expect(settings.quietHours?.endMinute).toBe(480);
    expect(teamSettingsSchema.safeParse({ quietHours: { enabled: true, start: 1 } }).success).toBe(
      false,
    );
    const usage = teamUsageSummarySchema.parse({
      directTotal: 1.25,
      byDay: [{ dayStart: 1736870400000, total: 0.5 }],
      byBot: [{ botId: 'bot_01ARZ3NDEKTSV4RRFFQ69G5FAV', total: 0.75 }],
    });
    expect(usage.directTotal).toBe(1.25);
    expect(teamUsageSummarySchema.safeParse({ directTotal: 'x' }).success).toBe(false);
  });

  // --- T9（决议卡 / 用量全口径）：只增用例 -------------------------------------

  it('T9 resolution view: strict state enum, snapshot signature details, body', () => {
    const view = {
      id: 'res_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      conversationId: 'cnv_proj',
      issuedByBotId: 'bot_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      state: 'open',
      title: '发布 v2',
      body: '目标：…\n范围：…\n执行要点：…',
      version: 2,
      myApprovalVersion: null,
      snapshot: [
        { memberId: MBR, name: '阿李', approvedVersion: 1 },
        { memberId: MBR2, name: 'Bob', approvedVersion: null },
      ],
      createdAt: 1736870400000,
      updatedAt: 1736870500000,
      cardMessageId: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    };
    const parsed = teamResolutionViewSchema.parse(view);
    expect(parsed.state).toBe('open');
    expect(parsed.snapshot[0]).toMatchObject({ memberId: MBR, approvedVersion: 1 });
    // state 枚举收死：其它值拒绝。
    expect(teamResolutionViewSchema.safeParse({ ...view, state: 'closed' }).success).toBe(false);
    // 快照结构 strict：多余字段 / 错型拒绝。
    expect(
      teamResolutionViewSchema.safeParse({
        ...view,
        snapshot: [{ memberId: MBR, name: '阿李', approvedVersion: 'v1' }],
      }).success,
    ).toBe(false);
    expect(
      teamResolutionViewSchema.safeParse({
        ...view,
        snapshot: [{ memberId: MBR, name: '阿李', approvedVersion: null, note: 'x' }],
      }).success,
    ).toBe(false);
    // body / version 必填（签署绑定版本的前提）。
    const { body: _body, ...withoutBody } = view;
    void _body;
    expect(teamResolutionViewSchema.safeParse(withoutBody).success).toBe(false);
    // 可选尾随字段：passed / withdrawn / supersedes 展示位。
    expect(
      teamResolutionViewSchema.safeParse({
        ...view,
        state: 'passed',
        passedAt: 1736870600000,
        myApprovalVersion: 2,
        snapshot: [{ memberId: MBR, name: '阿李', approvedVersion: 2 }],
      }).success,
    ).toBe(true);
    expect(
      teamResolutionViewSchema.safeParse({
        ...view,
        state: 'withdrawn',
        withdrawnAt: 1736870600000,
        withdrawnBy: MBR,
        supersedesResolutionId: null,
      }).success,
    ).toBe(true);
  });

  it('T9 resolutions io: withdraw carries optional reason; approve output is the view', () => {
    expect(
      teamRpcMethodSchemas['team.resolutions.withdraw'].input.safeParse({
        resolutionId: 'res_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        reason: '方向变了',
      }).success,
    ).toBe(true);
    expect(
      teamRpcMethodSchemas['team.resolutions.withdraw'].input.safeParse({
        resolutionId: 'res_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }).success,
    ).toBe(true);
    expect(
      teamRpcMethodSchemas['team.resolutions.withdraw'].input.safeParse({
        resolutionId: 'res_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        reason: 'x'.repeat(501),
      }).success,
    ).toBe(false);
    // list 出参带快照签署明细；圈外无关字段拒。
    expect(
      teamRpcMethodSchemas['team.resolutions.list'].output.safeParse({
        resolutions: [
          {
            id: 'res_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            conversationId: 'cnv_proj',
            issuedByBotId: 'bot_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            state: 'open',
            title: 't',
            body: 'b',
            version: 1,
            myApprovalVersion: null,
            snapshot: [{ memberId: MBR, name: '阿李', approvedVersion: null }],
            createdAt: 1,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      teamRpcMethodSchemas['team.resolutions.approve'].output.safeParse({
        id: 'res_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        conversationId: 'cnv_proj',
        issuedByBotId: 'bot_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        state: 'passed',
        title: 't',
        body: 'b',
        version: 1,
        myApprovalVersion: 1,
        snapshot: [],
        createdAt: 1,
      }).success,
    ).toBe(true);
  });

  it('T9 usage.mine summary: full attribution fields are additive and strict', () => {
    const full = teamUsageSummarySchema.parse({
      directTotal: 1.25,
      byDay: [{ dayStart: 1736870400000, total: 2.5 }],
      byBot: [{ botId: 'bot_01ARZ3NDEKTSV4RRFFQ69G5FAV', total: 2.5 }],
      projectShareTotal: 0.5,
      otherTotal: 0.25,
      platformTotal: 3,
    });
    expect(full.projectShareTotal).toBe(0.5);
    expect(full.platformTotal).toBe(3);
    // 旧 shape（无新增字段）仍合法（additive）。
    expect(
      teamUsageSummarySchema.safeParse({ directTotal: 1.25, byBot: [] }).success,
    ).toBe(true);
    expect(teamUsageSummarySchema.safeParse({ directTotal: 1, unknown: 1 }).success).toBe(false);
  });
});

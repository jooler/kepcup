import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@kepcup/shared';

/**
 * T9 决议卡（62.09 §5）：渲染决策逻辑级测试（无 DOM mount 基建，按 T8 的做法
 * 断言 resolution-card.svelte.ts 的派生与动作语义）——载荷解析（shared
 * resolutionCardSchema 校验 / 非决议卡 null）、签署三态（已签 / 待重签 / 未签）、
 * 按钮显隐（本人 ∈ 快照才可签；项目负责人 = roster 的 leadMemberId；作废与通过
 * 置灰）、动作带版本号与 stale / locked 错误归类、ROSTER 读口失败保持隐藏。
 */

const h = vi.hoisted(() => {
  return {
    memberId: 'mbr_alice' as string | null,
    status: 'connected' as 'connected' | 'offline',
    calls: [] as Array<{ method: string; input: unknown }>,
    responder: (method: string, input: Record<string, unknown>): unknown => {
      void method;
      void input;
      return {};
    },
  };
});

vi.mock('$lib/rpc/connections.svelte', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 测试 mock 的模块类型标注。
  const actual = (await importOriginal()) as typeof import('$lib/rpc/connections.svelte');
  return {
    ...actual,
    connections: {
      get: (source: string) => {
        void source;
        return {
          status: h.status,
          memberId: h.memberId,
          call: (method: string, input?: unknown) => {
            h.calls.push({ method, input });
            return Promise.resolve(h.responder(method, (input ?? {}) as Record<string, unknown>));
          },
        };
      },
    },
  };
});

const { ResolutionCardState, resolutionCardDataOf, signatureStateOf } = await import(
  './resolution-card.svelte'
);

function cardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resolutionId: 'res_1',
    title: '发布 v2',
    body: '目标：周五发布。',
    version: 2,
    state: 'open',
    snapshot: [
      { memberId: 'mbr_alice', name: 'Alice', approvedVersion: null },
      { memberId: 'mbr_bob', name: 'Bob', approvedVersion: null },
    ],
    ...overrides,
  };
}

function messageOf(data: Record<string, unknown>): Message {
  return {
    id: 'msg_1',
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'system',
    senderBotId: null,
    kind: 'card',
    content: { cardType: 'resolution', hostCard: { data } },
    replyTo: null,
    mentions: [],
    attachments: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 0,
    ownerBotId: null,
    taskId: null,
    senderPrincipalId: null,
    senderName: null,
  } as unknown as Message;
}

function state(): InstanceType<typeof ResolutionCardState> {
  return new ResolutionCardState({ source: 'team:h1' as never, conversationId: 'conv_1' });
}

beforeEach(() => {
  h.memberId = 'mbr_alice';
  h.status = 'connected';
  h.calls = [];
  h.responder = () => ({});
});

describe('resolutionCardDataOf：载荷解析', () => {
  it('决议卡消息解析出载荷；快照 / 版本 / 状态齐备', () => {
    const data = resolutionCardDataOf(messageOf(cardData()).content);
    expect(data).toMatchObject({ resolutionId: 'res_1', version: 2, state: 'open' });
    expect(data?.snapshot).toHaveLength(2);
  });

  it('非决议卡 / 缺 hostCard / 载荷不合法（strict：未知字段、错状态）= null', () => {
    expect(resolutionCardDataOf({ cardType: 'mail', mailSummary: 'x' })).toBeNull();
    expect(resolutionCardDataOf({ cardType: 'resolution' })).toBeNull();
    expect(resolutionCardDataOf({ cardType: 'resolution', hostCard: { data: { ghost: true } } })).toBeNull();
    expect(
      resolutionCardDataOf(messageOf(cardData({ state: 'closed' })).content),
    ).toBeNull();
    expect(
      resolutionCardDataOf(
        messageOf(cardData({ snapshot: [{ memberId: 'x', name: 'X', approvedVersion: 'v1' }] })).content,
      ),
    ).toBeNull();
  });
});

describe('signatureStateOf：快照成员签署三态', () => {
  it('签当前版本 = signed；签旧版本 = stale（待重签）；未签 = unsigned', () => {
    expect(signatureStateOf({ memberId: 'm', name: 'M', approvedVersion: 2 }, 2)).toBe('signed');
    expect(signatureStateOf({ memberId: 'm', name: 'M', approvedVersion: 1 }, 2)).toBe('stale');
    expect(signatureStateOf({ memberId: 'm', name: 'M', approvedVersion: null }, 2)).toBe('unsigned');
  });
});

describe('ResolutionCardState：按钮显隐与动作', () => {
  it('讨论中 + 在快照 + 未签 → 可签；签过当前版本 → 可撤回；不在快照 → 都不可', () => {
    const card = state();
    card.applyMessage(messageOf(cardData()).content);
    expect(card.canApprove).toBe(true);
    expect(card.canRevoke).toBe(false);

    card.applyMessage(
      messageOf(
        cardData({
          snapshot: [{ memberId: 'mbr_alice', name: 'Alice', approvedVersion: 2 }],
        }),
      ).content,
    );
    expect(card.canApprove).toBe(false);
    expect(card.canRevoke).toBe(true);

    // 不在快照（发起后加入者）：两个按钮都不出。
    h.memberId = 'mbr_carol';
    expect(card.canApprove).toBe(false);
    expect(card.canRevoke).toBe(false);
  });

  it('通过 / 作废卡：签署动作全部隐藏（锁定置灰）；withdrawn 展示作废人', () => {
    const card = state();
    card.applyMessage(messageOf(cardData({ state: 'passed', passedAt: 1 })).content);
    expect(card.canApprove).toBe(false);
    expect(card.canRevoke).toBe(false);
    card.applyMessage(messageOf(cardData({ state: 'withdrawn', withdrawnAt: 1, withdrawnBy: 'mbr_bob' })).content);
    expect(card.canApprove).toBe(false);
  });

  it('项目负责人「作废」：roster 的 leadMemberId = 本人才显示；读到 null / 失败保持隐藏', async () => {
    const card = state();
    card.applyMessage(messageOf(cardData()).content);
    expect(card.canWithdraw).toBe(false);

    h.responder = (method) =>
      method === 'team.projects.roster' ? { leadMemberId: 'mbr_alice' } : {};
    await card.loadLead();
    expect(card.canWithdraw).toBe(true);

    h.responder = (method) =>
      method === 'team.projects.roster' ? { leadMemberId: 'mbr_bob' } : {};
    await card.loadLead();
    expect(card.canWithdraw).toBe(false);

    h.status = 'offline';
    await card.loadLead();
    expect(card.leadMemberId).toBeNull();
    expect(card.canWithdraw).toBe(false);
  });

  it('approve 带当前版本号调用；RESOLUTION_STALE 归类为 lastError（卡片随后随 message.updated 收敛）', async () => {
    const card = state();
    card.applyMessage(messageOf(cardData()).content);
    h.responder = () => {
      throw Object.assign(new Error('stale'), { code: 'RESOLUTION_STALE' });
    };
    expect(await card.approve()).toBe(false);
    expect(h.calls[0]).toMatchObject({
      method: 'team.resolutions.approve',
      input: { resolutionId: 'res_1', version: 2 },
    });
    expect(card.lastError).toBe('RESOLUTION_STALE');
    expect(card.busy).toBe(false);

    // 成功路径：错误清空。
    h.calls = [];
    h.responder = () => ({});
    expect(await card.approve()).toBe(true);
    expect(card.lastError).toBeNull();
    expect(h.calls[0]?.method).toBe('team.resolutions.approve');
  });

  it('revoke / withdraw 走对应方法；错误码透传归类（RESOLUTION_LOCKED / NOT_PROJECT_LEAD / OTHER）', async () => {
    const card = state();
    card.applyMessage(
      messageOf(
        cardData({ snapshot: [{ memberId: 'mbr_alice', name: 'Alice', approvedVersion: 2 }] }),
      ).content,
    );
    expect(await card.revoke()).toBe(true);
    expect(h.calls[0]).toMatchObject({ method: 'team.resolutions.revoke', input: { resolutionId: 'res_1' } });

    h.responder = (method) => {
      if (method === 'team.projects.roster') return { leadMemberId: 'mbr_alice' };
      throw Object.assign(new Error('locked'), { code: 'RESOLUTION_LOCKED' });
    };
    await card.loadLead();
    expect(await card.withdraw()).toBe(false);
    expect(card.lastError).toBe('RESOLUTION_LOCKED');

    h.responder = (method) => {
      if (method === 'team.projects.roster') return { leadMemberId: 'mbr_alice' };
      throw Object.assign(new Error('nope'), { code: 'NOT_PROJECT_LEAD' });
    };
    expect(await card.withdraw()).toBe(false);
    expect(card.lastError).toBe('NOT_PROJECT_LEAD');

    h.responder = (method) => {
      if (method === 'team.projects.roster') return { leadMemberId: 'mbr_alice' };
      throw new Error('boom');
    };
    expect(await card.withdraw()).toBe(false);
    expect(card.lastError).toBe('OTHER');
  });
});

import { describe, expect, it } from 'vitest';
import type { Bot, Conversation, MemoryItem, Schedule, SkillEntry, Watch } from '@kepcup/shared';
import { botProfile } from '@kepcup/testkit';
import { HandoverRegistry } from '../../src/handover/registry.js';
import { WatchAdapter } from '../../src/handover/adapters/watch.js';
import { SkillAdapter } from '../../src/handover/adapters/skill.js';
import {
  MemoryAdapter,
  memoryRefusal,
  type HandoverMemoryPort,
} from '../../src/handover/adapters/memory.js';
import { ScheduleAdapter } from '../../src/handover/adapters/schedule.js';
import type { NewMemoryItem } from '../../src/memory/store.js';
import type { HandoverContext } from '../../src/handover/types.js';

/**
 * D88 P1 适配器（todo/bot-handover.md §4）：网页监看（就地改归属、保留检查状态）、技能
 * （导入的同版本、自写的复制、同名置灰、停用照搬）、记忆（按条复制、三处过滤、敏感默认
 * 不勾、来源记录、幂等）、承诺随定时任务迁移（复制 → 移交 → 作废，崩溃后只补剩下的）。
 * 依赖全部用内存桩。
 */

function makeBot(id: string, name: string): Bot {
  return {
    id,
    name,
    avatar: null,
    bio: '',
    profile: botProfile({ name }),
    status: 'active',
    setupState: null,
    systemRole: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const A = makeBot('bot_a', 'A');
const B = makeBot('bot_b', 'B');

function ctx(toBot: Bot | null = B, handoverId = 'hnd_1'): HandoverContext & { toBot: Bot } {
  return { handoverId, fromBot: A, toBot: toBot as Bot, toName: toBot?.name ?? '新人' };
}

const conversations: Record<string, Partial<Conversation>> = {
  conv_a: { id: 'conv_a', type: 'direct', directBotId: 'bot_a', readOnly: false, title: null },
  conv_g: { id: 'conv_g', type: 'group', directBotId: null, readOnly: false, title: '盯价群' },
};

function conversationPort(members: Record<string, string[]>) {
  return {
    get: (id: string) => (conversations[id] as Conversation | undefined) ?? null,
    memberBotIds: (id: string) => members[id] ?? [],
    directIdFor: (botId: string) => `direct_${botId}`,
  };
}

describe('watch adapter', () => {
  function watch(id: string, conversationId: string, extra: Partial<Watch> = {}): Watch {
    return {
      id,
      botId: 'bot_a',
      conversationId,
      source: { kind: 'web_page', url: `https://shop.test/${id}` },
      condition: { kind: 'changed' },
      intervalSec: 3600,
      status: 'active',
      lastHash: 'h1',
      lastQuietHash: 'q1',
      lastMatched: false,
      alertSeq: 3,
      failures: 0,
      nextCheckAt: 1,
      lastCheckedAt: 1,
      lastError: null,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    } as Watch;
  }

  function setup(opts: { liveOfB?: number; profiles?: Record<string, string> } = {}) {
    const rows = new Map<string, Watch>([
      ['wat_d', watch('wat_d', 'conv_a')],
      ['wat_g', watch('wat_g', 'conv_g', { status: 'paused' })],
      ['wat_s', watch('wat_s', 'conv_a', { status: 'stopped' })],
    ]);
    const members: Record<string, string[]> = { conv_a: ['bot_a'], conv_g: ['bot_a'] };
    const transfers: string[] = [];
    const adapter = new WatchAdapter({
      watches: {
        listLiveForBot: (botId) =>
          [...rows.values()].filter((row) => row.botId === botId && row.status !== 'stopped'),
        get: (id) => rows.get(id) ?? null,
        countLiveForBot: (botId) =>
          botId === 'bot_b'
            ? (opts.liveOfB ?? 0)
            : [...rows.values()].filter((r) => r.botId === botId).length,
        transferTo: (id, target) => {
          transfers.push(`${id}->${target.conversationId}`);
          // In place: same id, check state kept.
          const moved = { ...rows.get(id)!, ...target, version: rows.get(id)!.version + 1 };
          rows.set(id, moved);
          return moved;
        },
        profileKeyFor: (botId) => opts.profiles?.[botId] ?? `bot:${botId}`,
      },
      conversations: conversationPort(members),
    });
    return { adapter, rows, transfers, members };
  }

  it('lists live watches only (paused kept, stopped left out), as move-only external entries', () => {
    const { adapter } = setup();
    const entries = adapter.inventory('bot_a');
    expect(entries.map((entry) => entry.key)).toEqual(['watch:wat_d', 'watch:wat_g']);
    expect(entries[0]).toMatchObject({
      type: 'watch',
      label: 'https://shop.test/wat_d',
      actions: ['move'],
      defaultAction: 'move',
      external: true,
    });
    expect(entries[0]!.detail).toContain('私聊');
    expect(entries[1]!.detail).toContain('群「盯价群」');
    expect(entries[1]!.detail).toContain('已暂停');
  });

  it('group watches need B in the group; B’s cap is checked; only move', () => {
    const { adapter, members } = setup({ liveOfB: 20 });
    expect(adapter.validate(ctx(), 'watch:wat_d', 'copy')).toBe('网页监看只能移交');
    expect(adapter.validate(ctx(), 'watch:wat_d', 'move')).toContain('上限');
    const fresh = setup();
    expect(fresh.adapter.validate(ctx(), 'watch:wat_g', 'move')).toBe('B 不在群「盯价群」里');
    // New target (not created yet): a blank bot is in no group.
    expect(fresh.adapter.validate(ctx(null), 'watch:wat_g', 'move')).toContain('不在群');
    fresh.members['conv_g'] = ['bot_a', 'bot_b'];
    expect(fresh.adapter.validate(ctx(), 'watch:wat_g', 'move')).toBeNull();
    expect(fresh.adapter.validate(ctx(), 'watch:wat_d', 'move')).toBeNull();
    expect(fresh.adapter.validate(ctx(), 'watch:wat_s', 'move')).toBe('这个监看已停止');
    void members;
  });

  it('a direct-chat watch moves in place to B’s direct chat, keeping its check state; re-apply is a no-op', async () => {
    const { adapter, rows, transfers } = setup();
    expect(adapter.isApplied(ctx(), 'watch:wat_d')).toBe(false);
    await adapter.apply(ctx(), 'watch:wat_d');
    expect(transfers).toEqual(['wat_d->direct_bot_b']);
    expect(rows.get('wat_d')).toMatchObject({
      id: 'wat_d',
      botId: 'bot_b',
      conversationId: 'direct_bot_b',
      lastHash: 'h1',
      lastQuietHash: 'q1',
      alertSeq: 3,
    });
    expect(adapter.isApplied(ctx(), 'watch:wat_d')).toBe(true);
  });

  it('warns that login state does not travel when the browser profiles differ', () => {
    const { adapter } = setup();
    const entry = adapter.inventory('bot_a')[0]!;
    expect(adapter.warnings(ctx(), entry)[0]).toContain('重新登录');
    const shared = setup({ profiles: { bot_a: 'shared:x', bot_b: 'shared:x' } });
    expect(shared.adapter.warnings(ctx(), entry)).toEqual([]);
  });
});

describe('skill adapter', () => {
  function skill(name: string, extra: Partial<SkillEntry> = {}): SkillEntry {
    return {
      botId: 'bot_a',
      name,
      kind: 'imported',
      scope: 'private',
      status: 'active',
      statusReason: null,
      description: `${name} 的描述`,
      compatibility: 'compatible',
      libraryId: `lib_${name}`,
      sourceUrl: `https://example.com/${name}.git`,
      commitOid: null,
      relPath: null,
      missingDeps: [],
      enhancedRequired: false,
      enhancedInstallHint: null,
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    } as SkillEntry;
  }

  function setup() {
    const own: Record<string, SkillEntry[]> = {
      bot_a: [
        skill('deploy'),
        skill('weekly', { kind: 'authored', libraryId: null, sourceUrl: null, status: 'disabled' }),
        skill('half', { kind: 'authored', libraryId: null, sourceUrl: null, status: 'draft' }),
        skill('clash'),
      ],
      bot_b: [skill('clash', { botId: 'bot_b' })],
    };
    const copies: string[] = [];
    const adapter = new SkillAdapter({
      skills: {
        privateEntries: (botId) => own[botId] ?? [],
        privateEntry: (botId, name) => own[botId]?.find((s) => s.name === name) ?? null,
        contentAvailable: () => true,
        isHandoverCopy: (_from, to, name) => (own[to] ?? []).some((s) => s.name === name),
        copyForHandover: async (input) => {
          copies.push(`${input.name}:${input.fromName}->${input.toBotId}`);
          const source = own[input.fromBotId]!.find((s) => s.name === input.name)!;
          own[input.toBotId] = [...(own[input.toBotId] ?? []), { ...source, botId: input.toBotId }];
        },
      },
    });
    return { adapter, own, copies };
  }

  it('lists imported (marked 外部导入) and authored skills, not drafts; copy only', () => {
    const { adapter } = setup();
    const entries = adapter.inventory('bot_a');
    expect(entries.map((entry) => entry.key)).toEqual([
      'skill:deploy',
      'skill:weekly',
      'skill:clash',
    ]);
    expect(entries[0]).toMatchObject({
      actions: ['copy'],
      defaultAction: 'copy',
      marks: ['external_import'],
    });
    expect(entries[0]!.detail).toContain('外部导入');
    expect(entries[1]!.marks).toEqual([]);
    expect(entries[1]!.detail).toContain('已停用');
    expect(adapter.describe(entries[0]!, 'copy', 'B')).toContain('不再单独审批');
  });

  it('a same-name private skill on B greys the item out; a draft / unknown one is not copyable', () => {
    const { adapter } = setup();
    expect(adapter.validate(ctx(), 'skill:clash', 'copy')).toBe('B 已有同名技能 clash');
    expect(adapter.validate(ctx(), 'skill:deploy', 'move')).toBe('技能只能复制');
    expect(adapter.validate(ctx(), 'skill:half', 'copy')).toContain('已没有技能');
    expect(adapter.validate(ctx(null), 'skill:clash', 'copy')).toBeNull();
    expect(adapter.validate(ctx(), 'skill:deploy', 'copy')).toBeNull();
  });

  it('apply copies once (status carries over in the service); isApplied afterwards', async () => {
    const { adapter, copies, own } = setup();
    await adapter.apply(ctx(), 'skill:weekly');
    expect(copies).toEqual(['weekly:A->bot_b']);
    expect(own['bot_b']!.find((s) => s.name === 'weekly')!.status).toBe('disabled');
    expect(adapter.isApplied(ctx(), 'skill:weekly')).toBe(true);
  });
});

/** In-memory per-bot memory store (handover port). */
function memoryWorld(seed: Record<string, MemoryItem[]>) {
  const items = new Map<string, MemoryItem[]>(Object.entries(seed));
  let next = 0;
  const embedded: string[] = [];
  const voided: string[] = [];
  const port: HandoverMemoryPort = {
    get: (botId, id) => items.get(botId)?.find((item) => item.id === id) ?? null,
    activeItems: (botId) => (items.get(botId) ?? []).filter((item) => item.status === 'active'),
    search: (botId, query) =>
      (items.get(botId) ?? []).filter(
        (item) => item.status === 'active' && item.content.includes(query),
      ),
    findCopy: (botId, handoverId, fromItemId) =>
      (items.get(botId) ?? []).find((item) =>
        item.evidence.some((e) => e.handoverId === handoverId && e.fromItemId === fromItemId),
      ) ?? null,
    activeWithContent: (botId, content) =>
      (items.get(botId) ?? []).find(
        (item) => item.status === 'active' && item.content.trim() === content.trim(),
      ) ?? null,
    insertCopy: (botId, input: NewMemoryItem) => {
      next += 1;
      const item = memory(`mem_new${next}`, input.content, {
        ...input,
        botId,
        subject: input.subject ?? null,
        originConversationId: input.originConversationId ?? null,
        dueAt: input.dueAt ?? null,
        validUntil: input.validUntil ?? null,
      });
      items.set(botId, [...(items.get(botId) ?? []), item]);
      return item;
    },
    embed: async (_botId, item) => {
      embedded.push(item.id);
    },
    voidCommitment: (botId, id) => {
      const item = port.get(botId, id);
      if (item === null || item.status !== 'active') return false;
      items.set(
        botId,
        (items.get(botId) ?? []).map((m) => (m.id === id ? { ...m, status: 'void' as const } : m)),
      );
      voided.push(id);
      return true;
    },
  };
  return { port, items, embedded, voided };
}

function memory(id: string, content: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    botId: 'bot_a',
    kind: 'preference',
    content,
    subject: null,
    source: 'explicit',
    evidence: [{ messageId: 'msg_1', conversationId: 'conv_a', runId: null }],
    origin: 'private',
    originConversationId: 'conv_a',
    confidence: 0.9,
    sensitivity: 'normal',
    privateToBot: false,
    dueAt: null,
    validUntil: null,
    status: 'active',
    supersedes: null,
    lastUsedAt: null,
    useCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as MemoryItem;
}

describe('memory adapter', () => {
  function setup() {
    const world = memoryWorld({
      bot_a: [
        memory('mem_pref', '用户喜欢简洁的周报'),
        memory('mem_sens', '用户的体检报告在周报文件夹', { sensitivity: 'sensitive' }),
        memory('mem_priv', '只告诉你：周报其实是老板写的', { privateToBot: true }),
        memory('mem_self', '我写周报总是太长', { kind: 'self_note' }),
        memory('mem_old', '用户以前喜欢长周报', { status: 'superseded' }),
        memory('mem_exp', '本周周报延期', { validUntil: 5 }),
        memory('mem_com', '周五前交周报', { kind: 'commitment', dueAt: 100 }),
      ],
      bot_b: [memory('mem_b1', '用户喜欢简洁的周报', { botId: 'bot_b' })],
    });
    const adapter = new MemoryAdapter({ memory: world.port, clock: () => 10 });
    return { adapter, ...world };
  }

  it('without a query lists nothing but a summary; private_to_bot / self_note / commitments / inactive / expired never appear', () => {
    const { adapter } = setup();
    expect(adapter.inventory('bot_a')).toEqual([]);
    const summary = adapter.summary('bot_a')!;
    expect(summary).toContain('2 条');
    expect(summary).toContain('敏感 1 条');
    const listed = adapter.inventory('bot_a', { memoryQuery: '周报' }).map((entry) => entry.key);
    expect(listed).toEqual(['memory:mem_pref', 'memory:mem_sens']);
    expect(adapter.inventory('bot_a', { memoryQuery: '*' }).map((entry) => entry.key)).toEqual(
      listed,
    );
  });

  it('sensitive items are marked and default-unchecked', () => {
    const { adapter } = setup();
    const [plain, sensitive] = adapter.inventory('bot_a', { memoryQuery: '周报' });
    expect(plain).toMatchObject({ marks: [], defaultSelected: true, actions: ['copy'] });
    expect(sensitive).toMatchObject({ marks: ['sensitive'], defaultSelected: false });
    expect(sensitive!.external).toBe(true);
  });

  it('refusal explains never-transferable keys; resolve only accepts eligible ones', () => {
    const { adapter } = setup();
    expect(adapter.refusal('bot_a', 'memory:mem_priv')).toContain('只告诉');
    expect(adapter.refusal('bot_a', 'memory:mem_self')).toContain('关于自己的笔记');
    expect(adapter.refusal('bot_a', 'memory:mem_com')).toContain('定时任务');
    expect(adapter.refusal('bot_a', 'memory:mem_old')).toContain('已失效');
    expect(adapter.refusal('bot_a', 'memory:mem_exp')).toContain('过期');
    expect(adapter.refusal('bot_a', 'memory:mem_made_up')).toBeNull();
    expect(adapter.resolve('bot_a', 'memory:mem_priv')).toBeNull();
    expect(adapter.resolve('bot_a', 'memory:mem_sens')).toMatchObject({ key: 'memory:mem_sens' });
    // Execution re-checks too (an item made private after the proposal is skipped).
    expect(adapter.validate(ctx(), 'memory:mem_priv', 'copy')).toContain('只告诉');
  });

  it('copies with a new id, same fields, provenance evidence and no origin conversation; once; embedded', async () => {
    const { adapter, items, embedded } = setup();
    expect(adapter.validate(ctx(), 'memory:mem_sens', 'copy')).toBeNull();
    expect(adapter.isApplied(ctx(), 'memory:mem_sens')).toBe(false);
    const { result } = await adapter.apply(ctx(), 'memory:mem_sens');
    const copy = items.get('bot_b')!.find((item) => item.id === result['itemId'])!;
    expect(copy.id).not.toBe('mem_sens');
    expect(copy).toMatchObject({
      kind: 'preference',
      content: '用户的体检报告在周报文件夹',
      source: 'explicit',
      confidence: 0.9,
      sensitivity: 'sensitive',
      privateToBot: false,
      originConversationId: null,
      evidence: [
        {
          messageId: null,
          conversationId: null,
          runId: null,
          handoverId: 'hnd_1',
          fromBotId: 'bot_a',
          fromItemId: 'mem_sens',
        },
      ],
    });
    expect(embedded).toEqual([copy.id]);
    expect(adapter.isApplied(ctx(), 'memory:mem_sens')).toBe(true);
    await adapter.apply(ctx(), 'memory:mem_sens');
    expect(items.get('bot_b')!.filter((item) => item.content === copy.content)).toHaveLength(1);
    // The source is untouched (copy, not move).
    expect(items.get('bot_a')!.find((item) => item.id === 'mem_sens')!.status).toBe('active');
  });

  it('an item B already remembers word for word is not copied again', () => {
    const { adapter } = setup();
    expect(adapter.validate(ctx(), 'memory:mem_pref', 'copy')).toBe('B 已经记着同样的内容');
  });

  it('an embedding failure does not block the write', async () => {
    const world = memoryWorld({ bot_a: [memory('mem_1', '用户住在杭州')] });
    world.port.embed = async () => {
      // MemoryService.embedItem never throws; a port that resolves after a failed embed is the contract.
    };
    const adapter = new MemoryAdapter({ memory: world.port, clock: () => 10 });
    await adapter.apply(ctx(), 'memory:mem_1');
    expect(world.items.get('bot_b')).toHaveLength(1);
  });

  it('memoryRefusal is shared with the schedule adapter’s commitment rule', () => {
    expect(memoryRefusal(memory('m', 'x', { privateToBot: true }), 0, 'A')).toContain('只告诉 A');
  });
});

describe('schedule adapter: commitment moves with its schedule', () => {
  function setup() {
    const rows = new Map<string, Schedule>([
      [
        'sch_c',
        {
          id: 'sch_c',
          botId: 'bot_a',
          conversationId: 'conv_a',
          kind: 'once',
          runAt: 100,
          cron: null,
          timezone: 'UTC',
          note: '周五前交周报',
          title: '周五前交周报',
          origin: 'commitment',
          commitmentId: 'mem_com',
          status: 'active',
          nextFireAt: 100,
          lastFiredAt: null,
          createdAt: 1,
        } as Schedule,
      ],
    ]);
    const world = memoryWorld({
      bot_a: [
        memory('mem_com', '周五前交周报', { kind: 'commitment', dueAt: 100 }),
        memory('mem_pc', '只告诉你：周五前交私事', {
          kind: 'commitment',
          dueAt: 100,
          privateToBot: true,
        }),
      ],
    });
    const transfers: Array<{ id: string; commitmentId: string | undefined }> = [];
    let failTransfer = false;
    const adapter = new ScheduleAdapter({
      schedules: {
        listActiveForBot: () => [...rows.values()].filter((r) => r.status === 'active'),
        get: (id) => rows.get(id) ?? null,
        transferTo: (id, target) => {
          if (failTransfer) throw new Error('crash before the transfer committed');
          transfers.push({ id, commitmentId: target.commitmentId });
          rows.set(id, { ...rows.get(id)!, status: 'cancelled' });
          const created = {
            ...rows.get(id)!,
            id: `${id}_new`,
            botId: target.botId,
            conversationId: target.conversationId,
            commitmentId: target.commitmentId ?? null,
            status: 'active' as const,
          };
          rows.set(created.id, created);
          return created;
        },
        transferredTo: (id, botId) =>
          rows.get(id)?.status === 'cancelled' &&
          [...rows.values()].some((r) => r.botId === botId && r.status === 'active'),
        describeWhen: () => '周五 18:00',
      },
      conversations: conversationPort({ conv_a: ['bot_a'] }),
      memory: world.port,
    });
    return {
      adapter,
      rows,
      transfers,
      ...world,
      failNext: (value: boolean) => {
        failTransfer = value;
      },
    };
  }

  it('is no longer greyed out; the card says the commitment goes along and A’s is voided', () => {
    const { adapter } = setup();
    const [entry] = adapter.inventory('bot_a');
    expect(entry!.blocked).toBeUndefined();
    expect(entry!.detail).toContain('连同承诺「周五前交周报」');
    expect(adapter.describe(entry!, 'move', 'B')).toContain('原来的承诺作废');
    expect(adapter.validate(ctx(), 'schedule:sch_c', 'move')).toBeNull();
  });

  it('copy → transfer linked to B’s copy → void A’s; B’s copy keeps due date and follows the task’s conversation', async () => {
    const { adapter, rows, transfers, items, voided } = setup();
    await adapter.apply(ctx(), 'schedule:sch_c');
    const copy = items.get('bot_b')!.find((item) => item.kind === 'commitment')!;
    expect(copy).toMatchObject({
      content: '周五前交周报',
      dueAt: 100,
      originConversationId: 'direct_bot_b',
      evidence: [expect.objectContaining({ fromItemId: 'mem_com', handoverId: 'hnd_1' })],
    });
    expect(transfers).toEqual([{ id: 'sch_c', commitmentId: copy.id }]);
    expect(rows.get('sch_c_new')!.commitmentId).toBe(copy.id);
    expect(voided).toEqual(['mem_com']);
    expect(adapter.isApplied(ctx(), 'schedule:sch_c')).toBe(true);
  });

  it('crash between copying and the transfer: the re-run reuses the copy (no second commitment)', async () => {
    const { adapter, items, failNext, voided } = setup();
    failNext(true);
    await expect(adapter.apply(ctx(), 'schedule:sch_c')).rejects.toThrow('crash');
    expect(items.get('bot_b')!.filter((item) => item.kind === 'commitment')).toHaveLength(1);
    expect(voided).toEqual([]);
    failNext(false);
    expect(adapter.isApplied(ctx(), 'schedule:sch_c')).toBe(false);
    expect(adapter.validate(ctx(), 'schedule:sch_c', 'move')).toBeNull();
    await adapter.apply(ctx(), 'schedule:sch_c');
    expect(items.get('bot_b')!.filter((item) => item.kind === 'commitment')).toHaveLength(1);
    expect(voided).toEqual(['mem_com']);
  });

  it('crash between the transfer and voiding A’s commitment: not applied yet, still valid, re-run only voids', async () => {
    const { adapter, rows, transfers, port, voided } = setup();
    // Simulate: transfer committed, void never ran.
    const realVoid = port.voidCommitment;
    port.voidCommitment = () => false;
    await adapter.apply(ctx(), 'schedule:sch_c');
    port.voidCommitment = realVoid;
    expect(rows.get('sch_c')!.status).toBe('cancelled');
    expect(adapter.isApplied(ctx(), 'schedule:sch_c')).toBe(false);
    expect(adapter.validate(ctx(), 'schedule:sch_c', 'move')).toBeNull();
    await adapter.apply(ctx(), 'schedule:sch_c');
    expect(transfers).toHaveLength(1);
    expect(voided).toEqual(['mem_com']);
    expect(adapter.isApplied(ctx(), 'schedule:sch_c')).toBe(true);
  });

  it('a voided or private_to_bot commitment blocks its schedule', () => {
    const { adapter, rows, port } = setup();
    rows.set('sch_p', { ...rows.get('sch_c')!, id: 'sch_p', commitmentId: 'mem_pc' });
    expect(adapter.validate(ctx(), 'schedule:sch_p', 'move')).toContain('只告诉 A');
    port.voidCommitment('bot_a', 'mem_com');
    expect(adapter.validate(ctx(), 'schedule:sch_c', 'move')).toContain('承诺已失效');
  });
});

describe('registry refusal', () => {
  it('routes refusal() to the owning adapter', () => {
    const world = memoryWorld({ bot_a: [memory('mem_priv', 'x', { privateToBot: true })] });
    const registry = new HandoverRegistry([new MemoryAdapter({ memory: world.port, clock: () => 0 })]);
    expect(registry.entry('bot_a', 'memory:mem_priv')).toBeNull();
    expect(registry.refusal('bot_a', 'memory:mem_priv')).toContain('只告诉');
    expect(registry.refusal('bot_a', 'mail:mal_x')).toBeNull();
    expect(registry.summaries('bot_a')).toEqual([
      { type: 'memory', text: expect.stringContaining('0 条') },
    ]);
  });
});

import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/infra/migrate.js';
import { ProfileStore } from '../../src/memory/profile-store.js';
import type { SqliteDatabase } from '../../src/infra/db.js';
import type { ProfileItem } from '@kepcup/shared';
import { AppError } from '@kepcup/shared';
import { buildMemoryTools, type MemoryToolFacade } from '../../src/tools/memory-tools.js';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, step, waitFor, type TestStack } from '@kepcup/testkit';

/**
 * C11 profile-per-principal (62.11, docs/design/62-team-server/
 * 05-profile-and-memory.md §2): profile entries, proposals and the compiled
 * card live in per-principal buckets (`principal_key`, '' = the single-user
 * bucket). Dormancy: the default-argument paths repeat the pre-team-server
 * behaviour byte-for-byte (the migration itself is covered by
 * principal-profile-migration.test.ts).
 */

const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

// --- Part 1: the store, per-principal bucketing -------------------------------

const openDbs: SqliteDatabase[] = [];

afterEach(async () => {
  for (const db of openDbs.splice(0)) db.close();
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

function makeStore(): { store: ProfileStore; advance: (ms: number) => void } {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  let now = 1_000_000;
  const store = new ProfileStore({ db, clock: () => now });
  return {
    store,
    advance: (ms) => {
      now += ms;
    },
  };
}

const PR_A = 'pr_AAA';
const PR_B = 'pr_BBB';

function seed(
  store: ProfileStore,
  content: string,
  principalKey = '',
): ReturnType<ProfileStore['insert']> {
  return store.insert(
    {
      category: 'boundaries',
      content,
      source: 'explicit',
      evidence: [],
      contributedBy: null,
      confidence: 1,
    },
    principalKey,
  );
}

describe('ProfileStore per-principal buckets (C11)', () => {
  it('keeps two principals’ entries in disjoint buckets', () => {
    const { store } = makeStore();
    const shared = seed(store, '单用户条目');
    const a = seed(store, 'A 不吃香菜', PR_A);
    const b = seed(store, 'B 不吃花生', PR_B);

    expect(store.list('active').map((item) => item.id)).toEqual([shared.id]);
    expect(store.list('active', undefined, PR_A).map((item) => item.id)).toEqual([a.id]);
    expect(store.list('active', undefined, PR_B).map((item) => item.id)).toEqual([b.id]);
    // Every entry carries its bucket key; ids stay unique across buckets.
    expect(store.getItem(a.id)!.principalKey).toBe(PR_A);
    expect(store.getItem(b.id)!.principalKey).toBe(PR_B);
    expect(store.getItem(shared.id)!.principalKey).toBe('');
    // A category filter composes with the bucket.
    expect(store.list('active', 'boundaries', PR_B).map((item) => item.id)).toEqual([b.id]);
  });

  it('compiles and staleness-checks the card per principal', () => {
    const { store, advance } = makeStore();
    const a = seed(store, 'A 不吃香菜', PR_A);
    const b = seed(store, 'B 不吃花生', PR_B);

    // A compiles: A's card goes fresh, B's bucket was never compiled.
    store.setCard('A 的卡片', PR_A);
    expect(store.getCard(PR_A).content).toBe('A 的卡片');
    expect(store.cardIsStale(PR_A)).toBe(false);
    expect(store.getCard(PR_B).content).toBeNull();
    expect(store.cardIsStale(PR_B)).toBe(true);
    expect(store.getCard().content).toBeNull();

    // A direct edit stales only A's card; B stays untouched.
    advance(1);
    store.updateContent(a.id, 'A 对坚果过敏', PR_A);
    expect(store.cardIsStale(PR_A)).toBe(true);
    expect(store.cardIsStale(PR_B)).toBe(true); // never compiled
    store.setCard('B 的卡片', PR_B);
    advance(1);
    store.retract(b.id, PR_B);
    expect(store.cardIsStale(PR_B)).toBe(true);
    expect(store.cardIsStale(PR_A)).toBe(true); // still stale from A's edit
    store.setCard('A 的新卡片', PR_A);
    expect(store.cardIsStale(PR_A)).toBe(false);
    // The single-user bucket is unaffected by both principals' activity.
    expect(store.cardIsStale()).toBe(false); // no entries in '' at all
  });

  it('scopes mutations to the principal bucket (wrong key = no-op)', () => {
    const { store, advance } = makeStore();
    const a = seed(store, 'A 条目', PR_A);
    seed(store, 'B 条目', PR_B);

    advance(1);
    // A wrong-key update rewrites nothing: the item keeps its content.
    const unchanged = store.updateContent(a.id, '跨主体改写', PR_B);
    expect(unchanged.content).toBe('A 条目');
    expect(store.getItem(a.id)!.content).toBe('A 条目');
    // The right key rewrites it.
    expect(store.updateContent(a.id, 'A 条目 v2', PR_A).content).toBe('A 条目 v2');

    // Category move + retract follow the same rule.
    expect(store.updateCategory(a.id, 'work', PR_B).category).toBe('boundaries');
    expect(store.updateCategory(a.id, 'work', PR_A).category).toBe('work');
    store.retract(a.id, PR_B);
    expect(store.getItem(a.id)!.status).toBe('active');
    store.retract(a.id, PR_A);
    expect(store.getItem(a.id)!.status).toBe('retracted');
    // The FTS row of the retracted entry is gone; the other bucket is intact.
    expect(store.list('active', undefined, PR_B)).toHaveLength(1);
  });

  it('files proposals per principal bucket', () => {
    const { store } = makeStore();
    const forA = store.insertProposal(
      { botId: 'bot_1', op: 'add', payload: { content: 'A 的提议' } },
      PR_A,
    );
    const shared = store.insertProposal({ botId: null, op: 'retract', payload: {} });

    expect(store.pendingProposals(PR_A).map((p) => p.id)).toEqual([forA.id]);
    expect(store.pendingProposals()).toHaveLength(1);
    expect(store.pendingProposals(PR_B)).toHaveLength(0);
    expect(store.getProposal(forA.id)!.principalKey).toBe(PR_A);
    expect(store.getProposal(shared.id)!.principalKey).toBe('');
    // Marking is id-based (the curation job only sees its own bucket's list).
    store.markProposal(forA.id, 'applied', { op: 'add' });
    expect(store.pendingProposals(PR_A)).toHaveLength(0);
  });
});

// --- Part 2: the service, proposals and evidence principal validation ---------

const stacks: TestStack[] = [];

const STACK_ENV = {
  // Curation merge window pushed out of the test's reach: delayed jobs never
  // run here, only immediate ones do (deterministic per-principal assertions).
  KEPCUP_PROFILE_CURATION_DELAY_MS: '600000',
  KEPCUP_REFLECTION_DEBOUNCE_MS: '0',
};

async function start(): Promise<TestStack> {
  const stack = await createTestStack({ env: STACK_ENV });
  stacks.push(stack);
  return stack;
}

async function callAs(
  core: CoreHarness,
  method: string,
  input?: Record<string, unknown>,
  principalId?: string,
): Promise<unknown> {
  const spec = core.services.appMethods[method];
  if (spec === undefined) throw new Error(`method not bound: ${method}`);
  const parsed = input === undefined ? undefined : spec.input.safeParse(input);
  if (parsed !== undefined && !parsed.success) {
    throw new AppError('INVALID_INPUT', `Invalid input for ${method}`);
  }
  const task = async () => spec.output.parse(await spec.handle(parsed?.data));
  return principalId === undefined ? task() : withCaller({ principalId }, task);
}

describe('MemoryService profile proposals per principal (C11)', () => {
  it('files a proposal into the proposing principal’s own domain', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿档');
    const memory = core.services.memory!;
    const convA = core.services.domain!.conversations.openDirect(bot.id, {
      ownerPrincipalId: PR_A,
    }).conversation;
    const msgA = core.services.domain!.messages.append({
      conversationId: convA.id,
      senderType: 'user',
      kind: 'text',
      text: '我负责支付网关的开发',
      senderPrincipalId: PR_A,
      senderName: '成员A',
    });

    const outcome = memory.submitProfileProposal(
      bot.id,
      {
        category: 'work',
        content: 'A 负责支付网关',
        source: 'explicit',
        evidence: [msgA.id],
        confidence: 1,
        sensitivity: 'normal',
        immediate: true,
      },
      PR_A,
    );
    expect(outcome.ok).toBe(true);
    // The proposal and its curation job belong to pr_A's domain only.
    expect(memory.profileStore.pendingProposals(PR_A)).toHaveLength(1);
    expect(memory.profileStore.pendingProposals('')).toHaveLength(0);
    expect(memory.profileStore.pendingProposals(PR_B)).toHaveLength(0);
    const jobs = core.services
      .mainDb!.prepare("select dedupe_key, payload_json from jobs where type = 'profile_curation'")
      .all() as Array<{ dedupe_key: string; payload_json: string }>;
    expect(jobs.map((row) => row.dedupe_key)).toEqual([`profile_curation:${PR_A}`]);
    expect(JSON.parse(jobs[0]!.payload_json)).toEqual({ principalKey: PR_A });
  });

  it('rejects evidence of another principal (A 的证据不能给 B 提议)', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿证');
    const memory = core.services.memory!;
    const conversations = core.services.domain!.conversations;
    const messages = core.services.domain!.messages;
    const convA = conversations.openDirect(bot.id, { ownerPrincipalId: PR_A }).conversation;
    const msgA = messages.append({
      conversationId: convA.id,
      senderType: 'user',
      kind: 'text',
      text: '我对芒果过敏',
      senderPrincipalId: PR_A,
      senderName: '成员A',
    });
    // The bot participates in A's conversation, so the evidence is "in range"
    // — only the principal mismatch must drop it.
    const candidate = {
      category: 'basic' as const,
      content: '提议人对芒果过敏',
      source: 'explicit' as const,
      evidence: [msgA.id],
      confidence: 1,
      sensitivity: 'normal' as const,
      immediate: false,
    };
    expect(memory.submitProfileProposal(bot.id, candidate, PR_B).ok).toBe(false);
    expect(memory.profileStore.pendingProposals(PR_B)).toHaveLength(0);
    // The matching principal accepts the same evidence.
    expect(memory.submitProfileProposal(bot.id, candidate, PR_A).ok).toBe(true);
    expect(memory.profileStore.pendingProposals(PR_A)).toHaveLength(1);
  });

  it('keeps the single-user path identical: no key ⇒ the empty bucket', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿单');
    const memory = core.services.memory!;
    const conversations = core.services.domain!.conversations;
    const messages = core.services.domain!.messages;
    const conv = conversations.openDirect(bot.id).conversation;
    const msg = messages.append({
      conversationId: conv.id,
      senderType: 'user',
      kind: 'text',
      text: '我住在北京',
    });
    expect(msg.senderPrincipalId ?? null).toBeNull();
    const outcome = memory.submitProfileProposal(bot.id, {
      category: 'basic',
      content: '用户住在北京',
      source: 'explicit',
      evidence: [msg.id],
      confidence: 1,
      sensitivity: 'normal',
    });
    expect(outcome.ok).toBe(true);
    // The default-argument path lands on the legacy bucket and the legacy
    // dedupe key (pre-team-server jobs dedupe into the same slot).
    expect(memory.profileStore.pendingProposals('')).toHaveLength(1);
    const jobs = core.services
      .mainDb!.prepare("select dedupe_key, payload_json from jobs where type = 'profile_curation'")
      .all() as Array<{ dedupe_key: string; payload_json: string }>;
    expect(jobs.map((row) => row.dedupe_key)).toEqual(['profile_curation']);
    expect(JSON.parse(jobs[0]!.payload_json)).toEqual({ principalKey: '' });
  });

  it('curation processes one principal per job (dedupeKey 不同、互不处理)', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿理');
    const memory = core.services.memory!;
    const conversations = core.services.domain!.conversations;
    const messages = core.services.domain!.messages;
    const conv = conversations.openDirect(bot.id, { ownerPrincipalId: PR_A }).conversation;
    const msgA = messages.append({
      conversationId: conv.id,
      senderType: 'user',
      kind: 'text',
      text: 'A 的工作是大模型',
      senderPrincipalId: PR_A,
      senderName: '成员A',
    });
    const msgB = messages.append({
      conversationId: conv.id,
      senderType: 'user',
      kind: 'text',
      text: 'B 的工作是前端',
      senderPrincipalId: PR_B,
      senderName: '成员B',
    });
    const proposalA = memory.submitProfileProposal(
      bot.id,
      {
        category: 'work',
        content: 'A 的工作是大模型',
        source: 'explicit',
        evidence: [msgA.id],
        confidence: 1,
        sensitivity: 'normal',
      },
      PR_A,
    );
    const proposalB = memory.submitProfileProposal(
      bot.id,
      {
        category: 'work',
        content: 'B 的工作是前端',
        source: 'explicit',
        evidence: [msgB.id],
        confidence: 1,
        sensitivity: 'normal',
      },
      PR_B,
    );
    expect(proposalA.ok && proposalB.ok).toBe(true);
    const pendingA = memory.profileStore.pendingProposals(PR_A)[0]!.id;
    const pendingB = memory.profileStore.pendingProposals(PR_B)[0]!.id;

    // A's immediate job sees ONLY A's proposals (the prompt proves the scope);
    // the model applies A's proposal and recompiles A's card.
    stack.llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('A 的工作是大模型'))
        .expect((req) => !req.lastUserText().includes('B 的工作是前端'))
        .replyJson({
          operations: [{ op: 'add', proposalId: pendingA, category: 'work', content: 'A 从事大模型' }],
          card: 'A 卡：从事大模型',
        }),
    ]);
    memory.scheduleCuration(true, PR_A);
    await waitFor(() => (memory.profileStore.list('active', undefined, PR_A).length === 1 ? true : null), {
      label: 'pr_A item curated',
    });
    // B's bucket was not touched: its proposal is still pending and its card
    // was never compiled.
    expect(memory.profileStore.pendingProposals(PR_B).map((p) => p.id)).toEqual([pendingB]);
    expect(memory.profileStore.getCard(PR_B).content).toBeNull();
    expect(memory.profileStore.getCard(PR_A).content).toBe('A 卡：从事大模型');
  });

  it('profile.* bindings with a caller act on the caller’s own domain', async () => {
    const stack = await start();
    const core = stack.core;
    await makeBot(core, '阿绑');
    const memory = core.services.memory!;
    const shared = seed(memory.profileStore, '单用户条目');
    const ownedA = seed(memory.profileStore, 'A 的边界', PR_A);

    // No caller: the whole single-user bucket (status quo).
    expect((await callAs(core, 'profile.list') as { items: ProfileItem[] }).items).toHaveLength(1);
    // Caller pr_A: only their own entries.
    const listA = (await callAs(core, 'profile.list', undefined, PR_A)) as {
      items: ProfileItem[];
    };
    expect(listA.items.map((item) => item.id)).toEqual([ownedA.id]);
    // Cross-domain edits report NOT_FOUND (no existence leak).
    await expect(callAs(core, 'profile.update', { id: shared.id, content: 'x' }, PR_A)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await expect(callAs(core, 'profile.retract', { id: shared.id }, PR_A)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Own-domain edits succeed and land back in the caller's list.
    await callAs(core, 'profile.update', { id: ownedA.id, content: 'A 的边界 v2' }, PR_A);
    const after = (await callAs(core, 'profile.list', undefined, PR_A)) as {
      items: ProfileItem[];
    };
    expect(after.items[0]!.content).toBe('A 的边界 v2');
    // The card endpoint is caller-scoped: pr_A's domain has no card yet, and
    // the single-user card is empty as well.
    expect(
      ((await callAs(core, 'profile.card', undefined, PR_A)) as { card: { content: string | null } })
        .card.content,
    ).toBeNull();
    expect(
      ((await callAs(core, 'profile.card')) as { card: { content: string | null } }).card.content,
    ).toBeNull();
  });
});

// --- Part 3: the get_user_profile tool (principal + memberId) -----------------

function toolContext(conversationId: string | null) {
  return {
    identity: { runId: 'run_1', botId: 'bot_1', conversationId, loopType: 'turn' as const },
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  };
}

describe('get_user_profile tool per principal (C11)', () => {
  it('reads the speaking principal’s entries; member_id returns the card only', async () => {
    const seenKeys: Array<string | null> = [];
    const seenCategories: Array<string | undefined> = [];
    const facade: MemoryToolFacade = {
      writeMemory: async () => ({ ok: false, item: null, deduped: false, reason: '' }),
      recall: async () => ({ items: [], text: '', truncated: false }),
      getUserProfile: (opts) => {
        seenKeys.push(opts?.principalKey ?? null);
        seenCategories.push(opts?.category);
        return opts?.principalKey === PR_A
          ? [
              { id: 'prf_1', category: 'work', content: 'A 从事大模型' } as ProfileItem,
              { id: 'prf_2', category: 'basic', content: 'A 在北京' } as ProfileItem,
            ]
          : [];
      },
      profileCard: (principalKey) => ({
        content: principalKey === PR_A ? 'A 卡' : principalKey === PR_B ? 'B 卡' : null,
        compiledAt: null,
      }),
      listCommitments: () => [],
      feedback: () => ({ ok: false, message: '' }),
      forget: () => ({ retracted: [], proposed: [] }),
      requestProfileChange: async () => ({ approved: false, note: '' }),
      triggerMessages: () => [],
    };
    const tools = buildMemoryTools({
      identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' },
      memory: facade,
      principalId: PR_A,
      // In-conversation roster: only pr_B (and the speaker) is present.
      hasConversationPrincipal: (_conversationId, principalId) =>
        principalId === PR_A || principalId === PR_B,
    });
    const tool = tools.find((definition) => definition.name === 'get_user_profile')!;
    const ctx = toolContext('conv_1');

    // Default: the speaking principal's full entries, category passthrough.
    const all = await tool.execute({}, ctx);
    expect(seenKeys.at(-1)).toBe(PR_A);
    expect(all.ok).toBe(true);
    expect(all.content).toContain('A 从事大模型');
    await tool.execute({ category: 'work' }, ctx);
    expect(seenCategories.at(-1)).toBe('work');

    // A member lookup returns the compiled card only — not raw entries.
    const member = await tool.execute({ member_id: PR_B }, ctx);
    expect(member.ok).toBe(true);
    expect(member.content).not.toContain('prf_');
    expect(member.content).toContain('<untrusted>');
    expect(seenKeys.at(-1)).toBe(PR_A); // the facade's entry reader untouched

    // Off-roster principals are rejected.
    const stranger = await tool.execute({ member_id: 'pr_ZZZ' }, ctx);
    expect(stranger.ok).toBe(false);
    expect(stranger.errorCode).toBe('INVALID_INPUT');

    // Without a roster provider, member lookups are rejected outright.
    const bare = buildMemoryTools({
      identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' },
      memory: facade,
    });
    const bareTool = bare.find((definition) => definition.name === 'get_user_profile')!;
    expect((await bareTool.execute({ member_id: PR_B }, ctx)).ok).toBe(false);
  });
});

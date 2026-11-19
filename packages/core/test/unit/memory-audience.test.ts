import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { MemoryDbManager } from '../../src/memory/manager.js';
import { retrieveRelevant } from '../../src/memory/retrieve.js';
import type { Embedder } from '../../src/memory/embedder.js';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, makeProject, type TestStack } from '@kepcup/testkit';

/**
 * C12 memory source & audience (62.11, docs/design/62-team-server/
 * 05-profile-and-memory.md §3): entries carry their producing principal
 * (`source_principal_id`) and retrieval / recall / my_state / the Bot-detail
 * list all apply the same audience judgment. Dormancy: without an audience
 * every entry passes exactly as before.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'memory-audience-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let tick = 0;
const clock = () => 1_000_000 + tick++;

/** Deterministic 8-dim embedder: same text ⇒ same unit vector. */
function fakeEmbedder(): Embedder {
  return {
    id: 'fake:8',
    dim: 8,
    ready: () => true,
    embed: async (texts: string[]) =>
      texts.map((text) => {
        const vector = new Float32Array(8);
        for (let i = 0; i < text.length; i++) {
          vector[(text.charCodeAt(i) + i) % 8] += 1;
        }
        let sum = 0;
        for (const value of vector) sum += value * value;
        const norm = Math.sqrt(sum) || 1;
        for (let i = 0; i < 8; i++) vector[i] = vector[i]! / norm;
        return vector;
      }),
  };
}

function newManager(): MemoryDbManager {
  return new MemoryDbManager({
    paths: {
      home: dir,
      logsDir: dir,
      mainDbPath: path.join(dir, 'main.db'),
      runsDbPath: path.join(dir, 'runs.db'),
      cacheDir: dir,
      cacheNpmDir: dir,
      cachePipDir: dir,
      cacheXdgDir: dir,
      cacheCargoDir: dir,
      cachePycacheDir: dir,
      cacheUvDir: dir,
      cacheDownloadsDir: dir,
      toolchainsDir: dir,
    },
    masterKey: randomBytes(32),
    clock,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  });
}

const PR_A = 'pr_AAA';
const PR_B = 'pr_BBB';
const CONV_A = 'conv_direct_A';
const CONV_B = 'conv_direct_B';
const CONV_P = 'conv_project_P';

/** Card conversation of project P (its items must surface inside P). */
const CONV_CARD_OF_P = 'conv_card_of_P';

function scopeOf(conversationId: string): string | null {
  if (conversationId === CONV_P || conversationId === CONV_CARD_OF_P) return CONV_P;
  return null;
}

// --- Part 1: retrieval filters -------------------------------------------------

describe('retrieval audience rules (C12)', () => {
  it('scopes private entries to their source principal’s direct chat, project entries to their project', async () => {
    const manager = newManager();
    const store = manager.for('bot_aud');
    store.insert({
      kind: 'fact',
      content: 'A 的直聊记忆',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      originConversationId: CONV_A,
      sourcePrincipalId: PR_A,
      confidence: 1,
      sensitivity: 'normal',
    });
    store.insert({
      kind: 'fact',
      content: 'B 的直聊记忆',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      originConversationId: CONV_B,
      sourcePrincipalId: PR_B,
      confidence: 1,
      sensitivity: 'normal',
    });
    store.insert({
      kind: 'fact',
      content: '项目内记忆',
      source: 'explicit',
      evidence: [],
      origin: 'project',
      originConversationId: CONV_P,
      sourcePrincipalId: PR_A,
      confidence: 1,
      sensitivity: 'normal',
    });
    // A card conversation of the same project maps to it.
    store.insert({
      kind: 'fact',
      content: '卡片会话记忆',
      source: 'explicit',
      evidence: [],
      origin: 'project',
      originConversationId: CONV_CARD_OF_P,
      sourcePrincipalId: PR_B,
      confidence: 1,
      sensitivity: 'normal',
    });
    store.insert({
      kind: 'fact',
      content: '共享记忆',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
    });

    const retrieve = async (audience:
      | { principalId: string | null; conversationId: string; projectConversationId: string | null }
      | undefined) => {
      const result = await retrieveRelevant({
        store,
        embedder: null,
        queryText: '记忆',
        filters: {
          isProject: audience?.projectConversationId !== undefined && audience !== undefined,
          now: 2_000_000,
          ...(audience !== undefined
            ? { audience, projectScopeResolver: scopeOf }
            : {}),
        },
      });
      return result.items.map((item) => item.content);
    };

    // A's direct chat: A's entries + shared; not B's, not the project's.
    // (FTS rank decides the order; assertions are order-insensitive.)
    expect(
      (await retrieve({ principalId: PR_A, conversationId: CONV_A, projectConversationId: null })).sort(),
    ).toEqual(['A 的直聊记忆', '共享记忆']);
    // B's direct chat: B's entries + shared.
    expect(
      (await retrieve({ principalId: PR_B, conversationId: CONV_B, projectConversationId: null })).sort(),
    ).toEqual(['B 的直聊记忆', '共享记忆']);
    // The project (any speaker): project entries of BOTH speakers (cards map
    // to the project) + shared; nobody's private entries.
    expect(
      (
        await retrieve({ principalId: PR_A, conversationId: CONV_P, projectConversationId: CONV_P })
      ).sort(),
    ).toEqual(['项目内记忆', '卡片会话记忆', '共享记忆'].sort());
    // Another project's audience sees nothing of project P.
    expect(
      await retrieve({ principalId: PR_A, conversationId: 'conv_other', projectConversationId: 'conv_other' }),
    ).toEqual(['共享记忆']);
    // No audience = the full store (single-user status quo).
    expect((await retrieve(undefined)).sort()).toEqual(
      ['A 的直聊记忆', 'B 的直聊记忆', '项目内记忆', '卡片会话记忆', '共享记忆'].sort(),
    );
    manager.closeAll();
  });

  it('dedupes inside one source principal only (同内容两主体各留一条)', async () => {
    const manager = newManager();
    const store = manager.for('bot_dedup');
    const first = store.insert({
      kind: 'fact',
      content: '每周五开例会',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      sourcePrincipalId: PR_A,
      confidence: 1,
      sensitivity: 'normal',
    });
    // Same sentence, same principal → dedupe hit.
    expect(store.findSimilar('每周五开例会', null, PR_A)?.id).toBe(first.id);
    // Same sentence, other principal → no hit; a second entry is kept.
    expect(store.findSimilar('每周五开例会', null, PR_B)).toBeNull();
    const second = store.insert({
      kind: 'fact',
      content: '每周五开例会',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      sourcePrincipalId: PR_B,
      confidence: 1,
      sensitivity: 'normal',
    });
    expect(second.id).not.toBe(first.id);
    expect(store.activeItems().map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    // The shared (NULL) bucket groups with itself, not with sourced entries.
    const shared = store.insert({
      kind: 'fact',
      content: '每周五开例会',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
    });
    expect(store.findSimilar('每周五开例会', null, null)?.id).toBe(shared.id);
    manager.closeAll();
  });

  it('keeps the vector dedupe inside the source principal as well', async () => {
    const manager = newManager();
    const store = manager.for('bot_vec');
    const embedder = fakeEmbedder();
    const [vector] = await embedder.embed(['每周五开例会']);
    const stored = store.insert({
      kind: 'fact',
      content: '每周五开例会',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      sourcePrincipalId: PR_A,
      confidence: 1,
      sensitivity: 'normal',
    });
    await store.ensureVecTable(embedder.id, 8);
    store.upsertVec(store.rowidOf(stored.id)!, vector!);
    // Same principal: cosine hit.
    expect(store.findSimilar('每周五开例会', vector!, PR_A)?.id).toBe(stored.id);
    // Other principal: the vec query filters them out entirely.
    expect(store.findSimilar('每周五开例会', vector!, PR_B)).toBeNull();
    manager.closeAll();
  });

  it('a closer cross-principal vector does not shadow a same-principal near-duplicate', async () => {
    const manager = newManager();
    const store = manager.for('bot_vec_shadow');
    const stored = store.insert({
      kind: 'fact',
      content: '每周五开例会',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      sourcePrincipalId: PR_A,
      confidence: 1,
      sensitivity: 'normal',
    });
    // A very close entry of ANOTHER principal: with a k = 1 global scan it is
    // the nearest row overall and would mask pr_A's entry behind the join
    // (the principal filter lives on memory_items, not in the vec0 scan).
    const shadowRow = store.insert({
      kind: 'fact',
      content: '每周五开例会（另一主体的表述）',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      sourcePrincipalId: PR_B,
      confidence: 1,
      sensitivity: 'normal',
    });
    // Deterministic unit vectors on the e0–e1 plane (L2 metric):
    //   pr_A item at angle 0, pr_B shadow at 0.2, new write (query) at 0.35.
    // distance(query, pr_A) = 0.348 (< 0.4 = dedupe threshold), but
    // distance(query, shadow) = 0.15 — the shadow is strictly closer.
    const unitAt = (angle: number): Float32Array => {
      const vector = new Float32Array(8);
      vector[0] = Math.cos(angle);
      vector[1] = Math.sin(angle);
      return vector;
    };
    await store.ensureVecTable('fake:8-shadow', 8);
    store.upsertVec(store.rowidOf(stored.id)!, unitAt(0));
    store.upsertVec(store.rowidOf(shadowRow.id)!, unitAt(0.2));
    expect(store.findSimilar('每周五开例会', unitAt(0.35), PR_A)?.id).toBe(stored.id);
    // pr_B's own query still hits only its shadow, never pr_A's entry.
    expect(store.findSimilar('每周五开例会', unitAt(0.35), PR_B)?.id).toBe(shadowRow.id);
    manager.closeAll();
  });
});

// --- Part 2: the service, my_state and the Bot-detail bindings -----------------

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack({ env: { KEPCUP_REFLECTION_DEBOUNCE_MS: '0' } });
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

/** Starts a long-running turn for the (bot, conversation) pair. */
function startRunningRun(
  core: CoreHarness,
  botId: string,
  conversationId: string,
): string {
  const runs = core.services.domain!.runs;
  const run = runs.create({
    botId,
    conversationId,
    loopType: 'task',
    triggerReason: 'task',
    triggerMessageIds: [],
  });
  runs.update(run.id, { status: 'running' });
  return run.id;
}

describe('MemoryService audience scoping (C12)', () => {
  it('A 的直聊写入不出现在 B 与单用户会话的检索 / recall / my_state 中', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿受');
    const memory = core.services.memory!;
    const conversations = core.services.domain!.conversations;
    const messages = core.services.domain!.messages;
    const convA = conversations.openDirect(bot.id, { ownerPrincipalId: PR_A }).conversation;
    const convB = conversations.openDirect(bot.id, { ownerPrincipalId: PR_B }).conversation;
    const convSingle = conversations.openDirect(bot.id).conversation;
    const msgA = messages.append({
      conversationId: convA.id,
      senderType: 'user',
      kind: 'text',
      text: '记住我要周五交周报',
      senderPrincipalId: PR_A,
      senderName: '成员A',
    });

    // A asks the bot to remember something (sourced to pr_A).
    const written = await memory.writeMemory(bot.id, convA.id, {
      content: 'A 每周五要交周报',
      kind: 'fact',
      sourcePrincipalId: PR_A,
      triggerMessages: [msgA],
    });
    expect(written.ok).toBe(true);
    expect(written.item!.sourcePrincipalId).toBe(PR_A);
    expect(written.item!.origin).toBe('private');

    // Retrieval: A's conversation sees it, B's does not, the single-user
    // conversation (no audience) keeps the status-quo full view.
    expect(
      (await memory.relevantMemoriesSection({ botId: bot.id, conversationId: convA.id, queryText: '周报' })),
    ).toContain('A 每周五要交周报');
    expect(
      (await memory.relevantMemoriesSection({ botId: bot.id, conversationId: convB.id, queryText: '周报' })),
    ).not.toContain('A 每周五要交周报');
    expect(
      (await memory.relevantMemoriesSection({ botId: bot.id, conversationId: convSingle.id, queryText: '周报' })),
    ).toContain('A 每周五要交周报');

    // recall_memory (the tool's path): same judgment, run principal passed.
    expect((await memory.recall(bot.id, convA.id, '周报', undefined, PR_A)).items).toHaveLength(1);
    expect((await memory.recall(bot.id, convB.id, '周报', undefined, PR_B)).items).toHaveLength(0);
    // A explicit principal beats the conversation owner: B's id in A's chat
    // still sees nothing of A's entry.
    expect((await memory.recall(bot.id, convA.id, '周报', undefined, PR_B)).items).toHaveLength(0);

    // my_state: a commitment made in A's chat shows up only in A's audience.
    memory.storeFor(bot.id).insert({
      kind: 'commitment',
      content: '周五前交付周报',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      originConversationId: convA.id,
      sourcePrincipalId: PR_A,
      confidence: 1,
      sensitivity: 'normal',
      dueAt: Date.now() + 86_400_000,
    });
    expect(memory.myStateSection(bot.id, convA.id, PR_A)).toContain('周五前交付周报');
    expect(memory.myStateSection(bot.id, convB.id, PR_B)).not.toContain('周五前交付周报');
    // Status quo: without a principal the commitment stays visible everywhere.
    expect(memory.myStateSection(bot.id, convSingle.id)).toContain('周五前交付周报');
  });

  it('项目记忆只在该项目内可见（含卡片会话映射）；my_state 只列受众内的进行中 run', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿项');
    const otherBot = await makeBot(core, '阿旁');
    const memory = core.services.memory!;
    const conversations = core.services.domain!.conversations;
    const messages = core.services.domain!.messages;
    const project = await makeProject(core, '发布项目', [bot.id, otherBot.id]);
    const convP = project.id;
    // pr_A participates in the project (the host's roster write).
    core.services
      .mainDb!.prepare(
        "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values (?, ?, 'member', ?)",
      )
      .run(convP, PR_A, Date.now());
    // A card conversation of the project (host-managed; direct row insert).
    const convCard = 'conv_card_test';
    core.services
      .mainDb!.prepare(
        "insert into conversations (id, type, parent_project_id, card_todo_id, direct_bot_id, created_at) values (?, 'card', ?, ?, ?, ?)",
      )
      .run(convCard, convP, 'todo_x', bot.id, Date.now());
    const convA = conversations.openDirect(bot.id, { ownerPrincipalId: PR_A }).conversation;
    const convB = conversations.openDirect(bot.id, { ownerPrincipalId: PR_B }).conversation;

    const msgP = messages.append({
      conversationId: convP,
      senderType: 'user',
      kind: 'text',
      text: '项目定在周五发布',
      senderPrincipalId: PR_A,
      senderName: '成员A',
    });
    const written = await memory.writeMemory(bot.id, convP, {
      content: '项目周五发布',
      kind: 'fact',
      sourcePrincipalId: PR_A,
      triggerMessages: [msgP],
    });
    expect(written.ok).toBe(true);
    expect(written.item!.origin).toBe('project');

    // A private entry of A must NOT leak into the project audience.
    const msgA = messages.append({
      conversationId: convA.id,
      senderType: 'user',
      kind: 'text',
      text: '我私下说周五要请假',
      senderPrincipalId: PR_A,
      senderName: '成员A',
    });
    await memory.writeMemory(bot.id, convA.id, {
      content: 'A 私下提到请假',
      kind: 'fact',
      sourcePrincipalId: PR_A,
      triggerMessages: [msgA],
    });

    // Project audience: the project memory + the card conversation's memory
    // (mapped through its parent), never A's private entries.
    const projectSection = await memory.relevantMemoriesSection({
      botId: bot.id,
      conversationId: convP,
      queryText: '发布',
      principalId: PR_A,
    });
    expect(projectSection).toContain('项目周五发布');
    expect(projectSection).not.toContain('A 私下提到请假');

    // In-flight runs: a task running in the project's card conversation is
    // inside the project audience; a task in B's direct chat is not.
    startRunningRun(core, bot.id, convCard);
    startRunningRun(core, bot.id, convB.id);
    const projectState = memory.myStateSection(bot.id, convP, PR_A);
    expect(projectState).toContain('项目组卡片对话');
    expect(projectState).not.toContain('与用户的单聊');
    // The direct audience (B) lists only B's own conversation's runs — which
    // is the current one, so nothing else appears.
    expect(memory.myStateSection(bot.id, convB.id, PR_B)).not.toContain('项目组卡片对话');
    // A's direct chat (owner-derived audience): only this conversation's runs.
    expect(memory.myStateSection(bot.id, convA.id)).not.toContain('项目组卡片对话');
    // Dormancy: a single-user conversation without an owner keeps the
    // cross-conversation listing exactly as before.
    const convSingle = conversations.openDirect(bot.id).conversation;
    const dormantState = memory.myStateSection(bot.id, convSingle.id);
    expect(dormantState).toContain('项目组卡片对话');
    expect(dormantState).toContain('与用户的单聊');
  });

  it('writeMemory 拒绝跨主体证据；同内容两主体各留一条', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿写');
    const memory = core.services.memory!;
    const conversations = core.services.domain!.conversations;
    const messages = core.services.domain!.messages;
    const convA = conversations.openDirect(bot.id, { ownerPrincipalId: PR_A }).conversation;
    const msgA = messages.append({
      conversationId: convA.id,
      senderType: 'user',
      kind: 'text',
      text: '我偏好邮件沟通',
      senderPrincipalId: PR_A,
      senderName: '成员A',
    });

    // A's evidence with B's attribution: dropped.
    const mismatched = await memory.writeMemory(bot.id, convA.id, {
      content: 'B 偏好邮件沟通',
      kind: 'fact',
      sourcePrincipalId: PR_B,
      triggerMessages: [msgA],
    });
    expect(mismatched.ok).toBe(false);

    // The matching principal writes; the fact also spawns a profile proposal
    // in the writer's own domain (not the shared bucket).
    const ok = await memory.writeMemory(bot.id, convA.id, {
      content: 'A 偏好邮件沟通',
      kind: 'fact',
      sourcePrincipalId: PR_A,
      triggerMessages: [msgA],
    });
    expect(ok.ok).toBe(true);
    expect(memory.profileStore.pendingProposals(PR_A).map((p) => (p.payload as { content?: string }).content)).toContain(
      'A 偏好邮件沟通',
    );
    expect(memory.profileStore.pendingProposals('')).toHaveLength(0);

    // Same content from B: a second entry, no cross-principal dedupe.
    const msgB = messages.append({
      conversationId: convA.id,
      senderType: 'user',
      kind: 'text',
      text: '我也偏好邮件沟通',
      senderPrincipalId: PR_B,
      senderName: '成员B',
    });
    const okB = await memory.writeMemory(bot.id, convA.id, {
      content: 'B 偏好邮件沟通',
      kind: 'fact',
      sourcePrincipalId: PR_B,
      triggerMessages: [msgB],
    });
    expect(okB.ok).toBe(true);
    expect(okB.item!.id).not.toBe(ok.item!.id);
    expect(memory.storeFor(bot.id).activeItems().filter((item) => item.content.includes('邮件沟通'))).toHaveLength(2);
  });
});

describe('memory.* bindings with a caller (C12 Bot 详情判定)', () => {
  it('lists only shared ∨ own-sourced ∨ enrolled-project entries; invisible updates are NOT_FOUND', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '阿列');
    const otherBot = await makeBot(core, '阿另');
    const memory = core.services.memory!;
    const conversations = core.services.domain!.conversations;
    const convA = conversations.openDirect(bot.id, { ownerPrincipalId: PR_A }).conversation;

    // Project P: pr_A enrolled; project Q: not enrolled.
    const projectP = (await makeProject(core, '项目P', [bot.id, otherBot.id])).id;
    const projectQ = (await makeProject(core, '项目Q', [bot.id, otherBot.id])).id;
    core.services
      .mainDb!.prepare(
        "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values (?, ?, 'member', ?)",
      )
      .run(projectP, PR_A, Date.now());

    const store = memory.storeFor(bot.id);
    const shared = store.insert({
      kind: 'fact',
      content: '共享条目',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      confidence: 1,
      sensitivity: 'normal',
    });
    const ownedA = store.insert({
      kind: 'fact',
      content: 'A 的条目',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      originConversationId: convA.id,
      sourcePrincipalId: PR_A,
      confidence: 1,
      sensitivity: 'normal',
    });
    const ownedB = store.insert({
      kind: 'fact',
      content: 'B 的条目',
      source: 'explicit',
      evidence: [],
      origin: 'private',
      originConversationId: convBId(core, bot.id),
      sourcePrincipalId: PR_B,
      confidence: 1,
      sensitivity: 'normal',
    });
    const inP = store.insert({
      kind: 'fact',
      content: '项目 P 条目',
      source: 'explicit',
      evidence: [],
      origin: 'project',
      originConversationId: projectP,
      sourcePrincipalId: PR_B,
      confidence: 1,
      sensitivity: 'normal',
    });
    const inQ = store.insert({
      kind: 'fact',
      content: '项目 Q 条目',
      source: 'explicit',
      evidence: [],
      origin: 'project',
      originConversationId: projectQ,
      sourcePrincipalId: PR_B,
      confidence: 1,
      sensitivity: 'normal',
    });

    // No caller: the full list (status quo).
    const full = (await callAs(core, 'memory.list', { botId: bot.id })) as {
      items: Array<{ id: string }>;
    };
    expect(full.items.map((item) => item.id).sort()).toEqual(
      [shared.id, ownedA.id, ownedB.id, inP.id, inQ.id].sort(),
    );

    // Caller pr_A: shared + own + enrolled project P; not B's private, not Q.
    const visible = (await callAs(core, 'memory.list', { botId: bot.id }, PR_A)) as {
      items: Array<{ id: string }>;
    };
    expect(visible.items.map((item) => item.id).sort()).toEqual(
      [shared.id, ownedA.id, inP.id].sort(),
    );

    // Invisible entries are not writable: B's item reports NOT_FOUND.
    await expect(
      callAs(core, 'memory.update', { botId: bot.id, id: ownedB.id, content: 'x' }, PR_A),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      callAs(core, 'memory.retract', { botId: bot.id, id: ownedB.id }, PR_A),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Q's project entry is invisible to pr_A too.
    await expect(
      callAs(core, 'memory.retract', { botId: bot.id, id: inQ.id }, PR_A),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Visible entries remain editable / retractable.
    await callAs(core, 'memory.update', { botId: bot.id, id: ownedA.id, content: 'A 的条目 v2' }, PR_A);
    await callAs(core, 'memory.retract', { botId: bot.id, id: inP.id }, PR_A);
    const after = (await callAs(core, 'memory.list', { botId: bot.id }, PR_A)) as {
      items: Array<{ id: string; content: string; status: string }>;
    };
    expect(after.items.find((item) => item.id === ownedA.id)!.content).toBe('A 的条目 v2');
    // The retracted entry stays listed (the list is a full-status dump, as
    // before) but now carries the retracted status.
    expect(after.items.find((item) => item.id === inP.id)!.status).toBe('retracted');

    // The other principal sees a different slice (own + shared + their project
    // entries, including the one pr_A just retracted).
    const visibleB = (await callAs(core, 'memory.list', { botId: bot.id }, PR_B)) as {
      items: Array<{ id: string }>;
    };
    expect(visibleB.items.map((item) => item.id).sort()).toEqual(
      [shared.id, ownedB.id, inP.id, inQ.id].sort(),
    );
  });
});

/** B's direct conversation id for one bot (owner-scoped direct lookup). */
function convBId(core: CoreHarness, botId: string): string {
  const conversation = core.services.domain!.conversations.openDirect(botId, {
    ownerPrincipalId: PR_B,
  }).conversation;
  return conversation.id;
}

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_HANDOVER_EVENT,
  BOT_HANDOVER_FOLLOWUP_EVENT,
  botHandoverPayloadSchema,
  type Approval,
  type Bot,
  type MemoryItem,
  type Message,
} from '@kepcup/shared';
import {
  createFakeBrowserHost,
  createTestStack,
  listAllMessages,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  TestClock,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import type { NewMemoryItem } from '../../src/memory/store.js';
import { handoverMemoryCopy } from '../../src/handover/adapters/memory.js';
import { scanSkillDir } from '../../src/skills/scan.js';
import { parseSkillDir } from '../../src/skills/parse.js';

/**
 * D88 P1（docs/design/37，todo/bot-handover.md §4）：普通 Bot 自己发起移交（只能交出自己的、
 * 目标只能是已有 Bot，宿主校验）；网页监看移交（保留检查状态）；技能复制（外部导入同版本）；
 * 记忆按条复制（private_to_bot 永不出现、敏感默认不勾、副本 B 能检索到）；承诺随定时任务
 * 迁移（A 的承诺作废、不再提醒）；崩溃恢复不重复。全程 mock LLM。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

const DAY = 24 * 60 * 60 * 1000;

function remember(
  stack: TestStack,
  botId: string,
  item: Partial<NewMemoryItem> & { content: string },
): MemoryItem {
  return stack.core.services.memory!.storeFor(botId).insert({
    kind: 'preference',
    subject: null,
    source: 'explicit',
    evidence: [{ messageId: null, conversationId: null, runId: null }],
    origin: 'private',
    originConversationId: null,
    confidence: 0.9,
    sensitivity: 'normal',
    privateToBot: false,
    ...item,
  });
}

function installImported(stack: TestStack, botId: string, name: string): void {
  const skills = stack.core.services.skills!;
  const stagingDir = path.join(stack.core.services.paths.cacheDir, 'staging', `${name}-${botId}`);
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    path.join(stagingDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的描述\n---\n正文`,
  );
  skills.installImported({
    botId,
    conversationId: 'conv_x',
    name,
    scan: scanSkillDir(stagingDir, parseSkillDir(stagingDir)),
    sourceUrl: `https://example.com/${name}.git`,
    commitOid: '0123456789abcdef0123456789abcdef01234567',
    contentHash: `hash-${name}`,
    stagingDir,
    reuseExisting: false,
  });
}

/** A watch with check state (as if it had run for a while), not due soon. */
function seedWatch(stack: TestStack, botId: string, conversationId: string): string {
  const watches = stack.core.services.watches!;
  const row = watches.store.insert({
    botId,
    conversationId,
    source: { kind: 'web_page', url: 'https://shop.example.com/item/1' },
    condition: { kind: 'changed' },
    intervalSec: 3600,
    nextCheckAt: Date.now() + DAY,
  });
  stack.core.services
    .mainDb!.prepare(
      "update watches set last_hash = 'hash-1', last_quiet_hash = 'quiet-1', alert_seq = 2 where id = ?",
    )
    .run(row.id);
  return row.id;
}

/** A due-dated commitment of `botId` and its linked one-shot schedule (P07/P10 linkage). */
function seedCommitment(
  stack: TestStack,
  botId: string,
  conversationId: string,
  content: string,
): { commitment: MemoryItem; scheduleId: string } {
  const dueAt = Date.now() + 2 * DAY;
  const commitment = remember(stack, botId, {
    kind: 'commitment',
    content,
    dueAt,
    originConversationId: conversationId,
  });
  const schedule = stack.core.services.schedules!.createOnce({
    botId,
    conversationId,
    runAt: dueAt,
    note: content,
    title: content,
    origin: 'commitment',
    commitmentId: commitment.id,
  });
  return { commitment, scheduleId: schedule.id };
}

function handoverApprovals(stack: TestStack, conversationId: string): Approval[] {
  return stack.core.services
    .domain!.approvals.list(conversationId)
    .filter((approval) => approval.kind === 'bot_handover');
}

async function pendingHandover(stack: TestStack, conversationId: string): Promise<Approval> {
  return waitFor(
    () => handoverApprovals(stack, conversationId).find((a) => a.status === 'pending') ?? null,
    { label: 'pending bot_handover card' },
  );
}

async function settled(stack: TestStack, approvalId: string) {
  const host = stack.core.services.handover!;
  return waitFor(
    () => {
      const view = host.view(approvalId);
      return view !== null && view.status !== 'proposed' && view.status !== 'applying'
        ? view
        : null;
    },
    { label: 'handover settled' },
  );
}

function eventsOf(messages: Message[], event: string): Message[] {
  return messages.filter(
    (message) =>
      message.kind === 'system_event' &&
      'event' in message.content &&
      message.content.event === event,
  );
}

function toolResults(request: { body: Record<string, unknown> }): string {
  return JSON.stringify(request.body.messages);
}

interface World {
  alpha: Bot;
  beta: Bot;
  alphaDirect: string;
  watchId: string;
  pref: MemoryItem;
  sensitive: MemoryItem;
  secret: MemoryItem;
  selfNote: MemoryItem;
  commitment: MemoryItem;
  commitmentScheduleId: string;
}

async function world(stack: TestStack): Promise<World> {
  const { core } = stack;
  const alpha = await makeBot(core, '阿尔法');
  const beta = await makeBot(core, '贝塔');
  const alphaDirect = (await openDirect(core, alpha.id)).id;
  await openDirect(core, beta.id);
  const watchId = seedWatch(stack, alpha.id, alphaDirect);
  installImported(stack, alpha.id, 'deploy');
  const pref = remember(stack, alpha.id, { content: '用户喜欢周报用三段式写' });
  const sensitive = remember(stack, alpha.id, {
    content: '用户的周报里会提到体检安排',
    sensitivity: 'sensitive',
  });
  const secret = remember(stack, alpha.id, {
    content: '只告诉你：周报其实是外包写的',
    privateToBot: true,
  });
  const selfNote = remember(stack, alpha.id, { content: '我写周报总是太啰嗦', kind: 'self_note' });
  const { commitment, scheduleId } = seedCommitment(
    stack,
    alpha.id,
    alphaDirect,
    '周五前把周报模板发给用户',
  );
  return {
    alpha,
    beta,
    alphaDirect,
    watchId,
    pref,
    sensitive,
    secret,
    selfNote,
    commitment,
    commitmentScheduleId: scheduleId,
  };
}

describe('bot asset handover P1 (D88)', () => {
  it('普通 Bot 自己发起：只能交自己的；监看 / 技能 / 记忆 / 承诺随定时任务一张卡完成；private_to_bot 永不出现；敏感默认不勾；B 能检索到副本；A 不再提醒', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const w = await world(stack);
    const memory = core.services.memory!;
    const schedules = core.services.schedules!;

    llm.script('mock-main', [
      // 盘点别的 Bot → 拒绝。
      step().replyToolCall('inspect_bot_assets', { bot_id: w.beta.id }),
      step()
        .expect((request) => toolResults(request).includes('你只能盘点自己名下的资产'))
        .replyToolCall('inspect_bot_assets', { memory_query: '周报' }),
      // 盘点自己：私密 / 自我笔记 / 承诺不在候选里；监看、技能、承诺定时任务都在。
      step()
        .expect((request) => {
          const text = toolResults(request);
          return (
            text.includes(`memory:${w.pref.id}`) &&
            text.includes(`memory:${w.sensitive.id}`) &&
            !text.includes(`memory:${w.secret.id}`) &&
            !text.includes(`memory:${w.selfNote.id}`) &&
            !text.includes(`memory:${w.commitment.id}`) &&
            text.includes(`watch:${w.watchId}`) &&
            text.includes('skill:deploy') &&
            text.includes(`schedule:${w.commitmentScheduleId}`)
          );
        })
        // 以别的 Bot 为来源 → 拒绝。
        .replyToolCall('propose_handover', {
          from_bot_id: w.beta.id,
          to: { bot_id: w.alpha.id },
          items: [],
          handover_note: '不该成功。',
        }),
      step()
        .expect((request) => toolResults(request).includes('你只能交出自己名下的资产'))
        // private_to_bot 出现在提议里 → 整张退回。
        .replyToolCall('propose_handover', {
          to: { bot_id: w.beta.id },
          items: [{ key: `memory:${w.pref.id}` }, { key: `memory:${w.secret.id}` }],
          handover_note: '不该成功。',
        }),
      step()
        .expect((request) => toolResults(request).includes('这些条目不能移交'))
        .replyToolCall('propose_handover', {
          to: { bot_id: w.beta.id },
          items: [
            { key: `watch:${w.watchId}` },
            { key: 'skill:deploy' },
            { key: `memory:${w.pref.id}` },
            { key: `memory:${w.sensitive.id}` },
            { key: `schedule:${w.commitmentScheduleId}` },
          ],
          handover_note: '周报模板在共享盘；用户喜欢三段式。',
        }),
    ]);
    await sendBatch(core, w.alphaDirect, ['以后周报相关的事都交给贝塔负责吧']);
    const approval = await pendingHandover(stack, w.alphaDirect);
    await waitForRun(core, w.alphaDirect, 'completed');
    // 被退回的提议什么都没留下：只有一张卡。
    expect(handoverApprovals(stack, w.alphaDirect)).toHaveLength(1);

    const payload = botHandoverPayloadSchema.parse(approval.payload);
    expect(payload.fromBotId).toBe(w.alpha.id);
    expect(payload.target).toMatchObject({ kind: 'existing', botId: w.beta.id });
    const item = (key: string) => payload.items.find((entry) => entry.key === key)!;
    expect(item(`watch:${w.watchId}`)).toMatchObject({ assetType: 'watch', action: 'move' });
    expect(item('skill:deploy')).toMatchObject({
      assetType: 'skill',
      action: 'copy',
      marks: ['external_import'],
    });
    expect(item(`memory:${w.pref.id}`)).toMatchObject({ marks: [], defaultSelected: true });
    expect(item(`memory:${w.sensitive.id}`)).toMatchObject({
      marks: ['sensitive'],
      defaultSelected: false,
    });
    const scheduleItem = item(`schedule:${w.commitmentScheduleId}`);
    expect(scheduleItem.blocked).toBeUndefined();
    expect(scheduleItem.detail).toContain('原来的承诺作废');
    expect(payload.items.some((entry) => entry.key === `memory:${w.secret.id}`)).toBe(false);

    // 不带勾选的确认 = 卡上的默认勾选：敏感记忆不会被带进来。
    llm.script('mock-main', [step().replyText('已经交给贝塔了。')]);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');
    expect(view.items.find((entry) => entry.key === `memory:${w.sensitive.id}`)).toBeUndefined();

    const betaDirect = core.services.domain!.conversations.listDirectByBot(w.beta.id)[0]!.id;
    // 监看：同一行改到贝塔私聊，提醒序号保留；两边浏览器资料不同（bot:{id}），页面哈希
    // 清空、贝塔第一次检查重新记基线（审查 #2）。
    const watch = core.services.watches!.store.get(w.watchId)!;
    expect(watch).toMatchObject({
      botId: w.beta.id,
      conversationId: betaDirect,
      lastHash: null,
      lastQuietHash: null,
      alertSeq: 2,
      status: 'active',
    });
    expect(core.services.watches!.contextSection(w.alpha.id, w.alphaDirect)).toBe('');
    expect(core.services.watches!.contextSection(w.beta.id, betaDirect)).toContain(
      'shop.example.com',
    );

    // 技能：贝塔有同一库版本的一行，阿尔法保留。
    const skills = core.services.skills!;
    expect(skills.botSkillRow(w.beta.id, 'deploy')).toMatchObject({
      kind: 'imported',
      library_id: skills.botSkillRow(w.alpha.id, 'deploy')!.library_id,
      status: 'active',
    });
    expect(skills.botSkillRow(w.alpha.id, 'deploy')).not.toBeNull();

    // 记忆：普通条目复制、可被贝塔检索；敏感（未勾）、私密、自我笔记都没有过去。
    const betaItems = memory.activeItemsFor(w.beta.id);
    const prefCopy = betaItems.find((entry) => entry.content === w.pref.content)!;
    expect(prefCopy).toBeDefined();
    expect(prefCopy.id).not.toBe(w.pref.id);
    expect(prefCopy.originConversationId).toBeNull();
    expect(prefCopy.evidence).toEqual([
      expect.objectContaining({
        handoverId: payload.handoverId,
        fromBotId: w.alpha.id,
        fromItemId: w.pref.id,
        messageId: null,
      }),
    ]);
    for (const absent of [w.sensitive, w.secret, w.selfNote]) {
      expect(betaItems.some((entry) => entry.content === absent.content)).toBe(false);
    }
    const recalled = await memory.recall(w.beta.id, betaDirect, '三段式 周报');
    expect(recalled.items.map((entry) => entry.id)).toContain(prefCopy.id);
    // 阿尔法的记忆原样保留（复制，不是移动）。
    expect(memory.getItemFor(w.alpha.id, w.pref.id)!.status).toBe('active');

    // 承诺随定时任务迁移：贝塔得到承诺副本并接到重建的任务上；阿尔法的承诺作废、任务取消。
    expect(schedules.store.get(w.commitmentScheduleId)!.status).toBe('cancelled');
    const rebuilt = schedules.listForBotInConversation(w.beta.id, betaDirect);
    expect(rebuilt).toHaveLength(1);
    const betaCommitment = memory.getItemFor(w.beta.id, rebuilt[0]!.commitmentId!)!;
    expect(betaCommitment).toMatchObject({
      kind: 'commitment',
      content: '周五前把周报模板发给用户',
      status: 'active',
      dueAt: w.commitment.dueAt,
    });
    expect(rebuilt[0]).toMatchObject({ origin: 'commitment', runAt: w.commitment.dueAt });
    expect(memory.getItemFor(w.alpha.id, w.commitment.id)!.status).toBe('void');
    expect(memory.listCommitments(w.alpha.id)).toEqual([]);
    expect(memory.myStateSection(w.alpha.id, null)).not.toContain('周报模板');
    expect(memory.myStateSection(w.beta.id, null)).toContain('周五前把周报模板发给用户');
    // 阿尔法名下没有任何还会触发的定时任务。
    expect(schedules.listActiveForBot(w.alpha.id)).toEqual([]);

    // 交接记录与结果通知：记忆只给条数。
    const betaNotes = eventsOf(await listAllMessages(core, betaDirect), BOT_HANDOVER_EVENT);
    expect(betaNotes).toHaveLength(1);
    expect(JSON.stringify(betaNotes[0]!.content)).toContain('复制了 1 条记忆');
    const followUp = await waitFor(
      async () =>
        eventsOf(await listAllMessages(core, w.alphaDirect), BOT_HANDOVER_FOLLOWUP_EVENT)[0],
    );
    const followText = (followUp.content as { text: string }).text;
    expect(followText).toContain('复制了 1 条记忆给 贝塔');
    expect(followText).not.toContain(w.pref.content);
  }, 60_000);

  it('宿主侧校验不只靠工具注册：普通 Bot 直接调宿主也不能新建目标、不能以别人为来源、不能盘点别人', async () => {
    const stack = await start();
    const { core } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    const host = core.services.handover!;
    const identity = {
      botId: alpha.id,
      conversationId: alphaDirect,
      runId: 'run_x',
      loopType: 'turn',
    } as Parameters<typeof host.inspect>[0];
    expect(host.inspect(identity, { botId: beta.id })).toMatchObject({ ok: false });
    expect(host.inspect(identity, { botId: '' })).toMatchObject({ ok: true });
    expect(
      host.propose(identity, {
        fromBotId: alpha.id,
        target: {
          kind: 'new',
          bot: {
            name: '新人',
            bio: '',
            expertise: '',
            responsibilities: '打杂',
            reason: '',
            routines: [],
            model: 'inherit',
          },
        },
        items: [],
        handoverNote: '交给你。',
        note: '',
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('只有管家可以新建 Bot') });
    expect(
      host.propose(identity, {
        fromBotId: beta.id,
        target: { kind: 'existing', botId: alpha.id },
        items: [],
        handoverNote: '交给你。',
        note: '',
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('你只能交出自己名下的资产') });
    // 审查 #9 / DEV-020：普通 Bot 不能改接手方的模型——盘点里没有模型条目与可用模型，
    // 提议里出现 model:* 退回。
    const own = host.inspect(identity, { botId: '' });
    expect(own.ok).toBe(true);
    if (own.ok) {
      expect(own.inspection.entries.some((entry) => entry.type === 'model')).toBe(false);
      expect(own.inspection.modelOptions).toEqual([]);
    }
    expect(
      host.propose(identity, {
        fromBotId: alpha.id,
        target: { kind: 'existing', botId: beta.id },
        items: [{ key: 'model:inherit' }],
        handoverNote: '交给你。',
        note: '',
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('模型不是你自己的资产') });
    expect(handoverApprovals(stack, alphaDirect)).toHaveLength(0);
  }, 30_000);

  it('勾上敏感记忆就复制；崩溃在「任务已移交、承诺未作废」与「记忆已写、未记账」之间 → recover() 只补剩下的，不重复', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const w = await world(stack);
    const memory = core.services.memory!;
    const schedules = core.services.schedules!;
    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        to: { bot_id: w.beta.id },
        items: [
          { key: `memory:${w.sensitive.id}` },
          { key: `schedule:${w.commitmentScheduleId}` },
          { key: `watch:${w.watchId}` },
          { key: 'skill:deploy' },
        ],
        handover_note: '交给你了。',
      }),
    ]);
    await sendBatch(core, w.alphaDirect, ['把周报的事交给贝塔']);
    const approval = await pendingHandover(stack, w.alphaDirect);
    await waitForRun(core, w.alphaDirect, 'completed');
    const handoverId = botHandoverPayloadSchema.parse(approval.payload).handoverId;

    // 模拟「批准后执行到一半崩溃」：条目已落库为 pending；记忆副本已写、承诺副本已写且
    // 定时任务已移交（事务提交），但 A 的承诺还没作废；监看已改归属；技能已复制。
    const db = core.services.mainDb!;
    db.prepare("update approvals set status = 'approved', decided_at = ? where id = ?").run(
      Date.now(),
      approval.id,
    );
    const now = Date.now();
    for (const [key, type, action] of [
      [`memory:${w.sensitive.id}`, 'memory', 'copy'],
      [`schedule:${w.commitmentScheduleId}`, 'schedule', 'move'],
      [`watch:${w.watchId}`, 'watch', 'move'],
      ['skill:deploy', 'skill', 'copy'],
      ['note:handover', 'note', 'write'],
    ] as const) {
      db.prepare(
        `insert into bot_handover_items (handover_id, key, asset_type, action, status, updated_at)
         values (?, ?, ?, ?, 'pending', ?)`,
      ).run(handoverId, key, type, action, now);
    }
    db.prepare("update bot_handovers set status = 'applying' where id = ?").run(handoverId);
    const betaDirect = (await openDirect(core, w.beta.id)).id;
    memory.insertHandoverCopy(
      w.beta.id,
      handoverMemoryCopy(w.sensitive, { handoverId, fromBotId: w.alpha.id }),
    );
    const commitmentCopy = memory.insertHandoverCopy(
      w.beta.id,
      handoverMemoryCopy(w.commitment, { handoverId, fromBotId: w.alpha.id }, betaDirect),
    );
    schedules.transferTo(w.commitmentScheduleId, {
      botId: w.beta.id,
      botName: '贝塔',
      conversationId: betaDirect,
      commitmentId: commitmentCopy.id,
    });
    core.services.watches!.transferTo(w.watchId, { botId: w.beta.id, conversationId: betaDirect });
    await core.services.skills!.copyForHandover({
      fromBotId: w.alpha.id,
      toBotId: w.beta.id,
      name: 'deploy',
      fromName: '阿尔法',
    });
    expect(memory.getItemFor(w.alpha.id, w.commitment.id)!.status).toBe('active');

    llm.script('mock-main', [step().replyText('恢复后完成了。')]);
    core.services.handover!.recover();
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');
    expect(view.items.every((entry) => entry.status === 'done')).toBe(true);
    // 只补了作废：A 的承诺 void；B 只有一份敏感记忆、一份承诺、一条重建任务、一行技能。
    expect(memory.getItemFor(w.alpha.id, w.commitment.id)!.status).toBe('void');
    const betaItems = memory.activeItemsFor(w.beta.id);
    expect(betaItems.filter((entry) => entry.content === w.sensitive.content)).toHaveLength(1);
    expect(betaItems.filter((entry) => entry.kind === 'commitment')).toHaveLength(1);
    expect(schedules.listActiveForBot(w.beta.id)).toHaveLength(1);
    expect(core.services.skills!.rowsForBot(w.beta.id)).toHaveLength(1);
    // 敏感记忆的副本保留敏感标记。
    expect(betaItems.find((entry) => entry.content === w.sensitive.content)!.sensitivity).toBe(
      'sensitive',
    );
  }, 60_000);

  it('审查 #7：执行时不成立的记忆按原因汇总成条数，不逐条列出', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    await openDirect(core, beta.id);
    const kept = remember(stack, alpha.id, { content: '用户每周一开周会' });
    const gone = [
      remember(stack, alpha.id, { content: '用户喜欢用表格汇报进度' }),
      remember(stack, alpha.id, { content: '用户习惯下午写周报' }),
    ];
    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        to: { bot_id: beta.id },
        items: [kept, ...gone].map((item) => ({ key: `memory:${item.id}` })),
        handover_note: '交给你。',
      }),
    ]);
    await sendBatch(core, alphaDirect, ['把周报相关的记忆交给贝塔']);
    const approval = await pendingHandover(stack, alphaDirect);
    await waitForRun(core, alphaDirect, 'completed');
    // 提议之后用户把两条标成「只告诉阿尔法」。
    for (const item of gone)
      core.services.memory!.storeFor(alpha.id).setPrivateToBot(item.id, true);
    llm.script('mock-main', [step().replyText('部分完成。')]);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('partial');
    const followUp = await waitFor(
      async () =>
        eventsOf(await listAllMessages(core, alphaDirect), BOT_HANDOVER_FOLLOWUP_EVENT)[0],
    );
    const text = (followUp.content as { text: string }).text;
    expect(text.match(/记忆 2 条：/g)).toHaveLength(1);
    for (const item of gone) expect(text).not.toContain(item.content);
    const card = core.services.domain!.approvals.get(approval.id)!;
    expect(card.status).toBe('failed');
    expect(JSON.stringify(card.decision)).toContain('记忆 2 条');
  }, 60_000);

  it('监看移交后接着上次的检查结果：同一状态不再提醒（A、B 都不），之后的新变化只提醒 B、用 B 的浏览器资料', async () => {
    const clock = new TestClock();
    const browser = createFakeBrowserHost();
    const stack = await createTestStack({ clock, timers: clock, browserRpc: browser });
    stacks.push(stack);
    const { core, llm } = stack;
    const watches = core.services.watches!;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const alphaDirect = (await openDirect(core, alpha.id)).id;
    const betaDirect = (await openDirect(core, beta.id)).id;
    llm.script(
      'mock-main',
      Array.from({ length: 4 }, () =>
        step()
          .expect((request) => request.lastUserText().includes('<trigger reason="watch"'))
          .replyText('监看有变化了'),
      ),
    );
    const url = 'https://shop.example.com/item/9';
    const alertCards = async (conversationId: string, watchId: string) =>
      (await listMessages(core, conversationId)).filter(
        (message) =>
          message.kind === 'card' &&
          (message.content as { watchId?: string; watchEvent?: string }).watchId === watchId &&
          (message.content as { watchEvent?: string }).watchEvent === 'alert',
      ).length;
    const wakeRuns = async (conversationId: string) =>
      (await listRuns(core, conversationId)).filter(
        (run) =>
          run.triggerReason === 'watch' && run.loopType === 'turn' && run.status === 'completed',
      ).length;

    // 审查 #2：另一个 `changed` 监看——两边浏览器资料不同，B 的第一次检查只重新记基线。
    const url2 = 'https://news.example.com/list';
    browser.pageTexts.set(url2, '公告\n第一条');
    const changed = watches.create({
      botId: alpha.id,
      conversationId: alphaDirect,
      source: { kind: 'web_page', url: url2 },
      condition: { kind: 'changed' },
      intervalSec: 300,
    });

    // A：100 → 90（< 95）提醒一次。
    browser.pageTexts.set(url, '商品\n现价 ¥100');
    const watch = watches.create({
      botId: alpha.id,
      conversationId: alphaDirect,
      source: { kind: 'web_page', url },
      condition: { kind: 'number_below', value: 95 },
      intervalSec: 300,
    });
    await watches.whenIdle();
    browser.pageTexts.set(url, '商品\n现价 ¥90');
    clock.advance(5 * 60_000);
    await watches.whenIdle();
    await waitFor(
      async () =>
        (await alertCards(alphaDirect, watch.id)) === 1 && (await wakeRuns(alphaDirect)) === 1
          ? true
          : null,
      { label: 'alpha alerted once' },
    );

    // 移交给 B（同一行改归属）：B 的私聊出一张「已创建」卡。
    watches.transferTo(watch.id, { botId: beta.id, conversationId: betaDirect });
    expect(watches.get(changed.id)!.lastQuietHash).not.toBeNull();
    watches.transferTo(changed.id, { botId: beta.id, conversationId: betaDirect });
    // 测试栈里每个 Bot 的浏览器资料不同（bot:{id}）：哈希清空，提醒序号与条件状态保留。
    expect(watches.get(changed.id)!).toMatchObject({ lastHash: null, lastQuietHash: null });
    expect(watches.get(watch.id)!).toMatchObject({ lastMatched: true, alertSeq: 1 });
    // B 的资料看到的页面不同（例如没登录）：只建基线，不误报「页面变化」。
    browser.pageTexts.set(url2, '公告\n第一条\n（未登录，部分内容隐藏）');
    expect(
      (await listMessages(core, betaDirect)).filter(
        (message) =>
          message.kind === 'card' &&
          (message.content as { watchEvent?: string; watchId?: string }).watchId === watch.id &&
          (message.content as { watchEvent?: string }).watchEvent === 'created',
      ),
    ).toHaveLength(1);

    // 仍是 90：B 接着 A 的结果检查，不重复提醒（两边都没有新卡 / 新唤醒）。
    clock.advance(5 * 60_000);
    await watches.whenIdle();
    expect(watches.get(watch.id)!).toMatchObject({
      botId: beta.id,
      alertSeq: 1,
      lastMatched: true,
    });
    const lastFetch = browser.calls.filter((call) => call.method === 'browser.fetchText').at(-1)!;
    expect(lastFetch.input).toMatchObject({ botId: beta.id, profileKey: `bot:${beta.id}` });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await alertCards(betaDirect, watch.id)).toBe(0);
    expect(await alertCards(betaDirect, changed.id)).toBe(0);
    expect(watches.get(changed.id)!.lastQuietHash).not.toBeNull();
    expect(watches.get(changed.id)!.alertSeq).toBe(0);
    expect(await wakeRuns(betaDirect)).toBe(0);
    expect(await alertCards(alphaDirect, watch.id)).toBe(1);
    expect(await wakeRuns(alphaDirect)).toBe(1);

    // 回到 100 再跌到 90：新变化只提醒 B。
    browser.pageTexts.set(url, '商品\n现价 ¥100');
    clock.advance(5 * 60_000);
    await watches.whenIdle();
    browser.pageTexts.set(url, '商品\n现价 ¥90');
    clock.advance(5 * 60_000);
    await watches.whenIdle();
    expect(watches.get(watch.id)!.alertSeq).toBe(2);
    await waitFor(
      async () =>
        (await alertCards(betaDirect, watch.id)) === 1 && (await wakeRuns(betaDirect)) === 1
          ? true
          : null,
      { label: 'beta alerted once' },
    );
    expect(await alertCards(alphaDirect, watch.id)).toBe(1);
    expect(await wakeRuns(alphaDirect)).toBe(1);
  }, 60_000);
});

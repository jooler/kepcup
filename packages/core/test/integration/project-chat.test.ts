import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_MEMBER_PREVIEW_MAX, type Bot, type Conversation, type Run } from '@kepcup/shared';
import {
  createTestStack,
  listMembers,
  listMessages,
  listRuns,
  makeBot,
  makeProject,
  openDirect,
  sendDrafts,
  step,
  viaTask,
  waitFor,
  waitForEvent,
  waitForMessage,
  type TestStack,
} from '@kepcup/testkit';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<TestStack> {
  const stack = await createTestStack({ env });
  stacks.push(stack);
  return stack;
}

function systemText(request: { body: { messages?: Array<{ role: string; content?: unknown }> } }): string {
  const first = request.body.messages?.[0];
  return typeof first?.content === 'string' ? first.content : '';
}

/** Run of one bot in one conversation with response loopType and status. */
function waitForBotRun(
  core: TestStack['core'],
  conversationId: string,
  botId: string,
  status: Run['status'],
  options: { timeoutMs?: number } = {},
): Promise<Run> {
  return waitFor(
    async () =>
      (await listRuns(core, conversationId)).find(
        (r) => r.botId === botId && r.loopType === 'turn' && r.status === status,
      ) ?? null,
    { ...options, label: `response run of ${botId} in ${status}` },
  );
}

async function botRuns(
  core: TestStack['core'],
  conversationId: string,
  botId: string,
): Promise<Run[]> {
  return (await listRuns(core, conversationId)).filter((r) => r.botId === botId && r.loopType === 'turn');
}

async function stepsOf(core: TestStack['core'], runId: string): Promise<Array<Record<string, unknown>>> {
  const result = (await core.rpc.call('runs.steps', { runId })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return result.steps.map((s) => ({ type: s.type, ...s.payload }) as Record<string, unknown>);
}

async function threeBots(core: TestStack['core']) {
  const a = await makeBot(core, '阿甲');
  const b = await makeBot(core, '阿乙');
  const c = await makeBot(core, '阿丙');
  // The lead is 阿丙 (a filler member): other cases delete / remove 阿甲 or
  // 阿乙, which the lead guard (D92 T1a) would refuse.
  const conv = await makeProject(core, '项目讨论', [a.id, b.id, c.id], {
    leadBotId: c.id,
  });
  return { a, b, c, conv };
}

describe('project conversations', () => {
  it('creates, renames and manages members; creation requires at least 2 members', async () => {
    const { core } = await start();
    const { a, b, c, conv } = await threeBots(core);
    expect(conv.type).toBe('project');
    expect(conv.title).toBe('项目讨论');

    await expect(
      core.rpc.call('projects.create', {
        title: 'x',
        leadBotId: a.id,
        memberBotIds: [a.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const renamed = (await core.rpc.call('projects.update', {
      conversationId: conv.id,
      title: '新群名',
    })) as { conversation: { title: string } };
    expect(renamed.conversation.title).toBe('新群名');

    const d = await makeBot(core, '阿丁');
    const added = (await core.rpc.call('projects.addMembers', {
      conversationId: conv.id,
      botIds: [d.id],
    })) as { members: Array<{ bot: { id: string } }> };
    expect(added.members.map((m) => m.bot.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());

    await core.rpc.call('projects.removeMember', { conversationId: conv.id, botId: d.id });
    const members = (await core.rpc.call('conversations.members', {
      conversationId: conv.id,
    })) as { members: Array<{ bot: { id: string } }> };
    expect(members.members.map((m) => m.bot.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('list / get views carry member avatar previews for groups only, capped at PROJECT_MEMBER_PREVIEW_MAX', async () => {
    const { core } = await start();
    const { a, conv } = await threeBots(core);
    const direct = await openDirect(core, a.id);
    const listed = async () =>
      (
        (await core.rpc.call('conversations.list')) as {
          conversations: Array<Conversation>;
        }
      ).conversations;

    const previewsOf = (members: Array<{ bot: Bot }>) =>
      members.map((m) => ({ id: m.bot.id, name: m.bot.name, avatar: m.bot.avatar }));
    const group = (await listed()).find((c) => c.id === conv.id)!;
    expect(group.memberPreviews).toEqual(previewsOf(await listMembers(core, conv.id)));
    expect(group.memberPreviews?.map((p) => p.name).sort()).toEqual(
      ['阿丙', '阿乙', '阿甲'].sort(),
    );
    expect((await listed()).find((c) => c.id === direct.id)!.memberPreviews).toBeUndefined();

    // A big group: only the first PROJECT_MEMBER_PREVIEW_MAX members (join order).
    const extra: Bot[] = [];
    for (let i = 0; i < PROJECT_MEMBER_PREVIEW_MAX; i += 1) {
      extra.push(await makeBot(core, `成员${i}`));
    }
    await core.rpc.call('projects.addMembers', {
      conversationId: conv.id,
      botIds: extra.map((bot) => bot.id),
    });
    const members = await listMembers(core, conv.id);
    expect(members.length).toBeGreaterThan(PROJECT_MEMBER_PREVIEW_MAX);
    const expected = previewsOf(members).slice(0, PROJECT_MEMBER_PREVIEW_MAX);
    expect((await listed()).find((c) => c.id === conv.id)!.memberPreviews).toEqual(expected);
    const got = (await core.rpc.call('conversations.get', { id: conv.id })) as {
      conversation: Conversation;
    };
    expect(got.conversation.memberPreviews).toEqual(expected);
  });

  it('@ A → only A executes and no triage request is sent', async () => {
    const { core, llm } = await start();
    const { a, conv } = await threeBots(core);
    llm.script('mock-main', [step().replyText('阿甲收到')]);

    await sendDrafts(core, conv.id, [{ text: '帮我看下', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === a.id);

    const runs = await listRuns(core, conv.id);
    // P07 起：响应之后还有一个后台反思 run（loopType=reflection）。响应 run
    // 只有一个，且没有发送任何群聊判断请求（triage 的输入含 <triage_batch>；
    // 反思的输入含 <trigger_messages>，两者共用轻量模型）。
    const responseRuns = runs.filter((r) => r.loopType === 'turn');
    expect(responseRuns).toHaveLength(1);
    expect(responseRuns[0]).toMatchObject({ botId: a.id, triggerReason: 'mention' });
    expect(runs.filter((r) => r.loopType !== 'turn').every((r) => r.loopType === 'reflection')).toBe(true);
    expect(llm.requestsFor('mock-light').filter((req) => req.lastUserText().includes('<triage_batch>'))).toHaveLength(0);
  });

  it('one message @-ing A and B executes them in order; B sees A\'s reply and the sequence hint', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    void conv;
    llm.script('mock-main', [
      step().replyText('阿甲的答复'),
      step().replyText('阿乙的补充'),
    ]);

    await sendDrafts(core, conv.id, [
      { text: '两个问题一起', mentions: [a.id, b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');

    const responses = llm.requestsFor('mock-main');
    expect(responses).toHaveLength(2);
    const aIndex = responses.findIndex((r) => systemText(r).includes('名字：阿甲'));
    const bIndex = responses.findIndex((r) => systemText(r).includes('名字：阿乙'));
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThan(aIndex);

    const bRequest = responses[bIndex]!;
    expect(bRequest.lastUserText()).toContain('阿甲的答复');
    expect(bRequest.lastUserText()).toContain('在你之前，阿甲已经回复');

    // 只在响应 run 里断言：P07 起每个响应 run 还有一个同 Bot 的反思 run
    // （triggerReason=background，created_at 更新排在前），find 命中它会得到
    // 'background'——套件高负载下反思先落库时此断言偶发翻车。
    const responseRuns = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    for (const id of [a.id, b.id]) {
      expect(responseRuns.find((r) => r.botId === id)?.triggerReason).toBe('mention');
    }
  });

  it('send_message @ B triggers B as a bot_mention turn bound to the episode (hop 1)', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyToolCall('send_message', {
        text: '请阿乙帮忙看一下',
        mention_bot_ids: [b.id],
      }),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙来了'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '阿甲你来', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    const bRun = await waitForBotRun(core, conv.id, b.id, 'completed');
    expect(bRun.triggerReason).toBe('bot_mention');
    expect(bRun.episodeId).toBeTruthy();
    expect(bRun.episodeHop).toBe(1);

    const mentionsMessage = await waitForMessage(
      core,
      conv.id,
      (m) => m.senderBotId === a.id && m.mentions.includes(b.id),
    );
    expect(bRun.triggerMessageIds).toContain(mentionsMessage.id);
    await waitForMessage(core, conv.id, (m) => m.senderBotId === b.id);
  }, 30_000);

  it('an @ inside the final text does not trigger anyone', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    llm.script('mock-main', [step().replyText(`这个问题可以问 @阿乙`)]);

    await sendDrafts(core, conv.id, [{ text: '随便说说', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === a.id);
    await waitFor(
      async () => ((await botRuns(core, conv.id, b.id)).length === 0 ? true : null),
      { label: 'B never triggered' },
    );
  }, 30_000);

  // D75 W2 (D2 revised): the mid-round batch is no longer steered into the
  // running bot (old: A's second request carried <new_messages>) — it waits
  // and is dispatched after the round to the bots it is for (B only here).
  it('a batch flushed mid-round waits and is dispatched after the round', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('阿甲第一批'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙第一批'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙第二批'),
    ]);

    await sendDrafts(core, conv.id, [
      { text: '第一批甲', mentions: [a.id] },
      { text: '第一批乙', mentions: [b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), { label: 'A first request' });

    const second = await sendDrafts(core, conv.id, [{ text: '第二批（追加了）', mentions: [b.id] }]);
    llm.releaseAll();

    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');
    // Dispatched after the round: B executes the second batch too.
    const bAll = await waitForBotRunCount(core, conv.id, b.id, 2, { timeoutMs: 20_000 });

    const requests = llm.requestsFor('mock-main');
    expect(requests.every((r) => !r.lastUserText().includes('<new_messages>'))).toBe(true);
    const secondIds = second.map((m) => m.id);
    const redispatched = bAll.find((r) => r.triggerMessageIds.length === 1 && r.triggerMessageIds[0] === secondIds[0]);
    expect(redispatched).toBeTruthy();
    expect(redispatched!.triggerReason).toBe('mention');
    // A is not addressed by the second batch: it never got a turn for it.
    expect(await botRuns(core, conv.id, a.id)).toHaveLength(1);
  }, 40_000);

  it('removing a queued bot skips it; removing the running bot cancels it and the next continues', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    // Case 1: B queued behind A; B removed before its slot.
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('阿甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙不应执行'),
    ]);
    await sendDrafts(core, conv.id, [
      { text: '先甲后乙', mentions: [a.id, b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), { label: 'A request' });
    await core.rpc.call('projects.removeMember', { conversationId: conv.id, botId: b.id });
    llm.releaseAll();
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitFor(
      async () => ((await botRuns(core, conv.id, b.id)).length === 0 ? true : null),
      { label: 'B skipped' },
    );

    // Case 2: A running; A removed -> its run is cancelled, next member continues.
    const b2 = await makeBot(core, '阿乙二号');
    await core.rpc.call('projects.addMembers', { conversationId: conv.id, botIds: [b2.id] });
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('阿甲将被取消'),
      step().expect((r) => systemText(r).includes('名字：阿乙二号')).replyText('阿乙二号接棒'),
    ]);
    await sendDrafts(core, conv.id, [
      { text: '再试一次', mentions: [a.id, b2.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 2 ? true : null), { label: 'A second request' });
    await core.rpc.call('projects.removeMember', { conversationId: conv.id, botId: a.id });
    const aRun = await waitForBotRun(core, conv.id, a.id, 'cancelled');
    expect(aRun).toBeTruthy();
    await waitForBotRun(core, conv.id, b2.id, 'completed');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === b2.id);
    llm.releaseAll();
  }, 40_000);

  it('removing a member cleans workspace, grants and pending approvals; re-added bot searches full history', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    const paths = core.services.paths;

    await sendDrafts(core, conv.id, [{ text: '历史消息：独特关键词 zebra_marker', mentions: [a.id] }]);
    llm.script('mock-main', [step().replyText('收到历史消息')]);
    await waitForBotRun(core, conv.id, a.id, 'completed');

    // B runs once: reads an out-of-workspace path -> approval -> approved for
    // the conversation (grant), then finishes. D75 审查 M4: access approvals
    // are a task's (a turn fails fast), so B's turn starts a task for it.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'group-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, '机密内容');
    const isB = (r: Parameters<typeof systemText>[0]) => systemText(r).includes('名字：阿乙');
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().expect(isB).replyToolCall('read', { path: outsideFile }),
          step().expect(isB).replyText('读到了'),
        ],
        writes: false,
        relay: 'B-RELAY 读到了',
      }).map((s) => s.expect(isB)),
    );
    await sendDrafts(core, conv.id, [{ text: '读一下那个文件', mentions: [b.id] }]);
    await waitForEvent(core, 'approval.created', (p) => p.approval.botId === b.id);
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ id: string; status: string }>;
    };
    const pending = approvals.approvals.find((x) => x.status === 'pending');
    expect(pending).toBeTruthy();
    await core.rpc.call('approvals.decide', { id: pending!.id, approve: true, duration: 'conversation' });
    await waitForMessage(core, conv.id, (m) => 'text' in m.content && m.content.text === 'B-RELAY 读到了');

    const workspaceDir = path.join(paths.home, 'bots', b.id, 'workspaces', conv.id);
    expect(existsSync(workspaceDir)).toBe(true);
    let grants = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: Array<{ botId: string }>;
    };
    expect(grants.grants.some((g) => g.botId === b.id)).toBe(true);

    // Second run leaves a pending approval behind when the member is removed.
    const outsideFile2 = path.join(outsideDir, 'another.txt');
    writeFileSync(outsideFile2, '其他内容');
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().expect(isB).replyToolCall('read', { path: outsideFile2 }),
          step().expect(isB).replyText('不会走到这里'),
        ],
        writes: false,
      }).map((s) => s.expect(isB)),
    );
    await sendDrafts(core, conv.id, [{ text: '再读一个文件', mentions: [b.id] }]);
    await waitForEvent(
      core,
      'approval.created',
      (p) =>
        p.approval.botId === b.id &&
        (p.approval.payload as { path?: string } | undefined)?.path === realpathSync(outsideFile2),
    );

    await core.rpc.call('projects.removeMember', { conversationId: conv.id, botId: b.id });

    expect(existsSync(workspaceDir)).toBe(false);
    grants = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: Array<{ botId: string }>;
    };
    expect(grants.grants.some((g) => g.botId === b.id)).toBe(false);
    const after = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ botId: string | null; status: string; payload: { path?: string } }>;
    };
    expect(
      after.approvals.some(
        (x) => x.payload?.path === realpathSync(outsideFile2) && x.status === 'cancelled',
      ),
    ).toBe(true);

    // Re-added: the bot reads the FULL history again (search finds pre-removal messages).
    await core.rpc.call('projects.addMembers', { conversationId: conv.id, botIds: [b.id] });
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyToolCall('search_messages', { query: 'zebra_marker' }),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('查到了历史消息'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '你记得之前那条消息吗', mentions: [b.id] }]);
    const searchRun = await waitFor(
      async () => {
        const runs = await botRuns(core, conv.id, b.id);
        const newest = runs[0];
        // B's turns so far: start task 1, relay its result, start task 2.
        return newest && newest.status === 'completed' && runs.length >= 4 ? newest : null;
      },
      { label: 'search run completed' },
    );
    const searchSteps = await stepsOf(core, searchRun.id);
    expect(
      searchSteps.some(
        (s) => s['type'] === 'tool_result' && String(s['content']).includes('zebra_marker'),
      ),
    ).toBe(true);
    rmSync(outsideDir, { recursive: true, force: true });
  }, 60_000);

  it('a group-bound workdir is shared by all members and still lease-protected', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    const workdirDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'group-workdir-')));
    const selected = (await core.rpc.call('workdirs.select', {
      conversationId: conv.id,
      path: workdirDir,
    })) as { workdir: { id: string; path: string } };
    expect(selected.workdir.path).toBe(workdirDir);

    // One script for the whole scenario: script() replaces the queue, so the
    // held step for A must live in the same queue as B's later steps.
    // D75 W2: writes happen in write tasks (a turn is read-only) — each bot's
    // turn starts one; the tasks contend for the workdir lease.
    const isA = (r: Parameters<typeof systemText>[0]) => systemText(r).includes('名字：阿甲');
    const isB = (r: Parameters<typeof systemText>[0]) => systemText(r).includes('名字：阿乙');
    const [aStart, aAck, aWrite, aFinal, aRelay] = viaTask({
      taskSteps: [
        step().expect(isA).replyToolCall('write', { path: 'from-group.txt', content: '群聊成员甲写入' }),
        step().expect(isA).hold().replyText('甲完成'),
      ],
      relay: '甲：写好了',
    });
    const [bStart, bAck, bWrite, bFinal, bRelay] = viaTask({
      taskSteps: [
        step().expect(isB).replyToolCall('write', { path: 'from-direct.txt', content: '乙写入' }),
        step().expect(isB).replyText('乙完成'),
      ],
      relay: '乙：写好了',
    });
    llm.script('mock-main', [
      aStart!.expect(isA),
      aAck!.expect(isA),
      aWrite!,
      aFinal!,
      aRelay!.expect(isA),
      bStart!.expect(isB),
      bAck!.expect(isB),
      bWrite!,
      bFinal!,
      bRelay!.expect(isB),
    ]);
    await sendDrafts(core, conv.id, [{ text: '建一个文件', mentions: [a.id] }]);
    await waitFor(
      () => (existsSync(path.join(workdirDir, 'from-group.txt')) ? true : null),
      { label: 'A group write' },
    );

    // While A's write task still holds the lease, B's write task (direct
    // conversation bound to the same workdir) waits for it, still submitted.
    const direct = await (async () => {
      const result = (await core.rpc.call('conversations.openDirect', { botId: b.id })) as {
        conversation: { id: string };
      };
      return result.conversation;
    })();
    await core.rpc.call('workdirs.select', { conversationId: direct.id, path: workdirDir });
    await sendDrafts(core, direct.id, [{ text: '你也写一个' }]);
    // The task host keeps one write task per cwd (across conversations):
    // B's task stays submitted, its queue reason names A's task (the old
    // response run showed waiting_lease + lease.waiting instead).
    const bTask = await waitFor(
      async () => (await listRuns(core, direct.id)).find((r) => r.loopType === 'task') ?? null,
      { label: 'B task submitted' },
    );
    const aTask = (await listRuns(core, conv.id)).find((r) => r.loopType === 'task')!;
    expect(aTask.botId).toBe(a.id);
    expect(bTask.status).toBe('queued');
    const queued = core.services.orchestrator!.tasks.list({
      runId: bTask.originRunId!,
      botId: b.id,
      conversationId: direct.id,
      loopType: 'turn',
    });
    expect(queued[0]?.queueReason).toContain(aTask.id);
    expect(bWrite!.consumed).toBe(false);

    llm.releaseAll();
    await waitFor(
      async () =>
        (await listRuns(core, conv.id)).find((r) => r.loopType === 'task' && r.status === 'completed') ?? null,
      { label: 'A task completes' },
    );
    const bRun = await waitFor(
      async () =>
        (await listRuns(core, direct.id)).find(
          (r) => r.loopType === 'task' && r.botId === b.id && r.status === 'completed',
        ) ?? null,
      { label: 'B task completes after lease' },
    );
    expect(bRun).toBeTruthy();
    expect(existsSync(path.join(workdirDir, 'from-direct.txt'))).toBe(true);
    rmSync(workdirDir, { recursive: true, force: true });
  }, 60_000);

  it('project.turn events report routing, current bot and queue', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('乙完成'),
    ]);
    const runningEvent = waitForEvent(
      core,
      'project.turn',
      (p) => p.phase === 'running' && p.currentBotId === a.id && p.queue.includes(b.id),
      {},
    );
    await sendDrafts(core, conv.id, [
      { text: '甲先乙后', mentions: [a.id, b.id] },
    ]);
    const running = await runningEvent;
    expect(running.batchId).toBeTruthy();
    const idlePromise = waitForEvent(
      core,
      'project.turn',
      (p) => p.phase === 'idle' && p.queue.length === 0 && p.currentBotId === null,
      { timeoutMs: 20_000 },
    );
    llm.releaseAll();
    await idlePromise;
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');
  }, 30_000);

  // --- 审查修复回归（BR-P05-001/002/003/004） ---------------------------------

  it('deleting the conversation mid-turn spawns no new runs and no model requests', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('甲将被中止'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '先甲后乙', mentions: [a.id, b.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), { label: 'A request' });

    // New runs start as queued; any spawn during teardown shows up here.
    const spawned: Run[] = [];
    const off = core.onEvent('run.status', (p) => {
      const run = (p as { run: Run }).run;
      if (run.status === 'queued') spawned.push(run);
    });
    await core.rpc.call('conversations.delete', { id: conv.id });
    await waitForBotRun(core, conv.id, a.id, 'cancelled').catch(() => null);
    await new Promise((r) => setTimeout(r, 1_000));
    off();

    expect(spawned).toHaveLength(0);
    expect(llm.requestsFor('mock-main')).toHaveLength(1);
    // The turn finished without delivering to B: no reply beyond the original.
    const messages = await listMessages(core, conv.id);
    expect(messages.some((m) => m.senderType === 'bot')).toBe(false);
    llm.releaseAll();
  }, 30_000);

  it('deleting during routing neither delivers nor starts a turn (BR-P05-001)', async () => {
    const { core, llm } = await start();
    const { conv } = await threeBots(core);

    // The lead's gate call (no prior bot reply -> no continuation check) hangs.
    llm.script('mock-light', [step().expect((r) => r.lastUserText().includes('成员名册：')).hold()]);
    await sendBatchless(core, conv.id, '需要有人处理');
    await waitFor(() => (llm.requestsFor('mock-light').length >= 1 ? true : null), { label: 'gate request' });

    await core.rpc.call('conversations.delete', { id: conv.id });
    llm.releaseAll();
    await new Promise((r) => setTimeout(r, 1_000));

    // The cleared coordinator must not react to the late gate verdict:
    // no turn run, no model request on the main model.
    expect(llm.requestsFor('mock-main')).toHaveLength(0);
    expect((await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn')).toHaveLength(0);
  }, 30_000);

  it('an episode-bound run holding the mailbox does not absorb the turn delivery (BR-P05-002)', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    const aFinal = step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('甲完成');
    const bHeld = step().expect((r) => systemText(r).includes('名字：阿乙')).hold().replyText('乙的回合触发');
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyToolCall('send_message', {
        text: '请阿乙先看这条',
        mention_bot_ids: [b.id],
      }),
      aFinal,
      bHeld,
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('乙轮次'),
    ]);

    const batch = await sendDrafts(core, conv.id, [
      { text: '轮次批次给乙', mentions: [a.id, b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 3 ? true : null), { label: 'A final + B held' });

    // A finishes while B's episode-bound run still holds B's mailbox.
    aFinal.release();
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await new Promise((r) => setTimeout(r, 800));
    // The turn waits (no fresh delivery steered into the episode's run).
    expect(await botRuns(core, conv.id, b.id)).toHaveLength(1);
    // The episode's run was never steered: no <new_messages> injection anywhere.
    const episodeRequests = llm.requestsFor('mock-main').filter((r) => systemText(r).includes('名字：阿乙'));
    expect(episodeRequests.length).toBeGreaterThanOrEqual(1);
    expect(episodeRequests.every((r) => !r.lastUserText().includes('<new_messages>'))).toBe(true);

    // The episode's run ends -> mailbox idle -> the turn delivers as its own run.
    bHeld.release();
    const bRuns = await waitForBotRunCount(core, conv.id, b.id, 2, { timeoutMs: 20_000 });
    const turnRun = bRuns[0]!; // newest first
    expect(turnRun.triggerReason).toBe('mention');
    expect(turnRun.episodeId).toBe(null);
    expect(turnRun.triggerMessageIds).toEqual(batch.map((m) => m.id));
    const episodeRun = bRuns[1]!;
    expect(episodeRun.triggerReason).toBe('bot_mention');
  }, 40_000);

  it('editing a delivered user message in a group re-dispatches it (BR-P05-004)', async () => {
    const { core, llm } = await start();
    const { a, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('第一次回复'),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('编辑后的回复'),
    ]);
    const batch = await sendDrafts(core, conv.id, [{ text: '原始消息', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');

    await core.rpc.call('messages.edit', { id: batch[0]!.id, text: '编辑后的消息' });
    const aRuns = await waitForBotRunCount(core, conv.id, a.id, 2, { timeoutMs: 20_000 });
    const second = aRuns[0]!; // newest first
    expect(second.triggerMessageIds).toEqual([batch[0]!.id]);
    expect(second.triggerReason).toBe('mention');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === a.id);
    const editedBubble = await waitForMessage(
      core,
      conv.id,
      (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text === '编辑后的回复',
    );
    expect(editedBubble).toBeTruthy();
  }, 30_000);

  it('deleting a bot pushes conversation.updated for every group it was in (03-data-model 删除 Bot)', async () => {
    const { core } = await start();
    const { a, b, c, conv } = await threeBots(core);

    // 删除级联先删成员行；开放中的群 UI 依赖该事件重载成员列表——已删除 Bot
    // 从成员卡/@ 候选消失，其历史消息发送者回退为 id（设计/01 删除 Bot）。
    const groupUpdated = waitForEvent<{ conversation: { id: string; type: string } }>(
      core,
      'conversation.updated',
      (p) => p.conversation.id === conv.id,
    );
    const deleted = waitForEvent<{ id: string }>(
      core,
      'bot.deleted',
      (p) => p.id === a.id,
    );
    await core.rpc.call('bots.delete', { id: a.id });
    expect((await groupUpdated).conversation.type).toBe('project');
    await deleted;

    const members = (await core.rpc.call('conversations.members', {
      conversationId: conv.id,
    })) as { members: Array<{ bot: { id: string } }> };
    expect(members.members.map((m) => m.bot.id).sort()).toEqual([b.id, c.id].sort());
    // Bot 行转为占位（仅剩 id），供历史消息渲染发送者。
    const placeholder = (await core.rpc.call('bots.get', { id: a.id })) as {
      bot: { status: string; name: string };
    };
    expect(placeholder.bot.status).toBe('deleted');
    expect(placeholder.bot.name).toBe('');
  }, 20_000);
});

// -- helpers ------------------------------------------------------------------


/** Flushes a single draft without mentions (a silently routed batch). */
async function sendBatchless(
  core: TestStack['core'],
  conversationId: string,
  text: string,
): Promise<void> {
  await sendDrafts(core, conversationId, [{ text }]);
}

/** Resolves when the bot has at least `count` response runs. */
async function waitForBotRunCount(
  core: TestStack['core'],
  conversationId: string,
  botId: string,
  count: number,
  options: { timeoutMs?: number } = {},
): Promise<Run[]> {
  return waitFor(async () => {
    const runs = await botRuns(core, conversationId, botId);
    return runs.length >= count ? runs : null;
  }, { ...options, label: `${count} response runs of ${botId}` });
}

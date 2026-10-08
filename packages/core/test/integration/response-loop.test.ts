import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  listRuns,
  makeBot,
  makeGroup,
  openDirect,
  sendBatch,
  sendDrafts,
  step,
  TestClock,
  waitFor,
  waitForEvent,
  waitForMessage,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(options: Parameters<typeof createTestStack>[0] = {}): Promise<TestStack> {
  const stack = await createTestStack(options);
  stacks.push(stack);
  return stack;
}

describe('response loop', () => {
  it('one flushed batch becomes multiple messages and a single run', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('收到，三条都看到了')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const messages = await sendBatch(core, conv.id, ['第一条', '第二条', '第三条']);
    expect(messages).toHaveLength(3);
    expect(new Set(messages.map((m) => m.batchId)).size).toBe(1);

    const run = await waitForRun(core, conv.id, 'completed');
    expect(run.triggerMessageIds).toEqual(messages.map((m) => m.id));
    // P07：响应之后还有后台反思 run——响应 run 本身仍只有一个。
    const runs = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    expect(runs).toHaveLength(1);

    const all = await listMessages(core, conv.id);
    expect(all.filter((m) => m.senderType === 'user')).toHaveLength(3);
    const botMessage = all.find((m) => m.senderBotId === bot.id);
    expect(botMessage?.content).toMatchObject({ text: '收到，三条都看到了' });
  });

  it('a batch flushed mid-run is injected as <new_messages> without a second run', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().hold().replyText('先看看'),
      step().replyText('好的，已经调整'),
    ]);
    await sendBatch(core, conv.id, ['开始干活']);
    await waitForRun(core, conv.id, 'running');

    // While the first request is held, deliver another batch.
    const second = await sendBatch(core, conv.id, ['等一下，先别改配置']);
    expect(second).toHaveLength(1);

    // Wait for the first request to actually reach the mock before releasing.
    await waitFor(() => (llm.requests().length >= 1 ? true : null), { label: 'first request' });
    llm.releaseAll();
    await waitForRun(core, conv.id, 'completed');

    const requests = llm.requestsFor('mock-main');
    expect(requests.length).toBe(2);
    const secondRequest = requests[1]!;
    expect(JSON.stringify(secondRequest.body.messages)).toContain('<new_messages>');
    expect(JSON.stringify(secondRequest.body.messages)).toContain('等一下，先别改配置');

    const runs = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    expect(runs).toHaveLength(1);
  }, 20_000);

  it('cancelling keeps send_message output and marks the run cancelled', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall('send_message', { text: '收到，我看一下' }),
      step().hold().replyText('这条永远不会到达'),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['帮我查一下']);
    await waitForMessage(core, conv.id, (m) => m.senderType === 'bot');

    const run = await waitForRun(core, conv.id, 'running');
    await core.rpc.call('runs.cancel', { runId: run.id });
    const cancelled = await waitForRun(core, conv.id, 'cancelled');

    const all = await listMessages(core, conv.id);
    const botMessages = all.filter((m) => m.senderBotId === bot.id);
    expect(botMessages).toHaveLength(1);
    expect(botMessages[0]?.content).toMatchObject({ text: '收到，我看一下' });
    expect(cancelled.outputMessageIds).toHaveLength(1);
    llm.releaseAll();
    void llm;
  });

  it('send_message twice plus the final text yields three bot messages', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall('send_message', { text: '第一条' }),
      step().replyToolCall('send_message', { text: '第二条' }),
      step().replyText('第三条，最终结论'),
    ]);
    const bot = await makeBot(core, '话痨');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['讲三句']);
    await waitForRun(core, conv.id, 'completed');

    const all = await listMessages(core, conv.id);
    const botMessages = all.filter((m) => m.senderBotId === bot.id);
    expect(botMessages.map((m) => ('text' in m.content ? m.content.text : ''))).toEqual([
      '第一条',
      '第二条',
      '第三条，最终结论',
    ]);
    void llm;
  });

  it('skip_reply ends the run without a final message', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyToolCall('skip_reply', { reason: '无需回应' })]);
    const bot = await makeBot(core, '安静');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['谢谢']);
    await waitForRun(core, conv.id, 'completed');

    const all = await listMessages(core, conv.id);
    expect(all.filter((m) => m.senderBotId === bot.id)).toHaveLength(0);
    void llm;
  });

  it('a 401 fails the run with an auth error and retry succeeds', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().failWith(401, 'Incorrect API key provided'),
      step().replyText('重试后成功'),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['你好']);
    const failed = await waitForRun(core, conv.id, 'failed');
    expect(failed.error ?? '').toMatch(/401|api key/i);

    const result = (await core.rpc.call('runs.retry', { runId: failed.id })) as {
      run: { id: string } | null;
    };
    expect(result.run).not.toBeNull();
    // The returned run is the one that actually executes — the mailbox-owned
    // create path, not a phantom second record (BR-P01-001).
    await waitForMessage(core, conv.id, (m) => m.senderType === 'bot');
    const completed = await waitForRun(core, conv.id, 'completed');
    expect(completed.id).toBe(result.run!.id);
    expect(completed.triggerMessageIds).toEqual(failed.triggerMessageIds);
    // The retry path adds exactly one run record (failed + retried).
    const runs = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    expect(runs).toHaveLength(2);
  });

  it('a run without any configured model fails with a structured main-model setup requirement', async () => {
    // KEPCUP_MOCK_LLM_URL 置空：seedMockLlm 不注册 mock 供应商、不设默认
    // 模型——模拟全新环境（docs/design/18-inline-setup.md 锚定场景 1）。
    const { core, llm } = await start({ env: { KEPCUP_MOCK_LLM_URL: '' } });
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['你好']);
    const failed = await waitForRun(core, conv.id, 'failed');
    expect(failed.setup).toEqual({ kind: 'main-model' });
    expect(failed.error ?? '').toContain('未配置模型');

    // 用户在设置卡片里完成配置（添加供应商 + 设默认主模型）→ 原消息自动重试。
    const settings = (await core.rpc.call('settings.get')) as { customProviders: unknown[] };
    await core.rpc.call('settings.update', {
      customProviders: [
        ...settings.customProviders,
        {
          id: 'mock',
          name: 'Mock LLM',
          baseUrl: llm.url,
          models: [{ id: 'mock-main', name: 'Mock Main' }],
        },
      ],
      defaultMainModel: 'custom:mock/mock-main',
    });
    await core.rpc.call('providers.setKey', { provider: 'custom:mock', key: 'sk-test' });

    llm.script('mock-main', [step().replyText('模型已配置，你好！')]);
    const retried = (await core.rpc.call('runs.retry', { runId: failed.id })) as {
      run: { id: string } | null;
    };
    expect(retried.run).not.toBeNull();
    await waitForMessage(core, conv.id, (m) => m.senderType === 'bot');
    const completed = await waitForRun(core, conv.id, 'completed');
    expect(completed.triggerMessageIds).toEqual(failed.triggerMessageIds);
  });

  it('generate_image without a configured image capability aborts the run into a capability-model setup failure', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall('generate_image', { prompt: '一只在窗台晒太阳的猫' }),
    ]);
    const bot = await makeBot(core, '画师');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['帮我画一张图']);
    const failed = await waitForRun(core, conv.id, 'failed');
    expect(failed.setup).toEqual({ kind: 'capability-model', capability: 'image' });

    // 设置卡片完成图像模型配置后重试：工具不再报 SETUP_REQUIRED，对话继续。
    const settings = (await core.rpc.call('settings.get')) as {
      capabilityModels: Record<string, unknown>;
    };
    await core.rpc.call('settings.update', {
      capabilityModels: {
        ...settings.capabilityModels,
        image: { vendor: 'dashscope', model: 'qwen-image' },
      },
    });
    llm.script('mock-main', [step().replyText('图像能力已就绪')]);
    const retried = (await core.rpc.call('runs.retry', { runId: failed.id })) as {
      run: { id: string } | null;
    };
    expect(retried.run).not.toBeNull();
    await waitForRun(core, conv.id, 'completed');
    const runs = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    expect(runs.filter((r) => r.setup !== null)).toHaveLength(1);
  }, 30_000);

  it('deleting one conversation leaves a running loop in another conversation alone', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('TAG-A'))
        .hold(),
      step()
        .expect((req) => req.lastUserText().includes('TAG-B'))
        .replyText('B 完成'),
    ]);
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);

    await sendBatch(core, convA.id, ['TAG-A 开始干活']);
    await waitForRun(core, convA.id, 'running');
    await sendBatch(core, convB.id, ['TAG-B 开始干活']);
    await waitForRun(core, convB.id, 'completed');

    // Deleting conversation A aborts A's loops only; B's state is untouched.
    await core.rpc.call('conversations.delete', { id: convA.id });
    llm.releaseAll();

    const botMessage = await waitForMessage(core, convB.id, (m) => m.senderBotId === botB.id);
    expect(botMessage.content).toMatchObject({ text: 'B 完成' });
    const runsB = (await listRuns(core, convB.id)).filter((r) => r.loopType === 'turn');
    expect(runsB[0]?.status).toBe('completed');
    void llm;
  }, 20_000);

  it('records the full context of every request as redacted steps', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('完成')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['记录检查']);
    await waitForRun(core, conv.id, 'completed');

    const runs = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    const stepsResult = (await core.rpc.call('runs.steps', { runId: runs[0]!.id })) as {
      steps: Array<{ type: string; payload: unknown }>;
    };
    const requestSteps = stepsResult.steps.filter((s) => s.type === 'request');
    expect(requestSteps.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.stringify(requestSteps[0]!.payload);
    expect(payload).toContain('<platform_rules>');
    expect(payload).toContain('记录检查');
    expect(payload).toContain('send_message');
    void llm;
  });

  it('records usage entries for every model call', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall(
        'send_message',
        { text: '好' },
        { prompt_tokens: 100, completion_tokens: 10 },
      ),
      step().replyText('完成', { prompt_tokens: 200, completion_tokens: 20 }),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['你好']);
    await waitForRun(core, conv.id, 'completed');

    const responseRunId = (await listRuns(core, conv.id)).find(
      (r) => r.loopType === 'turn',
    )!.id;
    const rows = core.services
      .mainDb!.prepare('select * from usage_ledger where run_id = ?')
      .all(responseRunId) as Array<{
      input_tokens: number;
      output_tokens: number;
      provider: string;
      model: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.input_tokens)).toContain(100);
    expect(rows.map((r) => r.input_tokens)).toContain(200);
    expect(rows[0]?.provider).toBe('custom:mock');
    expect(rows[0]?.model).toBe('mock-main');
    void llm;
  });

  // --- 中间过程投送（todo/loop-interim-updates.md） ---------------------------

  it('delivers interim assistant texts (text + tool call) as bot messages in order', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyTextAndToolCall('收到，我先看看项目结构', 'search_messages', { query: '计划' }),
      step().replyTextAndToolCall('让我再检索一些细节', 'search_messages', { query: '细节' }),
      step().replyText('最终结论'),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['帮我调研一下']);
    const run = await waitForRun(core, conv.id, 'completed');

    const all = await listMessages(core, conv.id);
    const botMessages = all.filter((m) => m.senderBotId === bot.id);
    expect(botMessages.map((m) => ('text' in m.content ? m.content.text : ''))).toEqual([
      '收到，我先看看项目结构',
      '让我再检索一些细节',
      '最终结论',
    ]);
    // 中间消息与最终消息同属本 run，且都记入 outputMessageIds。
    expect(botMessages.every((m) => m.runId === run.id)).toBe(true);
    expect(run.outputMessageIds).toHaveLength(3);
    void llm;
  });

  it('a tool call without text stays out of the conversation', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall('search_messages', { query: '无文本' }),
      step().replyText('只有最终结果'),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['查一下']);
    await waitForRun(core, conv.id, 'completed');

    const botMessages = (await listMessages(core, conv.id)).filter((m) => m.senderBotId === bot.id);
    expect(botMessages.map((m) => ('text' in m.content ? m.content.text : ''))).toEqual([
      '只有最终结果',
    ]);
    void llm;
  });

  it('interim delivery is capped at eight per run and the overflow stays in run steps only', async () => {
    const { core, llm } = await start();
    const script = Array.from({ length: 9 }, (_, i) =>
      step().replyTextAndToolCall(`中间说明 ${i + 1}`, 'search_messages', { query: `q${i + 1}` }),
    );
    script.push(step().replyText('最终结果'));
    llm.script('mock-main', script);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['长任务']);
    const run = await waitForRun(core, conv.id, 'completed');

    const botMessages = (await listMessages(core, conv.id)).filter((m) => m.senderBotId === bot.id);
    expect(botMessages.map((m) => ('text' in m.content ? m.content.text : ''))).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `中间说明 ${i + 1}`),
      '最终结果',
    ]);
    // 全部 10 条 assistant 消息仍完整进入执行记录（含第 9 条中间说明）。
    const stepsResult = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string }>;
    };
    expect(stepsResult.steps.filter((s) => s.type === 'assistant')).toHaveLength(10);
    void llm;
  });

  it('publishes run.progress with the tool name when the loop calls a tool', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyToolCall('search_messages', { query: '进度' }),
      step().replyText('完成'),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const progressPromise = waitForEvent<{
      runId: string;
      conversationId: string | null;
      toolName?: string;
    }>(core, 'run.progress', (p) => p.toolName === 'search_messages');
    await sendBatch(core, conv.id, ['查一下']);
    const payload = await progressPromise;
    expect(payload.conversationId).toBe(conv.id);
    await waitForRun(core, conv.id, 'completed');
    void llm;
  });

  it('group conversations cap interim texts at four per run', async () => {
    const { core, llm } = await start();
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const conv = await makeGroup(core, '中间消息群', [a.id, b.id]);
    const script = Array.from({ length: 5 }, (_, i) =>
      step().replyTextAndToolCall(`群里中间 ${i + 1}`, 'search_messages', { query: `q${i + 1}` }),
    );
    script.push(step().replyText('群里最终'));
    llm.script('mock-main', script);

    await sendDrafts(core, conv.id, [{ text: '开始干活', mentions: [a.id] }]);
    await waitForRun(core, conv.id, 'completed');

    const botMessages = (await listMessages(core, conv.id)).filter((m) => m.senderBotId === a.id);
    expect(botMessages.map((m) => ('text' in m.content ? m.content.text : ''))).toEqual([
      '群里中间 1',
      '群里中间 2',
      '群里中间 3',
      '群里中间 4',
      '群里最终',
    ]);
    void llm;
  });
});

describe('loop continuation (Loop 续接, D56)', () => {
  it('replays the previous run deterministically when the next batch arrives within the window', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().replyTextAndToolCall('收到，我先看看日志', 'read', { path: 'logs/error.log' }),
      step().replyText('已经定位到超时原因'),
      step().replyText('好的，接着刚才的结论继续'),
    ]);
    await sendBatch(core, conv.id, ['帮我看下报错']);
    const runA = await waitForRun(core, conv.id, 'completed');
    expect(runA.continuedFromRunIds).toEqual([]);

    await sendBatch(core, conv.id, ['接着刚才继续']);
    const runB = await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        return (
          runs.find(
            (r) => r.id !== runA.id && r.loopType === 'turn' && r.status === 'completed',
          ) ?? null
        );
      },
      { label: 'run B completed' },
    );
    expect(runB.continuedFromRunIds).toEqual([runA.id]);

    // Run B's first request carries the replay of run A's process record:
    // the tool call and the final reply are visible, big outputs elided.
    const runBFirstRequest = llm
      .requestsFor('mock-main')
      .find((r) => r.lastUserText().includes('接着刚才继续'));
    expect(runBFirstRequest).toBeDefined();
    const body = JSON.stringify(runBFirstRequest!.body.messages);
    expect(body).toContain('<continuation>');
    expect(body).toContain(runA.id);
    expect(body).toContain('read(');
    expect(body).toContain('（最终回复） 已经定位到超时原因');
  });

  it('beyond the window the light-model arbiter picks what to replay', async () => {
    const clock = new TestClock();
    const { core, llm } = await start({ clock, timers: clock });
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [step().replyText('第一轮完成')]);
    await sendBatch(core, conv.id, ['开始干活']);
    const runA = await waitForRun(core, conv.id, 'completed');

    // 2h later: outside the deterministic window, inside the arbiter window.
    clock.advance(2 * 60 * 60 * 1000);
    llm.script('mock-light', [
      step()
        .expect((req) => JSON.stringify(req.body).includes('<candidates>'))
        .replyToolCall('submit', { continueRunIds: [runA.id], reason: '用户在继续上一轮' }),
    ]);
    llm.script('mock-main', [step().replyText('继续第二轮')]);
    await sendBatch(core, conv.id, ['接着刚才继续']);
    const runB = await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        return (
          runs.find(
            (r) => r.id !== runA.id && r.loopType === 'turn' && r.status === 'completed',
          ) ?? null
        );
      },
      { label: 'run B completed' },
    );
    expect(runB.continuedFromRunIds).toEqual([runA.id]);

    const runBFirstRequest = llm
      .requestsFor('mock-main')
      .find((r) => r.lastUserText().includes('接着刚才继续'));
    expect(runBFirstRequest).toBeDefined();
    expect(JSON.stringify(runBFirstRequest!.body.messages)).toContain('<continuation>');
    // The arbiter really consulted the light model with the candidate list.
    expect(
      llm.requestsFor('mock-light').some((r) => JSON.stringify(r.body).includes('<candidates>')),
    ).toBe(true);
  });

  it('an arbiter failure degrades to a normal run without replay', async () => {
    const clock = new TestClock();
    const { core, llm } = await start({ clock, timers: clock });
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [step().replyText('第一轮完成')]);
    await sendBatch(core, conv.id, ['开始干活']);
    const runA = await waitForRun(core, conv.id, 'completed');

    clock.advance(2 * 60 * 60 * 1000);
    // No mock-light script: every arbiter request gets a 500 (twice, with the
    // structured-call retry) -> fail-open, run B starts without replay.
    llm.script('mock-main', [step().replyText('继续第二轮')]);
    await sendBatch(core, conv.id, ['接着刚才继续']);
    await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        return (
          runs.find(
            (r) => r.id !== runA.id && r.loopType === 'turn' && r.status === 'completed',
          ) ?? null
        );
      },
      { label: 'run B completed' },
    );

    const runBFirstRequest = llm
      .requestsFor('mock-main')
      .find((r) => r.lastUserText().includes('接着刚才继续'));
    expect(runBFirstRequest).toBeDefined();
    expect(JSON.stringify(runBFirstRequest!.body.messages)).not.toContain('<continuation>');
    expect(llm.requestsFor('mock-light').length).toBeGreaterThanOrEqual(2);
  });
});

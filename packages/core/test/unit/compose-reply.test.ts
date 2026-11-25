import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, step, type TestStack } from '@kepcup/testkit';

/**
 * T10 `bots.composeReply`（62.06 §3 分身代答的 core 通用能力）：以 Bot 人设做
 * 一次**无工具**的轻量生成。四条验收：
 * - 无工具——模型请求不带 tools（工具面为空断言）；
 * - 不注入本机记忆与画像原文——prompt 不含 `<relevant_memories>` /
 *   `<user_profile>` 段、不泄漏库里的条目内容（只注入人设 + instructions）；
 * - 记用量——先建 run（conversation_id NULL），usage_ledger 行 run_id 非空；
 * - 入参校验——transcript / instructions 形态与未知 Bot。
 *
 * 模型链走既有轻量链（triage 路由 → mock-light）；失败路径留 failed run
 * （light-judgement 先例）。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function compose(
  stack: TestStack,
  input: Record<string, unknown>,
): Promise<{ text: string }> {
  return (await stack.core.rpc.call('bots.composeReply', input)) as { text: string };
}

describe('bots.composeReply（T10）', () => {
  it('无工具：请求不带 tools，transcript 与 instructions 按协议渲染', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '代答回答者');
    stack.llm.script('mock-light', [
      step()
        .expect((req) => req.body.tools === undefined || (req.body.tools ?? []).length === 0)
        .expect((req) => req.lastUserText().includes('同事甲：下午的会推迟到三点'))
        .expect((req) => req.lastUserText().includes('同事乙：收到，那我等通知'))
        .expect((req) => req.lastUserText().includes('说明张三暂时离开'))
        .replyText('好的，会议推迟到三点，我会同步相关同事。'),
    ]);
    const result = await compose(stack, {
      botId: bot.id,
      transcript: [
        { speaker: '同事甲', text: '下午的会推迟到三点' },
        { speaker: '同事乙', text: '收到，那我等通知' },
      ],
      instructions: '你在替张三回复同事；说明张三暂时离开；不承诺具体事项。',
    });
    expect(result.text).toContain('会议推迟到三点');
    // 人设段注入了 Bot 名（identity），instructions 原样出现。
    const request = stack.llm.requestsFor('mock-light')[0]!;
    expect(request.body.tools ?? []).toHaveLength(0);
    const system = JSON.stringify(request.body.messages ?? []).includes('代答回答者');
    expect(system).toBe(true);
    expect(JSON.stringify(request.body.messages ?? [])).toContain('你在替张三回复同事');
  });

  it('不注入本机记忆与画像：prompt 无 <relevant_memories> / <user_profile>，条目内容不出现', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '保密测试机');
    const memory = stack.core.services.memory!;
    // 一条本机记忆 + 一条画像条目：若注入它们，mock 断言会立即暴露。
    const written = await memory.writeMemory(bot.id, null, {
      content: 'PRIVATE-MEMORY-MARKER-绝不外泄的私人记忆',
      kind: 'self_note',
      triggerMessages: [],
    });
    expect(written.ok).toBe(true);
    memory.profileStore.insert(
      {
        category: 'boundaries',
        content: 'PRIVATE-PROFILE-MARKER-绝不外泄的画像条目',
        source: 'explicit',
        evidence: [],
        contributedBy: null,
        confidence: 1,
      },
      '',
    );
    stack.llm.script('mock-light', [
      step()
        .expect((req) => !JSON.stringify(req.body.messages ?? []).includes('<relevant_memories>'))
        .expect((req) => !JSON.stringify(req.body.messages ?? []).includes('<user_profile>'))
        .expect((req) => !JSON.stringify(req.body.messages ?? []).includes('PRIVATE-MEMORY-MARKER'))
        .expect((req) => !JSON.stringify(req.body.messages ?? []).includes('PRIVATE-PROFILE-MARKER'))
        .replyText('收到。'),
    ]);
    const result = await compose(stack, {
      botId: bot.id,
      transcript: [{ speaker: '同事甲', text: '在吗' }],
      instructions: '简短回复即可。',
    });
    expect(result.text).toBe('收到。');
    expect(stack.llm.requestsFor('mock-light')).toHaveLength(1);
  });

  it('先建 run 记用量：usage_ledger.run_id 非空、conversation_id NULL、run 行 triage/NULL', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '记账测试机');
    stack.llm.script('mock-light', [
      step().replyText('好的。', { prompt_tokens: 100, completion_tokens: 7 }),
    ]);
    await compose(stack, {
      botId: bot.id,
      transcript: [{ speaker: 'user', text: '在吗' }],
      instructions: '回复一句。',
    });
    // run 行：conversation_id NULL + loop_type triage（先于模型调用创建）。
    const runsDb = stack.core.services.runsDb!;
    const run = runsDb
      .prepare(
        'select id, conversation_id, loop_type, status, bot_id from runs where bot_id = ? order by created_at desc limit 1',
      )
      .get(bot.id) as { id: string; conversation_id: string | null; loop_type: string; status: string };
    expect(run.loop_type).toBe('triage');
    expect(run.conversation_id).toBeNull();
    expect(run.status).toBe('completed');
    // 账行：run_id 非空且指向刚建的 run；conversation_id NULL（团队层按
    // 「NULL conversation = 平台/宿主消耗」兜底，core 不解释）。
    const ledger = stack.core.services.mainDb!
      .prepare(
        'select run_id, conversation_id, bot_id, input_tokens, output_tokens from usage_ledger where run_id = ?',
      )
      .all(run.id) as Array<{ run_id: string; conversation_id: string | null; input_tokens: number }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.run_id).toBe(run.id);
    expect(ledger[0]!.conversation_id).toBeNull();
    expect(ledger[0]!.input_tokens).toBe(100);
  });

  it('失败路径留 failed run（照 light-judgement 先例），错误上抛', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '失败测试机');
    stack.llm.script('mock-light', [step().failWith(500, 'boom')]);
    await expect(
      compose(stack, {
        botId: bot.id,
        transcript: [{ speaker: 'user', text: '在吗' }],
        instructions: '回复一句。',
      }),
    ).rejects.toMatchObject({});
    const runsDb = stack.core.services.runsDb!;
    const run = runsDb
      .prepare('select status from runs where bot_id = ? order by created_at desc limit 1')
      .get(bot.id) as { status: string };
    expect(run.status).toBe('failed');
  });

  it('入参校验：transcript 空 / 超限、text 超长、instructions 超长、未知 Bot', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '校验测试机');
    const longText = '长'.repeat(4001);
    const longInstructions = '长'.repeat(2001);
    await expect(compose(stack, { botId: bot.id, transcript: [], instructions: 'x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      compose(stack, {
        botId: bot.id,
        transcript: Array.from({ length: 51 }, () => ({ speaker: 'a', text: 'x' })),
        instructions: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      compose(stack, { botId: bot.id, transcript: [{ speaker: 'a', text: longText }], instructions: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      compose(stack, { botId: bot.id, transcript: [{ speaker: 'a', text: 'x' }], instructions: longInstructions }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      compose(stack, {
        botId: 'bot_nonexistent',
        transcript: [{ speaker: 'a', text: 'x' }],
        instructions: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 合法边界（50 条 / 4000 字 / 2000 字）不应被拒——打到 mock 即证明通过校验。
    stack.llm.script('mock-light', [step().replyText('ok')]);
    const result = await compose(stack, {
      botId: bot.id,
      transcript: Array.from({ length: 50 }, () => ({ speaker: 'a', text: 'x'.repeat(4000) })),
      instructions: 'y'.repeat(2000),
    });
    expect(result.text).toBe('ok');
  });
});

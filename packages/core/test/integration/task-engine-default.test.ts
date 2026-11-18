import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Run } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentSpawner,
  fakeAgentEntry,
  fakeAcpAgentLaunch,
  makeBot,
  readFakeAgentRecord,
  openDirect,
  sendBatch,
  step,
  waitFor,
  writeFakeAgentScript,
  type FakeAgentScript,
  type MockLlmStep,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 任务执行引擎三态（2026-11 修订，design 28 §8 / §3）：`runtime.agent.id` 的
 * `''` = 跟随应用默认（`settings.defaultTaskAgentId`，经 `agentRunGate` 不可用
 * 回落内置）、`'builtin'` = 显式内置任务引擎（可选任务模型）、目录 id = 外部。
 * 对话轮恒内置。每个用例用 `start_task` 的模型 ref 断言任务落在哪个引擎。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ENTRY = fakeAgentEntry('fake', { name: 'Fake Agent' });

async function start(script: FakeAgentScript) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kepcup-task-engine-'));
  dirs.push(dir);
  const scriptFile = path.join(dir, 'script.json');
  const recordFile = path.join(dir, 'record.jsonl');
  writeFakeAgentScript(scriptFile, script);
  const stack = await createTestStack({
    agentCatalog: [ENTRY],
    agentLaunch: (entry) =>
      entry.id.startsWith('fake') ? fakeAcpAgentLaunch(scriptFile, recordFile) : null,
  });
  stacks.push(stack);
  return {
    ...stack,
    record: () => Promise.resolve(readFakeAgentRecord(recordFile)),
  };
}

function runsOf(stack: TestStack, conversationId: string, loopType: Run['loopType']): Run[] {
  return stack.core.services
    .domain!.runs.listByConversation(conversationId, 100)
    .filter((run) => run.loopType === loopType)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** 等任务结算；超时时把 run 行状态塞进错误信息（worker console 被 vitest 吞掉）。 */
async function waitSettledTask(
  stack: TestStack,
  conversationId: string,
  statuses: Run['status'][],
): Promise<Run> {
  const dump = (): string =>
    JSON.stringify({
      tasks: runsOf(stack, conversationId, 'task').map((run) => ({
        s: run.status,
        e: run.error,
        setup: run.setup,
        eng: run.engine,
        model: run.model,
      })),
      turns: runsOf(stack, conversationId, 'turn').map((run) => ({
        s: run.status,
        e: run.error,
        eng: run.engine,
      })),
      reqs: stack.llm.requests().length,
    });
  try {
    return await waitFor(
      () => {
        const task = runsOf(stack, conversationId, 'task').find((run) =>
          statuses.includes(run.status),
        );
        return task ?? null;
      },
      { label: `settled task (${statuses.join('/')})` },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nSTATE: ${dump()}`,
    );
  }
}

/**
 * 派任务 + 唤醒转述的最小对话轮剧本。`start_task.source_message_ids` 必填：
 * 用 lazy 回调在请求到达时取当前对话里的用户消息 id（消息在 script 之后才发）。
 */
function dispatchScript(
  sourceIds: () => string[],
  taskText: string,
): MockLlmStep[] {
  return [
    step()
      .inTurn()
      .replyToolCall('start_task', () => ({
        title: '处理请求',
        instruction: '按用户的消息完成这件事',
        source_message_ids: sourceIds(),
        writes: false,
      })),
    step().inTurn().replyText('ACK 我交给外援'),
    step().inTask().replyText(taskText),
    step().inTurn().replyText(`RELAY ${taskText}`),
  ];
}

function sharedUserIds(stack: TestStack, conversationId: string): () => string[] {
  return () =>
    stack.core.services
      .domain!.messages.listShared(conversationId, { limit: 50 })
      .filter((message) => message.senderType === 'user')
      .map((message) => message.id);
}

describe('task engine three states (2026-11 revision)', () => {
  it("'': a bot without an explicit engine follows settings.defaultTaskAgentId for tasks; its turn stays built-in", async () => {
    const stack = await start({ turns: [agentTurn().text('外援完成了')] });
    await stack.core.rpc.call('settings.update', {
      agents: { fake: { enabled: true } },
      defaultTaskAgentId: 'fake',
    });
    const bot = await makeBot(stack.core, '跟随默认');
    // 新建 Bot 未显式设置任务引擎（''），应用默认解析到 fake。
    expect(bot.profile.runtime.agent.id).toBe('');
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script('mock-main', dispatchScript(sharedUserIds(stack, conv.id), '外援完成了'));

    await sendBatch(stack.core, conv.id, ['帮我办一件事']);
    const task = await waitSettledTask(stack, conv.id, ['completed']);
    // 任务落在外部智能体引擎；对话轮恒内置。
    expect(task.engine).toBe('agent:fake');
    const [turn] = runsOf(stack, conv.id, 'turn');
    expect(turn?.engine).toBe('builtin');
    await waitFor(
      async () =>
        (await stack.record()).prompts.some((prompt) => prompt.text.includes('帮我办一件事'))
          ? true
          : null,
      { label: 'agent received the task prompt' },
    );
  }, 45_000);

  it("the app default being unusable (not enabled) falls back to the built-in engine for the bot's tasks", async () => {
    const stack = await start({ turns: [agentTurn().text('不该被调用')] });
    // 默认引擎指向一个未启用的目录条目：agentRunGate 拦下 → 回落内置。
    await stack.core.rpc.call('settings.update', {
      agents: { fake: { enabled: false } },
      defaultTaskAgentId: 'fake',
    });
    const bot = await makeBot(stack.core, '回落内置');
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script('mock-main', dispatchScript(sharedUserIds(stack, conv.id), '内置引擎完成了'));

    await sendBatch(stack.core, conv.id, ['帮我办一件事']);
    const task = await waitSettledTask(stack, conv.id, ['completed']);
    expect(task.engine).toBe('builtin');
    expect(task.model).toBe('custom:mock/mock-main');
    // 假智能体进程从未被拉起。
    expect((await stack.record()).sessions).toHaveLength(0);
  }, 45_000);

  it("'builtin': an explicit built-in task engine uses the bot's task model for its tasks", async () => {
    const stack = await start({ turns: [agentTurn().text('不该被调用')] });
    const created = await makeBot(stack.core, '显式内置');
    const bot = (
      (await stack.core.rpc.call('bots.update', {
        id: created.id,
        profile: {
          ...created.profile,
          runtime: {
            ...created.profile.runtime,
            agent: {
              id: 'builtin',
              model: 'custom:mock/mock-light',
              effort: '',
              permission: 'workspace',
              capabilities: null,
            },
          },
        },
      })) as { bot: Bot }
    ).bot;
    expect(bot.profile.runtime.agent.id).toBe('builtin');
    const conv = await openDirect(stack.core, bot.id);
    // 对话轮走主模型；任务按显式内置任务模型走 mock-light（两条泳道都要有剧本）。
    stack.llm.script('mock-main', [
      step()
        .inTurn()
        .replyToolCall('start_task', () => ({
          title: '处理请求',
          instruction: '按用户的消息完成这件事',
          source_message_ids: sharedUserIds(stack, conv.id)(),
          writes: false,
        })),
      step().inTurn().replyText('ACK 我去办'),
      step().inTurn().replyText('RELAY 内置任务模型完成了'),
    ]);
    stack.llm.script('mock-light', [step().inTask().replyText('内置任务模型完成了')]);

    await sendBatch(stack.core, conv.id, ['帮我办一件事']);
    const task = await waitSettledTask(stack, conv.id, ['completed']);
    expect(task.engine).toBe('builtin');
    // 显式内置的任务模型（custom:mock/mock-light）优先于主模型。
    expect(task.model).toBe('custom:mock/mock-light');
    expect((await stack.record()).sessions).toHaveLength(0);
  }, 45_000);
});

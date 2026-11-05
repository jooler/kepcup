import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  isTaskRequest,
  makeBot,
  openDirect,
  sendBatch,
  step,
  viaTask,
  waitForRun,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';

/**
 * prompt cache 的前缀稳定性（D93 任务 loop = 一个对话）。
 *
 * pi-ai 的 Anthropic 适配给断点标在「最后一个工具」「system 块」「最后一条消息」上
 * （anthropic-messages.ts buildParams），缓存按前缀匹配：断点之前的任何字节变化都会让
 * 之后的缓存全部失效。所以同一个 run 内 system 必须逐字节不变，动态内容（计划、
 * 记忆、授权、workspace 列表……）只能以消息形式追加在尾部。
 *
 * mock provider 是 OpenAI 兼容端点：system 是 messages 里的第一条 system 消息。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) stack.llm.releaseAll();
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function workspaceOf(core: TestStack['core'], botId: string, conversationId: string): string {
  return workspacePathFor(resolvePaths(core.services.paths.home), botId, conversationId);
}

/** 请求里 system 段的原文（OpenAI 兼容端点：第一条 system / developer 消息）。 */
function systemText(request: MockChatRequest): string {
  const messages = (request.body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const system = messages.find(
    (message) => message.role === 'system' || message.role === 'developer',
  );
  return typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content);
}

function userTexts(request: MockChatRequest): string[] {
  const messages = (request.body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

function countPlanBlocks(request: MockChatRequest): number {
  return userTexts(request).filter((text) => text.includes('<current_plan>')).length;
}

describe('prompt cache: one run sends a byte-stable prefix', () => {
  it('同一 run 内 system 逐字节不变（workspace 顶层内容变了也不重建）', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '缓存稳定性');
    const conv = await openDirect(core, bot.id);
    const workspace = workspaceOf(core, bot.id, conv.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'before.txt'), 'before\n');

    llm.script(
      'mock-main',
      viaTask({
        writes: true,
        taskSteps: [
          step().replyToolCall('write', { path: 'after.txt', content: 'after' }),
          step().replyToolCall('read', { path: 'after.txt' }),
          step().replyText('完成'),
        ],
      }),
    );

    await sendBatch(core, conv.id, ['跑一下缓存稳定性']);
    await waitForRun(core, conv.id, 'completed', { loopType: 'task', timeoutMs: 120_000 });

    const taskRequests = llm.requests().filter((request) => isTaskRequest(request));
    expect(taskRequests.length).toBeGreaterThanOrEqual(3);

    // 反证：system 的一个输入确实变了（workspace 顶层多了 after.txt），
    // 旧实现会在下一次请求重建 system，这里必须是同一份字节。
    expect(existsSync(path.join(workspace, 'after.txt'))).toBe(true);
    const systems = taskRequests.map((request) => systemText(request));
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain('<workspace>');
    expect(systems[0]).not.toContain('after.txt');

    // 断点之间的 tools 段同样稳定（最后一个工具之后就是 tools 的缓存断点）。
    const toolNames = taskRequests.map((request) =>
      JSON.stringify(
        ((request.body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
          (tool) => tool.function?.name ?? '',
        ),
      ),
    );
    expect(new Set(toolNames).size).toBe(1);
  }, 180_000);

  it('计划只以尾部 user 消息下发，不改 system，也不每轮重复堆叠', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '计划缓存');
    const conv = await openDirect(core, bot.id);
    const workspace = workspaceOf(core, bot.id, conv.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'plan.txt'), 'plan body\n');

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('update_plan', {
            plan: [
              { step: '检查项目', status: 'in_progress' },
              { step: '汇报结果', status: 'pending' },
            ],
          }),
          step().replyToolCall('read', { path: 'plan.txt' }),
          step().replyToolCall('read', { path: 'plan.txt' }),
          step().replyText('完成'),
        ],
      }),
    );

    await sendBatch(core, conv.id, ['按计划做完']);
    await waitForRun(core, conv.id, 'completed', { loopType: 'task', timeoutMs: 120_000 });

    const taskRequests = llm.requests().filter((request) => isTaskRequest(request));
    expect(taskRequests.length).toBeGreaterThanOrEqual(4);

    // system 里不再有计划段，且整轮不变。
    const systems = taskRequests.map((request) => systemText(request));
    expect(new Set(systems).size).toBe(1);
    expect(systems.every((system) => !system.includes('<current_plan>'))).toBe(true);

    // 计划变化后的一次请求能看到计划；之后没有变化就不重复追加。
    const withPlan = taskRequests.filter((request) => countPlanBlocks(request) > 0);
    expect(withPlan.length).toBeGreaterThan(0);
    const last = taskRequests.at(-1)!;
    expect(countPlanBlocks(last)).toBe(1);
    expect(userTexts(last).some((text) => text.includes('[in_progress] 检查项目'))).toBe(true);
    // 计划块在消息流末尾（最后一条 user 消息），而不是历史中段。
    expect(userTexts(last).at(-1)).toContain('<current_plan>');
  }, 180_000);
});

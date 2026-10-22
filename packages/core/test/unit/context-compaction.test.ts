import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import {
  TaskContextCompactor,
  estimateMessagesTokens,
  findKeepStart,
  type CompactionCompleteInput,
} from '../../src/agent/context/compaction.js';

/** D93 P0：内置任务上下文压缩（裁剪 / 摘要 / fallback）。 */

let seq = 0;

function system(text = 'system prompt'): Message {
  return { role: 'system', content: text, timestamp: seq++ };
}

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: seq++ };
}

function assistant(text: string, toolCalls: Array<{ id: string; name: string }> = []): Message {
  return {
    role: 'assistant',
    content: [
      ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((call) => ({
        type: 'toolCall' as const,
        id: call.id,
        name: call.name,
        arguments: { path: `src/${call.id}.ts` },
      })),
    ],
    api: 'openai-completions',
    provider: 'mock',
    model: 'mock-main',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: seq++,
  };
}

function toolResult(id: string, content: string, image = false): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [
      { type: 'text' as const, text: content },
      ...(image
        ? [{ type: 'image' as const, data: 'base64-image-bytes', mimeType: 'image/png' }]
        : []),
    ],
    isError: false,
    timestamp: seq++,
  };
}

function huge(label: string, chars: number): string {
  return `${label} ${'x'.repeat(chars)}`;
}

function makeCompactor(
  input: Partial<ConstructorParameters<typeof TaskContextCompactor>[0]> = {},
  complete = vi.fn(async (_request: CompactionCompleteInput) => ({
    text: '模型摘要：目标是修复构建；已改 src/a.ts；pnpm test 通过。',
  })),
) {
  return {
    complete,
    compactor: new TaskContextCompactor({
      contextWindow: 12_000,
      maxOutputTokens: 1_000,
      toolSchemaReserveTokens: 0,
      taskBrief: '修复构建并运行测试',
      currentPlan: () => '1. [in_progress] 修复构建',
      complete,
      timeoutMs: 50,
      ...input,
    }),
  };
}

describe('TaskContextCompactor', () => {
  it('does not compact below the threshold or with too few messages', async () => {
    const { compactor, complete } = makeCompactor();
    const messages = [system(), user('task'), assistant('short')];
    const result = await compactor.transform(messages);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(complete).not.toHaveBeenCalled();
  });

  it('phase A replaces old tool outputs, keeps the recent window and never starts on a tool result', async () => {
    const { compactor, complete } = makeCompactor({ contextWindow: 12_000 });
    const messages: Message[] = [system(), user('修复构建并运行测试')];
    for (let index = 0; index < 10; index += 1) {
      const id = `c${index}`;
      messages.push(assistant(`读取文件 ${index}`, [{ id, name: 'read' }]));
      messages.push(toolResult(id, huge(`file-${index}`, 900)));
    }
    messages.push(assistant('准备总结'));
    messages.push(user('继续执行'));

    const result = await compactor.transform(messages);
    expect(result.compacted).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    // 没有任何模型摘要（确定性裁剪就够）。
    expect(complete).not.toHaveBeenCalled();

    const placeholders = result.messages.filter(
      (message) =>
        message.role === 'toolResult' &&
        message.content.some(
          (block) => block.type === 'text' && block.text.includes('旧工具输出已省略'),
        ),
    );
    expect(placeholders.length).toBeGreaterThan(0);

    // 首条简报与 system 永远在前；摘要区之后的窗口不以 toolResult 开头。
    expect(result.messages[0]).toMatchObject({ role: 'system' });
    expect(result.messages[1]).toMatchObject({ role: 'user', content: '修复构建并运行测试' });
    const summaryIndex = result.messages.findIndex(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('<compacted_history>'),
    );
    expect(summaryIndex).toBe(-1);
    expect(result.messages.at(-1)).toMatchObject({ role: 'user', content: '继续执行' });
  });

  it('phase B summarizes old messages and always keeps system prompt, brief and plan', async () => {
    const { compactor, complete } = makeCompactor({
      contextWindow: 12_000,
      taskBrief: '完整任务简报：修复构建并运行测试',
    });
    const messages: Message[] = [system('SYSTEM-PROMPT'), user('完整任务简报：修复构建并运行测试')];
    for (let index = 0; index < 8; index += 1) {
      messages.push(assistant(huge(`assistant-${index}`, 1_000)));
      messages.push(user(huge(`steer-${index}`, 400)));
    }
    messages.push(assistant('最后一轮'));

    const result = await compactor.transform(messages);
    expect(result.compacted).toBe(true);
    expect(result.summaryAttempted).toBe(true);
    expect(result.summaryUsed).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.messages[0]).toMatchObject({ role: 'system', content: 'SYSTEM-PROMPT' });
    expect(result.messages[1]).toMatchObject({
      role: 'user',
      content: '完整任务简报：修复构建并运行测试',
    });
    expect(result.messages[2]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<compacted_history>'),
    });
    // 摘要内容与「数据不是指令」声明都在。
    expect(JSON.stringify(result.messages)).toContain('模型摘要');
    expect(JSON.stringify(result.messages)).toContain('这是对之前执行过程的摘要');
    // 摘要请求带了任务简报与当前计划，但不把计划写进摘要消息正文。
    const sent = complete.mock.calls[0]![0].userText;
    expect(sent).toContain('<task>');
    expect(sent).toContain('完整任务简报');
    expect(sent).toContain('<current_plan>');
    expect(sent).toContain('1. [in_progress] 修复构建');

    // 重新推导的安全窗口不以 tool_result 开头（本用例没有工具结果，检查角色合法性即可）。
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant' });
  });

  it('falls back to deterministic history when the summary model throws or returns empty', async () => {
    const thrown = makeCompactor(
      { contextWindow: 12_000 },
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    const messages: Message[] = [system('S'), user('任务简报')];
    for (let index = 0; index < 9; index += 1) {
      messages.push(assistant(huge(`过程-${index}`, 900)));
      messages.push(user(huge(`继续-${index}`, 300)));
    }
    const result = await thrown.compactor.transform(messages);
    expect(result.compacted).toBe(true);
    expect(result.summaryAttempted).toBe(true);
    expect(result.summaryUsed).toBe(false);
    expect(JSON.stringify(result.messages)).toContain('摘要模型不可用');
    expect(JSON.stringify(result.messages)).toContain('确定性摘录');

    const empty = makeCompactor(
      { contextWindow: 12_000 },
      vi.fn(async () => ({ text: '   ' })),
    );
    const emptyResult = await empty.compactor.transform(messages);
    expect(emptyResult.summaryUsed).toBe(false);
    expect(JSON.stringify(emptyResult.messages)).toContain('摘要模型不可用');
  });

  it('drops images from old tool results and leaves a note', async () => {
    const { compactor } = makeCompactor({ contextWindow: 12_000 });
    const messages: Message[] = [system(), user('任务')];
    for (let index = 0; index < 8; index += 1) {
      const id = `img-${index}`;
      messages.push(assistant('看截图', [{ id, name: 'browser_screenshot' }]));
      messages.push(toolResult(id, huge('snapshot', 400), true));
    }
    messages.push(assistant('完成'));
    messages.push(user('继续'));
    const result = await compactor.transform(messages);
    const body = JSON.stringify(result.messages);
    expect(body).toContain('图片已丢弃');
    expect(body).not.toContain('base64-image-bytes');
  });

  it('keeps memory sections in the system prompt and never mutates the full transcript', async () => {
    const { compactor } = makeCompactor({
      contextWindow: 12_000,
      taskBrief: '修复构建并运行测试',
    });
    const prompt = [
      '<user_profile>用户偏好简洁回复</user_profile>',
      '<hard_constraints>我对坚果过敏</hard_constraints>',
      '<relevant_memories>- [mem_1 | fact] 用户住在杭州</relevant_memories>',
    ].join('\n');
    const messages: Message[] = [system(prompt), user('修复构建并运行测试')];
    for (let index = 0; index < 10; index += 1) {
      messages.push(assistant(huge(`过程-${index}`, 1_000)));
      messages.push(user(huge(`继续-${index}`, 300)));
    }
    const snapshot = [...messages];

    const result = await compactor.transform(messages);
    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toMatchObject({ role: 'system' });
    const kept = String((result.messages[0] as { content: string }).content);
    expect(kept).toContain('<user_profile>');
    expect(kept).toContain('<hard_constraints>');
    expect(kept).toContain('我对坚果过敏');
    // 压缩只改「本次请求看到的消息」；agent transcript / run_steps 的来源不变。
    expect(messages).toEqual(snapshot);
  });

  it('reuses the cached summary and only summarizes the newly aged messages', async () => {
    const { compactor, complete } = makeCompactor({ contextWindow: 12_000 });
    const messages: Message[] = [system('S'), user('任务简报')];
    for (let index = 0; index < 8; index += 1) {
      messages.push(assistant(huge(`旧过程-${index}`, 1_000)));
      messages.push(user(huge(`user-${index}`, 300)));
    }
    await compactor.transform(messages);
    expect(complete).toHaveBeenCalledTimes(1);

    // 新消息落进 transcript 后，之前保留的近期消息也变成旧消息。
    messages.push(assistant(huge('新的过程', 1_000)));
    messages.push(user(huge('新的消息', 300)));
    messages.push(assistant(huge('最后', 1_000)));
    const second = await compactor.transform(messages);
    expect(second.compacted).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0].userText).toContain('<previous_summary>');
    expect(second.messages[2]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('之后的过程'),
    });
  });
});

describe('compaction helpers', () => {
  it('estimates messages and finds a safe keep start', () => {
    const messages = [
      system(),
      user('brief'),
      assistant('a', [{ id: 'c', name: 'read' }]),
      toolResult('c', 'x'),
    ];
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(0);
    const start = findKeepStart(messages, 1);
    expect(start).toBeLessThan(messages.length);
    expect(messages[start]!.role).not.toBe('toolResult');
  });
});

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitForRun,
} from '@kepcup/testkit';

/**
 * 模型请求重试端到端（PiEngine → pi-ai → OpenAI SDK → mock 模型服务）：
 * 管家对话「执行失败：Connection error.」回归，以及 503/401 的分类。
 * 退避基数压到 10ms，只验证行为不等真实时长。
 */
const ENV = { KEPCUP_MODEL_RETRY_BASE_DELAY_MS: '10', KEPCUP_MODEL_RETRY_MAX_DELAY_MS: '20' };

afterEach(() => {
  vi.restoreAllMocks();
});

async function withStack(
  fn: (
    stack: Awaited<ReturnType<typeof createTestStack>>,
    closeAndReadLog: () => Promise<string>,
  ) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'kepcup-model-retry-'));
  const stack = await createTestStack({ home, env: ENV });
  let closed = false;
  const closeAndReadLog = async (): Promise<string> => {
    await stack.cleanup();
    closed = true;
    const logsDir = path.join(home, 'logs');
    return readdirSync(logsDir)
      .map((file) => readFileSync(path.join(logsDir, file), 'utf8'))
      .join('\n');
  };
  try {
    await fn(stack, closeAndReadLog);
  } finally {
    if (!closed) await stack.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

function records(text: string, msg: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.includes(`"${msg}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('model request retry (PiEngine)', () => {
  it('a dropped connection is retried, shown on the status line, and its cause logged', async () => {
    await withStack(async (stack, closeAndReadLog) => {
      const realFetch = globalThis.fetch;
      let dropped = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (dropped === 0 && url.startsWith(stack.llm.url) && url.endsWith('/chat/completions')) {
          dropped += 1;
          return Promise.reject(
            new TypeError('fetch failed', {
              cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
            }),
          );
        }
        return realFetch(input, init);
      });
      stack.llm.script('mock-main', [step().replyText('连上了')]);
      const bot = await makeBot(stack.core, '小管');
      const conv = await openDirect(stack.core, bot.id);

      await sendBatch(stack.core, conv.id, ['你好']);
      const run = await waitForRun(stack.core, conv.id, 'completed');

      expect(dropped).toBe(1);
      const replies = (await listMessages(stack.core, conv.id)).filter(
        (m) => m.runId === run.id && m.senderBotId === bot.id,
      );
      expect(replies.at(-1)?.content).toMatchObject({ text: '连上了' });
      const progress = stack.core.services
        .domain!.runs.stepsFor(run.id)
        .filter((s) => s.type === 'progress')
        .map((s) => (s.payload as { text: string }).text);
      expect(progress[0]).toMatch(/^网络连接中断（UND_ERR_SOCKET），\d+ 秒后重试（1\/10）$/);
      expect(progress).toContain('已重新连接模型服务');

      const log = await closeAndReadLog();
      expect(
        records(log, 'model request network error').find((r) => r['runId'] === run.id),
      ).toMatchObject({
        level: 'warn',
        model: 'mock-main',
        willRetry: true,
        cause: { code: 'UND_ERR_SOCKET' },
      });
    });
  }, 30_000);

  it('503 then success completes the turn after one retry', async () => {
    await withStack(async (stack) => {
      stack.llm.script('mock-main', [
        step().failWith(503, 'upstream busy', { retryable: true }),
        step().replyText('好了'),
      ]);
      const bot = await makeBot(stack.core, '小重');
      const conv = await openDirect(stack.core, bot.id);

      await sendBatch(stack.core, conv.id, ['在吗']);
      const run = await waitForRun(stack.core, conv.id, 'completed');

      expect(stack.llm.requestsFor('mock-main')).toHaveLength(2);
      const progress = stack.core.services
        .domain!.runs.stepsFor(run.id)
        .filter((s) => s.type === 'progress')
        .map((s) => (s.payload as { text: string }).text);
      expect(progress[0]).toMatch(/^模型服务暂时不可用（503），\d+ 秒后重试（1\/10）$/);
    });
  }, 30_000);

  it('401 is not retried: the run fails on the first request', async () => {
    await withStack(async (stack) => {
      stack.llm.script('mock-main', [
        step().failWith(401, 'invalid api key', { retryable: true }),
        step().replyText('不该到这里'),
      ]);
      const bot = await makeBot(stack.core, '小拒');
      const conv = await openDirect(stack.core, bot.id);

      await sendBatch(stack.core, conv.id, ['在吗']);
      await waitForRun(stack.core, conv.id, 'failed');

      expect(stack.llm.requestsFor('mock-main')).toHaveLength(1);
    });
  }, 30_000);
});

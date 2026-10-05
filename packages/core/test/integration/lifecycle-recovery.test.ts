import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestCore,
  createTestStack,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { createMemoryKeystore } from '@kepcup/core';
import { step } from '@kepcup/testkit';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

describe('startup recovery', () => {
  it('a run still marked running after a crash becomes interrupted with a system message', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-recover-'));
    const keystore = createMemoryKeystore();
    const first = await createTestStack({ home, keystore });
    try {
      first.llm.script('mock-main', [step().hold().replyText('永远不会完成')]);
      const bot = await makeBot(first.core, '小艾');
      const conv = await openDirect(first.core, bot.id);
      await sendBatch(first.core, conv.id, ['开始长任务']);
      await waitForRun(first.core, conv.id, 'running');

      // Simulate a crash: drop the core without settling the run.
      await first.core.close();
      await first.llm.stop();
      stacks.pop();

      const second = await createTestStack({ home, keystore });
      try {
        const runs = await listRuns(second.core, conv.id);
        // P07：可能还有后台反思 run——响应 run 才是被中断的那个。
        expect(runs.find((r) => r.loopType === 'response')?.status).toBe('interrupted');

        const messages = await listMessages(second.core, conv.id);
        const systemMessage = messages.find(
          (m) => m.senderType === 'system' && 'text' in m.content && m.content.text.includes('中断'),
        );
        expect(systemMessage).toBeDefined();
      } finally {
        await second.cleanup();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('jobs stuck in running are reset to pending on boot', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-jobs-'));
    const keystore = createMemoryKeystore();
    const first = await createTestCore({ home, keystore });
    const jobs = first.services.domain!.jobs;
    jobs.enqueue({ type: 'conversation_summary', conversationId: 'conv_x', payload: { targetSeq: 1 }, priority: 2 });
    const claimed = jobs.claimNext();
    expect(claimed?.status).toBe('running');
    await first.close();

    const second = await createTestCore({ home, keystore });
    try {
      const rows = second.services.mainDb!.prepare('select status from jobs').all() as Array<{
        status: string;
      }>;
      expect(rows[0]?.status).toBe('pending');
    } finally {
      await second.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('delete conversation cascade', () => {
  it('removes messages, attachments files, runs and drafts; the next open gets a new id', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('完成')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    // Draft + attachment still queued, plus a completed run with messages.
    await core.rpc.call('attachments.upload', {
      conversationId: conv.id,
      fileName: 'notes.txt',
      mime: 'text/plain',
      bytesBase64: Buffer.from('附件内容').toString('base64'),
    });
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '待发送草稿' });
    await sendBatch(core, conv.id, ['历史消息']);
    await waitForRun(core, conv.id, 'completed');

    const attachmentDir = path.join(core.services.paths.home, 'conversations', conv.id);
    expect(existsSync(attachmentDir)).toBe(true);

    await core.rpc.call('conversations.delete', { id: conv.id });

    // Everything scoped to the conversation is gone.
    expect(core.services.mainDb!.prepare('select count(*) as n from messages where conversation_id = ?').get(conv.id)).toEqual({ n: 0 });
    expect(core.services.mainDb!.prepare('select count(*) as n from drafts where conversation_id = ?').get(conv.id)).toEqual({ n: 0 });
    expect(core.services.mainDb!.prepare('select count(*) as n from attachments where conversation_id = ?').get(conv.id)).toEqual({ n: 0 });
    expect(core.services.mainDb!.prepare('select count(*) as n from conversations where id = ?').get(conv.id)).toEqual({ n: 0 });
    expect(core.services.runsDb!.prepare('select count(*) as n from runs where conversation_id = ?').get(conv.id)).toEqual({ n: 0 });
    expect(existsSync(attachmentDir)).toBe(false);

    // Reopening opens a NEW conversation instance (ids never reused).
    const reopened = await openDirect(core, bot.id);
    expect(reopened.id).not.toBe(conv.id);
    const messages = await listMessages(core, reopened.id);
    expect(messages).toHaveLength(0);
    void llm;
  });

  it('cancels a running execution before deleting', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().hold().replyText('挂着')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    await sendBatch(core, conv.id, ['删除我']);
    await waitForRun(core, conv.id, 'running');
    await waitFor(() => (llm.requests().length >= 1 ? true : null), { label: 'request' });

    await core.rpc.call('conversations.delete', { id: conv.id });
    const runs = await listRuns(core, conv.id);
    expect(runs).toHaveLength(0); // rows deleted with the conversation
    llm.releaseAll();
  }, 20_000);
});

describe('delete bot cascade', () => {
  it('keeps history as read-only, removes runs and the bot directory, never reuses ids', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('在的')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    await sendBatch(core, conv.id, ['你好']);
    await waitForRun(core, conv.id, 'completed');
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '未发出的草稿' });

    // Simulate bot data on disk (workspace etc. arrives in later phases).
    const botDir = path.join(core.services.paths.home, 'bots', bot.id);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(path.join(botDir, 'keep.txt'), 'data');

    const preview = (await core.rpc.call('bots.deletionPreview', { id: bot.id })) as {
      conversations: number;
      messages: number;
    };
    expect(preview.conversations).toBe(1);
    expect(preview.messages).toBe(1);

    await core.rpc.call('bots.delete', { id: bot.id });

    // Address book no longer lists the bot; the row survives as a placeholder.
    const bots = (await core.rpc.call('bots.list')) as { bots: Array<{ id: string }> };
    expect(bots.bots).toHaveLength(0);
    const row = core.services.mainDb!.prepare('select status, name, profile_json from bots where id = ?').get(bot.id) as {
      status: string;
      name: string;
      profile_json: string;
    };
    expect(row.status).toBe('deleted');
    expect(row.name).toBe('');
    expect(row.profile_json).toBe('{}');

    // The direct conversation is read-only with a cleared queue.
    const conversation = (await core.rpc.call('conversations.get', { id: conv.id })) as {
      conversation: { readOnly: boolean } | null;
    };
    expect(conversation.conversation?.readOnly).toBe(true);
    const drafts = (await core.rpc.call('drafts.list', { conversationId: conv.id })) as {
      drafts: unknown[];
    };
    expect(drafts.drafts).toHaveLength(0);

    // Flushing into a read-only conversation is rejected.
    await expect(core.rpc.call('drafts.add', { conversationId: conv.id, text: 'x' })).resolves.toBeTruthy();
    await expect(core.rpc.call('drafts.flush', { conversationId: conv.id })).rejects.toMatchObject({
      code: 'CONVERSATION_READ_ONLY',
    });

    // Runs of the bot are gone; messages stay; directory removed.
    expect(core.services.runsDb!.prepare('select count(*) as n from runs where bot_id = ?').get(bot.id)).toEqual({ n: 0 });
    const messages = await listMessages(core, conv.id);
    expect(messages.length).toBeGreaterThan(0);
    expect(existsSync(botDir)).toBe(false);

    // A new bot with the same name is a fresh id (no reuse).
    const newBot = await makeBot(core, '小艾');
    expect(newBot.id).not.toBe(bot.id);
    void llm;
  });
});

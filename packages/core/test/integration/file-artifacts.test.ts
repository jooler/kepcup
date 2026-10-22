import { Buffer } from 'node:buffer';
import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import {
  createTestStack,
  isTaskRequest,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

/**
 * A write task's files end up as artifacts on the reply that relays its
 * result, so the conversation can render file cards under the bubble.
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

const isWake = (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes('<trigger reason="task"');

function textOf(message: Message): string {
  return 'text' in message.content ? message.content.text : '';
}

describe('Bot file artifacts', () => {
  it('attaches the files written by a task to the bot reply that reports it', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '写手');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().inTurn().replyToolCall('start_task', {
        title: '写一个文件',
        instruction: '在工作区写 notes/hello.md',
        source_message_ids: [],
        writes: true,
      }),
      step().inTurn().replyText('ACK 我去写'),
      step().inTask().replyTextAndToolCall('PROGRESS 开始写入', 'write', {
        path: 'notes/hello.md',
        content: '# hello\n',
      }),
      step().inTask().replyText('DONE notes/hello.md'),
      step().inTurn().expect(isWake).replyText('写好了，文件在下面。'),
    ]);

    await sendBatch(core, conv.id, ['帮我写个说明']);
    await waitFor(
      async () =>
        (await listMessages(core, conv.id)).find((m) => textOf(m).includes('写好了')) ?? null,
      { label: 'final reply with artifacts', timeoutMs: 20_000 },
    );
    const reply = (await listMessages(core, conv.id)).find((m) => textOf(m).includes('写好了'))!;
    expect('artifacts' in reply.content).toBe(true);
    const artifacts = 'artifacts' in reply.content ? (reply.content.artifacts ?? []) : [];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ name: 'hello.md', change: 'created', size: 8 });
    expect(artifacts[0]!.path.endsWith('/notes/hello.md')).toBe(true);

    const preview = (await core.rpc.call('files.preview', {
      conversationId: conv.id,
      path: artifacts[0]!.path,
    })) as { dataBase64: string; mime: string; name: string };
    expect(preview).toMatchObject({ name: 'hello.md', mime: 'text/markdown' });
    expect(Buffer.from(preview.dataBase64, 'base64').toString('utf8')).toBe('# hello\n');

    await expect(
      core.rpc.call('files.preview', { conversationId: conv.id, path: '/etc/hosts' }),
    ).rejects.toMatchObject({ code: 'PATH_OUT_OF_SCOPE' });

    // A symlink surfaced in the card still resolves outside the conversation's
    // artifact path: the canonical target no longer matches the stored path.
    const link = path.join(core.services.paths.home, 'link-to-hosts');
    symlinkSync('/etc/hosts', link);
    core.services.domain!.messages.append({
      conversationId: conv.id,
      senderType: 'bot',
      senderBotId: bot.id,
      kind: 'text',
      text: '一个链接',
      artifacts: [{ path: link, name: 'link-to-hosts', change: 'created' }],
    });
    await expect(
      core.rpc.call('files.preview', { conversationId: conv.id, path: link }),
    ).rejects.toMatchObject({ code: 'PATH_OUT_OF_SCOPE' });
  });
});

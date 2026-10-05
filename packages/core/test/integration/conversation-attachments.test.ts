import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listDrafts,
  listMessages,
  makeBot,
  openDirect,
} from '@kepcup/testkit';

/**
 * 对话附件链路（docs/design/20-conversation-media.md，D61）：上传预挂 →
 * drafts.add 绑定（归属校验）→ 草稿展示（draft.attachments）→ detach 移除 →
 * flush 转正（message.attachments）→ 草稿删除级联清理。
 */

let stack: Awaited<ReturnType<typeof createTestStack>>;
let conv: Awaited<ReturnType<typeof openDirect>>;

async function upload(
  fileName: string,
  mime = 'image/png',
  bytes = 'aGVsbG8=',
): Promise<{ id: string }> {
  const result = (await stack.core.rpc.call('attachments.upload', {
    conversationId: conv.id,
    fileName,
    mime,
    bytesBase64: bytes,
  })) as { attachment: { id: string } };
  return result.attachment;
}

beforeAll(async () => {
  stack = await createTestStack();
  const bot = await makeBot(stack.core, '附件甲');
  conv = await openDirect(stack.core, bot.id);
});

afterAll(async () => {
  await stack.cleanup();
});

describe('drafts.add 绑定附件', () => {
  it('attachmentIds 预挂 → draft.attachments 可见 → flush 转正到 message.attachments', async () => {
    const att = await upload('photo.png');
    await stack.core.rpc.call('drafts.add', {
      conversationId: conv.id,
      text: '',
      attachmentIds: [att.id],
    });
    const drafts = await listDrafts(stack.core, conv.id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.attachments.map((a) => a.id)).toEqual([att.id]);

    const flushed = (await stack.core.rpc.call('drafts.flush', {
      conversationId: conv.id,
    })) as {
      messages: Array<{
        id: string;
        attachments: Array<{ id: string }>;
        content: { text?: string };
      }>;
    };
    expect(flushed.messages).toHaveLength(1);
    expect(flushed.messages[0]!.attachments.map((a) => a.id)).toEqual([att.id]);
    expect(flushed.messages[0]!.content.text ?? '').toBe('');

    const messages = await listMessages(stack.core, conv.id);
    const withAttachment = messages.find((m) => m.attachments.length > 0);
    expect(withAttachment).toBeDefined();
  });

  it('附件归属校验：他人对话的附件 / 已占用附件 → INVALID_INPUT', async () => {
    const otherBot = await makeBot(stack.core, '附件乙');
    const otherConv = await openDirect(stack.core, otherBot.id);
    const foreign = (await stack.core.rpc.call('attachments.upload', {
      conversationId: otherConv.id,
      fileName: 'x.png',
      mime: 'image/png',
      bytesBase64: 'aGVsbG8=',
    })) as { attachment: { id: string } };

    await expect(
      stack.core.rpc.call('drafts.add', {
        conversationId: conv.id,
        text: '拿别人的附件',
        attachmentIds: [foreign.attachment.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const mine = await upload('mine.png');
    await stack.core.rpc.call('drafts.add', {
      conversationId: conv.id,
      text: '先占用',
      attachmentIds: [mine.id],
    });
    await expect(
      stack.core.rpc.call('drafts.add', {
        conversationId: conv.id,
        text: '再次占用同一附件',
        attachmentIds: [mine.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('attachments.detach 与草稿删除级联', () => {
  it('detach：草稿阶段可移除（draft.changed 后附件消失）；重复移除 NOT_FOUND', async () => {
    const att = await upload('temp.txt', 'text/plain');
    await stack.core.rpc.call('drafts.add', {
      conversationId: conv.id,
      text: '带附件草稿',
      attachmentIds: [att.id],
    });
    await stack.core.rpc.call('attachments.detach', { id: att.id });
    const drafts = await listDrafts(stack.core, conv.id);
    const draft = drafts.find((d) => d.text === '带附件草稿');
    expect(draft!.attachments).toHaveLength(0);
    await expect(stack.core.rpc.call('attachments.get', { id: att.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('已随消息发出的附件不可 detach', async () => {
    const att = await upload('sent.png');
    await stack.core.rpc.call('drafts.add', {
      conversationId: conv.id,
      text: '已发送附件',
      attachmentIds: [att.id],
    });
    await stack.core.rpc.call('drafts.flush', { conversationId: conv.id });
    await expect(stack.core.rpc.call('attachments.detach', { id: att.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('drafts.remove 级联清理草稿附件（行删除）', async () => {
    const att = await upload('doomed.png');
    await stack.core.rpc.call('drafts.add', {
      conversationId: conv.id,
      text: '要删的草稿',
      attachmentIds: [att.id],
    });
    const drafts = await listDrafts(stack.core, conv.id);
    const draft = drafts.find((d) => d.text === '要删的草稿')!;
    await stack.core.rpc.call('drafts.remove', { id: draft.id });
    await expect(stack.core.rpc.call('attachments.get', { id: att.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

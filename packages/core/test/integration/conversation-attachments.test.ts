import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
} from '@kepcup/testkit';

/**
 * 对话附件链路（docs/design/20-conversation-media.md，D61）：上传（无主）→
 * messages.send 携 attachmentIds 转正（归属校验）→ message.attachments；
 * detach 只能移除未随消息发出的上传。
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

describe('messages.send 携附件', () => {
  it('attachmentIds 转正到 message.attachments；空文本 + 纯附件允许', async () => {
    const att = await upload('photo.png');
    const sent = (await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '',
      attachmentIds: [att.id],
    })) as {
      message: {
        id: string;
        attachments: Array<{ id: string }>;
        content: { text?: string };
      };
    };
    expect(sent.message.attachments.map((a) => a.id)).toEqual([att.id]);
    expect(sent.message.content.text ?? '').toBe('');

    const messages = await listMessages(stack.core, conv.id);
    const withAttachment = messages.find((m) => m.attachments.length > 0);
    expect(withAttachment).toBeDefined();
  });

  it('空文本 + 无附件 → INVALID_INPUT', async () => {
    await expect(
      stack.core.rpc.call('messages.send', { conversationId: conv.id, text: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
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
      stack.core.rpc.call('messages.send', {
        conversationId: conv.id,
        text: '拿别人的附件',
        attachmentIds: [foreign.attachment.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const mine = await upload('mine.png');
    await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '先占用',
      attachmentIds: [mine.id],
    });
    await expect(
      stack.core.rpc.call('messages.send', {
        conversationId: conv.id,
        text: '再次占用同一附件',
        attachmentIds: [mine.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('attachments.detach（仅未发送的上传可移除）', () => {
  it('detach：上传后未发送可移除；重复移除 NOT_FOUND', async () => {
    const att = await upload('temp.txt', 'text/plain');
    await stack.core.rpc.call('attachments.detach', { id: att.id });
    await expect(stack.core.rpc.call('attachments.get', { id: att.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('已随消息发出的附件不可 detach', async () => {
    const att = await upload('sent.png');
    await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '已发送附件',
      attachmentIds: [att.id],
    });
    await expect(stack.core.rpc.call('attachments.detach', { id: att.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('attachments.status（草稿 chip 存在性批量查询）', () => {
  it('一次往返区分 pending / sent / missing；换个对话查同一 id 算 missing', async () => {
    const pending = await upload('p.pdf', 'application/pdf');
    const sentAtt = await upload('s.png');
    await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '发出去',
      attachmentIds: [sentAtt.id],
    });
    const result = (await stack.core.rpc.call('attachments.status', {
      conversationId: conv.id,
      ids: [pending.id, sentAtt.id, 'att_does_not_exist'],
    })) as { statuses: Array<{ id: string; state: string }> };
    expect(result.statuses).toEqual([
      { id: pending.id, state: 'pending' },
      { id: sentAtt.id, state: 'sent' },
      { id: 'att_does_not_exist', state: 'missing' },
    ]);

    const other = await openDirect(stack.core, (await makeBot(stack.core, '附件乙')).id);
    const foreign = (await stack.core.rpc.call('attachments.status', {
      conversationId: other.id,
      ids: [pending.id],
    })) as { statuses: Array<{ id: string; state: string }> };
    expect(foreign.statuses).toEqual([{ id: pending.id, state: 'missing' }]);
  });
});

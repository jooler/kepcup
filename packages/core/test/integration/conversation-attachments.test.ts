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

describe('messages.send voiceMode（53 号修订 v2 V2-1）', () => {
  it('voiceMode: true → content.origin 记 voice（Bot 收到纯文本语义）', async () => {
    const sent = (await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '明天有什么安排',
      voiceMode: true,
    })) as { message: { content: { text?: string; origin?: string } } };
    expect(sent.message.content).toMatchObject({ text: '明天有什么安排', origin: 'voice' });

    const messages = await listMessages(stack.core, conv.id);
    const voice = messages.find((m) => m.content.origin === 'voice');
    expect(voice).toBeDefined();
  });

  it('不带 voiceMode → content.origin 不记 voice（文字直发不变）', async () => {
    const sent = (await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '普通文字',
    })) as { message: { content: { text?: string; origin?: string } } };
    expect(sent.message.content).toMatchObject({ text: '普通文字' });
    expect(sent.message.content.origin).toBeUndefined();
  });

  it('voiceMode: true + 空文本（转写失败兜底）+ 附件 → origin 仍记 voice', async () => {
    // 空文本需带附件（空文本 + 无附件是 INVALID_INPUT）：渲染层转写失败分支
    // 正是「空文本 + 附件照发」。origin 照记（事实），只有 core 上下文标注按
    // 正文非空条件生效（见 conversation.ts），Bot 侧 transcribe_audio 兜底不受阻。
    const att = await upload('voice-fail.wav', 'audio/wav');
    const sent = (await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '',
      voiceMode: true,
      attachmentIds: [att.id],
    })) as { message: { content: { text?: string; origin?: string } } };
    expect(sent.message.content).toMatchObject({ text: '', origin: 'voice' });
  });

  it('显式 voiceMode: false → content.origin 不记 voice（仅 === true 才记）', async () => {
    const sent = (await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '显式关闭',
      voiceMode: false,
    })) as { message: { content: { text?: string; origin?: string } } };
    expect(sent.message.content).toMatchObject({ text: '显式关闭' });
    expect(sent.message.content.origin).toBeUndefined();
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

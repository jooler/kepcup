import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type Bot, type Message } from '@kepcup/shared';
import { createMemoryKeystore } from '@kepcup/core';
import { createTestStack, listMessages, makeBot, type TestStack } from '@kepcup/testkit';
import { BUTLER_WELCOME_TEXT } from '../../src/domain/butler.js';

/**
 * 管家（D70，docs/design/27-butler-and-delegation.md）P1 地基：唯一、置顶、
 * 不可删；存量用户启动时补建（不访谈）。
 */

const stacks: TestStack[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

interface EnsureResult {
  bot: Bot;
  conversationId: string;
  created: boolean;
}

function activeButlers(stack: TestStack): Bot[] {
  return stack.core.services.domain!.bots.listActive().filter((b) => b.systemRole === 'butler');
}

describe('butler (D70) foundation', () => {
  it('butler.ensure 幂等：恰好一个管家 + 一个私聊；不能再建第二个', async () => {
    const stack = await start();
    const first = (await stack.core.rpc.call('butler.ensure', {})) as EnsureResult;
    expect(first.created).toBe(true);
    expect(first.bot.systemRole).toBe('butler');
    expect(first.bot.name).toBe('管家');
    expect(first.bot.setupState ?? null).toBeNull();

    const second = (await stack.core.rpc.call('butler.ensure', {})) as EnsureResult;
    expect(second.created).toBe(false);
    expect(second.bot.id).toBe(first.bot.id);
    expect(second.conversationId).toBe(first.conversationId);
    expect(activeButlers(stack)).toHaveLength(1);

    const bots = stack.core.services.domain!.bots;
    expect(() => bots.create({ identity: { name: '另一个管家' } }, { systemRole: 'butler' })).toThrow(
      AppError,
    );
    expect(activeButlers(stack)).toHaveLength(1);

    // 普通 Bot 不受影响，也不是管家。
    const plain = await makeBot(stack.core, '小艾');
    expect(plain.systemRole ?? null).toBeNull();

    // 存量用户的管家（无 interview）只有一条确定性欢迎语，没有访谈卡。
    const messages = await listMessages(stack.core, first.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderType: 'bot', senderBotId: first.bot.id });
    expect((messages[0]!.content as { text: string }).text).toBe(BUTLER_WELCOME_TEXT);
  });

  it('删除管家被拒绝（BOT_UNDELETABLE），管家与私聊原样保留', async () => {
    const stack = await start();
    const { bot, conversationId } = (await stack.core.rpc.call('butler.ensure', {})) as EnsureResult;
    await expect(stack.core.rpc.call('bots.delete', { id: bot.id })).rejects.toMatchObject({
      code: 'BOT_UNDELETABLE',
    });
    const after = stack.core.services.domain!.bots.get(bot.id)!;
    expect(after.status).toBe('active');
    expect(stack.core.services.domain!.conversations.get(conversationId)!.readOnly).toBe(false);

    // 普通 Bot 删除仍按 D18。
    const plain = await makeBot(stack.core, '小艾');
    await stack.core.rpc.call('bots.delete', { id: plain.id });
    expect(stack.core.services.domain!.bots.get(plain.id)!.status).toBe('deleted');
  });

  it('管家私聊被删后 ensure 重开一个空私聊（置顶入口不消失），不重复欢迎', async () => {
    const stack = await start();
    const first = (await stack.core.rpc.call('butler.ensure', {})) as EnsureResult;
    await stack.core.rpc.call('conversations.delete', { id: first.conversationId });
    const again = (await stack.core.rpc.call('butler.ensure', {})) as EnsureResult;
    expect(again.bot.id).toBe(first.bot.id);
    expect(again.conversationId).not.toBe(first.conversationId);
    expect(await listMessages(stack.core, again.conversationId)).toEqual([] as Message[]);
  });

  it('存量用户：已完成引导的库重启后自动补建管家；未完成引导的库不建', async () => {
    const keystore = createMemoryKeystore();
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-butler-'));
    homes.push(home);

    const first = await createTestStack({ home, keystore });
    stacks.push(first);
    expect(activeButlers(first)).toHaveLength(0);
    await makeBot(first.core, '老 Bot');
    await first.core.rpc.call('settings.update', { onboarding: { completed: true } });
    await first.cleanup();
    stacks.pop();

    const second = await createTestStack({ home, keystore });
    stacks.push(second);
    const butlers = activeButlers(second);
    expect(butlers).toHaveLength(1);
    expect(butlers[0]!.setupState ?? null).toBeNull();
    await second.cleanup();
    stacks.pop();

    // 再次重启不重复建。
    const third = await createTestStack({ home, keystore });
    stacks.push(third);
    expect(activeButlers(third)).toHaveLength(1);

    // 未完成引导的新库：不建。
    const fresh = await start();
    expect(activeButlers(fresh)).toHaveLength(0);
  });
});

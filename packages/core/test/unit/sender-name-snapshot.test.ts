import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';

/**
 * 62.11 C4（T6 审查修复，D18「历史保留、名称可辨」）：用户消息发送时经 C2
 * 主体目录把发送人显示名快照进 `messages.sender_name`——成员禁用 / 删除后
 * 消息仍显示发送时的名字。修复点在 orchestrator 的主体清洗（`#cleanPrincipal`），
 * `messages.send` / 草稿发送 / 工作台派发共用。
 *
 * 休眠铁律：无目录（单用户缺省）= 快照 null = 现状；有目录但 describe 不到
 * （未知主体）= null；目录返回空名 = null（不冒充有名字）。
 */

const PR_A = 'pr_AAA';
const NAME_A = '张三';

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(principals?: { describe(id: string): { name: string } | null }): Promise<{
  stack: TestStack;
  core: CoreHarness;
  botId: string;
  conversationId: string;
}> {
  const stack = await createTestStack(
    principals === undefined ? {} : { principals: principals as never },
  );
  stacks.push(stack);
  const core = stack.core;
  const bot = await makeBot(core, '快照对象');
  const conversation = core.services.domain!.conversations.openDirect(bot.id, {
    ownerPrincipalId: PR_A,
  }).conversation;
  return { stack, core, botId: bot.id, conversationId: conversation.id };
}

async function sendAs(
  core: CoreHarness,
  conversationId: string,
  principalId: string | undefined,
): Promise<Message> {
  const send = () =>
    core.services.appMethods['messages.send']!.handle({ conversationId, text: `来自 ${principalId}` });
  const sent = (await (principalId === undefined ? send() : withCaller({ principalId }, send))) as {
    message: Message;
  };
  return sent.message;
}

describe('sender_name 快照（62.11 C4，T6 修复）', () => {
  it('有目录：发送时经 describe 落显示名快照；消息行与库行一致', async () => {
    const { core, conversationId } = await start({
      describe: (id) => (id === PR_A ? { name: NAME_A } : null),
    });
    const message = await sendAs(core, conversationId, PR_A);
    expect(message.senderPrincipalId).toBe(PR_A);
    expect(message.senderName).toBe(NAME_A);
    const row = core.services.mainDb!
      .prepare('select sender_name from messages where id = ?')
      .get(message.id) as { sender_name: string | null };
    expect(row.sender_name).toBe(NAME_A);
    // messages.list 读出的形状同样带快照。
    const listed = (await withCaller({ principalId: PR_A }, () =>
      core.services.appMethods['messages.list']!.handle({ conversationId, limit: 5 }),
    )) as { messages: Message[] };
    expect(listed.messages.at(-1)?.senderName).toBe(NAME_A);
  });

  it('有目录但 describe 不到 / 空名：快照 null（不冒充有名字）', async () => {
    const { core, botId, conversationId } = await start({
      describe: (id) => (id === 'pr_ghost' ? null : { name: '' }),
    });
    // 未知主体（目录 describe 不到）用它自己的直聊发（资格过、快照 null）。
    const ghostDirect = core.services.domain!.conversations.openDirect(botId, {
      ownerPrincipalId: 'pr_ghost',
    }).conversation;
    const ghost = await sendAs(core, ghostDirect.id, 'pr_ghost');
    expect(ghost.senderPrincipalId).toBe('pr_ghost');
    expect((ghost.senderName ?? null)).toBeNull();
    const blank = await sendAs(core, conversationId, PR_A); // 目录返回空名
    expect((blank.senderName ?? null)).toBeNull();
  });

  it('无目录（单用户缺省）：调用者在但快照 null = 现状', async () => {
    const { core, conversationId } = await start();
    const message = await sendAs(core, conversationId, PR_A);
    expect(message.senderPrincipalId).toBe(PR_A);
    expect((message.senderName ?? null)).toBeNull();
    const row = core.services.mainDb!
      .prepare('select sender_name from messages where id = ?')
      .get(message.id) as { sender_name: string | null };
    expect(row.sender_name).toBeNull();
  });
});

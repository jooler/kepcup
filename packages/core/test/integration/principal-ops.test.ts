import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTestStack,
  makeBot,
  makeProject,
  step,
  waitForEvent,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import type { MockChatRequest } from '@kepcup/testkit';
import { withCaller, type CoreHarness } from '@kepcup/core';

/**
 * C1/C4：RPC 客户端跨 MessagePort 不带 AsyncLocalStorage，主体发送按 T1 的
 * 口径直接在 `withCaller` 里分发 `services.appMethods`（同
 * collab-drafts-principal.test.ts 的 harness）。
 */
async function callAs(
  core: CoreHarness,
  method: string,
  input: Record<string, unknown>,
  principalId?: string,
): Promise<unknown> {
  const spec = core.services.appMethods[method];
  if (spec === undefined) throw new Error(`method not bound: ${method}`);
  const parsed = spec.input.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid input for ${method}`);
  const task = async () => spec.output.parse(await spec.handle(parsed.data));
  return principalId === undefined ? task() : withCaller({ principalId }, task);
}

/**
 * 62.11 C15 宿主写入口（CoreServices.principalOps，进程内 domain API）：加人 /
 * 离开 / 改角色落名册并发可见系统消息；openDm 复用 T1；appendSystemMessage /
 * appendCard / updateCard / wakeBot / provisionWorkdir 各就各位。不调用 = 无
 * 任何副作用（单用户宿主不会触碰这个门面）。
 */

let stack: TestStack;
let botA: string;
let botB: string;
let root: string;

beforeAll(async () => {
  root = realpathSync(await mkdtemp(path.join(tmpdir(), 'kepcup-ops-')));
  stack = await createTestStack({ workdirRoots: [root] });
  botA = (await makeBot(stack.core, '阿甲')).id;
  botB = (await makeBot(stack.core, '阿乙')).id;
});

afterAll(async () => {
  await stack.cleanup();
  await rm(root, { recursive: true, force: true });
});

describe('62.11 C15 principalOps：名册（join / setRole / leave / list / hasPrincipal）', () => {
  it('join 落名册、发「已加入」系统消息并广播 conversation.updated', async () => {
    const project = await makeProject(stack.core, '写入项目', [botA, botB]);
    const ops = stack.core.services.principalOps!;
    const updated = waitForEvent<{ conversation: { id: string } }>(
      stack.core,
      'conversation.updated',
      (payload) => payload.conversation.id === project.id,
    );

    ops.join(project.id, 'mbr_1', 'member');

    const roster = ops.list(project.id);
    expect(roster.map((p) => p.principalId)).toEqual(['mbr_1']);
    expect(ops.hasPrincipal(project.id, 'mbr_1')).toBe(true);
    await updated;
    const messages = (await stack.core.rpc.call('messages.list', {
      conversationId: project.id,
      limit: 50,
    })) as { messages: Array<{ kind: string; content?: { text?: string } }> };
    const join = messages.messages.find((m) => m.content?.text === 'mbr_1 已加入');
    expect(join).toBeDefined();
  });

  it('重复 join 报错；setRole 改角色；leave 写 left_at 并发「已离开」', async () => {
    const project = await makeProject(stack.core, '写入项目二', [botA, botB]);
    const ops = stack.core.services.principalOps!;
    ops.join(project.id, 'mbr_2', 'member');
    ops.join(project.id, 'mbr_3', 'lead');
    expect(() => ops.join(project.id, 'mbr_2', 'member')).toThrowError();
    expect(ops.list(project.id).find((p) => p.principalId === 'mbr_3')?.role).toBe('lead');

    ops.setRole(project.id, 'mbr_2', 'lead');
    expect(ops.list(project.id).find((p) => p.principalId === 'mbr_2')?.role).toBe('lead');
    expect(() => ops.setRole(project.id, 'mbr_9', 'member')).toThrowError();

    const updated = waitForEvent<{ conversation: { id: string } }>(
      stack.core,
      'conversation.updated',
      (payload) => payload.conversation.id === project.id,
    );
    ops.leave(project.id, 'mbr_3');
    await updated;
    expect(ops.hasPrincipal(project.id, 'mbr_3')).toBe(false);
    // 名册行保留（left_at 落痕），重新 join 复活同一行。
    ops.join(project.id, 'mbr_3', 'member');
    expect(ops.hasPrincipal(project.id, 'mbr_3')).toBe(true);
    const messages = (await stack.core.rpc.call('messages.list', {
      conversationId: project.id,
      limit: 50,
    })) as { messages: Array<{ content?: { text?: string } }> };
    expect(messages.messages.find((m) => m.content?.text === 'mbr_3 已离开')).toBeDefined();
    expect(messages.messages.filter((m) => m.content?.text === 'mbr_3 已加入').length).toBe(2);
  });

  it('直聊不能进名册（INVALID_INPUT）', async () => {
    const direct = (await stack.core.rpc.call('conversations.openDirect', {
      botId: botA,
    })) as { conversation: { id: string } };
    const ops = stack.core.services.principalOps!;
    expect(() => ops.join(direct.conversation.id, 'mbr_1', 'member')).toThrowError();
  });
});

describe('62.11 C15 principalOps：dm / 系统消息 / 卡片 / 唤醒 / workdir', () => {
  it('openDm 复用 T1（重复打开同一组 = 同一会话）', () => {
    const ops = stack.core.services.principalOps!;
    const first = ops.openDm(['mbr_1', 'mbr_2']);
    expect(first.created).toBe(true);
    const second = ops.openDm(['mbr_2', 'mbr_1']);
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.created).toBe(false);
  });

  it('appendSystemMessage 落一条用户可见的系统消息', async () => {
    const project = await makeProject(stack.core, '系统消息项目', [botA, botB]);
    const message = stack.core.services.principalOps!.appendSystemMessage(
      project.id,
      '宿主通知：今晚维护。',
    );
    const list = (await stack.core.rpc.call('messages.list', {
      conversationId: project.id,
      limit: 50,
    })) as { messages: Array<{ id: string; content?: { text?: string } }> };
    expect(list.messages.find((m) => m.id === message.id)?.content?.text).toBe('宿主通知：今晚维护。');
  });

  it('appendCard + updateCard：卡片消息可被宿主改写并广播 message.updated', async () => {
    const project = await makeProject(stack.core, '卡片项目', [botA, botB]);
    const ops = stack.core.services.principalOps!;
    const updated = waitForEvent(stack.core, 'message.updated', (payload: { message: { id: string } }) =>
      payload.message.id !== '',
    );
    const card = ops.appendCard(project.id, {
      cardType: 'resolution',
      text: '决议：采用方案 A',
      data: { state: 'open', summary: '采用方案 A' },
    });
    const patched = ops.updateCard(card.id, { data: { state: 'approved', summary: '采用方案 A' } });
    await updated;
    const list = (await stack.core.rpc.call('messages.list', {
      conversationId: project.id,
      limit: 50,
    })) as { messages: Array<{ id: string; kind: string; content?: Record<string, unknown> }> };
    const row = list.messages.find((m) => m.id === card.id);
    expect(row?.kind).toBe('card');
    const content = row?.content as {
      cardType?: string;
      hostCard?: { text?: string; data: Record<string, unknown> };
    };
    expect(content.cardType).toBe('resolution');
    expect(content.hostCard?.text).toBe('决议：采用方案 A');
    const patchedContent = patched.content as { hostCard?: { data: Record<string, unknown> } };
    expect(patchedContent.hostCard?.data).toEqual({ state: 'approved', summary: '采用方案 A' });
    // 只有宿主卡片（带 data 字段）能被 updateCard 改写。
    expect(() => ops.updateCard('msg_nonexistent', { text: 'x' })).toThrowError();
  });

  it('wakeBot 以系统事件触发在册 Bot（保留免打扰语义的公开入口）', async () => {
    const project = await makeProject(stack.core, '唤醒项目', [botA, botB]);
    const ops = stack.core.services.principalOps!;
    ops.wakeBot(project.id, botA, '决议已通过，请开始执行。');
    const messages = (await stack.core.rpc.call('messages.list', {
      conversationId: project.id,
      limit: 50,
    })) as { messages: Array<{ kind: string; content?: { text?: string } }> };
    expect(
      messages.messages.find(
        (m) => m.kind === 'system_event' && m.content?.text === '决议已通过，请开始执行。',
      ),
    ).toBeDefined();
  });

  it('provisionWorkdir 在 roots[0] 建目录并绑定到会话', async () => {
    const project = await makeProject(stack.core, '目录项目', [botA, botB]);
    const ops = stack.core.services.principalOps!;
    const workdir = ops.provisionWorkdir(project.id, '报表 项目!');
    expect(workdir.path.startsWith(root)).toBe(true);
    expect(path.basename(workdir.path)).toMatch(/^报表-项目/);
    const bound = stack.core.services.domain!.conversations.get(project.id);
    expect(bound?.workdirId).toBe(workdir.id);
  });
});


describe('62.11 C2 接线：注入目录后的运行时渲染（直聊 owner 主体）', () => {
  it('<user_identity> / 发言人标签出现，主体化的画像 / 记忆注入不破运行', async () => {
    const stack = await createTestStack({
      principals: { describe: (id) => (id === 'mbr_9' ? { name: '王五', note: '研发' } : null) },
    });
    try {
      const bot = await makeBot(stack.core, '标签乙');
      // owner 主体直聊（C3：runs.principal_id = 会话 owner）。
      const { conversation } = stack.core.services.domain!.conversations.openDirect(bot.id, {
        ownerPrincipalId: 'mbr_9',
      });
      stack.llm.script('mock-main', [step().inTurn().replyText('好的。')]);
      await callAs(stack.core, 'messages.send', { conversationId: conversation.id, text: '你好' }, 'mbr_9');
      await waitForRun(stack.core, conversation.id, 'completed');

      const request: MockChatRequest = stack.llm.requestsFor('mock-main')[0]!;
      const system = JSON.stringify(request.body.messages ?? []);
      // <user_identity>（62.05 §4）：直聊 = 「当前与你对话的是 王五；研发」。
      expect(system).toContain('当前与你对话的是 王五；研发');
      // 触发批的用户行经 #renderOptions.describePrincipal 出显示名。
      expect(request.lastUserText()).toContain('王五');
      // 运行正常完成（主体化 memorySections 调用没有打断 run）。
      const run = await waitForRun(stack.core, conversation.id, 'completed');
      expect(run.status).toBe('completed');
    } finally {
      await stack.cleanup();
    }
  }, 30_000);
});

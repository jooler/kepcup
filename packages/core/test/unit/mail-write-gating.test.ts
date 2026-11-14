import { beforeEach, describe, expect, it } from 'vitest';
import { buildMailTools } from '../../src/tools/mail-tools.js';
import type { MailService } from '../../src/mail/service.js';
import type { RunIdentity, ToolDefinition } from '../../src/agent/types.js';

/**
 * D144 邮箱内部写操作的门控语义（design 35「邮箱内部写操作」）：
 * - 对话轮（turn）放行——绑定邮箱即授权，可逆低风险，不出审批卡；
 * - 只读任务 / 只读父链子代理仍按只读规则拒绝（RUN_READ_ONLY）；
 * - 写任务放行；mail_send 保持对话轮拒绝不变。
 */

function identityOf(loopType: RunIdentity['loopType']): RunIdentity {
  return { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType };
}

function mailStub(calls: string[]): MailService {
  return {
    markMessages: async () => {
      calls.push('markMessages');
      return 'ok';
    },
    sendMessage: async () => {
      calls.push('sendMessage');
      return 'ok';
    },
    accountsForBot: () => [{ id: 'mal_1', label: '邮箱', address: 'me@example.com', pluginId: null }],
  } as unknown as MailService;
}

function toolsFor(
  loopType: RunIdentity['loopType'],
  writeDenial: (identity: RunIdentity) => string | null,
): ToolDefinition[] {
  return buildMailTools({
    identity: identityOf(loopType),
    mail: mailStub(calls),
    gateway: { writeDenial },
    bound: true,
    extraPluginIds: new Set<string>(),
  });
}

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
});

function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

describe('D144 mailbox write gating', () => {
  it('allows mark in a conversation turn even though the gateway would refuse workspace writes', async () => {
    const tools = toolsFor('turn', () => '对话轮是只读的，不能写工作区');
    const result = await toolOf(tools, 'mail_mark').execute({ uids: [1], seen: true } as never, {
      signal: new AbortController().signal,
    } as never);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['markMessages']);
  });

  it('refuses mark in a read-only task with RUN_READ_ONLY and never touches the service', async () => {
    const tools = toolsFor('task', () => '任务未申请写权限');
    const result = await toolOf(tools, 'mail_mark').execute({ uids: [1], seen: true } as never, {
      signal: new AbortController().signal,
    } as never);
    expect(result).toMatchObject({ ok: false, errorCode: 'RUN_READ_ONLY' });
    expect(calls).toEqual([]);
  });

  it('allows mark in a write task and refuses mail_send there without approval flow', async () => {
    const tools = toolsFor('task', () => null);
    const mark = await toolOf(tools, 'mail_mark').execute({ uids: [1], seen: true } as never, {
      signal: new AbortController().signal,
    } as never);
    expect(mark.ok).toBe(true);
    expect(calls).toEqual(['markMessages']);
    // mail_send 的拒绝发生在 service 的审批层；工具层这里只确认没有 readOnlyRefusal 拦它。
    // （真实审批由 MailService.sendMessage 的 requestApproval 触发，集成测试覆盖。）
    expect(toolOf(tools, 'mail_send')).toBeDefined();
  });

  it('refuses a read-only subagent whose parent chain denies writes', async () => {
    const tools = toolsFor('subagent', () => '父任务是只读的');
    const result = await toolOf(tools, 'mail_move').execute(
      { uids: [1], destination: 'Archive' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'RUN_READ_ONLY' });
    expect(calls).toEqual([]);
  });

  it('keeps mail_send refused in a conversation turn (unchanged behavior)', async () => {
    const tools = toolsFor('turn', () => '对话轮是只读的，不能写工作区');
    const result = await toolOf(tools, 'mail_send').execute(
      { to: ['a@example.com'], subject: 's', text: 'x' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'RUN_READ_ONLY' });
    expect(calls).toEqual([]);
  });
});

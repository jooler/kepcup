import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect, waitFor, type TestStack } from '@kepcup/testkit';
import type { Approval, ApprovalDuration, ApprovalKind } from '@kepcup/shared';

/**
 * D73 P1 §5.6：审批层——`decide()` 的时长降级表（'bot' 只对带 durations 的 mcp_tool 有效，
 * 'conversation' 对 mcp_tool 同样按 payload.durations 判定，grants / agent_tool 只见 once |
 * conversation）、`approvals.decide` RPC 入参、无人值守审计带风险与账号身份、上下文行。
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

const appPayload = (durations: ApprovalDuration[] | undefined, risk = 'write') => ({
  serverId: 'conn_gh',
  serverName: 'GitHub',
  toolName: 'create_issue',
  argsSummary: '{"title":"x"}',
  risk,
  connectionId: 'conn_gh',
  connectorSlug: 'github',
  accountLabel: 'jyy@example.com',
  ...(durations !== undefined ? { durations } : {}),
});

const agentToolPayload = (durations: string[]) => ({
  agentId: 'fake',
  agentName: 'Fake',
  title: 'edit',
  kind: 'write',
  toolKind: 'edit',
  access: 'write',
  locations: ['/tmp/x'],
  durations,
});

async function ask(
  stack: TestStack,
  kind: ApprovalKind,
  payload: Record<string, unknown>,
  choice: ApprovalDuration | undefined,
): Promise<Approval> {
  const bot = await makeBot(stack.core, `小审${Math.random().toString(36).slice(2, 6)}`);
  const conv = await openDirect(stack.core, bot.id);
  const approvals = stack.core.services.domain!.approvals;
  const identity = {
    runId: `run_${Math.random().toString(36).slice(2, 8)}`,
    botId: bot.id,
    conversationId: conv.id,
    loopType: 'task' as const,
  };
  const outcome = approvals.request(identity, kind, payload);
  const pending = await waitFor(
    async () => {
      const list = (await stack.core.rpc.call('approvals.list', { conversationId: conv.id })) as {
        approvals: Approval[];
      };
      return list.approvals.find((a) => a.status === 'pending') ?? null;
    },
    { label: 'pending approval' },
  );
  await stack.core.rpc.call('approvals.decide', {
    id: pending.id,
    approve: true,
    ...(choice !== undefined ? { duration: choice } : {}),
  });
  return (await outcome).approval;
}

describe('decide(): duration degradation table', () => {
  const all: ApprovalDuration[] = ['once', 'conversation', 'bot'];
  it.each<[string, ApprovalKind, Record<string, unknown>, ApprovalDuration, ApprovalDuration]>([
    // write app tool: the card offers all three → honoured as chosen
    ['app write, bot', 'mcp_tool', appPayload(all), 'bot', 'bot'],
    ['app write, conversation', 'mcp_tool', appPayload(all), 'conversation', 'conversation'],
    ['app write, once', 'mcp_tool', appPayload(all), 'once', 'once'],
    // destructive app tool: only once offered → anything wider degrades
    ['app destructive, bot', 'mcp_tool', appPayload(['once'], 'destructive'), 'bot', 'once'],
    [
      'app destructive, conversation',
      'mcp_tool',
      appPayload(['once'], 'destructive'),
      'conversation',
      'once',
    ],
    // plain MCP card / pre-D73 row (no durations) → once
    ['plain mcp, bot', 'mcp_tool', appPayload(undefined), 'bot', 'once'],
    ['plain mcp, conversation', 'mcp_tool', appPayload(undefined), 'conversation', 'once'],
    // conversation offered but not bot
    ['mcp conv-only, bot', 'mcp_tool', appPayload(['once', 'conversation']), 'bot', 'once'],
    // agent_tool: grant durations only (bot never exists there)
    [
      'agent_tool path, conversation',
      'agent_tool',
      agentToolPayload(['once', 'conversation']),
      'conversation',
      'conversation',
    ],
    [
      'agent_tool path, bot',
      'agent_tool',
      agentToolPayload(['once', 'conversation']),
      'bot',
      'once',
    ],
    [
      'agent_tool command, conversation',
      'agent_tool',
      agentToolPayload(['once']),
      'conversation',
      'once',
    ],
  ])('%s → %s', async (_label, kind, payload, chosen, expected) => {
    const stack = await start();
    const approval = await ask(stack, kind, payload, chosen);
    expect(approval.status).toBe('approved');
    expect(approval.decision).toEqual({ duration: expected });
  });

  it('an access card never sees bot: it degrades to once instead of failing', async () => {
    const stack = await start();
    const approval = await ask(
      stack,
      'access',
      { path: '/tmp/x', access: 'read', reason: 'r' },
      'bot',
    );
    expect(approval.decision).toEqual({ duration: 'once' });
  });

  it('the RPC rejects durations outside once | conversation | bot', async () => {
    const stack = await start();
    await expect(
      stack.core.rpc.call('approvals.decide', { id: 'apr_x', approve: true, duration: 'forever' }),
    ).rejects.toBeDefined();
  });
});

describe('unattended mode', () => {
  it('auto-approves every risk tier of an app tool; approval_auto audit carries risk + account identity', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '小控');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    const approvals = core.services.domain!.approvals;
    const identity = {
      runId: 'run_app_unattended',
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task' as const,
    };
    const outcomes = [];
    for (const risk of ['read', 'write', 'destructive'] as const) {
      outcomes.push(await approvals.request(identity, 'mcp_tool', appPayload(['once'], risk)));
    }
    expect(outcomes.map((o) => o.decision)).toEqual(['approved', 'approved', 'approved']);
    expect(outcomes.every((o) => o.approval.autoApproved === true)).toBe(true);
    const audit = core.services
      .domain!.audit.listByConversation(conv.id, 50)
      .filter((a) => a.action === 'approval_auto' && a.detail['kind'] === 'mcp_tool');
    expect(audit.map((a) => a.detail['risk']).sort()).toEqual(['destructive', 'read', 'write']);
    for (const entry of audit) {
      expect(entry.detail).toMatchObject({
        connectionId: 'conn_gh',
        connectorSlug: 'github',
        accountLabel: 'jyy@example.com',
        appName: 'GitHub',
        approved: true,
      });
    }
    // A plain MCP card's audit has no identity keys.
    const plainOutcome = await approvals.request(identity, 'mcp_tool', {
      serverId: 'srv',
      serverName: 'S',
      toolName: 't',
      argsSummary: '{}',
      risk: 'write',
    });
    const last = core.services
      .domain!.audit.listByConversation(conv.id, 50)
      .find(
        (a) => a.action === 'approval_auto' && a.detail['approvalId'] === plainOutcome.approval.id,
      )!;
    expect(last.detail).not.toHaveProperty('connectionId');
    // Unattended decisions never record a duration (no grant outlives the mode).
    expect(outcomes[1]!.approval.decision).toBeNull();
  });

  it('butler proposals still always wait for the user (NEVER_AUTO_DECIDED unchanged)', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '小管');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    const approvals = core.services.domain!.approvals;
    void approvals.request(
      { runId: 'run_b', botId: bot.id, conversationId: conv.id, loopType: 'task' },
      'butler_proposal',
      {
        proposalType: 'bot',
        bots: [{ name: 'x', bio: '', expertise: '', responsibilities: '', reason: '' }],
        note: '',
      },
    );
    const list = await waitFor(
      async () => {
        const result = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return result.approvals.find((a) => a.kind === 'butler_proposal') ?? null;
      },
      { label: 'butler card' },
    );
    expect(list.status).toBe('pending');
    expect(list.autoApproved).toBe(false);
  });
});

describe('context line', () => {
  it('names the account, app and tool, and the duration the user picked', async () => {
    const stack = await start();
    const approvals = stack.core.services.domain!.approvals;
    const approval = await ask(
      stack,
      'mcp_tool',
      appPayload(['once', 'conversation', 'bot']),
      'bot',
    );
    const line = approvals.renderContextLine(approval);
    expect(line).toContain('以 jyy@example.com 身份在 GitHub 执行 create_issue');
    expect(line).toContain('对该 Bot 总是允许');
    expect(approvals.describe(approval)).toContain(
      '以 jyy@example.com 身份在 GitHub 执行 create_issue',
    );
    // A plain MCP card keeps the W5 wording.
    const plain = await ask(
      stack,
      'mcp_tool',
      { serverId: 'srv', serverName: '笔记', toolName: 'add', argsSummary: '{}', risk: 'write' },
      undefined,
    );
    expect(approvals.renderContextLine(plain)).toContain('调用 MCP 工具 add（服务器「笔记」）');
  });
});

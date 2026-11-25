import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerHostToolNames, resolveCapabilities } from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import type { MockChatRequest } from '@kepcup/testkit';
import { createCapabilityDiscovery } from '../../src/capabilities/discovery.js';
import { buildExternalAgentTools } from '../../src/agent/external/capabilities.js';
import { buildSubagentResearchTools } from '../../src/tools/index.js';
import type { ToolDefinition } from '../../src/agent/types.js';
import { allowedOnReadOnlySurface } from '../../src/mcp/policy.js';
import type { McpToolEntry } from '../../src/mcp/tools.js';

/**
 * 62.11 C8 / C10（CoreServicesOptions.toolPolicy / hostTools）：被拒工具从最终
 * 工具面移除（内置、子代理、能力两件套懒解析）、提示词 has* 标志由最终工具名
 * 集合推导（被拒工具不再被静态规则点名）；宿主贡献工具进内置面与 ACP 能力包；
 * 不传选项 = 工具面与提示词现状。
 */

const systemOf = (req: MockChatRequest): string => {
  const first = req.body.messages?.[0];
  return typeof first?.content === 'string' ? first.content : '';
};
const toolNamesOf = (req: MockChatRequest): string[] =>
  (req.body.tools ?? []).map((tool) => (tool as { function?: { name?: string } }).function?.name ?? '');

const hostToolDef = (name: string): ToolDefinition => ({
  name,
  description: '宿主提供的测试工具',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true, content: 'ok' }),
});

/** A scripted plain reply, so the scripted turn does nothing else. */
const plainReply = () => [step().inTurn().replyText('好的。')];

describe('62.11 C8 工具策略：内置面与提示词同步', () => {
  let stack: TestStack;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack({
      toolPolicy: (_ctx, toolName) => (toolName === 'settings_change' ? 'deny' : 'allow'),
    });
    const bot = await makeBot(stack.core, '策略甲');
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('被拒的 settings_change 不在工具面，settings_search 保留；提示词不再点名设置写入', async () => {
    stack.llm.script('mock-main', plainReply());
    await sendBatch(stack.core, conversationId, ['你好']);
    await waitForRun(stack.core, conversationId, 'completed');

    const request = stack.llm.requestsFor('mock-main')[0]!;
    const names = toolNamesOf(request);
    expect(names).not.toContain('settings_change');
    expect(names).toContain('settings_search');
    // The SETTINGS_RULE row is gated by hasSettingsTools — derived from the final
    // tool-name set — and the rule text names settings_change.
    expect(systemOf(request)).not.toContain('settings_change');
  });
});

describe('62.11 C8 提示词同步：get_user_profile 被拒时静态规则不再点名', () => {
  let stack: TestStack;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack({
      toolPolicy: (_ctx, toolName) => (toolName === 'get_user_profile' ? 'deny' : 'allow'),
    });
    const bot = await makeBot(stack.core, '策略戊');
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('工具面无 get_user_profile；平台规则与 <user_profile> 引导都不提它', async () => {
    stack.llm.script('mock-main', plainReply());
    await sendBatch(stack.core, conversationId, ['你好']);
    await waitForRun(stack.core, conversationId, 'completed');
    const request = stack.llm.requestsFor('mock-main')[0]!;
    expect(toolNamesOf(request)).not.toContain('get_user_profile');
    const system = systemOf(request);
    expect(system).not.toContain('get_user_profile');
    // 点名 get_user_profile 的静态画像规则整句省略（对照栈里这句存在）。
    expect(system).not.toContain('需要具体细节（沟通偏好、工作、兴趣、边界、近况等）时');
  });
});

describe('62.11 C8/C10 无策略 = 现状（对照栈）', () => {
  let stack: TestStack;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack();
    const bot = await makeBot(stack.core, '对照乙');
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('工具面与提示词与既有快照一致（settings 三件套仍在）', async () => {
    stack.llm.script('mock-main', plainReply());
    await sendBatch(stack.core, conversationId, ['你好']);
    await waitForRun(stack.core, conversationId, 'completed');
    const request = stack.llm.requestsFor('mock-main')[0]!;
    const names = toolNamesOf(request);
    expect(names).toContain('settings_change');
    expect(names).toContain('get_user_profile');
    expect(systemOf(request)).toContain('settings_change');
    // 现状：静态画像规则点名 get_user_profile（被策略拒绝时整句省略，见上一组）。
    expect(systemOf(request)).toContain('调用 get_user_profile 按分类查询完整条目');
  });
});

describe('62.11 C10 宿主贡献工具', () => {
  it('内置面：宿主工具先拼进工具面，再被同一策略移除', async () => {
    const stack = await createTestStack({
      hostTools: ({ loopType }) => (loopType === 'turn' ? [hostToolDef('team_echo')] : []),
      toolPolicy: (_ctx, toolName) => (toolName === 'team_echo' ? 'deny' : 'allow'),
    });
    try {
      const bot = await makeBot(stack.core, '宿主丙');
      const conversationId = (await openDirect(stack.core, bot.id)).id;
      stack.llm.script('mock-main', plainReply());
      await sendBatch(stack.core, conversationId, ['你好']);
      await waitForRun(stack.core, conversationId, 'completed');
      // The host tool joined the mount (registration ran) and was then filtered.
      expect(toolNamesOf(stack.llm.requestsFor('mock-main')[0]!)).not.toContain('team_echo');
    } finally {
      await stack.cleanup();
    }
  });

  it('内置面：未被策略拒绝的宿主工具出现在对话轮工具面', async () => {
    const stack = await createTestStack({
      hostTools: ({ loopType }) => (loopType === 'turn' ? [hostToolDef('team_echo')] : []),
    });
    try {
      const bot = await makeBot(stack.core, '宿主丁');
      const conversationId = (await openDirect(stack.core, bot.id)).id;
      stack.llm.script('mock-main', plainReply());
      await sendBatch(stack.core, conversationId, ['你好']);
      await waitForRun(stack.core, conversationId, 'completed');
      expect(toolNamesOf(stack.llm.requestsFor('mock-main')[0]!)).toContain('team_echo');
    } finally {
      await stack.cleanup();
    }
  });

  it('ACP 能力包：登记过的宿主工具经 host 包保留，未登记的丢弃', () => {
    const hostTool = hostToolDef('resolution_submit');
    const capabilities = resolveCapabilities(null, { nativeCapabilities: {} });
    // Not registered: dropped by the pack filter (status quo for unknown names).
    expect(
      buildExternalAgentTools({ responseTools: [hostTool], capabilities }).map((t) => t.name),
    ).not.toContain('resolution_submit');
    // Registered (C10): rides the `host` pack and survives.
    registerHostToolNames(['resolution_submit']);
    expect(
      buildExternalAgentTools({ responseTools: [hostTool], capabilities }).map((t) => t.name),
    ).toContain('resolution_submit');
  });
});

describe('62.11 C8：懒解析（capability_search / capability_call）与子代理', () => {
  // Minimal discovery fixtures (same shape as capability-discovery.test.ts).
  const server = { id: 'conn_x', name: 'x', transport: 'http', url: 'https://x.test', enabled: true } as never;
  const entry = (name: string, risk: 'read' | 'write'): McpToolEntry =>
    ({
      server,
      tool: { name, description: '', inputSchema: { type: 'object', properties: {} } } as never,
      name,
      decision: {
        risk,
        riskSource: 'annotation',
        approval: risk === 'read' ? 'auto' : 'ask',
        approvalSource: 'default',
        enabled: true,
      } as never,
    }) as McpToolEntry;

  function discoveryWith(allowedTool?: (name: string) => boolean) {
    return createCapabilityDiscovery({
      surface: 'turn',
      capabilities: [
        {
          id: 'app:x',
          kind: 'app',
          name: 'X',
          description: '',
          status: 'ready',
          statusText: '可用',
          toolPrefix: 'app_x_',
          connectionId: 'conn_x',
          server,
        } as never,
      ],
      include: (e) => allowedOnReadOnlySurface(e.decision),
      ...(allowedTool !== undefined ? { allowedTool } : {}),
      timeoutMs: 50,
      resolve: async () => ({
        entries: [entry('app_x_list', 'read'), entry('app_x_delete', 'write')],
        unavailable: [],
        failed: [],
        failureDetails: {},
        locked: [],
      }),
      wrap: (entries) =>
        entries.map(
          (e): ToolDefinition => ({
            name: e.name,
            description: '',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ ok: true, content: 'ok' }),
          }),
        ),
      logger: { warn: () => {} },
    });
  }

  it('capability_search 搜不到被拒工具，capability_call 也拒绝（不进索引）', async () => {
    const discovery = discoveryWith((name) => name !== 'app_x_delete');
    const result = await discovery.search({ query: 'delete' });
    expect(result.hits.map((hit) => hit.name)).not.toContain('app_x_delete');
    const browse = await discovery.search({ query: '' });
    expect(browse.hits.map((hit) => hit.name)).toEqual(['app_x_list']);
    const call = await discovery.call('app_x_delete', {}, { signal: undefined } as never);
    expect(call.ok).toBe(false);
    expect(call.errorCode).toBe('MCP_TOOL_NOT_FOUND');
  });

  it('不传 allowedTool = 现状（只读索引含 list；write 不在对话轮索引）', async () => {
    const discovery = discoveryWith();
    const browse = await discovery.search({ query: '' });
    expect(browse.hits.map((hit) => hit.name)).toEqual(['app_x_list']);
  });

  it('子代理研究工具面受同一策略过滤', () => {
    const identity = {
      runId: 'run_sub',
      botId: 'bot_1',
      conversationId: 'conv_1',
      loopType: 'subagent' as const,
    };
    const deps = {
      runs: {} as never,
      gateway: {} as never,
      workspacePath: '/tmp/ws',
      workdirPath: null,
      network: { mode: 'open', allowDomains: [] } as never,
      secrets: {} as never,
      fsState: {} as never,
    };
    const names = buildSubagentResearchTools({
      identity,
      deps: deps as never,
    }).map((t) => t.name);
    expect(names).toContain('grep');
    const filtered = buildSubagentResearchTools({
      identity,
      deps: deps as never,
      principalId: 'mbr_1',
      toolPolicy: (_ctx, name) => (name === 'grep' ? 'deny' : 'allow'),
    }).map((t) => t.name);
    expect(filtered).not.toContain('grep');
    expect(filtered).toContain('read');
  });
});

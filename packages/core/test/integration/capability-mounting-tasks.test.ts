import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_CAPABILITIES_MAX,
  type Message,
  type Run,
  type SetupRequirement,
  type TaskEventContent,
} from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import { buildTaskTools } from '../../src/tools/task-tools.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../../src/agent/types.js';

/**
 * D91 P1 (design 40 §4, §10): a task declares the external capabilities it uses
 * (`start_task.capabilities`) and mounts only those; the rest is reached through the capability
 * pair (lazy). Real core + stdio fake MCP servers + mock model; tasks are started through the
 * TaskHost / task tools directly.
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A stdio MCP server whose tool list comes from argv[2] (JSON: [{name, readOnly}]). */
const SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const defs = JSON.parse(process.argv[2]);
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' } } });
    return;
  }
  if (String(msg.method).startsWith('notifications/')) return;
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    const empty = { type: 'object', properties: {} };
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: defs.map((d) => ({
      name: d.name, description: d.name + ' 工具', inputSchema: empty,
      annotations: d.readOnly ? { readOnlyHint: true } : { destructiveHint: false } })) } });
    return;
  }
  if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'CALLED:' + String(msg.params?.name ?? '') }], isError: false } });
  }
});
`;

interface ServerSpec {
  id: string;
  tools: Array<{ name: string; readOnly: boolean }>;
}

const ALPHA: ServerSpec = {
  id: 'alpha',
  tools: [
    { name: 'read_a', readOnly: true },
    { name: 'write_a', readOnly: false },
  ],
};
const BETA: ServerSpec = {
  id: 'beta',
  tools: [
    { name: 'read_b', readOnly: true },
    { name: 'write_b', readOnly: false },
  ],
};
const BIG: ServerSpec = {
  id: 'big',
  tools: Array.from({ length: 41 }, (_, i) => ({
    name: `t${String(i).padStart(2, '0')}`,
    readOnly: true,
  })),
};

async function start(specs: ServerSpec[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cap-mount-'));
  dirs.push(dir);
  const scriptPath = path.join(dir, 'server.cjs');
  await writeFile(scriptPath, SERVER_SCRIPT);
  const stack = await createTestStack();
  stacks.push(stack);
  const { core } = stack;
  await core.rpc.call('settings.update', {
    mcpServers: specs.map((spec) => ({
      id: spec.id,
      name: `服务器${spec.id}`,
      transport: 'stdio' as const,
      command: process.execPath,
      args: [scriptPath, JSON.stringify(spec.tools)],
      env: {},
      enabled: true,
      // Approval is not under test here: calls go through without a card.
      autoApprove: true,
    })),
  });
  // Pre-warm so lazy resolution never depends on a slow spawn.
  const mcp = core.services.mcp!;
  for (const server of mcp.listServers()) await mcp.listTools(server);
  const bot = await makeBot(core, '小艾');
  await core.rpc.call('bots.update', {
    id: bot.id,
    profile: {
      ...bot.profile,
      runtime: { ...bot.profile.runtime, mcp_server_ids: specs.map((spec) => spec.id) },
    },
  });
  const conv = await openDirect(core, bot.id);
  return { stack, core, llm: stack.llm, bot, conv, host: core.services.orchestrator!.tasks };
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);

function turnIdentity(botId: string, conversationId: string, runId = 'run_turn_cap'): RunIdentity {
  return { runId, botId, conversationId, loopType: 'turn' };
}

function toolsOf(req: MockChatRequest): string {
  return JSON.stringify(req.body.tools ?? []);
}

function systemOf(req: MockChatRequest): string {
  return JSON.stringify(
    (req.body.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer'),
  );
}

function runsOf(stack: TestStack) {
  return stack.core.services.domain!.runs;
}

function waitDone(stack: TestStack, id: string): Promise<Run> {
  return waitFor(
    () => {
      const run = runsOf(stack).get(id);
      return run !== null &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
        ? run
        : null;
    },
    { label: `task ${id} settled`, timeoutMs: 20_000 },
  );
}

function briefOf(stack: TestStack, taskId: string): TaskEventContent {
  const events = stack.core.services
    .domain!.messages.taskEvents(taskId)
    .map((m: Message) => m.content as TaskEventContent);
  return events.find((e) => e.phase === 'brief')!;
}

function stepsOf(stack: TestStack, runId: string) {
  return runsOf(stack).stepsFor(runId);
}

describe('D91 P1: tasks mount only the capabilities they declare', () => {
  it('declared capability: persisted on the row and in the brief; its tools are inline, other capabilities are not, the pair is there', async () => {
    const { stack, llm, bot, conv, host } = await start([ALPHA, BETA]);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-A')).replyText('RESULT-A'),
      step().replyText('ok'),
    ]);
    const started = host.start(turnIdentity(bot.id, conv.id), {
      title: '声明 alpha',
      instruction: 'TASK-A',
      sourceMessageIds: [],
      writes: false,
      capabilities: ['mcp:alpha'],
    });
    await waitDone(stack, started.taskId);

    expect(runsOf(stack).getOrThrow(started.taskId).taskCapabilities).toEqual(['mcp:alpha']);
    expect(briefOf(stack, started.taskId).capabilities).toEqual(['mcp:alpha']);
    expect(host.view(started.taskId)?.capabilities).toEqual(['mcp:alpha']);
    expect(
      host.list(turnIdentity(bot.id, conv.id)).find((t) => t.taskId === started.taskId)
        ?.capabilities,
    ).toEqual(['mcp:alpha']);

    const request = llm.requestsFor('mock-main').find(isTaskRequest('TASK-A'))!;
    const tools = toolsOf(request);
    expect(tools).toContain('mcp_alpha_read_a');
    expect(tools).toContain('mcp_alpha_write_a');
    expect(tools).not.toContain('mcp_beta_');
    // beta is ready but undeclared → reachable through the pair.
    expect(tools).toContain('capability_search');
    expect(tools).toContain('capability_call');
    const system = systemOf(request);
    expect(system).toContain('mcp:alpha');
    expect(system).toContain('mcp:beta');
    expect(system).toContain('本任务已挂上：mcp:alpha（工具名以 mcp_alpha_ 开头）');
    expect(system).not.toContain('mcp:beta（工具名以');
  }, 40_000);

  it('undeclared task (also the host-started §8.4 downgrade): no inline external tools; everything is reached through the pair, lazily', async () => {
    const { stack, llm, bot, conv, host } = await start([ALPHA, BETA]);
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-N'))
        .replyToolCall('capability_search', { query: 'read_b' }),
      step().replyToolCall('capability_call', { name: 'mcp_beta_read_b', arguments: {} }),
      step().replyText('RESULT-N'),
      step().replyText('ok'),
    ]);
    const started = host.start(turnIdentity(bot.id, conv.id), {
      title: '未声明',
      instruction: 'TASK-N',
      sourceMessageIds: [],
      writes: false,
    });
    await waitDone(stack, started.taskId);

    expect(runsOf(stack).getOrThrow(started.taskId).taskCapabilities).toBeNull();
    expect(briefOf(stack, started.taskId).capabilities).toBeUndefined();
    const request = llm.requestsFor('mock-main').find(isTaskRequest('TASK-N'))!;
    const tools = toolsOf(request);
    expect(tools).not.toContain('mcp_alpha_');
    expect(tools).not.toContain('mcp_beta_');
    expect(tools).toContain('capability_search');
    expect(systemOf(request)).not.toContain('本任务已挂上');
    const call = stepsOf(stack, started.taskId).find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'capability_call',
    );
    expect(call?.payload['ok']).toBe(true);
    expect(String(call?.payload['content'])).toContain('CALLED:read_b');
  }, 40_000);

  it('more than EXTERNAL_TOOLS_INLINE_MAX declared tools: none inline, all through the pair', async () => {
    const { stack, llm, bot, conv, host } = await start([ALPHA, BIG]);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-BIG')).replyToolCall('capability_search', { query: 't07' }),
      step().replyToolCall('capability_call', { name: 'mcp_big_t07', arguments: {} }),
      step().replyText('RESULT-BIG'),
      step().replyText('ok'),
    ]);
    const started = host.start(turnIdentity(bot.id, conv.id), {
      title: '大服务器',
      instruction: 'TASK-BIG',
      sourceMessageIds: [],
      writes: false,
      capabilities: ['mcp:big'],
    });
    await waitDone(stack, started.taskId);
    const request = llm.requestsFor('mock-main').find(isTaskRequest('TASK-BIG'))!;
    const tools = toolsOf(request);
    expect(tools).not.toContain('mcp_big_');
    expect(tools).not.toContain('mcp_alpha_');
    expect(tools).toContain('capability_search');
    expect(systemOf(request)).not.toContain('本任务已挂上');
    const call = stepsOf(stack, started.taskId).find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'capability_call',
    );
    expect(call?.payload['ok']).toBe(true);
    expect(String(call?.payload['content'])).toContain('CALLED:t07');
  }, 40_000);

  it('a declared id that is not in the bot catalog is INVALID_INPUT and lists the available ids; nothing is created', async () => {
    const { stack, bot, conv, host } = await start([ALPHA, BETA]);
    expect(() =>
      host.start(turnIdentity(bot.id, conv.id), {
        title: 'x',
        instruction: 'TASK-X',
        sourceMessageIds: [],
        writes: false,
        capabilities: ['mcp:alpha', 'mcp:nope'],
      }),
    ).toThrow(/不存在的能力 id：mcp:nope.*mcp:alpha、mcp:beta/);
    expect(runsOf(stack).listTasks({ conversationId: conv.id, botId: bot.id })).toHaveLength(0);

    // Through the tool: the same failure comes back as a tool error.
    const tools = buildTaskTools({ identity: turnIdentity(bot.id, conv.id), tasks: host });
    const result = await run(
      tools.find((t) => t.name === 'start_task')!,
      {
        title: 'x',
        instruction: 'TASK-X',
        source_message_ids: [],
        writes: false,
        capabilities: ['app:github'],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('app:github');
    expect(result.content).toContain('mcp:alpha');
  }, 40_000);

  it('a bot without any external capability: declaring one lists "none available"', async () => {
    const { bot, conv, host } = await start([]);
    expect(() =>
      host.start(turnIdentity(bot.id, conv.id), {
        title: 'x',
        instruction: 'TASK-X',
        sourceMessageIds: [],
        writes: false,
        capabilities: ['mcp:alpha'],
      }),
    ).toThrow(/没有接入外部能力/);
  }, 40_000);

  it('continues_task_id: the new task gets the union of the continued task capabilities and its own', async () => {
    const { stack, llm, bot, conv, host } = await start([ALPHA, BETA]);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-C1')).replyText('RESULT-C1'),
      step().replyText('ok'),
      step().expect(isTaskRequest('TASK-C2')).replyText('RESULT-C2'),
      step().replyText('ok'),
    ]);
    const turn = turnIdentity(bot.id, conv.id);
    const first = host.start(turn, {
      title: 'c1',
      instruction: 'TASK-C1',
      sourceMessageIds: [],
      writes: false,
      capabilities: ['mcp:alpha'],
    });
    await waitDone(stack, first.taskId);
    const second = host.start(turnIdentity(bot.id, conv.id, 'run_turn_cap2'), {
      title: 'c2',
      instruction: 'TASK-C2',
      sourceMessageIds: [],
      writes: false,
      continuesTaskId: first.taskId,
      capabilities: ['mcp:beta'],
    });
    await waitDone(stack, second.taskId);
    expect(runsOf(stack).getOrThrow(second.taskId).taskCapabilities).toEqual([
      'mcp:alpha',
      'mcp:beta',
    ]);
    const tools = toolsOf(llm.requestsFor('mock-main').find(isTaskRequest('TASK-C2'))!);
    expect(tools).toContain('mcp_alpha_read_a');
    expect(tools).toContain('mcp_beta_read_b');
  }, 40_000);

  it('a queued task no longer mounts a capability the bot dropped while it waited', async () => {
    const { stack, core, llm, bot, conv, host } = await start([ALPHA, BETA]);
    const held = step().expect(isTaskRequest('TASK-Q1')).hold().replyText('RESULT-Q1');
    llm.script('mock-main', [
      held,
      step().replyText('ok'),
      step().expect(isTaskRequest('TASK-Q2')).replyText('RESULT-Q2'),
      step().replyText('ok'),
    ]);
    const turn = turnIdentity(bot.id, conv.id);
    const w1 = host.start(turn, {
      title: 'q1',
      instruction: 'TASK-Q1',
      sourceMessageIds: [],
      writes: true,
    });
    const w2 = host.start(turn, {
      title: 'q2',
      instruction: 'TASK-Q2',
      sourceMessageIds: [],
      writes: true,
      capabilities: ['mcp:alpha', 'mcp:beta'],
    });
    expect(w2.state).toBe('submitted');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'w1 request held',
    });
    // The user unticks alpha while q2 waits for the write lease.
    const fresh = (await core.rpc.call('bots.get', { id: bot.id })) as {
      bot: { profile: typeof bot.profile };
    };
    await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...fresh.bot.profile,
        runtime: { ...fresh.bot.profile.runtime, mcp_server_ids: ['beta'] },
      },
    });
    // Dropping a server interrupts the bot's running task (W3), which frees the write lease for q2.
    await waitDone(stack, w1.taskId);
    held.release();
    await waitDone(stack, w2.taskId);
    // The row still says what was declared; the mount follows the catalog at launch time.
    expect(runsOf(stack).getOrThrow(w2.taskId).taskCapabilities).toEqual(['mcp:alpha', 'mcp:beta']);
    const request = llm.requestsFor('mock-main').find(isTaskRequest('TASK-Q2'))!;
    const tools = toolsOf(request);
    expect(tools).not.toContain('mcp_alpha_');
    expect(tools).toContain('mcp_beta_read_b');
    expect(systemOf(request)).not.toContain('mcp:alpha');
  }, 40_000);

  it('a retry keeps the capabilities the failed task declared', async () => {
    const { stack, llm, bot, conv, host } = await start([ALPHA, BETA]);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-R')).replyText('RESULT-R'),
      step().replyText('ok'),
    ]);
    const started = host.start(turnIdentity(bot.id, conv.id), {
      title: 'retry',
      instruction: 'TASK-R',
      sourceMessageIds: [],
      writes: false,
      capabilities: ['mcp:beta'],
    });
    await waitDone(stack, started.taskId);
    // Make it look failed (a crash / gate failure) so it can be retried.
    runsOf(stack).update(started.taskId, { status: 'failed', error: 'boom' });
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-R')).replyText('RESULT-R2'),
      step().replyText('ok'),
    ]);
    const retried = host.retry(started.taskId);
    await waitDone(stack, retried.id);
    expect(runsOf(stack).getOrThrow(retried.id).taskCapabilities).toEqual(['mcp:beta']);
    expect(briefOf(stack, retried.id).capabilities).toEqual(['mcp:beta']);
    const requests = llm.requestsFor('mock-main').filter(isTaskRequest('TASK-R'));
    expect(toolsOf(requests.at(-1)!)).toContain('mcp_beta_read_b');
  }, 40_000);

  describe('retry after connect-app (D91 follow-up): the newly connected capability is declared', () => {
    const failWithSetup = (
      stack: TestStack,
      taskId: string,
      setup: SetupRequirement,
    ): void => {
      runsOf(stack).update(taskId, { status: 'failed', error: 'setup', setup });
    };

    it('custom OAuth target: mcp:{serverId} is merged into the retried task (row + brief), mounted inline', async () => {
      const { stack, llm, bot, conv, host } = await start([ALPHA, BETA]);
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C1')).replyText('RESULT'),
        step().replyText('ok'),
      ]);
      const started = host.start(turnIdentity(bot.id, conv.id), {
        title: 'c1',
        instruction: 'TASK-C1',
        sourceMessageIds: [],
        writes: false,
        capabilities: ['mcp:alpha'],
      });
      await waitDone(stack, started.taskId);
      failWithSetup(stack, started.taskId, {
        kind: 'connect-app',
        target: { kind: 'custom', serverId: 'beta' },
        reason: 'not_connected',
      });
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C1')).replyText('RESULT2'),
        step().replyText('ok'),
      ]);
      const retried = host.retry(started.taskId);
      await waitDone(stack, retried.id);
      expect(runsOf(stack).getOrThrow(retried.id).taskCapabilities).toEqual([
        'mcp:alpha',
        'mcp:beta',
      ]);
      expect(briefOf(stack, retried.id).capabilities).toEqual(['mcp:alpha', 'mcp:beta']);
      const last = llm.requestsFor('mock-main').filter(isTaskRequest('TASK-C1')).at(-1)!;
      expect(toolsOf(last)).toContain('mcp_alpha_read_a');
      expect(toolsOf(last)).toContain('mcp_beta_read_b');
    }, 40_000);

    it('a task that declared nothing gets just the connected one; a catalog target maps to app:{slug}', async () => {
      const { stack, llm, bot, conv, host } = await start([ALPHA]);
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C2')).replyText('RESULT'),
        step().replyText('ok'),
      ]);
      const started = host.start(turnIdentity(bot.id, conv.id), {
        title: 'c2',
        instruction: 'TASK-C2',
        sourceMessageIds: [],
        writes: false,
      });
      await waitDone(stack, started.taskId);
      expect(runsOf(stack).getOrThrow(started.taskId).taskCapabilities).toBeNull();
      failWithSetup(stack, started.taskId, {
        kind: 'connect-app',
        target: { kind: 'catalog', connectorId: 'github' },
        connectionId: 'conn_gh',
        reason: 'expired',
      });
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C2')).replyText('RESULT2'),
        step().replyText('ok'),
      ]);
      const retried = host.retry(started.taskId);
      await waitDone(stack, retried.id);
      // Not in the catalog / not ready yet: declared anyway (the mount intersects with ready).
      expect(runsOf(stack).getOrThrow(retried.id).taskCapabilities).toEqual(['app:github']);
    }, 40_000);

    it('already declared → not duplicated; other setup kinds → declaration untouched', async () => {
      const { stack, llm, bot, conv, host } = await start([ALPHA, BETA]);
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C3')).replyText('RESULT'),
        step().replyText('ok'),
      ]);
      const started = host.start(turnIdentity(bot.id, conv.id), {
        title: 'c3',
        instruction: 'TASK-C3',
        sourceMessageIds: [],
        writes: false,
        capabilities: ['mcp:beta'],
      });
      await waitDone(stack, started.taskId);
      failWithSetup(stack, started.taskId, {
        kind: 'connect-app',
        target: { kind: 'custom', serverId: 'beta' },
        reason: 'expired',
      });
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C3')).replyText('RESULT2'),
        step().replyText('ok'),
      ]);
      const retried = host.retry(started.taskId);
      await waitDone(stack, retried.id);
      expect(runsOf(stack).getOrThrow(retried.id).taskCapabilities).toEqual(['mcp:beta']);

      // A different setup kind (mail) leaves the declaration as it was.
      failWithSetup(stack, retried.id, { kind: 'mail-account' });
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C3')).replyText('RESULT3'),
        step().replyText('ok'),
      ]);
      const again = host.retry(retried.id);
      await waitDone(stack, again.id);
      expect(runsOf(stack).getOrThrow(again.id).taskCapabilities).toEqual(['mcp:beta']);
    }, 60_000);

    it('over TASK_CAPABILITIES_MAX: the connected one is not merged (warn), the old declaration stays', async () => {
      const specs: ServerSpec[] = Array.from({ length: TASK_CAPABILITIES_MAX + 1 }, (_, i) => ({
        id: `s${i}`,
        tools: [{ name: 'r', readOnly: true }],
      }));
      const { stack, llm, bot, conv, host } = await start(specs);
      const declared = specs.slice(0, TASK_CAPABILITIES_MAX).map((spec) => `mcp:${spec.id}`);
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C4')).replyText('RESULT'),
        step().replyText('ok'),
      ]);
      const started = host.start(turnIdentity(bot.id, conv.id), {
        title: 'c4',
        instruction: 'TASK-C4',
        sourceMessageIds: [],
        writes: false,
        capabilities: declared,
      });
      await waitDone(stack, started.taskId);
      failWithSetup(stack, started.taskId, {
        kind: 'connect-app',
        target: { kind: 'custom', serverId: `s${TASK_CAPABILITIES_MAX}` },
        reason: 'not_connected',
      });
      llm.script('mock-main', [
        step().expect(isTaskRequest('TASK-C4')).replyText('RESULT2'),
        step().replyText('ok'),
      ]);
      const retried = host.retry(started.taskId);
      await waitDone(stack, retried.id);
      expect(runsOf(stack).getOrThrow(retried.id).taskCapabilities).toEqual(declared);
    }, 60_000);
  });

  it('a sub run of a task gets the read-only + auto subset of every reachable capability (inline subset + the pair); write tools never', async () => {
    const { stack, llm, bot, conv, host } = await start([ALPHA, BETA]);
    const isSub = (marker: string) => (req: MockChatRequest) =>
      !req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-S'))
        .replyToolCall('delegate_task', { task: 'SUB-S 查一下' }),
      step().expect(isSub('SUB-S')).replyToolCall('capability_search', { query: '' }),
      step().replyToolCall('capability_call', { name: 'mcp_beta_read_b', arguments: {} }),
      step().replyText('子代理查到了'),
      step().expect(isTaskRequest('TASK-S')).replyText('RESULT-S'),
      step().replyText('ok'),
    ]);
    llm.script('mock-light', [
      step()
        .expect((req) => req.lastUserText().includes('<process_record>'))
        .replyText('压缩后的结论'),
    ]);
    const started = host.start(turnIdentity(bot.id, conv.id), {
      title: '子代理',
      instruction: 'TASK-S',
      sourceMessageIds: [],
      writes: false,
      capabilities: ['mcp:alpha'],
    });
    await waitDone(stack, started.taskId);
    const subRequest = llm.requestsFor('mock-main').find(isSub('SUB-S'))!;
    const subTools = toolsOf(subRequest);
    expect(subTools).toContain('mcp_alpha_read_a');
    expect(subTools).not.toContain('mcp_alpha_write_a');
    expect(subTools).not.toContain('mcp_beta_');
    expect(subTools).toContain('capability_search');
    const sub = runsOf(stack)
      .listByConversation(conv.id, 50)
      .find((r) => r.loopType === 'subagent' && r.parentRunId === started.taskId)!;
    const search = stepsOf(stack, sub.id).find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'capability_search',
    );
    const text = String(search?.payload['content']);
    expect(text).toContain('mcp_beta_read_b');
    expect(text).not.toContain('mcp_beta_write_b');
    const call = stepsOf(stack, sub.id).find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'capability_call',
    );
    expect(call?.payload['ok']).toBe(true);
    // The task itself holds the declared write tool.
    expect(toolsOf(llm.requestsFor('mock-main').find(isTaskRequest('TASK-S'))!)).toContain(
      'mcp_alpha_write_a',
    );
  }, 60_000);
});

async function run(tool: ToolDefinition, params: unknown): Promise<ToolResult> {
  return tool.execute(params, {
    identity: { runId: 'x', botId: null, conversationId: null, loopType: 'turn' },
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  });
}

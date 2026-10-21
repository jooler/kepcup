import { describe, expect, it } from 'vitest';
import type { Run, RunStep } from '@kepcup/shared';

import {
  buildGetRunStepsTool,
  buildResponseTools,
  buildSubagentResearchTools,
} from '../../src/tools/index.js';
import { buildExternalAgentTools } from '../../src/agent/external/capabilities.js';
import { FileReadState } from '../../src/tools/fs-state.js';
import type { RunIdentity, ToolContext } from '../../src/agent/types.js';

/**
 * D93 P3 详细历史读取：get_run_steps 只读自己的 run / 当前对话里本 Bot 的
 * run；任务与子代理可用，对话轮不改变工具面；结果按 TOOL_OUTPUT_MAX_CHARS
 * 截断并包 <untrusted>。
 */

const BOT = 'bot_x';
const CONV = 'conv_x';

function runOf(id: string, botId = BOT, conversationId = CONV): Run {
  return { id, botId, conversationId, loopType: 'task' } as Run;
}

function step(seq: number, type: RunStep['type'], payload: unknown): RunStep {
  return { id: `stp_${seq}`, runId: 'run_task', seq, type, payload, createdAt: seq };
}

function ctxFor(identity: RunIdentity): ToolContext {
  return {
    identity,
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  };
}

function toolFor(identity: RunIdentity, runs: Run[], steps: RunStep[]) {
  return buildGetRunStepsTool({
    identity,
    runs: {
      get: (id: string) => runs.find((run) => run.id === id) ?? null,
      stepsFor: (id: string) => (id === 'run_task' ? steps : []),
    },
  });
}

const task: RunIdentity = { runId: 'run_task', botId: BOT, conversationId: CONV, loopType: 'task' };
const subagent: RunIdentity = {
  runId: 'run_sub',
  botId: BOT,
  conversationId: CONV,
  loopType: 'subagent',
};
const turn: RunIdentity = { runId: 'run_turn', botId: BOT, conversationId: CONV, loopType: 'turn' };

function responseToolNames(identity: RunIdentity): string[] {
  const runs = [
    runOf('run_task'),
    runOf('run_other_bot', 'bot_y'),
    runOf('run_other_conv', BOT, 'conv_y'),
  ];
  return buildResponseTools({
    identity,
    deps: {
      messages: {} as never,
      attachments: {} as never,
      runs: {
        get: (id: string) => runs.find((run) => run.id === id) ?? null,
        stepsFor: () => [],
        listByBotInConversation: () => [],
      } as never,
      secrets: { redact: (text: string) => text } as never,
      renderOptions: {},
      gateway: {} as never,
      workspacePath: '/ws',
      workdirPath: null,
      workdirs: {} as never,
      network: { mode: 'none', allowDomains: [] },
      fsState: new FileReadState(),
      onBotMessage: () => {},
      environment: {} as never,
    } as never,
  }).map((tool) => tool.name);
}

describe('get_run_steps 工具面', () => {
  it('任务 / 子代理可用；对话轮不新增该工具', () => {
    expect(responseToolNames(task)).toContain('get_run_steps');
    expect(responseToolNames(subagent)).toContain('get_run_steps');
    expect(responseToolNames(turn)).not.toContain('get_run_steps');
  });

  it('子代理研究工具集也带 get_run_steps', () => {
    const tools = buildSubagentResearchTools({
      identity: subagent,
      deps: {
        runs: { get: () => null, stepsFor: () => [] } as never,
        gateway: {} as never,
        workspacePath: '/ws',
        workdirPath: null,
        network: { mode: 'none', allowDomains: [] },
        secrets: { redact: (text: string) => text } as never,
        fsState: new FileReadState(),
      },
    });
    expect(tools.map((tool) => tool.name)).toContain('get_run_steps');
  });

  it('外部智能体经能力包过滤不会注入 get_run_steps', () => {
    const tool = toolFor(task, [runOf('run_task')], []);
    const external = buildExternalAgentTools({
      responseTools: [tool],
      capabilities: ['core'],
    });
    expect(external.map((entry) => entry.name)).not.toContain('get_run_steps');
  });
});

describe('get_run_steps 读取范围', () => {
  const runs = [
    runOf('run_task'),
    runOf('run_other_bot', 'bot_y'),
    runOf('run_other_conv', BOT, 'conv_y'),
  ];
  const steps = [
    step(0, 'tool_call', { toolName: 'read', args: { path: '/ws/a.txt' } }),
    step(1, 'tool_result', {
      toolName: 'read',
      ok: true,
      content: `HEAD${'x'.repeat(200_000)}TAIL`,
    }),
    step(2, 'progress', { text: '计划 1/2：阅读文件' }),
    step(3, 'assistant', { text: '完成阅读', stopReason: 'stop' }),
    step(4, 'tool_call', { toolName: 'bash', args: {} }),
  ];

  it('自己的 run 可读，结果包 <untrusted> 且超长结果被截断', async () => {
    const tool = toolFor(task, runs, steps);
    const result = await tool.execute({ run_id: 'run_task' }, ctxFor(task));
    expect(result.ok).toBe(true);
    expect(result.content.startsWith('<untrusted>\n')).toBe(true);
    expect(result.content.endsWith('\n</untrusted>')).toBe(true);
    expect(result.content).toContain('[tool_call] read');
    expect(result.content).toContain('[tool_result] read（成功）');
    expect(result.content).toContain('[progress] 计划 1/2：阅读文件');
    expect(result.content).toContain('[assistant]');
    expect(result.content).toContain('[已截断]');
    expect(result.content.length).toBeLessThan(200_000);
  });

  it('当前对话里本 Bot 的其他 run 可读', async () => {
    const tool = toolFor(task, runs, steps);
    const result = await tool.execute({ run_id: 'run_task' }, ctxFor(subagent));
    expect(result.ok).toBe(true);
  });

  it('其他 Bot / 其他对话的 run 一律 RUN_NOT_FOUND', async () => {
    const tool = toolFor(task, runs, steps);
    for (const runId of ['run_other_bot', 'run_other_conv', 'run_missing']) {
      const result = await tool.execute({ run_id: runId }, ctxFor(task));
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('RUN_NOT_FOUND');
    }
  });

  it('from_seq / limit 分页并给出继续位置', async () => {
    const tool = toolFor(task, runs, steps);
    const result = await tool.execute({ run_id: 'run_task', from_seq: 1, limit: 2 }, ctxFor(task));
    expect(result.content).toContain('1. [tool_result] read');
    expect(result.content).toContain('2. [progress]');
    expect(result.content).not.toContain('3. [assistant]');
    expect(result.content).toContain('from_seq=3');
  });

  it('非法 from_seq / limit 返回 INVALID_INPUT', async () => {
    const tool = toolFor(task, runs, steps);
    for (const params of [
      { run_id: 'run_task', from_seq: -1 },
      { run_id: 'run_task', from_seq: 1.5 },
      { run_id: 'run_task', limit: 0 },
    ]) {
      const result = await tool.execute(params, ctxFor(task));
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('INVALID_INPUT');
    }
  });
});

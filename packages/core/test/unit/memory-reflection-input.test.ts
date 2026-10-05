import { describe, expect, it } from 'vitest';

import { executionStepsSummary, reflectionInput } from '../../src/memory/reflection.js';
import type { RunStep } from '@kepcup/shared';

function step(type: RunStep['type'], payload: unknown): RunStep {
  return { id: 'stp_1', runId: 'run_1', seq: 0, type, payload, createdAt: 1 };
}

describe('reflection input (BR-P07-009: 执行步骤概要)', () => {
  it('renders the sanitized execution steps wrapped in <untrusted>', () => {
    const messages = reflectionInput({
      triggerMessages: [
        {
          id: 'msg_1',
          createdAt: 1,
          senderType: 'user',
          senderBotId: null,
          content: { text: '你好' },
        },
      ],
      botMessages: [],
      runId: 'run_1',
      executionSteps: '- assistant: 你好\n- tool_call read_file',
      existingMemories: '',
      profileCard: '',
    });
    const text = String(messages[0]!.content);
    expect(text).toContain('<execution_steps>');
    expect(text).toContain('<untrusted>\n- assistant: 你好\n- tool_call read_file\n</untrusted>');
    expect(text).toContain('<trigger_messages>');
  });

  it('omits the section when there are no steps', () => {
    const messages = reflectionInput({
      triggerMessages: [],
      botMessages: [],
      runId: null,
      executionSteps: '',
      existingMemories: '',
      profileCard: '',
      continuedFromRunIds: [],
    });
    expect(String(messages[0]!.content)).not.toContain('<execution_steps>');
  });

  it('notes the continuation source runs (Loop 续接, D56) only when present', () => {
    const base = {
      triggerMessages: [],
      botMessages: [],
      runId: 'run_2',
      executionSteps: '',
      existingMemories: '',
      profileCard: '',
    };
    const withContinuation = reflectionInput({
      ...base,
      continuedFromRunIds: ['run_a', 'run_b'],
    });
    expect(String(withContinuation[0]!.content)).toContain(
      '<continued_from_runs>run_a,run_b</continued_from_runs>',
    );
    const withoutContinuation = reflectionInput({ ...base, continuedFromRunIds: [] });
    expect(String(withoutContinuation[0]!.content)).not.toContain('<continued_from_runs>');
  });

  it('executionStepsSummary exposes only step kinds and tool names (no args/results)', () => {
    const runs = {
      stepsFor: (runId: string) =>
        runId === 'run_1'
          ? [
              step('request', { messages: '应被省略的完整请求' }),
              step('assistant', { text: '我来查看文件', stopReason: 'toolUse' }),
              step('tool_call', { toolName: 'read_file', args: { path: '/etc/passwd' } }),
              step('tool_result', { content: 'root:x:0:0 应被省略' }),
              step('progress', { text: '进度' }),
            ]
          : [],
    } as never;
    const summary = executionStepsSummary(runs, 'run_1');
    expect(summary).toContain('- assistant: 我来查看文件');
    expect(summary).toContain('- tool_call read_file');
    expect(summary).not.toContain('/etc/passwd');
    expect(summary).not.toContain('root:x:0:0');
    expect(summary).not.toContain('应被省略的完整请求');
  });

  it('returns empty for a null run and never throws on runs-service failures', () => {
    expect(executionStepsSummary({ stepsFor: () => [] } as never, null)).toBe('');
    expect(
      executionStepsSummary(
        {
          stepsFor: () => {
            throw new Error('db gone');
          },
        } as never,
        'run_x',
      ),
    ).toBe('');
  });

  it('caps the summary (50 steps, 4000 chars)', () => {
    const runs = {
      stepsFor: () => Array.from({ length: 200 }, () => step('tool_call', { toolName: 'shell' })),
    } as never;
    const summary = executionStepsSummary(runs, 'run_1');
    expect(summary.split('\n')).toHaveLength(50);
    expect(summary.length).toBeLessThanOrEqual(4000);
  });
});

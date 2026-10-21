import { describe, expect, it } from 'vitest';
import type { RunStep } from '@kepcup/shared';
import {
  buildTaskRunTimeline,
  formatElapsed,
  formatToolArgs,
  resultPreview,
  taskElapsedMs,
  toolCallSummary,
} from './task-run-view';

/** 任务执行过程页的 run_steps 展示逻辑（docs/design/42-task-run-view.md）。 */

function step(seq: number, type: RunStep['type'], payload: unknown): RunStep {
  return { id: `s${seq}`, runId: 'run_task', seq, type, payload, createdAt: seq };
}

describe('buildTaskRunTimeline', () => {
  it('keeps assistant prose and drops empty assistant / request steps', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'request', { messages: [] }),
      step(1, 'assistant', { text: '我先看一下目录。', stopReason: 'toolUse' }),
      step(2, 'assistant', { text: '', stopReason: 'toolUse' }),
      step(3, 'assistant', { text: '完成了。', stopReason: 'stop' }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['assistant', 'assistant']);
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: '我先看一下目录。' });
  });

  it('pairs a tool_result with its tool_call and keeps the call order', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'assistant', { text: '开始', stopReason: 'toolUse' }),
      step(1, 'tool_call', {
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pnpm test' },
      }),
      step(2, 'tool_call', { toolCallId: 'c2', toolName: 'read', args: { path: 'src/a.ts' } }),
      step(3, 'tool_result', {
        toolCallId: 'c1',
        toolName: 'bash',
        ok: true,
        content: 'all green',
      }),
      step(4, 'tool_result', {
        toolCallId: 'c2',
        toolName: 'read',
        ok: false,
        content: 'not found',
        errorCode: 'ENOENT',
      }),
    ]);
    const tools = entries.filter((entry) => entry.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      kind: 'tool',
      name: 'bash',
      result: { ok: true, content: 'all green' },
    });
    expect(tools[1]).toMatchObject({
      name: 'read',
      result: { ok: false, content: 'not found', errorCode: 'ENOENT' },
    });
  });

  it('keeps progress, steer and system entries in sequence order', () => {
    const entries = buildTaskRunTimeline([
      step(2, 'progress', { text: '正在执行 pnpm test' }),
      step(0, 'steer', { text: '先看 README' }),
      step(1, 'system', { text: '模型重连' }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['steer', 'system', 'progress']);
  });

  it('keeps an orphan tool_result visible', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'tool_result', { toolCallId: 'lost', toolName: 'bash', ok: true, content: 'ok' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'bash', result: { ok: true } });
  });
});

describe('toolCallSummary', () => {
  it('uses the command for bash', () => {
    expect(toolCallSummary({ name: 'bash', title: null, args: { command: 'pnpm test' } })).toBe(
      'pnpm test',
    );
  });

  it('prefers an external agent title', () => {
    expect(
      toolCallSummary({ name: 'Read', title: 'Reading src/a.ts', args: { path: 'src/a.ts' } }),
    ).toBe('Reading src/a.ts');
  });

  it('falls back to the first string argument', () => {
    expect(toolCallSummary({ name: 'custom_tool', title: null, args: { query: 'hello' } })).toBe(
      'hello',
    );
  });
});

describe('formatting helpers', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });

  it('counts from start once running, and stops at the end', () => {
    expect(taskElapsedMs({ createdAt: 100, startedAt: 200, endedAt: null }, 1_200)).toBe(1_000);
    expect(taskElapsedMs({ createdAt: 100, startedAt: 200, endedAt: 900 }, 5_000)).toBe(700);
  });

  it('renders JSON args and a one-line result preview', () => {
    expect(formatToolArgs({ path: 'a.ts' })).toContain('"path": "a.ts"');
    expect(resultPreview('\n\nfirst line\nsecond line')).toBe('first line');
    expect(resultPreview('')).toBe('');
  });
});

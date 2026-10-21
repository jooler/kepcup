import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { wrapPiTool } from '../../src/tools/coding-tools.js';
import { ToolOutputSpill } from '../../src/agent/tool-output-spill.js';
import type { ToolContext } from '../../src/agent/types.js';

/**
 * pi 工具包装语义（Phase A 审查 P2-1）：pi 1.0.2 的工具失败不再 throw 而是
 * 返回 `isError: true` 的结果（agent-core types.d.ts）；wrapPiTool 必须把它
 * 映射为 ok:false + COMMAND_FAILED，输出仍 <untrusted> 包裹 + 脱敏。
 */

const secrets = { redact: (text: string) => text } as never;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ctx: ToolContext = {
  identity: { runId: 'run_1', botId: 'bot', conversationId: 'conv', loopType: 'turn' },
  signal: new AbortController().signal,
  terminate: () => {},
  progress: () => {},
};

function fakeDef(result: unknown, error?: unknown) {
  return {
    name: 'bash',
    description: 'd',
    parameters: {},
    execute: async () => {
      if (error !== undefined) throw error;
      return result as never;
    },
  };
}

describe('wrapPiTool', () => {
  it('正常结果：ok:true + <untrusted> 包裹', async () => {
    const tool = wrapPiTool(
      fakeDef({ content: [{ type: 'text', text: 'hello' }] }),
      '/ws',
      secrets,
    );
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello');
    expect(result.content.startsWith('<untrusted>')).toBe(true);
  });

  it('pi 1.x isError 结果：ok:false + COMMAND_FAILED（而非误报成功）', async () => {
    const tool = wrapPiTool(
      fakeDef({
        content: [{ type: 'text', text: 'out' }],
        isError: true,
      }),
      '/ws',
      secrets,
    );
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('COMMAND_FAILED');
    expect(result.content).toContain('out');
    expect(result.content.startsWith('<untrusted>')).toBe(true);
  });

  it('throw 路径（0.x 语义 / 宿主 abort）：ok:false', async () => {
    const thrown = wrapPiTool(fakeDef(null, new Error('aborted')), '/ws', secrets);
    const result = await thrown.execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TOOL_FAILED');

    const appErr = wrapPiTool(
      fakeDef(null, new AppError('PATH_OUT_OF_SCOPE', 'no')),
      '/ws',
      secrets,
    );
    const result2 = await appErr.execute({}, ctx);
    expect(result2.ok).toBe(false);
    expect(result2.errorCode).toBe('PATH_OUT_OF_SCOPE');
  });

  it('D93 P3：超长输出落盘，模型只拿头尾摘要且仍包 <untrusted>', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'kepcup-coding-spill-'));
    roots.push(workspacePath);
    mkdirSync(workspacePath, { recursive: true });
    const full = `${'A'.repeat(40_000)}TAIL`;
    const spill = new ToolOutputSpill({ workspacePath, runId: 'run_task' });
    const tool = wrapPiTool(
      fakeDef({ content: [{ type: 'text', text: full }] }),
      workspacePath,
      secrets,
      { spill },
    );

    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.content.startsWith('<untrusted>\n')).toBe(true);
    expect(result.content.endsWith('\n</untrusted>')).toBe(true);
    expect(result.content).toContain(path.join('.tool-output', 'run_task', '0.txt'));
    expect(result.content).toContain('共 40004 字符');
    expect(result.content.length).toBeLessThan(full.length);
    expect(
      readFileSync(path.join(workspacePath, '.tool-output', 'run_task', '0.txt'), 'utf8'),
    ).toBe(full);
  });

  it('D93 P3：落盘失败退回现有截断', async () => {
    const missing = path.join(tmpdir(), 'kepcup-missing-workspace', String(Date.now()));
    const spill = new ToolOutputSpill({ workspacePath: missing, runId: 'run_task' });
    const full = '中'.repeat(40_000);
    const tool = wrapPiTool(fakeDef({ content: [{ type: 'text', text: full }] }), '/ws', secrets, {
      spill,
    });

    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('[已截断]');
    expect(result.content.length).toBeLessThan(full.length);
  });
});

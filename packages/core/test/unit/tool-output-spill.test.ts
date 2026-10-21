import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearToolOutputSpill,
  spillToolResult,
  ToolOutputSpill,
} from '../../src/agent/tool-output-spill.js';

/**
 * D93 P3 工具输出落盘：超长输出写 workspace，模型只拿头尾摘要；写失败 /
 * 不安全路径退回截断；结算清理不跟随符号链接。
 */

const roots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'kepcup-spill-'));
  roots.push(root);
  return path.join(root, 'workspace');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ToolOutputSpill', () => {
  it('小输出不落盘', () => {
    const workspacePath = tempWorkspace();
    mkdirSync(workspacePath, { recursive: true });
    const spill = new ToolOutputSpill({ workspacePath, runId: 'run_1', maxChars: 100 });
    expect(spill.spill('short')).toBeNull();
  });

  it('超长输出写文件并返回头 + 尾 + 路径 + 字符数', () => {
    const workspacePath = tempWorkspace();
    mkdirSync(workspacePath, { recursive: true });
    const spill = new ToolOutputSpill({
      workspacePath,
      runId: 'run_1',
      maxChars: 100,
      headChars: 20,
      tailChars: 20,
    });
    const text = `${'A'.repeat(1_000)}MIDDLE${'Z'.repeat(1_000)}`;
    const result = spill.spill(text);

    expect(result).not.toBeNull();
    expect(result!.totalChars).toBe(text.length);
    expect(result!.path.endsWith(path.join('.tool-output', 'run_1', '0.txt'))).toBe(true);
    expect(readFileSync(result!.path, 'utf8')).toBe(text);
    expect(result!.text).toContain(`共 ${text.length} 字符`);
    expect(result!.text).toContain(result!.path);
    expect(result!.text).toContain('A'.repeat(20));
    expect(result!.text).toContain('Z'.repeat(20));
    expect(result!.text).not.toContain('MIDDLE');
    expect(result!.text.length).toBeLessThan(text.length);
  });

  it('同一 run 的文件序号递增', () => {
    const workspacePath = tempWorkspace();
    mkdirSync(workspacePath, { recursive: true });
    const spill = new ToolOutputSpill({ workspacePath, runId: 'run_1', maxChars: 5 });
    const first = spill.spill('123456');
    const second = spill.spill('abcdef');
    expect(first!.path.endsWith('/0.txt')).toBe(true);
    expect(second!.path.endsWith('/1.txt')).toBe(true);
  });

  it('写失败退回 null（调用方走现有截断）', () => {
    const spill = new ToolOutputSpill({
      workspacePath: path.join(tmpdir(), 'kepcup-missing-workspace', String(Date.now())),
      runId: 'run_1',
      maxChars: 5,
    });
    expect(spill.spill('123456')).toBeNull();
  });

  it('不写穿 .tool-output 符号链接', () => {
    const workspacePath = tempWorkspace();
    const outside = mkdtempSync(path.join(tmpdir(), 'kepcup-spill-outside-'));
    roots.push(outside);
    mkdirSync(workspacePath, { recursive: true });
    symlinkSync(outside, path.join(workspacePath, '.tool-output'));
    const spill = new ToolOutputSpill({ workspacePath, runId: 'run_1', maxChars: 5 });
    expect(spill.spill('123456')).toBeNull();
    let wroteOutside = false;
    try {
      readFileSync(path.join(outside, 'run_1', '0.txt'));
      wroteOutside = true;
    } catch {
      // expected
    }
    expect(wroteOutside).toBe(false);
  });
});

describe('clearToolOutputSpill', () => {
  it('删除本 run 的落盘文件，可重复调用', () => {
    const workspacePath = tempWorkspace();
    mkdirSync(workspacePath, { recursive: true });
    const spill = new ToolOutputSpill({ workspacePath, runId: 'run_1', maxChars: 5 });
    const result = spill.spill('123456');
    expect(result).not.toBeNull();
    writeFileSync(path.join(workspacePath, '.tool-output', 'keep.txt'), 'x');

    clearToolOutputSpill(workspacePath, 'run_1');
    expect(() => readFileSync(result!.path)).toThrow();
    expect(readFileSync(path.join(workspacePath, '.tool-output', 'keep.txt'), 'utf8')).toBe('x');
    expect(() => clearToolOutputSpill(workspacePath, 'run_1')).not.toThrow();
  });
});

describe('spillToolResult', () => {
  it('保留 <untrusted> 包裹并把内容换成摘要', () => {
    const workspacePath = tempWorkspace();
    mkdirSync(workspacePath, { recursive: true });
    const spill = new ToolOutputSpill({
      workspacePath,
      runId: 'run_1',
      maxChars: 40,
      headChars: 10,
      tailChars: 10,
    });
    const content = `<untrusted>\n${'x'.repeat(40_000)}\n</untrusted>`;
    const result = spillToolResult({ ok: true, content }, spill);
    expect(result.content.startsWith('<untrusted>\n')).toBe(true);
    expect(result.content.endsWith('\n</untrusted>')).toBe(true);
    expect(result.content).toContain('.tool-output');
    expect(result.content.length).toBeLessThan(content.length);
  });

  it('短结果原样返回', () => {
    const workspacePath = tempWorkspace();
    mkdirSync(workspacePath, { recursive: true });
    const spill = new ToolOutputSpill({ workspacePath, runId: 'run_1' });
    const result = { ok: true, content: 'short' };
    expect(spillToolResult(result, spill)).toBe(result);
  });
});

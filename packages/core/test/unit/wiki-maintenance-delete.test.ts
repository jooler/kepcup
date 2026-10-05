import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildMaintenanceTools } from '../../src/wiki/maintenance-tools.js';

/**
 * P09 wiki maintenance loop 的 delete 工具（docs/dev/phases/P09-wiki.md 任务
 * 表维护 loop 能力）：只能删除 pages/ 下的页面文件——index.md、log.md、
 * raw/、SCHEMA.md 与越界路径全部拒绝。删除本身由平台以 add -A 提交进 git
 * 历史（可回滚恢复），工具只负责把文件从工作区移除。
 */

describe('P09 wiki：维护 loop delete 工具的作用域（仅 pages/ 下文件）', () => {
  let root: string;
  let del: (path: string) => Promise<{ ok: boolean; content: string; errorCode?: string }>;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wiki-del-tool-'));
    mkdirSync(path.join(root, 'pages'), { recursive: true });
    mkdirSync(path.join(root, 'raw'), { recursive: true });
    writeFileSync(path.join(root, 'pages', 'obsolete.md'), '# 过时\n\n内容。');
    writeFileSync(path.join(root, 'pages', 'keep.md'), '# 保留\n\n内容。');
    writeFileSync(path.join(root, 'raw', '20261001-abcdef123456-src.md'), '原始资料');
    writeFileSync(path.join(root, 'SCHEMA.md'), '# Wiki 维护规范');
    writeFileSync(path.join(root, 'index.md'), '# 目录');
    writeFileSync(path.join(root, 'log.md'), '# 变更日志');
    mkdirSync(path.join(root, 'pages', 'subdir'), { recursive: true });

    const tools = buildMaintenanceTools({ wikiRoot: root });
    const tool = tools.find((t) => t.name === 'delete');
    expect(tool).toBeDefined();
    del = async (target) =>
      (await tool!.execute({ path: target } as never, {
        identity: {
          runId: 'run_test',
          botId: 'bot_test',
          conversationId: null,
          loopType: 'wiki_maintenance',
        },
        signal: new AbortController().signal,
        terminate: () => {},
        progress: () => {},
      })) as { ok: boolean; content: string; errorCode?: string };
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('删除 pages/ 下的页面文件：成功且文件从工作区消失', async () => {
    const result = await del('pages/obsolete.md');
    expect(result.ok).toBe(true);
    expect(result.content).toContain('pages/obsolete.md');
    expect(existsSync(path.join(root, 'pages', 'obsolete.md'))).toBe(false);
  });

  it('受保护条目全部拒绝：index.md / log.md / SCHEMA.md / raw/ / pages 目录本身', async () => {
    const protectedTargets = [
      'index.md',
      'log.md',
      'SCHEMA.md',
      'raw/20261001-abcdef123456-src.md',
      'pages',
    ];
    for (const target of protectedTargets) {
      const result = await del(target);
      expect(result.ok, target).toBe(false);
      expect(result.errorCode, target).toBe('PATH_OUT_OF_SCOPE');
    }
    // 受保护文件原样保留。
    expect(existsSync(path.join(root, 'index.md'))).toBe(true);
    expect(existsSync(path.join(root, 'log.md'))).toBe(true);
    expect(existsSync(path.join(root, 'SCHEMA.md'))).toBe(true);
    expect(existsSync(path.join(root, 'raw', '20261001-abcdef123456-src.md'))).toBe(true);
  });

  it('目录与越界路径拒绝：pages 子目录、目录穿越、绝对路径', async () => {
    for (const target of ['pages/subdir', 'pages/../log.md', '../outside.md', '/etc/passwd']) {
      const result = await del(target);
      expect(result.ok, target).toBe(false);
    }
    expect(existsSync(path.join(root, 'pages', 'subdir'))).toBe(true);
  });

  it('不存在的页面：NOT_FOUND', async () => {
    const result = await del('pages/missing.md');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
    // 其余页面不受影响。
    expect(existsSync(path.join(root, 'pages', 'keep.md'))).toBe(true);
  });
});

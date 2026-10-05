import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { resolvePaths } from '../../src/infra/paths.js';
import { validateDraft, shQuote } from '../../src/skills/authoring.js';
import type { SandboxBackend } from '../../src/sandbox/types.js';

const dir = mkdtempSync(path.join(tmpdir(), 'skills-validate-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * BR-P08-008：语法检查命令把草稿文件名拼进 shell。用一个「真执行命令」的
 * 假沙箱（bash -c），文件名带单引号/空格时旧实现会命令变形，新实现正常。
 */
function realShellSandbox(): SandboxBackend {
  return {
    kind: 'srt',
    async probe() {
      return { available: true };
    },
    async exec(input) {
      const result = spawnSync('bash', ['-c', input.command], {
        cwd: input.cwd,
        encoding: 'utf8',
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: false,
        violations: [],
      };
    },
  };
}

function paths() {
  return resolvePaths(path.join(dir, `home-${Math.random().toString(36).slice(2, 8)}`));
}

function makeDraft(name: string, files: Record<string, string>): string {
  const draftsDir = path.join(dir, `draft-${Math.random().toString(36).slice(2, 8)}`);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(draftsDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return draftsDir;
}

const SKILL_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: 描述\n---\n正文`;

describe('skills/validateDraft：语法检查命令的 shell 引用（BR-P08-008）', () => {
  it('shQuote 正确转义单引号', () => {
    expect(shQuote("it's a script.sh")).toBe(`'it'\\''s a script.sh'`);
    expect(shQuote('plain.sh')).toBe(`'plain.sh'`);
  });

  it('文件名含单引号与空格：语法检查正常执行并给出正确结论（通过）', async () => {
    const name = 'quoted-skill';
    const draftsDir = makeDraft(name, {
      'SKILL.md': SKILL_MD(name),
      // 单引号 + 空格：旧实现 `'${rel}'` 拼接会让 shell 把它拆成多个词
      [`scripts/it's a script.sh`]: '#!/usr/bin/env bash\necho ok',
      'scripts/with space.sh': '#!/usr/bin/env bash\necho ok',
    });
    const verdict = await validateDraft({
      draftsDir,
      name,
      sandbox: realShellSandbox(),
      paths: paths(),
      botId: 'bot_x',
    });
    expect(verdict.ok).toBe(true);
  });

  it('文件名含单引号：脚本真有语法错误时结论正确（失败且原因指向该文件）', async () => {
    const name = 'quoted-bad';
    const draftsDir = makeDraft(name, {
      'SKILL.md': SKILL_MD(name),
      [`scripts/it's broken.sh`]: '#!/usr/bin/env bash\nfi fi fi',
    });
    const verdict = await validateDraft({
      draftsDir,
      name,
      sandbox: realShellSandbox(),
      paths: paths(),
      botId: 'bot_x',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('shell 语法检查');
    expect(verdict.reason).toContain("it's broken.sh");
  });

  it('Node 脚本文件名含单引号：node --check 正常执行', async () => {
    const name = 'quoted-node';
    const draftsDir = makeDraft(name, {
      'SKILL.md': SKILL_MD(name),
      [`scripts/it's fine.mjs`]: 'export const x = 1;',
    });
    const verdict = await validateDraft({
      draftsDir,
      name,
      sandbox: realShellSandbox(),
      paths: paths(),
      botId: 'bot_x',
    });
    expect(verdict.ok).toBe(true);
  });
});

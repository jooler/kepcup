import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  parseFlatFrontmatter,
  parseSkillDir,
  sanitizeSkillName,
  splitFrontmatter,
  truncateDescription,
} from '../../src/skills/parse.js';
import { SKILL_DESCRIPTION_MAX_CHARS } from '@kepcup/shared';

const dir = mkdtempSync(path.join(tmpdir(), 'skills-parse-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSkill(name: string, markdown: string): string {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), markdown);
  return skillDir;
}

describe('skills/parse（P08 任务 1：frontmatter 校验，pi loadSkills 优先）', () => {
  it('合法 frontmatter：name/description 必填，extras 读取 permissions/sandbox/test', () => {
    const skillDir = makeSkill(
      'full',
      [
        '---',
        'name: full',
        'description: 一个用于验证解析的技能',
        'permissions:',
        '  - network',
        '  - credentials',
        'sandbox: enhanced',
        'test: bash tests/run.sh',
        '---',
        '',
        '# 正文',
      ].join('\n'),
    );
    const parsed = parseSkillDir(skillDir);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('full');
    expect(parsed!.description).toBe('一个用于验证解析的技能');
    expect(parsed!.extras.permissions).toEqual(['network', 'credentials']);
    expect(parsed!.extras.sandbox).toBe('enhanced');
    expect(parsed!.extras.test).toBe('bash tests/run.sh');
  });

  it('缺少 description 时 pi 不识别为技能（返回 null）', () => {
    const skillDir = makeSkill('no-desc', '---\nname: no-desc\n---\n正文没有 description');
    expect(parseSkillDir(skillDir)).toBeNull();
  });

  it('frontmatter 缺 name 时回退到目录名（pi 行为一致）', () => {
    const skillDir = makeSkill('dirname-fallback', '---\ndescription: 只有描述\n---\n正文');
    const parsed = parseSkillDir(skillDir);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('dirname-fallback');
  });

  it('没有 SKILL.md 的目录不是技能', () => {
    const empty = path.join(dir, 'empty-dir');
    mkdirSync(empty, { recursive: true });
    expect(parseSkillDir(empty)).toBeNull();
  });

  it('描述超过 1024 字符被截断并注明', () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS + 100);
    expect(truncateDescription(long).length).toBeLessThan(long.length);
    expect(truncateDescription(long)).toContain('已截断');
    const short = '短描述';
    expect(truncateDescription(short)).toBe(short);
  });

  it('splitFrontmatter：无 frontmatter 返回 null；CRLF 归一化', () => {
    expect(splitFrontmatter('普通正文')).toBeNull();
    expect(splitFrontmatter('---\nkey: value\n---\nbody')).toEqual({
      frontmatter: 'key: value',
      body: 'body',
    });
    expect(splitFrontmatter('---\r\nkey: value\r\n---\r\nbody\r\n')).toEqual({
      frontmatter: 'key: value',
      body: 'body\n',
    });
  });

  it('parseFlatFrontmatter：行内列表、引号、列表项与标量', () => {
    const map = parseFlatFrontmatter(
      [
        'name: demo',
        "tags: [a, 'b, c', d]",
        'permissions:',
        '- network',
        '- credentials',
        'sandbox: "enhanced"',
        'empty:',
      ].join('\n'),
    );
    expect(map['name']).toBe('demo');
    expect(map['tags']).toEqual(['a', 'b, c', 'd']);
    expect(map['permissions']).toEqual(['network', 'credentials']);
    expect(map['sandbox']).toBe('enhanced');
    expect(map['empty']).toEqual([]);
  });

  it('sanitizeSkillName：小写化、非法字符转连字符、去首尾连字符、长度上限', () => {
    expect(sanitizeSkillName('Deploy Check')).toBe('deploy-check');
    expect(sanitizeSkillName('  --weird__name--  ')).toBe('weird-name');
    expect(sanitizeSkillName('')).toBeNull();
    expect(sanitizeSkillName('---')).toBeNull();
    expect(sanitizeSkillName('x'.repeat(100))).toHaveLength(64);
    expect(sanitizeSkillName('-starts-with-hyphen')).toBe('starts-with-hyphen');
  });
});

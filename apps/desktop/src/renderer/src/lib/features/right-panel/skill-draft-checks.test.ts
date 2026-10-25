import { describe, expect, it } from 'vitest';

import { parseSkillDraftChecks } from './skill-draft-checks';

/** kepcup-release 草稿的真实校验输出（节选，末行 O 是 500 字符截断的尾巴）。 */
const REAL_SAMPLE = [
  '技能测试未通过：ok   scripts/preflight.sh 存在且语法正确',
  'ok   scripts/last-tag.sh 存在且语法正确',
  'ok   非法版本号触发 FAIL',
  'ok   preflight 报告分支',
  '  缺少: 上一个 tag: v1.0.0',
  'FAIL preflight 报告 tag 区间',
  '== kepcup 发版体检 ==',
  'OK    当前分支: main',
  'O',
].join('\n');

describe('parseSkillDraftChecks', () => {
  it('把 TAP 风格输出还原成逐条检查：ok/FAIL/OK、续行并入上一条、分节行无勾叉', () => {
    expect(parseSkillDraftChecks(REAL_SAMPLE)).toEqual([
      { kind: 'pass', label: 'scripts/preflight.sh 存在且语法正确' },
      { kind: 'pass', label: 'scripts/last-tag.sh 存在且语法正确' },
      { kind: 'pass', label: '非法版本号触发 FAIL' },
      { kind: 'pass', label: 'preflight 报告分支 缺少: 上一个 tag: v1.0.0' },
      { kind: 'fail', label: 'preflight 报告 tag 区间' },
      { kind: 'info', label: 'kepcup 发版体检' },
      { kind: 'pass', label: '当前分支: main' },
      { kind: 'info', label: 'O' },
    ]);
  });

  it('半角冒号前缀同样剥离', () => {
    const checks = parseSkillDraftChecks('技能测试未通过: ok a\nFAIL b');
    expect(checks).toEqual([
      { kind: 'pass', label: 'a' },
      { kind: 'fail', label: 'b' },
    ]);
  });

  it('标签里的 ok/FAIL 字样不影响首词判定（「非法版本号触发 FAIL」是 pass 项）', () => {
    const checks = parseSkillDraftChecks('ok 非法版本号触发 FAIL');
    expect(checks).toEqual([{ kind: 'pass', label: '非法版本号触发 FAIL' }]);
  });

  it('单句原因（无 ok/FAIL 行）返回 null，调用方退回整段文本', () => {
    expect(parseSkillDraftChecks('SKILL.md 缺少 description')).toBeNull();
  });

  it('语法检查的 Traceback（多行、无标记行）返回 null', () => {
    const traceback = [
      'Python 语法检查：scripts/create_release.py 未通过：Traceback (most recent call last):',
      '  File "scripts/create_release.py", line 197, in _run_module_as_main',
      'SyntaxError: invalid syntax',
    ].join('\n');
    expect(parseSkillDraftChecks(traceback)).toBeNull();
  });

  it('null 与空串返回 null', () => {
    expect(parseSkillDraftChecks(null)).toBeNull();
    expect(parseSkillDraftChecks('')).toBeNull();
    expect(parseSkillDraftChecks('   ')).toBeNull();
  });
});

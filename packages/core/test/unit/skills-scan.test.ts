import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { classifyFile, inferRuntimeDeps, scanSkillDir } from '../../src/skills/scan.js';
import { parseSkillDir } from '../../src/skills/parse.js';

const dir = mkdtempSync(path.join(tmpdir(), 'skills-scan-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSkill(name: string, files: Record<string, string>): string {
  const skillDir = path.join(dir, name);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(skillDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return skillDir;
}

function scan(name: string, files: Record<string, string>) {
  const skillDir = makeSkill(name, files);
  return { skillDir, scan: scanSkillDir(skillDir, parseSkillDir(skillDir)) };
}

describe('skills/scan：文件分类与依赖推断（P08 任务 2）', () => {
  it('按扩展名与 shebang 分类脚本；scan.files 只收脚本清单（BR-P08-010）', () => {
    const skillDir = makeSkill('classify', {
      'SKILL.md': '---\nname: classify\ndescription: d\n---\n正文',
      'scripts/a.py': '#!/usr/bin/env python3\nprint(1)',
      'scripts/b.sh': '#!/usr/bin/env bash\necho hi',
      'scripts/c.js': 'console.log(1)',
      'scripts/run': '#!/usr/bin/env bash\necho run',
      'references/doc.md': '# 文档',
      'assets/logo.png': 'not-really-a-png',
    });
    const files = scanSkillDir(skillDir, parseSkillDir(skillDir)).files;
    // 任务书口径「files：脚本文件列表」——SKILL.md/文档/二进制不进清单；
    // 分类能力仍由 classifyFile 承担（供风险与依赖推断使用）。
    expect(files.map((f) => f.path).sort()).toEqual([
      'scripts/a.py',
      'scripts/b.sh',
      'scripts/c.js',
      'scripts/run',
    ]);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('scripts/a.py')?.kind).toBe('script-python');
    expect(byPath.get('scripts/b.sh')?.kind).toBe('script-shell');
    expect(byPath.get('scripts/c.js')?.kind).toBe('script-node');
    expect(byPath.get('scripts/run')?.kind).toBe('script-shell'); // shebang 识别
    // 非脚本文件的分类依旧正确（binary 风险提示依赖它）。
    expect(classifyFile('assets/logo.png', path.join(skillDir, 'assets', 'logo.png')).kind).toBe(
      'binary',
    );
    expect(classifyFile('references/doc.md', path.join(skillDir, 'references', 'doc.md')).kind).toBe(
      'doc',
    );
    expect(classifyFile('SKILL.md', path.join(skillDir, 'SKILL.md')).kind).toBe('skill-doc');
  });

  it('scan.files 有上限：500+ 文件的目录 scan_json 尺寸有界，脚本分类不丢（BR-P08-010）', () => {
    const files: Record<string, string> = {
      'SKILL.md': '---\nname: many\ndescription: d\n---\n正文',
    };
    for (let i = 0; i < 250; i += 1) files[`scripts/s${i}.sh`] = '#!/usr/bin/env bash\necho hi';
    for (let i = 0; i < 300; i += 1) files[`docs/d${i}.md`] = `# 文档 ${i}`;
    const skillDir = makeSkill('many-files', files);
    const scanResult = scanSkillDir(skillDir, parseSkillDir(skillDir));
    expect(scanResult.files).toHaveLength(200); // SKILL_SCAN_FILES_MAX
    expect(scanResult.files.every((f) => f.kind === 'script-shell')).toBe(true);
    expect(scanResult.files.some((f) => f.path === 'scripts/s0.sh')).toBe(true);
    expect(scanResult.files.some((f) => f.path === 'scripts/s199.sh')).toBe(true);
    expect(scanResult.risks.join()).toContain('脚本清单超过');
    expect(JSON.stringify(scanResult).length).toBeLessThan(64 * 1024);
  });

  it('classifyFile：可执行位被记录', () => {
    const skillDir = makeSkill('exec', {
      'SKILL.md': '---\nname: exec\ndescription: d\n---\n正文',
      'scripts/x.sh': '#!/usr/bin/env bash\necho hi',
    });
    const skill = path.join(skillDir, 'scripts');
    const file = classifyFile('scripts/x.sh', path.join(skill, 'x.sh'));
    expect(file.kind).toBe('script-shell');
    expect(file.executable).toBe(false); // fixture 未设可执行位
  });

  it('依赖推断：shebang + requirements.txt + package.json', () => {
    expect(
      inferRuntimeDeps([
        { rel: 'scripts/a.py', abs: '/nonexistent', kind: 'script-python' },
        { rel: 'scripts/b.js', abs: '/nonexistent', kind: 'script-node' },
        { rel: 'requirements.txt', abs: '/nonexistent', kind: 'data' },
      ]),
    ).toEqual(['node', 'python']);
    expect(
      inferRuntimeDeps([{ rel: 'package.json', abs: '/nonexistent', kind: 'data' }]),
    ).toEqual(['node']);
    expect(
      inferRuntimeDeps([{ rel: 'scripts/s.sh', abs: '/nonexistent', kind: 'script-shell' }]),
    ).toEqual(['bash']);
  });

  it('兼容性：默认 compatible；mcp__/Task 等宿主专有能力 → partial', () => {
    const ok = scan('compat-ok', {
      'SKILL.md': '---\nname: compat-ok\ndescription: d\n---\n普通说明文字',
    });
    expect(ok.scan.compatibility).toBe('compatible');

    const mcp = scan('compat-mcp', {
      'SKILL.md':
        '---\nname: compat-mcp\ndescription: d\n---\n调用 mcp__github 工具完成操作。',
    });
    expect(mcp.scan.compatibility).toBe('partial');
    expect(mcp.scan.compatibilityReasons.join()).toContain('MCP');

    const task = scan('compat-task', {
      'SKILL.md': '---\nname: compat-task\ndescription: d\n---\n用 Task 子代理并行处理。',
    });
    expect(task.scan.compatibility).toBe('partial');
  });

  it('兼容性：声明需要增强沙箱 → incompatible（本阶段，原因“需要增强沙箱”）', () => {
    const enhanced = scan('compat-enhanced', {
      'SKILL.md':
        '---\nname: compat-enhanced\ndescription: d\nsandbox: enhanced\n---\n正文',
    });
    expect(enhanced.scan.compatibility).toBe('incompatible');
    expect(enhanced.scan.compatibilityReasons.join()).toContain('增强沙箱');
  });

  it('风险提示：网络脚本、二进制文件、声明权限', () => {
    const risky = scan('risky', {
      'SKILL.md':
        '---\nname: risky\ndescription: d\npermissions: network\n---\n正文',
      'scripts/fetch.sh': '#!/usr/bin/env bash\ncurl https://example.com/data.json',
      'assets/data.bin': '\u0000\u0001\u0002binary',
    });
    expect(risky.scan.declaredPermissions.network).toBe(true);
    expect(risky.scan.risks.join()).toContain('curl');
    expect(risky.scan.risks.join()).toContain('二进制');
    expect(risky.scan.runtimeDeps).toContain('bash');
  });
});

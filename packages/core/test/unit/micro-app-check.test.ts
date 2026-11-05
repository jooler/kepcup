import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { microAppDraftIssues, readMicroAppDraftBundle } from '../../src/widgets/check/micro-app-check.js';

/**
 * 微应用草稿扫描（D112 P3，设计 55 §11）：清单 / 包 / 能力面 / 回退 / 成本 / 联网用途 /
 * 宿主可用性。存量组件草稿（无 micro-app.json）不进这条路径（readMicroAppDraftBundle 为
 * null，runWidgetCheck 零变化）。
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDraft(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'micro-app-check-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

const HTML = '<!DOCTYPE html><html><body><input id="say"><script>kepcup.storage.set("a", 1);</script></body></html>';

const BASE_MANIFEST = {
  spec: 'kepcup-micro-app/1',
  slug: 'demo',
  name: 'demo',
  description: '',
  entry: 'index.html',
  permissions: ['storage.kv'],
  net: { mode: 'none' },
};

describe('micro-app 草稿扫描', () => {
  test('存量组件草稿（无清单）返回 null', () => {
    const dir = makeDraft({ 'index.html': HTML });
    expect(readMicroAppDraftBundle(dir)).toBeNull();
  });

  test('合法清单 + 全部声明能力都被调用 → 无问题', () => {
    const dir = makeDraft({
      'index.html': HTML,
      'micro-app.json': JSON.stringify(BASE_MANIFEST),
    });
    const bundle = readMicroAppDraftBundle(dir)!;
    expect(bundle.files).toEqual([]);
    expect(microAppDraftIssues({ bundle, html: HTML, spec: '> demo' })).toEqual([]);
  });

  test('清单不合法 → app.manifest-invalid 且不再做能力面判定', () => {
    const dir = makeDraft({
      'index.html': HTML,
      'micro-app.json': JSON.stringify({ ...BASE_MANIFEST, spec: 'nope/9', permissions: ['ai.chat'] }),
    });
    const issues = microAppDraftIssues({
      bundle: readMicroAppDraftBundle(dir)!,
      html: 'kepcup.ai.chat({})',
      spec: null,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'app.manifest-invalid', level: 'error', blocking: true });
  });

  test('调用未声明能力 → app.permission-undeclared', () => {
    const dir = makeDraft({
      'index.html': HTML,
      'micro-app.json': JSON.stringify(BASE_MANIFEST),
    });
    const issues = microAppDraftIssues({
      bundle: readMicroAppDraftBundle(dir)!,
      html: `${HTML}<script>kepcup.ai.chat({messages: []});</script>`,
      spec: '> demo',
    });
    expect(issues.map((issue) => issue.rule)).toContain('app.permission-undeclared');
  });

  // 反斜杠是 POSIX 专属文件名成分：Windows 上 writeFileSync 会把它当分隔符，
  // 根本造不出 isSafeMicroAppPath 拒绝的包路径，所以这条只能在 POSIX 上验。
  test.skipIf(process.platform === 'win32')('包路径含反斜杠 → app.bundle-invalid', () => {
    const dir = makeDraft({
      'index.html': HTML,
      'micro-app.json': JSON.stringify(BASE_MANIFEST),
      // macOS 文件名允许反斜杠：真实 FS 上能造出 isSafeMicroAppPath 拒绝的包路径。
      'assets\\evil.css': 'body{}',
      'assets/main.css': 'body{color:red}',
    });
    const issues = microAppDraftIssues({
      bundle: readMicroAppDraftBundle(dir)!,
      html: `${HTML}<script>kepcup.ai.chat({messages: []});</script>`,
      spec: '> demo',
    });
    const rules = issues.map((issue) => issue.rule);
    expect(rules).toContain('app.permission-undeclared');
    expect(rules).toContain('app.bundle-invalid');
    expect(readMicroAppDraftBundle(dir)!.files.map((file) => file.path).sort()).toEqual([
      'assets/main.css',
      'assets\\evil.css',
    ]);
  });

  test('声明了从未调用的能力 → app.permission-overbroad', () => {
    const dir = makeDraft({
      'index.html': HTML,
      'micro-app.json': JSON.stringify({ ...BASE_MANIFEST, permissions: ['storage.kv', 'media.listen'] }),
    });
    const issues = microAppDraftIssues({ bundle: readMicroAppDraftBundle(dir)!, html: HTML, spec: '> demo' });
    expect(issues.map((issue) => issue.rule)).toContain('app.permission-overbroad');
  });

  test('声明环境能力但页面没有文本输入 → app.fallback-missing；有 <input> 不报', () => {
    const manifest = JSON.stringify({ ...BASE_MANIFEST, permissions: ['ai.chat'] });
    const noInput = makeDraft({ 'index.html': '<p>kepcup.ai.chat</p>', 'micro-app.json': manifest });
    const withInput = makeDraft({
      'index.html': '<textarea id="x"></textarea><script>kepcup.ai.chat({messages:[]})</script>',
      'micro-app.json': manifest,
    });
    expect(
      microAppDraftIssues({ bundle: readMicroAppDraftBundle(noInput)!, html: '<p>x</p>', spec: '> d' }).map((i) => i.rule),
    ).toContain('app.fallback-missing');
    expect(
      microAppDraftIssues({
        bundle: readMicroAppDraftBundle(withInput)!,
        html: '<textarea></textarea>',
        spec: '> d',
      }).map((i) => i.rule),
    ).not.toContain('app.fallback-missing');
  });

  test('ai.chat 声明但 spec 没写成本 → app.cost-estimate-missing；net=open 没写用途 → app.net-open-default', () => {
    const manifest = JSON.stringify({ ...BASE_MANIFEST, permissions: ['ai.chat'], net: { mode: 'open' } });
    const dir = makeDraft({
      'index.html': '<textarea></textarea><script>kepcup.ai.chat({messages:[]})</script>',
      'micro-app.json': manifest,
    });
    const issues = microAppDraftIssues({
      bundle: readMicroAppDraftBundle(dir)!,
      html: '<textarea></textarea>',
      spec: '> 只是一句话说明',
    });
    const rules = issues.map((issue) => issue.rule);
    expect(rules).toContain('app.cost-estimate-missing');
    expect(rules).toContain('app.net-open-default');
    const withBoth = microAppDraftIssues({
      bundle: readMicroAppDraftBundle(dir)!,
      html: '<textarea></textarea>',
      spec: '> 每轮约 500 token 成本；联网调用词典 API，断网显示缓存',
    });
    expect(withBoth.map((issue) => issue.rule)).not.toContain('app.cost-estimate-missing');
    expect(withBoth.map((issue) => issue.rule)).not.toContain('app.net-open-default');
  });

  test('宿主缺配置 → app.capability-unavailable（warning，不阻断）', () => {
    const manifest = JSON.stringify({ ...BASE_MANIFEST, permissions: ['storage.kv', 'ai.chat'] });
    const dir = makeDraft({
      'index.html': '<textarea></textarea><script>kepcup.ai.chat({messages:[]})</script>',
      'micro-app.json': manifest,
    });
    const issues = microAppDraftIssues({
      bundle: readMicroAppDraftBundle(dir)!,
      html: '<textarea></textarea>',
      spec: '> 成本：每轮 100 token',
      capabilityAvailability: (capability) =>
        capability === 'ai.chat' ? { available: false, reason: '未配置模型' } : { available: true },
    });
    const issue = issues.find((item) => item.rule === 'app.capability-unavailable');
    expect(issue?.level).toBe('warning');
    expect(issue?.blocking).toBe(false);
    expect(issue?.message).toContain('未配置模型');
  });
});

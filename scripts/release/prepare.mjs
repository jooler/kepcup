#!/usr/bin/env node
// Prepares a release on the version branch (docs/dev/06-release.md 「发一个版本」).
//
//   node scripts/release/prepare.mjs <X.Y.Z | patch | minor | major> [--force]
//
// 1. bumps apps/desktop/package.json "version" (the only version electron-builder reads);
// 2. refuses a version whose tag v<version> already exists locally or on origin
//    (release.yml skips a main push whose tag exists, so a forgotten bump ships nothing);
// 3. creates docs/releases/v<version>.md — the GitHub Release body — from the commits
//    since the last tag, unless the file exists.
// Nothing is committed: review the diff, edit the notes, commit on the version branch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appVersion, desktopPackageJson, repoDir, run, SEMVER } from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const target = args.find((arg) => !arg.startsWith('--'));
if (target === undefined) {
  console.error(
    'usage: node scripts/release/prepare.mjs <X.Y.Z | patch | minor | major> [--force]',
  );
  process.exit(2);
}

const current = appVersion();
const currentParts = SEMVER.exec(current);
if (currentParts === null)
  throw new Error(`apps/desktop/package.json version "${current}" is not semver`);

function bump(kind) {
  const [major, minor, patch] = currentParts.slice(1, 4).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  // A pre-release (0.3.0-beta.2) bumps to its own final version (0.3.0).
  return currentParts[4] !== undefined
    ? `${major}.${minor}.${patch}`
    : `${major}.${minor}.${patch + 1}`;
}

const next = ['major', 'minor', 'patch'].includes(target) ? bump(target) : target.replace(/^v/, '');
if (!SEMVER.test(next)) throw new Error(`"${next}" is not a semver version (X.Y.Z or X.Y.Z-pre.N)`);
// release.yml never ships 0.0.0 (the pre-release placeholder) or pre-release versions.
if (next === '0.0.0' || next.includes('-')) {
  throw new Error(`"${next}": only X.Y.Z above 0.0.0 is released automatically`);
}
const tag = `v${next}`;

const localTag = run('git', ['tag', '--list', tag], { capture: true });
let remoteTag = '';
try {
  remoteTag = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { capture: true });
} catch {
  console.warn('[prepare] could not reach origin; only local tags were checked');
}
if ((localTag !== '' || remoteTag !== '') && !force) {
  throw new Error(`tag ${tag} already exists — that version has shipped; pick a higher one`);
}

const pkgText = readFileSync(desktopPackageJson, 'utf8');
const pkg = JSON.parse(pkgText);
pkg.version = next;
writeFileSync(desktopPackageJson, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`[prepare] apps/desktop/package.json: ${current} → ${next}`);

const notesFile = path.join(repoDir, 'docs/releases', `${tag}.md`);
if (existsSync(notesFile)) {
  console.log(`[prepare] ${path.relative(repoDir, notesFile)} exists — left as is`);
} else {
  // Latest release tag reachable from HEAD; empty on the first release.
  const lastTag =
    run('git', ['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname'], {
      capture: true,
    }).split('\n')[0] ?? '';
  // The first release would list the whole history: cap it, the notes get rewritten anyway.
  const range = lastTag === '' ? ['--max-count=50', 'HEAD'] : [`${lastTag}..HEAD`];
  const subjects = run('git', ['log', '--no-merges', '--format=- %s', ...range], {
    capture: true,
  });
  mkdirSync(path.dirname(notesFile), { recursive: true });
  writeFileSync(
    notesFile,
    [
      `# KepCup ${next}`,
      '',
      '<!-- GitHub Release 正文。发布前把下面的提交列表改写成用户能读懂的变更说明，删掉这行注释。 -->',
      '',
      '## 新增',
      '',
      '## 改进',
      '',
      '## 修复',
      '',
      `<details><summary>提交记录（${lastTag === '' ? '首个版本' : `自 ${lastTag}`}）</summary>`,
      '',
      subjects === '' ? '（无）' : subjects,
      '',
      '</details>',
      '',
    ].join('\n'),
  );
  console.log(`[prepare] wrote ${path.relative(repoDir, notesFile)} — edit it before merging`);
}

console.log(`
下一步：
  1. 编辑 docs/releases/${tag}.md（GitHub Release 正文）。
  2. 在版本分支提交：git add -A && git commit -m "release: ${tag}"
  3. 合并到 main 并推送：GitHub Actions 构建并发布 ${tag}。
  4. Release 发布后本地跑：node scripts/release/store-upload.mjs ${next}`);

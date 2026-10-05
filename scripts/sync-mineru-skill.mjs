/**
 * sync-mineru-skill.mjs — 同步 vendored 预置技能 mineru 的上游原文。
 *
 * `mineru/SKILL.md` 是 opendatalab/MinerU 官方 Agent Skill 的逐字拷贝
 * （AGPL-3.0，来源与锚点记录在 preset-skills/NOTICE.md）。本脚本只做机械
 * 搬运：从上游拉取 → 校验 frontmatter → 写入。不自动递增 catalog version、
 * 不自动改 NOTICE——同步是否采纳是发版决策，由人做。
 *
 * 用法：
 *   node scripts/sync-mineru-skill.mjs [ref]      # 拉取并写入（默认 master）
 *   node scripts/sync-mineru-skill.mjs --check    # 只比对，不一致退出码 1
 *   COMMIT=<sha> node scripts/sync-mineru-skill.mjs   # 锁定 commit 拉取
 *
 * 同步后必须（见 preset-skills/README.md）：
 *   1. 递增 catalog.json 中 mineru 条目的 version（市场「更新」按钮靠它）；
 *   2. 更新 NOTICE.md 的锚点 commit 与引入日期。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_REPO = 'opendatalab/MinerU';
const UPSTREAM_PATH = 'skills/mineru/SKILL.md';
const EXPECTED_NAME = 'mineru';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scriptDir, '..', 'apps/desktop/resources/preset-skills/mineru/SKILL.md');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const ref = args.find((arg) => !arg.startsWith('--')) ?? process.env.COMMIT ?? 'master';

/** 依次尝试的镜像源：raw 优先（实时），gcore.jsdelivr 对国内网络更可达，但其
 * 分支 ref 有 CDN 缓存（可能滞后约一天）——锚定式同步请传 commit SHA（不可变）；
 * `--check master` 报出的"不一致"若与 GitHub 网页矛盾，先怀疑缓存再动手。 */
function sourcesFor(givenRef) {
  return [
    `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${givenRef}/${UPSTREAM_PATH}`,
    `https://gcore.jsdelivr.net/gh/${UPSTREAM_REPO}@${givenRef}/${UPSTREAM_PATH}`,
  ];
}

async function fetchUpstream(givenRef) {
  let lastError;
  for (const url of sourcesFor(givenRef)) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        continue;
      }
      const text = await response.text();
      if (text.trim().length === 0) {
        lastError = new Error(`empty body from ${url}`);
        continue;
      }
      return text;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('all upstream sources failed');
}

/** frontmatter 必须声明目标技能名——防止镜像返回错误页或上游改名后静默错装。 */
function assertValidSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) throw new Error('上游内容缺少 frontmatter（--- 块）');
  if (!/^name:\s*mineru\s*$/m.test(match[1])) {
    throw new Error(`frontmatter name 不是 ${EXPECTED_NAME}（上游可能已改名，请人工核对）`);
  }
}

const upstream = await fetchUpstream(ref).catch((error) => {
  console.error(`拉取上游失败（ref=${ref}）：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
assertValidSkill(upstream);
const upstreamSha = createHash('sha256').update(upstream, 'utf8').digest('hex');

let localSha = null;
try {
  localSha = createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex');
} catch {
  // 本地不存在（首次引入）按不一致处理
}

console.log(`上游 ${UPSTREAM_REPO}@${ref} ${UPSTREAM_PATH}`);
console.log(`上游 sha256: ${upstreamSha}`);
console.log(localSha === null ? '本地状态: 文件不存在' : `本地 sha256: ${localSha}`);

if (upstreamSha === localSha) {
  console.log('已一致，无需同步。');
  process.exit(0);
}

if (checkOnly) {
  console.error('本地与上游不一致——运行 `node scripts/sync-mineru-skill.mjs` 同步，'
    + '然后递增 catalog.json 的 mineru version 并更新 NOTICE.md 锚点。');
  process.exit(1);
}

writeFileSync(target, upstream, 'utf8');
console.log(`已写入 ${path.relative(process.cwd(), target)}`);
console.log('后续动作（人工）：递增 catalog.json 的 mineru version；更新 NOTICE.md 锚点 commit 与日期。');

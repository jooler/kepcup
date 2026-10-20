#!/usr/bin/env node
// 更新镜像同步（docs/dev/06-release.md「更新镜像与选源」）：把已发布的 GitHub
// Release 资产复制到 R2（国际第二源）与阿里云 OSS（国内首选）。GitHub 是唯一
// 写入根，两个镜像只读；幂等可重跑。未配置任何镜像凭据时直接跳过（CI 不因缺
// 机密而失败，镜像晚几分钟只是国内用户晚几分钟收到更新）。
//
//   node scripts/release/sync-mirrors.mjs [v0.1.1] [--prune 3]
//
// tag 缺省取 apps/desktop/package.json 的版本；--prune N 只保留最近 N 个版本的
// 产物（默认不清理）。凭据读 .env.release「CI · 更新镜像」段（CI 里经
// sync-github-secrets.mjs 同步为 GitHub 机密）：
//   R2:  R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
//   OSS: OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY / OSS_BUCKET / OSS_ENDPOINT
// 每个镜像四项要么全填要么全空，半配置直接报错（凭据写一半是事故）。
//
// 顺序红线：安装包与 blockmap 先传、latest*.yml 清单最后传，且每个对象 PUT 后
// HEAD 回读校验大小、清单再逐字节比对——任何时刻镜像上的清单都不会指向缺失
// 或不一致的文件，半同步状态表现为「探测失败」（客户端落回其他源），而不是让
// 用户下到坏包。完整性由 latest.yml 里的 sha512 最终兜底，镜像不被信任。
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnvFile, repoDir, requireTool } from './lib.mjs';

const GH_REPO = process.env.GH_REPO || 'jooler/kepcup';

// --- 参数 -----------------------------------------------------------------

const args = process.argv.slice(2);
const pruneIndex = args.indexOf('--prune');
const pruneKeep = pruneIndex >= 0 ? Number(args[pruneIndex + 1]) : null;
if (pruneKeep !== null && (!Number.isInteger(pruneKeep) || pruneKeep < 1)) {
  console.error('[sync] --prune 需要一个正整数，如 --prune 3');
  process.exit(1);
}
const positional = args.filter(
  (arg, index) => !(index === pruneIndex || (pruneIndex >= 0 && index === pruneIndex + 1)),
);
const tag =
  positional[0] ??
  `v${JSON.parse(readFileSync(path.join(repoDir, 'apps/desktop/package.json'), 'utf8')).version}`;
if (!/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error(`[sync] 非法 tag：${tag}`);
  process.exit(1);
}
const version = tag.replace(/^v/, '');

const env = {
  ...parseEnvFile(path.join(repoDir, '.env.release')),
  ...process.env,
};

// --- 镜像目标（先解析凭据，全未配置时不动 gh） ------------------------------

/** 四项要么全有要么全无；返回 null = 未配置（跳过该镜像）。 */
function targetConfig(names) {
  const values = names.map((name) => env[name]?.trim() ?? '');
  if (values.every((value) => value.length === 0)) return null;
  if (values.some((value) => value.length === 0)) {
    throw new Error(`${names.join(' / ')}: 半配置——四项要么全填，要么全空`);
  }
  return values;
}

function r2Target() {
  const config = targetConfig([
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
  ]);
  if (config === null) return null;
  const [accountId, accessKeyId, secretAccessKey, bucket] = config;
  return {
    name: 'r2',
    // 虚拟主机式：https://<bucket>.<account>.r2.cloudflarestorage.com/<key>
    host: `${bucket}.${accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
    accessKeyId,
    secretAccessKey,
  };
}

function ossTarget() {
  const config = targetConfig([
    'OSS_ACCESS_KEY_ID',
    'OSS_SECRET_ACCESS_KEY',
    'OSS_BUCKET',
    'OSS_ENDPOINT',
  ]);
  if (config === null) return null;
  const [accessKeyId, secretAccessKey, bucket, endpoint] = config;
  return {
    name: 'oss',
    // 虚拟主机式：https://<bucket>.<endpoint>/<key>
    host: `${bucket}.${endpoint}`,
    // SigV4 scope 的 region：S3 兼容层用 endpoint 首段（如 oss-cn-hangzhou）。
    region: env.OSS_REGION?.trim() || endpoint.split('.')[0],
    accessKeyId,
    secretAccessKey,
  };
}

let targets;
try {
  targets = [r2Target(), ossTarget()].filter((target) => target !== null);
} catch (error) {
  console.error(`[sync] ${error.message}`);
  process.exit(1);
}
if (targets.length === 0) {
  console.log('[sync] 未配置任何镜像（R2/OSS 凭据为空），跳过。');
  process.exit(0);
}

// --- gh：拉取已发布 Release 的资产 ------------------------------------------

function ghRun(ghArgs) {
  const result = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `gh ${ghArgs.join(' ')} 失败：${result.stderr?.trim() ?? result.error?.message ?? ''}`,
    );
  }
  return result.stdout;
}

requireTool('gh', 'install GitHub CLI and run `gh auth login`');

const releaseInfo = JSON.parse(
  ghRun(['release', 'view', tag, '--repo', GH_REPO, '--json', 'isDraft,assets']),
);
if (releaseInfo.isDraft === true) {
  console.error(`[sync] ${tag} 还是草稿——镜像只同步已正式发布的版本`);
  process.exit(1);
}
const assetCount = releaseInfo.assets.length;

const tmpDir = mkdtempSync(path.join(tmpdir(), 'kepcup-sync-'));
try {
  ghRun(['release', 'download', tag, '--repo', GH_REPO, '--dir', tmpDir, '--clobber']);
  const assets = readdirSync(tmpDir).sort();
  if (assets.length === 0 || assets.length !== assetCount) {
    throw new Error(`下载到 ${assets.length} 个文件，Release 上有 ${assetCount} 个资产——数量不符`);
  }

  // 清单校验：latest*.yml 的 version 必须等于 tag，杜绝旧清单盖住新版本。
  const manifests = assets.filter((name) => /^latest.*\.yml$/.test(name));
  if (manifests.length === 0) throw new Error('Release 上没有任何 latest*.yml');
  for (const name of manifests) {
    const match = /^version:\s*(\S+)/m.exec(readFileSync(path.join(tmpDir, name), 'utf8'));
    if (match === null || match[1] !== version) {
      throw new Error(`${name} 的 version(${match?.[1] ?? '缺失'}) ≠ ${version}`);
    }
  }

  // 顺序红线：清单最后传。
  const files = [...assets.filter((name) => !/^latest.*\.yml$/.test(name)), ...manifests];

  const failures = [];
  for (const target of targets) {
    console.log(`[sync] ${target.name}: ${files.length} 个文件 → https://${target.host}/`);
    try {
      for (const name of files) {
        const body = readFileSync(path.join(tmpDir, name));
        const size = statSync(path.join(tmpDir, name)).size;
        await s3Fetch(target, 'PUT', name, { body });
        const head = await s3Fetch(target, 'HEAD', name, {});
        if (Number(head.headers.get('content-length')) !== size) {
          throw new Error(`PUT 后回读大小不符（本地 ${size}）`);
        }
        console.log(`[sync]   ${target.name} ← ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      }
      // 清单内容级校验：回读逐字节比对（小文件，只比大小不够安心）。
      for (const name of manifests) {
        const remote = await (await s3Fetch(target, 'GET', name, {})).text();
        if (remote !== readFileSync(path.join(tmpDir, name), 'utf8')) {
          throw new Error('清单回读内容不一致');
        }
      }
      if (pruneKeep !== null) await pruneOldVersions(target, pruneKeep);
    } catch (error) {
      failures.push(error);
      console.error(`[sync] ${target.name} 失败：${error.message}`);
    }
  }

  if (failures.length > 0) {
    console.error('[sync] 有镜像同步失败——GitHub 渠道不受影响，可重跑本脚本重试。');
    process.exit(1);
  }
  console.log(`[sync] ${tag} 镜像同步完成。`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// --- SigV4（PUT / HEAD / GET / DELETE / LIST，零依赖） ----------------------

function signedRequest(target, method, key, { body = null, query = [] } = {}) {
  const payloadHash = createHash('sha256')
    .update(body ?? '')
    .digest('hex');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `/${key.split('/').map(encodeURIComponent).join('/')}`;
  // URLSearchParams.sort() 原地排序且返回 undefined——不能链式接 toString()。
  const params = new URLSearchParams(query);
  params.sort();
  const canonicalQuery = query.length === 0 ? '' : params.toString();
  const canonicalHeaders = `host:${target.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const hmac = (keyMaterial, data) => createHmac('sha256', keyMaterial).update(data).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, dateStamp), target.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    url: `https://${target.host}${canonicalUri}${canonicalQuery === '' ? '' : `?${canonicalQuery}`}`,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

async function s3Fetch(target, method, key, options = {}) {
  const signed = signedRequest(target, method, key, options);
  const response = await fetch(signed.url, {
    method,
    headers: signed.headers,
    body: options.body ?? null,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `${target.name} ${method} ${key} → HTTP ${response.status}${text ? `：${text.slice(0, 400)}` : ''}`,
    );
  }
  return response;
}

/** 列出并删除 keep 个版本之外的产物（只动文件名里带 X.Y.Z 版本号的 key）。 */
async function pruneOldVersions(target, keep) {
  const versionOf = (key) => /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(key)?.[1] ?? null;
  const compareVersions = (a, b) => {
    const pa = a.split(/[.-]/).map(Number);
    const pb = b.split(/[.-]/).map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const keys = [];
  let token = null;
  do {
    const query =
      token === null
        ? [['list-type', '2']]
        : [
            ['list-type', '2'],
            ['continuation-token', token],
          ];
    const xml = await (await s3Fetch(target, 'GET', '', { query })).text();
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(match[1]);
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
  } while (token !== null);
  const versions = [...new Set(keys.map(versionOf).filter((v) => v !== null))].sort(
    compareVersions,
  );
  const stale = new Set(versions.slice(0, Math.max(0, versions.length - keep)));
  if (stale.size === 0) return;
  for (const key of keys) {
    const keyVersion = versionOf(key);
    if (keyVersion === null || !stale.has(keyVersion)) continue;
    await s3Fetch(target, 'DELETE', key, {});
    console.log(`[sync]   ${target.name} ✕ ${key}（保留最近 ${keep} 个版本）`);
  }
}

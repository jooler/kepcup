#!/usr/bin/env node
// Submits a released version to the Microsoft Store (docs/dev/06-release.md 「商店上传」).
//
//   node scripts/release/store-upload.mjs [X.Y.Z] [--download-only] [--draft] [--dry-run]
//
// Runs on any OS (gh + msstore are cross-platform; nothing is built locally). The MSIX is the one
// release.yml built for the tagged commit (workflow artifact "store-msix"), so the Store gets the
// exact bits behind the GitHub Release.
//
//   --download-only  fetch the MSIX into apps/desktop/release/store/vX.Y.Z/ and stop
//                    (the Store's FIRST submission must be made by hand in Partner Center)
//   --draft          upload but leave the submission uncommitted (review it in Partner Center)
//   --dry-run        print what would run; secrets redacted
//
// Credentials come from .env.release (see .env.release.example): MSSTORE_TENANT_ID,
// MSSTORE_SELLER_ID, MSSTORE_CLIENT_ID, MSSTORE_CLIENT_SECRET, MSSTORE_PRODUCT_ID.
// Mac App Store and Flathub are deliberately absent: see the doc for why.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { appVersion, loadReleaseEnv, repoDir, requireTool, run, SEMVER } from './lib.mjs';

const args = process.argv.slice(2);
const downloadOnly = args.includes('--download-only');
const draft = args.includes('--draft');
const dryRun = args.includes('--dry-run');
const version = (args.find((arg) => !arg.startsWith('--')) ?? appVersion()).replace(/^v/, '');
if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version`);
const tag = `v${version}`;

const env = loadReleaseEnv();
const repo = env.GH_REPO || 'jooler/kepcup';

requireTool('gh', 'install GitHub CLI and run `gh auth login`');
if (!downloadOnly) {
  if (!dryRun)
    requireTool(
      'msstore',
      'install the Microsoft Store Developer CLI: https://github.com/microsoft/msstore-cli',
    );
  const missing = [
    'MSSTORE_TENANT_ID',
    'MSSTORE_SELLER_ID',
    'MSSTORE_CLIENT_ID',
    'MSSTORE_CLIENT_SECRET',
    'MSSTORE_PRODUCT_ID',
  ].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`.env.release is missing: ${missing.join(', ')}`);
}

// 1. The GitHub Release must be published: the Store never gets ahead of the direct download.
const release = JSON.parse(
  run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,url'], { capture: true }),
);
if (release.isDraft) throw new Error(`${tag} is still a draft — wait for release.yml to finish`);
console.log(`[store] ${tag}: ${release.url}`);

// 2. The release.yml run that built the tagged commit carries the MSIX.
const sha = run('gh', ['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha'], { capture: true });
const runId = run(
  'gh',
  [
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    'release.yml',
    '--commit',
    sha,
    '--status',
    'success',
    '--limit',
    '1',
    '--json',
    'databaseId',
    '--jq',
    '.[0].databaseId',
  ],
  { capture: true },
);
if (runId === '') throw new Error(`no successful release.yml run for ${tag} (${sha.slice(0, 7)})`);

const outDir = path.join(repoDir, 'apps/desktop/release/store', tag);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
run('gh', ['run', 'download', runId, '--repo', repo, '--name', 'store-msix', '--dir', outDir]);
const packages = readdirSync(outDir).filter(
  (name) => name.endsWith('.appx') && !name.includes('arm64'),
);
if (packages.length !== 1) {
  throw new Error(`expected one x64 .appx in ${outDir}, found: ${packages.join(', ') || 'none'}`);
}
const msix = path.join(outDir, packages[0]);
console.log(`[store] MSIX: ${path.relative(repoDir, msix)}`);
if (downloadOnly) process.exit(0);

// 3. msstore: credentials (only flags are supported, so the secret is on argv for this one call).
function msstore(commandArgs, redacted = commandArgs) {
  console.log(`[store] msstore ${redacted.join(' ')}`);
  if (!dryRun) run('msstore', commandArgs);
}
const credentialArgs = [
  'reconfigure',
  '--tenantId',
  env.MSSTORE_TENANT_ID,
  '--sellerId',
  env.MSSTORE_SELLER_ID,
  '--clientId',
  env.MSSTORE_CLIENT_ID,
];
msstore(
  [...credentialArgs, '--clientSecret', env.MSSTORE_CLIENT_SECRET],
  [...credentialArgs, '--clientSecret', '***'],
);
// publish deletes any pending draft and recreates it from the last published submission, so
// listing/metadata edits belong after this step (or in Partner Center before the next one).
msstore(['publish', msix, '--appId', env.MSSTORE_PRODUCT_ID, ...(draft ? ['--noCommit'] : [])]);
console.log(
  draft
    ? '[store] uploaded as a draft — review and submit it in Partner Center'
    : '[store] submitted — certification usually takes from a few hours to 3 business days',
);

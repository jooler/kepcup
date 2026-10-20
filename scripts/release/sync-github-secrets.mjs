#!/usr/bin/env node
// Pushes the CI half of .env.release into GitHub Actions secrets/variables
// (docs/dev/06-release.md 「一次性准备」).
//
//   node scripts/release/sync-github-secrets.mjs [--dry-run]
//
// Only non-empty values are written; nothing is ever deleted. Certificate and key FILES are read
// from the *_PATH entries and uploaded base64-encoded. Values go to gh on stdin, never on argv.
// GOOGLE_CLIENT_ID/SECRET fall back to the repo-root .env, which apps/desktop/scripts/dist.mjs
// already reads for local builds.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadReleaseEnv, parseEnvFile, repoDir, requireTool, run } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
// Empty entries (the example's blanks) must not shadow a value from .env.
const env = {
  ...parseEnvFile(path.join(repoDir, '.env')),
  ...Object.fromEntries(Object.entries(loadReleaseEnv()).filter(([, value]) => value !== '')),
};
const repo = env.GH_REPO || 'jooler/kepcup';

function fileBase64(name) {
  const file = env[name];
  if (!file) return '';
  const resolved = path.resolve(repoDir, file.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (!existsSync(resolved)) throw new Error(`${name}: ${resolved} does not exist`);
  return readFileSync(resolved).toString('base64');
}

const secrets = {
  MAC_CSC_LINK: fileBase64('MAC_CSC_P12_PATH'),
  MAC_CSC_KEY_PASSWORD: env.MAC_CSC_KEY_PASSWORD,
  APPLE_API_KEY_BASE64: fileBase64('APPLE_API_KEY_P8_PATH'),
  APPLE_API_KEY_ID: env.APPLE_API_KEY_ID,
  APPLE_API_ISSUER: env.APPLE_API_ISSUER,
  WIN_CSC_LINK: fileBase64('WIN_CSC_P12_PATH'),
  WIN_CSC_KEY_PASSWORD: env.WIN_CSC_KEY_PASSWORD,
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
  // 更新镜像（scripts/release/sync-mirrors.mjs；全可选，单个镜像四项一起填）。
  R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: env.R2_BUCKET,
  OSS_ACCESS_KEY_ID: env.OSS_ACCESS_KEY_ID,
  OSS_SECRET_ACCESS_KEY: env.OSS_SECRET_ACCESS_KEY,
  OSS_BUCKET: env.OSS_BUCKET,
  OSS_ENDPOINT: env.OSS_ENDPOINT,
};
const variables = {
  MSSTORE_IDENTITY_NAME: env.MSSTORE_IDENTITY_NAME,
  MSSTORE_PUBLISHER: env.MSSTORE_PUBLISHER,
  MSSTORE_PUBLISHER_DISPLAY_NAME: env.MSSTORE_PUBLISHER_DISPLAY_NAME,
};

// Half-configured notarization makes electron-builder throw on the macOS runners.
const apple = [secrets.APPLE_API_KEY_BASE64, secrets.APPLE_API_KEY_ID, secrets.APPLE_API_ISSUER];
if (apple.some(Boolean) && !apple.every(Boolean)) {
  throw new Error(
    'APPLE_API_KEY_P8_PATH / APPLE_API_KEY_ID / APPLE_API_ISSUER: fill all three or none',
  );
}
const store = Object.values(variables);
if (store.some(Boolean) && !store.every(Boolean)) {
  throw new Error(
    'MSSTORE_IDENTITY_NAME / MSSTORE_PUBLISHER / MSSTORE_PUBLISHER_DISPLAY_NAME: fill all three or none',
  );
}

if (!dryRun) requireTool('gh', 'install GitHub CLI and run `gh auth login`');
for (const [kind, entries] of [
  ['secret', secrets],
  ['variable', variables],
]) {
  for (const [name, value] of Object.entries(entries)) {
    if (!value) {
      console.log(`[sync] ${kind} ${name}: empty, skipped`);
      continue;
    }
    console.log(`[sync] ${kind} ${name}${dryRun ? ' (dry run)' : ''}`);
    if (!dryRun) run('gh', [kind, 'set', name, '--repo', repo], { input: value });
  }
}

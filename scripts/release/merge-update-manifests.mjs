#!/usr/bin/env node
// Merges per-runner electron-updater manifests that share one name (docs/dev/06-release.md).
//
//   node scripts/release/merge-update-manifests.mjs <out.yml> <in1.yml> <in2.yml> ...
//
// macOS arm64 and x64 build on different runners and each writes its own latest-mac.yml listing
// only its own zip/dmg. Uploading both would let the last one win and strand the other arch.
// The merged file lists every file; electron-updater's MacUpdater picks the arm64 or x64 zip by
// file name. Top-level path/sha512 (read only by very old updaters) come from the x64 manifest.
//
// The input is electron-builder's fixed output shape, so this parses just that shape and fails
// loudly on anything else instead of pulling a YAML library into the publish job.
import { readFileSync, writeFileSync } from 'node:fs';

const [outFile, ...inputs] = process.argv.slice(2);
if (outFile === undefined || inputs.length < 2) {
  console.error('usage: merge-update-manifests.mjs <out.yml> <in1.yml> <in2.yml> [...]');
  process.exit(2);
}

function parse(file) {
  const manifest = { files: [], top: {} };
  let current = null;
  let inFiles = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (line === 'files:') {
      inFiles = true;
      continue;
    }
    const item = /^ {2}- (\w+): (.*)$/.exec(line);
    const field = /^ {4}(\w+): (.*)$/.exec(line);
    const top = /^(\w+): (.*)$/.exec(line);
    if (inFiles && item !== null) {
      current = { [item[1]]: item[2] };
      manifest.files.push(current);
    } else if (inFiles && field !== null && current !== null) {
      current[field[1]] = field[2];
    } else if (top !== null) {
      inFiles = false;
      manifest.top[top[1]] = top[2];
    } else {
      throw new Error(`${file}: unexpected line ${JSON.stringify(line)}`);
    }
  }
  for (const key of ['version', 'path', 'sha512']) {
    if (manifest.top[key] === undefined) throw new Error(`${file}: missing top-level "${key}"`);
  }
  if (manifest.files.length === 0 || manifest.files.some((f) => !f.url || !f.sha512)) {
    throw new Error(`${file}: "files" must list url + sha512 entries`);
  }
  return manifest;
}

const manifests = inputs.map(parse);
const version = manifests[0].top.version;
if (manifests.some((m) => m.top.version !== version)) {
  throw new Error(`version mismatch: ${manifests.map((m) => m.top.version).join(' vs ')}`);
}

const files = new Map();
for (const manifest of manifests) {
  for (const file of manifest.files) files.set(file.url, file);
}
const primary = manifests.find((m) => !/arm64/.test(m.top.path)) ?? manifests[0];
const releaseDate = manifests
  .map((m) => m.top.releaseDate)
  .filter(Boolean)
  .sort()
  .at(-1);

const lines = [`version: ${version}`, 'files:'];
for (const file of files.values()) {
  const [first, ...rest] = Object.entries(file);
  lines.push(`  - ${first[0]}: ${first[1]}`);
  for (const [key, value] of rest) lines.push(`    ${key}: ${value}`);
}
lines.push(`path: ${primary.top.path}`, `sha512: ${primary.top.sha512}`);
if (releaseDate !== undefined) lines.push(`releaseDate: ${releaseDate}`);
writeFileSync(outFile, `${lines.join('\n')}\n`);
console.log(
  `[merge] ${outFile}: ${files.size} files from ${inputs.length} manifests (v${version})`,
);

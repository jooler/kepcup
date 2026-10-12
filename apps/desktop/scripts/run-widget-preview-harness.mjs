#!/usr/bin/env node
// D87 P3b: runs the S2 widget preview host (apps/desktop/src/main/widget-preview.ts) in a real
// Electron against the cases in apps/desktop/test/electron/widget-preview.harness.ts.
//
// The harness is bundled with esbuild into one CJS Electron main (electron stays external), then
// started with the repo's Electron binary. The harness prints one JSON line per case plus a final
// JSON summary; this script exits with the harness's exit code (non-zero = some case failed).
//
// Linux / Docker (no configured SUID sandbox helper, see todo/bot-widgets-authoring.md §8.1):
//   xvfb-run -a node apps/desktop/scripts/run-widget-preview-harness.mjs > log 2>&1
// `--no-sandbox` only turns off the OS-level process sandbox; iframe sandbox flags, CSP and the
// process model are unaffected. Set KEPCUP_HARNESS_OS_SANDBOX=1 to keep it on (macOS / Windows).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(desktop, 'package.json'));
const { build } = require('esbuild');
/** @type {string} the `electron` package exports the binary path when required from Node. */
const electron = require('electron');

const HARD_LIMIT_MS = 240_000;

const outDir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-widget-preview-harness-'));
const bundle = path.join(outDir, 'harness.cjs');
await build({
  entryPoints: [path.join(desktop, 'test/electron/widget-preview.harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: bundle,
  sourcemap: 'inline',
  logLevel: 'warning',
});

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = process.env.KEPCUP_HARNESS_OS_SANDBOX === '1' ? [bundle] : ['--no-sandbox', bundle];
const child = spawn(electron, args, { stdio: 'inherit', env });
const killer = setTimeout(() => {
  console.log(JSON.stringify({ key: 'FATAL', value: `harness exceeded ${HARD_LIMIT_MS}ms` }));
  child.kill('SIGKILL');
}, HARD_LIMIT_MS);
child.on('exit', (code, signal) => {
  clearTimeout(killer);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(signal !== null ? 1 : (code ?? 1));
});

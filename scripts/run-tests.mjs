#!/usr/bin/env node
// Runs vitest with Electron as the Node runtime so that native modules
// compiled against Electron (and Node-API prebuilds) load in tests.
// See docs/dev/05-testing.md ("Native modules").
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const electron = require('electron');
const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

const args = process.argv.slice(2);
if (!args.includes('run') && !args.some((a) => a.startsWith('--'))) {
  // default to a single run; `test:watch` passes no args -> still a run
  args.unshift('run');
}

const child = spawn(electron, [vitestEntry, ...args], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

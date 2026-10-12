// D87 P3c: starts the S2 widget preview host in a real Electron as a child process speaking JSON
// lines over stdio (apps/desktop/test/electron/widget-preview.server.ts), so Node-side code — the
// widget-craft benchmark (packages/core/test/benchmark) — can bind core's preview facade to it.
//
//   const server = await startWidgetPreviewServer();   // needs a display (xvfb-run on Linux)
//   core.services.widgetPreviewRpc.bindFacade({ run: (input) => server.run(input) });
//   …
//   await server.close();
//
// `--no-sandbox` only turns off the OS process sandbox (see run-widget-preview-harness.mjs).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function startWidgetPreviewServer() {
  const require = createRequire(path.join(desktop, 'package.json'));
  const { build } = require('esbuild');
  /** @type {string} */
  const electron = require('electron');
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-widget-preview-server-'));
  const bundle = path.join(outDir, 'server.cjs');
  await build({
    entryPoints: [path.join(desktop, 'test/electron/widget-preview.server.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: bundle,
    logLevel: 'warning',
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = process.env.KEPCUP_HARNESS_OS_SANDBOX === '1' ? [bundle] : ['--no-sandbox', bundle];
  const child = spawn(electron, args, { stdio: ['pipe', 'pipe', 'inherit'], env });
  const pending = new Map();
  let seq = 0;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Chromium noise on stdout
    }
    if (message.ready === true) {
      resolveReady();
      return;
    }
    const call = pending.get(message.id);
    if (call === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) call.reject(new Error(message.error));
    else call.resolve(message.output);
  });
  // 起不来（没有显示服务 / Electron 缺失或崩溃）：立即失败，而不是等到调用方的超时。
  child.on('error', (error) => {
    rejectReady(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  });
  child.on('exit', (code, signal) => {
    rejectReady(
      new Error(`widget preview server exited before ready (code ${code}, signal ${signal})`),
    );
    for (const call of pending.values()) call.reject(new Error('widget preview server exited'));
    pending.clear();
    rmSync(outDir, { recursive: true, force: true });
  });
  await ready;
  return {
    run(input) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, input })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      await new Promise((resolve) => {
        // Electron 退出卡住时 5 秒后强杀。
        const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.on('exit', () => {
          clearTimeout(killer);
          resolve();
        });
      });
    },
  };
}

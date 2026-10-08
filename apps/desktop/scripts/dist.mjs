#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

/**
 * 打包入口（P13 任务 1 + 产物剔除，docs/dev/phases/P13-release.md）。
 *
 *   pnpm dist --mac --arm64        # 本机 macOS arm64 dmg+zip（未签名）
 *   pnpm dist --win --x64          # Windows（CI）
 *   pnpm dist --linux --arm64      # Linux（CI）
 *
 * 步骤：
 *  1. electron-vite build（KEPCUP_PACKAGE_BUILD=1 →
 *     __KEPCUP_TEST_HOOKS__=false，见 electron.vite.config.ts）；
 *  2. 用 esbuild 把 @kepcup/core（dist）整体并进 out/main/core-entry/index.js，
 *     define __KEPCUP_TEST_HOOKS__=false + minify 死码剔除测试缝
 *     （mock LLM 播种 / KEYSTORE=memory|file / WSL fixture runner——
 *     其余依赖一律 external，留在 asar 的 node_modules）；
 *     同时注入外部智能体目录的发行门禁放行清单（agent-release-gates.json →
 *     `__KEPCUP_AGENT_RELEASE_GATES__`，D72）：`releaseGate` 未放行的目录条目
 *     （Claude Agent 等待定条目、testkit 假 Agent）在发行构建中不收录；开发
 *     构建与测试不注入该常量，全部条目照常可用；
 *  3. 迁移文件拷到 out/migrations（打包后 core 的 import.meta.url 相对解析到那里）；
 *     外部智能体的 stdio ↔ HTTP MCP 代理（stdio-proxy.mjs，D72）拷到 bundle
 *     同目录（asarUnpack 解出，供子进程以 Electron 自带 Node 运行）；
 *  4. electron-builder（本文件传入的目标参数 + `--publish never`——发布永远
 *     由显式的独立 publish 步骤控制，绝不随构建/推 tag 隐式触发，见
 *     BR-P13-003）。无签名凭据时明确跳过签名
 *     （CSC_IDENTITY_AUTO_DISCOVERY=false），产物仅本地验证、不分发。
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);
const repoDir = path.dirname(path.dirname(appDir));

const builderArgs = process.argv.slice(2);

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

// 1. electron-vite build with the packaged define.
console.log('[dist] electron-vite build (KEPCUP_PACKAGE_BUILD=1)');
run('pnpm', ['exec', 'electron-vite', 'build'], { KEPCUP_PACKAGE_BUILD: '1' });

// 2. Bundle the core service entry with the test-only paths eliminated and the
//    agent catalog release gates pinned (D72: entries whose `releaseGate` is
//    not approved are dropped by core's effectiveAgentCatalog at runtime).
const releaseGates = JSON.parse(
  readFileSync(path.join(appDir, 'agent-release-gates.json'), 'utf8'),
).approved;
if (!Array.isArray(releaseGates) || releaseGates.some((gate) => typeof gate !== 'string')) {
  throw new Error('[dist] agent-release-gates.json: "approved" must be an array of strings');
}
console.log(`[dist] agent release gates approved: ${JSON.stringify(releaseGates)}`);
const coreEntry = path.join(appDir, 'src/core-entry/index.ts');
const outfile = path.join(appDir, 'out/main/core-entry/index.js');
console.log('[dist] esbuild bundle core-entry (test paths eliminated)');
await esbuild.build({
  entryPoints: [coreEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: false,
  outfile,
  // The workspace core package is bundled from its compiled dist; every third
  // party dependency stays external and ships in the asar's node_modules.
  alias: { '@kepcup/core': path.join(repoDir, 'packages/core/dist/index.js') },
  external: [
    'electron',
    '@kepcup/shared',
    // D72 ACP client: a @kepcup/core dependency like pi-*, resolved from the
    // asar's node_modules the same way (electron-builder collects core's
    // production dependency tree).
    '@agentclientprotocol/sdk',
    '@anthropic-ai/sandbox-runtime',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@napi-rs/keyring',
    'bash-parser',
    'better-sqlite3-multiple-ciphers',
    'birpc',
    'cron-parser',
    'es-git',
    'pino',
    'pino-roll',
    'zod',
    // Optional runtime: devDependency, absent from the package on purpose —
    // core degrades to full-text search (memory/store.ts resolveVecLoader).
    'sqlite-vec',
  ],
  define: {
    __KEPCUP_TEST_HOOKS__: 'false',
    __KEPCUP_AGENT_RELEASE_GATES__: JSON.stringify(releaseGates),
  },
  logLevel: 'info',
});

// 3. Migrations ride with the bundle.
const migrationsOut = path.join(appDir, 'out/migrations');
rmSync(migrationsOut, { recursive: true, force: true });
cpSync(path.join(repoDir, 'packages/core/migrations'), migrationsOut, { recursive: true });
console.log('[dist] migrations copied to out/migrations');

// 3b. D72 stdio ↔ HTTP MCP proxy: run by a child process (Electron's Node),
//     resolved next to the bundle (core resolveStdioProxyPath) and unpacked
//     from the asar (electron-builder.yml asarUnpack).
const stdioProxyOut = path.join(path.dirname(outfile), 'stdio-proxy.mjs');
cpSync(path.join(repoDir, 'packages/core/src/agent/external/stdio-proxy.mjs'), stdioProxyOut);
console.log('[dist] stdio-proxy.mjs copied next to the core-entry bundle');

// 4. Build-time sanity probe of the elimination (also asserted post-pack by
//    scripts/pack-hooks.cjs on the asar itself).
{
  const bundled = await import('node:fs').then((fs) => fs.readFileSync(outfile, 'utf8'));
  const markers = [
    'KEPCUP_MOCK_LLM_URL',
    'KEPCUP_WSL_TEST_FIXTURE',
    'Mock LLM',
    // D72 P6 external-agent e2e seam (fake ACP agent).
    'KEPCUP_FAKE_ACP_AGENT_BIN',
    'KEPCUP_FAKE_ACP_AGENT_SCRIPT',
    'KEPCUP_FAKE_ACP_AGENT_RECORD',
  ];
  for (const marker of markers) {
    if (bundled.includes(marker)) {
      throw new Error(`[dist] core-entry bundle still contains test marker "${marker}"`);
    }
  }
  if (!existsSync(path.join(migrationsOut, 'main'))) {
    throw new Error('[dist] out/migrations/main missing after copy');
  }
  if (!existsSync(stdioProxyOut)) {
    throw new Error('[dist] out/main/core-entry/stdio-proxy.mjs missing after copy');
  }
  // The gate list must have been substituted: a bare reference would leave
  // the catalog unfiltered in the packaged app.
  if (bundled.includes('__KEPCUP_AGENT_RELEASE_GATES__')) {
    throw new Error('[dist] core-entry bundle still references __KEPCUP_AGENT_RELEASE_GATES__');
  }
  console.log('[dist] core-entry bundle verified: no test-path markers, release gates pinned');
}

// 5. electron-builder. Skip code signing unless credentials are provided.
const env = {};
if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}
// BR-P13-003: publishing is ALWAYS an explicit, separate action — never an
// implicit side effect of a build. electron-builder would otherwise publish
// on its own whenever it runs in CI on a tag push with a GH_TOKEN present
// (its default publish mode is `onTagOrDraft`); `--publish never` pins the
// build to artifacts-only. A future release goes through a dedicated publish
// job (release.yml 的注释 publish job) that invokes electron-builder with an
// explicit --publish mode itself.
console.log(`[dist] electron-builder ${builderArgs.join(' ')} --publish never`);
run('pnpm', ['exec', 'electron-builder', ...builderArgs, '--publish', 'never'], env);
console.log('[dist] done — artifacts in apps/desktop/release/');

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import {
  macTargetArches,
  macTargetArchesFromYml,
  shareExtensionSkipPlan,
} from './dist-share-extension.mjs';

/**
 * 打包入口（P13 任务 1 + 产物剔除，docs/dev/phases/P13-release.md）。
 *
 *   pnpm dist --mac --arm64        # 本机 macOS arm64 dmg+zip（未签名）
 *   pnpm dist --win --x64          # Windows（CI）
 *   pnpm dist --linux --arm64      # Linux（CI）
 *
 * 步骤：
 *  0. Windows 目标的 WSL rootfs 自检（缺失时默认自建，启动 build-rootfs.sh
 *     的对应架构；KEPCUP_DIST_SKIP_ROOTFS=1 可跳过）；
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
     预注册 OAuth 客户端表同样注入（oauth-clients.json → `__KEPCUP_OAUTH_CLIENTS__`，
     D73 P2 §6.4）：只放平台定义为非保密的桌面客户端凭据；
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

const require = createRequire(import.meta.url);

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...env },
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

/** Resolve a package's CLI and run it with process.execPath (no pnpm.cmd / shell). */
function runPackageBin(packageName, binRelative, args, env = {}) {
  const pkgJson = require.resolve(`${packageName}/package.json`);
  const cli = path.join(path.dirname(pkgJson), binRelative);
  run(process.execPath, [cli, ...args], env);
}

/**
 * 0. Windows 目标的 WSL rootfs（P12/P13）。
 *
 *    CI：rootfs job 先产双架构（见 release.yml）；win build job 直接消费。
 *    本地：electron-builder 从 `resources/wsl/${arch}` 取子目录，缺了才会走
 *    pack 钩子的警告与非阻塞路径——为了让本地 `pnpm dist --win` 出的包也
 *    开箱可用，这里默认自建缺失架构的 rootfs（`bash
 *    apps/desktop/scripts/build-wsl-rootfs/build-rootfs.sh <arch>`，机制与
 *    CI 相同；本地通常是 amd64 原生容器，无需 qemu）。要求 docker + bash；
 *    `KEPCUP_DIST_SKIP_ROOTFS=1` 显式跳过（出包警告由 pack 钩子给出）。
 */
function winArchsFromArgs() {
  if (!builderArgs.includes('--win')) return [];
  const archs = [];
  if (builderArgs.includes('--x64')) archs.push('x64');
  if (builderArgs.includes('--arm64')) archs.push('arm64');
  if (archs.length === 0) {
    // 无架构参数：electron-builder 的 win target 用宿主架构（config 无 arch
    // 列表时的默认），这里对齐——桌面主机的 process.arch 即 WSL2 内核架构。
    archs.push(process.arch === 'arm64' ? 'arm64' : 'x64');
  }
  return archs;
}

/**
 * 0b. macOS 的 Share Extension（D94，docs/design/44-macos-share-extension.md §10.1）。
 *
 *     先用 xcodebuild 出 .appex（每个目标架构一份），再由 electron-builder 放进
 *     Contents/PlugIns/。是否随包发行由这里按产物存在性决定：
 *      - 任一架构缺产物（没装 Xcode 等）→ 本次打包跳过：删掉 resources/share-extension
 *        （已 gitignore，残留的陈旧 appex 会被 electron-builder 静默打包），并通过
 *        spawn env 给 electron-builder 进程传 KEPCUP_SKIP_SHARE_EXTENSION=1（子进程里
 *        设 env 传不回父进程——pack 钩子读的是本进程树）。
 *      - xcodebuild 失败（如本机无法交叉编译目标架构）→ run() 直接抛错终止，绝不
 *        静默缺产物。
 *     裸 `pnpm dist --mac`（无架构参数）按 electron-builder.yml 声明的双架构出
 *     appex——第二个 pass 缺 appex 必挂。
 */
const macArches = macTargetArches(
  builderArgs,
  macTargetArchesFromYml(readFileSync(path.join(appDir, 'electron-builder.yml'), 'utf8')),
);
let shareExtensionSkip = false;
if (macArches.length > 0) {
  console.log(`[dist] 构建 Share Extension（${macArches.join(', ')}）`);
  run(process.execPath, ['scripts/build-share-extension.mjs', ...macArches]);
  const plan = shareExtensionSkipPlan({
    arches: macArches,
    appexExists: (arch) =>
      existsSync(path.join(appDir, 'resources', 'share-extension', arch, 'KepCupShare.appex')),
  });
  if (plan.skip) {
    shareExtensionSkip = true;
    rmSync(path.join(appDir, 'resources', 'share-extension'), { recursive: true, force: true });
    console.warn(
      `[dist] Share Extension 产物缺失（${plan.missing.join(', ')}）——本次打包不带系统分享入口` +
        '（发版流水线必须装 Xcode），并已清掉 resources/share-extension 里的陈旧产物。',
    );
  }
}

if (process.env.KEPCUP_DIST_SKIP_ROOTFS !== '1') {
  for (const arch of winArchsFromArgs()) {
    const tarPath = path.join(appDir, 'resources', 'wsl', arch, 'rootfs.tar');
    if (existsSync(tarPath)) continue;
    console.log(
      `[dist] resources/wsl/${arch}/rootfs.tar 缺失——构建 rootfs（P12/P13；docker + bash）`,
    );
    run('bash', ['scripts/build-wsl-rootfs/build-rootfs.sh', arch]);
    if (!existsSync(tarPath)) {
      throw new Error(`[dist] build-rootfs.sh 运行成功但产物仍缺失：${tarPath}`);
    }
  }
}

// 1. electron-vite build with the packaged define.
// Windows CI: spawnSync('pnpm') without shell cannot find pnpm.cmd (exit code null).
// Invoke the local CLI via node instead (docs/dev/06-release.md 首跑验证).
console.log('[dist] electron-vite build (KEPCUP_PACKAGE_BUILD=1)');
runPackageBin('electron-vite', 'bin/electron-vite.js', ['build'], { KEPCUP_PACKAGE_BUILD: '1' });

// 2. Bundle the core service entry with the test-only paths eliminated and the
//    agent catalog release gates pinned (D72: entries whose `releaseGate` is
//    not approved are dropped by core's effectiveAgentCatalog at runtime).
const releaseGates = JSON.parse(
  readFileSync(path.join(appDir, 'agent-release-gates.json'), 'utf8'),
).approved;
if (!Array.isArray(releaseGates) || releaseGates.some((gate) => typeof gate !== 'string')) {
  throw new Error('[dist] agent-release-gates.json: "approved" must be an array of strings');
}
// The testkit fake agent (scripted, test seams only) never ships (D72 P6).
if (releaseGates.includes('testkit')) {
  throw new Error('[dist] agent-release-gates.json: "testkit" must never be approved');
}
console.log(`[dist] agent release gates approved: ${JSON.stringify(releaseGates)}`);
// Pre-registered OAuth clients (D73 P2 §6.4): { [clientRef]: { issuer, clientId, clientSecret? } }.
// Only credentials the platform defines as NON-confidential for desktop apps may live here.
const oauthClients = JSON.parse(readFileSync(path.join(appDir, 'oauth-clients.json'), 'utf8'));
if (typeof oauthClients !== 'object' || oauthClients === null || Array.isArray(oauthClients)) {
  throw new Error('[dist] oauth-clients.json must be an object');
}
for (const [ref, client] of Object.entries(oauthClients)) {
  if (
    typeof client !== 'object' ||
    client === null ||
    typeof client.issuer !== 'string' ||
    typeof client.clientId !== 'string' ||
    client.clientId.length === 0 ||
    (client.clientSecret !== undefined && typeof client.clientSecret !== 'string')
  ) {
    throw new Error(`[dist] oauth-clients.json: invalid entry "${ref}"`);
  }
}
// Env-sourced clients (kept out of git): process.env over the repo-root .env (gitignored).
// Same table as packages/core/src/apps/oauth-clients.ts ENV_OAUTH_CLIENTS.
const ENV_OAUTH_CLIENTS = [
  {
    clientRef: 'google',
    issuer: 'https://accounts.google.com',
    idVar: 'GOOGLE_CLIENT_ID',
    secretVar: 'GOOGLE_CLIENT_SECRET',
  },
];
{
  const fileEnv = {};
  const envFile = path.join(repoDir, '.env');
  if (existsSync(envFile)) {
    for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      let value = match[2];
      const quoted = /^(['"])(.*)\1$/.exec(value);
      value = quoted !== null ? quoted[2] : value.replace(/\s+#.*$/, '').trim();
      fileEnv[match[1]] = value;
    }
  }
  const env = { ...fileEnv, ...process.env };
  for (const spec of ENV_OAUTH_CLIENTS) {
    const clientId = env[spec.idVar]?.trim();
    if (!clientId) continue;
    const clientSecret = env[spec.secretVar]?.trim();
    oauthClients[spec.clientRef] = {
      issuer: spec.issuer,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }
}
console.log(`[dist] pre-registered oauth clients: ${JSON.stringify(Object.keys(oauthClients))}`);
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
  // package.json is type:module, so Electron utilityProcess loads this as ESM.
  // Bundled CJS deps still emit esbuild's __require shim for node builtins
  // (child_process/fs/...); without a real require in scope the shim throws
  // "Dynamic require of \"child_process\" is not supported" and core never starts.
  banner: {
    js: "import { createRequire as __kepcupCreateRequire } from 'node:module';const require = __kepcupCreateRequire(import.meta.url);",
  },
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
    __KEPCUP_OAUTH_CLIENTS__: JSON.stringify(oauthClients),
  },
  logLevel: 'info',
});

// 3. Migrations ride with the bundle.
// Layout must match import.meta.url after esbuild collapses core into
// out/main/core-entry/index.js:
//   start.ts migrationsUrl → ../migrations/${kind}  → out/main/migrations
//   memory/manager.ts      → ../../migrations/memory → out/migrations/memory
const migrationsSrc = path.join(repoDir, 'packages/core/migrations');
const migrationsOut = path.join(appDir, 'out/migrations');
const migrationsNextToBundle = path.join(appDir, 'out/main/migrations');
rmSync(migrationsOut, { recursive: true, force: true });
rmSync(migrationsNextToBundle, { recursive: true, force: true });
cpSync(migrationsSrc, migrationsOut, { recursive: true });
cpSync(migrationsSrc, migrationsNextToBundle, { recursive: true });
console.log('[dist] migrations copied to out/migrations and out/main/migrations');

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
    // D104 P1-3 plugin-market e2e seam (must DCE with __KEPCUP_TEST_HOOKS__).
    'KEPCUP_TEST_PLUGIN_MARKET',
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
  if (bundled.includes('__KEPCUP_OAUTH_CLIENTS__')) {
    throw new Error('[dist] core-entry bundle still references __KEPCUP_OAUTH_CLIENTS__');
  }
  console.log('[dist] core-entry bundle verified: no test-path markers, release gates pinned');
}

// 5. electron-builder. Skip code signing unless credentials are provided.
const env = {};
if (shareExtensionSkip) {
  // 见 0b：appex 缺产物时跳过随包发行，pack 钩子据此只警告不硬失败。
  env.KEPCUP_SKIP_SHARE_EXTENSION = '1';
}
if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}
// We invoke electron-builder via `node …/cli.js` (not `pnpm exec`), so its module
// collector would otherwise fall back to npm on a pnpm workspace and OOM. Tip it
// toward pnpm; apps/desktop/package.json also carries packageManager for file detection.
if (!process.env.npm_config_user_agent?.includes('pnpm')) {
  const pnpmVersion = (
    JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).packageManager ?? ''
  ).replace(/^pnpm@/, '');
  env.npm_config_user_agent = `pnpm/${pnpmVersion} npm/? node/${process.version.slice(1)}`;
}
if (!process.env.NODE_OPTIONS?.includes('max-old-space-size')) {
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--max-old-space-size=8192']
    .filter(Boolean)
    .join(' ');
}
// BR-P13-003: publishing is ALWAYS an explicit, separate action — never an
// implicit side effect of a build. electron-builder would otherwise publish
// on its own whenever it runs in CI on a tag push with a GH_TOKEN present
// (its default publish mode is `onTagOrDraft`); `--publish never` pins the
// build to artifacts-only. A future release goes through a dedicated publish
// job (release.yml 的注释 publish job) that invokes electron-builder with an
// explicit --publish mode itself.
console.log(`[dist] electron-builder ${builderArgs.join(' ')} --publish never`);
runPackageBin('electron-builder', 'cli.js', [...builderArgs, '--publish', 'never'], env);
console.log('[dist] done — artifacts in apps/desktop/release/');

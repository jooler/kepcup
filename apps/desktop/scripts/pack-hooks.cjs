'use strict';

/**
 * electron-builder beforePack / afterPack 钩子（P13 任务 1 + 产物剔除验证）。
 *
 * beforePack：确保按平台条件的 extraResources 源目录存在（bin/{os}-{arch}、
 *   resources/wsl），缺文件的场景只警告不阻塞（rootfs.tar 是 CI 产出，
 *   resources/wsl 目录不存在时 glob 自然不打包任何内容——existsSync 条件打包）。
 *
 * afterPack：对打包产物做硬校验（任何一条失败则构建失败）：
 *   1. app.asar 中不得出现测试路径标记（mock LLM 播种 / WSL fixture seam /
 *      KEYSTORE=memory|file / Mock LLM 提供方）；
 *   2. @kepcup/core（工作区 dist 仍含测试缝）与 @kepcup/testkit
 *      （mock 模型服务与测试夹具）不得进入 asar；
 *   3. macOS/Linux 产物必须自带平台 rg（resources/bin/{os}-{arch}/rg，
 *      extraResources 落在 asar 外的 resources/bin/）。
 *   4. 组件查询子进程（D81，设计 32 §6.1；`ELECTRON_RUN_AS_NODE=1`）加载的 SQLite
 *      驱动整包解出在 app.asar.unpacked 下（core resolveQueryDriverPath 的落点），且带
 *      目标平台的原生库；目标平台 = 构建机平台时，再用产物里的 Electron（Node 模式）
 *      对加密临时库做一次真实读写查询（与查询子进程同一加载路径）。
 */

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Map electron-builder / Node platform ids → resources/bin/{os}-{arch} dir prefix. */
const PLATFORM_DIR_NAME = {
  mac: 'darwin',
  darwin: 'darwin',
  mas: 'darwin',
  win: 'win',
  windows: 'win', // Platform.WINDOWS.name (NOT "win")
  win32: 'win',
  linux: 'linux',
};

/** 产物中绝不允许出现的测试路径标记（P13 注意事项「产物剔除」）。 */
const FORBIDDEN_MARKERS = [
  // seedMockLlm（mock 模型服务播种，start.ts）
  'KEPCUP_MOCK_LLM_URL',
  '"Mock LLM"',
  // WSL fixture runner（KEPCUP_WSL_TEST_FIXTURE e2e seam）
  'KEPCUP_WSL_TEST_FIXTURE',
  // memory/file keystore（KEPCUP_KEYSTORE=memory 的代码路径）
  '=memory is only allowed when NODE_ENV=test',
  'KEPCUP_FILE_KEYSTORE_PATH',
  // P13-B 首启引导 e2e seam（KEPCUP_ONBOARDING=off，main/index.ts）
  'KEPCUP_ONBOARDING',
  // D72 P6 外部智能体 e2e seam（假 ACP Agent，start.ts fakeAcpAgentSeamFromEnv）
  'KEPCUP_FAKE_ACP_AGENT_BIN',
  'KEPCUP_FAKE_ACP_AGENT_SCRIPT',
  'KEPCUP_FAKE_ACP_AGENT_RECORD',
  // D73 P3 MCP Apps e2e seam：渲染端 main.ts 的 window.__kepcupRpc（页面可直接调用 core RPC）
  '__kepcupRpc',
];

/** 文本里出现的第一个禁止标记；干净 = null（导出供单测）。 */
function findForbiddenMarker(text) {
  return FORBIDDEN_MARKERS.find((marker) => text.includes(marker)) ?? null;
}

/**
 * Resolve the resources/bin/{os}-{arch} OS segment for this pack context.
 * Prefer electronPlatformName (darwin|win32|linux|mas); fall back to
 * packager.platform.name (mac|windows|linux). Never default to darwin — a
 * wrong guess makes Windows afterPack look for bin/darwin-*.
 */
function platformDirName(context) {
  const ep = context.electronPlatformName;
  if (typeof ep === 'string' && PLATFORM_DIR_NAME[ep]) {
    return PLATFORM_DIR_NAME[ep];
  }
  const p = context.packager && context.packager.platform;
  const name = typeof p === 'string' ? p : p && p.name;
  const mapped = typeof name === 'string' ? PLATFORM_DIR_NAME[name] : undefined;
  if (!mapped) {
    throw new Error(
      `[pack] unknown platform for bin dir: electronPlatformName=${ep} packager.platform=${name}`,
    );
  }
  return mapped;
}

/** @deprecated use platformDirName; kept name only if anything imported it. */
function platformName(context) {
  return platformDirName(context);
}

function archName(context) {
  // context.arch is electron-builder's numeric Arch enum; map it (the target
  // arch — NOT process.arch, which differs when one config pass builds both
  // mac arches back to back).
  const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  return ARCH_NAMES[context.arch] ?? process.arch;
}

/** 组件查询子进程 require 的 SQLite 驱动（与 core widgets/query-runner.ts 同名）。 */
const QUERY_DRIVER = 'better-sqlite3-multiple-ciphers';

/**
 * 校验查询驱动整包解出在 `<resources>/app.asar.unpacked/node_modules/<驱动>/`：入口 JS
 * 与目标平台原生库（prebuilds/{platform}-{arch}.node 或 node-gyp 的 build/Release）
 * 都在磁盘上。返回入口路径（导出供单测）。
 */
function assertQueryDriverUnpacked(resourcesPath, platform, arch) {
  const packageDir = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', QUERY_DRIVER);
  const entry = path.join(packageDir, 'lib', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(
      `[pack] 组件查询驱动未解出 asar：缺少 ${entry}——子进程（ELECTRON_RUN_AS_NODE）只能退回 asar 内路径，` +
        '依赖 Electron 的 asar 补丁（检查 electron-builder.yml 的 asarUnpack 规则）',
    );
  }
  if (arch === 'x64' || arch === 'arm64') {
    const prebuild = path.join(packageDir, 'prebuilds', `${platform}-${arch}.node`);
    const built = path.join(packageDir, 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(prebuild) && !existsSync(built)) {
      throw new Error(`[pack] 组件查询驱动缺少 ${platform}-${arch} 原生库（${prebuild} 或 ${built}）`);
    }
  }
  return entry;
}

/**
 * 用 `execPath`（打包产物里的 Electron，以 Node 模式运行）在子进程里加载 `driverEntry`，
 * 对一个 chacha20 加密的临时库建表写入、再以 readonly + query_only 打开读回——与组件
 * 查询子进程的加载与开库方式一致。返回读回的行（导出供单测）；失败抛错（构建失败）。
 */
function smokeQueryDriver(execPath, driverEntry) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-pack-query-'));
  const script = [
    "'use strict';",
    'const Database = require(process.argv[1]);',
    "const key = 'key=\"x\\'' + '5a'.repeat(32) + '\\'\"';",
    'const w = new Database(process.argv[2]);',
    "w.pragma(\"cipher='chacha20'\"); w.pragma(key);",
    "w.exec(\"create table t (v text); insert into t values ('ok')\"); w.close();",
    'const r = new Database(process.argv[2], { readonly: true, fileMustExist: true });',
    "r.pragma(\"cipher='chacha20'\"); r.pragma(key); r.pragma('query_only = ON');",
    "process.stdout.write(JSON.stringify(r.prepare('select v from t').get()) + '\\n');",
  ].join('\n');
  try {
    const result = spawnSync(execPath, ['-e', script, driverEntry, path.join(dir, 'smoke.db')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const reason = result.error?.message ?? (result.stderr.trim() || `退出码 ${result.status}`);
      throw new Error(`[pack] 组件查询驱动冒烟失败（${execPath} 加载 ${driverEntry}）：${reason}`);
    }
    const lines = result.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 产物里的 Electron 可执行文件。 */
function packagedExecutable(context, appBundle) {
  const name = context.packager.appInfo.productFilename;
  if (appBundle !== undefined) return path.join(context.appOutDir, appBundle, 'Contents', 'MacOS', name);
  if (context.electronPlatformName === 'win32') return path.join(context.appOutDir, `${name}.exe`);
  return path.join(context.appOutDir, context.packager.executableName ?? name.toLowerCase());
}

function beforePack(context) {
  const projectDir = context.packager.projectDir;
  const dirName = platformDirName(context);
  const arch = archName(context);
  // extraResources 的 from 源目录不存在时 electron-builder 直接报错——确保目录存在。
  const binDir = path.join(projectDir, 'resources', 'bin', `${dirName}-${arch}`);
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
    console.warn(
      `[pack] created empty extraResources source dir: ${path.relative(projectDir, binDir)}`,
    );
  }
  // electron-builder FileSet skips empty directories — a marker keeps win-* (no rg yet) in the package.
  if (readdirSync(binDir).length === 0) {
    writeFileSync(path.join(binDir, '.keep'), '');
    console.warn(
      `[pack] wrote .keep under ${path.relative(projectDir, binDir)} so extraResources copies the dir`,
    );
  }
  if (dirName === 'win') {
    const wslDir = path.join(projectDir, 'resources', 'wsl');
    const rootfs = path.join(wslDir, 'rootfs.tar');
    if (!existsSync(rootfs)) {
      mkdirSync(wslDir, { recursive: true });
      console.warn(
        '[pack] resources/wsl/rootfs.tar 不存在——WSL 发行版 rootfs 由 CI 产出' +
          '（apps/desktop/scripts/build-wsl-rootfs，P12），本次打包不含该文件（条件打包，不阻塞）。',
      );
    }
  }
}

function afterPack(context) {
  // macOS: everything lives inside the .app bundle; win/linux: resources/ next
  // to the executable. (Detect by bundle presence — packager.platform naming
  // has changed across electron-builder majors.)
  const appBundle = readdirSync(context.appOutDir).find((name) => name.endsWith('.app'));
  const resourcesPath =
    appBundle !== undefined
      ? path.join(context.appOutDir, appBundle, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  if (existsSync(asarPath)) {
    const asar = readFileSync(asarPath);
    const asarText = asar.toString('latin1');
    const marker = findForbiddenMarker(asarText);
    if (marker !== null) {
      throw new Error(`[pack] 打包产物包含测试路径标记 "${marker}"（P13 产物剔除校验失败）`);
    }
    for (const pkg of ['node_modules/@kepcup/core', 'node_modules/@kepcup/testkit']) {
      if (asarText.includes(pkg)) {
        throw new Error(`[pack] 打包产物包含禁止打包的工作区包 "${pkg}"（P13 产物剔除校验失败）`);
      }
    }
  }

  // 平台二进制布局（core-host.bundledBinEnv 按 process.resourcesPath/bin/{os}-{arch} 注入）。
  const dirName = platformDirName(context);
  const binDir = path.join(resourcesPath, 'bin', `${dirName}-${archName(context)}`);
  if (!existsSync(binDir)) {
    throw new Error(`[pack] 缺少平台二进制目录 ${binDir}`);
  }
  if (dirName !== 'win') {
    const entries = readdirSync(binDir);
    if (!entries.includes('rg')) {
      throw new Error(`[pack] 平台二进制目录缺少 rg：${binDir}`);
    }
  } else {
    // Windows 的 rg 二进制尚未随仓库分发（沙箱走 WSL 发行版自带工具链，P12）；
    // 目录存在即可，宿主 rg 经系统 PATH 兜底。
    console.warn('[pack] win: resources/bin 下暂无预置二进制（rg 走系统 PATH 兜底）。');
  }

  // 托盘四件套（app-brand.trayIconPath 运行时读取 extraResources tray/；
  // 缺失时托盘静默变空白，这里硬校验兜住）。
  const trayDir = path.join(resourcesPath, 'tray');
  for (const name of ['trayTemplate.png', 'trayTemplate@2x.png', 'tray.png', 'tray@2x.png']) {
    if (!existsSync(path.join(trayDir, name))) {
      throw new Error(`[pack] 缺少托盘图标资源 ${name}（extraResources resources/tray）`);
    }
  }
  // 组件查询子进程的 SQLite 驱动（D81 §6.1）：整包解出 + 目标平台原生库；能在本机
  // 运行产物时（目标平台 = 构建机平台）再跑一次真实查询。
  const driverPlatform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const driverEntry = assertQueryDriverUnpacked(resourcesPath, driverPlatform, archName(context));
  if (driverPlatform === process.platform && archName(context) === process.arch) {
    const row = smokeQueryDriver(packagedExecutable(context, appBundle), driverEntry);
    if (row === null || typeof row !== 'object' || row.v !== 'ok') {
      throw new Error(`[pack] 组件查询驱动冒烟读回异常：${JSON.stringify(row)}`);
    }
    console.log('[pack] 组件查询驱动冒烟通过（Electron Node 模式加载 app.asar.unpacked 驱动，加密库读写）。');
  } else {
    console.warn(
      `[pack] 跨平台构建（${driverPlatform}-${archName(context)}），跳过组件查询驱动的运行冒烟；` +
        '到目标平台按 docs/design/32-bot-widgets.md §6.1 的打包态验证步骤手工验证。',
    );
  }

  console.log(
    `[pack] afterPack 校验通过（${dirName}-${archName(context)}，无测试路径标记，无工作区包）。`,
  );
}

module.exports = {
  beforePack,
  afterPack,
  FORBIDDEN_MARKERS,
  findForbiddenMarker,
  assertQueryDriverUnpacked,
  smokeQueryDriver,
  platformDirName,
  PLATFORM_DIR_NAME,
};

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
 */

const { existsSync, mkdirSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const PLATFORM_DIR_NAME = { mac: 'darwin', win: 'win', linux: 'linux' };

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
];

function platformName(context) {
  // context.packager.platform is a Platform instance ({name: 'mac'|'linux'|'win'}).
  const p = context.packager.platform;
  return typeof p === 'string' ? p : p.name;
}

function archName(context) {
  // context.arch is electron-builder's numeric Arch enum; map it (the target
  // arch — NOT process.arch, which differs when one config pass builds both
  // mac arches back to back).
  const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  return ARCH_NAMES[context.arch] ?? process.arch;
}

function beforePack(context) {
  const projectDir = context.packager.projectDir;
  const dirName = PLATFORM_DIR_NAME[platformName(context)] ?? 'darwin';
  const arch = archName(context);
  // extraResources 的 from 源目录不存在时 electron-builder 直接报错——确保目录存在。
  const binDir = path.join(projectDir, 'resources', 'bin', `${dirName}-${arch}`);
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
    console.warn(`[pack] created empty extraResources source dir: ${path.relative(projectDir, binDir)}`);
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
    for (const marker of FORBIDDEN_MARKERS) {
      if (asarText.includes(marker)) {
        throw new Error(`[pack] 打包产物包含测试路径标记 "${marker}"（P13 产物剔除校验失败）`);
      }
    }
    for (const pkg of ['node_modules/@kepcup/core', 'node_modules/@kepcup/testkit']) {
      if (asarText.includes(pkg)) {
        throw new Error(`[pack] 打包产物包含禁止打包的工作区包 "${pkg}"（P13 产物剔除校验失败）`);
      }
    }
  }

  // 平台二进制布局（core-host.bundledBinEnv 按 process.resourcesPath/bin/{os}-{arch} 注入）。
  const dirName = PLATFORM_DIR_NAME[platformName(context)] ?? 'darwin';
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
  console.log(`[pack] afterPack 校验通过（${dirName}-${archName(context)}，无测试路径标记，无工作区包）。`);
}

module.exports = { beforePack, afterPack };

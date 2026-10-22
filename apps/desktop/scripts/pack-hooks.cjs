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
 *   5. macOS：Share Extension（D94，docs/design/44-macos-share-extension.md §10.2）
 *      的 .appex 落在 Contents/PlugIns/ 下，Info.plist 可解析、扩展点正确、
 *      App Group 与主应用一致；Windows / Linux 产物里不得出现 .appex。
 *      （扩展没构建时只警告——本机没装 Xcode 的本地构建不该因此失败。）
 */

const { spawnSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
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
  // P12-B Windows 沙箱提示 e2e seam（KEPCUP_WSL_PROMPT=off，start.ts）
  'KEPCUP_WSL_PROMPT',
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
      throw new Error(
        `[pack] 组件查询驱动缺少 ${platform}-${arch} 原生库（${prebuild} 或 ${built}）`,
      );
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
    'w.pragma("cipher=\'chacha20\'"); w.pragma(key);',
    'w.exec("create table t (v text); insert into t values (\'ok\')"); w.close();',
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
  if (appBundle !== undefined)
    return path.join(context.appOutDir, appBundle, 'Contents', 'MacOS', name);
  if (context.electronPlatformName === 'win32') return path.join(context.appOutDir, `${name}.exe`);
  return path.join(context.appOutDir, context.packager.executableName ?? name.toLowerCase());
}

function plistFail(plistPath, detail) {
  throw new Error(`[pack] plist 解析失败：${plistPath}（${detail}）`);
}

/** XML 文本实体。`&amp;` 最后替换，避免把 `&amp;lt;` 解两次。 */
function decodeXmlText(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `xml` 以 `<name…>` 开头；返回内文与闭合标签之后的剩余。 */
function sliceBalanced(xml, name) {
  const open = new RegExp(`^<${name}(\\s[^>]*)?>`).exec(xml);
  if (open === null) return null;
  const tokenRe = new RegExp(`<(/?)${name}(\\s[^>]*)?>`, 'g');
  tokenRe.lastIndex = open[0].length;
  let depth = 1;
  let match = tokenRe.exec(xml);
  while (match !== null) {
    const isClose = match[1] === '/';
    const selfClose = /\/\s*>$/.test(match[0]);
    if (isClose) {
      depth -= 1;
      if (depth === 0) {
        return {
          inner: xml.slice(open[0].length, match.index),
          rest: xml.slice(match.index + match[0].length),
        };
      }
    } else if (!selfClose) {
      depth += 1;
    }
    match = tokenRe.exec(xml);
  }
  return null;
}

function parsePlistValue(xml, fail) {
  const text = xml.trim();
  const self = /^<(true|false|dict|array)\s*\/>/.exec(text);
  if (self !== null) {
    const kind = self[1];
    const value = kind === 'true' ? true : kind === 'false' ? false : kind === 'dict' ? {} : [];
    return { value, rest: text.slice(self[0].length) };
  }
  const open = /^<([A-Za-z]+)\b/.exec(text);
  if (open === null) fail('无法识别的 XML');
  const name = open[1];
  const sliced = sliceBalanced(text, name);
  if (sliced === null) fail(`标签 ${name} 未闭合`);
  let value;
  switch (name) {
    case 'dict':
      value = parseDict(sliced.inner, fail);
      break;
    case 'array':
      value = parseArray(sliced.inner, fail);
      break;
    case 'string':
    case 'date':
    case 'data':
      value = decodeXmlText(sliced.inner);
      break;
    case 'integer':
      value = Number.parseInt(sliced.inner.trim(), 10);
      break;
    case 'real':
      value = Number.parseFloat(sliced.inner.trim());
      break;
    case 'true':
      value = true;
      break;
    case 'false':
      value = false;
      break;
    default:
      fail(`不支持的类型 ${name}`);
  }
  return { value, rest: sliced.rest };
}

function parseDict(inner, fail) {
  const obj = {};
  let rest = inner.trim();
  while (rest.length > 0) {
    if (!rest.startsWith('<key')) fail('dict 缺少 key');
    const keySlice = sliceBalanced(rest, 'key');
    if (keySlice === null) fail('key 未闭合');
    const key = decodeXmlText(keySlice.inner).trim();
    const parsed = parsePlistValue(keySlice.rest, fail);
    obj[key] = parsed.value;
    rest = parsed.rest.trim();
  }
  return obj;
}

function parseArray(inner, fail) {
  const items = [];
  let rest = inner.trim();
  while (rest.length > 0) {
    const parsed = parsePlistValue(rest, fail);
    items.push(parsed.value);
    rest = parsed.rest.trim();
  }
  return items;
}

/**
 * plutil 不在时的 XML plist 回退（Linux / Windows 的打包校验单测）。
 * macOS 发版产物是 Xcode 的二进制 plist，仍走 plutil。
 */
function readXmlPlist(xml, plistPath) {
  const fail = (detail) => plistFail(plistPath, detail);
  const stripped = xml
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const root = /^<plist\b[^>]*>([\s\S]*)<\/plist>\s*$/i.exec(stripped);
  if (root === null) fail('不是 XML plist');
  return parsePlistValue(root[1], fail).value;
}

/**
 * 解析 plist。macOS 用系统 plutil（覆盖 Xcode 写出的二进制 plist）；
 * plutil 不存在时（Linux / Windows CI）解析 XML plist。不引第三方依赖。
 */
function readPlist(plistPath) {
  const plutil = '/usr/bin/plutil';
  if (existsSync(plutil)) {
    const result = spawnSync(plutil, ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        plistFail(plistPath, error.message);
      }
    }
    // spawn 本身失败（ENOENT 等）才回退；plutil 拒绝的二进制 / 损坏文件保持原错误。
    if (result.error === undefined) {
      plistFail(plistPath, result.stderr?.trim() || `退出码 ${result.status}`);
    }
  }
  let xml;
  try {
    xml = readFileSync(plistPath, 'utf8');
  } catch (error) {
    plistFail(plistPath, error.message);
  }
  return readXmlPlist(xml, plistPath);
}

/**
 * 从 `codesign -d --entitlements :-` 的输出里取第一个 application-group。
 * 输出格式随 macOS 版本变（旧版带 DOCTYPE 的完整 plist、新版裸 XML、前面可能
 * 还混着 `Executable=…` 行），所以只按「key 后第一个 <string>」匹配（导出供单测）。
 */
function firstAppGroupFromEntitlements(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const match =
    /<key>com\.apple\.security\.application-groups<\/key>\s*(?:<array>\s*)?<string>([^<]+)<\/string>/.exec(
      text,
    );
  return match === null ? null : match[1].trim();
}

/** appex 签名里实际生效的 entitlements 文本；codesign 不可用时返回 null（跳过校验）。 */
function codesignEntitlements(appexPath) {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', appexPath], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/**
 * 校验 macOS 产物里的 Share Extension（D94 §10.2）：.appex 在 Contents/PlugIns/ 下、
 * Info.plist 可解析、扩展点是 com.apple.share-services、bundle id 以主应用 id 为前缀、
 * 签名里的 App Group 与主应用一致（groupId 来自 resources/share-extension/group.json，
 * 即构建脚本展开 TeamID 后写的同一个值）。返回校验摘要（导出供单测）。
 */
function assertShareExtension(appBundlePath, groupId) {
  const pluginsDir = path.join(appBundlePath, 'Contents', 'PlugIns');
  const appexPath = path.join(pluginsDir, 'KepCupShare.appex');
  if (!existsSync(appexPath)) {
    throw new Error(
      `[pack] 缺少 Share Extension：${appexPath}（先跑 scripts/build-share-extension.mjs）`,
    );
  }
  const info = readPlist(path.join(appexPath, 'Contents', 'Info.plist'));
  const extension = info?.NSExtension ?? {};
  if (extension.NSExtensionPointIdentifier !== 'com.apple.share-services') {
    throw new Error(
      `[pack] Share Extension 扩展点不对：${extension.NSExtensionPointIdentifier}（应为 com.apple.share-services）`,
    );
  }
  const bundleId = String(info.CFBundleIdentifier ?? '');
  if (!bundleId.startsWith('app.kepcup.desktop')) {
    throw new Error(`[pack] Share Extension bundle id 不对：${bundleId}`);
  }
  // 签名校验：已签名的扩展必须通过 codesign --verify --strict（未签名的本地
  // 构建只警告——发版流水线不允许）。
  const signed = existsSync(path.join(appexPath, 'Contents', '_CodeSignature'));
  if (signed) {
    const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', appexPath], {
      encoding: 'utf8',
    });
    if (verify.status !== 0) {
      throw new Error(
        `[pack] Share Extension 签名校验失败：${appexPath}（${verify.stderr?.trim() || `退出码 ${verify.status}`}）`,
      );
    }
  } else {
    console.warn(`[pack] Share Extension 未签名：${appexPath}（发版前必须签名）。`);
  }
  // App Group 一致性（§9.6）：扩展签名 entitlements 里实际生效的组 id 必须与
  // 主应用的一致——对不上时扩展拿不到容器、功能整体不可用，硬失败。未签名 /
  // codesign 不可用 / 没有 group.json（groupId 为 null）时无法取证，只警告。
  let appGroup = null;
  if (groupId === null) {
    console.warn('[pack] 没有 App Group 基准（group.json 缺失）——跳过 App Group 一致性校验。');
  } else if (!signed) {
    console.warn('[pack] Share Extension 未签名，取不到 entitlements——跳过 App Group 一致性校验。');
  } else {
    const entitlements = codesignEntitlements(appexPath);
    if (entitlements === null) {
      console.warn('[pack] codesign 不可用——跳过 App Group 一致性校验。');
    } else {
      appGroup = firstAppGroupFromEntitlements(entitlements);
      if (appGroup === null) {
        throw new Error(
          `[pack] Share Extension 的 entitlements 里没有 application-groups（期望 ${groupId}）`,
        );
      }
      if (appGroup !== groupId) {
        throw new Error(
          `[pack] Share Extension 与主应用的 App Group 不一致：${appGroup}（期望 ${groupId}）`,
        );
      }
    }
  }
  return {
    appexPath,
    bundleId,
    extensionPoint: extension.NSExtensionPointIdentifier,
    signed,
    appGroup,
  };
}

/**
 * 把构建脚本产出的 .appex 放进 Contents/PlugIns/KepCupShare.appex。
 *
 * electron-builder 的 extraFiles 按文件复制，可能摊平 bundle 或弄坏
 * codesign。这里在校验前用 ditto（保留资源叉与签名）整包覆盖；源不存在时
 * 不动，交给 assertShareExtension 报「缺少 Share Extension」。
 * 返回是否放入了构建产物。
 */
function installBuiltShareExtension(context, appBundlePath) {
  const source = path.join(
    context.packager.projectDir,
    'resources',
    'share-extension',
    archName(context),
    'KepCupShare.appex',
  );
  if (!existsSync(source)) return false;
  const pluginsDir = path.join(appBundlePath, 'Contents', 'PlugIns');
  const dest = path.join(pluginsDir, 'KepCupShare.appex');
  mkdirSync(pluginsDir, { recursive: true });
  // extraFiles 若把 appex 的内容摊进 PlugIns/，会留下同级的 Contents/。
  rmSync(path.join(pluginsDir, 'Contents'), { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
  if (existsSync('/usr/bin/ditto')) {
    const result = spawnSync('/usr/bin/ditto', [source, dest], { encoding: 'utf8' });
    if (result.status !== 0) {
      const reason = result.stderr?.trim() || result.error?.message || `退出码 ${result.status}`;
      throw new Error(`[pack] 复制 Share Extension 失败：${source} → ${dest}（${reason}）`);
    }
  } else {
    cpSync(source, dest, { recursive: true });
  }
  console.log(`[pack] Share Extension 已放入 ${dest}（整包复制，保留签名）。`);
  return true;
}

/** resources/share-extension/group.json 里的组 id（构建脚本写入）；读不到为 null。 */
function shareGroupIdFromProject(projectDir) {
  try {
    const group = JSON.parse(
      readFileSync(path.join(projectDir, 'resources', 'share-extension', 'group.json'), 'utf8'),
    );
    return typeof group.groupId === 'string' && group.groupId.length > 0 ? group.groupId : null;
  } catch {
    return null;
  }
}

/** 产物里不该出现 .appex（Windows / Linux）。 */
function assertNoShareExtension(outDir) {
  const stack = [outDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.appex')) {
          throw new Error(`[pack] 非 macOS 产物里出现了 Share Extension：${full}`);
        }
        stack.push(full);
      }
    }
  }
}

/**
 * D94：把主应用的 entitlements 模板展开成实际使用的 plist。
 *
 * App Group 的组 id 带 TeamID 前缀（`$(TeamIdentifierPrefix)` 在 Xcode 构建期
 * 才会展开，electron-builder 直接把文件交给 codesign，不会展开）。TeamID 由
 * scripts/build-share-extension.mjs 解析并写进 resources/share-extension/group.json；
 * 没有 TeamID（本地未签名构建）时去掉 App Group 权限。
 */
function expandMainEntitlements(projectDir) {
  const template = path.join(projectDir, 'resources', 'entitlements.mac.plist');
  const target = path.join(projectDir, 'resources', 'entitlements.mac.expanded.plist');
  if (!existsSync(template)) return null;
  let team = null;
  try {
    const group = JSON.parse(
      readFileSync(path.join(projectDir, 'resources', 'share-extension', 'group.json'), 'utf8'),
    );
    team = typeof group.teamId === 'string' && group.teamId.length > 0 ? group.teamId : null;
  } catch {
    team = null;
  }
  const raw = readFileSync(template, 'utf8');
  const expanded =
    team === null
      ? raw.replace(
          /\s*<key>com\.apple\.security\.application-groups<\/key>\s*<array>[\s\S]*?<\/array>/,
          '',
        )
      : raw.replaceAll('$(TeamIdentifierPrefix)', `${team}.`);
  writeFileSync(target, expanded);
  return target;
}

function beforePack(context) {
  const projectDir = context.packager.projectDir;
  const dirName = platformDirName(context);
  // D94：macOS 主应用也要 App Group 权限（它读扩展写的 inbox、给扩展写快照）。
  if (dirName === 'darwin') expandMainEntitlements(projectDir);
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
    ensureWslRootfsSource(wslDir, archName(context), projectDir);
  }
}

/**
 * Win 打包前把 resources/wsl/<arch> 备货成 extraResources 可用的 source dir
 * （P13）：
 *  - electron-builder 的 `from: resources/wsl/${arch}` 在整目录缺失或为空时
 *    什么都不拷（空 source dir 会被跳过），package 里连 Resources/wsl 这层
 *    都不建——core 的 KEPCUP_WSL_ROOTFS 注入会缺席，报错形态变成「安装包
 *    不完整」。所以这里兜底建目录 + 写 .keep（bin 目录同法，见上）。
 *  - 迁移期兼容：CI 产出的旧布局是单文件 resources/wsl/rootfs.tar（只有
 *    x64 架构语义）。新布局没到位（arch 子目录缺 rootfs.tar）且旧文件在，
 *    x64 pass 仍可出包（core 侧 resolveRootfsTarPath 有 legacy 回退），
 *    因此只警告不阻塞；arm64 pass 的警告按缺失处理——旧布局不能被 arm64
 *    打包误用（导入能过但 distro 里二进制跑不了）。
 *  - 返回 { kept, warnMissing } 便于单测断言。
 */
function ensureWslRootfsSource(wslDir, targetArch, projectDir) {
  if (!existsSync(wslDir)) {
    mkdirSync(wslDir, { recursive: true });
    console.warn(
      `[pack] created empty WSL rootfs source dir: ${path.relative(projectDir, wslDir)}`,
    );
  }
  const archDir = path.join(wslDir, targetArch);
  mkdirSync(archDir, { recursive: true });
  if (readdirSync(archDir).length === 0) {
    writeFileSync(path.join(archDir, '.keep'), '');
    console.warn(
      `[pack] wrote .keep under ${path.relative(projectDir, path.dirname(path.join(archDir, '.keep')))} ` +
        'so extraResources copies the (empty) wsl dir',
    );
  }
  const archTar = path.join(archDir, 'rootfs.tar');
  if (existsSync(archTar)) {
    return { kept: path.relative(projectDir, archTar), warnMissing: false };
  }
  const legacyTar = path.join(wslDir, 'rootfs.tar');
  if (targetArch === 'x64' && existsSync(legacyTar)) {
    console.warn(
      '[pack] 新双架构布局缺位，回退旧单文件 resources/wsl/rootfs.tar（x64 语义）出包——' +
        'CI 需重跑根 rootfs job 产 x64/arm64 双目录；arm64 安装包将不含 rootfs。',
    );
    return { kept: path.relative(projectDir, legacyTar), warnMissing: false };
  }
  console.warn(
    `[pack] resources/wsl/${targetArch}/rootfs.tar 不存在——WSL 发行版 rootfs 由 CI 产出` +
      '（apps/desktop/scripts/build-wsl-rootfs，P12/P13）' +
      (targetArch === 'arm64' && existsSync(legacyTar)
        ? '，旧单文件 rootfs.tar 是 x64 语义，不能给 arm64 打包（导入后 distro 内二进制跑不了），'
        : '') +
      '；本次打包不含该文件（不阻塞），用户端沙箱准备向导会报「安装包不完整」。',
  );
  return { kept: null, warnMissing: true };
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
  const driverPlatform =
    context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const driverEntry = assertQueryDriverUnpacked(resourcesPath, driverPlatform, archName(context));
  if (driverPlatform === process.platform && archName(context) === process.arch) {
    const row = smokeQueryDriver(packagedExecutable(context, appBundle), driverEntry);
    if (row === null || typeof row !== 'object' || row.v !== 'ok') {
      throw new Error(`[pack] 组件查询驱动冒烟读回异常：${JSON.stringify(row)}`);
    }
    console.log(
      '[pack] 组件查询驱动冒烟通过（Electron Node 模式加载 app.asar.unpacked 驱动，加密库读写）。',
    );
  } else {
    console.warn(
      `[pack] 跨平台构建（${driverPlatform}-${archName(context)}），跳过组件查询驱动的运行冒烟；` +
        '到目标平台按 docs/design/32-bot-widgets.md §6.1 的打包态验证步骤手工验证。',
    );
  }

  // D94 §10.2：Share Extension 的落位与一致性校验。
  if (dirName === 'darwin') {
    const appBundlePath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
    );
    if (process.env.KEPCUP_SKIP_SHARE_EXTENSION === '1') {
      console.warn(
        '[pack] Share Extension 未构建（KEPCUP_SKIP_SHARE_EXTENSION=1，dist.mjs 按 appex 产物存在性设置）——产物不带系统分享入口。',
      );
    } else {
      // extraFiles 的落点不对或逐文件复制损坏签名时，用构建产物整包补上。
      installBuiltShareExtension(context, appBundlePath);
      // 基准组 id 来自构建脚本写的 group.json（TeamID 展开后的同一个值），
      // 不再读无人设置的 KEPCUP_SHARE_GROUP_ID env。
      const summary = assertShareExtension(
        appBundlePath,
        shareGroupIdFromProject(context.packager.projectDir),
      );
      console.log(
        `[pack] Share Extension 校验通过（${summary.bundleId}，${summary.extensionPoint}）。`,
      );
    }
  } else {
    assertNoShareExtension(context.appOutDir);
  }

  console.log(
    `[pack] afterPack 校验通过（${dirName}-${archName(context)}，无测试路径标记，无工作区包）。`,
  );
}

module.exports = {
  beforePack,
  afterPack,
  assertShareExtension,
  assertNoShareExtension,
  readPlist,
  installBuiltShareExtension,
  firstAppGroupFromEntitlements,
  shareGroupIdFromProject,
  ensureWslRootfsSource,
  FORBIDDEN_MARKERS,
  findForbiddenMarker,
  assertQueryDriverUnpacked,
  smokeQueryDriver,
  platformDirName,
  PLATFORM_DIR_NAME,
};

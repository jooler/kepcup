import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPluginFixture } from '@kepcup/testkit';

/**
 * 市场 CI 静态扫描钩子（D125 P4 步骤 2）：文件面（native / 可执行位 / symlink）、
 * 代码面（eval / new Function / child_process / process.binding / Worker / 动态 import）
 * 与白名单一致性（包内域名 vs runtime.network.allow）。
 *
 * 违规样例都在测试夹具里现场构造（真实 `.kepcup` 归档），不依赖仓库里的可疑文件；
 * reference-media 与 dashscope-t2i 两个真实执行型插件必须放行（任务书验收项）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const scriptPath = path.resolve(repoRoot, 'scripts/scan-plugin-runtime.mjs');
type ScanResult = {
  status: 'pass' | 'warn' | 'fail';
  errors: string[];
  warnings: string[];
};
interface ScanScript {
  scanRuntimePackage(input: {
    files: Array<{
      path: string;
      data?: Buffer | string;
      mode?: number;
      isSymlink?: boolean;
    }>;
    manifest: unknown;
  }): ScanResult | null;
  readDirectoryFiles(
    dir: string,
  ): Promise<Array<{ path: string; data?: Buffer; mode?: number; isSymlink?: boolean }>>;
  readPackageFiles(file: string): Promise<{ manifest: unknown; files: unknown[] }>;
  runtimeScanHostAllowed(host: string, allow: readonly string[]): boolean;
  run(
    argv: string[],
    io?: { out(message: string): void; err(message: string): void },
  ): Promise<number>;
}
const scanner = (await import(/* @vite-ignore */ pathToFileURL(scriptPath).href)) as ScanScript;

const root = mkdtempSync(path.join(tmpdir(), 'runtime-scan-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const runtimeManifest = {
  format_version: 1,
  id: 'io.test/runtime-scan',
  name: '运行时扫描夹具',
  version: '1.0.0',
  usage: '测试专用。',
  instances: ['capability-model'],
  runtime: {
    entry: 'dist/main.js',
    hostApi: '^1',
    network: { allow: ['api.example.com', '*.cdn.example.com'] },
  },
  contributions: {
    capabilityModels: [{ id: 'img', capability: 'image', model: 'm' }],
  },
};

const safeCode = `
globalThis.x = 1;
await fetch('https://api.example.com/v1');
await fetch('https://img.cdn.example.com/out.png');
const mod = await import('./helper.js');
`;

function scan(
  files: Array<{ path: string; data?: Buffer | string; mode?: number; isSymlink?: boolean }>,
  manifest: unknown = runtimeManifest,
) {
  // .js entry 需要 package.json 的 "type":"module"（ESM 约定）；除专门测试该策略的用例，
  // 其余夹具默认带一个正确的根 package.json。
  const hasPackageJson = files.some(
    (file) => String(file.path).replace(/^\.\//, '') === 'package.json',
  );
  return scanner.scanRuntimePackage({
    files: hasPackageJson ? files : [{ path: 'package.json', data: '{"type":"module"}' }, ...files],
    manifest,
  });
}

async function buildRuntimeFixture(
  extraEntries: Array<{
    name: string;
    data?: Buffer | string;
    mode?: number;
    symlink?: boolean;
  }> = [],
): Promise<string> {
  const dir = path.join(root, `pkg-${Math.random().toString(36).slice(2, 8)}`);
  const fixture = await buildPluginFixture({
    dir,
    fileName: 'runtime.kepcup',
    manifest: { ...runtimeManifest, contributions: runtimeManifest.contributions },
    extraEntries: [
      { name: 'dist/main.js', data: safeCode },
      { name: 'package.json', data: '{"type":"module"}' },
      ...extraEntries,
    ],
  });
  return fixture.path;
}

describe('runtime 静态扫描（D125 P4 步骤 2）', () => {
  it('数据型插件（无 runtime 段）不进入扫描', () => {
    expect(scan([{ path: 'skills/x/SKILL.md', data: 'x' }], { format_version: 1 })).toBeNull();
  });

  it('干净执行型包：pass（白名单内域名 + 静态相对动态 import）', () => {
    expect(
      scan([
        { path: 'plugin.json', data: '{}' },
        { path: 'dist/main.js', data: safeCode },
      ]),
    ).toEqual({ status: 'pass', errors: [], warnings: [] });
  });

  it('白名单外的包内域名 → warn（人工复审；不阻断出包）', () => {
    const result = scan([
      {
        path: 'dist/main.js',
        data: `fetch('https://api.example.com'); fetch('https://evil.example.net/x')`,
      },
    ]);
    expect(result?.status).toBe('warn');
    expect(result?.warnings.join(' ')).toContain('evil.example.net');
    expect(result?.errors).toEqual([]);
  });

  it('文件面：.node / .wasm / .dll / .so / .exe / 可执行位 / symlink 全部 fail', () => {
    for (const name of ['native.node', 'lib.wasm', 'x.dll', 'libx.so', 'tool.exe']) {
      const result = scan([{ path: name, data: 'x' }]);
      expect(result?.status, name).toBe('fail');
      expect(result?.errors.join(' '), name).toContain('native');
    }
    expect(scan([{ path: 'bin/run', data: 'x', mode: 0o755 }])?.status).toBe('fail');
    expect(scan([{ path: 'dist/evil', isSymlink: true }])?.status).toBe('fail');
  });

  it('代码面：eval 标识符 / Function( / require / process.binding / Worker 全部 fail（含间接与混淆写法）', () => {
    for (const code of [
      'eval("1")',
      '(0, eval)("1")',
      'globalThis.eval("1")',
      'new Function("return 1")',
      'Function("return 1")()',
      "require('child_process').execSync('id')",
      "require('node:' + 'child_process')",
      'process.binding("fs")',
      'process . binding("fs")',
      'process.getBuiltinModule("child_process")',
      'const { getBuiltinModule } = process; getBuiltinModule("child_process");',
      'const { mainModule } = process; mainModule.require("child_process");',
      'const { _linkedBinding } = process; _linkedBinding("fs");',
      'process["bin" + "ding"]("fs")',
      'new Worker("x")',
      'globalThis["ev" + "al"]("1")',
      'globalThis["Worker"]("x")',
      'Reflect.get(globalThis, "eval")("1")',
      'Object.getOwnPropertyDescriptor(globalThis, "eval").value("1")',
      '(()=>{}).constructor.constructor("return 1")()',
      'const x = `${eval("1")}`;',
      'const x = `${(0, eval)("1")}`;',
      // Regex literals must not desynchronise the mask (a quote inside /["']/ used to
      // hide the following eval call).
      'const re = /["\']/; eval("1");',
      'const re = /`/; eval("1");',
      // A division after an object literal must not be mistaken for a regex and mask the
      // following call.
      'const x = {} / 2; eval("1"); const y = 1 / 3;',
    ]) {
      const result = scan([{ path: 'dist/main.js', data: code }]);
      expect(result?.status, code).toBe('fail');
    }
  });

  it('动态 import：远程 / 计算 / 包外路径 / 受限内置模块 fail；静态本地 / 裸包名 / 注释放行', () => {
    expect(scan([{ path: 'main.js', data: `import('https://evil.example/x.js')` }])?.status).toBe(
      'fail',
    );
    expect(scan([{ path: 'main.js', data: `import(someVar)` }])?.status).toBe('fail');
    expect(scan([{ path: 'main.js', data: 'import(`./${name}.js`)' }])?.status).toBe('fail');
    expect(scan([{ path: 'main.js', data: "import('node:child_process')" }])?.status).toBe('fail');
    expect(scan([{ path: 'main.js', data: "import('node:vm')" }])?.status).toBe('fail');
    expect(scan([{ path: 'main.js', data: "import('node:fs')" }])?.status).toBe('fail');
    expect(scan([{ path: 'main.js', data: "import('data:text/javascript,1')" }])?.status).toBe(
      'fail',
    );
    expect(scan([{ path: 'main.js', data: "import('/etc/x.js')" }])?.status).toBe('fail');
    expect(scan([{ path: 'main.js', data: 'import("../x.js")' }])?.status).toBe('fail');
    // Node loads an extensionless relative import as ESM → cannot be left unscanned.
    expect(scan([{ path: 'main.js', data: "import('./chunk')" }])?.status).toBe('fail');
    expect(scan([{ path: 'main.js', data: "import('node:' + 'child_process')" }])?.status).toBe(
      'fail',
    );
    expect(scan([{ path: 'main.js', data: "import/*x*/('node:child_process')" }])?.status).toBe(
      'fail',
    );
    expect(scan([{ path: 'main.js', data: "import('./a.js'); import('zod')" }])?.status).toBe(
      'pass',
    );
    expect(scan([{ path: 'main.js', data: `import(/* local */ './a.js')` }])?.status).toBe('pass');
  });

  it('静态 import：远程 / data: / 受限内置模块 / 包外路径 fail；普通包与 node:crypto 放行', () => {
    for (const code of [
      "import fs from 'node:fs';",
      "import { DatabaseSync } from 'node:sqlite';",
      "import { createRequire } from 'node:module';",
      "import 'data:text/javascript,1';",
      "import 'https://evil.example/x.js';",
      "export { x } from '../outside.js';",
      "import './chunk';",
      "import { execSync } from 'child_process';",
    ]) {
      expect(scan([{ path: 'main.js', data: code }])?.status, code).toBe('fail');
    }
    expect(
      scan([
        {
          path: 'main.js',
          data: "import { createHash } from 'node:crypto'; import { z } from 'zod';",
        },
      ])?.status,
    ).toBe('pass');
  });

  it('entry 必须是 .js / .mjs，且 .js 需要 package.json 的 "type":"module"（封 CJS 加载面）', () => {
    const withEntry = (entry: string) => ({
      ...runtimeManifest,
      runtime: { ...runtimeManifest.runtime, entry },
    });
    const raw = (files: Array<{ path: string; data?: Buffer | string }>, manifest: unknown) =>
      scanner.scanRuntimePackage({ files, manifest });
    const dir = (entry: string, path: string) => [{ path, data: 'globalThis.ok = 1;' }];
    // 无扩展名 / .cjs 不是 ESM 单文件约定。
    expect(raw(dir('main', 'main'), withEntry('main'))?.status).toBe('fail');
    expect(raw(dir('dist/main.cjs', 'dist/main.cjs'), withEntry('dist/main.cjs'))?.status).toBe(
      'fail',
    );
    // .js 没有 package.json → Node 按 CommonJS 加载，module['require'] 可绕过 require 规则。
    expect(raw(dir('dist/main.js', 'dist/main.js'), withEntry('dist/main.js'))?.status).toBe(
      'fail',
    );
    expect(
      raw(
        [
          { path: 'dist/main.js', data: 'globalThis.ok = 1;' },
          { path: 'package.json', data: '{"type":"commonjs"}' },
        ],
        withEntry('dist/main.js'),
      )?.status,
    ).toBe('fail');
    expect(
      raw(
        [
          { path: 'dist/main.js', data: 'globalThis.ok = 1;' },
          { path: 'package.json', data: '{"type":"module"}' },
        ],
        withEntry('dist/main.js'),
      )?.status,
    ).toBe('pass');
    // .mjs 恒为 ESM，不需要 package.json。
    expect(
      raw([{ path: 'dist/main.mjs', data: 'globalThis.ok = 1;' }], withEntry('dist/main.mjs'))
        ?.status,
    ).toBe('pass');
    // 嵌套 package.json 会改变「最近」判定。
    expect(
      raw(
        [
          { path: 'dist/main.js', data: 'globalThis.ok = 1;' },
          { path: 'package.json', data: '{"type":"module"}' },
          { path: 'dist/package.json', data: '{"type":"commonjs"}' },
        ],
        withEntry('dist/main.js'),
      )?.status,
    ).toBe('fail');
    // entry 即使扩展名合法，代码规则照常生效。
    expect(
      raw([{ path: 'dist/main.js', data: 'eval("1")' }], withEntry('dist/main.js'))?.status,
    ).toBe('fail');
  });

  it('目录扫描尊重 .kepcup-ignore（构建脚本不随包发布，扫描与 pack 同一排除口径）', async () => {
    const dir = path.join(root, `ignored-${Math.random().toString(36).slice(2, 8)}`);
    const { mkdirSync, writeFileSync: write } = await import('node:fs');
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    write(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        ...runtimeManifest,
        runtime: { ...runtimeManifest.runtime, entry: 'dist/main.js' },
      }),
    );
    write(path.join(dir, 'dist/main.js'), safeCode);
    write(path.join(dir, 'package.json'), '{"type":"module"}');
    write(path.join(dir, 'build.mjs'), "import { createRequire } from 'node:module';\n");
    write(path.join(dir, 'src/main.ts'), 'export const x = 1;\n');
    write(path.join(dir, '.kepcup-ignore'), 'build.mjs\nsrc/\n');
    const files = await scanner.readDirectoryFiles(dir);
    expect(files.map((file) => file.path).sort()).toEqual([
      'dist/main.js',
      'package.json',
      'plugin.json',
    ]);
    expect(
      scanner.scanRuntimePackage({
        files,
        manifest: {
          ...runtimeManifest,
          runtime: { ...runtimeManifest.runtime, entry: 'dist/main.js' },
        },
      }),
    ).toEqual({
      status: 'pass',
      errors: [],
      warnings: [],
    });
  });

  it('白名单匹配语义与宿主 isHostAllowed 一致（*.domain 只匹配子域）', () => {
    expect(scanner.runtimeScanHostAllowed('a.cdn.example.com', ['*.cdn.example.com'])).toBe(true);
    expect(scanner.runtimeScanHostAllowed('cdn.example.com', ['*.cdn.example.com'])).toBe(false);
    expect(scanner.runtimeScanHostAllowed('API.EXAMPLE.COM', ['api.example.com'])).toBe(true);
  });

  it('真实 .kepcup：读包视图并扫描', async () => {
    const archive = await buildRuntimeFixture();
    const view = await scanner.readPackageFiles(archive);
    expect(scanner.scanRuntimePackage(view as never)).toEqual({
      status: 'pass',
      errors: [],
      warnings: [],
    });
  });

  it('CLI：--package 违规包返回 1；--json 输出结构化结果', async () => {
    const archive = await buildRuntimeFixture([{ name: 'evil.node', data: 'x' }]);
    const errors: string[] = [];
    const exit = await scanner.run(['--package', archive, '--json'], {
      out: (message) => errors.push(message),
      err: (message) => errors.push(message),
    });
    expect(exit).toBe(1);
    expect(JSON.parse(errors[0] ?? '{}').status).toBe('fail');
  });

  it('真实官方插件放行：reference-media 与 dashscope-t2i 目录扫描 pass', async () => {
    for (const name of ['reference-media', 'dashscope-t2i']) {
      const dir = path.join(repoRoot, 'plugins', name);
      const manifestPath = path.join(dir, 'plugin.json');
      expect(existsSync(manifestPath), `${name}: 缺少 plugin.json`).toBe(true);
      const files = await scanner.readDirectoryFiles(dir);
      const { readFileSync } = await import('node:fs');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      const result = scanner.scanRuntimePackage({ files, manifest });
      expect(result?.errors, name).toEqual([]);
      expect(result?.status, name).not.toBe('fail');
    }
  });
});

describe('执行型插件 dist 构建（扫描/试点前置）', () => {
  beforeAll(() => {
    for (const name of ['reference-media', 'dashscope-t2i']) {
      const build = path.join(repoRoot, 'plugins', name, 'build.mjs');
      if (!existsSync(build)) continue;
      execFileSync(process.execPath, [build], {
        cwd: repoRoot,
        stdio: 'pipe',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    }
  }, 120_000);

  it('dist/main.js 已产出（构建钩子真实可用）', () => {
    for (const name of ['reference-media', 'dashscope-t2i']) {
      expect(existsSync(path.join(repoRoot, 'plugins', name, 'dist', 'main.js')), name).toBe(true);
    }
  });
});

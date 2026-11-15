#!/usr/bin/env node
// 参考媒体插件打包脚本（D125 P1）：src/main.ts → dist/main.js。
//
// 约定（packages/plugin-sdk/README.md）：esbuild 单文件 ESM、`--platform=node`、
// 禁 native / `__dirname`。esbuild 复用仓库 devDependencies 里的既有版本
// （apps/desktop 0.28.2，经 createRequire 解析），不引入新依赖；@kepcup/plugin-sdk /
// @kepcup/shared 直接 alias 到 workspace 源码（bundle 前不需要先 build），zod 一并打进
// 单文件——插件进程的安装目录没有 node_modules。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const requireFromDesktop = createRequire(path.join(repoRoot, 'apps', 'desktop', 'package.json'));
const esbuild = requireFromDesktop('esbuild');

await esbuild.build({
  entryPoints: [path.join(here, 'src', 'main.ts')],
  outfile: path.join(here, 'dist', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  alias: {
    '@kepcup/plugin-sdk': path.join(repoRoot, 'packages', 'plugin-sdk', 'src', 'index.ts'),
    '@kepcup/shared': path.join(repoRoot, 'packages', 'shared', 'src', 'index.ts'),
  },
});
console.log('built plugins/reference-media/dist/main.js');

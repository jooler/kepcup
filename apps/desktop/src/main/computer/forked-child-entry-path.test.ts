import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getForkedChildEntryPath, unpackedAsarPath } from './forked-child-entry-path';

/** 当前平台上合法的绝对 file URL。Windows 的 fileURLToPath 拒绝没有盘符的 POSIX URL。 */
const root = path.parse(process.cwd()).root;

function fileUrl(parts: string[]): string {
  return pathToFileURL(path.join(root, ...parts)).href;
}

/**
 * D105 sidecar 入口解析的回归测试（2026-10-31 冒烟测试发现）：rollup 把本模块
 * 内联进 out/main/index.js 后 import.meta.url 指向 bundle 自身，按源码目录层级
 * 回溯会多退一级到 out/，capabilities 握手必挂、computer_* 工具永远不注册。
 * 正确语义是「与引用它的 bundle 同目录」——helper 的 socket peer 校验
 * （main.swift 按 /out/main/computer-sidecar.js 前缀）与 electron-builder
 * asarUnpack 都锚定这个布局。
 */
describe('getForkedChildEntryPath', () => {
  it('dev：入口与主进程 bundle 同目录（out/main/）', () => {
    expect(
      getForkedChildEntryPath(
        'computer-sidecar.js',
        fileUrl(['Users', 'x', 'www', 'kepcup', 'out', 'main', 'index.js']),
      ),
    ).toBe(path.join(root, 'Users', 'x', 'www', 'kepcup', 'out', 'main', 'computer-sidecar.js'));
  });

  it('打包：app.asar 内路径映射到 app.asar.unpacked（ELECTRON_RUN_AS_NODE 子进程读不了 asar 内 ESM）', () => {
    expect(
      getForkedChildEntryPath(
        'computer-sidecar.js',
        fileUrl([
          'Applications',
          'KepCup.app',
          'Contents',
          'Resources',
          'app.asar',
          'out',
          'main',
          'index.js',
        ]),
      ),
    ).toBe(
      path.join(
        root,
        'Applications',
        'KepCup.app',
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'out',
        'main',
        'computer-sidecar.js',
      ),
    );
  });

  it('Windows 反斜杠的 app.asar 同样映射到 app.asar.unpacked', () => {
    expect(
      unpackedAsarPath(
        'C:\\Program Files\\KepCup\\resources\\app.asar\\out\\main\\computer-sidecar.js',
      ),
    ).toBe(
      'C:\\Program Files\\KepCup\\resources\\app.asar.unpacked\\out\\main\\computer-sidecar.js',
    );
  });
});

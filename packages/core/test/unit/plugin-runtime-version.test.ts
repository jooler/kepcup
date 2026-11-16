import { describe, expect, it } from 'vitest';
import {
  isHostApiRangeValid,
  parseHostApiRange,
  satisfiesHostApiRange,
} from '../../src/plugins/runtime/version.js';

/**
 * `runtime.hostApi` 范围解析（D125，61 §2 / §3.1）。这是安装管线与握手的同一道门：
 * 语义按 npm 风格（插件清单作者预期），不匹配走 PLUGIN_UPGRADE_REQUIRED、语法错误走
 * PLUGIN_INVALID。本文件覆盖 ^ / ~ / 比较符 / 裸版本 / 通配与拒绝面。
 *
 * 注意 Host API 版本是**整数**（v1 = 1），`satisfiesHostApiRange` 按 `[version,0,0]`
 * 比较：因此 `~1.2` / `1.2` 这类带非零次版本的范围对整数宿主恒不满足（合约要求
 * `>=1.2.0`），它们的上界由 `parseHostApiRange` 直接断言。
 */

describe('parseHostApiRange / isHostApiRangeValid', () => {
  it('可解析：^ / ~ / 比较符序列 / 裸版本 / *', () => {
    for (const range of [
      '^1',
      '^1.2.3',
      '^0.2',
      '~1',
      '~1.2',
      '~1.2.3',
      '>=1.0.0 <2.0.0',
      '1',
      '1.2',
      '1.2.3',
      '*',
      'x',
      '  ^1  ',
    ]) {
      expect(isHostApiRangeValid(range), range).toBe(true);
    }
  });

  it('语法错误：空串 / 非数字 / 未知操作符 / 缺版本', () => {
    for (const range of ['', ' ', 'abc', '>=', '^', '~', '1.x', '>= 1.0.0', '1 || 2', 'v1']) {
      expect(isHostApiRangeValid(range), range).toBe(false);
      expect(parseHostApiRange(range), range).toBeNull();
    }
  });

  it('^1 / ^0.x 的上界（npm caret：锁最左侧非零段）', () => {
    expect(parseHostApiRange('^1')).toEqual([
      { op: '>=', version: [1, 0, 0] },
      { op: '<', version: [2, 0, 0] },
    ]);
    expect(parseHostApiRange('^0.2')).toEqual([
      { op: '>=', version: [0, 2, 0] },
      { op: '<', version: [0, 3, 0] },
    ]);
    expect(parseHostApiRange('^0.0.3')).toEqual([
      { op: '>=', version: [0, 0, 3] },
      { op: '<', version: [0, 0, 4] },
    ]);
    expect(parseHostApiRange('^0.0')).toEqual([
      { op: '>=', version: [0, 0, 0] },
      { op: '<', version: [0, 1, 0] },
    ]);
    expect(parseHostApiRange('^0.0.0')).toEqual([
      { op: '>=', version: [0, 0, 0] },
      { op: '<', version: [0, 0, 1] },
    ]);
  });

  it('~1 / ~1.2 的上界（npm tilde：锁 major 或 major.minor）', () => {
    expect(parseHostApiRange('~1')).toEqual([
      { op: '>=', version: [1, 0, 0] },
      { op: '<', version: [2, 0, 0] },
    ]);
    expect(parseHostApiRange('~1.2')).toEqual([
      { op: '>=', version: [1, 2, 0] },
      { op: '<', version: [1, 3, 0] },
    ]);
  });

  it('裸版本：1 / 1.2 是前缀范围；1.2.3 是精确匹配（不是「>=1.2.3 无上界」）', () => {
    expect(parseHostApiRange('1')).toEqual([
      { op: '>=', version: [1, 0, 0] },
      { op: '<', version: [2, 0, 0] },
    ]);
    expect(parseHostApiRange('1.2')).toEqual([
      { op: '>=', version: [1, 2, 0] },
      { op: '<', version: [1, 3, 0] },
    ]);
    expect(parseHostApiRange('1.2.3')).toEqual([{ op: '=', version: [1, 2, 3] }]);
  });
});

describe('satisfiesHostApiRange（Host API 为整数版本，v1 = 1）', () => {
  it('^1 接受 1.x，拒绝 2.x / 0.x', () => {
    expect(satisfiesHostApiRange('^1', 1)).toBe(true);
    expect(satisfiesHostApiRange('^1', 2)).toBe(false);
    expect(satisfiesHostApiRange('^1', 0)).toBe(false);
  });

  it('~1 接受 1.x，拒绝 2.x（旧的 ~1 → <1.1.0 过窄实现会误拒宿主 1 以外的兼容版本）', () => {
    expect(satisfiesHostApiRange('~1', 1)).toBe(true);
    expect(satisfiesHostApiRange('~1', 2)).toBe(false);
    expect(satisfiesHostApiRange('~1.0', 1)).toBe(true);
  });

  it('比较符序列是合取：>=1 <2 接受 1、拒绝 2', () => {
    expect(satisfiesHostApiRange('>=1 <2', 1)).toBe(true);
    expect(satisfiesHostApiRange('>=1 <2', 2)).toBe(false);
    expect(satisfiesHostApiRange('>=2', 1)).toBe(false);
  });

  it('裸前缀 1 接受整数宿主 1；完整版本 1.2.3 对整数宿主恒不满足', () => {
    expect(satisfiesHostApiRange('1', 1)).toBe(true);
    expect(satisfiesHostApiRange('1', 2)).toBe(false);
    expect(satisfiesHostApiRange('1.2', 1)).toBe(false);
    expect(satisfiesHostApiRange('1.2.3', 1)).toBe(false);
    // 旧实现把 1.2.3 当作「>=1.2.3 无上界」会错误接受 2。
    expect(satisfiesHostApiRange('1.2.3', 2)).toBe(false);
  });

  it('通配 * / x 接受任意宿主版本；语法错误 = 不满足', () => {
    expect(satisfiesHostApiRange('*', 1)).toBe(true);
    expect(satisfiesHostApiRange('*', 99)).toBe(true);
    expect(satisfiesHostApiRange('x', 1)).toBe(true);
    expect(satisfiesHostApiRange('nonsense', 1)).toBe(false);
  });
});

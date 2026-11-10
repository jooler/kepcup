import { describe, expect, it } from 'vitest';

import { readNativeShell } from './shell';

describe('readNativeShell(D122 手机原生壳交接参数)', () => {
  it('shell=native + shellBack → 壳模式 + 首页地址', () => {
    const home = 'capacitor://localhost/index.html';
    expect(readNativeShell(`?shell=native&shellBack=${encodeURIComponent(home)}`)).toEqual({
      native: true,
      home,
    });
  });

  it('shell=native 无 shellBack → 壳模式但首页地址为 null(断开退化 history.back)', () => {
    expect(readNativeShell('?shell=native')).toEqual({ native: true, home: null });
    expect(readNativeShell('?shell=native&shellBack=')).toEqual({ native: true, home: null });
  });

  it('shellBack 只接受本地首页源(iOS capacitor / Android https / 浏览器 dev localhost)', () => {
    const ok = [
      'capacitor://localhost/index.html',
      'https://localhost/index.html',
      'http://localhost:5173/',
    ];
    for (const home of ok) {
      expect(readNativeShell(`?shell=native&shellBack=${encodeURIComponent(home)}`).home).toBe(
        home,
      );
    }
    // 伪链/外站一律视同缺省(审查修复:断开不得导去非本地页)。
    const bad = [
      'https://evil.com/',
      'capacitor://evil.example/',
      'http://192.168.1.5:8642/',
      'javascript:alert(1)',
      'not a url',
    ];
    for (const home of bad) {
      expect(readNativeShell(`?shell=native&shellBack=${encodeURIComponent(home)}`)).toEqual({
        native: true,
        home: null,
      });
    }
  });

  it('无参数(普通浏览器 PWA 路径)→ 非壳', () => {
    expect(readNativeShell('')).toEqual({ native: false, home: null });
    expect(readNativeShell('?x=1')).toEqual({ native: false, home: null });
  });

  it('shell 参数取其他值 → 非壳(枚举值防误配)', () => {
    expect(readNativeShell('?shell=browser')).toEqual({ native: false, home: null });
  });

  it('壳参数与其他应用参数共存', () => {
    const home = 'https://localhost/index.html';
    expect(readNativeShell(`?shell=native&x=2&shellBack=${encodeURIComponent(home)}`)).toEqual({
      native: true,
      home,
    });
  });
});

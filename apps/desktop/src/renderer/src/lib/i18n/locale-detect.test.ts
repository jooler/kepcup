import { describe, expect, it } from 'vitest';
import { pickInitialLocale } from './locale-detect';

describe('首次启动语言推断', () => {
  it('中国时区默认中文，其它时区默认英文', () => {
    expect(pickInitialLocale('Asia/Shanghai', 'en-US')).toBe('zh-CN');
    expect(pickInitialLocale('Asia/Urumqi', 'en-US')).toBe('zh-CN');
    expect(pickInitialLocale('Asia/Hong_Kong', 'en-US')).toBe('zh-CN');
    expect(pickInitialLocale('America/Los_Angeles', 'zh-CN')).toBe('en-US');
    expect(pickInitialLocale('Europe/Berlin', 'zh-CN')).toBe('en-US');
  });

  it('时区不可用时退回系统语言', () => {
    expect(pickInitialLocale('', 'zh-Hans-CN')).toBe('zh-CN');
    expect(pickInitialLocale('', 'en-GB')).toBe('en-US');
    expect(pickInitialLocale('', 'fr-FR')).toBe('en-US');
  });
});

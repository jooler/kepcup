import { describe, expect, it } from 'vitest';
import { enUS } from './locales/en-US';
import { zhCN } from './locales/zh-CN';

const placeholders = (value: string): string[] => (value.match(/\{\w+\}/g) ?? []).sort();

describe('界面语言词典', () => {
  it('en-US 与 zh-CN 的 key 完全一致', () => {
    expect(Object.keys(enUS)).toEqual(Object.keys(zhCN));
  });

  it('英文词典没有空值与中文残留，占位符与中文一致', () => {
    for (const [key, value] of Object.entries(enUS) as Array<[string, string]>) {
      expect(value.trim(), key).not.toBe('');
      expect(value, key).not.toMatch(/[\u4e00-\u9fff]/);
      expect(placeholders(value), key).toEqual(placeholders(zhCN[key as keyof typeof zhCN]));
    }
  });
});

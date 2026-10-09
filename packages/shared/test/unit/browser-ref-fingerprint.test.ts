import { describe, expect, test } from 'vitest';
import { compareRefFingerprint, normalizeRefName, stripSnapshotRefs } from '@kepcup/shared';

const btn = (name: string) => ({ role: 'button', name });

describe('ref fingerprint (W1 stale-ref pre-check)', () => {
  test('same role + name matches; short digit runs (badges, times) are ignored', () => {
    expect(compareRefFingerprint(btn('消息 (3)'), btn('消息 (12)'))).toBeNull();
    expect(compareRefFingerprint(btn('更新于 9:05'), btn('更新于 10:41'))).toBeNull();
  });

  test('long numbers tell elements apart (order ids, amounts)', () => {
    expect(compareRefFingerprint(btn('删除 订单 10023'), btn('删除 订单 10024'))).toBe('name');
  });

  test('role change or different name is stale', () => {
    expect(compareRefFingerprint(btn('删除 A'), { role: 'link', name: '删除 A' })).toBe('role');
    expect(compareRefFingerprint(btn('删除 张三'), btn('删除 李四'))).toBe('name');
  });

  test('no prefix match unless the listed name was cut', () => {
    expect(compareRefFingerprint(btn('Pay'), btn('Pay $500 now'))).toBe('name');
    const long = '很长的按钮名称'.repeat(20);
    expect(compareRefFingerprint(btn(`${long.slice(0, 80)}…`), btn(long))).toBeNull();
  });

  test('empty only matches empty; digit-only names compare raw', () => {
    expect(compareRefFingerprint(btn(''), btn(''))).toBeNull();
    expect(compareRefFingerprint(btn('提交'), btn(''))).toBe('name');
    expect(compareRefFingerprint(btn(''), btn('提交'))).toBe('name');
    expect(compareRefFingerprint(btn('2'), btn('3'))).toBe('name');
    expect(compareRefFingerprint(btn('2'), btn('2'))).toBeNull();
  });

  test('only the first 40 characters count', () => {
    expect(normalizeRefName('a'.repeat(50))).toHaveLength(40);
    expect(compareRefFingerprint(btn(`${'x'.repeat(40)}A`), btn(`${'x'.repeat(40)}B`))).toBeNull();
  });

  test('stripSnapshotRefs removes ref ids only', () => {
    expect(stripSnapshotRefs('- [e1] button “提交 e2”\n- [e12] link')).toBe(
      '- [] button “提交 e2”\n- [] link',
    );
  });
});

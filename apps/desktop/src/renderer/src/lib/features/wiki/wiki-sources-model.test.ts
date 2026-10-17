import { describe, expect, it } from 'vitest';
import { WIKI_TEXT_SOURCE_MAX_CHARS } from '@kepcup/shared';

import {
  formatSourceBytes,
  isValidSourceText,
  isValidSourceUrl,
  sortSourceRows,
  stepSourceDelete,
  WIKI_SOURCE_DELETE_TIMEOUT_MS,
  type WikiSourceRow,
} from './wiki-sources-model';

/**
 * D92 T1b WP10 步骤 5：来源面板纯逻辑——行排序、删除中状态机
 * （wiki_changed 确认 / 30 秒超时还原）、表单校验与体积格式化。
 */

function row(id: string, createdAt: number): WikiSourceRow {
  return {
    id,
    fileName: `${id}.md`,
    bytes: 10,
    createdAt,
    creator: { kind: 'user' },
  };
}

describe('D92 T1b WP10：来源面板排序与格式化', () => {
  it('按 createdAt 倒序，id 作并列裁决；不改动入参', () => {
    const input = [row('ast_a', 1), row('ast_c', 3), row('ast_b', 3), row('ast_d', 9)];
    const sorted = sortSourceRows(input);
    expect(sorted.map((r) => r.id)).toEqual(['ast_d', 'ast_b', 'ast_c', 'ast_a']);
    expect(input.map((r) => r.id)).toEqual(['ast_a', 'ast_c', 'ast_b', 'ast_d']);
  });

  it('体积格式化：B / KB / MB', () => {
    expect(formatSourceBytes(512)).toBe('512 B');
    expect(formatSourceBytes(2048)).toBe('2.0 KB');
    expect(formatSourceBytes(15 * 1024)).toBe('15 KB');
    expect(formatSourceBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('D92 T1b WP10：删除中状态机（stepSourceDelete）', () => {
  it('begin 开启；重复 begin 同一来源被忽略', () => {
    const first = stepSourceDelete(null, { type: 'begin', id: 'ast_a', now: 1_000 });
    expect(first.pending).toEqual({ id: 'ast_a', startedAt: 1_000 });
    expect(first.outcome).toBeNull();
    const second = stepSourceDelete(first.pending, { type: 'begin', id: 'ast_b', now: 1_100 });
    expect(second.pending).toEqual({ id: 'ast_a', startedAt: 1_000 });
    expect(second.outcome).toBeNull();
  });

  it('reloaded：来源从列表消失 → confirmed；仍在列表 → 继续等待', () => {
    const pending = { id: 'ast_a', startedAt: 1_000 };
    const gone = stepSourceDelete(pending, { type: 'reloaded', presentIds: ['ast_b'], now: 2_000 });
    expect(gone.pending).toBeNull();
    expect(gone.outcome).toBe('confirmed');
    const stays = stepSourceDelete(pending, { type: 'reloaded', presentIds: ['ast_a'], now: 2_000 });
    expect(stays.pending).toEqual(pending);
    expect(stays.outcome).toBeNull();
  });

  it('timeout：30 秒未确认 → 还原；未到点不动', () => {
    const pending = { id: 'ast_a', startedAt: 1_000 };
    const early = stepSourceDelete(pending, { type: 'timeout', now: 1_000 + WIKI_SOURCE_DELETE_TIMEOUT_MS - 1 });
    expect(early.pending).toEqual(pending);
    expect(early.outcome).toBeNull();
    const late = stepSourceDelete(pending, { type: 'timeout', now: 1_000 + WIKI_SOURCE_DELETE_TIMEOUT_MS });
    expect(late.pending).toBeNull();
    expect(late.outcome).toBe('timeout');
    // 无挂起删除时 reloaded / timeout 都是空操作。
    expect(stepSourceDelete(null, { type: 'reloaded', presentIds: [], now: 1 })).toEqual({
      pending: null,
      outcome: null,
    });
    expect(stepSourceDelete(null, { type: 'timeout', now: 1 })).toEqual({
      pending: null,
      outcome: null,
    });
  });
});

describe('D92 T1b WP10：添加来源表单校验', () => {
  it('网址必须是可解析的 http(s)', () => {
    expect(isValidSourceUrl('https://example.com/a')).toBe(true);
    expect(isValidSourceUrl('http://example.com')).toBe(true);
    expect(isValidSourceUrl('  https://example.com  ')).toBe(true);
    expect(isValidSourceUrl('ftp://example.com')).toBe(false);
    expect(isValidSourceUrl('example.com')).toBe(false);
    expect(isValidSourceUrl('')).toBe(false);
    expect(isValidSourceUrl('   ')).toBe(false);
  });

  it('文本 trim 非空且不超过 WIKI_TEXT_SOURCE_MAX_CHARS', () => {
    expect(isValidSourceText('正文')).toBe(true);
    expect(isValidSourceText('   ')).toBe(false);
    expect(isValidSourceText('')).toBe(false);
    expect(isValidSourceText('x'.repeat(WIKI_TEXT_SOURCE_MAX_CHARS))).toBe(true);
    expect(isValidSourceText('x'.repeat(WIKI_TEXT_SOURCE_MAX_CHARS + 1))).toBe(false);
  });
});

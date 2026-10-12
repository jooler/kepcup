import { describe, expect, it } from 'vitest';

import {
  PRESENT_CONTEXT_MAX_CHARS,
  PRESENT_DATA_MAX_BYTES,
  presentContextText,
  validatePresent,
} from '../../src/domain/present.js';

/** 声明式展示卡（D87 P4 L1）：每种 kind 的最小 schema、可行动的报错、体积上限、紧凑回放。 */
describe('present', () => {
  it('accepts a minimal valid payload for every kind', () => {
    const samples: Array<[string, unknown]> = [
      [
        'table',
        {
          columns: ['名称', '金额'],
          rows: [
            ['午餐', 32],
            ['打车', null],
          ],
        },
      ],
      [
        'bar',
        { categories: ['一月', '二月'], series: [{ name: '支出', values: [10, 20] }], unit: '元' },
      ],
      ['line', { categories: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2, 3] }] }],
      [
        'pie',
        {
          slices: [
            { label: '餐饮', value: 3 },
            { label: '交通', value: 1 },
          ],
        },
      ],
      ['kpi', { items: [{ label: '收入', value: 1200, unit: '元', change: -5 }] }],
      [
        'steps',
        {
          steps: [
            { title: '下单', status: 'done' },
            { title: '发货', status: 'current' },
          ],
        },
      ],
      ['timeline', { events: [{ time: '10:00', title: '开会' }] }],
      [
        'compare',
        { options: ['A', 'B'], criteria: [{ name: '价格', values: [10, 12] }], recommended: 'A' },
      ],
    ];
    for (const [kind, data] of samples) {
      expect(validatePresent(kind, data)).toMatchObject({ ok: true, kind });
    }
  });

  it('rejects with an actionable message naming the field', () => {
    expect(validatePresent('radar', {})).toMatchObject({ ok: false });
    const mismatch = validatePresent('bar', {
      categories: ['a', 'b'],
      series: [{ name: 's', values: [1] }],
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.message).toContain('categories 的数量');
    const ragged = validatePresent('table', { columns: ['a', 'b'], rows: [['x']] });
    if (!ragged.ok) expect(ragged.message).toContain('data.rows');
    const badRecommend = validatePresent('compare', {
      options: ['A', 'B'],
      criteria: [{ name: 'x', values: [1, 2] }],
      recommended: 'C',
    });
    expect(badRecommend.ok).toBe(false);
    expect(validatePresent('pie', { slices: [{ label: 'x', value: -1 }] }).ok).toBe(false);
    expect(validatePresent('table', { columns: ['a'], rows: [['x']], extra: 1 }).ok).toBe(false);
  });

  it('caps the data size', () => {
    const rows = Array.from({ length: 400 }, () => ['x'.repeat(200)]);
    const result = validatePresent('table', { columns: ['a'], rows });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(String(PRESENT_DATA_MAX_BYTES));
  });

  it('replays compactly and truncates', () => {
    expect(
      presentContextText({
        kind: 'bar',
        title: '月度支出',
        data: {
          categories: ['一月', '二月'],
          series: [{ name: '支出', values: [10, 20] }],
          unit: '元',
        },
      }),
    ).toBe('[展示卡·bar] 月度支出\n支出：一月=10元，二月=20元');
    const big = presentContextText({
      kind: 'table',
      title: '',
      data: { columns: ['a'], rows: Array.from({ length: 300 }, (_, i) => [`第 ${i} 行的内容`]) },
    });
    expect(big.length).toBeLessThanOrEqual(PRESENT_CONTEXT_MAX_CHARS);
    expect(big.endsWith('（已截断）')).toBe(true);
    expect(presentContextText({ kind: 'kpi', title: '', data: { items: 'nope' } })).toContain(
      '数据已损坏',
    );
  });
});

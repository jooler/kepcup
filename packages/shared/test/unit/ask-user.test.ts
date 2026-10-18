import { describe, expect, it } from 'vitest';

import {
  ASK_USER_DISPLAY_MAX_CHARS,
  askUserFieldsSchema,
  checkAskUserAnswer,
} from '../../src/domain/ask-user.js';

/** ask_user 表单化（D87 P4 L2）：多选 / 表单回答的校验与整理（core 与问题卡共用）。 */
describe('checkAskUserAnswer', () => {
  it('multi: subset of the options, card order, at least one', () => {
    const q = { mode: 'multi' as const, options: ['甲', '乙', '丙'], fields: [] };
    expect(checkAskUserAnswer(q, ['丙', '甲'])).toEqual({
      ok: true,
      display: '甲、丙',
      structured: ['甲', '丙'],
    });
    expect(checkAskUserAnswer(q, [])).toMatchObject({ ok: false });
    expect(checkAskUserAnswer(q, 'ab')).toMatchObject({ ok: false });
  });

  it('multi: custom entries are allowed and trail the card options', () => {
    const q = { mode: 'multi' as const, options: ['甲', '乙', '丙'], fields: [] };
    expect(checkAskUserAnswer(q, ['丙', '自定义一', ' 甲 '])).toEqual({
      ok: true,
      display: '甲、丙、自定义一',
      structured: ['甲', '丙', '自定义一'],
    });
    // 候选之外但超长：拒。
    expect(checkAskUserAnswer(q, ['x'.repeat(201)])).toMatchObject({ ok: false });
    // 空白条目：拒。
    expect(checkAskUserAnswer(q, ['甲', '  '])).toMatchObject({ ok: false });
    // 超过条目上限（含自定义）：拒。
    expect(
      checkAskUserAnswer(q, Array.from({ length: 13 }, (_, i) => `第${i}项`)),
    ).toMatchObject({ ok: false });
  });

  it('form: required, number, date, select, unknown keys', () => {
    const fields = askUserFieldsSchema.parse([
      { name: 'n', label: '数量', type: 'number', required: true },
      { name: 'd', label: '日期', type: 'date' },
      { name: 's', label: '口味', type: 'select', options: ['甜', '咸'] },
      { name: 't', label: '备注', type: 'text' },
    ]);
    const q = { mode: 'form' as const, options: [], fields };
    expect(checkAskUserAnswer(q, { n: '3', s: '甜' })).toEqual({
      ok: true,
      display: '数量：3；口味：甜',
      structured: { n: 3, s: '甜' },
    });
    expect(checkAskUserAnswer(q, { s: '甜' })).toMatchObject({
      ok: false,
      message: '「数量」必填',
    });
    expect(checkAskUserAnswer(q, { n: 'x' })).toMatchObject({ ok: false });
    expect(checkAskUserAnswer(q, { n: '1', d: '11/01' })).toMatchObject({ ok: false });
    expect(checkAskUserAnswer(q, { n: '1', s: '辣' })).toMatchObject({ ok: false });
    expect(checkAskUserAnswer(q, { n: '1', z: '?' })).toMatchObject({ ok: false });
  });

  it('form: the card line is clipped (fits tasks.answer), the structured answer is not', () => {
    const fields = askUserFieldsSchema.parse(
      Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, label: `字段${i}`, type: 'text' })),
    );
    const values = Object.fromEntries(fields.map((f) => [f.name, 'x'.repeat(1_000)]));
    const checked = checkAskUserAnswer({ mode: 'form', options: [], fields }, values);
    if (!checked.ok) throw new Error(checked.message);
    expect(checked.display.length).toBe(ASK_USER_DISPLAY_MAX_CHARS);
    expect(checked.display.endsWith('…')).toBe(true);
    expect((checked.structured as Record<string, string>).f7).toHaveLength(1_000);
  });

  it('field schema: select needs options, names unique', () => {
    expect(askUserFieldsSchema.safeParse([{ name: 'a', label: 'A', type: 'select' }]).success).toBe(
      false,
    );
    expect(
      askUserFieldsSchema.safeParse([
        { name: 'a', label: 'A', type: 'text' },
        { name: 'a', label: 'B', type: 'text' },
      ]).success,
    ).toBe(false);
  });
});

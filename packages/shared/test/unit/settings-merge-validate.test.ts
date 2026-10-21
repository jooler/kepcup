import { describe, expect, it } from 'vitest';
import {
  getSettingItem,
  listSettingItems,
  mergePatchOnto,
  mergeThreeWay,
  settingValuesProblems,
  settingsDeepEqual,
  settingsUpdateInputSchema,
  settingsSchema,
  botsUpdateInputSchema,
  settingsCardsCompleteInputSchema,
  setupRequirementSchema,
} from '../../src/index.js';

/**
 * D89 审查修复：三方合并（过期表单不覆盖并发修改）与 `values` 的形状校验。
 */

function item(id: string) {
  const found = getSettingItem(id);
  if (found === null) throw new Error(id);
  return found;
}

describe('mergeThreeWay', () => {
  it('keeps the latest value for fields the form did not touch', () => {
    const base = { model: 'a', light: 'x', nested: { p: 1, q: 1 } };
    const mine = { model: 'a', light: 'y', nested: { p: 1, q: 2 } };
    const theirs = { model: 'b', light: 'x', nested: { p: 3, q: 1 } };
    expect(mergeThreeWay(base, mine, theirs)).toEqual({
      model: 'b',
      light: 'y',
      nested: { p: 3, q: 2 },
    });
  });

  it('the form wins when both sides changed the same leaf', () => {
    expect(mergeThreeWay({ v: 1 }, { v: 2 }, { v: 3 })).toEqual({ v: 2 });
    expect(mergeThreeWay(['a'], ['b'], ['c'])).toEqual(['b']);
  });

  it('merges id-keyed lists entry by entry', () => {
    const base = [
      { id: 'a', enabled: false, url: 'u1' },
      { id: 'gone', enabled: true },
      { id: 'kept', enabled: true },
    ];
    const mine = [
      { id: 'a', enabled: true, url: 'u1' },
      { id: 'gone', enabled: true },
      { id: 'kept', enabled: false },
      { id: 'mine-new', enabled: true },
    ];
    const theirs = [
      { id: 'a', enabled: false, url: 'u2' },
      { id: 'kept', enabled: true },
      { id: 'their-new', enabled: true },
    ];
    expect(mergeThreeWay(base, mine, theirs)).toEqual([
      // both edited different fields of `a`
      { id: 'a', enabled: true, url: 'u2' },
      // `gone` deleted elsewhere, untouched here → stays deleted; `kept` edited here → kept
      { id: 'kept', enabled: false },
      { id: 'mine-new', enabled: true },
      { id: 'their-new', enabled: true },
    ]);
    // deleted by the form, untouched elsewhere → deleted
    expect(
      mergeThreeWay([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]),
    ).toEqual([{ id: 'a' }]);
  });

  it('mergePatchOnto only merges keys present in base', () => {
    const latest = { a: 2, b: 2, c: 2 };
    expect(mergePatchOnto({ a: 1, b: 9 }, { a: 1 }, latest)).toEqual({ a: 2, b: 9 });
    expect(mergePatchOnto({ a: 1 }, undefined, latest)).toEqual({ a: 1 });
  });

  it('record keys like __proto__ / constructor are merged as plain own keys', () => {
    const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;
    const base = parse('{"__proto__":{"enabled":false},"constructor":1,"x":1}');
    const mine = parse('{"__proto__":{"enabled":true},"constructor":1,"x":1}');
    const theirs = parse('{"__proto__":{"enabled":false},"constructor":2,"x":2}');
    const merged = mergeThreeWay(base, mine, theirs) as Record<string, unknown>;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual({ enabled: true });
    expect(merged.constructor).toBe(2);
    expect(merged.x).toBe(2);
    // A key missing on one side is not read from the prototype chain.
    expect(
      settingsDeepEqual(
        { a: 1 },
        Object.fromEntries([
          ['a', 1],
          ['constructor', undefined],
        ]),
      ),
    ).toBe(true);
    expect(settingsDeepEqual(parse('{"toString":1}'), parse('{"toString":1}'))).toBe(true);
    const patched = mergePatchOnto(
      parse('{"__proto__":{"a":2}}'),
      parse('{"__proto__":{"a":1}}'),
      parse('{"__proto__":{"a":1}}'),
    );
    expect(Object.getPrototypeOf(patched)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(patched, '__proto__')?.value).toEqual({ a: 2 });
  });

  it('deep equality ignores key order and undefined keys', () => {
    expect(settingsDeepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(settingsDeepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(settingsDeepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('appLanguage (renderer-synced UI language)', () => {
  it('defaults to zh-CN and accepts en-US through settings.update', () => {
    expect(settingsSchema.parse({}).appLanguage).toBe('zh-CN');
    expect(settingsUpdateInputSchema.parse({ appLanguage: 'en-US' })).toEqual({
      appLanguage: 'en-US',
    });
    expect(settingsUpdateInputSchema.safeParse({ appLanguage: 'fr-FR' }).success).toBe(false);
  });
});

describe('settingValuesProblems', () => {
  it('accepts well-formed values for every catalog field type', () => {
    expect(
      settingValuesProblems(item('models.concurrency'), { provider: 'openai', limit: 4 }),
    ).toEqual([]);
    expect(
      settingValuesProblems(item('bot.network'), { policy: 'allowlist', allowlist: ['a.com'] }),
    ).toEqual([]);
    expect(settingValuesProblems(item('bot.network'), { allowlist: 'a.com, b.com' })).toEqual([]);
    expect(
      settingValuesProblems(item('capability.image'), { provider: 'dashscope', apiKey: 'k' }),
    ).toEqual([]);
    expect(settingValuesProblems(item('general.language'), { language: 'zh-CN' })).toEqual([]);
  });

  it('rejects unknown keys, wrong types and values outside static options', () => {
    expect(settingValuesProblems(item('models.concurrency'), { limit: '4' })).toEqual([
      'limit 应为数字',
    ]);
    expect(settingValuesProblems(item('general.launch-at-login'), { enabled: 'yes' })).toEqual([
      'enabled 应为 true / false',
    ]);
    expect(settingValuesProblems(item('bot.network'), { policy: 'everything' })).toEqual([
      'policy 只能是 none / allowlist / open',
    ]);
    expect(settingValuesProblems(item('general.language'), { language: 'xx' })).toEqual([
      'language 只能是 zh-CN / en-US',
    ]);
    expect(
      settingValuesProblems(item('general.language'), { language: 'zh-CN', extra: true }),
    ).toEqual(['没有字段 extra']);
    expect(settingValuesProblems(item('project.title'), { title: 'x'.repeat(501) })).toEqual([
      'title 应为字符串',
    ]);
    expect(settingValuesProblems(item('workdir.ports'), { ports: [1, 'x'] })).toEqual([
      'ports 应为数字列表',
    ]);
  });

  it('every static select option of the catalog passes its own check', () => {
    for (const entry of listSettingItems()) {
      for (const field of entry.fields) {
        if (field.options !== 'static' || field.multiple === true) continue;
        for (const option of field.staticOptions ?? []) {
          expect(settingValuesProblems(entry, { [field.name]: option.value })).toEqual([]);
        }
      }
    }
  });
});

describe('contracts touched by the review fixes', () => {
  it('settings.update / bots.update accept an optional base snapshot', () => {
    expect(
      settingsUpdateInputSchema.parse({
        defaultMainModel: 'a/b',
        base: { defaultMainModel: 'a/c' },
      }),
    ).toEqual({
      defaultMainModel: 'a/b',
      base: { defaultMainModel: 'a/c' },
    });
    const profile = { identity: { name: 'x', bio: '' } };
    expect(botsUpdateInputSchema.parse({ id: 'b', profile, base: profile }).base).toEqual(profile);
  });

  it('settings.cards.complete takes an optional auto flag; the setting requirement carries before', () => {
    expect(settingsCardsCompleteInputSchema.parse({ messageId: 'm', auto: true })).toEqual({
      messageId: 'm',
      auto: true,
    });
    expect(
      setupRequirementSchema.parse({
        kind: 'setting',
        itemId: 'mcp.servers',
        before: { server: 'srv', enabled: false },
        reason: 'r',
      }),
    ).toMatchObject({ before: { server: 'srv', enabled: false } });
  });
});

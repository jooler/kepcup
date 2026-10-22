import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoSaveField, type FieldSavePlan } from './autosave-field.svelte';

/**
 * 项目详情页「名称 / 目标」的自动保存调度（D92 41 §11.3 审查修复）：
 * IME 组合期不提交半成品、blur 尊重组合态、失败回滚不吞飞行期新输入、
 * 卸载补提交且不双保存。真实的 Svelte 响应式运行时（desktop-svelte 项目）；
 * 纯判定（trim / 还原 / 截断）在 project-settings-model.test.ts。
 */

const DELAY_MS = 400;

/** 与名称字段同形的判定：空 → 还原；相同 → 跳过；否则 trim 后提交。 */
const plan = (draft: string, current: string | null): FieldSavePlan => {
  const next = draft.trim();
  if (next.length === 0) return { kind: 'restore' };
  if (next === current) return { kind: 'skip' };
  return { kind: 'save', value: next };
};

interface Fixture {
  field: AutoSaveField;
  /** 已提交的值，按顺序。 */
  calls: Array<string | null>;
  saved: { value: string | null };
  setSaved: (value: string | null) => void;
  fail: () => void;
  /** 挂起提交的 resolve 队列（deferred 模式）。 */
  resolve: (index: number, ok: boolean) => void;
}

/** immediate=true 时提交立刻落定；false 时挂起，由测试手动 resolve。 */
function setup(initial: string, immediate = true): Fixture {
  const calls: Array<string | null> = [];
  const saved = { value: initial } as { value: string | null };
  const pending: Array<(ok: boolean) => void> = [];
  let failNext = false;
  const field = new AutoSaveField({
    delayMs: DELAY_MS,
    plan,
    current: () => saved.value,
    save: async (value) => {
      calls.push(value);
      const fail = failNext;
      failNext = false;
      // 模拟 chat store：成功后已保存值更新为提交值（失败保持旧值）。
      const settle = (ok: boolean): boolean => {
        if (ok && value !== null) saved.value = value;
        return ok;
      };
      if (immediate) return settle(!fail);
      return new Promise<boolean>((resolve) => {
        pending.push((ok) => resolve(settle(!fail && ok)));
      });
    },
  });
  field.sync(initial);
  return {
    field,
    calls,
    saved,
    setSaved: (value) => {
      saved.value = value;
      field.sync(value);
    },
    fail: () => {
      failNext = true;
    },
    resolve: (index, ok) => pending[index]?.(ok),
  };
}

const compositionInput = { isComposing: true } as InputEvent;
const plainInput = {} as InputEvent;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AutoSaveField：停顿防抖提交', () => {
  it('停满延迟提交一次，期间不提交；再次输入重新计时', async () => {
    const { field, calls } = setup('旧名');
    field.draft = '新名';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(calls).toEqual([]);
    field.draft = '更新名';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['更新名']);
  });

  it('flush（回车/失焦）立即提交并撤掉挂起计时器，不双保存', async () => {
    const { field, calls } = setup('旧名');
    field.draft = '新名';
    field.onInput(plainInput);
    field.flush();
    expect(calls).toEqual(['新名']);
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual(['新名']);
  });

  it('草稿与已保存值相同不提交；清空只在 flush 时还原已保存值', async () => {
    const { field, calls } = setup('旧名');
    field.draft = ' 旧名 ';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual([]);

    field.draft = '';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual([]);
    expect(field.draft).toBe('');

    field.flush(true);
    expect(calls).toEqual([]);
    expect(field.draft).toBe('旧名');
  });
});

describe('AutoSaveField：IME 组合期不提交半成品', () => {
  it('组合中的每步 input 不调度；中途停满延迟也不提交；组合结束才提交上屏文本', async () => {
    const { field, calls } = setup('旧名');
    field.onCompositionStart();
    field.draft = 'xin';
    field.onInput(compositionInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS * 3); // 组合中停顿远超延迟
    expect(calls).toEqual([]);

    field.draft = '新';
    field.onCompositionEnd();
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['新']);
  });

  it('compositionstart 撤掉组合前的挂起计时（拼音串不会中途触发提交）', async () => {
    const { field, calls } = setup('旧名');
    field.draft = 'a'; // 组合前先敲了一个字母，防抖已挂起
    field.onInput(plainInput);
    field.onCompositionStart();
    field.draft = 'axiangmu';
    field.onInput(compositionInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual([]);

    field.draft = 'a项目';
    field.onCompositionEnd();
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['a项目']); // 组合前的输入一并提交，无丢失
  });

  it('组合中的 blur（flush）不提交半成品，组合结束的调度补上', async () => {
    const { field, calls } = setup('旧名');
    field.onCompositionStart();
    field.draft = 'weiwancheng';
    field.onInput(compositionInput);
    field.flush();
    expect(calls).toEqual([]);

    field.draft = '未完成';
    field.onCompositionEnd();
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['未完成']);
  });
});

describe('AutoSaveField：失败回滚与飞行期新输入', () => {
  it('失败且草稿未变：回滚为已保存值', async () => {
    const { field, calls, fail } = setup('旧名');
    fail();
    field.draft = '保存不了的名';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['保存不了的名']);
    expect(field.draft).toBe('旧名');
    // 回滚后与已保存值一致，不再反复重试。
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual(['保存不了的名']);
  });

  it('失败但飞行期间有新输入：不回滚，新草稿自动补一轮提交', async () => {
    const { field, calls, resolve } = setup('旧名', false);
    field.draft = '飞行中改名';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['飞行中改名']);

    field.draft = '又改了'; // 提交飞行中用户继续输入
    resolve(0, false); // 本次保存失败
    await vi.advanceTimersByTimeAsync(0);
    expect(field.draft).toBe('又改了'); // 不被旧值吞掉

    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['飞行中改名', '又改了']);
  });

  it('飞行中的 flush 不双提交，落定后按需补一轮', async () => {
    const { field, calls, resolve } = setup('旧名', false);
    field.draft = '第一次';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    field.draft = '飞行中的新草稿';
    field.flush(); // 飞行锁挡住，不重复提交
    expect(calls).toEqual(['第一次']);
    resolve(0, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['第一次', '飞行中的新草稿']);
  });
});

describe('AutoSaveField：卸载清理', () => {
  it('挂起计时器随卸载清掉，未保存的编辑补提交一次', async () => {
    const { field, calls } = setup('旧名');
    field.draft = '没 blur 就切走';
    field.onInput(plainInput);
    field.dispose();
    expect(calls).toEqual(['没 blur 就切走']);
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual(['没 blur 就切走']); // 计时器已清，不重复
  });

  it('组合中卸载：丢弃半成品，不提交也不残留计时器', async () => {
    const { field, calls } = setup('旧名');
    field.onCompositionStart();
    field.draft = 'pin';
    field.onInput(compositionInput);
    field.dispose();
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual([]);
  });
});

describe('AutoSaveField：外部已保存值同步', () => {
  it('草稿干净时跟随已保存值；有未保存编辑时保留草稿', () => {
    const { field, setSaved } = setup('旧名');
    setSaved('别处改的名');
    expect(field.draft).toBe('别处改的名');

    field.draft = '本地编辑';
    setSaved('别处又改了');
    expect(field.draft).toBe('本地编辑');
  });
});

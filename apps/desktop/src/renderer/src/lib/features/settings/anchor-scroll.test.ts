import { describe, expect, test } from 'vitest';
import {
  ANCHOR_SCROLL_MARGIN,
  focusSettingsAnchor,
  revealSettingsAnchor,
  scrollToSettingsAnchor,
  type AnchorScrollContainer,
} from './anchor-scroll';

function container(
  options: { containerTop?: number; targetTop?: number | null; scrollTop?: number } = {},
) {
  const scrolls: number[] = [];
  const queries: string[] = [];
  const el: AnchorScrollContainer & { scrolls: number[]; queries: string[] } = {
    scrollTop: options.scrollTop ?? 0,
    scrolls,
    queries,
    querySelector(selector) {
      queries.push(selector);
      const top = options.targetTop === undefined ? 300 : options.targetTop;
      return top === null ? null : { getBoundingClientRect: () => ({ top }) };
    },
    getBoundingClientRect: () => ({ top: options.containerTop ?? 100 }),
    scrollTo({ top }) {
      scrolls.push(top);
    },
  };
  return el;
}

describe('scrollToSettingsAnchor', () => {
  test('按目标相对容器的偏移 + 当前 scrollTop 减留白算滚动位置', () => {
    const el = container({ containerTop: 100, targetTop: 300, scrollTop: 50 });
    expect(scrollToSettingsAnchor(el, 'default-models')).toBe(true);
    expect(el.queries).toEqual(['[data-settings-anchor="default-models"]']);
    expect(el.scrolls).toEqual([50 + 200 - ANCHOR_SCROLL_MARGIN]);
  });

  test('目标在容器顶部之上时不滚成负值', () => {
    const el = container({ containerTop: 100, targetTop: 100, scrollTop: 0 });
    scrollToSettingsAnchor(el, 'x');
    expect(el.scrolls).toEqual([0]);
  });

  test('找不到目标返回 false 且不滚动', () => {
    const el = container({ targetTop: null });
    expect(scrollToSettingsAnchor(el, 'missing')).toBe(false);
    expect(el.scrolls).toEqual([]);
  });
});

describe('revealSettingsAnchor', () => {
  test('等渲染 tick 之后才滚动，并在滚动后清除锚点', async () => {
    const order: string[] = [];
    const el = container();
    const originalScrollTo = el.scrollTo.bind(el);
    el.scrollTo = (o) => {
      order.push('scroll');
      originalScrollTo(o);
    };
    await revealSettingsAnchor({
      anchor: 'a',
      container: () => el,
      flush: async () => {
        order.push('flush');
      },
      clear: () => order.push('clear'),
    });
    expect(order).toEqual(['flush', 'scroll', 'clear']);
  });

  test('容器已卸载 / 目标不存在也要清锚点', async () => {
    let cleared = 0;
    await revealSettingsAnchor({
      anchor: 'a',
      container: () => null,
      flush: async () => {},
      clear: () => void (cleared += 1),
    });
    await revealSettingsAnchor({
      anchor: 'a',
      container: () => container({ targetTop: null }),
      flush: async () => {},
      clear: () => void (cleared += 1),
    });
    expect(cleared).toBe(2);
  });

  test('内容异步就绪：attempts 内重试直到找到目标（右栏 Bot 配置）', async () => {
    let ready = 0;
    const waits: string[] = [];
    const found = await revealSettingsAnchor({
      anchor: 'bot-model',
      container: () => container({ targetTop: ready >= 2 ? 300 : null }),
      flush: async () => {},
      wait: async () => {
        ready += 1;
        waits.push('wait');
      },
      clear: () => undefined,
      attempts: 5,
    });
    expect(found).toBe(true);
    expect(waits).toEqual(['wait', 'wait']);
  });

  test('重试用尽仍找不到：返回 false 并清锚点', async () => {
    let cleared = false;
    const found = await revealSettingsAnchor({
      anchor: 'bot-model',
      container: () => container({ targetTop: null }),
      flush: async () => {},
      clear: () => void (cleared = true),
      attempts: 3,
    });
    expect(found).toBe(false);
    expect(cleared).toBe(true);
  });
});

describe('focusSettingsAnchor（群设置 / 工作目录设置对话框）', () => {
  test('滚进视野并聚焦锚点内第一个输入控件', () => {
    const calls: string[] = [];
    const root = {
      querySelector: (selector: string) =>
        selector === '[data-settings-anchor="group-title"]'
          ? {
              scrollIntoView: () => calls.push('scroll'),
              querySelector: (inner: string) =>
                inner === 'input, textarea, select' ? { focus: () => calls.push('focus') } : null,
            }
          : null,
    };
    expect(focusSettingsAnchor(root, 'group-title')).toBe(true);
    expect(calls).toEqual(['scroll', 'focus']);
    expect(focusSettingsAnchor(root, 'missing')).toBe(false);
  });
});

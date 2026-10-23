import { flushSync } from 'svelte';
import { BOT_WIDGET_CONSENT_STORAGE_KEY, BOT_WIDGET_CONSENTS_MAX, type WidgetCard } from '@kepcup/shared';
import { describe, expect, test } from 'vitest';
import { WidgetConsentStore, widgetConsentKey, type ConsentStorage } from './consent.svelte';

/**
 * 组件按版本确认记忆（真实 Svelte 响应式运行时）：BotWidgetCard 的海报可点态是
 * `$derived(!widgetConsented(card))`——确认必须让读取即时更新，因此这里不只测
 * 存取回路，还测快照的反应性（effect 跟踪 consented 的变化）。
 */

function fakeStorage(initial: Record<string, string> = {}): ConsentStorage & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

function failingSetStorage(): ConsentStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    },
  };
}

let seq = 0;
function card(sha256 = 'a'.repeat(64)): WidgetCard {
  seq += 1;
  return {
    messageId: `m${seq}`,
    sha256,
    queriesSha256: 'b'.repeat(64),
  } as unknown as WidgetCard;
}

describe('widget consent store', () => {
  test('构造时装载 localStorage 已有确认；remember 写穿回存储', () => {
    const first = card();
    const key = widgetConsentKey(first);
    const storage = fakeStorage({
      [BOT_WIDGET_CONSENT_STORAGE_KEY]: JSON.stringify({ [key]: true }),
    });
    const store = new WidgetConsentStore(storage);
    expect(store.consented(first)).toBe(true);

    const second = card('c'.repeat(64));
    expect(store.consented(second)).toBe(false);
    store.remember(second);
    expect(store.consented(second)).toBe(true);
    const persisted = JSON.parse(storage.store.get(BOT_WIDGET_CONSENT_STORAGE_KEY) ?? '{}') as Record<
      string,
      boolean
    >;
    expect(persisted[widgetConsentKey(second)]).toBe(true);
    expect(persisted[key]).toBe(true);
  });

  test('只认严格 true；损坏 JSON / 数组 / 非布尔值都按未确认', () => {
    const key = widgetConsentKey(card());
    expect(
      new WidgetConsentStore(
        fakeStorage({ [BOT_WIDGET_CONSENT_STORAGE_KEY]: '{"broken' }),
      ).consented(card()),
    ).toBe(false);
    expect(
      new WidgetConsentStore(
        fakeStorage({ [BOT_WIDGET_CONSENT_STORAGE_KEY]: JSON.stringify([key]) }),
      ).consented(card()),
    ).toBe(false);
    expect(
      new WidgetConsentStore(
        fakeStorage({ [BOT_WIDGET_CONSENT_STORAGE_KEY]: JSON.stringify({ [key]: 'yes' }) }),
      ).consented(card()),
    ).toBe(false);
  });

  test('无存储（node / 隐私模式）：内存内可用，remember 不抛', () => {
    const store = new WidgetConsentStore(null);
    expect(store.consented(card())).toBe(false);
    expect(() => store.remember(card())).not.toThrow();
    expect(store.consented(card())).toBe(true);
  });

  test('setItem 抛错（配额）：状态已更新，不抛给调用方', () => {
    const store = new WidgetConsentStore(failingSetStorage());
    expect(() => store.remember(card())).not.toThrow();
    expect(store.consented(card())).toBe(true);
  });

  test('有界：超过 BOT_WIDGET_CONSENTS_MAX 丢最旧的确认', () => {
    const store = new WidgetConsentStore(null);
    for (let i = 0; i <= BOT_WIDGET_CONSENTS_MAX; i += 1) {
      store.remember(card(i.toString(16).padStart(64, '0')));
    }
    expect(store.consented(card('0'.repeat(64)))).toBe(false);
    expect(store.consented(card(BOT_WIDGET_CONSENTS_MAX.toString(16).padStart(64, '0')))).toBe(true);
  });

  test('反应性：remember 后跟踪 consented 的 effect 即时重跑（海报可点态的基础）', () => {
    const store = new WidgetConsentStore(null);
    const target = card();
    const seen: boolean[] = [];
    let cleanups = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(store.consented(target));
        return () => {
          cleanups += 1;
        };
      });
    });
    flushSync();
    expect(seen).toEqual([false]);
    expect(cleanups).toBe(0);

    store.remember(target);
    flushSync();
    // 同一个 effect 重跑（先跑上一次的清理），读到新快照值——组件里的
    // $derived(!widgetConsented(card)) 同样直接吃到新值。
    expect(seen).toEqual([false, true]);
    expect(cleanups).toBe(1);

    stop();
    expect(cleanups).toBe(2);
  });
});

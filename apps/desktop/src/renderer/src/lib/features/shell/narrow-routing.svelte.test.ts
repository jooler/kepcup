import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import type { NarrowTab } from './narrow-layout';
import { bindNarrowRouting } from './narrow-routing.svelte';

/**
 * 回归：任意 tab 下的会话打开路由（通讯录「打开对话」/ 通知点击 / 深链）不被
 * tab 读取依赖弹回。
 *
 * 根因（历史）：「有会话 → 切对话 tab」的 effect 曾在 chat.current 非空时读了
 * `narrowLayout.tab`（成为依赖），别的 effect 调 selectTab 改了 tab，前者随即重跑，
 * 又把 tab 切回 'chats'，所有深链在会话详情里失效。现在对 tab 的读取必须 untrack
 * （见 narrow-routing.svelte.ts）。
 *
 * 这里在真实的 Svelte 响应式运行时（desktop-svelte 项目）里用与 NarrowShell 完全相同的
 * 路由函数 + 与真实 store 同形的响应式替身复现。（扩展中心深链 → 「扩展」tab 不走本
 * 模块：openExtensionCenter 在 shell store 里直接 selectTab。）
 */

class FakeLayout {
  tab = $state<NarrowTab>('chats');
  botDetailOpen = $state(false);
  selectCalls: NarrowTab[] = [];
  selectTab(tab: NarrowTab): void {
    this.selectCalls.push(tab);
    this.tab = tab;
    this.botDetailOpen = false;
  }
}

/** chat.current：select 时落新对象，属性更新不换引用。 */
class FakeChat {
  current = $state<{ id: string; messages: string[] } | null>(null);
  select(id: string): void {
    this.current = { id, messages: [] };
  }
}

function setup() {
  const layout = new FakeLayout();
  const chat = new FakeChat();
  const stop = $effect.root(() => {
    bindNarrowRouting({ currentChat: () => chat.current, layout });
  });
  flushSync();
  return { layout, chat, stop };
}

describe('bindNarrowRouting', () => {
  it('会话详情里切到「通讯录」tab（openSettings("contacts") 的路由）不被弹回「对话」', () => {
    const { layout, chat, stop } = setup();
    chat.select('conv_1');
    flushSync();
    expect(layout.tab).toBe('chats');
    layout.selectTab('contacts');
    flushSync();
    expect(layout.tab).toBe('contacts');
    expect(layout.selectCalls).toEqual(['contacts']);
    stop();
  });

  it('在其它 tab 下打开会话（通讯录「打开对话」/ 通知点击）→ 切到「对话」tab', () => {
    const { layout, chat, stop } = setup();
    layout.selectTab('contacts');
    flushSync();
    chat.select('conv_2');
    flushSync();
    expect(layout.tab).toBe('chats');
    stop();
  });

  it('重复打开同一会话（新对象）仍会触发；属性级更新不触发', () => {
    const { layout, chat, stop } = setup();
    chat.select('conv_1');
    flushSync();
    layout.selectTab('me');
    flushSync();
    // 消息到达：属性更新，不能把用户从「我」tab 拽走。
    chat.current!.messages.push('hi');
    flushSync();
    expect(layout.tab).toBe('me');
    // 再次 select 同一会话：落新对象，视为一次「打开」。
    chat.select('conv_1');
    flushSync();
    expect(layout.tab).toBe('chats');
    stop();
  });

  it('没有会话时不动 tab', () => {
    const { layout, stop } = setup();
    layout.selectTab('extensions');
    flushSync();
    expect(layout.tab).toBe('extensions');
    expect(layout.selectCalls).toEqual(['extensions']);
    stop();
  });
});

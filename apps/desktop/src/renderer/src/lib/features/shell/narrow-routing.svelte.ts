/**
 * 窄屏的两条「外部事件 → 底部 tab」路由（NarrowShell 调用）。独立成模块是为了能在
 * 真实的 Svelte 响应式运行时里单测（narrow-routing.svelte.test.ts）——这两条 effect
 * 共享 `narrowLayout.tab`，一旦依赖写错就会互相把对方的跳转弹回去。
 *
 * 1. 会话变化 → 切到「对话」tab：任意 tab 下打开了会话（通讯录「打开对话」、系统通知
 *    点击、记忆证据跳转……）跳到对话 tab 呈现详情。**只依赖会话对象的引用**：每次
 *    select 都落新对象（重复打开同一会话也触发），属性级更新（消息到达等）不触发；
 *    对 tab 的读取必须 untrack——否则它成了依赖，别处（下面的扩展中心深链）把 tab 切到
 *    「扩展」时本 effect 立刻重跑又把 tab 弹回「对话」，所有 openExtensionCenter /
 *    openSettings('contacts') 深链在会话详情里全部失效（回归测试覆盖）。
 * 2. 扩展中心深链 → 「扩展」tab：窄屏扩展中心不以弹框呈现，各处的 openExtensionCenter
 *    （设置「应用 → 去添加」、技能面板等）统一重路由到底部「扩展」tab。
 */
import { untrack } from 'svelte';
import type { NarrowTab } from './narrow-layout';

export interface NarrowRoutingDeps {
  /** 当前会话对象（chat.current）；null = 没有打开的会话。 */
  currentChat: () => unknown;
  shell: { extensionCenterOpen: boolean };
  layout: { readonly tab: NarrowTab; selectTab(tab: NarrowTab): void };
}

/** 必须在组件初始化（或 `$effect.root`）内调用。 */
export function bindNarrowRouting(deps: NarrowRoutingDeps): void {
  $effect(() => {
    if (deps.currentChat() === null) return;
    untrack(() => {
      if (deps.layout.tab !== 'chats') deps.layout.selectTab('chats');
    });
  });

  $effect(() => {
    if (!deps.shell.extensionCenterOpen) return;
    deps.shell.extensionCenterOpen = false;
    untrack(() => deps.layout.selectTab('extensions'));
  });
}

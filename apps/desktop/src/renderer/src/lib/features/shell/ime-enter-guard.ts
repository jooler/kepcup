/**
 * IME 回车守卫（全局，捕获阶段）：
 *
 * 中文等拼音输入法在候选浮窗里按 Enter 是「确认候选 / 上屏」，不是业务确认；
 * 但 keydown 仍会带着 isComposing=true（keyCode 229）派发到输入框，各处
 * `key === 'Enter'` 的确认逻辑（提交 env、保存名称、登录输入……）会把选词
 * 当成确认直接触发。过去靠各组件自行判断 isComposing，漏网不少（设置页
 * McpSection、AppConnectionDetail、RightPanel、AgentCard、McpbInstall、
 * SetupQuestionCard、ApprovalCard……），且每处新写确认逻辑都容易再漏。
 *
 * 这里在 window 的捕获阶段统一截停合成中的 Enter：事件到不了任何组件监听器
 * （元素 onkeydown、document/window 上的冒泡监听一并失效），存量与新增的
 * 确认逻辑无需再各自判断。只 stopPropagation、不 preventDefault——输入法
 * 照常选词上屏，浏览器默认行为不受影响。组件里已有的 isComposing 守卫保留
 * （等价且无害）。
 *
 * 范围：只拦 Enter（候选确认键）。合成中的方向键等其它按键有各自的组件语义
 * （如 Composer 的 @ 提及导航），仍由那些组件已有的 isComposing 判断处理。
 */

/** 事件最小面（单测用替身）。 */
export interface KeyEventLike {
  key: string;
  /** Windows 上合成中的按键 key 一律是 'Process'，需按 code 区分物理键。 */
  code?: string;
  isComposing: boolean;
  keyCode: number;
}

/** 是否为「输入法合成中确认候选」的 Enter。 */
export function isImeComposingEnter(event: KeyEventLike): boolean {
  // keyCode 229 是合成中按键的通用标记（部分浏览器 isComposing 不可靠时的兜底）。
  if (!(event.isComposing || event.keyCode === 229)) return false;
  return event.key === 'Enter' || (event.key === 'Process' && event.code === 'Enter');
}

let guardInstalled = false;

/**
 * 安装全局守卫并确保监听只挂一次。返回注销函数。用法（App 根组件内）：
 *
 *   $effect(() => mountImeEnterGuard());
 */
export function mountImeEnterGuard(): () => void {
  if (guardInstalled || typeof window === 'undefined') return () => {};
  guardInstalled = true;
  const onKeydownCapture = (event: KeyboardEvent): void => {
    if (isImeComposingEnter(event)) event.stopPropagation();
  };
  // 捕获阶段：早于一切元素监听器，才能拦得住。
  window.addEventListener('keydown', onKeydownCapture, true);
  return () => window.removeEventListener('keydown', onKeydownCapture, true);
}

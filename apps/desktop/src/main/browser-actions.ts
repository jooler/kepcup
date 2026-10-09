import { createHash } from 'node:crypto';
import {
  AppError,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_VIEWPORT_HEIGHT,
  BROWSER_VIEWPORT_WIDTH,
  compareRefFingerprint,
  type AxtreeNode,
  type BrowserActionOutput,
  type RefFingerprint,
} from '@kepcup/shared';
import { toPageError, withPhase } from './browser-action-phase.js';

/**
 * Electron-free page action flows of the browser host (W1 浏览器动作确定性),
 * unit-tested per CDP call site: every failure leaves tagged `details.phase`
 * — 'pre' before the side-effecting call (click function, Input.insertText,
 * Input.dispatchKeyEvent, mouseWheel, goBack) was sent, 'post' after it
 * (including the settle wait). core maps pre → not_started, post → uncertain.
 * BrowserHost (browser-host.ts) supplies the page operations.
 */
export interface PageOps {
  /** Waits for in-flight navigation (+ settle delay); throws PAGE_CLOSED. */
  settle(timeoutMs?: number): Promise<void>;
  /** DOM agent ready for DOM.resolveNode on the current document. */
  initDom(): Promise<void>;
  /** One CDP command (errors normalized by the host). */
  send(method: string, params: object): Promise<unknown>;
  /** Snapshot-time fingerprint of a ref; throws BROWSER_REF_UNKNOWN. */
  refFingerprint(ref: string): RefFingerprint;
  /** Bumped by every (cross- or same-document) navigation. */
  navigationSeq(): number;
  canGoBack(): boolean;
  goBack(): void;
  delay(ms: number): Promise<void>;
}

/**
 * Typing keys for browser_press, mapped to CDP Input.dispatchKeyEvent fields.
 * `key` is the DOM key value — CDP has no `keyCode` param, and a key event
 * without `key` never runs Chromium's default actions. Enter carries text
 * "\r" (Playwright's shape): the renderer generates the keypress/char from
 * the text, and implicit form submission only runs from that path.
 */
export const KEY_EVENTS: Record<
  string,
  { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};

/** Shared JS: is `this` attached, rendered and enabled (no side effects). */
const ELEMENT_STATE_JS = `
  var connected = this.isConnected === true;
  var visible = false;
  if (connected && this.tagName === 'OPTION') {
    // Options of a closed <select> have no box of their own: not a staleness signal.
    visible = true;
  } else if (connected) {
    if (typeof this.checkVisibility === 'function') {
      visible = this.checkVisibility() === true;
    } else if (typeof this.getBoundingClientRect === 'function') {
      var rect = this.getBoundingClientRect();
      visible = rect.width > 0 && rect.height > 0;
    }
  }
  var disabled =
    this.disabled === true ||
    (typeof this.getAttribute === 'function' && this.getAttribute('aria-disabled') === 'true');
  var password = this.tagName === 'INPUT' && String(this.type).toLowerCase() === 'password';`;

/**
 * Preflight probe (Runtime.callFunctionOn, returnByValue): still attached,
 * rendered, enabled — and whether it is a password field.
 */
export const PREFLIGHT_FUNCTION = `function () {${ELEMENT_STATE_JS}
  return { connected: connected, visible: visible, disabled: disabled, password: password };
}`;

/**
 * The click itself re-checks the element state in the same JS turn (no
 * preflight → click TOCTOU): a refusal comes back as `{ clicked: false }`.
 */
export const CLICK_FUNCTION = `function () {${ELEMENT_STATE_JS}
  if (!connected) return { clicked: false, reason: 'detached' };
  if (!visible) return { clicked: false, reason: 'hidden' };
  if (disabled) return { clicked: false, reason: 'disabled' };
  this.scrollIntoView({ block: 'center' });
  this.click();
  return { clicked: true };
}`;

/** Focus + select, then report whether focus really landed on the target. */
export const FOCUS_FUNCTION = `function () {
  if (this.isConnected !== true) return { focused: false };
  this.focus();
  if (typeof this.select === 'function') this.select();
  var root = typeof this.getRootNode === 'function' ? this.getRootNode() : document;
  var active = root && 'activeElement' in root ? root.activeElement : document.activeElement;
  var focused =
    active === this || (active !== null && typeof this.contains === 'function' && this.contains(active));
  return { focused: focused };
}`;

interface CallResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

const REFUSAL_REASONS: Record<string, string> = {
  detached: '已从页面移除',
  hidden: '当前不可见',
};

function staleError(ref: string, reason: string, password: boolean): AppError {
  return new AppError(
    'BROWSER_REF_STALE',
    `元素 ${ref} ${reason}，页面可能已变化，请重新 browser_snapshot 后再操作`,
    password ? { passwordField: true } : undefined,
  );
}

function disabledError(ref: string, password: boolean): AppError {
  return new AppError(
    'BROWSER_REF_STALE',
    `元素 ${ref} 当前处于禁用状态，无法操作；可先 browser_snapshot 查看页面状态`,
    password ? { passwordField: true } : undefined,
  );
}

/**
 * W1 ref 指纹预检（派发前，不产生副作用）：节点仍在文档里、可见、未禁用，当前
 * role + 可访问名与快照时一致。不符即 BROWSER_REF_STALE（错误 details 带
 * passwordField，失败的密码框输入也能被落盘脱敏）。
 */
export async function preflight(
  ops: PageOps,
  ref: string,
  fingerprint: RefFingerprint,
): Promise<{ objectId: string; password: boolean }> {
  let resolved: { object?: { objectId?: string } };
  try {
    resolved = (await ops.send('DOM.resolveNode', {
      backendNodeId: fingerprint.backendNodeId,
    })) as { object?: { objectId?: string } };
  } catch (error) {
    const pageError = toPageError(error);
    if (pageError.code === 'BROWSER_PAGE_CLOSED') throw pageError;
    throw staleError(ref, '已不在页面上', false);
  }
  const objectId = resolved.object?.objectId;
  if (!objectId) throw staleError(ref, '已不在页面上', false);
  const probe = (await ops.send('Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: PREFLIGHT_FUNCTION,
  })) as CallResult;
  const state = (probe.result?.value ?? {}) as {
    connected?: boolean;
    visible?: boolean;
    disabled?: boolean;
    password?: boolean;
  };
  const password = state.password === true;
  if (state.connected !== true) throw staleError(ref, '已从页面移除', password);
  if (state.visible !== true) throw staleError(ref, '当前不可见', password);
  if (state.disabled === true) throw disabledError(ref, password);
  // Current role + accessible name of exactly this node. A failing AX query
  // or no exact node match is not a staleness signal (best effort).
  try {
    const partial = (await ops.send('Accessibility.getPartialAXTree', {
      backendNodeId: fingerprint.backendNodeId,
      fetchRelatives: false,
    })) as { nodes?: AxtreeNode[] };
    const node = partial.nodes?.find((n) => n.backendDOMNodeId === fingerprint.backendNodeId);
    if (node !== undefined) {
      const rawName = node.name?.value;
      const mismatch = compareRefFingerprint(fingerprint, {
        role: node.ignored === true ? 'ignored' : (node.role?.value ?? ''),
        name: typeof rawName === 'string' ? rawName : '',
      });
      if (mismatch === 'role') throw staleError(ref, '的类型已变化', password);
      if (mismatch === 'name') throw staleError(ref, '的名称已变化', password);
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'BROWSER_REF_STALE') throw error;
    const pageError = toPageError(error);
    if (pageError.code === 'BROWSER_PAGE_CLOSED') throw pageError;
  }
  return { objectId, password };
}

function navigated(ops: PageOps, before: number): boolean {
  return ops.navigationSeq() !== before;
}

export async function clickAction(open: () => PageOps, ref: string): Promise<BrowserActionOutput> {
  let dispatched = false;
  try {
    const ops = open();
    const fingerprint = ops.refFingerprint(ref);
    await ops.settle();
    await ops.initDom();
    const target = await preflight(ops, ref, fingerprint);
    const password = target.password;
    const before = ops.navigationSeq();
    dispatched = true;
    const result = (await ops.send('Runtime.callFunctionOn', {
      objectId: target.objectId,
      returnByValue: true,
      functionDeclaration: CLICK_FUNCTION,
    })) as CallResult;
    if (result.exceptionDetails !== undefined) {
      // Our function threw before click() ran (click() never rethrows page
      // handler errors): nothing was dispatched. The exception text is
      // page-influenced, so it is not echoed.
      dispatched = false;
      throw new AppError('INTERNAL', '点击未执行（元素不支持点击，或页面脚本出错）');
    }
    const value = (result.result?.value ?? {}) as { clicked?: boolean; reason?: string };
    if (value.clicked !== true) {
      dispatched = false;
      if (value.reason === 'disabled') throw disabledError(ref, password);
      throw staleError(ref, REFUSAL_REASONS[value.reason ?? ''] ?? '状态已变化', password);
    }
    // A click may navigate; give the load a bounded window before returning.
    await ops.settle(5_000);
    return { ok: true, outcome: 'completed', navigated: navigated(ops, before) };
  } catch (error) {
    throw withPhase(error, dispatched ? 'post' : 'pre');
  }
}

export async function typeAction(
  open: () => PageOps,
  ref: string,
  text: string,
): Promise<BrowserActionOutput> {
  let dispatched = false;
  let password = false;
  try {
    const ops = open();
    const fingerprint = ops.refFingerprint(ref);
    await ops.settle();
    await ops.initDom();
    const target = await preflight(ops, ref, fingerprint);
    password = target.password;
    const before = ops.navigationSeq();
    const focus = (await ops.send('Runtime.callFunctionOn', {
      objectId: target.objectId,
      returnByValue: true,
      functionDeclaration: FOCUS_FUNCTION,
    })) as CallResult;
    const focused = (focus.result?.value as { focused?: boolean } | undefined)?.focused === true;
    if (focus.exceptionDetails !== undefined || !focused) {
      // insertText goes to whatever has focus — never type (a password) into
      // another field.
      throw new AppError(
        'BROWSER_REF_STALE',
        `元素 ${ref} 无法获得输入焦点，未输入任何内容；请重新 browser_snapshot 确认输入框`,
      );
    }
    if (text.length > 0) {
      dispatched = true;
      await ops.send('Input.insertText', { text });
    }
    await ops.delay(100);
    return {
      ok: true,
      outcome: 'completed',
      navigated: navigated(ops, before),
      ...(password ? { passwordField: true } : {}),
    };
  } catch (error) {
    throw withPhase(error, dispatched ? 'post' : 'pre', password ? { passwordField: true } : {});
  }
}

export async function pressAction(open: () => PageOps, key: string): Promise<BrowserActionOutput> {
  let dispatched = false;
  try {
    const ops = open();
    const keyEvent = KEY_EVENTS[key];
    if (!keyEvent) throw new AppError('INVALID_INPUT', `不支持的按键：${key}`);
    await ops.settle();
    const before = ops.navigationSeq();
    dispatched = true;
    // The exact event shape Playwright presses keys with: text-bearing keys
    // must dispatch as type "keyDown" (rawKeyDown never yields a keypress),
    // and keyUp repeats key/code/virtualKey without the text.
    await ops.send('Input.dispatchKeyEvent', {
      type: keyEvent.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...keyEvent,
    });
    await ops.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyEvent.key,
      code: keyEvent.code,
      windowsVirtualKeyCode: keyEvent.windowsVirtualKeyCode,
    });
    // Enter/Tab commonly navigate or move focus.
    await ops.settle(5_000);
    return { ok: true, outcome: 'completed', navigated: navigated(ops, before) };
  } catch (error) {
    throw withPhase(error, dispatched ? 'post' : 'pre');
  }
}

export async function scrollAction(
  open: () => PageOps,
  direction: 'up' | 'down',
  amount: number,
): Promise<BrowserActionOutput> {
  let dispatched = false;
  try {
    const ops = open();
    await ops.settle();
    const before = ops.navigationSeq();
    dispatched = true;
    await ops.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.floor(BROWSER_VIEWPORT_WIDTH / 2),
      y: Math.floor(BROWSER_VIEWPORT_HEIGHT / 2),
      deltaX: 0,
      deltaY: direction === 'down' ? amount : -amount,
    });
    await ops.delay(150);
    return { ok: true, outcome: 'completed', navigated: navigated(ops, before) };
  } catch (error) {
    throw withPhase(error, dispatched ? 'post' : 'pre');
  }
}

export async function backAction(open: () => PageOps): Promise<BrowserActionOutput> {
  let dispatched = false;
  try {
    const ops = open();
    await ops.settle();
    if (!ops.canGoBack()) {
      throw new AppError('INVALID_INPUT', '没有上一页可以返回');
    }
    const before = ops.navigationSeq();
    dispatched = true;
    ops.goBack();
    await ops.settle(BROWSER_NAVIGATION_TIMEOUT_MS);
    return { ok: true, outcome: 'completed', navigated: navigated(ops, before) };
  } catch (error) {
    throw withPhase(error, dispatched ? 'post' : 'pre');
  }
}

/** AX properties whose change counts as page progress (W1 无进展熔断). */
const STATE_PROPERTIES = new Set(['checked', 'expanded', 'selected', 'pressed']);

/**
 * sha256 over the listed elements' AX value and checked / expanded /
 * selected / pressed state — the state the snapshot text does not show (a
 * quantity stepper only changes a spinbutton value). Only the hash leaves
 * the host, never the values.
 */
export function axStateDigest(
  nodes: readonly AxtreeNode[],
  backendIds: ReadonlySet<number>,
): string {
  const hash = createHash('sha256');
  for (const node of nodes) {
    if (node.backendDOMNodeId === undefined || !backendIds.has(node.backendDOMNodeId)) continue;
    const parts: string[] = [String(node.backendDOMNodeId)];
    const value = node.value?.value;
    if (value !== undefined) parts.push(`v=${JSON.stringify(value)}`);
    for (const property of node.properties ?? []) {
      if (!STATE_PROPERTIES.has(property.name)) continue;
      parts.push(`${property.name}=${JSON.stringify(property.value?.value ?? null)}`);
    }
    hash.update(`${parts.join('|')}\n`);
  }
  return hash.digest('hex');
}

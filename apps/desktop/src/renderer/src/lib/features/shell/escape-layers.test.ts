import { describe, expect, test } from 'vitest';
import {
  blurEditableTarget,
  ESCAPE_PRIORITY,
  EscapeLayerStack,
  isEditableTarget,
  type EscapeEventLike,
} from './escape-layers';

function escapeEvent(patch: Partial<EscapeEventLike> = {}): EscapeEventLike & {
  prevented: boolean;
} {
  const event = {
    key: 'Escape',
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
      event.defaultPrevented = true;
    },
    ...patch,
  };
  return event;
}

describe('EscapeLayerStack', () => {
  test('一次 Esc 只关最顶层：设置页(50)压在 Bot 覆盖层(40)之上时只回调设置页', () => {
    const stack = new EscapeLayerStack();
    const calls: string[] = [];
    stack.register({
      priority: ESCAPE_PRIORITY.overlay,
      onEscape: () => void calls.push('overlay'),
    });
    stack.register({ priority: ESCAPE_PRIORITY.page, onEscape: () => void calls.push('settings') });
    const event = escapeEvent();
    expect(stack.dispatch(event)).toBe(true);
    expect(calls).toEqual(['settings']);
    expect(event.prevented).toBe(true);
  });

  test('与注册顺序无关：先开的设置页、后开的覆盖层，仍是高优先级者先处理', () => {
    const stack = new EscapeLayerStack();
    const calls: string[] = [];
    stack.register({ priority: ESCAPE_PRIORITY.page, onEscape: () => void calls.push('settings') });
    stack.register({
      priority: ESCAPE_PRIORITY.overlay,
      onEscape: () => void calls.push('overlay'),
    });
    stack.dispatch(escapeEvent());
    expect(calls).toEqual(['settings']);
  });

  test('优先级档位：灯箱 > 全屏页 > 弹出层 > Bot 覆盖层 > 内联录音', () => {
    expect(ESCAPE_PRIORITY.lightbox).toBeGreaterThan(ESCAPE_PRIORITY.page);
    expect(ESCAPE_PRIORITY.page).toBeGreaterThan(ESCAPE_PRIORITY.popover);
    expect(ESCAPE_PRIORITY.popover).toBeGreaterThan(ESCAPE_PRIORITY.overlay);
    expect(ESCAPE_PRIORITY.overlay).toBeGreaterThan(ESCAPE_PRIORITY.inline);
  });

  test('灯箱开在设置页 / Bot 覆盖层之上时，一次 Esc 只关灯箱，不连带关下层', () => {
    const stack = new EscapeLayerStack();
    const calls: string[] = [];
    stack.register({ priority: ESCAPE_PRIORITY.overlay, onEscape: () => void calls.push('overlay') });
    stack.register({ priority: ESCAPE_PRIORITY.page, onEscape: () => void calls.push('settings') });
    const offLightbox = stack.register({
      priority: ESCAPE_PRIORITY.lightbox,
      onEscape: () => void calls.push('lightbox'),
    });
    const first = escapeEvent();
    expect(stack.dispatch(first)).toBe(true);
    expect(first.prevented).toBe(true);
    expect(calls).toEqual(['lightbox']);
    offLightbox();
    stack.dispatch(escapeEvent());
    expect(calls).toEqual(['lightbox', 'settings']);
  });

  test('录音中（inline）有覆盖层 / 全屏页时 Esc 先关那一层，录音不被连带取消；层关后 Esc 才取消录音', () => {
    const stack = new EscapeLayerStack();
    const calls: string[] = [];
    stack.register({ priority: ESCAPE_PRIORITY.inline, onEscape: () => void calls.push('recording') });
    const offPage = stack.register({
      priority: ESCAPE_PRIORITY.page,
      onEscape: () => void calls.push('settings'),
    });
    stack.dispatch(escapeEvent());
    expect(calls).toEqual(['settings']);
    offPage();
    stack.dispatch(escapeEvent());
    expect(calls).toEqual(['settings', 'recording']);
  });

  test('同级后注册者在上', () => {
    const stack = new EscapeLayerStack();
    const calls: string[] = [];
    stack.register({ priority: 50, onEscape: () => void calls.push('first') });
    stack.register({ priority: 50, onEscape: () => void calls.push('second') });
    stack.dispatch(escapeEvent());
    expect(calls).toEqual(['second']);
  });

  test('层关闭（注销）后下一层接手；注销幂等', () => {
    const stack = new EscapeLayerStack();
    const calls: string[] = [];
    stack.register({ priority: 40, onEscape: () => void calls.push('overlay') });
    const off = stack.register({ priority: 50, onEscape: () => void calls.push('settings') });
    stack.dispatch(escapeEvent());
    off();
    off();
    stack.dispatch(escapeEvent());
    expect(calls).toEqual(['settings', 'overlay']);
    expect(stack.size).toBe(1);
  });

  test('已被内部控件 / bits-ui 弹层 preventDefault 的 Esc 不再处理（行内编辑、Select、Popover）', () => {
    const stack = new EscapeLayerStack();
    let called = 0;
    stack.register({ priority: 40, onEscape: () => void (called += 1) });
    expect(stack.dispatch(escapeEvent({ defaultPrevented: true }))).toBe(false);
    expect(called).toBe(0);
  });

  test('非 Esc、输入法合成、长按重复一律忽略', () => {
    const stack = new EscapeLayerStack();
    let called = 0;
    stack.register({ priority: 40, onEscape: () => void (called += 1) });
    expect(stack.dispatch(escapeEvent({ key: 'Enter' }))).toBe(false);
    expect(stack.dispatch(escapeEvent({ isComposing: true }))).toBe(false);
    expect(stack.dispatch(escapeEvent({ repeat: true }))).toBe(false);
    expect(called).toBe(0);
  });

  test('层返回 false = 不是我的，交给下一层；不 preventDefault', () => {
    const stack = new EscapeLayerStack();
    const calls: string[] = [];
    stack.register({ priority: 40, onEscape: () => void calls.push('overlay') });
    stack.register({
      priority: 50,
      onEscape: () => {
        calls.push('page');
        return false;
      },
    });
    const event = escapeEvent();
    expect(stack.dispatch(event)).toBe(true);
    expect(calls).toEqual(['page', 'overlay']);
    expect(event.prevented).toBe(true);

    const lone = new EscapeLayerStack();
    lone.register({ priority: 50, onEscape: () => false });
    const untouched = escapeEvent();
    expect(lone.dispatch(untouched)).toBe(false);
    expect(untouched.prevented).toBe(false);
  });

  test('没有任何层时不消费', () => {
    expect(new EscapeLayerStack().dispatch(escapeEvent())).toBe(false);
  });
});

describe('isEditableTarget / blurEditableTarget', () => {
  const field = (tagName: string, extra: Record<string, unknown> = {}) => {
    const el = { tagName, isContentEditable: false, blurred: false, ...extra } as {
      tagName: string;
      isContentEditable: boolean;
      blurred: boolean;
      blur: () => void;
    };
    el.blur = () => {
      el.blurred = true;
    };
    return el;
  };

  test('input / textarea / select / contenteditable 为可输入控件，其余不是', () => {
    expect(isEditableTarget(field('INPUT') as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(field('TEXTAREA') as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(field('SELECT') as unknown as EventTarget)).toBe(true);
    expect(
      isEditableTarget(field('DIV', { isContentEditable: true }) as unknown as EventTarget),
    ).toBe(true);
    expect(isEditableTarget(field('BUTTON') as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  test('Esc 落在输入控件里：先失焦并消费；否则不消费', () => {
    const input = field('INPUT');
    expect(blurEditableTarget({ target: input as unknown as EventTarget })).toBe(true);
    expect(input.blurred).toBe(true);
    const button = field('BUTTON');
    expect(blurEditableTarget({ target: button as unknown as EventTarget })).toBe(false);
    expect(button.blurred).toBe(false);
  });
});

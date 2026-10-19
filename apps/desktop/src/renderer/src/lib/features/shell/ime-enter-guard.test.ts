import { describe, expect, test } from 'vitest';
import { isImeComposingEnter } from './ime-enter-guard';

function keyEvent(patch: { key: string; code?: string; isComposing: boolean; keyCode: number }) {
  return patch;
}

describe('isImeComposingEnter', () => {
  test('合成中的 Enter（macOS Chromium：key=Enter + keyCode 229）是选词确认', () => {
    expect(
      isImeComposingEnter(keyEvent({ key: 'Enter', isComposing: true, keyCode: 229 })),
    ).toBe(true);
  });

  test('合成中的 Enter（Windows Chromium：key=Process + code=Enter）也是', () => {
    expect(
      isImeComposingEnter(
        keyEvent({ key: 'Process', code: 'Enter', isComposing: true, keyCode: 229 }),
      ),
    ).toBe(true);
  });

  test('合成结束后的 Enter（isComposing=false + keyCode 13）是业务确认，不拦', () => {
    expect(
      isImeComposingEnter(keyEvent({ key: 'Enter', isComposing: false, keyCode: 13 })),
    ).toBe(false);
  });

  test('合成中的非 Enter 键（候选翻页方向键等）不拦，留给组件自身语义', () => {
    expect(
      isImeComposingEnter(keyEvent({ key: 'ArrowDown', isComposing: true, keyCode: 229 })),
    ).toBe(false);
    expect(
      isImeComposingEnter(keyEvent({ key: 'Process', code: 'ArrowDown', isComposing: true, keyCode: 229 })),
    ).toBe(false);
  });

  test('keyCode 229 兜底：isComposing 不可靠时的合成 Enter 仍拦', () => {
    expect(
      isImeComposingEnter(keyEvent({ key: 'Enter', isComposing: false, keyCode: 229 })),
    ).toBe(true);
  });
});

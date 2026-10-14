import { describe, expect, it } from 'vitest';
import { nextMultilineLayoutState } from './composer-multiline';

describe('nextMultilineLayoutState', () => {
  it('enters multiline and latches length when content wraps', () => {
    expect(
      nextMultilineLayoutState({
        contentLength: 80,
        wraps: true,
        latchLength: null,
        widthChanged: false,
      }),
    ).toEqual({ multiline: true, latchLength: 80 });
  });

  it('stays multiline while length is at or above latch even if wraps is false', () => {
    expect(
      nextMultilineLayoutState({
        contentLength: 80,
        wraps: false,
        latchLength: 80,
        widthChanged: false,
      }),
    ).toEqual({ multiline: true, latchLength: 80 });
    expect(
      nextMultilineLayoutState({
        contentLength: 100,
        wraps: false,
        latchLength: 80,
        widthChanged: false,
      }),
    ).toEqual({ multiline: true, latchLength: 80 });
  });

  it('exits multiline when content shrinks below latch and no longer wraps', () => {
    expect(
      nextMultilineLayoutState({
        contentLength: 79,
        wraps: false,
        latchLength: 80,
        widthChanged: false,
      }),
    ).toEqual({ multiline: false, latchLength: null });
  });

  it('re-latches at the shorter length when still wrapping after shrink', () => {
    expect(
      nextMultilineLayoutState({
        contentLength: 40,
        wraps: true,
        latchLength: 80,
        widthChanged: false,
      }),
    ).toEqual({ multiline: true, latchLength: 40 });
  });

  it('clears latch on empty content', () => {
    expect(
      nextMultilineLayoutState({
        contentLength: 0,
        wraps: true,
        latchLength: 50,
        widthChanged: false,
      }),
    ).toEqual({ multiline: false, latchLength: null });
  });

  it('drops latch on width change and remeasures from wraps', () => {
    expect(
      nextMultilineLayoutState({
        contentLength: 80,
        wraps: false,
        latchLength: 80,
        widthChanged: true,
      }),
    ).toEqual({ multiline: false, latchLength: null });
    expect(
      nextMultilineLayoutState({
        contentLength: 80,
        wraps: true,
        latchLength: 80,
        widthChanged: true,
      }),
    ).toEqual({ multiline: true, latchLength: 80 });
  });

  it('stays single-line when content does not wrap', () => {
    expect(
      nextMultilineLayoutState({
        contentLength: 10,
        wraps: false,
        latchLength: null,
        widthChanged: false,
      }),
    ).toEqual({ multiline: false, latchLength: null });
  });
});

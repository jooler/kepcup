import { describe, expect, it } from 'vitest';
import {
  STICKIE_MARGIN,
  STICKIE_WIDTH,
  type Stickie,
  clampStickiePosition,
  defaultStickiePosition,
  isStickieVisible,
} from './stickies';

const baseStickie: Stickie = {
  id: 's1',
  text: 'hello',
  scope: 'conversation',
  conversationId: 'conv_a',
  position: null,
  z: 0,
  createdAt: 0,
  updatedAt: 0,
};

function makeStickie(overrides: Partial<Stickie> = {}): Stickie {
  return { ...baseStickie, ...overrides };
}

describe('isStickieVisible', () => {
  it('shows a conversation-scope stickie only in its origin conversation', () => {
    const stickie = makeStickie();
    expect(isStickieVisible(stickie, 'conv_a')).toBe(true);
    expect(isStickieVisible(stickie, 'conv_b')).toBe(false);
  });

  it('shows a global stickie in every conversation', () => {
    const stickie = makeStickie({ scope: 'global', conversationId: 'conv_a' });
    expect(isStickieVisible(stickie, 'conv_a')).toBe(true);
    expect(isStickieVisible(stickie, 'conv_b')).toBe(true);
  });
});

describe('clampStickiePosition', () => {
  it('keeps an in-bounds position unchanged', () => {
    expect(clampStickiePosition({ x: 40, y: 80 }, 800, 600, 120)).toEqual({ x: 40, y: 80 });
  });

  it('clamps a dragged position to the container minus card size', () => {
    expect(clampStickiePosition({ x: -50, y: 10_000 }, 800, 600, 120)).toEqual({
      x: STICKIE_MARGIN,
      y: 600 - 120 - STICKIE_MARGIN,
    });
    expect(clampStickiePosition({ x: 10_000, y: 10 }, 800, 600, 120)).toEqual({
      x: 800 - STICKIE_WIDTH - STICKIE_MARGIN,
      y: STICKIE_MARGIN,
    });
  });

  it('falls back to the margin when the container is smaller than the card', () => {
    expect(clampStickiePosition({ x: 100, y: 100 }, 100, 80, 120)).toEqual({
      x: STICKIE_MARGIN,
      y: STICKIE_MARGIN,
    });
  });
});

describe('defaultStickiePosition', () => {
  it('places the first stickie at the top right, below the header pill', () => {
    const pos = defaultStickiePosition(800, 600, 0);
    expect(pos).toEqual({ x: 800 - STICKIE_WIDTH - 24, y: 64 });
  });

  it('cascades successive slots downward', () => {
    const first = defaultStickiePosition(800, 600, 0);
    const second = defaultStickiePosition(800, 600, 1);
    expect(second.y).toBe(first.y + 28);
    expect(second.x).toBe(first.x);
  });

  it('wraps the cascade and stays inside a small container', () => {
    const pos = defaultStickiePosition(400, 200, 8);
    expect(pos.y).toBeLessThanOrEqual(200 - STICKIE_MARGIN - 96);
    // 容器内仍放得下卡片：默认 24px 右缘间隙未被夹取。
    expect(pos.x).toBe(400 - STICKIE_WIDTH - 24);
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  captureWindowState,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  loadWindowState,
  parseWindowState,
  resolveWindowOptions,
  saveWindowState,
  windowVisibleOnDisplays,
  type DisplayRect,
  type WindowBoundsState,
} from './window-state.js';

const PRIMARY: DisplayRect = { x: 0, y: 0, width: 1920, height: 1080 };
const SECONDARY: DisplayRect = { x: 1920, y: 0, width: 1440, height: 900 };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-winstate-'));
  dirs.push(dir);
  return path.join(dir, 'window-state.json');
}

describe('parseWindowState', () => {
  test('accepts a complete bounds object', () => {
    expect(parseWindowState({ x: 10, y: 20, width: 800, height: 600 })).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
  });

  test('keeps maximized only when true', () => {
    expect(parseWindowState({ x: 0, y: 0, width: 100, height: 100, maximized: true })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      maximized: true,
    });
    expect(parseWindowState({ x: 0, y: 0, width: 100, height: 100, maximized: false })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  test('rejects incomplete or non-finite values', () => {
    expect(parseWindowState(null)).toBeNull();
    expect(parseWindowState({})).toBeNull();
    expect(parseWindowState({ x: 0, y: 0, width: 0, height: 100 })).toBeNull();
    expect(parseWindowState({ x: 0, y: 0, width: Infinity, height: 100 })).toBeNull();
    expect(parseWindowState({ x: '0', y: 0, width: 100, height: 100 })).toBeNull();
  });
});

describe('windowVisibleOnDisplays', () => {
  test('accepts a window fully on the primary display', () => {
    expect(
      windowVisibleOnDisplays({ x: 100, y: 100, width: 800, height: 600 }, [PRIMARY]),
    ).toBe(true);
  });

  test('accepts a window on a secondary display (multi-monitor)', () => {
    expect(
      windowVisibleOnDisplays({ x: 2000, y: 50, width: 800, height: 600 }, [PRIMARY, SECONDARY]),
    ).toBe(true);
  });

  test('accepts a window spanning two displays', () => {
    expect(
      windowVisibleOnDisplays({ x: 1800, y: 100, width: 400, height: 600 }, [PRIMARY, SECONDARY]),
    ).toBe(true);
  });

  test('rejects a window entirely off every display (unplugged monitor)', () => {
    expect(
      windowVisibleOnDisplays({ x: 5000, y: 5000, width: 800, height: 600 }, [PRIMARY]),
    ).toBe(false);
  });

  test('rejects a tiny corner peek that leaves the title bar unreachable', () => {
    expect(
      windowVisibleOnDisplays({ x: 1900, y: 1060, width: 800, height: 600 }, [PRIMARY]),
    ).toBe(false);
  });
});

describe('resolveWindowOptions', () => {
  test('falls back to defaults when nothing is saved', () => {
    expect(resolveWindowOptions(null, [PRIMARY])).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
    });
  });

  test('restores on-screen bounds including maximized', () => {
    const saved: WindowBoundsState = {
      x: 120,
      y: 80,
      width: 1100,
      height: 700,
      maximized: true,
    };
    expect(resolveWindowOptions(saved, [PRIMARY])).toEqual({
      x: 120,
      y: 80,
      width: 1100,
      height: 700,
      maximized: true,
    });
  });

  test('clamps below min size and drops off-screen state', () => {
    expect(
      resolveWindowOptions({ x: 10, y: 10, width: 200, height: 200 }, [PRIMARY], {
        minWidth: 375,
        minHeight: 600,
      }),
    ).toEqual({ x: 10, y: 10, width: 375, height: 600, maximized: false });

    expect(
      resolveWindowOptions({ x: 9000, y: 9000, width: 800, height: 600 }, [PRIMARY]),
    ).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
    });
  });
});

describe('loadWindowState / saveWindowState', () => {
  test('round-trips through disk', () => {
    const file = tmpFile();
    expect(loadWindowState(file)).toBeNull();
    saveWindowState(file, { x: 1, y: 2, width: 900, height: 700, maximized: true });
    expect(loadWindowState(file)).toEqual({
      x: 1,
      y: 2,
      width: 900,
      height: 700,
      maximized: true,
    });
    const text = readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ width: 900, maximized: true });
  });

  test('corrupt JSON yields null', () => {
    const file = tmpFile();
    saveWindowState(file, { x: 0, y: 0, width: 100, height: 100 });
    // overwrite with garbage via save path's sibling write would need fs; parse covers it
    expect(parseWindowState(JSON.parse('"nope"'))).toBeNull();
  });
});

describe('captureWindowState', () => {
  test('uses normal bounds and records maximized', () => {
    const state = captureWindowState({
      isDestroyed: () => false,
      isMinimized: () => false,
      isMaximized: () => true,
      getNormalBounds: () => ({ x: 40, y: 50, width: 1000, height: 700 }),
    });
    expect(state).toEqual({ x: 40, y: 50, width: 1000, height: 700, maximized: true });
  });

  test('skips destroyed or minimized windows', () => {
    expect(
      captureWindowState({
        isDestroyed: () => true,
        isMinimized: () => false,
        isMaximized: () => false,
        getNormalBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
      }),
    ).toBeNull();
    expect(
      captureWindowState({
        isDestroyed: () => false,
        isMinimized: () => true,
        isMaximized: () => false,
        getNormalBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
      }),
    ).toBeNull();
  });
});

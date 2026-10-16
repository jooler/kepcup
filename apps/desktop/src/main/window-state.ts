import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Main-window bounds persistence: remember position/size across launches so
 * the tray-resident window reopens where the user left it (multi-display safe).
 *
 * Stored as a small JSON file under Electron `userData` (no electron-store).
 * Validation rejects bounds that no longer intersect any connected display
 * (e.g. a monitor was unplugged) and falls back to the default centered size.
 */

export interface WindowBoundsState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/** Display rectangle in screen coordinates (Electron `Display.bounds`). */
export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 840;
export const MIN_WINDOW_WIDTH = 375;
export const MIN_WINDOW_HEIGHT = 600;

/** Filename under `app.getPath('userData')`. */
export const WINDOW_STATE_FILE = 'window-state.json';

/** Minimum overlap (px) required with some display so the title bar stays reachable. */
const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 40;

export function parseWindowState(raw: unknown): WindowBoundsState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const x = asFiniteNumber(obj.x);
  const y = asFiniteNumber(obj.y);
  const width = asFiniteNumber(obj.width);
  const height = asFiniteNumber(obj.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 1 || height < 1) return null;
  const maximized = obj.maximized === true;
  return { x, y, width, height, ...(maximized ? { maximized: true } : {}) };
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * True when the window rectangle overlaps at least one display enough that a
 * title-bar strip remains clickable (multi-monitor: spanning two displays is OK).
 */
export function windowVisibleOnDisplays(
  bounds: Pick<WindowBoundsState, 'x' | 'y' | 'width' | 'height'>,
  displays: readonly DisplayRect[],
): boolean {
  if (displays.length === 0) return false;
  for (const display of displays) {
    const overlapW =
      Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
    const overlapH =
      Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
    if (overlapW >= MIN_VISIBLE_WIDTH && overlapH >= MIN_VISIBLE_HEIGHT) return true;
  }
  return false;
}

export interface ResolvedWindowOptions {
  width: number;
  height: number;
  /** Omitted when Electron should center the window (first launch / invalid). */
  x?: number;
  y?: number;
  maximized: boolean;
}

/**
 * Turns a saved state + current displays into BrowserWindow constructor options.
 * Invalid / off-screen state falls back to the default size with no x/y.
 */
export function resolveWindowOptions(
  saved: WindowBoundsState | null,
  displays: readonly DisplayRect[],
  limits: { minWidth?: number; minHeight?: number } = {},
): ResolvedWindowOptions {
  const minWidth = limits.minWidth ?? MIN_WINDOW_WIDTH;
  const minHeight = limits.minHeight ?? MIN_WINDOW_HEIGHT;

  if (!saved || !windowVisibleOnDisplays(saved, displays)) {
    return {
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      maximized: false,
    };
  }

  return {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(minWidth, Math.round(saved.width)),
    height: Math.max(minHeight, Math.round(saved.height)),
    maximized: saved.maximized === true,
  };
}

export function loadWindowState(filePath: string): WindowBoundsState | null {
  try {
    if (!existsSync(filePath)) return null;
    const text = readFileSync(filePath, 'utf8');
    return parseWindowState(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function saveWindowState(filePath: string, state: WindowBoundsState): void {
  const payload: WindowBoundsState = {
    x: Math.round(state.x),
    y: Math.round(state.y),
    width: Math.round(state.width),
    height: Math.round(state.height),
    ...(state.maximized ? { maximized: true } : {}),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** Capture restore-size bounds even while maximized; skip minimized windows. */
export function captureWindowState(win: {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  isMaximized: () => boolean;
  getNormalBounds: () => { x: number; y: number; width: number; height: number };
}): WindowBoundsState | null {
  if (win.isDestroyed() || win.isMinimized()) return null;
  const bounds = win.getNormalBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    ...(win.isMaximized() ? { maximized: true } : {}),
  };
}

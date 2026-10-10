import { describe, expect, test } from 'vitest';
import {
  APP_BRIDGE_MESSAGE_MAX_CHARS,
  clampAppHeight,
  createThrottle,
  describeAppLink,
  guardIncomingMessage,
  isFromFrame,
  normalizeAppLink,
} from './bridge-guard';

describe('guardIncomingMessage', () => {
  test('lets the supported methods through', () => {
    for (const method of [
      'ui/initialize',
      'ui/notifications/initialized',
      'ui/notifications/size-changed',
      'tools/call',
      'ui/open-link',
      'ui/message',
      'ui/update-model-context',
      'ping',
    ]) {
      expect(guardIncomingMessage({ jsonrpc: '2.0', id: 1, method, params: {} }), method).toEqual({
        ok: true,
      });
    }
  });

  test('responses to host requests pass; malformed shapes do not', () => {
    expect(guardIncomingMessage({ jsonrpc: '2.0', id: 3, result: {} })).toEqual({ ok: true });
    expect(
      guardIncomingMessage({ jsonrpc: '2.0', id: 3, error: { code: 1, message: 'x' } }),
    ).toEqual({
      ok: true,
    });
    expect(guardIncomingMessage({ jsonrpc: '2.0', id: 3 })).toMatchObject({ ok: false });
    expect(guardIncomingMessage('tools/call')).toMatchObject({ ok: false, reason: 'not-object' });
    expect(guardIncomingMessage(null)).toMatchObject({ ok: false });
    expect(guardIncomingMessage([{ jsonrpc: '2.0' }])).toMatchObject({ ok: false });
    expect(guardIncomingMessage({ id: 1, method: 'tools/call' })).toMatchObject({
      ok: false,
      reason: 'not-jsonrpc',
    });
  });

  test('methods the host does not implement are refused with the request id preserved', () => {
    for (const method of [
      'resources/read',
      'resources/list',
      'prompts/list',
      'sampling/createMessage',
      'ui/download-file',
      'ui/request-display-mode',
      'tools/list',
      'initialize',
      '__proto__',
    ]) {
      expect(guardIncomingMessage({ jsonrpc: '2.0', id: 7, method }), method).toEqual({
        ok: false,
        reason: 'method-not-allowed',
        id: 7,
      });
    }
    expect(guardIncomingMessage({ jsonrpc: '2.0', method: 42 })).toMatchObject({
      ok: false,
      reason: 'method-not-allowed',
    });
  });

  test('oversized messages are refused', () => {
    const big = 'x'.repeat(APP_BRIDGE_MESSAGE_MAX_CHARS + 1);
    expect(
      guardIncomingMessage({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { big } }),
    ).toEqual({ ok: false, reason: 'too-large', id: 'a' });
  });
});

describe('isFromFrame', () => {
  test('only the identical window object counts', () => {
    const frame = {};
    expect(isFromFrame(frame, frame)).toBe(true);
    expect(isFromFrame({}, frame)).toBe(false);
    expect(isFromFrame(null, frame)).toBe(false);
    expect(isFromFrame(undefined, undefined)).toBe(false);
    expect(isFromFrame(null, null)).toBe(false);
  });
});

describe('clampAppHeight', () => {
  test('clamps into [100, 800] and ignores non-numbers', () => {
    expect(clampAppHeight(0)).toBe(100);
    expect(clampAppHeight(-5)).toBe(100);
    expect(clampAppHeight(99.2)).toBe(100);
    expect(clampAppHeight(250.2)).toBe(251);
    expect(clampAppHeight(800)).toBe(800);
    expect(clampAppHeight(10_000_000)).toBe(800);
    expect(clampAppHeight(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampAppHeight(Number.NaN)).toBeNull();
    expect(clampAppHeight('300')).toBeNull();
    expect(clampAppHeight(undefined)).toBeNull();
  });
});

describe('normalizeAppLink', () => {
  test('https only, no credentials', () => {
    expect(normalizeAppLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeAppLink('HTTPS://Example.com')).toBe('https://example.com/');
    for (const bad of [
      'http://example.com/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'kepcup-app://app-x/abc',
      'https://user:pw@example.com/',
      '',
      'x'.repeat(3000),
    ]) {
      expect(normalizeAppLink(bad), bad.slice(0, 40)).toBeNull();
    }
    expect(normalizeAppLink(42)).toBeNull();
    expect(normalizeAppLink(undefined)).toBeNull();
  });

  test('describeAppLink shortens long links and exposes the host', () => {
    const long = `https://example.com/${'a'.repeat(300)}`;
    const info = describeAppLink(long);
    expect(info.host).toBe('example.com');
    expect(info.display.length).toBeLessThanOrEqual(120);
    expect(describeAppLink('https://example.com/x').display).toBe('https://example.com/x');
  });
});

describe('createThrottle', () => {
  test('emits the first value at once, then at most one trailing value per interval', () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const emitted: number[] = [];
    const throttled = createThrottle<number>(100, (value) => emitted.push(value), {
      now: () => now,
      setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
    });
    throttled(1);
    expect(emitted).toEqual([1]);
    now = 10;
    throttled(2);
    throttled(3);
    throttled(4);
    expect(emitted).toEqual([1]);
    expect(timers).toHaveLength(1);
    now = 100;
    timers[0]!.fn();
    expect(emitted).toEqual([1, 4]);
    now = 400;
    throttled(5);
    expect(emitted).toEqual([1, 4, 5]);
  });
});

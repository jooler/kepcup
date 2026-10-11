import { describe, expect, test } from 'vitest';
import {
  WIDGET_BRIDGE_MESSAGE_MAX_CHARS,
  clampWidgetHeight,
  parseWidgetBridgeMessage,
  widgetBridgeReply,
} from './widget-bridge-guard';

describe('parseWidgetBridgeMessage', () => {
  test('lets the supported widget methods through with id and payload', () => {
    for (const method of [
      'storage.get',
      'storage.set',
      'storage.delete',
      'storage.list',
      'openLink',
      'theme.get',
      'setHeight',
    ]) {
      expect(
        parseWidgetBridgeMessage({ source: 'kepcup-widget', id: 1, type: method, payload: {} }),
        method,
      ).toEqual({ ok: true, request: { id: 1, method, payload: {} } });
    }
    // setHeight 的通知形式（id 固定 0、带 height）。
    expect(
      parseWidgetBridgeMessage({
        source: 'kepcup-widget',
        id: 0,
        type: 'setHeight',
        payload: { height: 420 },
      }),
    ).toEqual({
      ok: true,
      request: { id: 0, method: 'setHeight', payload: { height: 420 } },
    });
  });

  test('malformed shapes are refused', () => {
    expect(parseWidgetBridgeMessage(null)).toMatchObject({ ok: false });
    expect(parseWidgetBridgeMessage('storage.get')).toMatchObject({ ok: false });
    expect(parseWidgetBridgeMessage([{ source: 'kepcup-widget' }])).toMatchObject({ ok: false });
    // 来源标记不对（宿主自己的消息、其他框架的消息等）。
    expect(parseWidgetBridgeMessage({ id: 1, type: 'storage.get', payload: {} })).toMatchObject({
      ok: false,
    });
    expect(
      parseWidgetBridgeMessage({ source: 'kepcup-host', id: 1, type: 'storage.get', payload: {} }),
    ).toMatchObject({ ok: false });
    // id 必须是非负整数。
    for (const id of ['1', -1, 1.5, null, undefined]) {
      expect(
        parseWidgetBridgeMessage({ source: 'kepcup-widget', id, type: 'storage.get', payload: {} }),
        String(id),
      ).toMatchObject({ ok: false });
    }
    // 方法必须在白名单里。
    for (const type of ['storage.clear', 'fs.read', 'tools/call', '__proto__', 42]) {
      expect(
        parseWidgetBridgeMessage({ source: 'kepcup-widget', id: 1, type, payload: {} }),
        String(type),
      ).toMatchObject({ ok: false });
    }
    // payload 必须是对象。
    expect(
      parseWidgetBridgeMessage({ source: 'kepcup-widget', id: 1, type: 'openLink', payload: 'x' }),
    ).toMatchObject({ ok: false });
    expect(
      parseWidgetBridgeMessage({ source: 'kepcup-widget', id: 1, type: 'openLink' }),
    ).toMatchObject({ ok: false });
  });

  test('oversized messages are refused', () => {
    const big = 'x'.repeat(WIDGET_BRIDGE_MESSAGE_MAX_CHARS);
    expect(
      parseWidgetBridgeMessage({
        source: 'kepcup-widget',
        id: 1,
        type: 'storage.set',
        payload: { key: 'k', value: big },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('widgetBridgeReply', () => {
  test('success carries the value; failures carry the error text', () => {
    expect(widgetBridgeReply(3, {})).toEqual({ source: 'kepcup-host', id: 3, ok: true });
    expect(widgetBridgeReply(3, { value: { a: 1 } })).toEqual({
      source: 'kepcup-host',
      id: 3,
      ok: true,
      value: { a: 1 },
    });
    expect(widgetBridgeReply(4, { error: '组件界面已过期' })).toEqual({
      source: 'kepcup-host',
      id: 4,
      ok: false,
      error: '组件界面已过期',
    });
  });
});

describe('clampWidgetHeight', () => {
  test('clamps to [100, 800]; non-finite is ignored', () => {
    expect(clampWidgetHeight(380)).toBe(380);
    expect(clampWidgetHeight(42.4)).toBe(100);
    expect(clampWidgetHeight(99)).toBe(100);
    expect(clampWidgetHeight(100_000)).toBe(800);
    expect(clampWidgetHeight('500')).toBeNull();
    expect(clampWidgetHeight(Number.NaN)).toBeNull();
    expect(clampWidgetHeight(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampWidgetHeight(null)).toBeNull();
  });
});

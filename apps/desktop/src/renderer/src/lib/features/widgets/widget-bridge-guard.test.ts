import { describe, expect, test } from 'vitest';
import {
  WIDGET_BRIDGE_MESSAGE_MAX_CHARS,
  WIDGET_BRIDGE_METHODS,
  clampWidgetHeight,
  parseWidgetBridgeMessage,
  widgetBridgeMessageId,
  widgetBridgeReply,
} from './widget-bridge-guard';

describe('parseWidgetBridgeMessage', () => {
  test('lets every whitelisted widget method through with id and payload', () => {
    // 遍历导出的白名单本体：垫片 / dispatch / schema 增删方法时这里自动跟随。
    for (const method of WIDGET_BRIDGE_METHODS) {
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

  test('oversized and unserializable messages are refused', () => {
    const big = 'x'.repeat(WIDGET_BRIDGE_MESSAGE_MAX_CHARS);
    expect(
      parseWidgetBridgeMessage({
        source: 'kepcup-widget',
        id: 1,
        type: 'storage.set',
        payload: { key: 'k', value: big },
      }),
    ).toMatchObject({ ok: false });
    // BigInt 值能过 structured clone 但 JSON.stringify 抛错：拒收（宿主按 id 回错误回执）。
    expect(
      parseWidgetBridgeMessage({
        source: 'kepcup-widget',
        id: 1,
        type: 'storage.set',
        payload: { key: 'k', value: 10n },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('widgetBridgeMessageId', () => {
  test('extracts a correlatable id from otherwise-rejected messages, or null', () => {
    expect(widgetBridgeMessageId({ source: 'wrong', id: 3, type: 'nope' })).toBe(3);
    expect(widgetBridgeMessageId({ id: 0 })).toBe(0);
    expect(widgetBridgeMessageId({ id: -1 })).toBeNull();
    expect(widgetBridgeMessageId({ id: 1.5 })).toBeNull();
    expect(widgetBridgeMessageId({ id: '1' })).toBeNull();
    expect(widgetBridgeMessageId('x')).toBeNull();
    expect(widgetBridgeMessageId(null)).toBeNull();
  });
});

describe('widgetBridgeReply', () => {
  test('success carries the value; failures carry the error text and machine-readable code', () => {
    expect(widgetBridgeReply(3, {})).toEqual({ source: 'kepcup-host', id: 3, ok: true });
    expect(widgetBridgeReply(3, { value: { a: 1 } })).toEqual({
      source: 'kepcup-host',
      id: 3,
      ok: true,
      value: { a: 1 },
    });
    expect(widgetBridgeReply(4, { error: '组件界面已过期', code: 'WIDGET_RESOURCE_EXPIRED' })).toEqual({
      source: 'kepcup-host',
      id: 4,
      ok: false,
      error: '组件界面已过期',
      code: 'WIDGET_RESOURCE_EXPIRED',
    });
    expect(widgetBridgeReply(5, { error: 'x' })).toEqual({
      source: 'kepcup-host',
      id: 5,
      ok: false,
      error: 'x',
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

import { describe, expect, it } from 'vitest';

import {
  htmlDefinesScrollbarStyle,
  injectIframeScrollbarStyle,
} from '../../src/domain/iframe-defaults.js';

/**
 * iframe 默认滚动条样式（kepcup-file 协议层与组件 SDK 垫片共用，docs/design/47）：
 * 注入位置（head → doctype → 前置）、页面自定义样式时不注入、纯 ASCII（协议层按
 * latin1 字节往返，任何 ASCII 兼容编码不变形）。
 */

describe('htmlDefinesScrollbarStyle', () => {
  it('detects webkit pseudo-elements and standard properties, case-insensitive', () => {
    expect(htmlDefinesScrollbarStyle('a<style>::-Webkit-Scrollbar{width:4px}</style>')).toBe(true);
    expect(htmlDefinesScrollbarStyle('*{scrollbar-width:thin}')).toBe(true);
    expect(htmlDefinesScrollbarStyle('X{SCROLLBAR-COLOR: red blue}')).toBe(true);
    expect(htmlDefinesScrollbarStyle('<p>no scrollbar styling here</p>')).toBe(false);
    // 注释里提到也算（静态判定，宁可不注入——页面作者显式写过这个词）。
    expect(htmlDefinesScrollbarStyle('/* ::-webkit-scrollbar later */')).toBe(true);
  });
});

describe('injectIframeScrollbarStyle', () => {
  it('inserts right after <head>, before the page’s own styles (cascade: page wins)', () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>p{}</style></head></html>';
    const out = injectIframeScrollbarStyle(html);
    expect(out.startsWith('<!DOCTYPE html><html><head><style data-kepcup-scrollbar>::-webkit-scrollbar')).toBe(true);
    expect(out.indexOf('::-webkit-scrollbar')).toBeLessThan(out.indexOf('<style>p{}</style>'));
    expect(out.endsWith(html.slice(html.indexOf('<meta')))).toBe(true);
  });

  it('falls back to after the doctype, then prepending', () => {
    const afterDoctype = injectIframeScrollbarStyle('<!doctype html><html><body></body></html>');
    expect(afterDoctype.startsWith('<!doctype html><style data-kepcup-scrollbar>::-webkit-scrollbar')).toBe(true);
    const prepended = injectIframeScrollbarStyle('<html><body></body></html>');
    expect(prepended.startsWith('<style data-kepcup-scrollbar>::-webkit-scrollbar')).toBe(true);
  });

  it('returns the input unchanged when the page defines its own scrollbar style', () => {
    const html = '<!DOCTYPE html><html><head><style>*{scrollbar-width:thin}</style></head></html>';
    expect(injectIframeScrollbarStyle(html)).toBe(html);
  });

  it('the injected CSS is single-line pure ASCII', () => {
    const out = injectIframeScrollbarStyle('<!doctype html><html><body></body></html>');
    const style = out.slice(out.indexOf('<style>') + 7, out.indexOf('</style>'));
    expect(style).not.toMatch(/[\n\r]/);
    expect(/^[\x20-\x7e]*$/.test(style)).toBe(true);
  });
});

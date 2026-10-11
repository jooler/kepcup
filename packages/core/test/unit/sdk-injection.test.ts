import { describe, expect, it } from 'vitest';

import {
  WIDGET_SDK_MARKER,
  WIDGET_SDK_SHIM,
  injectWidgetSdk,
} from '../../src/widgets/sdk-injection.js';

/**
 * SDK 垫片的执行路径测试（D81 P1）：垫片是带真实控制流的代码（promise 配对、错误码透传、
 * 高度夹取、key 校验），这里把它从 `<script>` 包裹里取出来，在 node 环境以假 window/parent
 * 执行，验证与宿主桥的协议契约——注入点与幂等的字符串级断言在 widgets-service.test.ts。
 */

const SHIM_BODY = WIDGET_SDK_SHIM.slice('<script>'.length, -'</script>'.length);

interface SentMessage {
  source: string;
  id: number;
  type: string;
  payload: Record<string, unknown>;
}

interface KepcupApi {
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(): Promise<unknown>;
  };
  openLink(url: unknown): Promise<unknown>;
  theme(): Promise<unknown>;
  setHeight(height: unknown): void;
}

interface ShimHarness {
  kepcup: KepcupApi;
  sent: SentMessage[];
  reply(data: Record<string, unknown>): void;
  replyFromOtherWindow(data: Record<string, unknown>): void;
}

function installShim(): ShimHarness {
  const sent: SentMessage[] = [];
  const parent = {
    postMessage: (msg: SentMessage) => {
      sent.push(msg);
    },
  };
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const win = {
    // 浏览器里 window.parent 天然存在；假 window 必须同样挂上，垫片的回执来源校验才为真。
    parent,
    kepcup: undefined as KepcupApi | undefined,
    addEventListener: (_type: string, fn: (event: { source: unknown; data: unknown }) => void) => {
      listeners.push(fn);
    },
  };
  new Function('window', 'parent', SHIM_BODY)(win, parent);
  if (win.kepcup === undefined) throw new Error('shim did not install window.kepcup');
  return {
    kepcup: win.kepcup,
    sent,
    reply: (data) => {
      for (const fn of listeners) fn({ source: parent, data });
    },
    replyFromOtherWindow: (data) => {
      for (const fn of listeners) fn({ source: {}, data });
    },
  };
}

describe('WIDGET_SDK_SHIM 执行路径', () => {
  it('storage.get：请求形状正确，按关联 id 配对回执', async () => {
    const h = installShim();
    const pending = h.kepcup.storage.get('count');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({
      source: 'kepcup-widget',
      id: 1,
      type: 'storage.get',
      payload: { key: 'count' },
    });
    h.reply({ source: 'kepcup-host', id: 1, ok: true, value: { n: 42 } });
    await expect(pending).resolves.toEqual({ n: 42 });
  });

  it('错误回执 reject 并透传机器可读 code；无 code 时只有 message', async () => {
    const h = installShim();
    const withCode = h.kepcup.storage.set('k', 1);
    h.reply({
      source: 'kepcup-host',
      id: 1,
      ok: false,
      error: '这个组件的存储空间已用完',
      code: 'WIDGET_STORAGE_QUOTA',
    });
    await expect(withCode).rejects.toMatchObject({
      message: '这个组件的存储空间已用完',
      code: 'WIDGET_STORAGE_QUOTA',
    });

    const withoutCode = h.kepcup.storage.list();
    h.reply({ source: 'kepcup-host', id: 2, ok: false, error: '宿主调用失败' });
    const err = (await withoutCode.then(
      () => {
        throw new Error('should have rejected');
      },
      (e: Error & { code?: string }) => e,
    )) as Error & { code?: string };
    expect(err.message).toBe('宿主调用失败');
    expect(err.code).toBeUndefined();
  });

  it('非宿主窗口的回执被忽略（正确回执仍能到达）', async () => {
    const h = installShim();
    const pending = h.kepcup.storage.get('k');
    h.replyFromOtherWindow({ source: 'kepcup-host', id: 1, ok: false, error: '伪造' });
    h.reply({ source: 'kepcup-host', id: 1, ok: true, value: 'v' });
    await expect(pending).resolves.toBe('v');
  });

  it('未知关联 id 的宿主消息被忽略，不影响后续请求', async () => {
    const h = installShim();
    h.reply({ source: 'kepcup-host', id: 999, ok: false, error: '过期回执' });
    const pending = h.kepcup.storage.get('k');
    expect(h.sent[0]!.id).toBe(1);
    h.reply({ source: 'kepcup-host', id: 1, ok: true, value: 1 });
    await expect(pending).resolves.toBe(1);
  });

  it('requireKey：空串同步抛错（requireKey 在发消息前执行），不发出消息', () => {
    const h = installShim();
    expect(() => h.kepcup.storage.get('')).toThrow(/非空字符串/);
    expect(() => h.kepcup.storage.delete('')).toThrow(/非空字符串/);
    expect(() => h.kepcup.storage.set('', 1)).toThrow(/非空字符串/);
    expect(h.sent).toHaveLength(0);
  });

  it('setHeight：夹取 [100, 800] 后上报（id 0 通知，数字字符串宽松接取），非有限数不上报', () => {
    const h = installShim();
    h.kepcup.setHeight(50);
    h.kepcup.setHeight(2000);
    h.kepcup.setHeight(380.4);
    h.kepcup.setHeight(Number.NaN);
    h.kepcup.setHeight('400');
    expect(h.sent).toHaveLength(4);
    expect(h.sent.map((m) => m.payload['height'])).toEqual([100, 800, 381, 400]);
    for (const message of h.sent) {
      expect(message).toMatchObject({ id: 0, type: 'setHeight' });
    }
  });

  it('theme / openLink 的请求与回执', async () => {
    const h = installShim();
    const theme = h.kepcup.theme();
    expect(h.sent[0]).toMatchObject({ type: 'theme.get', payload: {} });
    h.reply({ source: 'kepcup-host', id: 1, ok: true, value: 'dark' });
    await expect(theme).resolves.toBe('dark');

    await expect(h.kepcup.openLink('')).rejects.toThrow(/https/);
    const opened = h.kepcup.openLink('https://example.com');
    expect(h.sent[1]).toMatchObject({ type: 'openLink', payload: { url: 'https://example.com' } });
    h.reply({ source: 'kepcup-host', id: 2, ok: true, value: true });
    await expect(opened).resolves.toBe(true);
  });

  it('二次执行同一 window 时垫片早退（不重装、不发消息）', () => {
    const h = installShim();
    void h.kepcup.storage.list();
    expect(h.sent).toHaveLength(1);
    // 以同一个 window（kepcup 已存在）再装一次：IIFE 早退。
    new Function('window', 'parent', SHIM_BODY)(
      { kepcup: h.kepcup, addEventListener: () => undefined },
      { postMessage: () => undefined },
    );
    expect(h.sent).toHaveLength(1);
  });
});

describe('injectWidgetSdk 插入点边界', () => {
  it('<head> 出现在注释里时垫片会被注释吞掉——文档化的自伤失效模式，用例钉住行为防意外变化', () => {
    const tricky = '<!DOCTYPE html><!-- <head> --><html><body></body></html>';
    const out = injectWidgetSdk(tricky);
    // head 正则不做注释解析（廉价探测不值得）：垫片插进注释 → window.kepcup 不存在，
    // 无副作用（见 sdk-injection.ts 模块注释「已知失效模式」）；Bot 重发修正的 HTML 即恢复。
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<!-- <head><script>');
    expect(out).toContain(WIDGET_SDK_MARKER);
  });

  it('幂等判定认 WIDGET_SDK_MARKER，不认协议字段值', () => {
    // Bot HTML 恰好写了协议里的 source 字段值：不应被误判为已注入。
    const mimicking = '<!DOCTYPE html><html><body><script>parent.postMessage({source: "kepcup-widget"})</script></body></html>';
    const out = injectWidgetSdk(mimicking);
    expect(out).toContain(WIDGET_SDK_MARKER);
    // 真含垫片标记（含注释里的指纹）才跳过。
    expect(injectWidgetSdk(out)).toBe(out);
  });
});

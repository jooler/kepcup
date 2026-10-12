import { describe, expect, it } from 'vitest';

import { parse } from 'acorn';
import {
  WIDGET_KIT_SCRIPT,
  WIDGET_KIT_STYLE,
  WIDGET_SDK_MARKER,
  WIDGET_SDK_SHIM,
  injectWidgetSdk,
  wantsKepcupKit,
  widgetSdkShim,
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
  query(name: unknown, params: unknown): Promise<unknown>;
  openLink(url: unknown): Promise<unknown>;
  reply(text: unknown): Promise<unknown>;
  theme(): Promise<unknown>;
  setHeight(height: unknown): void;
}

interface ShimHarness {
  kepcup: KepcupApi;
  sent: SentMessage[];
  reply(data: Record<string, unknown>): void;
  replyFromOtherWindow(data: Record<string, unknown>): void;
}

function installShim(navigator: unknown = {}): ShimHarness {
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
  new Function('window', 'parent', 'navigator', SHIM_BODY)(win, parent, navigator);
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

  it('theme：直接返回注入时的主题；宿主推送主题事件后更新（D87 P3b）；openLink 请求与回执', async () => {
    const h = installShim();
    await expect(h.kepcup.theme()).resolves.toBe('light');
    expect(h.sent).toHaveLength(0);
    h.reply({ source: 'kepcup-host', event: 'theme', theme: 'dark' });
    await expect(h.kepcup.theme()).resolves.toBe('dark');
    // 非法主题值、非宿主窗口的主题事件都被忽略。
    h.reply({ source: 'kepcup-host', event: 'theme', theme: 'purple' });
    h.replyFromOtherWindow({ source: 'kepcup-host', event: 'theme', theme: 'light' });
    await expect(h.kepcup.theme()).resolves.toBe('dark');

    await expect(h.kepcup.openLink('')).rejects.toThrow(/https/);
    const opened = h.kepcup.openLink('https://example.com');
    expect(h.sent[0]).toMatchObject({ type: 'openLink', payload: { url: 'https://example.com' } });
    h.reply({ source: 'kepcup-host', id: 1, ok: true, value: true });
    await expect(opened).resolves.toBe(true);
  });

  it('reply（D87 P4 L3）：手势里发请求并按回执 resolve；不在手势里直接 false、不发；空文字被拒', async () => {
    const activation = { isActive: true };
    const h = installShim({ userActivation: activation });
    await expect(h.kepcup.reply('  ')).rejects.toThrow(/非空/);
    const sent = h.kepcup.reply('清单：牛奶');
    expect(h.sent[0]).toMatchObject({ type: 'reply', payload: { text: '清单：牛奶' } });
    h.reply({ source: 'kepcup-host', id: 1, ok: true, value: true });
    await expect(sent).resolves.toBe(true);

    activation.isActive = false;
    await expect(h.kepcup.reply('再来')).resolves.toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it('query：请求形状 { name, params }；params 缺省为 {}；按关联 id 配对回执并透传错误码', async () => {
    const h = installShim();
    const pending = h.kepcup.query('by_month', { month: '2026-02' });
    expect(h.sent[0]).toEqual({
      source: 'kepcup-widget',
      id: 1,
      type: 'query',
      payload: { name: 'by_month', params: { month: '2026-02' } },
    });
    h.reply({ source: 'kepcup-host', id: 1, ok: true, value: { rows: [{ total: 5 }], truncated: false } });
    await expect(pending).resolves.toEqual({ rows: [{ total: 5 }], truncated: false });

    // params 缺省为 {}（宿主 schema 的 default 语义在垫片侧就兑现）。
    const noParams = h.kepcup.query('all', undefined);
    expect(h.sent[1]).toMatchObject({ type: 'query', payload: { name: 'all', params: {} } });
    h.reply({
      source: 'kepcup-host',
      id: 2,
      ok: false,
      error: '查询「all」没有在这个组件版本里登记',
      code: 'WIDGET_QUERY_UNKNOWN',
    });
    await expect(noParams).rejects.toMatchObject({
      message: '查询「all」没有在这个组件版本里登记',
      code: 'WIDGET_QUERY_UNKNOWN',
    });
  });

  it('query：非空字符串校验在发消息前同步失败，不发消息', async () => {
    const h = installShim();
    await expect(h.kepcup.query('', {})).rejects.toThrow(/非空字符串/);
    await expect(h.kepcup.query(42, {})).rejects.toThrow(/非空字符串/);
    expect(h.sent).toHaveLength(0);
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
    expect(out).toContain('<!-- <head><style data-kepcup="theme">');
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

describe('垫片 v2：单行注入、主题与 kit（D87 P3b）', () => {
  const body = (script: string): string => script.slice(script.indexOf('>') + 1, -'</script>'.length);

  it('注入内容不含换行：原文每一行的行号不变', () => {
    const html = '<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body><script>boom()</script></body>\n</html>';
    const out = injectWidgetSdk(html, { theme: 'dark' });
    expect(out.split('\n')).toHaveLength(html.split('\n').length);
    expect(out.split('\n')[5]).toBe('<body><script>boom()</script></body>');
    expect(WIDGET_SDK_SHIM).not.toContain('\n');
  });

  it('垫片与 kit 脚本折行后仍是合法 JS（不依赖换行的语句分隔）', () => {
    for (const script of [widgetSdkShim('light'), widgetSdkShim('dark'), WIDGET_KIT_SCRIPT]) {
      expect(() => parse(body(script), { ecmaVersion: 2022, sourceType: 'script' })).not.toThrow();
    }
  });

  it('主题按 open 的参数写进垫片（缺省 light），主题变量总是注入', () => {
    expect(injectWidgetSdk('<html><head></head></html>')).toContain("currentTheme = 'light'");
    const dark = injectWidgetSdk('<html><head></head></html>', { theme: 'dark' });
    expect(dark).toContain("currentTheme = 'dark'");
    expect(dark).toContain('--kc-accent');
    expect(dark).toContain(':root[data-theme=dark]');
    // 不带 kit 的存量组件不受 color-scheme 影响。
    expect(dark).not.toContain('color-scheme');
  });

  it('kit 只在 <meta name="kepcup-kit" content="1"> 时注入', () => {
    const plain = '<html><head></head><body></body></html>';
    const kit = '<html><head><meta name="kepcup-kit" content="1"></head><body></body></html>';
    expect(wantsKepcupKit(plain)).toBe(false);
    expect(wantsKepcupKit(kit)).toBe(true);
    expect(wantsKepcupKit('<meta content="1" name="kepcup-kit">')).toBe(true);
    expect(injectWidgetSdk(plain)).not.toContain('kepcup-kit');
    const out = injectWidgetSdk(kit);
    expect(out).toContain(WIDGET_KIT_STYLE);
    expect(out).toContain(WIDGET_KIT_SCRIPT);
    expect(WIDGET_KIT_STYLE).toContain(':where(');
  });

  it('旧版（v1）垫片标记同样视为已注入', () => {
    const legacy = '<html><head><script>/* kepcup-widget-sdk-v1 */</script></head></html>';
    expect(injectWidgetSdk(legacy)).toBe(legacy);
    expect(WIDGET_SDK_MARKER).toBe('kepcup-widget-sdk-v2');
  });
});


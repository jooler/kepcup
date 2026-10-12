import { describe, expect, test } from 'vitest';
import {
  WIDGET_PREVIEW_RPC_METHODS,
  widgetAcceptanceSchema,
  type WidgetPreviewFinding,
  type WidgetPreviewRunInput,
} from '@kepcup/shared';
import { parseAppUiUrl } from './apps-ui-policy';
import {
  alignAcceptance,
  classifyConsoleMessage,
  isPreviewRequestAllowed,
  isUniformBitmap,
  mergeConsoleFindings,
  newPreviewResource,
  probeVerdict,
  sanitizeProbeFindings,
  shouldBlockPreviewNavigation,
  timeoutFinding,
} from './widget-preview-policy';
import { PREVIEW_SHELL_BRIDGE_JS, buildPreviewShellHtml } from './widget-preview-shell';
import { widgetPreviewMethodSpecs } from './widget-preview-methods';

/**
 * D87 P3b 预览宿主的纯逻辑（设计 32 §11.9）：资源地址、导航 / 请求判定、探针回报清洗、
 * console-message 兜底合并、模拟能力桥的回执形状（与正式宿主 widget-bridge-host 逐字段一致）。
 * 真实 Chromium 里的行为见 apps/desktop/test/electron/widget-preview.harness.ts。
 */

const SHELL = 'file:///tmp/kepcup-widget-preview-x/shell.html';

describe('preview resources and navigation', () => {
  test('every preview gets a fresh host that passes the kepcup-app URL shape check', () => {
    const a = newPreviewResource();
    const b = newPreviewResource();
    expect(a.host).not.toBe(b.host);
    expect(a.host.startsWith('widget-preview-')).toBe(true);
    expect(parseAppUiUrl(a.url)).toEqual({ host: a.host, resourceId: a.resourceId });
  });

  test('only the first load of a blank subframe into a preview resource is allowed', () => {
    const { url } = newPreviewResource();
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: false,
        frameUrl: 'about:blank',
        targetUrl: url,
        shellUrl: SHELL,
      }),
    ).toBe(false);
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: false,
        frameUrl: '',
        targetUrl: url,
        shellUrl: SHELL,
      }),
    ).toBe(false);
    // A loaded widget frame may not go anywhere (other previews, the web, itself).
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: false,
        frameUrl: url,
        targetUrl: url,
        shellUrl: SHELL,
      }),
    ).toBe(true);
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: false,
        frameUrl: 'about:blank',
        targetUrl: 'https://example.com/',
        shellUrl: SHELL,
      }),
    ).toBe(true);
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: false,
        frameUrl: 'about:blank',
        targetUrl: 'kepcup-app://widget-abc/x',
        shellUrl: SHELL,
      }),
    ).toBe(true);
    // The top frame stays on the shell page.
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: true,
        frameUrl: SHELL,
        targetUrl: SHELL,
        shellUrl: SHELL,
      }),
    ).toBe(false);
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: true,
        frameUrl: SHELL,
        targetUrl: url,
        shellUrl: SHELL,
      }),
    ).toBe(true);
    expect(
      shouldBlockPreviewNavigation({
        isMainFrame: true,
        frameUrl: SHELL,
        targetUrl: 'file:///etc/passwd',
        shellUrl: SHELL,
      }),
    ).toBe(true);
  });

  test('request allow-list: shell, preview resources, inline schemes', () => {
    expect(isPreviewRequestAllowed(SHELL, SHELL)).toBe(true);
    expect(isPreviewRequestAllowed(newPreviewResource().url, SHELL)).toBe(true);
    expect(isPreviewRequestAllowed('data:image/png;base64,AAAA', SHELL)).toBe(true);
    for (const bad of [
      'https://cdn.example.com/x.js',
      'file:///etc/passwd',
      'kepcup-app://widget-abc/x',
      'ws://localhost:1',
    ]) {
      expect(isPreviewRequestAllowed(bad, SHELL), bad).toBe(false);
    }
  });
});

describe('probe report sanitising', () => {
  test('drops malformed findings and clamps text', () => {
    const out = sanitizeProbeFindings([
      {
        rule: 'runtime.error',
        message: 'Uncaught TypeError: x',
        line: 12,
        col: 3,
        trigger: 'button#add「添加」',
      },
      { rule: 'made.up', message: 'x' },
      { rule: 'console.warn', message: 42 },
      { rule: 'render.bad-text', message: 'y'.repeat(5_000), line: 0, col: -1 },
      null,
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      rule: 'runtime.error',
      message: 'Uncaught TypeError: x',
      line: 12,
      col: 3,
      trigger: 'button#add「添加」',
    });
    expect(out[1]!.line).toBeUndefined();
    expect(out[1]!.message.length).toBeLessThanOrEqual(2_000);
    expect(sanitizeProbeFindings('nope')).toEqual([]);
  });

  test('acceptance is aligned to the input items (id / must from the input)', () => {
    const acceptance = widgetAcceptanceSchema.parse([
      { id: 'a', desc: 'A', must: true, expect: [{ noErrors: true }] },
      { id: 'b', desc: 'B', expect: [{ noBadText: true }] },
    ]);
    expect(
      alignAcceptance(acceptance, [
        { id: 'a', must: false, passed: true, detail: '' },
        { id: 'zzz', passed: true },
      ]),
    ).toEqual([
      { id: 'a', must: true, passed: true, detail: '' },
      { id: 'b', must: false, passed: false, detail: '未执行（探针没有回报这一条）' },
    ]);
    expect(alignAcceptance(null, [{ id: 'a', passed: true }])).toEqual([]);
  });
});

describe('console-message backup channel', () => {
  test('classifies uncaught errors, rejections and CSP; ignores plain console output', () => {
    expect(classifyConsoleMessage('Uncaught TypeError: a is not a function')).toEqual({
      rule: 'runtime.error',
      text: 'Uncaught TypeError: a is not a function',
    });
    expect(classifyConsoleMessage('Uncaught (in promise) Error: nope')).toEqual({
      rule: 'runtime.rejection',
      text: 'Error: nope',
    });
    expect(
      classifyConsoleMessage(
        "Refused to load the script 'https://cdn.example.com/x.js' because it violates the following Content Security Policy directive: \"script-src 'unsafe-inline'\".",
      )?.rule,
    ).toBe('csp.violation');
    expect(classifyConsoleMessage('just logging an error')).toBeNull();
  });

  test('merges what the probe missed and dedupes what it saw', () => {
    const probe: WidgetPreviewFinding[] = [
      {
        rule: 'runtime.error',
        message: 'Uncaught ReferenceError: foo is not defined',
        line: 7,
        col: 1,
      },
      {
        rule: 'csp.violation',
        message: '内容安全策略拦截（script-src-elem）：https://cdn.example.com/x.js',
        line: 5,
      },
    ];
    const merged = mergeConsoleFindings(probe, [
      { level: 'error', message: 'Uncaught ReferenceError: foo is not defined', line: 7 },
      {
        level: 'error',
        message:
          "Refused to load the script 'https://cdn.example.com/x.js' because it violates the following Content Security Policy directive",
        line: 5,
      },
      { level: 'error', message: 'Uncaught (in promise) Error: late', line: 9 },
      { level: 'error', message: 'Uncaught (in promise) Error: late', line: 9 },
      { level: 'warning', message: 'Uncaught TypeError: ignored (not error level)', line: 1 },
      { level: 'error', message: 'console.error output is the probe’s job', line: 3 },
    ]);
    expect(merged).toEqual([
      ...probe,
      { rule: 'runtime.rejection', message: 'Error: late', line: 9 },
    ]);
  });

  test('a tampered probe still yields the uncaught exception', () => {
    expect(
      mergeConsoleFindings([], [{ level: 'error', message: 'Uncaught Error: boom', line: 4 }]),
    ).toEqual([{ rule: 'runtime.error', message: 'Uncaught Error: boom', line: 4 }]);
  });
});

describe('timeout finding and screenshots', () => {
  test('says where the preview got stuck', () => {
    const atLoad = timeoutFinding({ timeoutMs: 8_000, stage: 'loading', lastTrigger: null });
    expect(atLoad.rule).toBe('preview.timeout');
    expect(atLoad.message).toContain('8s');
    expect(atLoad.message).toContain('加载期间');
    expect(atLoad.trigger).toBeUndefined();
    const monkey = timeoutFinding({
      timeoutMs: 8_000,
      stage: 'inspecting',
      lastTrigger: 'button#go「开始」',
    });
    expect(monkey.trigger).toBe('button#go「开始」');
    expect(monkey.message).toContain('button#go「开始」');
  });

  test('a 0×0 widget viewport invalidates the run; other probe trouble is only noted', () => {
    expect(probeVerdict({ probeReady: true, viewport: [360, 380], error: undefined })).toEqual({
      status: 'ok',
      detail: '',
    });
    expect(probeVerdict({ probeReady: true, viewport: [0, 0], error: undefined }).status).toBe(
      'failed',
    );
    const noted = probeVerdict({ probeReady: false, viewport: [360, 380], error: 'boom' });
    expect(noted.status).toBe('ok');
    expect(noted.detail).toContain('boom');
  });

  test('uniform bitmaps are treated as not-yet-composited frames', () => {
    const white = new Uint8Array(4 * 100).fill(255);
    expect(isUniformBitmap(white)).toBe(true);
    const marked = white.slice();
    marked[40] = 0;
    expect(isUniformBitmap(marked)).toBe(false);
  });
});

/** 外壳页内联的模拟能力桥（取出函数在 node 里跑协议用例）。 */
type BridgeState = {
  kv: Record<string, unknown>;
  queries: Record<string, unknown[]>;
  theme: string;
  links: string[];
  now?: () => number;
};
type BridgeOut = { reply: Record<string, unknown> | null; height: number | null };
const kcBridgeHandle = new Function(`${PREVIEW_SHELL_BRIDGE_JS}; return kcBridgeHandle;`)() as (
  state: BridgeState,
  msg: unknown,
) => BridgeOut;

function bridgeState(): BridgeState {
  return {
    kv: Object.assign(Object.create(null) as Record<string, unknown>, { total: { n: 3 } }),
    queries: { recent: [{ id: 1, text: 'hi' }] },
    theme: 'dark',
    links: [],
  };
}

const call = (state: BridgeState, id: number, type: string, payload: unknown): BridgeOut =>
  kcBridgeHandle(state, { source: 'kepcup-widget', id, type, payload });

describe('preview shell mock bridge', () => {
  test('storage: in-memory KV seeded from fixtures, JSON-cloned, exact reply shapes', () => {
    const state = bridgeState();
    expect(call(state, 1, 'storage.get', { key: 'total' }).reply).toEqual({
      source: 'kepcup-host',
      id: 1,
      ok: true,
      value: { n: 3 },
    });
    // Miss: no `value` key at all (the shim resolves undefined), like the real host.
    expect(call(state, 2, 'storage.get', { key: 'missing' }).reply).toEqual({
      source: 'kepcup-host',
      id: 2,
      ok: true,
    });
    const value = { list: [1, 2] };
    expect(call(state, 3, 'storage.set', { key: 'k', value }).reply).toEqual({
      source: 'kepcup-host',
      id: 3,
      ok: true,
    });
    value.list.push(3);
    expect(call(state, 4, 'storage.get', { key: 'k' }).reply?.['value']).toEqual({ list: [1, 2] });
    expect(call(state, 5, 'storage.list', {}).reply?.['value']).toEqual(['k', 'total']);
    expect(call(state, 6, 'storage.delete', { key: 'k' }).reply).toEqual({
      source: 'kepcup-host',
      id: 6,
      ok: true,
    });
    expect(call(state, 7, 'storage.list', {}).reply?.['value']).toEqual(['total']);
    expect(call(state, 8, 'storage.get', { key: '' }).reply).toEqual({
      source: 'kepcup-host',
      id: 8,
      ok: false,
      error: 'kepcup.storage 需要一个非空字符串 key',
      code: 'INVALID_INPUT',
    });
  });

  test('query returns fixtures by name (default empty), never truncated', () => {
    const state = bridgeState();
    expect(call(state, 1, 'query', { name: 'recent', params: {} }).reply?.['value']).toEqual({
      rows: [{ id: 1, text: 'hi' }],
      truncated: false,
    });
    expect(call(state, 2, 'query', { name: 'unknown' }).reply?.['value']).toEqual({
      rows: [],
      truncated: false,
    });
    expect(call(state, 3, 'query', { name: 'recent', params: [] }).reply?.['code']).toBe(
      'INVALID_INPUT',
    );
  });

  test('openLink is recorded (https only) and answered as declined; theme follows the viewport', () => {
    const state = bridgeState();
    expect(call(state, 1, 'openLink', { url: 'https://example.com/a' }).reply).toEqual({
      source: 'kepcup-host',
      id: 1,
      ok: true,
      value: false,
    });
    expect(call(state, 2, 'openLink', { url: 'http://example.com/' }).reply?.['ok']).toBe(false);
    expect(state.links).toEqual(['https://example.com/a']);
    expect(call(state, 3, 'theme.get', {}).reply?.['value']).toBe('dark');
  });

  test('setHeight is a clamped notification; malformed messages get an error reply when they carry an id', () => {
    const state = bridgeState();
    expect(call(state, 0, 'setHeight', { height: 5_000 })).toEqual({ reply: null, height: 800 });
    expect(call(state, 0, 'setHeight', { height: 'x' })).toEqual({ reply: null, height: null });
    expect(call(state, 9, 'fs.read', {}).reply).toEqual({
      source: 'kepcup-host',
      id: 9,
      ok: false,
      error: '不支持的消息格式',
      code: 'INVALID_INPUT',
    });
    expect(
      kcBridgeHandle(state, { source: 'kepcup-widget', type: 'theme.get', payload: {} }).reply,
    ).toBeNull();
    expect(
      kcBridgeHandle(state, { source: 'other', id: 1, type: 'theme.get', payload: {} }).reply,
    ).toBeNull();
  });

  test('production limits: value size / total quota / key count → WIDGET_STORAGE_QUOTA (review fix)', () => {
    const state = bridgeState();
    let t = 1_000_000;
    state.now = () => t;
    const big = call(state, 1, 'storage.set', { key: 'big', value: 'x'.repeat(300 * 1024) });
    expect(big.reply).toMatchObject({ ok: false, code: 'WIDGET_STORAGE_QUOTA' });
    for (let i = 0; i < 4; i++) {
      expect(
        call(state, 10 + i, 'storage.set', { key: `k${i}`, value: 'y'.repeat(250 * 1024) }).reply,
      ).toMatchObject({ ok: true });
      t += 10_000; // 让令牌桶回满，只测配额
    }
    const over = call(state, 20, 'storage.set', { key: 'k9', value: 'y'.repeat(250 * 1024) });
    expect(over.reply).toMatchObject({ ok: false, code: 'WIDGET_STORAGE_QUOTA' });
    // 覆盖已有键不重复计入旧值。
    expect(call(state, 21, 'storage.set', { key: 'k0', value: 'z' }).reply).toMatchObject({
      ok: true,
    });
  });

  test('storage + query share the production token bucket → WIDGET_RATE_LIMITED (review fix)', () => {
    const state = bridgeState();
    let t = 1_000_000;
    state.now = () => t;
    const codes: Array<string | undefined> = [];
    for (let i = 0; i < 25; i++) {
      const out = call(
        state,
        i + 1,
        i % 2 === 0 ? 'storage.get' : 'query',
        i % 2 === 0 ? { key: 'total' } : { name: 'recent' },
      );
      codes.push(out.reply?.['code'] as string | undefined);
    }
    expect(codes.slice(0, 20).every((code) => code === undefined)).toBe(true);
    expect(codes.slice(20).every((code) => code === 'WIDGET_RATE_LIMITED')).toBe(true);
    t += 1_000; // 每秒回填 5 个
    expect(call(state, 99, 'storage.list', {}).reply).toMatchObject({ ok: true });
    // theme / setHeight 不计数。
    expect(call(state, 100, 'theme.get', {}).reply).toMatchObject({ ok: true });
  });

  test('the shell page embeds the bridge and mounts the iframe like BotWidgetCard', () => {
    const html = buildPreviewShellHtml();
    expect(html).toContain(PREVIEW_SHELL_BRIDGE_JS);
    expect(html).toContain("f.setAttribute('sandbox', 'allow-scripts')");
    expect(html).toContain("f.setAttribute('allow', '')");
    expect(html).toContain("f.setAttribute('referrerpolicy', 'no-referrer')");
    expect(html).toContain('frame-src kepcup-app:');
  });
});

describe('widgetPreview.run method spec', () => {
  test('covers the registry and validates input / output with the shared schemas', async () => {
    const seen: WidgetPreviewRunInput[] = [];
    const specs = widgetPreviewMethodSpecs({
      run: (input) => {
        seen.push(input);
        return Promise.resolve({ viewports: [] });
      },
    });
    expect(Object.keys(specs).sort()).toEqual([...WIDGET_PREVIEW_RPC_METHODS].sort());
    const spec = specs['widgetPreview.run'];
    const input = spec.input.parse({
      viewports: [{ width: 360, theme: 'light', html: '<p>x</p>' }],
      acceptance: null,
      fixtures: {},
      monkeyMax: 30,
      screenshots: false,
    });
    expect(spec.output.parse(await spec.handle(input))).toEqual({ viewports: [] });
    expect(seen[0]!.fixtures).toEqual({ storage: {}, queries: {} });
    expect(() =>
      spec.input.parse({
        viewports: [],
        acceptance: null,
        fixtures: {},
        monkeyMax: 1,
        screenshots: false,
      }),
    ).toThrow();
  });
});

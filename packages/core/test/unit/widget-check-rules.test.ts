import { describe, expect, it } from 'vitest';

import {
  WIDGET_CHECK_RULES,
  previewOfflineNetworkMessage,
  previewOfflineResourceLoadMessage,
  ruleIssue,
  sandboxPitfallsPrompt,
  widgetCheckRule,
} from '../../src/widgets/check/index.js';

/** D87 P3a 规则注册表：覆盖设计 32 §11.8 的规则、级别与阻断口径、提示词不漂移。 */

describe('widget check rule registry', () => {
  it('registers every rule in design §11.8.1 / §11.8.2 plus the P3a/P3b extras, once', () => {
    const ids = WIDGET_CHECK_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'html.missing',
        'html.truncated',
        'html.size',
        'html.doctype',
        'sandbox.external-resource',
        'sandbox.storage',
        'sandbox.form-submit',
        'sandbox.submit-button',
        'sandbox.popup',
        'sandbox.top-nav',
        'sandbox.link-navigation',
        'sandbox.download',
        'sandbox.clipboard',
        'theme.media-query',
        'query.invalid',
        'query.unknown-name',
        'acceptance.invalid',
        'fixtures.invalid',
        'js.syntax',
        'js.handler-syntax',
        'js.handler-undefined',
        'js.undefined-name',
        'js.redeclare',
        'dom.id-missing',
        'dom.duplicate-id',
        'kepcup.not-awaited',
        'runtime.error',
        'runtime.rejection',
        'console.error',
        'console.warn',
        'csp.violation',
        'render.blank',
        'render.overflow-x',
        'render.bad-text',
        'preview.timeout',
        'preview.offline-network',
      ]),
    );
  });

  it('levels follow the full-webapp tier (storage / forms are warnings, no network / modals rules)', () => {
    const level = (id: string): string => widgetCheckRule(id).level;
    expect(level('sandbox.storage')).toBe('warning');
    expect(level('sandbox.submit-button')).toBe('warning');
    expect(level('sandbox.form-submit')).toBe('warning');
    expect(level('sandbox.link-navigation')).toBe('warning');
    expect(level('acceptance.invalid')).toBe('warning');
    expect(level('preview.offline-network')).toBe('warning');
    // 完整 WebApp 档：联网 / confirm / alert 合法，不再有对应禁区规则。
    expect(() => widgetCheckRule('sandbox.network')).toThrow(/unknown/);
    expect(() => widgetCheckRule('sandbox.modals')).toThrow(/unknown/);
    expect(() => widgetCheckRule('sandbox.alert')).toThrow(/unknown/);
  });

  it('every S0/S1 error is blocking; S2 blocking set matches §11.6', () => {
    for (const rule of WIDGET_CHECK_RULES) {
      if (rule.stage !== 'S2') expect(rule.blocking, rule.id).toBe(rule.level === 'error');
      if (rule.level === 'warning') expect(rule.blocking, rule.id).toBe(false);
    }
    const s2Blocking = WIDGET_CHECK_RULES.filter((rule) => rule.stage === 'S2' && rule.blocking)
      .map((rule) => rule.id)
      .sort();
    expect(s2Blocking).toEqual([
      'preview.timeout',
      'render.blank',
      'runtime.error',
      'runtime.rejection',
    ]);
    expect(widgetCheckRule('console.error')).toMatchObject({ level: 'error', blocking: false });
    expect(widgetCheckRule('csp.violation')).toMatchObject({ level: 'error', blocking: false });
  });

  it('every rule has a Chinese title and hint; widgetCheckRule throws on unknown ids', () => {
    for (const rule of WIDGET_CHECK_RULES) {
      expect(rule.title, rule.id).toMatch(/[一-鿿]/);
      expect(rule.hint, rule.id).toMatch(/[一-鿿]/);
    }
    expect(() => widgetCheckRule('no.such-rule')).toThrow(/unknown/);
  });

  it('sandbox hints point at the kepcup.* replacements', () => {
    expect(widgetCheckRule('sandbox.storage').hint).toContain('kepcup.storage');
    expect(widgetCheckRule('sandbox.popup').hint).toContain('kepcup.openLink');
    expect(widgetCheckRule('preview.offline-network').hint).toContain('fixtures');
  });

  it('ruleIssue: downgraded level is never blocking; messages are clipped', () => {
    const warn = ruleIssue('js.undefined-name', {
      message: 'x',
      level: 'warning',
      line: 1,
      col: 2,
    });
    expect(warn).toMatchObject({
      level: 'warning',
      blocking: false,
      stage: 'S1',
      file: 'index.html',
    });
    const long = ruleIssue('query.invalid', { message: 'y'.repeat(1000), file: 'queries.json' });
    expect(long.blocking).toBe(true);
    expect(long.message.length).toBeLessThanOrEqual(300);
  });

  it('sandboxPitfallsPrompt mentions every rule id (prompt and checker cannot drift)', () => {
    const prompt = sandboxPitfallsPrompt();
    for (const rule of WIDGET_CHECK_RULES) expect(prompt, rule.id).toContain(`[${rule.id}]`);
    expect(prompt).toContain('沙箱雷区清单');
    expect(prompt).toContain('阻断');
  });
});

describe('preview offline classifiers', () => {
  it('previewOfflineNetworkMessage matches the offline failure shapes (dead proxy)', () => {
    // fetch / XHR / WebSocket 的典型离线报错。
    expect(previewOfflineNetworkMessage('TypeError: Failed to fetch')).toBe(true);
    expect(
      previewOfflineNetworkMessage(
        "WebSocket connection to 'wss://x' failed: Error in connection establishment: net::ERR_PROXY_CONNECTION_FAILED",
      ),
    ).toBe(true);
    expect(
      previewOfflineNetworkMessage("GET https://x net::ERR_TUNNEL_CONNECTION_FAILED"),
    ).toBe(true);
    expect(previewOfflineNetworkMessage('NetworkError: Failed to execute send on XMLHttpRequest')).toBe(true);
    expect(previewOfflineNetworkMessage('net::ERR_CONNECTION_TIMED_OUT')).toBe(true);
    expect(previewOfflineNetworkMessage('net::ERR_CONNECTION_REFUSED')).toBe(true);
  });

  it('previewOfflineNetworkMessage does not swallow unrelated runtime errors', () => {
    // 旧版宽松匹配（关键词 + 任意远距离 error/failed）会把这类真实缺陷降级；现在不命中。
    expect(previewOfflineNetworkMessage("Failed to set target on 'XMLHttpRequest': not a function")).toBe(
      false,
    );
    expect(previewOfflineNetworkMessage('TypeError: WebSocketChannel has no method open0')).toBe(false);
    expect(previewOfflineNetworkMessage('ReferenceError: socket is not defined')).toBe(false);
    expect(previewOfflineNetworkMessage('读文件失败：EACCES')).toBe(false);
  });

  it('previewOfflineResourceLoadMessage: only external-resource load failures count', () => {
    expect(previewOfflineResourceLoadMessage('资源加载失败：<script> https://cdn.example.com/x.js')).toBe(
      true,
    );
    expect(previewOfflineResourceLoadMessage('资源加载失败：<img> HTTP://cdn.example.com/a.png')).toBe(
      true,
    );
    // 相对路径的加载失败是真实缺陷（S0 已阻断），不算离线产物。
    expect(previewOfflineResourceLoadMessage('资源加载失败：<script> js/app.js')).toBe(false);
    expect(previewOfflineResourceLoadMessage('资源加载失败：<img> (无地址)')).toBe(false);
    // 其它 console.error（真实的运行期错误输出）照常上报。
    expect(previewOfflineResourceLoadMessage('TypeError: x is null')).toBe(false);
  });
});

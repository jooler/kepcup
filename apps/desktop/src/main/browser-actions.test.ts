import { AppError, type AxtreeNode } from '@kepcup/shared';
import { describe, expect, test } from 'vitest';
import {
  axStateDigest,
  backAction,
  clickAction,
  pressAction,
  scrollAction,
  typeAction,
  type PageOps,
} from './browser-actions.js';

/**
 * W1: every CDP call site of the page actions, failing one at a time, must
 * report the right phase — 'pre' (nothing dispatched) or 'post' (outcome
 * unknown). The fake page answers the preflight like a healthy element.
 */
interface FakeOptions {
  /** `method#n` (n-th call of that method, 1-based) or `settle#n` / `goBack` / `ref` → error. */
  fail?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  ax?: AxtreeNode[] | null;
  click?: unknown;
  focus?: unknown;
  canGoBack?: boolean;
  navigateOn?: string;
}

function fakeOps(options: FakeOptions = {}) {
  const sent: string[] = [];
  const counts = new Map<string, number>();
  let seq = 0;
  const hit = (name: string): void => {
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    const failure = options.fail?.[`${name}#${n}`] ?? options.fail?.[name];
    if (failure !== undefined) throw failure;
    if (options.navigateOn === `${name}#${n}`) seq += 1;
  };
  const ops: PageOps = {
    settle: async () => hit('settle'),
    initDom: async () => hit('initDom'),
    send: async (method, params) => {
      const fn = (params as { functionDeclaration?: string }).functionDeclaration ?? '';
      const label =
        method === 'Runtime.callFunctionOn'
          ? fn.includes('clicked')
            ? 'click'
            : fn.includes('focused')
              ? 'focus'
              : 'probe'
          : method;
      sent.push(label);
      hit(label);
      switch (label) {
        case 'DOM.resolveNode':
          return { object: { objectId: 'obj-1' } };
        case 'probe':
          return {
            result: {
              value: {
                connected: true,
                visible: true,
                disabled: false,
                password: false,
                ...options.probe,
              },
            },
          };
        case 'Accessibility.getPartialAXTree':
          return {
            nodes:
              options.ax === null
                ? []
                : (options.ax ?? [
                    {
                      nodeId: '1',
                      backendDOMNodeId: 42,
                      role: { value: 'button' },
                      name: { value: '提交' },
                    },
                  ]),
          };
        case 'click':
          return options.click ?? { result: { value: { clicked: true } } };
        case 'focus':
          return options.focus ?? { result: { value: { focused: true } } };
        default:
          return {};
      }
    },
    refFingerprint: (ref) => {
      hit('ref');
      return {
        backendNodeId: 42,
        role: ref === 'e2' ? 'textbox' : 'button',
        name: ref === 'e2' ? '密码' : '提交',
      };
    },
    navigationSeq: () => seq,
    canGoBack: () => options.canGoBack ?? true,
    goBack: () => hit('goBack'),
    delay: async () => {},
  };
  return { ops, sent };
}

async function phaseOf(
  run: Promise<unknown>,
): Promise<{ code: string; phase: unknown; details: Record<string, unknown> }> {
  try {
    await run;
  } catch (error) {
    const e = error as AppError;
    const details = (e.details ?? {}) as Record<string, unknown>;
    return { code: e.code, phase: details['phase'], details };
  }
  throw new Error('expected the action to fail');
}

const boom = new Error('boom');

describe('browser click phases (W1)', () => {
  test('success reports completed and the navigated flag', async () => {
    const { ops, sent } = fakeOps({ navigateOn: 'settle#2' });
    await expect(clickAction(() => ops, 'e1')).resolves.toEqual({
      ok: true,
      outcome: 'completed',
      navigated: true,
    });
    expect(sent).toEqual(['DOM.resolveNode', 'probe', 'Accessibility.getPartialAXTree', 'click']);
  });

  test.each([
    ['page lookup', { open: true }, 'BROWSER_PAGE_CLOSED'],
    [
      'ref lookup',
      { fail: { ref: new AppError('BROWSER_REF_UNKNOWN', 'x') } },
      'BROWSER_REF_UNKNOWN',
    ],
    ['settle before', { fail: { 'settle#1': new Error('Target closed') } }, 'BROWSER_PAGE_CLOSED'],
    ['DOM agent init', { fail: { initDom: boom } }, 'INTERNAL'],
    ['DOM.resolveNode', { fail: { 'DOM.resolveNode': boom } }, 'BROWSER_REF_STALE'],
    ['preflight probe', { fail: { probe: boom } }, 'INTERNAL'],
    ['detached element', { probe: { connected: false } }, 'BROWSER_REF_STALE'],
    ['hidden element', { probe: { visible: false } }, 'BROWSER_REF_STALE'],
    ['disabled element', { probe: { disabled: true } }, 'BROWSER_REF_STALE'],
    [
      'renamed element',
      {
        ax: [
          { nodeId: '1', backendDOMNodeId: 42, role: { value: 'button' }, name: { value: '删除' } },
        ],
      },
      'BROWSER_REF_STALE',
    ],
    ['click function threw', { click: { exceptionDetails: { text: 'TypeError' } } }, 'INTERNAL'],
    [
      'click refused in the same turn',
      { click: { result: { value: { clicked: false, reason: 'hidden' } } } },
      'BROWSER_REF_STALE',
    ],
  ] as const)('%s → pre', async (_name, options, code) => {
    const { ops, sent } = fakeOps(options as FakeOptions);
    const open = () => {
      if ('open' in options) throw new AppError('BROWSER_PAGE_CLOSED', '浏览器页面未打开或已关闭');
      return ops;
    };
    const result = await phaseOf(clickAction(open, 'e1'));
    expect(result).toMatchObject({ code, phase: 'pre' });
    if (!('click' in options)) expect(sent).not.toContain('click');
  });

  test('a failing or non-matching AX lookup is not a staleness signal', async () => {
    for (const options of [
      { fail: { 'Accessibility.getPartialAXTree': boom } },
      {
        ax: [
          { nodeId: '9', backendDOMNodeId: 7, role: { value: 'link' }, name: { value: '别的' } },
        ],
      },
    ] as FakeOptions[]) {
      await expect(clickAction(() => fakeOps(options).ops, 'e1')).resolves.toMatchObject({
        outcome: 'completed',
      });
    }
  });

  test.each([
    [
      'click call transport error',
      { fail: { click: new Error('Target closed') } },
      'BROWSER_PAGE_CLOSED',
    ],
    [
      'execution context destroyed',
      { fail: { click: new Error('Execution context was destroyed.') } },
      'INTERNAL',
    ],
    [
      'settle after click',
      { fail: { 'settle#2': new Error('Target closed') } },
      'BROWSER_PAGE_CLOSED',
    ],
  ] as const)('%s → post', async (_name, options, code) => {
    const result = await phaseOf(clickAction(() => fakeOps(options as FakeOptions).ops, 'e1'));
    expect(result).toMatchObject({ code, phase: 'post' });
  });
});

describe('browser type phases (W1)', () => {
  test('a password target is reported on success and on failure (stale / post)', async () => {
    const ok = await typeAction(
      () => fakeOps({ probe: { password: true }, ax: null }).ops,
      'e2',
      'pw',
    );
    expect(ok).toMatchObject({ outcome: 'completed', passwordField: true });

    const stale = await phaseOf(
      typeAction(() => fakeOps({ probe: { password: true, disabled: true } }).ops, 'e2', 'pw'),
    );
    expect(stale).toMatchObject({
      code: 'BROWSER_REF_STALE',
      phase: 'pre',
      details: { passwordField: true },
    });

    const post = await phaseOf(
      typeAction(
        () =>
          fakeOps({
            probe: { password: true },
            ax: null,
            fail: { 'Input.insertText': new Error('Target closed') },
          }).ops,
        'e2',
        'pw',
      ),
    );
    expect(post).toMatchObject({ phase: 'post', details: { passwordField: true } });
  });

  test('focus that did not land on the target fails pre and never inserts text', async () => {
    for (const focus of [
      { result: { value: { focused: false } } },
      { exceptionDetails: { text: 'x' } },
    ]) {
      const { ops, sent } = fakeOps({ focus, ax: null });
      const result = await phaseOf(typeAction(() => ops, 'e2', 'secret'));
      expect(result).toMatchObject({ code: 'BROWSER_REF_STALE', phase: 'pre' });
      expect(sent).not.toContain('Input.insertText');
    }
  });

  test('focus call errors are pre; empty text dispatches nothing', async () => {
    expect(
      await phaseOf(typeAction(() => fakeOps({ fail: { focus: boom }, ax: null }).ops, 'e2', 'x')),
    ).toMatchObject({
      phase: 'pre',
    });
    const { ops, sent } = fakeOps({ ax: null });
    await typeAction(() => ops, 'e2', '');
    expect(sent).not.toContain('Input.insertText');
  });
});

describe('browser press / scroll / back phases (W1)', () => {
  test('press: unknown key and settle are pre; either key event failing is post', async () => {
    expect(await phaseOf(pressAction(() => fakeOps().ops, 'F13'))).toMatchObject({
      code: 'INVALID_INPUT',
      phase: 'pre',
    });
    expect(
      await phaseOf(pressAction(() => fakeOps({ fail: { 'settle#1': boom } }).ops, 'Enter')),
    ).toMatchObject({
      phase: 'pre',
    });
    for (const at of ['Input.dispatchKeyEvent#1', 'Input.dispatchKeyEvent#2', 'settle#2']) {
      expect(
        await phaseOf(pressAction(() => fakeOps({ fail: { [at]: boom } }).ops, 'Enter')),
      ).toMatchObject({
        phase: 'post',
      });
    }
  });

  test('scroll: settle pre, wheel event post', async () => {
    expect(
      await phaseOf(scrollAction(() => fakeOps({ fail: { settle: boom } }).ops, 'down', 600)),
    ).toMatchObject({
      phase: 'pre',
    });
    expect(
      await phaseOf(
        scrollAction(
          () => fakeOps({ fail: { 'Input.dispatchMouseEvent': boom } }).ops,
          'down',
          600,
        ),
      ),
    ).toMatchObject({ phase: 'post' });
  });

  test('back: no history is pre; goBack and the settle after it are post', async () => {
    expect(await phaseOf(backAction(() => fakeOps({ canGoBack: false }).ops))).toMatchObject({
      code: 'INVALID_INPUT',
      phase: 'pre',
    });
    for (const at of ['goBack', 'settle#2']) {
      expect(await phaseOf(backAction(() => fakeOps({ fail: { [at]: boom } }).ops))).toMatchObject({
        phase: 'post',
      });
    }
  });
});

describe('AX state digest (W1 no-progress)', () => {
  const node = (id: number, extra: Partial<AxtreeNode>): AxtreeNode => ({
    nodeId: String(id),
    backendDOMNodeId: id,
    role: { value: 'spinbutton' },
    ...extra,
  });

  test('changes with value / checked state of listed elements only, and never contains values', () => {
    const ids = new Set([1, 2]);
    const a = axStateDigest([node(1, { value: { value: 1 } }), node(2, {})], ids);
    const b = axStateDigest([node(1, { value: { value: 2 } }), node(2, {})], ids);
    const c = axStateDigest(
      [
        node(1, { value: { value: 1 } }),
        node(2, { properties: [{ name: 'checked', value: { value: 'true' } }] }),
      ],
      ids,
    );
    const d = axStateDigest(
      [node(1, { value: { value: 1 } }), node(2, {}), node(3, { value: { value: 'x' } })],
      ids,
    );
    expect(new Set([a, b, c]).size).toBe(3);
    expect(d).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

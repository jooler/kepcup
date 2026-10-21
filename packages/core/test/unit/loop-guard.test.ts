import { describe, expect, it } from 'vitest';
import {
  LoopGuard,
  callSignature,
  canonicalArgs,
} from '../../src/agent/loop-guard.js';

/** D93 P2：空转检测纯逻辑（同工具 + 同参数 + 同结果）。 */

const result = { ok: true, content: 'same output' };

describe('LoopGuard', () => {
  it('warns at the warn threshold and blocks after the stop threshold', () => {
    const guard = new LoopGuard({ warnAfter: 3, stopAfter: 6, windowCalls: 12 });
    const records = [];
    for (let index = 0; index < 6; index += 1) {
      expect(guard.check('read', { path: 'a.txt' })).toEqual({ block: false, fatal: false });
      records.push(guard.record('read', { path: 'a.txt' }, result));
    }
    expect(records.map((record) => record.warn)).toEqual([false, false, true, false, false, false]);
    expect(records.at(-1)?.count).toBe(6);
    expect(guard.check('read', { path: 'a.txt' })).toEqual({ block: true, fatal: false });
    // 被阻止后仍重复一次 → 任务中止。
    expect(guard.check('read', { path: 'a.txt' })).toEqual({ block: true, fatal: true });
  });

  it('does not count different arguments or different results', () => {
    const guard = new LoopGuard({ warnAfter: 2, stopAfter: 3, windowCalls: 10 });
    guard.record('read', { path: 'a.txt' }, result);
    guard.record('read', { path: 'b.txt' }, result);
    expect(guard.record('read', { path: 'a.txt' }, { ok: true, content: 'changed' }).warn).toBe(
      false,
    );
    expect(guard.check('read', { path: 'a.txt' })).toEqual({ block: false, fatal: false });
  });

  it('resets on steer and drops calls outside the window', () => {
    const guard = new LoopGuard({ warnAfter: 2, stopAfter: 3, windowCalls: 4 });
    guard.record('read', { path: 'a.txt' }, result);
    guard.record('read', { path: 'a.txt' }, result);
    expect(guard.size).toBe(2);
    guard.reset();
    expect(guard.size).toBe(0);
    expect(guard.check('read', { path: 'a.txt' })).toEqual({ block: false, fatal: false });

    for (let index = 0; index < 3; index += 1) {
      guard.record('read', { path: 'a.txt' }, result);
    }
    for (let index = 0; index < 3; index += 1) {
      guard.record('read', { path: `other-${index}.txt` }, result);
    }
    expect(guard.size).toBe(4);
    expect(guard.check('read', { path: 'a.txt' })).toEqual({ block: false, fatal: false });
  });
});

describe('canonical args', () => {
  it('is stable across key order', () => {
    expect(canonicalArgs({ b: 2, a: 1 })).toBe(canonicalArgs({ a: 1, b: 2 }));
    expect(callSignature('read', { b: 2, a: 1 })).toBe(callSignature('read', { a: 1, b: 2 }));
    expect(callSignature('read', { a: 1 })).not.toBe(callSignature('write', { a: 1 }));
  });
});

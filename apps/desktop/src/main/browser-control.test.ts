import { AppError, BROWSER_USER_CONTROL_IDLE_MS } from '@kepcup/shared';
import { describe, expect, test } from 'vitest';
import {
  ControlLease,
  DEFAULT_VIEWER_LABELS,
  HANDBACK_TITLE_PREFIX,
  classifyKeyInput,
  classifyMouseInput,
  parseProfileKey,
  parseViewerLabels,
  partitionDirName,
  viewerToolbarHtml,
  type HandbackReason,
  type LeaseTimers,
  type PageControl,
} from './browser-control.js';

/** Manual clock: `advance` fires due timers in order. */
function fakeTimers(): LeaseTimers & { advance(ms: number): void; pending(): number } {
  let now = 1_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function lease(idleMs = 1_000) {
  const timers = fakeTimers();
  const changes: Array<[PageControl, HandbackReason | null]> = [];
  const value = new ControlLease({
    idleMs,
    timers,
    onChange: (control, reason) => changes.push([control, reason]),
  });
  return { lease: value, timers, changes };
}

describe('W8 ControlLease (自动接管租约)', () => {
  test('starts with the bot; a click / key takes over once', () => {
    const { lease: l, changes } = lease();
    expect(l.control).toBe('agent');
    expect(() => l.assertAgent()).not.toThrow();
    expect(l.userInput('takeover')).toBe(true);
    expect(l.control).toBe('user');
    expect(l.userInput('takeover')).toBe(false);
    expect(changes).toEqual([['user', null]]);
  });

  test('activity (move / wheel) never takes over', () => {
    const { lease: l, changes } = lease();
    expect(l.userInput('activity')).toBe(false);
    expect(l.control).toBe('agent');
    expect(changes).toEqual([]);
  });

  test('while the user has the page the bot gets BROWSER_USER_CONTROL with phase pre', () => {
    const { lease: l } = lease();
    l.userInput('takeover');
    let caught: unknown;
    try {
      l.assertAgent();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('BROWSER_USER_CONTROL');
    expect((caught as AppError).details).toMatchObject({ phase: 'pre' });
  });

  test('handBack reports the reason once; a second handback is a no-op', () => {
    const { lease: l, changes, timers } = lease();
    l.userInput('takeover');
    expect(l.handBack('button')).toBe(true);
    expect(l.control).toBe('agent');
    expect(l.handBack('viewer_closed')).toBe(false);
    expect(changes).toEqual([
      ['user', null],
      ['agent', 'button'],
    ]);
    expect(timers.pending()).toBe(0);
  });

  test('idle timeout hands back after the idle window; any input while under user control extends it', () => {
    const { lease: l, changes, timers } = lease(1_000);
    l.userInput('takeover');
    timers.advance(600);
    l.userInput('activity'); // mouse move keeps the lease
    timers.advance(600);
    expect(l.control).toBe('user');
    timers.advance(399);
    expect(l.control).toBe('user');
    timers.advance(1);
    expect(l.control).toBe('agent');
    expect(changes.at(-1)).toEqual(['agent', 'idle']);
  });

  test('the default idle window is BROWSER_USER_CONTROL_IDLE_MS (10 minutes)', () => {
    expect(BROWSER_USER_CONTROL_IDLE_MS).toBe(600_000);
    const timers = fakeTimers();
    const l = new ControlLease({ timers, onChange: () => {} });
    l.userInput('takeover');
    timers.advance(BROWSER_USER_CONTROL_IDLE_MS - 1);
    expect(l.control).toBe('user');
    timers.advance(1);
    expect(l.control).toBe('agent');
  });

  test('input during a bot-synthesized dispatch is not attributed to the user', async () => {
    const { lease: l, changes } = lease();
    let tookOver: boolean | null = null;
    await l.withBotInput(async () => {
      tookOver = l.userInput('takeover');
    });
    expect(tookOver).toBe(false);
    expect(l.control).toBe('agent');
    expect(l.userInput('takeover')).toBe(true);
    expect(changes).toEqual([['user', null]]);
  });

  test('dispose: no timer, no callbacks, handBack is a no-op', () => {
    const { lease: l, changes, timers } = lease();
    l.userInput('takeover');
    l.dispose();
    expect(timers.pending()).toBe(0);
    expect(l.handBack('viewer_closed')).toBe(false);
    expect(l.userInput('takeover')).toBe(false);
    timers.advance(10_000);
    expect(changes).toEqual([['user', null]]);
  });
});

describe('W8 input classification', () => {
  test('keys: key down takes over (not a lone modifier); key up is activity', () => {
    expect(classifyKeyInput({ type: 'keyDown', key: 'a' })).toBe('takeover');
    expect(classifyKeyInput({ type: 'rawKeyDown', key: 'Enter' })).toBe('takeover');
    expect(classifyKeyInput({ type: 'keyDown', key: 'Shift' })).toBe('activity');
    expect(classifyKeyInput({ type: 'keyDown', key: 'Meta' })).toBe('activity');
    expect(classifyKeyInput({ type: 'keyUp', key: 'a' })).toBe('activity');
  });

  test('keys: unmodified navigation keys and copy only count as activity', () => {
    for (const key of [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Home',
      'End',
    ]) {
      expect(classifyKeyInput({ type: 'keyDown', key }), key).toBe('activity');
      expect(classifyKeyInput({ type: 'rawKeyDown', key, shift: true }), `shift+${key}`).toBe(
        'takeover',
      );
    }
    expect(classifyKeyInput({ type: 'keyDown', key: 'c', control: true })).toBe('activity');
    expect(classifyKeyInput({ type: 'keyDown', key: 'c', meta: true })).toBe('activity');
    expect(classifyKeyInput({ type: 'keyDown', key: 'C', control: true, shift: true })).toBe(
      'activity',
    );
    expect(classifyKeyInput({ type: 'keyDown', key: 'c' })).toBe('takeover');
    expect(classifyKeyInput({ type: 'keyDown', key: 'v', control: true })).toBe('takeover');
    expect(classifyKeyInput({ type: 'keyDown', key: 'Enter' })).toBe('takeover');
    expect(classifyKeyInput({ type: 'keyDown', key: 'Tab' })).toBe('takeover');
  });

  test('mouse: only a button press takes over', () => {
    expect(classifyMouseInput({ type: 'mouseDown' })).toBe('takeover');
    expect(classifyMouseInput({ type: 'contextMenu' })).toBe('takeover');
    expect(classifyMouseInput({ type: 'mouseMove' })).toBe('activity');
    expect(classifyMouseInput({ type: 'mouseWheel' })).toBe('activity');
    expect(classifyMouseInput({ type: 'mouseUp' })).toBe('activity');
    expect(classifyMouseInput({ type: 'mouseEnter' })).toBeNull();
    expect(classifyMouseInput({ type: 'mouseLeave' })).toBeNull();
  });
});

describe('W8 profile key → partition', () => {
  test('private and shared profiles map to their partitions', () => {
    expect(parseProfileKey('bot:bot_01ABC')).toEqual({
      kind: 'bot',
      id: 'bot_01ABC',
      partition: 'persist:bot-bot_01ABC',
    });
    expect(parseProfileKey('shared:bpf_01XYZ')).toEqual({
      kind: 'shared',
      id: 'bpf_01XYZ',
      partition: 'persist:shared-bpf_01XYZ',
    });
  });

  test('malformed keys are refused (never a path or another partition)', () => {
    for (const key of [
      '',
      'bot:',
      'team:x',
      'shared:../x',
      'bot:a b',
      'shared:a/b',
      `bot:${'x'.repeat(65)}`,
    ]) {
      expect(() => parseProfileKey(key)).toThrow(AppError);
    }
  });

  test('the on-disk directory is the lower-cased partition name', () => {
    expect(partitionDirName('persist:bot-bot_01ABC')).toBe('bot-bot_01abc');
    expect(partitionDirName('persist:shared-bpf_01XYZ')).toBe('shared-bpf_01xyz');
  });
});

describe('W8 viewer toolbar', () => {
  test('labels from the renderer are validated per field', () => {
    expect(parseViewerLabels(undefined)).toEqual(DEFAULT_VIEWER_LABELS);
    expect(parseViewerLabels({ agent: 'A', user: 42, handback: '' })).toEqual({
      agent: 'A',
      user: DEFAULT_VIEWER_LABELS.user,
      handback: DEFAULT_VIEWER_LABELS.handback,
    });
  });

  test('labels are embedded as escaped JSON (no markup injection) with the control state', () => {
    const html = viewerToolbarHtml(
      {
        agent: '</script><img src=x onerror=alert(1)>',
        user: '你正在操作',
        handback: '交还给 Bot',
      },
      'user',
    );
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain('"control":"user"');
    expect(html).toContain(HANDBACK_TITLE_PREFIX);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 应用状态提示（app.notice）：同 key 的提示互相替换、dismiss 撤掉、按钮跳转到对应
 * 页面；它只弹 toast，不碰对话消息。
 */

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler>();
const toasts: Array<{ kind: string; message: string; options: Record<string, unknown> }> = [];
const dismissed: string[] = [];
const opened: string[] = [];

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => undefined;
    },
  },
}));
vi.mock('svelte-sonner', () => {
  const push = (kind: string) => (message: string, options: Record<string, unknown>) =>
    toasts.push({ kind, message, options });
  return {
    toast: {
      error: push('error'),
      warning: push('warning'),
      info: push('info'),
      dismiss: (id: string) => dismissed.push(id),
    },
  };
});
vi.mock('$lib/stores/shell.svelte', () => ({
  shell: {
    openExtensionCenter: (tab: string) => opened.push(`extension:${tab}`),
    openSchedules: () => opened.push('schedules'),
  },
}));
vi.mock('$lib/i18n', () => ({ t: (key: string) => key }));

import { appNotices } from './app-notices.svelte';

function emit(payload: unknown): void {
  handlers.get('app.notice')!(payload);
}

describe('appNotices', () => {
  beforeEach(() => {
    toasts.length = 0;
    dismissed.length = 0;
    opened.length = 0;
    appNotices.start();
  });

  it('shows a toast per level, keyed so a repeat replaces the previous one', () => {
    emit({ key: 'mail-conn:a', level: 'warning', text: '连接中断' });
    emit({ key: 'mail-conn:a', level: 'error', text: '登录被拒' });
    expect(toasts.map((entry) => [entry.kind, entry.message, entry.options.id])).toEqual([
      ['warning', '连接中断', 'mail-conn:a'],
      ['error', '登录被拒', 'mail-conn:a'],
    ]);
  });

  it('dismisses the toast with the same key', () => {
    emit({ key: 'mail-conn:a', level: 'info', text: '', dismiss: true });
    expect(dismissed).toEqual(['mail-conn:a']);
    expect(toasts).toEqual([]);
  });

  it('wires the action button to the matching page', () => {
    emit({ key: 'k1', level: 'warning', text: 'x', action: 'open_mail_settings' });
    emit({ key: 'k2', level: 'warning', text: 'y', action: 'open_schedules' });
    for (const entry of toasts) {
      (entry.options.action as { onClick: () => void }).onClick();
    }
    expect(opened).toEqual(['extension:mail', 'schedules']);
  });

  it('shows no button when the notice has no action', () => {
    emit({ key: 'k', level: 'info', text: 'z' });
    expect(toasts[0]?.options.action).toBeUndefined();
  });
});

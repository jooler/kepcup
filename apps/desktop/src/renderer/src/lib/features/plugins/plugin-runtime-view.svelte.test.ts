import { describe, expect, it } from 'vitest';
import type { PluginRuntimePluginState } from '@kepcup/shared';
import {
  activityEmpty,
  activityRows,
  formatDuration,
  RUNTIME_MESSAGE_MAX_CHARS,
  runtimeBadge,
  truncateMessage,
} from './plugin-runtime-view';
import { t } from '$lib/i18n';
import { zhCN } from '$lib/i18n/locales/zh-CN';

/**
 * D125 P3 展示口径（61 §6）：状态徽标五值、活动抽屉行（结果三态 / 错误人话 /
 * 200 字截断）、非执行型插件零渲染（runtimeBadge(null) === null）。
 */

function state(overrides: Partial<PluginRuntimePluginState> = {}): PluginRuntimePluginState {
  return {
    pluginId: 'io.test/runtime',
    status: 'ready',
    detail: null,
    lastError: null,
    recent: [],
    ...overrides,
  };
}

describe('插件状态徽标（D125 P3）', () => {
  it('非执行型插件 / 快照未到：null（组件不渲染任何 DOM，零变化）', () => {
    expect(runtimeBadge(null)).toBeNull();
  });

  it('五值映射：stopped 灰 / starting 黄脉冲 / ready 绿 / busy 绿运行中 / error 红', () => {
    expect(runtimeBadge(state({ status: 'stopped' }))).toMatchObject({
      labelKey: 'plugins.runtime.status.stopped',
      pulse: false,
    });
    expect(runtimeBadge(state({ status: 'starting' }))).toMatchObject({
      labelKey: 'plugins.runtime.status.starting',
      pulse: true,
      dotClass: 'bg-amber-500',
    });
    expect(runtimeBadge(state({ status: 'ready' }))).toMatchObject({
      labelKey: 'plugins.runtime.status.ready',
      pulse: false,
      dotClass: 'bg-emerald-500',
    });
    expect(runtimeBadge(state({ status: 'busy' }))).toMatchObject({
      labelKey: 'plugins.runtime.status.busy',
      pulse: false,
    });
    expect(runtimeBadge(state({ status: 'error' }))).toMatchObject({
      labelKey: 'plugins.runtime.status.error',
      dotClass: 'bg-destructive',
    });
  });

  it('error 徽标 tooltip 用最近错误（lastError 优先于 detail）', () => {
    expect(
      runtimeBadge(state({ status: 'error', detail: '进程退出', lastError: '最近错误' }))?.tooltip,
    ).toBe('最近错误');
    expect(runtimeBadge(state({ status: 'ready', detail: '空闲回收' }))?.tooltip).toBe('空闲回收');
  });
});

describe('插件活动抽屉行（D125 P3）', () => {
  it('空态：执行型插件但尚无调用', () => {
    expect(activityEmpty(state())).toBe(true);
    expect(activityRows(state(), 'zh-CN')).toEqual([]);
    expect(activityEmpty(null)).toBe(false);
  });

  it('成功 / 失败 / 取消三态；PLUGIN_* 错误码走既有 errorText 人话，插件消息作次级说明', () => {
    const rows = activityRows(
      state({
        recent: [
          {
            at: 1_700_000_000_000,
            contract: 'media',
            method: 'generateImage',
            durationMs: 1234,
            ok: true,
            errorCode: null,
            message: null,
          },
          {
            at: 1_700_000_001_000,
            contract: 'media',
            method: 'submitVideo',
            durationMs: 900_000,
            ok: false,
            errorCode: 'PLUGIN_TIMEOUT',
            message: '插件 即梦 无响应，本次调用已终止',
          },
          {
            at: 1_700_000_002_000,
            contract: 'media',
            method: 'videoStatus',
            durationMs: 12,
            ok: false,
            errorCode: 'CANCELLED',
            message: '调用已取消',
          },
        ],
      }),
      'zh-CN',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      call: 'media.generateImage',
      outcome: 'ok',
      outcomeKey: 'plugins.runtime.result.ok',
      error: '',
      detail: '',
    });
    expect(rows[1]).toMatchObject({
      call: 'media.submitVideo',
      outcome: 'failed',
      outcomeKey: 'plugins.runtime.result.failed',
      error: t('chats.errorCode.PLUGIN_TIMEOUT'),
      detail: '插件 即梦 无响应，本次调用已终止',
      tooltip: '插件 即梦 无响应，本次调用已终止',
    });
    expect(rows[2]).toMatchObject({
      call: 'media.videoStatus',
      outcome: 'cancelled',
      outcomeKey: 'plugins.runtime.result.cancelled',
      error: '',
      detail: '',
    });
    expect(rows[1]?.duration).toBe('15m 0s');
  });

  it('插件 error.message 默认透传为次级说明（截断 200 字）；未登记错误码回原始消息', () => {
    const long = 'x'.repeat(300);
    const [mapped] = activityRows(
      state({
        recent: [
          {
            at: 1,
            contract: 'media',
            method: 'generateImage',
            durationMs: 5,
            ok: false,
            errorCode: 'PLUGIN_CRASHED',
            message: long,
          },
        ],
      }),
      'zh-CN',
    );
    // 已登记错误码：人话做主文案，插件 message 作次级说明并截断 200 字。
    expect(mapped?.error).toBe(t('chats.errorCode.PLUGIN_CRASHED'));
    expect(mapped?.detail).toBe(truncateMessage(long));
    expect(mapped?.detail).toHaveLength(RUNTIME_MESSAGE_MAX_CHARS + 1);
    expect(mapped?.detail.endsWith('…')).toBe(true);
    expect(mapped?.tooltip).toBe(long);

    const [unknown] = activityRows(
      state({
        recent: [
          {
            at: 1,
            contract: 'media',
            method: 'generateImage',
            durationMs: 5,
            ok: false,
            errorCode: 'SOME_UNKNOWN_CODE',
            message: '插件自己的错误说明',
          },
        ],
      }),
      'zh-CN',
    );
    expect(unknown?.error).toBe('插件自己的错误说明');
    expect(unknown?.detail).toBe('');
  });

  it('时长格式化：毫秒 / 秒 / 分秒', () => {
    expect(formatDuration(12)).toBe('12 ms');
    expect(formatDuration(1234)).toBe('1.2 s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });

  it('四个 PLUGIN_* 错误码的中文文案（61 §6 原文）', () => {
    expect(zhCN['chats.errorCode.PLUGIN_CRASHED']).toBe('插件已崩溃，正在自动重启');
    expect(zhCN['chats.errorCode.PLUGIN_TIMEOUT']).toBe('插件响应超时');
    expect(zhCN['chats.errorCode.PLUGIN_CONTRACT_VIOLATION']).toBe('插件返回了无效数据');
    expect(zhCN['chats.errorCode.PLUGIN_NETWORK_DENIED']).toBe('插件尝试访问未授权的网络地址');
  });

  it('活动行里 PLUGIN_* 走补集人话；PROVIDER_QUOTA / PROVIDER_AUTH_FAILED 沿用既有文案', () => {
    const codes = [
      'PLUGIN_CRASHED',
      'PLUGIN_TIMEOUT',
      'PLUGIN_CONTRACT_VIOLATION',
      'PLUGIN_NETWORK_DENIED',
      'PROVIDER_QUOTA',
      'PROVIDER_AUTH_FAILED',
    ] as const;
    const rows = activityRows(
      state({
        recent: codes.map((code, index) => ({
          at: index,
          contract: 'media',
          method: 'generateImage',
          durationMs: 1,
          ok: false,
          errorCode: code,
          message: `插件原始消息 ${code}`,
        })),
      }),
      'zh-CN',
    );
    expect(rows.map((row) => row.error)).toEqual(codes.map((code) => zhCN[`chats.errorCode.${code}`]));
    // 插件消息仍作为次级说明透传（不与主文案重复）。
    expect(rows.every((row) => row.detail.startsWith('插件原始消息 '))).toBe(true);
  });
});

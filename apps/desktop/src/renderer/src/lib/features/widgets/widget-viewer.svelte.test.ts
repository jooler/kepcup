import { widgetCardSchema, type WidgetCard } from '@kepcup/shared';
import { describe, expect, test } from 'vitest';
import { widgetViewer, widgetWindowHandoffPayload } from './widget-viewer.svelte';

/**
 * 「在新窗口打开」的 IPC 载荷回归（widget-window.md §5）：
 * `widgetViewer.current` 是 `$state` 深代理，Electron IPC 的结构化克隆（V8 序列化器）
 * 克隆不了 Proxy——直传在 `invoke` 边界抛 `DataCloneError`，表现是按钮一按即弹
 * 「未能打开组件窗口」、窗口不创建（2026-11-05 实测）。载荷必须经
 * `widgetWindowHandoffPayload`（`$state.snapshot`）拍成纯对象。这里用
 * `structuredClone`（与 Electron IPC 同一款 V8 序列化器）模拟序列化边界。
 */

const card: WidgetCard = {
  widgetId: 'w-1',
  version: 3,
  title: '晨间简报',
  description: '',
  scope: 'bot',
  sha256: 'a'.repeat(64),
  queriesSha256: '',
  queriesCount: 0,
  sizeBytes: 1024,
  botId: null,
  createdAt: 1_700_000_000_000,
  checkStatus: 'legacy',
  knownIssues: [],
};

/** 与 Electron IPC 同款序列化边界：能不能被结构化克隆。 */
function canCrossIpcSerialization(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

describe('widget window handoff payload', () => {
  test('$state 深代理直传过不了结构化克隆；snapshot 载荷可过且原样', () => {
    widgetViewer.show('m-1', card, 'c-1');
    const current = widgetViewer.current;
    expect(current).not.toBeNull();
    // 机制护栏：读取 current.card 得到的是响应式 Proxy，V8 序列化器拒绝克隆。
    // 若这条哪天变绿（Svelte/序列化器行为变化），直传也安全，可回退 snapshot。
    expect(canCrossIpcSerialization(current!.card)).toBe(false);

    const payload = widgetWindowHandoffPayload(current!);
    expect(canCrossIpcSerialization(payload)).toBe(true);
    expect(payload.messageId).toBe('m-1');
    expect(payload.card).toEqual(card);
    // 主进程还会按 shared 契约重验（widget-window.ts parseOpenWidgetInput）。
    expect(widgetCardSchema.safeParse(payload.card).success).toBe(true);
    widgetViewer.close();
  });
});

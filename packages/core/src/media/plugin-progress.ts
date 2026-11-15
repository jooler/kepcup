import type { PluginRuntimeProgressPayload } from '@kepcup/shared';

/**
 * 插件进度帧 → 工具状态行文案（D125 P3，61 §6）。
 *
 * `host.progress({phase, percent, message})` 由插件给出阶段词；宿主限速透传后在这里
 * 收成一行人类可读文本（对话内状态行 D55 / 任务详情页 D93 共用同一渲染）：
 * - 有 `message` 用 message（插件自己的阶段文案，如「排队中」「生成中」）；
 * - 追加 `percent`（取整），如「生成中 42%」；
 * - 只有 `phase` 时用 phase 原样（宿主不做枚举约束，61 §4）；
 * - 三者皆空 → 空串（调用方跳过，不覆盖状态行）。
 *
 * 宿主侧不做文案改写：插件是阶段语义的唯一来源（61 §6「阶段文案由插件给出」）。
 */
export function formatPluginProgress(payload: PluginRuntimeProgressPayload): string {
  const message = payload.message?.trim() ?? '';
  const phase = payload.phase?.trim() ?? '';
  const base = message.length > 0 ? message : phase;
  const percent = payload.percent;
  if (percent !== undefined && Number.isFinite(percent)) {
    const rounded = Math.round(percent);
    return base.length > 0 ? `${base} ${rounded}%` : `${rounded}%`;
  }
  return base;
}

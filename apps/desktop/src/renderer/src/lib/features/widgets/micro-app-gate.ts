import type { WidgetCard } from '@kepcup/shared';
import { microAppConsents } from './micro-app-consent.svelte';

/**
 * 微应用运行门控的纯判定（D112 §5.2 / Q8）：从 `WidgetRuntime` 抽出来是为了可单测——
 * 「卡片门控可能基于过期指纹」的兜底链路（pre-open 检查 + open 后对生效指纹再核）
 * 是防能力面静默扩大的唯一运行期防线。
 */

/**
 * 挂载前的门控（海报卡确认之外的防御层）：微应用只要**存在**该微应用的确认记录即放行
 * 到 open——不能比对卡片冻结的指纹（确认记录存的是生效版本的指纹，双指针前移后两者
 * 会不一致，比对会把扩权更新后的旧卡变成打不开的死胡同）。真正的能力面执法在 open
 * 之后对生效指纹的复核（`microAppEffectiveConsentOk`）：未确认的面貌会在那里被拒绝，
 * 卡片回到确认流程。卡片无指纹（损坏 / 旧结构）按未确认处理（fail closed）。
 */
export function microAppOpenAllowed(card: WidgetCard): boolean {
  if (card.capabilityFingerprint === undefined || card.capabilityFingerprint === '') return false;
  return microAppConsents.recordOf(card.widgetId) !== undefined;
}

/**
 * open 之后的兜底复核：生效版本（可能比卡片新）的指纹必须也被确认覆盖。
 * 能力面已扩大（新增能力 / 放宽网络 / 扩大域名）→ false → 关资源、回审查态。
 */
export function microAppEffectiveConsentOk(widgetId: string, effectiveFingerprint: string): boolean {
  if (effectiveFingerprint === '') return false;
  return microAppConsents.consented(widgetId, effectiveFingerprint).ok;
}

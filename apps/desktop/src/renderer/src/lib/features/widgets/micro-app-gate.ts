import type { WidgetCard } from '@kepcup/shared';
import { microAppConsents } from './micro-app-consent.svelte';

/**
 * 微应用运行门控的纯判定（D112 §5.2 / Q8）：从 `WidgetRuntime` 抽出来是为了可单测——
 * 「卡片门控可能基于过期指纹」的兜底链路（pre-open 检查 + open 后对生效指纹再核）
 * 是防能力面静默扩大的唯一运行期防线。
 */

/**
 * 挂载前的门控（海报卡确认之外的防御层）：微应用按卡片自带指纹查确认记录——
 * 卡片无指纹（损坏 / 旧结构）按未确认处理（fail closed）。
 */
export function microAppOpenAllowed(card: WidgetCard): boolean {
  if (card.capabilityFingerprint === undefined || card.capabilityFingerprint === '') return false;
  return microAppConsents.consented(card.widgetId, card.capabilityFingerprint).ok;
}

/**
 * open 之后的兜底复核：生效版本（可能比卡片新）的指纹必须也被确认覆盖。
 * 能力面已扩大（新增能力 / 放宽网络 / 扩大域名）→ false → 关资源、回审查态。
 */
export function microAppEffectiveConsentOk(widgetId: string, effectiveFingerprint: string): boolean {
  if (effectiveFingerprint === '') return false;
  return microAppConsents.consented(widgetId, effectiveFingerprint).ok;
}

import type { MessageKey } from '$lib/i18n';
import { CAPABILITY_SETTING_IDS, type SetupRequirement } from '@kepcup/shared';

/** 别名卡的兜底文案键（调用方传 `t`，保持本模块无 UI 依赖、可单测）。 */
export type SetupAliasText = (key: MessageKey) => string;

/**
 * 旧 kind → 通用设置项的兼容别名（P2 收拢，todo/conversational-settings-p2.md
 * 任务 1）：`capability-model` / `web-search` / `mail-account` 的失败续跑卡改由
 * `SettingSetupBody` → `SettingCardEmbed` 按目录条目渲染。`setupRequirementSchema`
 * 里旧 kind 原样保留（库与测试仍有旧值，core 产生路径不变），只在渲染层读到后
 * 转成已存在的 `kind:'setting'`。映射不出来的 kind（`main-model` / `agent` /
 * `connect-app` / `confirm-local-connector`，字段比目录条目多或行为特殊）返回
 * null，由 `SetupRequiredCard` 各自的分支渲染。
 */
export function setupAliasOf(
  requirement: SetupRequirement,
  text: SetupAliasText,
): Extract<SetupRequirement, { kind: 'setting' }> | null {
  switch (requirement.kind) {
    case 'capability-model':
      return {
        kind: 'setting',
        itemId: CAPABILITY_SETTING_IDS[requirement.capability],
        reason: text('setupCard.capabilityHint'),
      };
    case 'web-search':
      return {
        kind: 'setting',
        itemId: 'search.provider',
        reason: text('setupCard.webSearchHint'),
      };
    case 'mail-account':
      return {
        kind: 'setting',
        itemId: 'mail.account',
        // 厂商预填（qq / gmail / …）映到目录字段 `provider`；用户仍可改选。
        ...(requirement.provider !== undefined ? { prefill: { provider: requirement.provider } } : {}),
        reason:
          requirement.reason !== undefined && requirement.reason.trim().length > 0
            ? requirement.reason
            : text('setupCard.mailAccountHint'),
      };
    default:
      return null;
  }
}

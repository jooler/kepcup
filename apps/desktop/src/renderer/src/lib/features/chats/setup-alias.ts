import type { MessageKey } from '$lib/i18n';
import { CAPABILITY_SETTING_IDS, type SetupRequirement } from '@kepcup/shared';

/** 别名卡的兜底文案键（调用方传 `t`，保持本模块无 UI 依赖、可单测）。 */
export type SetupAliasText = (key: MessageKey) => string;

/**
 * 旧 kind → 通用设置项的兼容别名（P2 收拢，todo/conversational-settings-p2.md
 * 任务 1）：`capability-model` / `web-search` / `mail-account` 的失败续跑卡改由
 * `SettingSetupBody` → `SettingCardEmbed` 按目录条目渲染。`setupRequirementSchema`
 * 里旧 kind 原样保留（库与测试仍有旧值，core 产生路径不变），只在渲染层读到后
 * 转成已存在的 `kind:'setting'`。
 *
 * `agent` / `connect-app` 不在这里映射：载荷里比目录条目多的字段（`agentId` /
 * `reason` / `detail`；`target` / `connectionId` / `scopes`）与随附行为（Agent 的
 * 自动续跑基线与实验开关、连接的自定义目标 / 重连 / scope 并集 / 已在别处连好的
 * 一键继续）表达不进通用分发，压平会改掉已验收行为——它们原样交给
 * `SettingSetupBody` 的别名分支（各自的 `*SetupBody` 消费，设计篇 38 §5.3）。
 * `main-model`（两段式，不是单条目录条目）与 `confirm-local-connector`（不是设置
 * 目录条目）同样保留独立 kind，由 `SettingSetupBody` 分发到各自的独立 body。
 * `setting` kind 直通返回（同一个出口分发）。
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
        // P3：无厂商预填——卡上列已安装的邮件插件，表单由插件实例字段构建。
        reason:
          requirement.reason !== undefined && requirement.reason.trim().length > 0
            ? requirement.reason
            : text('setupCard.mailAccountHint'),
      };
    case 'setting':
      // 已是通用 kind：直通（SettingSetupBody 用同一个出口分发）。
      return requirement;
    default:
      return null;
  }
}

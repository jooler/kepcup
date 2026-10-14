import type { AgentView, CardKey, SettingItem, SettingValues } from '@kepcup/shared';
import { capabilityOfItem, prefillString, sensorOfItem } from './setting-card-model';

/**
 * 渲染层 `CardKey → Svelte 组件` 映射（todo/conversational-app-setup.md §4.1 / §4.3 测试二）。
 * 组件本身在 `SettingCardEmbed.svelte` 里按键分发（各组件 props 不同，逐键写参数）；这里登记
 * 「键 → 组件名」，单测用 shared 的 `cardComponentProblems` 核对每个非空 `card` 都有组件，
 * 并核对 `SettingCardEmbed.svelte` 确实引入了这些组件。
 */
export const SETTING_CARD_COMPONENTS = {
  'default-models': 'DefaultModelsCard',
  'provider-setup': 'ProviderSetupForm',
  'capability-model': 'CapabilityModelSection',
  'web-search': 'WebSearchSection',
  'connect-app': 'ConnectAppPanel',
  'mail-account': 'MailAccountAddForm',
  agent: 'AgentCard',
  'bot-model': 'BotModelCard',
  'bot-config': 'BotConfigCard',
  'bot-skills': 'BotSkillsCard',
  sensor: 'SensorCard',
  'field-editor': 'FieldEditorCard',
  embedding: 'EmbeddingSection',
  appearance: 'AppearanceSection',
  'background-tasks': 'BackgroundTasksSection',
  unattended: 'UnattendedSection',
  'taint-guard': 'UnattendedSection',
} as const satisfies Record<CardKey, string>;

/** 内嵌时需要的上下文（谁的卡、作用对象、可用的外部智能体）。 */
export interface EmbedContext {
  /** bot 范围条目的作用 Bot（卡片 target.botId，缺省为出卡 Bot）。 */
  botId: string | null;
  prefill: SettingValues | null;
  /** 外部智能体目录（未加载为 null）。 */
  agent(id: string): AgentView | null;
  /** 当前默认智能体 id（`settings.defaultAgentId`）。 */
  defaultAgentId: string | null;
}

/**
 * 该条目在当前上下文里能不能内嵌（不能就退回跳转卡）：
 * - `capability-model` / `sensor`：条目 id 能对上能力 / 传感器；
 * - `bot-model` / `mail-account`：要有作用 Bot；
 * - `connect-app`：要知道连哪个应用（预填 `app` = 目录 connectorId）；
 * - `agent`：要知道是哪个智能体（预填 `agent`，否则默认智能体），且目录里有它。
 */
export function cardEmbeddable(item: SettingItem, context: EmbedContext): boolean {
  switch (item.card) {
    case null:
      return false;
    case 'capability-model':
      return capabilityOfItem(item.id) !== null;
    case 'sensor':
      return sensorOfItem(item.id) !== null;
    case 'bot-model':
    case 'bot-config':
    case 'bot-skills':
    case 'mail-account':
      return context.botId !== null;
    case 'field-editor':
    case 'embedding':
    case 'appearance':
    case 'background-tasks':
    case 'unattended':
    case 'taint-guard':
      return true;
    case 'connect-app':
      return prefillString(context.prefill, 'app') !== null;
    case 'agent':
      return embeddedAgentId(context) !== null;
    case 'default-models':
    case 'provider-setup':
    case 'web-search':
      return true;
  }
}

/** agent 卡内嵌哪个智能体：预填 `agent` 优先，其次默认智能体；目录里没有返回 null。 */
export function embeddedAgentId(context: EmbedContext): string | null {
  const id = prefillString(context.prefill, 'agent') ?? context.defaultAgentId;
  if (id === null || id.length === 0) return null;
  return context.agent(id) !== null ? id : null;
}

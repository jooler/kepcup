import { capabilityOfItem, prefillString, sensorOfItem } from '../setting-card-model.js';
import { embeddedAgentId, type SettingCardContribution } from './types.js';

export * from './types.js';

const always: SettingCardContribution['embeddable'] = () => true;

/**
 * `CardKey → 组件名 + 可嵌入判定` 的贡献表（todo/settings-catalog-registry.md §4.3）。
 * 新增卡片：`CARD_KEYS` 加键 → 这里加一条 → `SettingCardEmbed.svelte` 加 import 与分支
 * （`card-components.ts` 从这里派生，不用再改）。条目用到的键必须全部登记
 * （`card-components.test.ts` 与 shared 的 `cardComponentProblems` 双向核对）。
 */
export const SETTING_CARD_CONTRIBUTIONS: readonly SettingCardContribution[] = [
  // --- 模型 ---------------------------------------------------------------
  { key: 'default-models', componentName: 'DefaultModelsCard', embeddable: always },
  { key: 'provider-setup', componentName: 'ProviderSetupForm', embeddable: always },
  {
    key: 'capability-model',
    componentName: 'CapabilityModelSection',
    // 条目 id 能对上能力键（capability.{能力}）。
    embeddable: (item) => capabilityOfItem(item.id) !== null,
  },
  { key: 'web-search', componentName: 'WebSearchSection', embeddable: always },
  { key: 'embedding', componentName: 'EmbeddingSection', embeddable: always },

  // --- 连接 / MCP / 邮件 ---------------------------------------------------
  {
    key: 'connect-app',
    componentName: 'ConnectAppPanel',
    // 要知道连哪个应用（预填 app = 目录 connectorId）。
    embeddable: (_item, ctx) => prefillString(ctx.prefill, 'app') !== null,
  },
  { key: 'mail-account', componentName: 'MailAccountAddForm', embeddable: (_item, ctx) => ctx.botId !== null },
  { key: 'tool-policy', componentName: 'AppConnectionDetail', embeddable: always },
  { key: 'mcp-servers', componentName: 'McpSection', embeddable: always },

  // --- 智能体 / Bot --------------------------------------------------------
  {
    key: 'agent',
    componentName: 'AgentCard',
    // 要知道是哪个智能体（预填 agent，否则默认智能体），且目录里有它。
    embeddable: (_item, ctx) => embeddedAgentId(ctx) !== null,
  },
  { key: 'bot-model', componentName: 'BotModelCard', embeddable: (_item, ctx) => ctx.botId !== null },
  { key: 'bot-config', componentName: 'BotConfigCard', embeddable: (_item, ctx) => ctx.botId !== null },
  { key: 'bot-skills', componentName: 'BotSkillsCard', embeddable: (_item, ctx) => ctx.botId !== null },

  // --- 硬件 ---------------------------------------------------------
  {
    key: 'sensor',
    componentName: 'SensorCard',
    // 硬件条目 → 传感器种类（microphone / camera）。
    embeddable: (item) => sensorOfItem(item.id) !== null,
  },

  // --- 目录字段编辑 --------------------------------------------------------
  { key: 'field-editor', componentName: 'FieldEditorCard', embeddable: always },

  // --- 通用 / 后台 / 无人值守 ----------------------------------------------
  { key: 'appearance', componentName: 'AppearanceSection', embeddable: always },
  { key: 'background-tasks', componentName: 'BackgroundTasksSection', embeddable: always },
  { key: 'unattended', componentName: 'UnattendedSection', embeddable: always },
  { key: 'taint-guard', componentName: 'UnattendedSection', embeddable: always },

  // --- 项目组 ---------------------------------------------------------------
  {
    key: 'project-title',
    componentName: 'ProjectTitleCard',
    embeddable: (_item, ctx) => ctx.conversationId !== null,
  },
  {
    key: 'project-goal',
    componentName: 'ProjectGoalCard',
    embeddable: (_item, ctx) => ctx.conversationId !== null,
  },
  {
    key: 'project-lead',
    componentName: 'ProjectLeadCard',
    embeddable: (_item, ctx) => ctx.conversationId !== null,
  },
  {
    key: 'project-members',
    componentName: 'ProjectMembersCard',
    embeddable: (_item, ctx) => ctx.conversationId !== null,
  },

  // --- 工作目录 / 浏览器 ----------------------------------------------------
  {
    key: 'workdir-settings',
    componentName: 'WorkdirSettingsDialog',
    embeddable: (_item, ctx) => ctx.workdirId !== null,
  },
  { key: 'browser-profiles', componentName: 'BrowserProfilesSection', embeddable: always },

  // --- 环境 -----------------------------------------------------------------
  { key: 'environment-toolchains', componentName: 'EnvironmentSection', embeddable: always },
  { key: 'environment-sandbox', componentName: 'SandboxSection', embeddable: always },
  { key: 'environment-allowlist', componentName: 'AllowlistSection', embeddable: always },
];

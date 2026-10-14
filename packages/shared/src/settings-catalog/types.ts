import { z } from 'zod';

/**
 * 设置目录的条目形态（todo/conversational-app-setup.md §4.1）。纯数据：core 的适配器、
 * 三个 Bot 工具、渲染层的 `SettingCard` 与覆盖率测试都读这一份，不做第二份清单。
 */

/** 分组：`settings_search` 无 query 时按组给就绪概况（§5.2）。 */
export const settingGroupSchema = z.enum([
  'models',
  'search',
  'connections',
  'mcp',
  'mail',
  'agents',
  'bot',
  'skills',
  'schedules',
  'profile',
  'browser',
  'group',
  'project',
  'hardware',
  'general',
  'background',
  'unattended',
  'environment',
  'developer',
  'diagnostics',
]);
export type SettingGroup = z.infer<typeof settingGroupSchema>;

/** 作用范围：全局 / 某个 Bot / 某个群 / 某个项目。 */
export const settingScopeSchema = z.enum(['global', 'bot', 'group', 'project']);
export type SettingScope = z.infer<typeof settingScopeSchema>;

/**
 * 值存在哪一侧：`core` = core 能读写；`renderer` = 只在渲染层 localStorage（主题、语言、
 * 麦克风……），core 读不到也写不了——`settings_read` 报「状态未知（只在本机界面可见）」，
 * 只能出卡，档位最多 confirm（§5.3 第 6 条）。
 */
export const settingOwnerSchema = z.enum(['core', 'renderer']);
export type SettingOwner = z.infer<typeof settingOwnerSchema>;

/**
 * 修改档位（§三）：
 * - `direct`：宿主立即执行 → 回执卡（可撤销）；只允许 `DIRECT_ITEM_IDS` 里的条目；
 * - `confirm`：预填卡，「应用 / 不用了」；
 * - `form`：待填卡，敏感字段由用户自己填，Bot 只能预填非敏感字段；
 * - `user-only`：安全开关卡，Bot 可以出卡但宿主不采用 `values`；
 * - `link`：跳转卡，「在设置中打开」深链到对应锚点。
 *
 * 严格程度按此顺序递增（`SETTING_WRITE_MODE_ORDER`）；宿主裁定只会往后收紧。
 */
export const settingWriteModeSchema = z.enum(['direct', 'confirm', 'form', 'user-only', 'link']);
export type SettingWriteMode = z.infer<typeof settingWriteModeSchema>;
export const SETTING_WRITE_MODE_ORDER: readonly SettingWriteMode[] = settingWriteModeSchema.options;

/** 字段类型。`secret` / `oauth` / `account` 是敏感类型：只能由用户在卡片里填，永不经模型。 */
export const settingFieldTypeSchema = z.enum([
  'text',
  'number',
  'select',
  'toggle',
  'model',
  'secret',
  'oauth',
  'account',
]);
export type SettingFieldType = z.infer<typeof settingFieldTypeSchema>;

/** 敏感字段类型（§七）：`settings_change` 的 `values` 带上即拒绝，`settings_read` 只回「已配置 / 未配置」。 */
export const SENSITIVE_FIELD_TYPES: ReadonlySet<SettingFieldType> = new Set([
  'secret',
  'oauth',
  'account',
]);

/**
 * 可选值来源：`static` 直接写在目录里；其余由 core 适配器在 `settings_read` 时现取
 * （≤30 个，§5.2），例如「已配置 Key 的厂商下的对话模型」。
 */
export const settingOptionSourceSchema = z.enum([
  'static',
  'chat-models',
  'capability-models',
  'providers',
  'websearch-providers',
  'app-catalog',
  'connections',
  'mcp-servers',
  'mail-providers',
  'agents',
  'agent-models',
  'skills',
  'skill-presets',
  'browser-profiles',
  'bots',
  'microphones',
  'cameras',
  'languages',
]);
export type SettingOptionSource = z.infer<typeof settingOptionSourceSchema>;

export const settingOptionSchema = z.object({ value: z.string(), label: z.string() });
export type SettingOption = z.infer<typeof settingOptionSchema>;

export const settingFieldSpecSchema = z.object({
  /** 字段名：`values` / `proposed` / `before` 的键。 */
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  label: z.string().min(1),
  type: settingFieldTypeSchema,
  /** 敏感：敏感类型恒为 true；非敏感类型也可显式标记（如 Bot 预填也不采用的字段）。 */
  sensitive: z.boolean(),
  options: settingOptionSourceSchema.optional(),
  /** `options = 'static'` 时的可选值。 */
  staticOptions: z.array(settingOptionSchema).optional(),
  /** 多选（数组值）。 */
  multiple: z.boolean().optional(),
  hint: z.string().optional(),
});
export type SettingFieldSpec = z.infer<typeof settingFieldSpecSchema>;

/**
 * 已有专门工具的项（§4.1 / §5.2）：`settings_read` 告诉 Bot 改用哪个工具，`settings_change`
 * 只回「请改用某工具」，不代为调用——各工具自己的门控与审批不被绕过。
 */
export const settingWriteViaSchema = z.union([
  z.literal('catalog'),
  z.object({ tool: z.string().min(1) }),
]);
export type SettingWriteVia = z.infer<typeof settingWriteViaSchema>;

export const settingWriteSpecSchema = z.object({
  /** 这一项最宽松能到哪一档；宿主还会按上下文再收紧（§5.3，`effectiveMode`）。 */
  maxMode: settingWriteModeSchema,
  via: settingWriteViaSchema,
  /**
   * 这一项能放宽权限或安全边界（新增授权、MCP、网络放开……）：永不 direct（§5.3 第 5 条）。
   */
  widensPermission: z.boolean(),
  /**
   * 具体某次修改是放宽方向时的档位（如 Bot 网络策略放开 → `user-only`）。放宽与否由 core
   * 适配器按旧值 → 新值判定后经 `SettingModeContext.valuesWiden` 传入；未知按放宽处理。
   */
  wideningMode: z.literal('user-only').optional(),
});
export type SettingWriteSpec = z.infer<typeof settingWriteSpecSchema>;

/**
 * 卡片组件键（渲染层 `CardKey → Svelte 组件` 映射，§4.1）。只登记已有嵌入组件的键；
 * P1 组件化一个，就在这里加一个键并把条目的 `card` 从 null 改过来。
 */
export const CARD_KEYS = [
  /** 新建 `DefaultModelsCard`（包住 `ModelSelectField` 并自带保存）。 */
  'default-models',
  /** `ProviderSetupForm`。 */
  'provider-setup',
  /** `CapabilityModelSection`（按条目的能力分发）。 */
  'capability-model',
  /** `WebSearchSection`。 */
  'web-search',
  /** `ConnectAppPanel`。 */
  'connect-app',
  /** `MailAccountAddForm`。 */
  'mail-account',
  /** `AgentCard`。 */
  'agent',
  /** Bot 模型片段卡（自带 `bots.update`）。 */
  'bot-model',
  /** Bot 配置其余片段（浏览器资料 / 网络 / MCP / 连接 / 任务引擎）。 */
  'bot-config',
  /** 这个 Bot 的技能启停。 */
  'bot-skills',
  /** `SensorCard{kind}`。 */
  'sensor',
  /** 目录字段编辑（审查模型、并发、默认智能体、开机启动、预算）。 */
  'field-editor',
  /** `EmbeddingSection`。 */
  'embedding',
  /** `AppearanceSection`（主题 / 语言，渲染层拥有）。 */
  'appearance',
  /** `BackgroundTasksSection`。 */
  'background-tasks',
  /** `UnattendedSection` 的开启 / 关闭。 */
  'unattended',
  /** 污点防护开关（`UnattendedSection` 的对应行）。 */
  'taint-guard',
  /** 群名（`GroupSettingsDialog` 的改名片段）。 */
  'group-title',
  /** 群成员（`GroupSettingsDialog` 的成员片段；组件自己调 groups RPC）。 */
  'group-members',
  /** 项目保护规则 / 放行端口（`ProjectSettingsDialog`，user-only，组件自己保存）。 */
  'project-settings',
  /** 一条连接工具的策略（`AppConnectionDetail` 片段；组件自己 `setToolPolicy`）。 */
  'tool-policy',
] as const;
export const cardKeySchema = z.enum(CARD_KEYS);
export type CardKey = z.infer<typeof cardKeySchema>;

/**
 * 深链落点：
 * - `settings`：`shell.openSettings(section, anchor)`，section 是设置弹框分区 id；
 * - `extension-center`：`openExtensionCenter(section)`，section 是扩展中心页签；
 * - `bot-panel`：右栏 Bot 详情，section 是页签 value；
 * - `group-dialog` / `project-dialog`：群设置 / 项目设置对话框（section 固定为对话框名）。
 * anchor 是 `data-settings-anchor` 的值；缺省 = 只到分区。
 */
export const settingSurfaceSchema = z.enum([
  'settings',
  'extension-center',
  'bot-panel',
  'group-dialog',
  'project-dialog',
]);
export type SettingSurface = z.infer<typeof settingSurfaceSchema>;

export const settingDeepLinkSchema = z.object({
  surface: settingSurfaceSchema,
  section: z.string().min(1),
  anchor: z.string().min(1).optional(),
});
export type SettingDeepLink = z.infer<typeof settingDeepLinkSchema>;

/**
 * 值存在哪里（core 适配器读写、`settings.changed` 映射用）：
 * - `settings`：`settingsSchema` 里的点路径（`capabilityModels.image`）；
 * - `bot`：`BotProfile` 里的点路径（`runtime.model`）；
 * - `service`：只经专用 RPC 写（`unattended.enable`、`groups.rename`……）；
 * - `renderer`：渲染层 localStorage；`none`：只读 / 只经专门工具。
 */
export const settingStoreSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('settings'), paths: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('bot'), paths: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('service'), methods: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('renderer') }),
  z.object({ kind: z.literal('none') }),
]);
export type SettingStore = z.infer<typeof settingStoreSchema>;

/** 稳定 id：`组.名字`，小写短横线（如 `models.default-main`、`capability.image`）。 */
export const SETTING_ITEM_ID_PATTERN = /^[a-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

export const settingItemSchema = z.object({
  id: z.string().regex(SETTING_ITEM_ID_PATTERN),
  group: settingGroupSchema,
  title: z.string().min(1),
  /** 一句人话：它决定什么。 */
  summary: z.string().min(1),
  /** 它让 Bot 能做什么（供搜索与「检查能力」）。 */
  enables: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  scope: settingScopeSchema,
  owner: settingOwnerSchema,
  fields: z.array(settingFieldSpecSchema),
  write: settingWriteSpecSchema,
  /** 渲染层组件键；null = 暂无内嵌组件，只能出 link（`effectiveMode` 兜底）。 */
  card: cardKeySchema.nullable(),
  deepLink: settingDeepLinkSchema,
  store: settingStoreSchema,
  /** 只读项（诊断 / 用量）：只给概要与跳转卡，不可写。 */
  readOnly: z.boolean(),
});
export type SettingItem = z.infer<typeof settingItemSchema>;

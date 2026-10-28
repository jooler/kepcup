import type { MessageKey } from '$lib/i18n';

/**
 * Bot 详情「配置」tab 的二级菜单导航模型（参考分组条目式设置页）：默认渲染分组
 * 条目菜单，点条目下钻到对应设置详情；返回回菜单。对话内设置卡的深链锚点
 * （data-settings-anchor，shared settings-catalog）也按这里映射到具体详情。
 */
export type BotConfigSection =
  'persona' | 'role' | 'model' | 'plugins' | 'inkcop' | 'network' | 'browser';

/** 菜单条目 / 详情标题共用的文案键。 */
export const BOT_CONFIG_SECTION_LABEL_KEYS: Record<BotConfigSection, MessageKey> = {
  persona: 'rightPanel.configRowPersona',
  role: 'rightPanel.configRowRole',
  model: 'rightPanel.configRowModel',
  plugins: 'botPanel.sections.plugins',
  inkcop: 'rightPanel.configRowInkcop',
  network: 'rightPanel.configRowNetwork',
  browser: 'rightPanel.configRowBrowser',
};

/**
 * 设置卡深链锚点 → 配置详情。`bot-agent` 并入「模型与智能体」（智能体设置就渲染
 * 在模型详情里；Bot 未切到智能体时同样落那里，引擎下拉可就地切换）。
 *
 * P2 注入模型：应用 / MCP / 邮箱三个区块收编为「插件」；旧锚点 `bot-apps` /
 * `bot-mcp` 保留为别名（shared settings-catalog 的 `bot.apps` / `bot.mcp-servers`
 * 条目仍指向它们，渲染层在插件区块顶部保留同名锚点落点，深链不断）。
 */
export const BOT_CONFIG_ANCHOR_SECTIONS: Record<string, BotConfigSection> = {
  'bot-identity': 'persona',
  'bot-model': 'model',
  'bot-agent': 'model',
  'bot-plugins': 'plugins',
  'bot-apps': 'plugins',
  'bot-mcp': 'plugins',
  'bot-network': 'network',
  'bot-browser-profile': 'browser',
  'bot-inkcop-agents': 'inkcop',
};

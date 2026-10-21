import {
  botAgentAdapter,
  botAppsAdapter,
  botFileAccessAdapter,
  botIdentityAdapter,
  botMcpAdapter,
  botModelAdapter,
  botSkillsAdapter,
  browserProfileAdapter,
  networkAdapter,
} from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * Bot 组：本 Bot 的模型 / 轻量模型 / 浏览器资料 / 网络 / MCP / 连接 / 技能 / 任务引擎，
 * 以及人设与目录授权两个 via-tool 条目的只读概要。
 */
export const botContribution: SettingAdapterContribution = {
  name: 'bot',
  adapters: {
    'bot.model': (deps) => botModelAdapter(deps, 'model'),
    'bot.light-model': (deps) => botModelAdapter(deps, 'light_model'),
    'bot.browser-profile': browserProfileAdapter,
    'bot.network': networkAdapter,
    'bot.mcp-servers': botMcpAdapter,
    'bot.apps': botAppsAdapter,
    'bot.skills': botSkillsAdapter,
    'bot.agent': botAgentAdapter,
    'bot.identity': botIdentityAdapter,
    'bot.file-access': botFileAccessAdapter,
  },
};

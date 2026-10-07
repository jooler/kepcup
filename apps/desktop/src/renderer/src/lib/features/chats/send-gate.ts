import {
  agentSetupReasonOf,
  type AgentView,
  type Bot,
  type SetupRequirement,
  type Settings,
} from '@kepcup/shared';

/**
 * 发送门禁（docs/design/18-inline-setup.md「发送门禁」）：单聊 Bot 明确跑不
 * 起来时不发送——草稿原地保留，消息列表呈现对应的设置卡，设置完成后
 * `continueAfterSetup` 自动冲掉草稿。返回 null = 放行。
 *
 * - 内置引擎：Bot 未指定模型且全局无默认主模型 → `main-model`；
 * - 外部 Agent（D72 P4）：实验开关关闭 / 未启用 / 未安装 / 未登录 / 不兼容 →
 *   `{kind:'agent'}`（与 core run 门禁同一份 `agentSetupReasonOf` 判定）。
 *   Agent 视图未加载时只按 settings 的启用开关判断，其余交给 core 的结构化
 *   失败兜底；对话式访谈期间恒走内置引擎。
 *
 * settings 快照未加载时放行（core 兜底，卡片仍会出现）。
 */
export function sendGateRequirement(input: {
  conversationType: string;
  bot: Pick<Bot, 'profile' | 'setupState'> | null | undefined;
  settings: Pick<Settings, 'defaultMainModel' | 'experimental' | 'agents'> | null;
  agents: { loaded: boolean; get(id: string): Pick<AgentView, 'enabled' | 'status'> | null };
}): SetupRequirement | null {
  const { bot, settings } = input;
  if (input.conversationType !== 'direct' || bot === null || bot === undefined) return null;
  if (settings === null) return null;
  const agentId = bot.setupState === 'interviewing' ? '' : bot.profile.runtime.agent.id;
  if (agentId.length > 0) {
    const view = input.agents.loaded
      ? input.agents.get(agentId)
      : { enabled: settings.agents[agentId]?.enabled === true, status: 'ready' as const };
    const reason = agentSetupReasonOf(view, settings.experimental.externalAgents);
    return reason === null ? null : { kind: 'agent', agentId, reason };
  }
  if (bot.profile.runtime.model.length > 0) return null;
  if (settings.defaultMainModel.length > 0) return null;
  return { kind: 'main-model' };
}

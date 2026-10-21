import {
  agentsDefaultAdapter,
  backgroundTasksAdapter,
  browserSharedProfilesAdapter,
  developerCustomMcpAdapter,
  developerMcpbAdapter,
  developerOauthClientsAdapter,
  externalAgentsAdapter,
  mcpServersAdapter,
  projectGoalAdapter,
  projectLeadAdapter,
  projectMembersAdapter,
  projectTitleAdapter,
  scheduleCountAdapter,
  skillInstallAdapter,
  taintGuardAdapter,
  toolPolicyAdapter,
  unattendedAdapter,
  watchCountAdapter,
  webSearchAdapter,
  workdirRulesAdapter,
} from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * 尚未按功能拆出的其余条目（第一阶段兼容贡献，todo/settings-catalog-registry.md §4.2.1）。
 * 按组迁移时把对应行挪进自己的 `contributions/<组>.ts` 并在 `index.ts` 换掉本贡献；
 * 适配器实现仍在 `adapters.ts`。
 */
export const legacyContribution: SettingAdapterContribution = {
  name: 'legacy',
  adapters: {
    'search.provider': webSearchAdapter,
    'connections.taint-guard': taintGuardAdapter,
    'connections.tool-policy': toolPolicyAdapter,
    'mcp.servers': mcpServersAdapter,
    'agents.external': externalAgentsAdapter,
    'agents.default': agentsDefaultAdapter,
    'browser.shared-profiles': browserSharedProfilesAdapter,
    'project.title': projectTitleAdapter,
    'project.goal': projectGoalAdapter,
    'project.members': projectMembersAdapter,
    'project.lead': projectLeadAdapter,
    'workdir.protect-rules': (deps) => workdirRulesAdapter(deps, 'rules'),
    'workdir.ports': (deps) => workdirRulesAdapter(deps, 'ports'),
    'background.tasks': backgroundTasksAdapter,
    'unattended.enable': (deps) => unattendedAdapter(deps, 'enable'),
    'unattended.disable': (deps) => unattendedAdapter(deps, 'disable'),
    'developer.custom-mcp': developerCustomMcpAdapter,
    'developer.oauth-clients': developerOauthClientsAdapter,
    'developer.mcpb': developerMcpbAdapter,
    'skills.install': skillInstallAdapter,
    'schedules.schedule': scheduleCountAdapter,
    'schedules.watch': watchCountAdapter,
  },
};

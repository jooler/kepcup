import type { AgentAuthMethodView, AgentView } from '@kepcup/shared';

type AgentCardView = Pick<
  AgentView,
  'id' | 'authKinds' | 'apiKeyEnv' | 'hasApiKey' | 'authMethods' | 'termsNoticeKey'
>;

/** Whether this agent only authenticates via an API key managed by KepCup. */
export function isApiKeyOnlyAgent(agent: Pick<AgentView, 'authKinds'>): boolean {
  return agent.authKinds.length > 0 && agent.authKinds.every((kind) => kind === 'api-key');
}

/**
 * Auth method buttons to show in AgentCard.
 *
 * When `apiKeyEnv` is present and there is a single `agent`-type API-key
 * method (which `AgentsService` automatically triggers on key save):
 * - For `apiKeyOnly` agents, the standalone button is always redundant.
 * - For multi-method agents (such as Antigravity), hide it until an API key
 *   has been saved so users cannot trigger an unkeyed selection. Once saved,
 *   it remains available to switch back from another method.
 */
export function visibleAgentAuthMethods(agent: AgentCardView): AgentAuthMethodView[] {
  const apiKeyOnly = isApiKeyOnlyAgent(agent);
  const autoKeyMethods =
    agent.apiKeyEnv !== null
      ? agent.authMethods.filter(
          (method) => method.type === 'agent' && /api[-_]key/i.test(method.id),
        )
      : [];
  const hiddenAutoKeyMethodId =
    autoKeyMethods.length === 1 && (apiKeyOnly || !agent.hasApiKey) ? autoKeyMethods[0]!.id : null;
  if (hiddenAutoKeyMethodId === null) return [...agent.authMethods];
  return agent.authMethods.filter((method) => method.id !== hiddenAutoKeyMethodId);
}

/** Whether signing in with `methodId` needs the Antigravity personal-account terms confirmation. */
export function requiresOAuthPersonalConfirm(
  agent: Pick<AgentView, 'id' | 'termsNoticeKey'>,
  methodId: string,
): boolean {
  return (
    methodId === 'oauth-personal' &&
    (agent.id === 'antigravity-acp' || agent.termsNoticeKey === 'agents.terms.antigravity')
  );
}

/**
 * Show the "local official sign-in preferred" notice only when the agent has
 * non-API-key official auth methods (`ENV_WHITELIST` blocks ambient API keys).
 */
export function shouldShowLocalAuthPreferred(
  agent: Pick<AgentView, 'authKinds' | 'isolatesLocalAuth'>,
): boolean {
  return !agent.isolatesLocalAuth && !isApiKeyOnlyAgent(agent) && agent.authKinds.length > 0;
}

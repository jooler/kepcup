import type { AgentAuthMethodView, AgentView } from '@kepcup/shared';
import { describe, expect, it } from 'vitest';
import {
  isApiKeyOnlyAgent,
  requiresOAuthPersonalConfirm,
  shouldShowLocalAuthPreferred,
  visibleAgentAuthMethods,
} from './agent-card-model';

const METHODS: AgentAuthMethodView[] = [
  { id: 'oauth-personal', name: 'Google OAuth', description: '', type: 'agent' },
  { id: 'oauth-business', name: 'Enterprise', description: '', type: 'agent' },
  { id: 'gemini-api-key', name: 'Use Gemini API key', description: '', type: 'agent' },
];

function stubAgent(
  overrides: Partial<
    Pick<
      AgentView,
      | 'id'
      | 'authKinds'
      | 'apiKeyEnv'
      | 'hasApiKey'
      | 'authMethods'
      | 'isolatesLocalAuth'
      | 'termsNoticeKey'
    >
  > = {},
) {
  return {
    id: 'antigravity-acp',
    authKinds: ['subscription', 'api-key'],
    apiKeyEnv: 'GEMINI_API_KEY',
    hasApiKey: false,
    authMethods: METHODS,
    isolatesLocalAuth: true,
    termsNoticeKey: 'agents.terms.antigravity',
    ...overrides,
  };
}

describe('agent-card-model', () => {
  it('hides unkeyed api-key auth method on hybrid agents until an API key is saved', () => {
    const unkeyed = visibleAgentAuthMethods(stubAgent({ hasApiKey: false }));
    expect(unkeyed.map((method) => method.id)).toEqual(['oauth-personal', 'oauth-business']);

    const keyed = visibleAgentAuthMethods(stubAgent({ hasApiKey: true }));
    expect(keyed.map((method) => method.id)).toEqual([
      'oauth-personal',
      'oauth-business',
      'gemini-api-key',
    ]);
  });

  it('always hides the redundant single agent api-key method on api-key-only agents', () => {
    const agent = stubAgent({
      id: 'dsh-acp',
      authKinds: ['api-key'],
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      hasApiKey: true,
      authMethods: [{ id: 'api-key', name: 'API Key', description: '', type: 'agent' }],
      isolatesLocalAuth: false,
      termsNoticeKey: null,
    });
    expect(isApiKeyOnlyAgent(agent)).toBe(true);
    expect(visibleAgentAuthMethods(agent)).toEqual([]);
  });

  it('scopes oauth-personal confirmation dialog to Antigravity', () => {
    expect(requiresOAuthPersonalConfirm(stubAgent(), 'oauth-personal')).toBe(true);
    expect(requiresOAuthPersonalConfirm(stubAgent(), 'oauth-business')).toBe(false);
    expect(
      requiresOAuthPersonalConfirm(
        stubAgent({ id: 'other-agent', termsNoticeKey: null }),
        'oauth-personal',
      ),
    ).toBe(false);
  });

  it('shows localAuthPreferred only for non-isolating agents with non-api-key auth', () => {
    expect(
      shouldShowLocalAuthPreferred({
        authKinds: ['subscription', 'api-key'],
        isolatesLocalAuth: false,
      }),
    ).toBe(true);
    expect(
      shouldShowLocalAuthPreferred({
        authKinds: ['subscription', 'api-key'],
        isolatesLocalAuth: true,
      }),
    ).toBe(false);
    expect(
      shouldShowLocalAuthPreferred({
        authKinds: ['api-key'],
        isolatesLocalAuth: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLocalAuthPreferred({
        authKinds: [],
        isolatesLocalAuth: false,
      }),
    ).toBe(false);
  });
});

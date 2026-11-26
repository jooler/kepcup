import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG, type AgentCatalogEntry, type AgentPermissionTier } from '@kepcup/shared';
import { isSessionNotFound } from '../../src/agent/external/acp/client.js';
import { isForbiddenAgentMode } from '../../src/agent/external/permission-bridge.js';
import { PROVIDERS } from '../../src/agent/external/providers/index.js';
import { gooseProvider } from '../../src/agent/external/providers/goose.js';
import { kimiProvider } from '../../src/agent/external/providers/kimi.js';
import type { PermissionTierContext } from '../../src/agent/external/types.js';

const catalog = (id: string): AgentCatalogEntry => AGENT_CATALOG.find((entry) => entry.id === id)!;
const stateDir = path.join('/s', 'agents', 'd118');

function tierContext(
  modes: readonly string[],
  current: string,
): { ctx: PermissionTierContext; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      sessionId: 's',
      modes: { currentModeId: current, availableModes: modes.map((id) => ({ id, name: id })) },
      configOptions: [],
      setMode: async (modeId) => {
        calls.push(`mode:${modeId}`);
      },
      setConfigOption: async () => {},
    },
  };
}

describe('Kimi Code provider (2.8.1)', () => {
  it('uses the npm successor distribution and dedicated provider', () => {
    const entry = catalog('kimi');
    expect(entry).toMatchObject({
      name: 'Kimi Code',
      version: '2.8.1',
      provider: 'kimi',
      repository: 'https://github.com/MoonshotAI/kimi-code',
      distribution: { npx: { package: '@moonshot-ai/kimi-code@2.8.1', args: ['acp'] } },
      releaseGate: 'kimi',
      tier: 'preview',
    });
    expect(PROVIDERS.kimi).toBe(kimiProvider);
  });

  it('maps read-only to plan and everything else to default, never auto/yolo', async () => {
    expect(kimiProvider.forbiddenModes).toEqual(['auto', 'yolo']);
    for (const mode of ['auto', 'yolo']) {
      expect(isForbiddenAgentMode(mode, kimiProvider)).toBe(true);
    }
    const expected: Record<AgentPermissionTier, string> = {
      read_only: 'plan',
      ask: 'default',
      workspace: 'default',
    };
    for (const tier of ['read_only', 'ask', 'workspace'] as const) {
      const { ctx, calls } = tierContext(['default', 'plan', 'auto', 'yolo'], 'default');
      await kimiProvider.applyPermissionTier(tier, ctx);
      expect(calls).toEqual(expected[tier] === 'default' ? [] : [`mode:${expected[tier]}`]);
    }
  });

  it('uses one-shot approval options and isolates KIMI_CODE_HOME unless asked', () => {
    expect(kimiProvider.permissionOptions).toEqual({
      allowOnce: ['approve_once'],
      rejectOnce: ['reject'],
    });
    const entry = catalog('kimi');
    const isolated = kimiProvider.launch({
      entry,
      target: { command: '/x/kimi', args: ['acp'], env: { KEEP: '1', KIMI_CODE_HOME: '/evil' } },
      platform: 'linux',
      stateDir,
    });
    expect(isolated.env).toMatchObject({
      KEEP: '1',
      KIMI_CODE_HOME: path.resolve(stateDir),
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_CLI_NO_AUTO_UPDATE: '1',
    });
    const user = kimiProvider.launch({
      entry,
      target: { command: '/x/kimi', args: ['acp'], env: { KIMI_CODE_HOME: '/user-home' } },
      platform: 'linux',
      loadUserConfig: true,
    });
    expect(user.env.KIMI_CODE_HOME).toBeUndefined();
    expect(user.env.KIMI_CODE_NO_AUTO_UPDATE).toBe('1');
    expect(user.env.KIMI_CLI_NO_AUTO_UPDATE).toBe('1');
    expect(() =>
      kimiProvider.launch({
        entry,
        target: { command: '/x/kimi', args: ['acp'], env: {} },
        platform: 'linux',
      }),
    ).toThrow(/私有状态目录/);
    expect(() =>
      kimiProvider.launch({
        entry,
        target: { command: '/x/kimi', args: ['acp'], env: {} },
        platform: 'linux',
        loadUserConfig: true,
      }),
    ).not.toThrow();
  });

  it('recognizes its session-not-found shapes and declares the verified features', () => {
    expect(isSessionNotFound({ code: 40404, message: 'missing' } as never, kimiProvider)).toBe(
      true,
    );
    expect(
      isSessionNotFound(
        { code: -32602, data: { sessionId: 's' }, message: 'invalid params' } as never,
        kimiProvider,
      ),
    ).toBe(true);
    expect(
      isSessionNotFound(
        { code: -32602, data: {}, message: 'invalid params' } as never,
        kimiProvider,
      ),
    ).toBe(false);
    expect(kimiProvider.features).toEqual({
      steering: false,
      loadSession: true,
      resume: true,
      osSandbox: false,
      httpMcp: true,
      parallelSessions: false,
    });
    expect(kimiProvider.agentSideConfigFiles).toEqual(['.kimi-code/', 'AGENTS.md', '.agents/']);
  });
});

describe('goose provider (1.61.1)', () => {
  it('uses the lean artifact and dedicated provider', () => {
    const entry = catalog('goose');
    expect(entry).toMatchObject({
      version: '1.61.1',
      provider: 'goose',
      repository: 'https://github.com/aaif-goose/goose',
      releaseGate: 'goose',
      tier: 'preview',
    });
    expect(entry.distribution.binary?.['darwin-aarch64']).toMatchObject({
      cmd: './goose-acp',
    });
    expect(entry.distribution.binary?.['darwin-aarch64']?.args).toBeUndefined();
    expect(PROVIDERS.goose).toBe(gooseProvider);
  });

  it('forces approve mode and a private GOOSE_PATH_ROOT unless asked', () => {
    const entry = catalog('goose');
    const isolated = gooseProvider.launch({
      entry,
      target: { command: '/x/goose-acp', args: [], env: { GOOSE_MODE: 'auto' } },
      platform: 'linux',
      stateDir,
    });
    expect(isolated.env).toMatchObject({
      GOOSE_MODE: 'approve',
      GOOSE_PATH_ROOT: path.resolve(stateDir),
    });
    const user = gooseProvider.launch({
      entry,
      target: {
        command: '/x/goose-acp',
        args: [],
        env: { GOOSE_MODE: 'auto', GOOSE_PATH_ROOT: '/evil' },
      },
      platform: 'linux',
      loadUserConfig: true,
    });
    expect(user.env.GOOSE_PATH_ROOT).toBe('/evil');
    expect(user.env.GOOSE_MODE).toBe('approve');
    expect(() =>
      gooseProvider.launch({
        entry,
        target: { command: '/x/goose-acp', args: [], env: {} },
        platform: 'linux',
      }),
    ).toThrow(/私有状态目录/);
  });

  it('declares one-shot permissions, forbidden autonomous modes and conservative features', () => {
    expect(gooseProvider.permissionOptions).toEqual({
      allowOnce: ['allow_once'],
      rejectOnce: ['reject_once', 'reject_always'],
    });
    for (const mode of ['auto', 'smart_approve', 'yolo']) {
      expect(isForbiddenAgentMode(mode, gooseProvider)).toBe(true);
    }
    expect(gooseProvider.features).toEqual({
      steering: false,
      loadSession: false,
      resume: false,
      osSandbox: false,
      httpMcp: true,
      parallelSessions: false,
    });
  });
});

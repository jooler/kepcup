import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG, type AgentCatalogEntry, type AgentPermissionTier } from '@kepcup/shared';
import { isSessionNotFound } from '../../src/agent/external/acp/client.js';
import { classifierFor } from '../../src/agent/external/errors.js';
import { isForbiddenAgentMode } from '../../src/agent/external/permission-bridge.js';
import { PROVIDERS } from '../../src/agent/external/providers/index.js';
import { clineProvider } from '../../src/agent/external/providers/cline.js';
import { copilotProvider } from '../../src/agent/external/providers/copilot.js';
import { grokBinaryState, grokProvider } from '../../src/agent/external/providers/grok.js';
import { qwenProvider } from '../../src/agent/external/providers/qwen.js';
import type {
  AgentProvider,
  PermissionTierContext,
  SessionContext,
} from '../../src/agent/external/types.js';

const stateDir = path.join('/s', 'agents', 'd118');
const catalog = (id: string): AgentCatalogEntry => AGENT_CATALOG.find((entry) => entry.id === id)!;

function tierContext(modes: readonly string[], current: string) {
  const calls: string[] = [];
  const ctx: PermissionTierContext = {
    sessionId: 's',
    modes: { currentModeId: current, availableModes: modes.map((id) => ({ id, name: id })) },
    configOptions: [],
    setMode: async (modeId) => {
      calls.push(`mode:${modeId}`);
    },
    setConfigOption: async (configId, value) => {
      calls.push(`config:${configId}=${value}`);
    },
  };
  return { ctx, calls };
}

function sessionContext(entry: AgentCatalogEntry, permission: AgentPermissionTier): SessionContext {
  return {
    entry,
    cwd: '/work',
    permission,
    capabilities: [],
    sessionPrompt: null,
    maxTurns: 60,
    loadUserConfig: false,
  };
}

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('D118 dedicated ACP providers', () => {
  it('registers all four providers', () => {
    expect(PROVIDERS.cline).toBe(clineProvider);
    expect(PROVIDERS.copilot).toBe(copilotProvider);
    expect(PROVIDERS.qwen).toBe(qwenProvider);
    expect(PROVIDERS.grok).toBe(grokProvider);
  });

  const modeCases: Array<{
    provider: AgentProvider;
    name: string;
    modes: readonly string[];
    current: string;
    expected: Readonly<Record<AgentPermissionTier, string>>;
  }> = [
    {
      provider: clineProvider,
      name: 'Cline',
      modes: ['plan', 'act'],
      current: 'act',
      expected: { read_only: 'plan', ask: 'act', workspace: 'act' },
    },
    {
      provider: copilotProvider,
      name: 'GitHub Copilot',
      modes: ['plan', 'agent', 'autopilot'],
      current: 'plan',
      expected: { read_only: 'plan', ask: 'agent', workspace: 'agent' },
    },
    {
      provider: qwenProvider,
      name: 'Qwen Code',
      modes: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
      current: 'default',
      expected: { read_only: 'plan', ask: 'default', workspace: 'default' },
    },
  ];

  for (const modeCase of modeCases) {
    it(`${modeCase.name} maps every permission tier through switchToMode`, async () => {
      for (const tier of ['read_only', 'ask', 'workspace'] as const) {
        const { ctx, calls } = tierContext(modeCase.modes, modeCase.current);
        await modeCase.provider.applyPermissionTier(tier, ctx);
        const target = modeCase.expected[tier];
        expect(calls).toEqual(modeCase.current === target ? [] : [`mode:${target}`]);
      }
    });
  }

  it('uses a mode config option when ACP modes are absent and fails closed if unavailable', async () => {
    const calls: string[] = [];
    const ctx: PermissionTierContext = {
      sessionId: 's',
      modes: null,
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'act',
          options: [
            { value: 'plan', name: 'Plan' },
            { value: 'act', name: 'Act' },
          ],
        },
      ],
      setMode: async () => {},
      setConfigOption: async (configId, value) => {
        calls.push(`config:${configId}=${value}`);
      },
    };
    await clineProvider.applyPermissionTier('read_only', ctx);
    expect(calls).toEqual(['config:mode=plan']);

    const missing = tierContext(['act'], 'act');
    await expect(clineProvider.applyPermissionTier('read_only', missing.ctx)).rejects.toMatchObject(
      {
        code: 'AGENT_INCOMPATIBLE',
      },
    );
  });

  it('declares the verified one-shot permission options and forbidden modes', () => {
    expect(clineProvider.permissionOptions).toEqual({
      allowOnce: ['allow_once'],
      rejectOnce: ['reject_once'],
    });
    expect(copilotProvider.permissionOptions).toEqual({
      allowOnce: ['allow_once'],
      rejectOnce: ['reject_once'],
    });
    expect(qwenProvider.permissionOptions).toEqual({
      allowOnce: ['proceed_once'],
      rejectOnce: ['cancel'],
    });
    expect(grokProvider.permissionOptions).toEqual({
      allowOnce: ['allow_once'],
      rejectOnce: ['reject_once'],
    });

    expect(copilotProvider.forbiddenModes).toEqual(['autopilot']);
    expect(copilotProvider.safeModes).toEqual(['agent']);
    expect(isForbiddenAgentMode('autopilot', copilotProvider)).toBe(true);
    expect(isForbiddenAgentMode('agent', copilotProvider)).toBe(false);
    expect(qwenProvider.forbiddenModes).toEqual(['auto-edit', 'auto', 'yolo']);
    for (const mode of ['auto-edit', 'auto', 'yolo']) {
      expect(isForbiddenAgentMode(mode, qwenProvider)).toBe(true);
    }
  });

  it('declares the verified feature matrix', () => {
    expect(clineProvider.features).toEqual({
      steering: false,
      loadSession: true,
      resume: false,
      osSandbox: false,
      httpMcp: true,
      parallelSessions: false,
    });
    for (const provider of [copilotProvider, qwenProvider, grokProvider]) {
      expect(provider.features).toEqual({
        steering: false,
        loadSession: true,
        resume: true,
        osSandbox: false,
        httpMcp: true,
        parallelSessions: false,
      });
    }
  });

  it('lists the workdir configuration each agent can load', () => {
    expect(clineProvider.agentSideConfigFiles).toEqual([
      '.cline/',
      '.clinerules/',
      '.agents/',
      'AGENTS.md',
    ]);
    expect(copilotProvider.agentSideConfigFiles).toEqual([
      'AGENTS.md',
      '.github/copilot-instructions.md',
      '.github/copilot/settings.json',
      '.github/copilot/settings.local.json',
      '.github/mcp.json',
      '.mcp.json',
      '.agents/',
      'hooks/',
      'extensions/',
      'plugins/',
    ]);
    expect(qwenProvider.agentSideConfigFiles).toEqual([
      'QWEN.md',
      'AGENTS.md',
      '.qwen/',
      '.agents/',
    ]);
    expect(grokProvider.agentSideConfigFiles).toEqual([
      '.grok/',
      '.agents/',
      '.claude/',
      'AGENTS.md',
    ]);
  });
});

describe('D118 launch environments', () => {
  it('Cline isolates config and data only when personal config is not loaded', () => {
    const entry = catalog('cline');
    const launch = clineProvider.launch({
      entry,
      target: {
        command: '/x/cline',
        args: ['--acp'],
        env: {
          KEEP: 'yes',
          CLINE_DIR: '/evil',
          cline_data_dir: '/evil/data',
          CLINE_NO_AUTO_UPDATE: '0',
        },
      },
      platform: 'linux',
      stateDir,
    });
    expect(launch.command).toBe('/x/cline');
    expect(launch.args).toEqual(entry.distribution.npx!.args);
    expect(launch.env).toMatchObject({
      KEEP: 'yes',
      CLINE_DIR: stateDir,
      CLINE_DATA_DIR: path.join(stateDir, 'data'),
      CLINE_NO_AUTO_UPDATE: '1',
    });

    const user = clineProvider.launch({
      entry,
      target: { command: '/x/cline', args: entry.distribution.npx!.args!, env: {} },
      platform: 'linux',
      loadUserConfig: true,
    });
    expect(user.env.CLINE_DIR).toBeUndefined();
    expect(user.env.CLINE_DATA_DIR).toBeUndefined();
    expect(user.env.CLINE_NO_AUTO_UPDATE).toBe('1');
  });

  it('Copilot preserves catalog args, disables updates / login-shell capture, and isolates home', () => {
    const entry = catalog('github-copilot-cli');
    const args = entry.distribution.npx!.args!;
    const launch = copilotProvider.launch({
      entry,
      target: {
        command: '/x/copilot',
        args,
        env: {
          KEEP: 'yes',
          COPILOT_AUTO_UPDATE: 'true',
          COPILOT_HOME: '/evil',
          COPILOT_DISABLE_LOGIN_SHELL_ENV: '0',
        },
      },
      platform: 'linux',
      stateDir,
    });
    expect(launch.args).toEqual(args);
    expect(launch.env).toMatchObject({
      KEEP: 'yes',
      COPILOT_AUTO_UPDATE: 'false',
      COPILOT_HOME: stateDir,
      COPILOT_DISABLE_LOGIN_SHELL_ENV: '1',
    });

    const user = copilotProvider.launch({
      entry,
      target: { command: '/x/copilot', args, env: {} },
      platform: 'linux',
      loadUserConfig: true,
    });
    expect(user.env.COPILOT_HOME).toBeUndefined();
    expect(user.env.COPILOT_AUTO_UPDATE).toBe('false');
    expect(user.env.COPILOT_DISABLE_LOGIN_SHELL_ENV).toBe('1');
  });

  it('Qwen preserves catalog args, disables updates, and isolates home', () => {
    const entry = catalog('qwen-code');
    const qwenState = mkdtempSync(path.join(tmpdir(), 'kepcup-qwen-state-'));
    try {
      const launch = qwenProvider.launch({
        entry,
        target: {
          command: '/x/qwen',
          args: entry.distribution.npx!.args!,
          env: { KEEP: 'yes', QWEN_HOME: '/evil', QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'false' },
        },
        platform: 'linux',
        stateDir: qwenState,
      });
      expect(launch.args).toEqual(entry.distribution.npx!.args);
      expect(launch.env).toMatchObject({
        KEEP: 'yes',
        QWEN_HOME: qwenState,
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
      });
      expect(JSON.parse(readFileSync(path.join(qwenState, 'settings.json'), 'utf8'))).toMatchObject(
        { general: { enableAutoUpdate: false } },
      );

      const user = qwenProvider.launch({
        entry,
        target: { command: '/x/qwen', args: entry.distribution.npx!.args!, env: {} },
        platform: 'linux',
        loadUserConfig: true,
      });
      expect(user.env.QWEN_HOME).toBeUndefined();
      expect(user.env.QWEN_CODE_SKIP_UPDATE_CHECK_ONCE).toBe('true');
    } finally {
      rmSync(qwenState, { recursive: true, force: true });
    }
  });

  it('Grok preserves catalog args, disables updates, and isolates only when asked', () => {
    const entry = catalog('grok-build');
    const args = entry.distribution.npx!.args!;
    const home = mkdtempSync(path.join(tmpdir(), 'kepcup-grok-home-'));
    const previous = process.env.HOME;
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const isolated = grokProvider.launch({
        entry,
        target: {
          command: '/x/grok',
          args,
          env: {
            GROK_DISABLE_AUTOUPDATER: '0',
            GROK_HOME: '/evil',
            GROK_MANAGED_BY_NPM: '0',
          },
        },
        platform: 'linux',
        stateDir,
      });
      expect(isolated.args).toEqual(args);
      expect(isolated.env).toMatchObject({
        GROK_DISABLE_AUTOUPDATER: '1',
        GROK_HOME: stateDir,
        GROK_MANAGED_BY_NPM: '1',
      });

      const user = grokProvider.launch({
        entry,
        target: { command: '/x/grok', args, env: { GROK_HOME: '/evil' } },
        platform: 'linux',
        loadUserConfig: true,
      });
      expect(user.env.GROK_HOME).toBeUndefined();
      expect(user.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
      expect(user.env.GROK_MANAGED_BY_NPM).toBe('1');
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recognizes the Windows copy layouts (npm and standalone installer)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'kepcup-grok-win-'));
    try {
      mkdirSync(path.join(home, 'bin'), { recursive: true });
      mkdirSync(path.join(home, 'downloads'), { recursive: true });
      writeFileSync(path.join(home, 'downloads', 'grok-1.0.92-windows-x64.exe'), 'pinned');
      writeFileSync(path.join(home, 'bin', 'grok.exe'), 'pinned');
      expect(grokBinaryState(home, '1.0.92', 'win32')).toBe('pinned');

      writeFileSync(path.join(home, 'bin', 'grok.exe'), 'stale-binary');
      expect(grokBinaryState(home, '1.0.92', 'win32')).toBe('other');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'Grok drops a stale managed binary and refuses a mismatched personal one',
    () => {
      const entry = catalog('grok-build');
      const home = mkdtempSync(path.join(tmpdir(), 'kepcup-grok-home-'));
      const managed = path.join(home, 'managed');
      const previous = process.env.HOME;
      try {
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        mkdirSync(path.join(managed, 'bin'), { recursive: true });
        writeFileSync(path.join(managed, 'bin', 'grok-1.0.92'), 'pinned');
        symlinkSync('grok-1.0.92', path.join(managed, 'bin', 'grok'));
        expect(grokBinaryState(managed, '1.0.92', 'linux')).toBe('pinned');

        rmSync(path.join(managed, 'bin', 'grok'));
        symlinkSync('grok-1.0.77', path.join(managed, 'bin', 'grok'));
        const args = entry.distribution.npx!.args!;
        grokProvider.launch({
          entry,
          target: { command: '/x/grok', args, env: {} },
          platform: 'linux',
          stateDir: managed,
        });
        expect(existsSync(path.join(managed, 'bin', 'grok'))).toBe(false);

        mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
        symlinkSync('grok-1.0.77', path.join(home, '.grok', 'bin', 'grok'));
        expect(() =>
          grokProvider.launch({
            entry,
            target: { command: '/x/grok', args, env: {} },
            platform: 'linux',
            loadUserConfig: true,
          }),
        ).toThrow(/不是目录锁定的 1\.0\.92 版本/);
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('refuses isolation without a state directory, but allows explicit user config', () => {
    for (const [provider, entry] of [
      [clineProvider, catalog('cline')],
      [copilotProvider, catalog('github-copilot-cli')],
      [qwenProvider, catalog('qwen-code')],
    ] as const) {
      expect(() =>
        provider.launch({
          entry,
          target: { command: '/x/agent', args: [], env: {} },
          platform: 'linux',
        }),
      ).toThrow(/私有状态目录/);
      expect(() =>
        provider.launch({
          entry,
          target: { command: '/x/agent', args: [], env: {} },
          platform: 'linux',
          loadUserConfig: true,
        }),
      ).not.toThrow();
    }
    const grok = catalog('grok-build');
    expect(() =>
      grokProvider.launch({
        entry: grok,
        target: { command: '/x/agent', args: [], env: {} },
        platform: 'linux',
      }),
    ).toThrow(/私有状态目录/);
    const home = mkdtempSync(path.join(tmpdir(), 'kepcup-grok-home-'));
    const previous = process.env.HOME;
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      expect(() =>
        grokProvider.launch({
          entry: grok,
          target: { command: '/x/agent', args: [], env: {} },
          platform: 'linux',
          loadUserConfig: true,
        }),
      ).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('D118 global config guards', () => {
  it.skipIf(process.platform === 'win32')(
    'Cline refuses unisolated global hooks/plugins; user config can opt in',
    () => {
      const home = mkdtempSync(path.join(tmpdir(), 'kepcup-cline-home-'));
      const previous = process.env.HOME;
      try {
        process.env.HOME = home;
        const hooks = path.join(home, 'Documents', 'Cline', 'Hooks');
        mkdirSync(hooks, { recursive: true });
        writeFileSync(path.join(hooks, 'hook.js'), 'export default 1;\n');
        const entry = catalog('cline');
        const check = (loadUserConfig: boolean) =>
          clineProvider.checkConfig!({ entry, platform: 'linux', loadUserConfig });
        expect(() => check(false)).toThrow(/Hooks \/ Plugins \/ Skills/);
        expect(() => check(true)).not.toThrow();

        rmSync(hooks, { recursive: true });
        mkdirSync(hooks, { recursive: true });
        const plugins = path.join(home, 'Documents', 'Cline', 'Plugins');
        mkdirSync(plugins, { recursive: true });
        writeFileSync(path.join(plugins, 'plugin.js'), 'export default 1;\n');
        expect(() => check(false)).toThrow(/Hooks \/ Plugins \/ Skills/);

        rmSync(path.join(home, 'Documents', 'Cline'), { recursive: true });
        const skill = path.join(home, '.agents', 'skills', 'risky');
        mkdirSync(skill, { recursive: true });
        writeFileSync(
          path.join(skill, 'SKILL.md'),
          '---\nname: risky\ndescription: x\nallowed-tools: Bash\n---\n',
        );
        expect(() => check(false)).toThrow(/Hooks \/ Plugins \/ Skills/);
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'Qwen refuses ~/.agents skills with allowedTools/hooks; benign skills pass',
    () => {
      const home = mkdtempSync(path.join(tmpdir(), 'kepcup-qwen-home-'));
      const previous = process.env.HOME;
      try {
        process.env.HOME = home;
        const skill = path.join(home, '.agents', 'skills', 'risky');
        mkdirSync(skill, { recursive: true });
        writeFileSync(
          path.join(skill, 'SKILL.md'),
          '---\nname: risky\ndescription: x\nallowed-tools: Bash(npx:*)\n---\n',
        );
        const entry = catalog('qwen-code');
        expect(() =>
          qwenProvider.checkConfig!({ entry, platform: 'linux', loadUserConfig: false }),
        ).toThrow(/绕过宿主确认/);

        const safe = path.join(home, '.agents', 'skills', 'safe');
        mkdirSync(safe, { recursive: true });
        writeFileSync(path.join(safe, 'SKILL.md'), '---\nname: safe\ndescription: x\n---\n');
        rmSync(skill, { recursive: true, force: true });
        expect(() =>
          qwenProvider.checkConfig!({ entry, platform: 'linux', loadUserConfig: false }),
        ).not.toThrow();
        expect(() =>
          qwenProvider.checkConfig!({ entry, platform: 'linux', loadUserConfig: true }),
        ).not.toThrow();
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe('D118 session metadata and tool names', () => {
  it('Cline forces the auto_approve config option off for every tier', async () => {
    for (const permission of ['read_only', 'ask', 'workspace'] as const) {
      const calls: string[] = [];
      const { ctx } = tierContext(['plan', 'act'], 'act');
      ctx.configOptions = [
        { id: 'auto_approve', type: 'boolean', currentValue: true, name: 'Auto approve' },
      ] as never;
      await clineProvider.applyPermissionTier(permission, {
        ...ctx,
        setConfigOption: async (id, value) => {
          calls.push(`${id}=${value}`);
        },
      });
      expect(calls).toEqual(['auto_approve=false']);
    }
  });

  it('Grok selects the read-only or ask-user profile and disables autonomous modes', () => {
    const entry = catalog('grok-build');
    expect(grokProvider.sessionNew(sessionContext(entry, 'read_only'))).toEqual({
      _meta: {
        agentProfile: 'grok-build-plan-no-subagents',
        yoloMode: false,
        autoMode: false,
      },
    });
    for (const permission of ['ask', 'workspace'] as const) {
      expect(grokProvider.sessionNew(sessionContext(entry, permission))).toEqual({
        _meta: {
          agentProfile: 'grok-build-ask-user',
          yoloMode: false,
          autoMode: false,
        },
      });
    }
  });

  it('Qwen recognizes only structured MCP metadata for the current bridge server', () => {
    const server = 'kepcup_ab12cd34';
    expect(
      qwenProvider.bridgeToolFromCall?.(
        { _meta: { toolName: 'send_message', provenance: 'mcp', serverId: server } },
        server,
      ),
    ).toBe('send_message');
    expect(
      qwenProvider.bridgeToolFromCall?.(
        { _meta: { toolName: 'send_message', provenance: 'mcp', serverId: 'other' } },
        server,
      ),
    ).toBeNull();
    expect(
      qwenProvider.bridgeToolFromCall?.(
        { _meta: { toolName: 'send_message', provenance: 'builtin', serverId: server } },
        server,
      ),
    ).toBeNull();
    expect(
      qwenProvider.bridgeToolFromCall?.({ name: `mcp__${server}__send_message` }, server),
    ).toBe('send_message');
  });

  it('Grok exposes MCP tools as server__tool', () => {
    expect(grokProvider.toolName('kepcup_ab12cd34', 'send_message')).toBe(
      'kepcup_ab12cd34__send_message',
    );
  });
});

describe('D118 error classification', () => {
  it('Cline recognizes only its -32603 unknown-session shape', () => {
    expect(isSessionNotFound(rpcError(-32603, 'unknown session: s1'), clineProvider)).toBe(true);
    expect(isSessionNotFound(rpcError(-32602, 'unknown session: s1'), clineProvider)).toBe(false);
    expect(isSessionNotFound(rpcError(-32603, 'disk full'), clineProvider)).toBe(false);
  });

  it('Qwen recognizes only its -32603 Session-not-found shape', () => {
    expect(isSessionNotFound(rpcError(-32603, 'Session not found: s1'), qwenProvider)).toBe(true);
    expect(isSessionNotFound(rpcError(-32602, 'Session not found: s1'), qwenProvider)).toBe(false);
    expect(isSessionNotFound(rpcError(-32603, 'disk full'), qwenProvider)).toBe(false);
  });

  it('Grok classifies its authentication messages and lost-session messages separately', () => {
    const classify = classifierFor(grokProvider);
    for (const message of [
      'Not signed in. Run grok login.',
      'set the XAI_API_KEY environment variable or run grok login',
      'Authentication required: your session has expired',
    ]) {
      expect(classify({ code: -32603, message }, 'prompt')).toBe('auth_required');
    }
    expect(classify({ code: -32000, message: 'Authentication required' }, 'session_new')).toBe(
      'auth_required',
    );
    expect(classify({ code: -32603, message: 'disk full' }, 'prompt')).toBe('other');

    for (const message of [
      'unknown session id: s1',
      'session is not loaded in this process; call session/load or session/resume first',
      'session s1 is not loaded in this process',
    ]) {
      expect(isSessionNotFound(rpcError(-32603, message), grokProvider)).toBe(true);
      expect(classify({ code: -32603, message }, 'prompt')).toBe('other');
    }
    expect(isSessionNotFound(rpcError(-32603, 'disk full'), grokProvider)).toBe(false);
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_CATALOG, type Approval } from '@kepcup/shared';
import { resolvePaths } from '../../src/infra/paths.js';
import {
  AgentPermissionBridge,
  classifyPermissionRequest,
  commandOfRawInput,
  effectiveAgentPermission,
  hashAgentConfigFiles,
  isForbiddenAgentMode,
} from '../../src/agent/external/permission-bridge.js';
import { neutralizeUntrusted } from '../../src/infra/data-boundary.js';
import {
  selectPermissionOption,
  type AcpRequestPermissionRequest,
} from '../../src/agent/external/acp/client.js';
import {
  claudeProvider,
  claudeModeForTier,
  claudeSandboxSettings,
} from '../../src/agent/external/providers/claude.js';
import { codexModeForTier, codexProvider } from '../../src/agent/external/providers/codex.js';
import { genericAcpProvider } from '../../src/agent/external/providers/generic-acp.js';
import {
  agentToolTouchesDataDir,
  agentToolUnattendedRefusal,
  commandTouchesDataDir,
  unattendedCommandVerdict,
} from '../../src/permissions/approvals.js';
import { defaultBridgeToolFromCall } from '../../src/agent/external/acp/client.js';
import { matchAllowlistCommand } from '../../src/permissions/allowlist-match.js';
import { BUILTIN_PATTERNS } from '../../src/permissions/allowlist.js';

/**
 * 权限桥（D72 P3，design 28 §6）的纯逻辑：请求分级、optionId 白名单、档位、
 * 模式过滤、无人值守底线（workspace / 技能目录除外）与桥的路径优先级。
 */

const root = mkdtempSync(path.join(tmpdir(), 'perm-bridge-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CLAUDE_OPTIONS = [
  { optionId: 'allow-with-updates', name: 'Always', kind: 'allow_always' as const },
  { optionId: 'exit-plan-default', name: 'Exit plan', kind: 'allow_once' as const },
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' as const },
  { optionId: 'reject', name: 'No', kind: 'reject_once' as const },
];
const CODEX_OPTIONS = [
  { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' as const },
  { optionId: 'allow_for_session', name: 'Session', kind: 'allow_always' as const },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' as const },
  { optionId: 'decline', name: 'No', kind: 'reject_once' as const },
];

describe('option selection (optionId whitelist)', () => {
  it('Claude: allow-once / reject; never allow-with-updates nor exit-plan-*', () => {
    expect(selectPermissionOption(CLAUDE_OPTIONS, claudeProvider, 'allow').response).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(selectPermissionOption(CLAUDE_OPTIONS, claudeProvider, 'reject').response).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    // Only a mode-switching allow_once offered: allowing degrades to reject.
    const planOnly = CLAUDE_OPTIONS.filter((o) => o.optionId !== 'allow-once');
    expect(selectPermissionOption(planOnly, claudeProvider, 'allow')).toMatchObject({
      decision: 'rejected',
      response: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });
  });

  it('Codex: allow_once; reject prefers decline over cancel (whitelist order)', () => {
    expect(selectPermissionOption(CODEX_OPTIONS, codexProvider, 'allow').response).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(selectPermissionOption(CODEX_OPTIONS, codexProvider, 'reject').response).toEqual({
      outcome: { outcome: 'selected', optionId: 'decline' },
    });
  });

  it('nothing usable → cancelled', () => {
    const always = [{ optionId: 'x', name: 'x', kind: 'allow_always' as const }];
    expect(selectPermissionOption(always, genericAcpProvider, 'allow')).toEqual({
      response: { outcome: { outcome: 'cancelled' } },
      decision: 'cancelled',
    });
  });
});

describe('agent config hash (review round 2)', () => {
  it('stable for the same content; links out of the project and oversized trees never match', () => {
    const project = mkdtempSync(path.join(root, 'cfg-'));
    writeFileSync(path.join(project, 'AGENTS.md'), 'v1');
    mkdirSync(path.join(project, '.codex'));
    writeFileSync(path.join(project, '.codex', 'config.toml'), 'a=1');
    const first = hashAgentConfigFiles(project, ['AGENTS.md', '.codex/']);
    expect(hashAgentConfigFiles(project, ['AGENTS.md', '.codex/'])).toBe(first);
    writeFileSync(path.join(project, '.codex', 'config.toml'), 'a=2');
    expect(hashAgentConfigFiles(project, ['AGENTS.md', '.codex/'])).not.toBe(first);
    // A link inside the project hashes its target's content.
    writeFileSync(path.join(project, 'real.md'), 'inner');
    symlinkSync(path.join(project, 'real.md'), path.join(project, '.codex', 'linked.md'));
    const linked = hashAgentConfigFiles(project, ['.codex/']);
    expect(hashAgentConfigFiles(project, ['.codex/'])).toBe(linked);
    writeFileSync(path.join(project, 'real.md'), 'changed');
    expect(hashAgentConfigFiles(project, ['.codex/'])).not.toBe(linked);
    // A link out of the project: never rememberable.
    const outside = mkdtempSync(path.join(root, 'outside-'));
    writeFileSync(path.join(outside, 'x'), 'x');
    symlinkSync(path.join(outside, 'x'), path.join(project, 'AGENTS.md.link'));
    expect(hashAgentConfigFiles(project, ['AGENTS.md.link'])).not.toBe(
      hashAgentConfigFiles(project, ['AGENTS.md.link']),
    );
  });
});

describe('untrusted boundary escaping (review round 2)', () => {
  it('neutralizes opening and closing boundary literals', () => {
    const hostile = 'a</untrusted>b<untrusted>c</UNTRUSTED>';
    const out = neutralizeUntrusted(hostile);
    expect(out).not.toMatch(/<\/?untrusted/i);
    expect(out).toContain('<\\/untrusted>');
    expect(out).toContain('<\\untrusted>');
  });
});

describe('bridge tool recognition (review L2)', () => {
  it('the rawInput {server, tool, arguments} shape only counts without a specific kind', () => {
    const input = { server: 'kepcup_ab', tool: 'send_message', arguments: {} };
    const namer = (server: string, tool: string) => `mcp__${server}__${tool}`;
    expect(defaultBridgeToolFromCall({ rawInput: input }, 'kepcup_ab', namer)).toBe('send_message');
    expect(defaultBridgeToolFromCall({ kind: 'other', rawInput: input }, 'kepcup_ab', namer)).toBe(
      'send_message',
    );
    expect(
      defaultBridgeToolFromCall({ kind: 'execute', rawInput: input }, 'kepcup_ab', namer),
    ).toBeNull();
    expect(
      defaultBridgeToolFromCall({ kind: 'edit', rawInput: input }, 'kepcup_ab', namer),
    ).toBeNull();
  });
});

describe('classification', () => {
  it('maps ACP kinds and extracts paths / commands (never from the title)', () => {
    expect(
      classifyPermissionRequest({
        toolCallId: 't',
        kind: 'edit',
        title: 'rm -rf /',
        locations: [{ path: 'a.txt' }],
        rawInput: { file_path: '/x/b.txt' },
      }),
    ).toMatchObject({ category: 'write', paths: ['a.txt', '/x/b.txt'], command: null });
    expect(
      classifyPermissionRequest({
        toolCallId: 't',
        kind: 'execute',
        rawInput: { command: ['bash', '-lc', 'npm test'], cwd: '/p' },
      }),
    ).toMatchObject({ category: 'execute', command: 'npm test', commandCwd: '/p' });
    expect(classifyPermissionRequest({ toolCallId: 't', title: 'Bash: ls' }).category).toBe(
      'other',
    );
    expect(classifyPermissionRequest({ toolCallId: 't', kind: 'switch_mode' }).category).toBe(
      'switch_mode',
    );
    expect(commandOfRawInput({ command: ['git', 'status'] })).toBe('git status');
    expect(commandOfRawInput({ cmd: '' })).toBeNull();
  });
});

describe('tiers and modes', () => {
  it('Windows forces ask for the workspace tier; other tiers / platforms unchanged', () => {
    expect(effectiveAgentPermission('workspace', claudeProvider, 'win32')).toBe('ask');
    expect(effectiveAgentPermission('read_only', claudeProvider, 'win32')).toBe('read_only');
    expect(effectiveAgentPermission('workspace', claudeProvider, 'linux')).toBe('workspace');
    expect(effectiveAgentPermission('workspace', genericAcpProvider, 'darwin')).toBe('workspace');
  });

  it('forbidden modes never pass the host filter', () => {
    for (const mode of [
      'bypassPermissions',
      'dontAsk',
      'auto',
      'agent-full-access',
      'agent',
      'yolo',
    ]) {
      expect(isForbiddenAgentMode(mode)).toBe(true);
    }
    for (const mode of ['default', 'acceptEdits', 'read-only', 'workspace-write', 'plan']) {
      expect(isForbiddenAgentMode(mode)).toBe(false);
    }
  });

  it('Claude: acceptEdits only for workspace; native sandbox always on, no escape', () => {
    expect(claudeModeForTier('workspace')).toBe('acceptEdits');
    expect(claudeModeForTier('ask')).toBe('default');
    expect(claudeModeForTier('read_only')).toBe('default');
    const isolation = {
      dataHome: '/h/.kepcup',
      denyRead: ['/h/.kepcup'],
      allowRead: ['/h/.kepcup/bots/b/workspaces/c'],
      denyWrite: ['/h/.kepcup'],
    };
    expect(claudeSandboxSettings('workspace', isolation)).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ['/h/.kepcup'],
        allowRead: ['/h/.kepcup/bots/b/workspaces/c'],
        denyWrite: ['/h/.kepcup'],
      },
    });
    expect(claudeSandboxSettings('ask')).toMatchObject({
      autoAllowBashIfSandboxed: false,
      failIfUnavailable: true,
    });
    const entry = AGENT_CATALOG.find((e) => e.id === 'claude-acp')!;
    const meta = claudeProvider.sessionNew({
      entry,
      cwd: '/p',
      permission: 'workspace',
      capabilities: [],
      sessionPrompt: null,
      maxTurns: 10,
      loadUserConfig: false,
      isolation,
    })._meta as { claudeCode: { options: Record<string, unknown> } };
    const keys = Object.keys(meta.claudeCode.options);
    // Host-enforced keys stay last.
    expect(keys.slice(-3)).toEqual([
      'sandbox',
      'settingSources',
      'allowDangerouslySkipPermissions',
    ]);
    expect(
      claudeProvider.execSandboxed?.({
        rawInput: { command: 'ls', dangerouslyDisableSandbox: true },
      }),
    ).toBe(false);
    expect(claudeProvider.execSandboxed?.({ rawInput: { command: 'ls' } })).toBe(true);
  });

  it('Codex: ask uses read-only (every write asks); commands are never treated as sandboxed', () => {
    expect(codexModeForTier('workspace')).toBe('workspace-write');
    expect(codexModeForTier('ask')).toBe('read-only');
    expect(codexModeForTier('read_only')).toBe('read-only');
    expect(codexProvider.execSandboxed?.({ rawInput: { command: 'ls' } })).toBe(false);
  });
});

describe('unattended data-directory floor (agent_tool)', () => {
  const home = '/home/u/.kepcup';
  const ws = '/home/u/.kepcup/bots/b/workspaces/c';
  const skill = '/home/u/.kepcup/skills-library/s@1';
  it('exempts the workspace / skill dirs, refuses the rest of the data dir', () => {
    const payload = (extra: Record<string, unknown>) => ({ exemptDirs: [ws, skill], ...extra });
    expect(agentToolTouchesDataDir(payload({ locations: [`${ws}/a.txt`] }), home, '/home/u')).toBe(
      false,
    );
    expect(
      agentToolTouchesDataDir(payload({ locations: [`${home}/main.db`] }), home, '/home/u'),
    ).toBe(true);
    expect(agentToolTouchesDataDir(payload({ locations: ['/home/u'] }), home, '/home/u')).toBe(
      true,
    );
    expect(
      agentToolTouchesDataDir(
        payload({ command: `cat ${skill}/SKILL.md`, cwd: ws }),
        home,
        '/home/u',
      ),
    ).toBe(false);
    expect(
      agentToolTouchesDataDir(
        payload({ command: `cp ${ws}/../../../../main.db /tmp`, cwd: ws }),
        home,
        '/home/u',
      ),
    ).toBe(true);
    expect(
      agentToolTouchesDataDir(
        payload({ command: 'cat $HOME/.kepcup/runs.db', cwd: ws }),
        home,
        '/home/u',
      ),
    ).toBe(true);
    expect(
      agentToolTouchesDataDir(
        payload({ command: `touch --target=${ws}/x`, cwd: ws }),
        home,
        '/home/u',
      ),
    ).toBe(false);
    expect(
      agentToolTouchesDataDir(payload({ command: 'npm test', cwd: ws }), home, '/home/u'),
    ).toBe(false);
    // Round 2: without a known cwd a command cannot be vouched for.
    expect(agentToolTouchesDataDir(payload({ command: 'npm test' }), home, '/home/u')).toBe(true);
  });

  it('review H3: relative tokens resolve against the command cwd; the cwd itself counts', () => {
    const payload = (extra: Record<string, unknown>) => ({ exemptDirs: [ws, skill], ...extra });
    // From the workspace, climbing out reaches the rest of the data dir.
    expect(
      agentToolTouchesDataDir(
        payload({ command: 'rm -rf ../../../skills', cwd: ws }),
        home,
        '/home/u',
        'linux',
      ),
    ).toBe(true);
    expect(
      agentToolTouchesDataDir(
        payload({ command: 'cat ./notes.md', cwd: ws }),
        home,
        '/home/u',
        'linux',
      ),
    ).toBe(false);
    expect(
      agentToolTouchesDataDir(
        payload({ command: 'cd .. && ls', cwd: ws }),
        home,
        '/home/u',
        'linux',
      ),
    ).toBe(true);
    // Codex `workdir = ~/.kepcup` + `rm main.db`.
    expect(
      agentToolTouchesDataDir(
        payload({ command: 'rm main.db', cwd: home }),
        home,
        '/home/u',
        'linux',
      ),
    ).toBe(true);
    // A project cwd elsewhere: relative tokens stay outside.
    expect(
      agentToolTouchesDataDir(
        payload({ command: 'rm -rf build', cwd: '/srv/proj' }),
        home,
        '/home/u',
        'linux',
      ),
    ).toBe(false);
    expect(
      agentToolTouchesDataDir(
        payload({ command: 'cat --file=../../home/u/.kepcup/main.db', cwd: '/srv/proj' }),
        home,
        '/home/u',
        'linux',
      ),
    ).toBe(true);
  });

  it('review L5: case-insensitive platforms, ~user and 8.3 short names fail closed', () => {
    expect(
      commandTouchesDataDir('cat /Home/U/.KEPCUP/main.db', home, '/home/u', [], {
        platform: 'darwin',
      }),
    ).toBe(true);
    expect(
      commandTouchesDataDir('cat /Home/U/.KEPCUP/main.db', home, '/home/u', [], {
        platform: 'linux',
      }),
    ).toBe(false);
    expect(commandTouchesDataDir('cat ~u/.kepcup/main.db', home, '/home/u')).toBe(true);
    expect(
      commandTouchesDataDir(
        'type C:/Users/u/KEPCUP~1/main.db',
        'C:/Users/u/.kepcup',
        'C:/Users/u',
        [],
        { platform: 'win32' },
      ),
    ).toBe(true);
    expect(
      commandTouchesDataDir('git show HEAD~1', home, '/home/u', [], { platform: 'win32' }),
    ).toBe(false);
  });

  it('review round 2: every reported bypass is refused (fail closed)', () => {
    // A real tree so symlinks resolve: <root>/u/.kepcup/bots/b/workspaces/c.
    const userHome = path.join(root, 'u');
    const dataHome = path.join(userHome, '.kepcup');
    const workspace = path.join(dataHome, 'bots', 'b', 'workspaces', 'c');
    const project = path.join(userHome, 'proj');
    mkdirSync(path.join(workspace, 's', 't'), { recursive: true });
    mkdirSync(path.join(project, 'sub'), { recursive: true });
    if (!existsSync(path.join(workspace, 'l'))) symlinkSync(dataHome, path.join(workspace, 'l'));
    const verdict = (command: string, cwd: string) =>
      unattendedCommandVerdict(command, {
        dataHome,
        homeDir: userHome,
        cwd,
        exemptDirs: [workspace],
        platform: 'linux',
      });
    const bypasses: Array<[string, string]> = [
      ['mkdir -p s/t; cd s/t && rm -rf ../../../../../../skills', workspace],
      ['env -C s rm ../../../../../x', workspace],
      ['rm ../../../../main.db', workspace],
      ['cd sub && rm ../../.kepcup/main.db', project],
      ["cat ~/.kep'cup'/main.db", project],
      [`cat ${userHome}/.kep""cup/main.db`, project],
      ['cat ~/.kep*/main.db', project],
      [`cat ${userHome}/.kepcu?/main.db`, project],
      ['cat l/main.db', workspace],
      ['cp x "$HOME"/.kepcup/a', project],
      ['cat ~/.kepcup/main.db', project],
      ['git -C ../.. status', project],
      ['make --directory=/tmp', project],
      ['bash -c "rm x"', project],
      ['xargs rm < list', project],
      ['cat {a,b}', project],
      ['cat ~root/x', project],
      ['FOO=1 ls', project],
      ['(cd .. && ls)', project],
      ['rm x', dataHome],
    ];
    for (const [command, cwd] of bypasses) {
      expect({ command, safe: verdict(command, cwd).safe }).toEqual({ command, safe: false });
    }
    for (const [command, cwd] of [
      ['npm test', project],
      ['git status', project],
      ['ls -la', workspace],
      ['cat notes.md | grep x > out.txt', workspace],
      ['rm -rf build && mkdir build', project],
    ] as Array<[string, string]>) {
      expect({ command, safe: verdict(command, cwd).safe }).toEqual({ command, safe: true });
    }
  });

  it('review round 2: a write whose target the agent hides is never auto-approved', () => {
    expect(
      agentToolUnattendedRefusal({ kind: 'write', locations: ['/p/a'], targetUncertain: true }),
    ).toBe(true);
  });

  it('review M1: unattended never approves what it cannot judge', () => {
    expect(agentToolUnattendedRefusal({ kind: 'other', locations: ['/x'] })).toBe(true);
    expect(agentToolUnattendedRefusal({ kind: 'write', locations: [] })).toBe(true);
    expect(agentToolUnattendedRefusal({ kind: 'write', locations: ['/x'] })).toBe(false);
    expect(agentToolUnattendedRefusal({ kind: 'execute', command: 'ls' })).toBe(false);
  });

  it('without exemptions commandTouchesDataDir keeps its old behaviour', () => {
    expect(commandTouchesDataDir(`ls ${ws}`, home, '/home/u')).toBe(true);
    expect(commandTouchesDataDir('ls /tmp', home, '/home/u')).toBe(false);
  });
});

describe('AgentPermissionBridge decisions', () => {
  const paths = resolvePaths(path.join(root, 'home'));
  const workspace = path.join(paths.home, 'bots', 'bot_a', 'workspaces', 'conv_a');
  const skillDir = path.join(paths.home, 'skills-library', 'demo@1');
  const project = path.join(root, 'project');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const identity = {
    runId: 'run_a',
    botId: 'bot_a',
    conversationId: 'conv_a',
    loopType: 'response' as const,
  };
  const requested: Array<Record<string, unknown>> = [];
  let answer: 'approved' | 'denied' | 'cancelled' = 'denied';
  let gatewayKind: 'needs_grant' | 'needs_lease' = 'needs_grant';
  const bridge = new AgentPermissionBridge({
    paths,
    redact: (text) => text.replaceAll('sk-SECRET', '[REDACTED]'),
    gateway: {
      checkPath: (_identity, input) =>
        gatewayKind === 'needs_lease'
          ? { kind: 'needs_lease', resolvedPath: input, reason: 'project 写入需要先取得写入租约' }
          : {
              kind: 'needs_grant',
              resolvedPath: input,
              reason: '位于当前 workspace 与系统目录之外',
              sensitive: false,
            },
      audit: () => undefined,
      workspacePath: () => workspace,
    },
    approvals: {
      request: async (_identity, _kind, payload) => {
        requested.push(payload);
        return {
          decision: answer,
          approval: { id: 'apr_1', autoApproved: false, decision: null } as unknown as Approval,
        };
      },
      publishEvent: () => undefined,
    },
    grants: {
      create: () => ({}) as never,
      listActive: () => [],
      hasEffectiveGrant: () => null,
    },
    allowlist: {
      match: (command, ctx) =>
        matchAllowlistCommand(command, {
          platform: 'posix',
          entries: BUILTIN_PATTERNS.posix,
          ...ctx,
        }),
    },
    skillDirs: () => [skillDir],
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    platform: 'linux',
  });
  const entry = AGENT_CATALOG.find((e) => e.id === 'fake')!;
  const decide = (
    toolCall: AcpRequestPermissionRequest['toolCall'],
    tier: 'read_only' | 'workspace' | 'ask' = 'workspace',
    provider: typeof genericAcpProvider = genericAcpProvider,
    workdir = project,
  ) =>
    bridge.decide(
      {
        sessionId: 's',
        toolCall,
        options:
          provider === claudeProvider
            ? CLAUDE_OPTIONS
            : provider === codexProvider
              ? CODEX_OPTIONS
              : [
                  { optionId: 'allow_once', name: 'y', kind: 'allow_once' },
                  { optionId: 'reject_once', name: 'n', kind: 'reject_once' },
                ],
      },
      {
        identity,
        entry,
        provider,
        tier,
        workdir,
        signal: new AbortController().signal,
        bridge: null,
      },
    );

  it('path priority: cwd → skill dirs (read only) → data dir (refused) → gateway', async () => {
    requested.length = 0;
    expect(
      (await decide({ toolCallId: '1', kind: 'edit', locations: [{ path: 'src/a.ts' }] })).decision,
    ).toBe('allowed');
    expect(
      (await decide({ toolCallId: '2', kind: 'edit', locations: [{ path: `${workspace}/x` }] }))
        .decision,
    ).toBe('allowed');
    expect(
      (
        await decide({
          toolCallId: '3',
          kind: 'read',
          locations: [{ path: `${skillDir}/SKILL.md` }],
        })
      ).decision,
    ).toBe('allowed');
    expect(
      (
        await decide({
          toolCallId: '4',
          kind: 'edit',
          locations: [{ path: `${skillDir}/SKILL.md` }],
        })
      ).decision,
    ).toBe('rejected');
    expect(
      (await decide({ toolCallId: '5', kind: 'read', locations: [{ path: paths.mainDbPath }] }))
        .decision,
    ).toBe('rejected');
    // Traversal out of the cwd into the data dir is normalized first.
    expect(
      (
        await decide(
          {
            toolCallId: '6',
            kind: 'read',
            locations: [{ path: `${workspace}/../../../../main.db` }],
          },
          'workspace',
          genericAcpProvider,
          workspace,
        )
      ).decision,
    ).toBe('rejected');
    expect(requested).toEqual([]);
    // Outside everything: the gateway says needs_grant → a card (denied here).
    expect(
      (await decide({ toolCallId: '7', kind: 'edit', locations: [{ path: '/etc/hosts' }] }))
        .decision,
    ).toBe('rejected');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ kind: 'write', durations: ['once', 'conversation'] });
  });

  it('tiers inside the cwd: read_only refuses, ask confirms', async () => {
    requested.length = 0;
    expect(
      (await decide({ toolCallId: 'r', kind: 'edit', locations: [{ path: 'a' }] }, 'read_only'))
        .decision,
    ).toBe('rejected');
    expect(requested).toEqual([]);
    answer = 'approved';
    expect(
      (await decide({ toolCallId: 'a', kind: 'edit', locations: [{ path: 'a' }] }, 'ask')).decision,
    ).toBe('allowed');
    expect(requested[0]).toMatchObject({ reason: expect.stringContaining('每次确认') });
    answer = 'denied';
  });

  it('commands: allowlist only inside a provider-confirmed sandbox; otherwise a once-only card', async () => {
    requested.length = 0;
    // Review H2: without a confirmed sandbox the allowlist would run the
    // command outside any sandbox — read_only refuses even `ls`.
    expect(
      (
        await decide(
          { toolCallId: 'ls', kind: 'execute', rawInput: { command: 'ls src' } },
          'read_only',
        )
      ).decision,
    ).toBe('rejected');
    expect(
      (
        await decide(
          { toolCallId: 'ls-codex', kind: 'execute', rawInput: { command: 'ls src' } },
          'read_only',
          codexProvider,
        )
      ).decision,
    ).toBe('rejected');
    // Claude confirms its sandbox: the allowlist applies in read_only.
    expect(
      (
        await decide(
          { toolCallId: 'ls-claude', kind: 'execute', rawInput: { command: 'ls src' } },
          'read_only',
          claudeProvider,
        )
      ).decision,
    ).toBe('allowed');
    // Allowlisted command reaching into the data dir is not exempt.
    expect(
      (
        await decide(
          { toolCallId: 'cat', kind: 'execute', rawInput: { command: `cat ${paths.mainDbPath}` } },
          'read_only',
          claudeProvider,
        )
      ).decision,
    ).toBe('rejected');
    // rg --pre runs a program: not read-only.
    expect(
      (
        await decide(
          { toolCallId: 'rg', kind: 'execute', rawInput: { command: 'rg --pre=./evil x' } },
          'read_only',
          claudeProvider,
        )
      ).decision,
    ).toBe('rejected');
    expect(
      (
        await decide(
          { toolCallId: 'npm', kind: 'execute', rawInput: { command: 'npm test' } },
          'read_only',
        )
      ).decision,
    ).toBe('rejected');
    expect(requested).toEqual([]);
    // Review H3: a working directory in the data dir (outside workspace /
    // skills) is refused outright, even in the workspace tier.
    expect(
      (
        await decide(
          {
            toolCallId: 'home',
            kind: 'execute',
            rawInput: { command: 'rm main.db', cwd: paths.home },
          },
          'workspace',
          claudeProvider,
        )
      ).decision,
    ).toBe('rejected');
    expect(
      (
        await decide(
          {
            toolCallId: 'up',
            kind: 'execute',
            rawInput: { command: 'ls', cwd: `${workspace}/../..` },
          },
          'workspace',
          claudeProvider,
        )
      ).decision,
    ).toBe('rejected');
    expect(requested).toEqual([]);
    // Claude confirms the sandbox; workspace tier passes without a card.
    expect(
      (
        await decide(
          { toolCallId: 'c', kind: 'execute', rawInput: { command: 'npm test' } },
          'workspace',
          claudeProvider,
        )
      ).decision,
    ).toBe('allowed');
    expect(requested).toEqual([]);
    // Codex never reports sandboxed commands → card.
    await decide(
      { toolCallId: 'x', kind: 'execute', rawInput: { command: 'npm test' } },
      'workspace',
      codexProvider,
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      kind: 'execute',
      command: 'npm test',
      durations: ['once'],
    });
  });

  it('think passes, switch_mode is refused, unknown kinds raise a card (read_only refuses them)', async () => {
    requested.length = 0;
    expect((await decide({ toolCallId: 't', kind: 'think' })).decision).toBe('allowed');
    expect((await decide({ toolCallId: 'm', kind: 'switch_mode' })).decision).toBe('rejected');
    // Review M1: read_only fails closed on what it cannot judge.
    expect((await decide({ toolCallId: 'o-ro', title: 'mystery' }, 'read_only')).decision).toBe(
      'rejected',
    );
    expect((await decide({ toolCallId: 'w-ro', kind: 'edit' }, 'read_only')).decision).toBe(
      'rejected',
    );
    expect((await decide({ toolCallId: 'x-ro', kind: 'execute' }, 'read_only')).decision).toBe(
      'rejected',
    );
    expect(requested).toEqual([]);
    await decide({ toolCallId: 'o', title: 'mystery' });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ kind: 'other', title: 'mystery' });
  });

  it('review H1: Codex writes always confirm; diff content and move targets count as paths; .git and agent config confirm', async () => {
    requested.length = 0;
    // A Codex patch request whose visible paths are all in the cwd.
    await decide(
      { toolCallId: 'cx', kind: 'edit', locations: [{ path: 'src/a.ts' }] },
      'workspace',
      codexProvider,
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ kind: 'write', reason: expect.stringContaining('沙箱') });
    // A move target outside the cwd (rawInput / diff content) is judged too.
    await decide({
      toolCallId: 'mv',
      kind: 'move',
      locations: [{ path: 'a.txt' }],
      rawInput: { move_path: '/etc/evil' },
      content: [{ type: 'diff', path: '/opt/other.txt', oldText: null, newText: 'x' }],
    });
    expect(requested[1]).toMatchObject({ locations: ['/opt/other.txt', '/etc/evil'] });
    // The repository's .git and the agent's own config files never pass silently.
    await decide({
      toolCallId: 'hook',
      kind: 'edit',
      locations: [{ path: '.git/hooks/pre-commit' }],
    });
    expect(requested[2]).toMatchObject({
      sensitive: true,
      reason: expect.stringContaining('.git'),
    });
    await decide({ toolCallId: 'cfg', kind: 'edit', locations: [{ path: 'AGENTS.md' }] });
    expect(requested[3]).toMatchObject({
      sensitive: true,
      reason: expect.stringContaining('配置'),
    });
    expect(requested).toHaveLength(4);
  });

  it('review round 2: hidden Codex write targets and unanalyzable commands are flagged on the card', async () => {
    requested.length = 0;
    await decide(
      { toolCallId: 'cx2', kind: 'edit', locations: [{ path: 'a.ts' }] },
      'workspace',
      codexProvider,
    );
    expect(requested[0]).toMatchObject({
      targetUncertain: true,
      reason: expect.stringContaining('真实写入目标可能与显示的路径不同'),
      // P4-B review #9: an uncertain target is never granted for the conversation.
      durations: ['once'],
    });
    await decide({ toolCallId: 'cdx', kind: 'execute', rawInput: { command: 'cd .. && rm x' } });
    expect(String(requested[1]!['reason'])).toContain('无法静态分析');
    await decide({ toolCallId: 'ok', kind: 'execute', rawInput: { command: 'npm test' } });
    expect(String(requested[2]!['reason'])).not.toContain('无法静态分析');
  });

  it('review M5 / M6 / L1: deduplicated paths, no other lease target, redacted and capped card text', async () => {
    requested.length = 0;
    await decide({
      toolCallId: 'dup',
      kind: 'edit',
      locations: [{ path: '/etc/x.conf' }, { path: '/etc/../etc/x.conf' }],
    });
    expect(requested[0]).toMatchObject({ locations: ['/etc/x.conf'] });
    gatewayKind = 'needs_lease';
    expect(
      (
        await decide({
          toolCallId: 'lease',
          kind: 'edit',
          locations: [{ path: '/srv/other-project/a' }],
        })
      ).decision,
    ).toBe('rejected');
    gatewayKind = 'needs_grant';
    expect(requested).toHaveLength(1);
    const long = `curl -H "Authorization: sk-SECRET" ${'x'.repeat(5000)}`;
    await decide({
      toolCallId: 'long',
      kind: 'execute',
      title: 't'.repeat(500),
      rawInput: { command: long },
    });
    const payload = requested[1]!;
    expect(String(payload['command'])).not.toContain('sk-SECRET');
    expect(String(payload['command']).length).toBeLessThan(2_100);
    expect(String(payload['title']).length).toBeLessThan(260);
  });

  it('isolation: the data dir is unreadable except workspace / skills; toolchains never writable', () => {
    const inside = bridge.isolationFor(identity, workspace);
    expect(inside.denyRead).toEqual([paths.home]);
    expect(inside.allowRead).toEqual(expect.arrayContaining([workspace, skillDir]));
    expect(inside.denyWrite).toContain(paths.toolchainsDir);
    expect(inside.denyWrite).not.toContain(paths.home);
    expect(bridge.isolationFor(identity, project).denyWrite).toEqual([paths.home]);
  });
});

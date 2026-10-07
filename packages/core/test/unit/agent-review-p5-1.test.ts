import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG, agentModelRef, type AgentCatalogEntry } from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentEntry,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import { chmodInstalledFiles } from '../../src/agent/external/installer.js';
import {
  FORBIDDEN_AGENT_MODES,
  type AgentPermissionHandler,
} from '../../src/agent/external/permission-bridge.js';
import { PROVIDERS } from '../../src/agent/external/providers/index.js';
import { cursorConfigDir, cursorProvider } from '../../src/agent/external/providers/cursor.js';
import { isDshMissingApiKey } from '../../src/agent/external/providers/dsh.js';
import type { AcpRequestPermissionRequest } from '../../src/agent/external/acp/client.js';
import { ensureAgentProcessCwd, resolvePaths } from '../../src/infra/paths.js';

/**
 * P5 第一部分独立审查（REQUEST CHANGES）的修复回归：Provider 注册表不变量
 * （safeModes ⊆ 全局禁止表、只有 Cursor 豁免 `agent`）、Cursor 私有配置目录、
 * dsh 只带 id 的权限请求由引擎补全（H2）、dsh 错误匹配收窄、安装后 chmod 的
 * 窄化钩子（H3）、Agent 进程私有 cwd（M1）。OpenCode 的配置层覆盖（H1）在
 * agent-providers-p5.test.ts，project 配置确认向上到 git 根在
 * integration/external-agent-p3.test.ts。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const dirs: string[] = [];
const hosts: AgentHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('provider registry invariants (M2)', () => {
  it('safeModes only exempt names of the global forbidden table; only Cursor exempts `agent`', () => {
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      for (const mode of provider.safeModes ?? []) {
        expect(FORBIDDEN_AGENT_MODES.has(mode), `${id}:${mode}`).toBe(true);
        expect(provider.forbiddenModes ?? [], `${id}:${mode}`).not.toContain(mode);
      }
    }
    const exempting = Object.entries(PROVIDERS)
      .filter(([, provider]) => (provider.safeModes ?? []).length > 0)
      .map(([id, provider]) => [id, provider.safeModes]);
    expect(exempting).toEqual([['cursor', ['agent']]]);
  });

  it('Cursor ignores the user CLI config (command allowlist) unless asked to load it', () => {
    const entry = AGENT_CATALOG.find((candidate) => candidate.id === 'cursor')!;
    const target = { command: '/x/agent', args: ['acp'], env: { CURSOR_API_KEY: 'k' } };
    const isolated = cursorProvider.launch({
      entry,
      target,
      platform: 'linux',
      stateDir: '/d/agents/cursor',
    });
    expect(isolated.env).toMatchObject({
      CURSOR_API_KEY: 'k',
      CURSOR_CONFIG_DIR: cursorConfigDir('/d/agents/cursor'),
    });
    const user = cursorProvider.launch({ entry, target, platform: 'linux', loadUserConfig: true });
    expect(user.env.CURSOR_CONFIG_DIR).toBeUndefined();
    expect(() => cursorProvider.launch({ entry, target, platform: 'linux' })).toThrow(
      /私有状态目录/,
    );
  });
});

describe('DeepSeek Harness (H2 / LOW)', () => {
  it('only the exact "no API key for provider route" -32603 counts as not logged in', () => {
    expect(
      isDshMissingApiKey({
        code: -32603,
        message: 'no API key for provider route "deepseek-official"',
      }),
    ).toBe(true);
    expect(isDshMissingApiKey({ code: -32603, message: 'tool said: No API key here' })).toBe(false);
    expect(isDshMissingApiKey({ code: -32000, message: 'no API key for provider route x' })).toBe(
      false,
    );
  });

  it('a permission request carrying only the id is completed from the call updates', async () => {
    const entry: AgentCatalogEntry = fakeAgentEntry('fake-dsh', { provider: 'dsh' });
    const workdir = tempDir('kepcup-h2-');
    const started: FakeAcpAgentHandle[] = [];
    const script: FakeAgentScript = {
      turns: [
        agentTurn()
          .toolCall('w1', 'Write notes.md', {
            kind: 'edit',
            input: { path: 'notes.md', content: 'x' },
          })
          .permission('w1', 'ignored', {
            bare: true,
            options: [
              { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          })
          .toolResult('w1', 'written')
          .text('ok'),
      ],
    };
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner({ [entry.id]: script }, started) as never,
    });
    hosts.push(host);
    const seen: AcpRequestPermissionRequest[] = [];
    const permissions: AgentPermissionHandler = {
      decide: async (request) => {
        seen.push(request);
        return {
          response: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
          decision: 'rejected',
        };
      },
      isolationFor: () => ({ dataHome: '/d', denyRead: [], allowRead: [], denyWrite: [] }),
      audit: () => {},
    };
    const engine = new ExternalAgentEngine({
      host,
      permissions,
      catalog: () => [entry],
      logger,
    });
    const outcome = await engine.startRun({
      identity: { runId: 'run_h2', botId: 'b', conversationId: 'c', loopType: 'response' },
      model: agentModelRef(entry.id, ''),
      buildSystemPrompt: async () => 'S',
      messages: [{ role: 'user', content: 'go', timestamp: 0 }],
      tools: [],
      limits: { maxTurns: 10 },
      workdir,
      external: { agentId: entry.id, permission: 'ask', capabilities: [], sessionKey: 'b:c:dsh' },
    }).done;
    expect(outcome.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolCall).toMatchObject({
      toolCallId: 'w1',
      kind: 'edit',
      title: 'Write notes.md',
      rawInput: { path: 'notes.md', content: 'x' },
    });
    expect(started[0]!.observed.permissions[0]).toEqual({
      toolCallId: 'w1',
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
  });
});

describe('narrow post-install chmod (H3)', () => {
  it('marks matching regular files executable; links, directories and escapes are skipped', () => {
    if (process.platform === 'win32') return;
    const root = tempDir('kepcup-h3-');
    const outside = tempDir('kepcup-h3-out-');
    const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
    for (const platform of ['darwin-arm64', 'darwin-x64']) {
      mkdirSync(path.join(prebuilds, platform), { recursive: true });
      writeFileSync(path.join(prebuilds, platform, 'spawn-helper'), 'bin');
      chmodSync(path.join(prebuilds, platform, 'spawn-helper'), 0o644);
    }
    mkdirSync(path.join(prebuilds, 'linux-x64', 'spawn-helper'), { recursive: true });
    writeFileSync(path.join(outside, 'victim'), 'x');
    chmodSync(path.join(outside, 'victim'), 0o600);
    mkdirSync(path.join(prebuilds, 'evil'), { recursive: true });
    symlinkSync(path.join(outside, 'victim'), path.join(prebuilds, 'evil', 'spawn-helper'));
    // A symlinked directory leading out of the root.
    symlinkSync(outside, path.join(prebuilds, 'escape'));
    writeFileSync(path.join(outside, 'spawn-helper'), 'y');
    chmodSync(path.join(outside, 'spawn-helper'), 0o600);

    const changed = chmodInstalledFiles(root, 'node_modules/node-pty/prebuilds/*/spawn-helper');
    expect(changed).toBe(2);
    for (const platform of ['darwin-arm64', 'darwin-x64']) {
      expect(statSync(path.join(prebuilds, platform, 'spawn-helper')).mode & 0o777).toBe(0o755);
    }
    expect(statSync(path.join(outside, 'victim')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(outside, 'spawn-helper')).mode & 0o777).toBe(0o600);
    expect(chmodInstalledFiles(root, '../x')).toBe(0);
  });
});

describe('agent process cwd (M1)', () => {
  it('is a private per-agent directory, never the shared temp directory', async () => {
    const home = tempDir('kepcup-m1-');
    const paths = resolvePaths(home);
    const cwd = ensureAgentProcessCwd(paths, 'cursor');
    expect(cwd).toBe(path.join(paths.home, 'agents', 'cursor', 'cwd'));
    if (process.platform !== 'win32') expect(statSync(cwd).mode & 0o777).toBe(0o700);

    const entry = AGENT_CATALOG.find((candidate) => candidate.id === 'fake')!;
    const cwds: string[] = [];
    const spawner = fakeAgentSpawner({ fake: { turns: [agentTurn().text('ok')] } });
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: ((input: { entry: { id: string }; cwd: string }) => {
        cwds.push(input.cwd);
        return spawner(input);
      }) as never,
      processCwdFor: (agentId) => ensureAgentProcessCwd(paths, agentId),
    });
    hosts.push(host);
    const lease = await host.acquire(entry);
    lease.release();
    expect(cwds).toEqual([path.join(paths.home, 'agents', 'fake', 'cwd')]);
  });
});

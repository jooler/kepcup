import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, McpbInspectOutput, McpServer } from '@kepcup/shared';
import {
  buildMcpbFixture,
  createTestStack,
  makeBot,
  openDirect,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';

/**
 * MCPB（D73 P2 §6.5）集成：`mcpb.inspect` / `mcpb.install` RPC → 真实启动已安装的 stdio server
 * （McpService）→ 调工具 → `mcp.removeServer` 清理；经对话的安装走 environment 类审批卡。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<TestStack> {
  const stack = await createTestStack({
    mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } },
  });
  stacks.push(stack);
  return stack;
}

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcpb-int-'));
  dirs.push(dir);
  return dir;
}

const manifest = {
  server: {
    type: 'node',
    entry_point: 'server/index.cjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.cjs', '${user_config.label}'],
      env: { API_KEY: '${user_config.api_key}', STATIC: 'plain' },
    },
  },
  user_config: {
    api_key: { type: 'string', title: 'API Key', sensitive: true, required: true },
    label: { type: 'string', title: 'Label', default: 'lbl' },
  },
};

describe('mcpb integration', () => {
  it('installs a bundle through RPC, runs its tools via McpService, and removes it cleanly', async () => {
    const { core } = await setup();
    const fixture = await buildMcpbFixture({ dir: await fixtureDir(), manifest });

    const info = (await core.rpc.call('mcpb.inspect', { path: fixture.path })) as McpbInspectOutput;
    expect(info).toMatchObject({
      name: 'echo-bundle',
      sha256: fixture.sha256,
      compatible: true,
      runtime: { kind: 'node', available: true },
    });
    expect(info.launchCommand).toContain(`${process.execPath} ${info.installDir}/server/index.cjs`);
    expect(info.launchCommand).toContain('${user_config.api_key}');

    const { serverId } = (await core.rpc.call('mcpb.install', {
      path: fixture.path,
      sha256: info.sha256,
      userConfig: { api_key: 'sk-integration' },
    })) as { serverId: string };

    const services = core.services;
    const settings = services.domain!.settings.get();
    const server = settings.mcpServers.find((entry) => entry.id === serverId) as McpServer;
    expect(server).toMatchObject({
      transport: 'stdio',
      tier: 'developer',
      source: { kind: 'mcpb', name: 'echo-bundle', version: '1.0.0', sha256: fixture.sha256 },
      env: { API_KEY: 'secret:env:api_key', STATIC: 'plain' },
    });
    expect(JSON.stringify(settings)).not.toContain('sk-integration');
    expect(services.domain!.secrets.getValue(`mcp:${serverId}:env:api_key`)).toBe('sk-integration');

    const mcp = services.mcp!;
    const tools = await mcp.listTools(server);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['argv', 'echo', 'read_env']);
    const echo = await mcp.callTool(server, 'echo', { text: 'hi' });
    expect(echo.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    // The sensitive value reaches the process through the secret placeholder.
    const env = await mcp.callTool(server, 'read_env', { name: 'API_KEY' });
    expect(env.content).toEqual([{ type: 'text', text: 'env:sk-integration' }]);
    const argv = await mcp.callTool(server, 'argv', {});
    expect(argv.content).toEqual([{ type: 'text', text: 'argv:["lbl"]' }]);

    const dir = info.installDir;
    expect(existsSync(dir)).toBe(true);
    await core.rpc.call('mcp.removeServer', { serverId });
    expect(existsSync(dir)).toBe(false);
    expect(services.domain!.secrets.getValue(`mcp:${serverId}:env:api_key`)).toBeNull();
    expect(services.domain!.settings.get().mcpServers.some((entry) => entry.id === serverId)).toBe(
      false,
    );
  }, 60_000);

  it('dropping an mcpb server via settings.update also removes its extracted directory', async () => {
    const { core } = await setup();
    const fixture = await buildMcpbFixture({ dir: await fixtureDir(), manifest });
    const info = (await core.rpc.call('mcpb.inspect', { path: fixture.path })) as McpbInspectOutput;
    await core.rpc.call('mcpb.install', {
      path: fixture.path,
      sha256: info.sha256,
      userConfig: { api_key: 'sk-drop' },
    });
    expect(existsSync(info.installDir)).toBe(true);
    await core.rpc.call('settings.update', { mcpServers: [] });
    expect(existsSync(info.installDir)).toBe(false);
  });

  it('rejects a replaced file (sha256 mismatch) and incompatible bundles over RPC', async () => {
    const { core } = await setup();
    const dir = await fixtureDir();
    const fixture = await buildMcpbFixture({ dir, manifest });
    await expect(
      core.rpc.call('mcpb.install', {
        path: fixture.path,
        sha256: 'a'.repeat(64),
        userConfig: { api_key: 'x' },
      }),
    ).rejects.toThrow(/sha256 不符/);
    const mac = await buildMcpbFixture({
      dir,
      fileName: 'mac.mcpb',
      manifest: { compatibility: { platforms: ['plan9'] } },
    });
    const info = (await core.rpc.call('mcpb.inspect', { path: mac.path })) as McpbInspectOutput;
    expect(info.compatible).toBe(false);
    expect(info.incompatibleReason).toMatch(/只支持 plan9/);
    await expect(
      core.rpc.call('mcpb.install', { path: mac.path, sha256: mac.sha256 }),
    ).rejects.toThrow(/只支持 plan9/);
    expect(core.services.domain!.settings.get().mcpServers).toHaveLength(0);
  });

  it('a conversation-started install shows an environment approval card with the full command', async () => {
    const { core } = await setup();
    const fixture = await buildMcpbFixture({ dir: await fixtureDir(), manifest });
    const bot = await makeBot(core, '小包');
    const conv = await openDirect(core, bot.id);

    const install = core.rpc.call('mcpb.install', {
      path: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-card' },
      conversationId: conv.id,
    }) as Promise<{ serverId: string }>;

    const approval = await waitFor(async () => {
      const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
        approvals: Approval[];
      };
      return list.approvals.find((a) => a.kind === 'environment' && a.status === 'pending') ?? null;
    });
    const payload = approval.payload as Record<string, unknown>;
    expect(payload['item']).toBe('mcpb:echo-bundle');
    expect(payload['source']).toBe(fixture.path);
    expect(String(payload['reason'])).toContain(
      `${process.execPath} ${path.join(core.services.paths.toolchainsDir, 'mcpb', 'echo-bundle@1.0.0')}/server/index.cjs lbl`,
    );
    expect(String(payload['reason'])).toContain('API_KEY=***');
    expect(String(payload['reason'])).toContain(fixture.sha256);
    expect(JSON.stringify(payload)).not.toContain('sk-card');
    // Nothing is installed while the card is pending.
    expect(core.services.domain!.settings.get().mcpServers).toHaveLength(0);

    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const { serverId } = await install;
    expect(
      core.services.domain!.settings.get().mcpServers.some((entry) => entry.id === serverId),
    ).toBe(true);
  }, 60_000);

  it('unattended mode follows D41: the environment-kind card is auto-approved', async () => {
    const { core } = await setup();
    const fixture = await buildMcpbFixture({ dir: await fixtureDir(), manifest });
    const bot = await makeBot(core, '小无人');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    const { serverId } = (await core.rpc.call('mcpb.install', {
      path: fixture.path,
      sha256: fixture.sha256,
      userConfig: { api_key: 'sk-auto' },
      conversationId: conv.id,
    })) as { serverId: string };
    expect(serverId).toMatch(/^mcpb_/);
    const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    const card = list.approvals.find((a) => a.kind === 'environment')!;
    expect(card.autoApproved).toBe(true);
  }, 60_000);
});

import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@kepcup/shared';

import { AppAuditor } from '../../src/apps/audit.js';
import { AppConnectionsService } from '../../src/apps/connections.js';
import { AppConnectionStore, customConnectionId } from '../../src/apps/connection-store.js';
import { ToolLockService, type LockableTool } from '../../src/apps/tool-lock.js';
import { SettingsService } from '../../src/domain/settings.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

/**
 * `AppConnectionsService.enableAllTools`（插件 MCP 配置完成后的自动启用）：连接（listTools
 * 登记）→ 批准全部待复核 → 审计带 trigger。守卫：server 已删除（竞态）/ 停用 / OAuth 跳过；
 * 连接失败上抛且不批准。只直接接线 settings / toolLock / auditor / mcp.listTools 四个被触及
 * 的依赖，其余以桩填充（该服务其余方法不在本文件触达范围）。触发点行为见
 * materializer-mcp / plugin-projector-mcp 单测与 app-tool-lock 集成用例。
 */

let env: RealMainDb | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

const logger = { info() {}, warn() {} };

function toolOf(name: string): LockableTool {
  return { name, description: `${name} desc`, inputSchema: { type: 'object', properties: {} } };
}

function serverOf(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id,
    name: `server ${id}`,
    transport: 'stdio',
    command: 'node',
    enabled: true,
    autoApprove: false,
    ...overrides,
  } as McpServer;
}

function setup() {
  env = openRealMainDb();
  const store = new AppConnectionStore({ db: env.db, clock: env.clock });
  const settings = new SettingsService(env.db, env.clock);
  const lock = new ToolLockService({
    db: env.db,
    clock: env.clock,
    store,
    logger,
    settings,
    onStatus: () => undefined,
  });
  const auditRecords: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const auditor = new AppAuditor({
    sink: { recordSystem: (action, detail) => void auditRecords.push({ action, detail }) },
    redact: (text) => text,
  });
  return { settings, lock, auditor, auditRecords };
}

function serviceOf(
  parts: { settings: SettingsService; lock: ToolLockService; auditor: AppAuditor },
  listTools: (server: McpServer, opts: Record<string, unknown>) => Promise<unknown>,
): AppConnectionsService {
  return new AppConnectionsService({
    store: null,
    vault: null,
    catalog: null,
    preregistered: null,
    toolLock: parts.lock,
    grants: null,
    mcp: { listTools },
    registry: null,
    disconnector: { attachRowDeleted: () => undefined, disconnect: async () => undefined },
    auditor: parts.auditor,
    botGrants: null,
    bots: { get: () => null },
    settings: parts.settings,
    events: { emit: () => undefined },
    logger,
    clock: null,
  } as unknown as ConstructorParameters<typeof AppConnectionsService>[0]);
}

describe('AppConnectionsService.enableAllTools (plugin config auto-enable)', () => {
  it('配置在位：listTools 登记（countFailure:false + refresh:true）后批准全部待复核，审计带 trigger', async () => {
    const { settings, lock, auditor, auditRecords } = setup();
    const server = serverOf('srv_ok');
    settings.update({ mcpServers: [server] });
    const tools = [toolOf('echo'), toolOf('read_env')];
    const listToolsCalls: Array<{ server: McpServer; opts: Record<string, unknown> }> = [];
    const service = serviceOf({ settings, lock, auditor }, async (server, opts) => {
      listToolsCalls.push({ server, opts });
      // 真实 McpService.listTools 的语义：拉到清单即登记锁定（此处直接模拟登记）。
      lock.refresh(customConnectionId(server.id), tools, { server });
      return [];
    });

    const result = await service.enableAllTools({ serverId: 'srv_ok', trigger: 'plugin-install' });

    expect(listToolsCalls).toHaveLength(1);
    expect(listToolsCalls[0]!.server.id).toBe('srv_ok');
    expect(listToolsCalls[0]!.opts).toEqual({ countFailure: false, refresh: true });
    expect(result).toEqual({ approved: ['echo', 'read_env'], pending: { added: 0, changed: 0 } });
    expect(
      lock.list(customConnectionId('srv_ok')).map((row) => [row.toolName, row.state]),
    ).toEqual([
      ['echo', 'approved'],
      ['read_env', 'approved'],
    ]);
    expect(auditRecords).toEqual([
      {
        action: 'app_tools_review',
        detail: {
          connectionId: customConnectionId('srv_ok'),
          connector: customConnectionId('srv_ok'),
          approved: ['echo', 'read_env'],
          trigger: 'plugin-install',
        },
      },
    ]);
  });

  it('server 已删除（竞态）/ 停用 / OAuth：静默跳过，不连接也不批准', async () => {
    const { settings, lock, auditor } = setup();
    settings.update({
      mcpServers: [
        serverOf('srv_disabled', { enabled: false }),
        serverOf('srv_oauth', {
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          auth: 'oauth',
        }),
      ],
    });
    let calls = 0;
    const service = serviceOf({ settings, lock, auditor }, async () => {
      calls += 1;
      return [];
    });

    await expect(service.enableAllTools({ serverId: 'srv_gone', trigger: 'instance-create' })).resolves.toEqual({
      approved: [],
      pending: { added: 0, changed: 0 },
    });
    await expect(
      service.enableAllTools({ serverId: 'srv_disabled', trigger: 'instance-update' }),
    ).resolves.toEqual({ approved: [], pending: { added: 0, changed: 0 } });
    await expect(
      service.enableAllTools({ serverId: 'srv_oauth', trigger: 'plugin-install' }),
    ).resolves.toEqual({ approved: [], pending: { added: 0, changed: 0 } });
    expect(calls).toBe(0);
  });

  it('连接失败上抛，且不批准任何工具（保持锁定，手动复核兜底）', async () => {
    const { settings, lock, auditor, auditRecords } = setup();
    settings.update({ mcpServers: [serverOf('srv_bad')] });
    const service = serviceOf({ settings, lock, auditor }, async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      service.enableAllTools({ serverId: 'srv_bad', trigger: 'instance-create' }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(lock.list(customConnectionId('srv_bad'))).toEqual([]);
    expect(auditRecords).toEqual([]);
  });
});

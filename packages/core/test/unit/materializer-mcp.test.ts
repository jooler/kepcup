import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { McpServer, PluginManifest, PluginFieldValue, Settings } from '@kepcup/shared';

import {
  createMcpMaterializer,
  reconcileMcpInstanceRows,
} from '../../src/plugins/materializers/mcp.js';

/**
 * mcp 实例 materializer 的补偿与形态切换单测（P4-M2 审查补齐）：纯内存桩——
 * settings / secrets 是内存对象，create 冲突时 header secret 必须精确还原到
 * previousValue（既不丢也不写新值）；auth 形态切换重建 headers 记录并清理多余
 * secret；reconcile 清「实例行在、server 不见」的孤儿行。集成路径（真实 core、
 * RPC、级联卸载）见 plugins-instances.test.ts。
 */

const PLUGIN_ID = 'io.github.tester/mcp-unit';

function manifestOf(
  contribution: PluginManifest['contributions']['mcp'][number] | null,
): PluginManifest {
  return {
    format_version: 1,
    id: PLUGIN_ID,
    name: 'Unit Vendor',
    version: '1.0.0',
    description: '',
    author: { name: 'tester' },
    usage: 'test',
    engines: { kepcup: '>=0.5.11' },
    instances: ['mcp'],
    contributions: {
      skills: [],
      connectors: [],
      mail: [],
      im: [],
      ...(contribution === null ? {} : { mcp: [contribution] }),
    },
    config: { fields: [] },
  } as unknown as PluginManifest;
}

const VENDOR_TEMPLATE = {
  kind: 'http' as const,
  id: 'docs',
  name: '文档服务',
  url: 'https://docs.example.com/openapi/mcp',
  auth: 'headers' as const,
  headers: [{ name: 'Authorization', key: 'token' }],
};

function serverIdOf(instanceId: string): string {
  return `plg_${createHash('sha256').update(`${PLUGIN_ID}#${instanceId}`).digest('hex').slice(0, 12)}`;
}

function makeDeps() {
  let servers: McpServer[] = [];
  const secretStore = new Map<string, string>();
  const closed: string[] = [];
  const autoEnabled: { serverId: string; trigger: string }[] = [];
  const deps = {
    settings: {
      get: (): Settings => ({ mcpServers: servers }) as unknown as Settings,
      update(patch: Partial<Settings>): Settings {
        if (patch.mcpServers !== undefined) servers = patch.mcpServers;
        return { mcpServers: servers } as unknown as Settings;
      },
    },
    secrets: {
      getValue: (name: string) => secretStore.get(name) ?? null,
      setValue: (name: string, value: string) => void secretStore.set(name, value),
      removeValue: (name: string) => void secretStore.delete(name),
    },
    mcp: { closeServer: async (serverId: string) => void closed.push(serverId) },
    disconnector: { removeCustomServer: async () => undefined },
    revokeMcpServerChanges: () => undefined,
    autoEnable: async (serverId: string, trigger: string) =>
      void autoEnabled.push({ serverId, trigger }),
    tierOf: () => 'developer' as const,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  return { deps, servers: () => servers, secretStore, closed, autoEnabled };
}

function ctxOf(
  manifest: PluginManifest,
  instanceId: string,
  values: Record<string, PluginFieldValue>,
) {
  return {
    pluginId: PLUGIN_ID,
    instanceId,
    kind: 'mcp' as const,
    title: instanceId,
    manifest,
    values,
    readStoredSecret: () => null,
  };
}

describe('mcp materializer compensation & shape switches (P4-M2 review)', () => {
  it('create 冲突（同 id 已存在）时 header secret 精确还原到 previousValue', async () => {
    const { deps, servers, secretStore } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    const manifest = manifestOf(VENDOR_TEMPLATE);
    const ctx = ctxOf(manifest, 'pli_case1', { token: 'Bearer abc' });
    await materializer.create(ctx);
    const secretName = `mcp:${serverIdOf('pli_case1')}:header:Authorization`;
    expect(secretStore.get(secretName)).toBe('Bearer abc');
    expect(servers()).toHaveLength(1);

    // 模拟"旧值在位"的冲突场景：先把 secret 改成旧值，再对同一 instanceId 重复
    // create（serverId 已存在 → PLUGIN_CONFLICT）。回滚必须把 secret 还原为
    // previousValue（= 'old'），而不是清空或保留新值。
    secretStore.set(secretName, 'old');
    await expect(materializer.create(ctx)).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' });
    expect(secretStore.get(secretName)).toBe('old');
    expect(servers()).toHaveLength(1);
  });

  it('update：auth none→headers 写 secret，headers→none 清记录与多余 secret；toolPolicies/enabled 保留', async () => {
    const { deps, servers, secretStore } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    const instanceId = 'pli_case2';
    const serverId = serverIdOf(instanceId);
    const withHeader = manifestOf(VENDOR_TEMPLATE);
    const withoutHeader = manifestOf({
      kind: 'http',
      id: 'docs',
      name: '文档服务',
      url: 'https://docs.example.com/openapi/mcp',
    });

    // 先以无认证模版落地（auth none），再更新为带 header 的模版。
    await materializer.create(ctxOf(withoutHeader, instanceId, { token: 'ignored' }));
    expect(servers()[0]!.auth).toBe('none');
    expect(servers()[0]!.headers).toBeUndefined();

    // 保留用户态：enabled 关 + toolPolicies；update 后应存活。
    const current = servers()[0]!;
    current.enabled = false;
    current.toolPolicies = { read_doc: { approval: 'ask', enabled: false } };

    await materializer.update(ctxOf(withHeader, instanceId, { token: 'Bearer abc' }));
    expect(servers()[0]!.auth).toBe('headers');
    expect(servers()[0]!.headers).toEqual({ Authorization: 'secret:header:Authorization' });
    expect(secretStore.get(`mcp:${serverId}:header:Authorization`)).toBe('Bearer abc');
    expect(servers()[0]!.enabled).toBe(false);
    expect(servers()[0]!.toolPolicies).toEqual({ read_doc: { approval: 'ask', enabled: false } });

    // 切回无认证：headers 记录清空、mcp 侧 secret 删除。
    await materializer.update(ctxOf(withoutHeader, instanceId, { token: 'Bearer abc' }));
    expect(servers()[0]!.auth).toBe('none');
    expect(servers()[0]!.headers).toBeUndefined();
    expect(deps.secrets.getValue(`mcp:${serverId}:header:Authorization`)).toBeNull();
  });

  it('reconcile 清「实例行在、server 不见」的孤儿行，server 在位的行保留', async () => {
    const { deps, servers } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    const manifest = manifestOf(VENDOR_TEMPLATE);
    await materializer.create(ctxOf(manifest, 'pli_alive', { token: 'Bearer abc' }));

    const rows = [
      { id: 'pli_alive', pluginId: PLUGIN_ID, kind: 'mcp' as const },
      { id: 'pli_orphan', pluginId: PLUGIN_ID, kind: 'mcp' as const },
    ];
    const deleted: string[] = [];
    const instances = {
      listKind: (kind: string) => (kind === 'mcp' ? rows : []),
      delete: async (id: string) => void deleted.push(id),
    } as unknown as Parameters<typeof reconcileMcpInstanceRows>[0];

    reconcileMcpInstanceRows(instances, deps.settings, deps.logger);
    expect(deleted).toEqual(['pli_orphan']);
    expect(servers()).toHaveLength(1);
  });
});

/**
 * 配置完成后的自动启用（连接 → 列工具 → 批准全部）：create / update 成功落地后以
 * 对应 trigger 触发一次；任何失败回滚（secret 还原 / NOT_FOUND）都不触发；autoEnable
 * 自身抛错不影响保存结果（fire-and-forget）；remove 不触发。触发点接线的端到端行为
 * （真批准、真可调用）见 plugins-instances.test.ts / app-tool-lock.test.ts。
 */
describe('mcp materializer auto-enable (config-complete → approve all)', () => {
  it('create 成功触发 instance-create；冲突回滚不触发', async () => {
    const { deps, autoEnabled } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    const manifest = manifestOf(VENDOR_TEMPLATE);
    await materializer.create(ctxOf(manifest, 'pli_auto1', { token: 'Bearer abc' }));
    expect(autoEnabled).toEqual([{ serverId: serverIdOf('pli_auto1'), trigger: 'instance-create' }]);

    await expect(
      materializer.create(ctxOf(manifest, 'pli_auto1', { token: 'Bearer abc' })),
    ).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' });
    expect(autoEnabled).toHaveLength(1);
  });

  it('update 成功触发 instance-update；实例不存在（NOT_FOUND）不触发', async () => {
    const { deps, autoEnabled } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    const manifest = manifestOf(VENDOR_TEMPLATE);
    await materializer.create(ctxOf(manifest, 'pli_auto2', { token: 'Bearer abc' }));
    expect(autoEnabled).toHaveLength(1);

    await materializer.update(ctxOf(manifest, 'pli_auto2', { token: 'Bearer xyz' }));
    expect(autoEnabled).toEqual([
      { serverId: serverIdOf('pli_auto2'), trigger: 'instance-create' },
      { serverId: serverIdOf('pli_auto2'), trigger: 'instance-update' },
    ]);

    await expect(
      materializer.update(ctxOf(manifest, 'pli_missing', { token: 'Bearer xyz' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(autoEnabled).toHaveLength(2);
  });

  it('autoEnable 抛错被吞掉（fire-and-forget），不影响 create / update 的结果', async () => {
    const { deps, servers } = makeDeps();
    deps.autoEnable = async () => {
      throw new Error('connect failed');
    };
    const materializer = createMcpMaterializer(deps);
    const manifest = manifestOf(VENDOR_TEMPLATE);
    await materializer.create(ctxOf(manifest, 'pli_boom', { token: 'Bearer abc' }));
    expect(servers()).toHaveLength(1);
    await materializer.update(ctxOf(manifest, 'pli_boom', { token: 'Bearer xyz' }));
    expect(servers()).toHaveLength(1);
  });

  it('remove 不触发自动启用', async () => {
    const { deps, autoEnabled } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    const manifest = manifestOf(VENDOR_TEMPLATE);
    await materializer.create(ctxOf(manifest, 'pli_rm', { token: 'Bearer abc' }));
    expect(autoEnabled).toHaveLength(1);
    await materializer.remove(ctxOf(manifest, 'pli_rm', {}));
    expect(autoEnabled).toHaveLength(1);
  });
});

/**
 * 凭据方案（`scheme: 'bearer'`，腾讯文档 MCP）：保存侧只存裸凭据——用户可能自己粘了
 * `Bearer `，发送侧统一补前缀，存储里绝不能出现 `Bearer Bearer x`。只有声明了方案的
 * header 被 strip，同一 server 的其他 header 与未声明的模版完全不变。
 */
describe('mcp materializer header scheme (bearer)', () => {
  const BEARER_TEMPLATE = {
    kind: 'http' as const,
    id: 'docs',
    name: '文档服务',
    url: 'https://docs.example.com/openapi/mcp',
    auth: 'headers' as const,
    headers: [
      { name: 'Authorization', key: 'token', scheme: 'bearer' as const },
      { name: 'X-Api-Key', key: 'apiKey' },
    ],
  };

  function ctxWithStoredSecret(
    manifest: PluginManifest,
    instanceId: string,
    values: Record<string, PluginFieldValue>,
    stored: Record<string, string> = {},
  ) {
    return {
      ...ctxOf(manifest, instanceId, values),
      readStoredSecret: (key: string) => stored[key] ?? null,
    };
  }

  it('create：裸 token 原样存、带前缀（含大小写 / 空白变体）只存裸 token', async () => {
    for (const [instanceId, input] of [
      ['pli_bare', 'tok_abc123'],
      ['pli_bearer', 'Bearer tok_abc123'],
      ['pli_lower', 'bearer tok_abc123'],
      ['pli_upper', '  BEARER \n tok_abc123  '],
    ] as const) {
      const { deps, secretStore } = makeDeps();
      const materializer = createMcpMaterializer(deps);
      await materializer.create(
        ctxOf(manifestOf(BEARER_TEMPLATE), instanceId, { token: input, apiKey: 'key-1' }),
      );
      const secretName = `mcp:${serverIdOf(instanceId)}:header:Authorization`;
      expect(secretStore.get(secretName)).toBe('tok_abc123');
    }
  });

  it('同一 server 里未声明方案的 header（API key）保持整值原样，不被 strip', async () => {
    const { deps, secretStore } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    await materializer.create(
      ctxOf(manifestOf(BEARER_TEMPLATE), 'pli_mixed', {
        token: 'Bearer tok_abc123',
        apiKey: 'Bearer not-a-bearer-header',
      }),
    );
    const serverId = serverIdOf('pli_mixed');
    expect(secretStore.get(`mcp:${serverId}:header:Authorization`)).toBe('tok_abc123');
    expect(secretStore.get(`mcp:${serverId}:header:X-Api-Key`)).toBe('Bearer not-a-bearer-header');
  });

  it('模版未声明方案时行为不变（整值写入）', async () => {
    const { deps, secretStore } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    await materializer.create(ctxOf(manifestOf(VENDOR_TEMPLATE), 'pli_plain', { token: 'Bearer abc' }));
    expect(secretStore.get(`mcp:${serverIdOf('pli_plain')}:header:Authorization`)).toBe('Bearer abc');
  });

  it('update：沿用已存 secret（旧记录带前缀）时顺带归一成裸 token', async () => {
    const { deps, secretStore } = makeDeps();
    const materializer = createMcpMaterializer(deps);
    const manifest = manifestOf(BEARER_TEMPLATE);
    const instanceId = 'pli_legacy';
    await materializer.create(
      ctxOf(manifest, instanceId, { token: 'tok_abc123', apiKey: 'key-1' }),
    );
    // 模拟旧版本写下的记录：secret 里带 `Bearer `，实例侧也存着同样带前缀的值。
    const secretName = `mcp:${serverIdOf(instanceId)}:header:Authorization`;
    secretStore.set(secretName, 'Bearer tok_abc123');
    await materializer.update(
      ctxWithStoredSecret(
        manifest,
        instanceId,
        { apiKey: 'key-1' },
        { token: 'Bearer tok_abc123', apiKey: 'key-1' },
      ),
    );
    expect(secretStore.get(secretName)).toBe('tok_abc123');
  });
});

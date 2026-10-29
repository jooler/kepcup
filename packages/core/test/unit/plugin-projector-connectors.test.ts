import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  connectorMetaOf,
  pluginManifestSchema,
  type AppConnection,
  type AppConnectionStatus,
  type PluginIdentity,
  type PluginItemKind,
} from '@kepcup/shared';

import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { createEventBus } from '../../src/infra/events.js';
import type { CoreEventsMap } from '../../src/start-types.js';
import {
  ConnectorsProjector,
  rewriteConnectorEntry,
} from '../../src/plugins/projectors/connectors.js';
import {
  emptyOwned,
  type PluginLedger,
  type PluginProjectionContext,
  type ProjectedKind,
} from '../../src/plugins/projectors/index.js';

/**
 * 连接器投影器（D104 P0a-2 步骤 6.2）：rewriteConnectorEntry 的改写与拒绝表、
 * inspect 的冲突 / 重复 / 缺图标、project 后目录条目与分级、unproject 先断连再摘条目、
 * setEnabled 往返只恢复自己停用的连接、activate 对坏文件容错。
 */

const root = mkdtempSync(path.join(tmpdir(), 'projector-connectors-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const noopLogger = { info() {}, warn() {}, error() {} };

class MemLedger implements PluginLedger {
  readonly #items = new Map<PluginItemKind, string[]>();
  add(kind: PluginItemKind, ref: string): void {
    const list = this.#items.get(kind) ?? [];
    if (!list.includes(ref)) list.push(ref);
    this.#items.set(kind, list);
  }
  remove(kind: PluginItemKind, ref: string): void {
    this.#items.set(
      kind,
      (this.#items.get(kind) ?? []).filter((entry) => entry !== ref),
    );
  }
  list(kind: PluginItemKind): string[] {
    return [...(this.#items.get(kind) ?? [])];
  }
}

function identity(tier: PluginIdentity['tier'] = 'developer'): PluginIdentity {
  return { id: 'io.github.tester/conns', version: '1.0.0', origin: 'local', tier };
}

function rawEntry(
  slug: string,
  options: {
    name?: string;
    icon?: string;
    url?: string;
    tier?: string;
    toolPolicy?: Record<string, { risk: string }>;
    packages?: unknown[];
  } = {},
): Record<string, unknown> {
  return {
    name: options.name ?? `test.${slug}/mcp`,
    title: `Fake ${slug}`,
    description: `测试应用 ${slug}`,
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: options.url ?? `https://mcp.${slug}.test/mcp` }],
    ...(options.packages !== undefined ? { packages: options.packages } : {}),
    _meta: {
      'app.kepcup/connector': {
        slug,
        icon: options.icon ?? `${slug}.svg`,
        category: 'productivity',
        tier: options.tier ?? 'builtin',
        auth: {
          kind: 'oauth',
          registration: 'auto',
          clientRef: null,
          scopes: { default: ['read:items'], write: ['write:items'] },
        },
        ...(options.toolPolicy !== undefined ? { toolPolicy: options.toolPolicy } : {}),
        skills: [],
        ui: false,
        privacyPolicy: 'https://example.com/privacy',
      },
    },
  };
}

function makeContent(entries: Array<{ slug: string; body: Record<string, unknown> | string }>): {
  dir: string;
  manifest: ReturnType<typeof pluginManifestSchema.parse>;
} {
  const dir = path.join(root, `content-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const item of entries) {
    const entryDir = path.join(dir, 'connectors', item.slug);
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(
      path.join(entryDir, 'server.json'),
      typeof item.body === 'string' ? item.body : JSON.stringify(item.body),
    );
    writeFileSync(path.join(entryDir, `${item.slug}.svg`), '<svg/>');
  }
  const manifest = pluginManifestSchema.parse({
    format_version: 1,
    id: 'io.github.tester/conns',
    name: 'Conns',
    version: '1.0.0',
    contributions: {
      connectors: entries.map((item) => ({ file: `connectors/${item.slug}/server.json` })),
    },
  });
  return { dir, manifest };
}

interface Rig {
  catalog: ConnectorCatalog;
  projector: ConnectorsProjector;
  events: ReturnType<typeof createEventBus<CoreEventsMap>>;
  catalogEvents: Array<{ connectorId: string; change: string }>;
  connections: Map<string, { status: AppConnectionStatus; disabled: boolean }>;
  disconnectCalls: string[];
}

function makeRig(bundledSlugs: string[] = []): Rig {
  const catalog = new ConnectorCatalog({
    logger: noopLogger,
    source: {
      entries: bundledSlugs.map((slug) => rawEntry(slug)),
      iconsDir: null,
    },
  });
  const connections = new Map<string, { status: AppConnectionStatus; disabled: boolean }>();
  const disconnectCalls: string[] = [];
  const catalogEvents: Array<{ connectorId: string; change: string }> = [];
  const events = createEventBus<CoreEventsMap>();
  events.on('apps.catalog_changed', (payload) => catalogEvents.push(payload));
  const connectionRow = (
    id: string,
    connectorId: string,
    status: AppConnectionStatus,
  ): AppConnection =>
    ({
      id,
      connectorId,
      label: id,
      accountSub: null,
      serverUrl: null,
      issuer: null,
      scopes: [],
      status,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
    }) as AppConnection;
  const projector = new ConnectorsProjector({
    catalog,
    connectionStore: {
      listByConnector: (connectorId: string) => {
        void connectorId;
        return [...connections.entries()].map(([id, row]) => ({
          id,
          connectorId,
          status: row.status,
        })) as AppConnection[];
      },
    },
    disconnector: {
      disconnect: async (connectionId: string) => {
        disconnectCalls.push(connectionId);
      },
    },
    connections: {
      update: async ({ connectionId, disabled }: { connectionId: string; disabled?: boolean }) => {
        const row = connections.get(connectionId)!;
        if (disabled === true) row.status = 'disabled';
        else if (row.status === 'disabled') row.status = 'connected';
        row.disabled = disabled ?? row.disabled;
        return connectionRow(connectionId, 'x', row.status);
      },
    },
    events,
    logger: noopLogger,
  });
  catalog.attachPlugins(projector);
  return { catalog, projector, events, catalogEvents, connections, disconnectCalls };
}

/** A projection context bound to a fresh in-memory ledger. */
function withLedger(): {
  ctx: (
    dir: string,
    manifest: PluginProjectionContext['manifest'],
    tier?: PluginIdentity['tier'],
    owned?: Readonly<Record<ProjectedKind, ReadonlySet<string>>>,
  ) => PluginProjectionContext;
  ledger: MemLedger;
} {
  const ledger = new MemLedger();
  return {
    ledger,
    ctx: (dir, manifest, tier, owned = emptyOwned()) => ({
      plugin: identity(tier ?? 'developer'),
      manifest,
      dir,
      userConfig: {},
      ledger,
      owned,
    }),
  };
}

describe('rewriteConnectorEntry', () => {
  const plugin = identity('developer');

  it('改写：tier 映射、toolPolicy 只留 destructive、packages 清空', () => {
    const raw = rawEntry('acme', {
      tier: 'builtin',
      toolPolicy: {
        read_items: { risk: 'read' },
        write_items: { risk: 'write' },
        destroy_all: { risk: 'destructive' },
      },
      packages: [{ registryType: 'mcpb', identifier: 'x' }],
    });
    // packages non-empty would be rejected; the rewrite expects an already-conforming body.
    const fixed = { ...raw, packages: [] };
    const rewritten = rewriteConnectorEntry(fixed, plugin, '/icon.svg');
    const meta = connectorMetaOf(rewritten);
    expect(meta.tier).toBe('developer');
    expect(Object.keys(meta.toolPolicy)).toEqual(['destroy_all']);
    expect(rewritten.packages).toEqual([]);
    expect(rewritten.remotes).toHaveLength(1);
  });

  it('tier 映射：verified → verified、community → community', () => {
    expect(
      connectorMetaOf(rewriteConnectorEntry(rawEntry('acme'), identity('verified'), null)).tier,
    ).toBe('verified');
    expect(
      connectorMetaOf(rewriteConnectorEntry(rawEntry('acme'), identity('community'), null)).tier,
    ).toBe('community');
  });

  it('拒绝：packages 非空、remotes 为空、不安全端点、保留前缀名称', () => {
    expect(() =>
      rewriteConnectorEntry(
        rawEntry('acme', { packages: [{ registryType: 'mcpb', identifier: 'x' }] }),
        plugin,
        null,
      ),
    ).toThrow(/不允许携带 packages/);
    const noRemotes = rawEntry('acme');
    (noRemotes['remotes'] as unknown[]) = [];
    (noRemotes['packages'] as unknown[]) = [];
    expect(() => rewriteConnectorEntry(noRemotes, plugin, null)).toThrow();
    expect(() =>
      rewriteConnectorEntry(rawEntry('acme', { url: 'http://mcp.acme.test/mcp' }), plugin, null),
    ).toThrow(/不是可接受的公网 https 地址/);
    expect(() =>
      rewriteConnectorEntry(rawEntry('acme', { name: 'local.kepcup/acme' }), plugin, null),
    ).toThrow(/保留前缀/);
  });
});

describe('ConnectorsProjector', () => {
  it('inspect：目录里已有同 slug / 同名 → 冲突（标来源）；包内重复 → blocker；缺图标 → blocker', async () => {
    const rig = makeRig(['acme']);
    const { ctx } = withLedger();
    const content = makeContent([
      { slug: 'acme', body: rawEntry('acme') }, // slug 冲突
      { slug: 'nameshadow', body: rawEntry('nameshadow', { name: 'test.acme/mcp' }) }, // name 冲突
      { slug: 'ok', body: rawEntry('ok') },
      { slug: 'noicon', body: rawEntry('noicon') }, // body ok but we remove the icon below
    ]);
    rmSync(path.join(content.dir, 'connectors', 'noicon', 'noicon.svg'));
    const result = await rig.projector.inspect(ctx(content.dir, content.manifest));
    expect(result.conflicts.map((conflict) => conflict.ref).sort()).toEqual(['acme', 'nameshadow']);
    expect(result.conflicts[0]!.withWhat).toContain('来源：plugin');
    expect(result.blockers).toHaveLength(1); // only the missing icon; conflicts are not blockers
    expect(result.blockers[0]).toContain('图标文件缺失');
    expect(result.items.map((item) => item.slug)).toEqual(['ok']);
    expect(result.items[0]).toMatchObject({
      name: 'test.ok/mcp',
      title: 'Fake ok',
      hosts: ['mcp.ok.test'],
      scopes: ['read:items', 'write:items'],
      authKind: 'oauth',
    });
  });

  it('inspect：包内两个同 slug 贡献 → blocker', async () => {
    const rig = makeRig();
    const { ctx } = withLedger();
    const content = makeContent([
      { slug: 'dup', body: rawEntry('dup') },
      { slug: 'dup2', body: rawEntry('dup', { icon: 'dup2.svg' }) }, // same slug via a different folder
    ]);
    const result = await rig.projector.inspect(ctx(content.dir, content.manifest));
    expect(result.blockers.some((line) => line.includes('重复的连接器'))).toBe(true);
  });

  it('project → catalog.list() 含条目且 tier 正确；catalog_changed added', async () => {
    const rig = makeRig();
    const { ctx, ledger } = withLedger();
    const content = makeContent([{ slug: 'acme', body: rawEntry('acme') }]);
    await rig.projector.project(ctx(content.dir, content.manifest, 'developer'));
    const entry = rig.catalog.get('acme');
    expect(entry).not.toBeNull();
    expect(connectorMetaOf(entry!).tier).toBe('developer');
    expect(rig.catalog.originOf('acme')).toBe('plugin');
    expect(rig.catalog.isDirectorySourced('acme')).toBe(true);
    expect(rig.catalog.iconSvg('acme')).toBe('<svg/>');
    expect(ledger.list('connector')).toEqual(['acme']);
    expect(rig.catalogEvents).toEqual([{ connectorId: 'acme', change: 'added' }]);
  });

  it('unproject：先断开连接（两次扫描）再摘条目', async () => {
    const rig = makeRig();
    const { ctx, ledger } = withLedger();
    const content = makeContent([{ slug: 'acme', body: rawEntry('acme') }]);
    await rig.projector.project(ctx(content.dir, content.manifest));
    rig.connections.set('conn_1', { status: 'connected', disabled: false });
    expect(rig.catalog.get('acme')).not.toBeNull();
    await rig.projector.unproject(identity(), ['acme'], ledger);
    // The connector's connections are swept twice (second pass catches a connection
    // that landed while the entry was being removed), like `LocalConnectors.remove`.
    expect(rig.disconnectCalls).toEqual(['conn_1', 'conn_1']);
    expect(rig.catalog.get('acme')).toBeNull();
    expect(ledger.list('connector')).toEqual([]);
    expect(rig.catalogEvents.at(-1)).toEqual({ connectorId: 'acme', change: 'removed' });
  });

  it('setEnabled 往返：false 隐藏并停用连接（记账），true 只恢复自己停用的', async () => {
    const rig = makeRig();
    const { ctx, ledger } = withLedger();
    const content = makeContent([{ slug: 'acme', body: rawEntry('acme') }]);
    await rig.projector.project(ctx(content.dir, content.manifest));
    // One user-disabled connection (stays disabled) and one active (the plugin disables it).
    rig.connections.set('conn_user_off', { status: 'disabled', disabled: false });
    rig.connections.set('conn_active', { status: 'connected', disabled: false });

    await rig.projector.setEnabled(ctx(content.dir, content.manifest), ['acme'], false);
    expect(rig.catalog.get('acme')).toBeNull(); // hidden from the catalog
    expect(rig.connections.get('conn_active')!.status).toBe('disabled');
    expect(rig.connections.get('conn_user_off')!.status).toBe('disabled');
    expect(ledger.list('disabled_connection')).toEqual(['conn_active']); // only the plugin's own disable
    expect(rig.catalogEvents.at(-1)).toEqual({ connectorId: 'acme', change: 'removed' });

    await rig.projector.setEnabled(ctx(content.dir, content.manifest), ['acme'], true);
    expect(rig.catalog.get('acme')).not.toBeNull();
    expect(rig.connections.get('conn_active')!.status).toBe('connected'); // restored
    expect(rig.connections.get('conn_user_off')!.status).toBe('disabled'); // untouched
    expect(ledger.list('disabled_connection')).toEqual([]);
    expect(rig.catalogEvents.at(-1)).toEqual({ connectorId: 'acme', change: 'added' });
  });

  it('activate：坏文件 warn 跳过，好条目重建', async () => {
    const rig = makeRig();
    const { ctx } = withLedger();
    const content = makeContent([
      { slug: 'good', body: rawEntry('good') },
      { slug: 'bad', body: '{not json' },
    ]);
    await rig.projector.activate(ctx(content.dir, content.manifest));
    expect(rig.catalog.get('good')).not.toBeNull();
    expect(rig.catalog.get('bad')).toBeNull();
  });
});

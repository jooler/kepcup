import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  pluginManifestSchema,
  type PluginItemKind,
  type PluginLedger,
  type PluginManifest,
  type PluginProjectionContext,
  type ProjectedKind,
} from '@kepcup/shared';

import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import type { Clock } from '../../src/infra/clock.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { SkillsService } from '../../src/skills/registry.js';
import { SkillsProjector } from '../../src/plugins/projectors/skills.js';
import { MailProjector } from '../../src/plugins/projectors/mail.js';
import { ConnectorsProjector } from '../../src/plugins/projectors/connectors.js';
import { emptyOwned } from '../../src/plugins/projectors/index.js';
import { hashDirectory } from '../../src/skills/library.js';

/**
 * 投影器的 update（D104 P1-2 步骤 4，真服务 rig）：技能按内容哈希原地替换、未变化不
 * 重装、删除的技能被清理且不碰别人的同名技能；连接器端点 / 认证绑定变化断连、不变
 * 保留连接、name 漂移报错、新增删除；邮件模板只同步账本；`owned` 排除使更新自己不报
 * 冲突。MCP 的 update / beginUpdate / commitUpdate / rollbackUpdate 在
 * plugin-projector-mcp.test.ts。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-projector-update-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const stubLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child: () => stubLogger,
};

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

function ownedOf(entries: Array<[ProjectedKind, string[]]>) {
  const owned: Record<ProjectedKind, Set<string>> = {
    skill: new Set(),
    connector: new Set(),
    mcp: new Set(),
    mail: new Set(),
  };
  for (const [kind, refs] of entries) for (const ref of refs) owned[kind].add(ref);
  return owned as Readonly<Record<ProjectedKind, ReadonlySet<string>>>;
}

// --- skills ---------------------------------------------------------------------

const SKILL_ID = 'io.github.tester/skills';

function makeSkillDir(entries: Array<{ name: string; body?: string; dir?: string }>): string {
  const dir = path.join(root, `skills-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const skillDir = path.join(dir, 'skills', entry.dir ?? entry.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${entry.name}\ndescription: ${entry.name} 技能\n---\n${entry.body ?? '正文'}`,
    );
  }
  return dir;
}

function skillManifest(id: string, version: string, dirs: string[]): PluginManifest {
  return pluginManifestSchema.parse({
    format_version: 1,
    id,
    name: 'Skills',
    version,
    contributions: { skills: dirs.map((dir) => ({ dir: `skills/${dir}` })) },
  });
}

function skillRig() {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let tick = 0;
  const clock: Clock = { now: () => 3_000_000 + tick++ };
  const skills = new SkillsService({
    paths,
    db,
    clock,
    logger: stubLogger,
    bots: { get: () => null },
    publish: () => {},
  });
  const projector = new SkillsProjector({ skills, logger: stubLogger });
  const ledger = new MemLedger();
  const ctxOf = (
    dir: string,
    options: {
      id?: string;
      version?: string;
      dirs?: string[];
      owned?: Readonly<Record<ProjectedKind, ReadonlySet<string>>>;
    } = {},
  ): PluginProjectionContext => ({
    plugin: {
      id: options.id ?? SKILL_ID,
      version: options.version ?? '1.0.0',
      origin: 'local',
      tier: 'developer',
    },
    manifest: skillManifest(options.id ?? SKILL_ID, options.version ?? '1.0.0', options.dirs ?? []),
    dir,
    userConfig: {},
    ledger,
    owned: options.owned ?? emptyOwned(),
  });
  return { skills, projector, ledger, ctxOf };
}

describe('SkillsProjector.update', () => {
  it('内容变化被替换（source_url / 内容哈希换新）、未变化不重装、删除的技能被清理', async () => {
    const rig = skillRig();
    const oldDir = makeSkillDir([
      { name: 'alpha', body: 'v1' },
      { name: 'beta', body: 'same' },
    ]);
    const newDir = makeSkillDir([
      { name: 'alpha', body: 'v2' },
      { name: 'beta', body: 'same' },
    ]);
    const oldCtx = rig.ctxOf(oldDir, { dirs: ['alpha', 'beta'] });
    await rig.projector.project(oldCtx);
    const oldAlphaLibrary = rig.skills.publicSkillRow('alpha')!.library_id;

    const newCtx = rig.ctxOf(newDir, {
      version: '2.0.0',
      dirs: ['alpha', 'beta'],
      owned: ownedOf([['skill', ['alpha', 'beta']]]),
    });
    await rig.projector.update(oldCtx, newCtx);

    const alpha = rig.skills.publicSkillRow('alpha')!;
    expect(alpha.library_id).not.toBe(oldAlphaLibrary); // new content → new library row
    const library = rig.skills.libraryGet(alpha.library_id)!;
    expect(library.source_url).toBe(`plugin://${SKILL_ID}/alpha`);
    expect(library.content_hash).toBe(hashDirectory(path.join(newDir, 'skills', 'alpha')));
    // beta content identical → the library row (hash) survives untouched.
    const beta = rig.skills.publicSkillRow('beta')!;
    expect(rig.skills.libraryGet(beta.library_id)!.content_hash).toBe(
      hashDirectory(path.join(oldDir, 'skills', 'beta')),
    );
    expect(rig.ledger.list('skill')).toEqual(['alpha', 'beta']);
  });

  it('删除的技能被清理；更新别人的同名技能抛 PLUGIN_CONFLICT 且内容不被碰', async () => {
    const rig = skillRig();
    const oldDir = makeSkillDir([{ name: 'alpha' }, { name: 'gone' }]);
    const newDir = makeSkillDir([{ name: 'alpha' }]);
    const oldCtx = rig.ctxOf(oldDir, { dirs: ['alpha', 'gone'] });
    await rig.projector.project(oldCtx);

    const newCtx = rig.ctxOf(newDir, {
      version: '2.0.0',
      dirs: ['alpha'],
      owned: ownedOf([['skill', ['alpha', 'gone']]]),
    });
    await rig.projector.update(oldCtx, newCtx);
    expect(rig.skills.publicSkillRow('gone')).toBeNull();
    expect(rig.ledger.list('skill')).toEqual(['alpha']);

    // A DIFFERENT plugin owns the same-name public skill: the update refuses to replace it.
    rig.skills.uninstallPublic('alpha'); // make room for the foreign install
    const foreign = rig.ctxOf(makeSkillDir([{ name: 'alpha', body: 'foreign' }]), {
      id: 'io.github.other/who',
      version: '1.0.0',
      dirs: ['alpha'],
    });
    await rig.projector.project(foreign); // installs under the foreign source marker
    const victim = rig.ctxOf(makeSkillDir([{ name: 'alpha', body: 'hijack' }]), {
      version: '3.0.0',
      dirs: ['alpha'],
      owned: ownedOf([['skill', ['alpha']]]),
    });
    await expect(rig.projector.update(newCtx, victim)).rejects.toMatchObject({
      code: 'PLUGIN_CONFLICT',
    });
    expect(rig.skills.libraryGet(rig.skills.publicSkillRow('alpha')!.library_id)!.source_url).toBe(
      'plugin://io.github.other/who/alpha',
    );
  });

  it('贡献目录改名（SKILL.md name 不变）不丢技能；SKILL.md name 改变则旧名清理', async () => {
    const rig = skillRig();
    const oldDir = makeSkillDir([{ name: 'alpha' }, { name: 'beta' }]);
    const newDir = makeSkillDir([
      { name: 'alpha', dir: 'alpha-moved', body: 'moved' }, // 同名技能换了目录 → 保留并换新内容
      { name: 'beta2', dir: 'beta' }, // 同目录改了 SKILL.md name → 旧名清理、新名登记
    ]);
    const oldCtx = rig.ctxOf(oldDir, { dirs: ['alpha', 'beta'] });
    await rig.projector.project(oldCtx);

    const newCtx = rig.ctxOf(newDir, {
      version: '2.0.0',
      dirs: ['alpha-moved', 'beta'],
      owned: ownedOf([['skill', ['alpha', 'beta']]]),
    });
    await rig.projector.update(oldCtx, newCtx);

    // 技能身份 = SKILL.md name：目录改名后 alpha 仍在（内容已换新）
    expect(rig.skills.publicSkillRow('alpha')).not.toBeNull();
    expect(
      rig.skills.libraryGet(rig.skills.publicSkillRow('alpha')!.library_id)!.content_hash,
    ).toBe(hashDirectory(path.join(newDir, 'skills', 'alpha-moved')));
    // SKILL.md name 改变：旧名被清理（若按贡献目录比对会误删仍存在的 alpha）
    expect(rig.skills.publicSkillRow('beta')).toBeNull();
    expect(rig.skills.publicSkillRow('beta2')).not.toBeNull();
    expect(rig.ledger.list('skill')).toEqual(['alpha', 'beta2']);
  });

  it('inspect 的 owned 排除：更新自己不报同名冲突，不带 owned 仍冲突', async () => {
    const rig = skillRig();
    const dir = makeSkillDir([{ name: 'dup' }]);
    await rig.projector.project(rig.ctxOf(dir, { dirs: ['dup'] }));
    const ownInspect = await rig.projector.inspect({
      ...rig.ctxOf(dir, { version: '2.0.0', dirs: ['dup'] }),
      owned: ownedOf([['skill', ['dup']]]),
    });
    expect(ownInspect.conflicts).toEqual([]);
    const plain = await rig.projector.inspect(rig.ctxOf(dir, { version: '2.0.0', dirs: ['dup'] }));
    expect(plain.conflicts).toEqual([{ kind: 'skill', ref: 'dup', withWhat: '已有同名公共技能' }]);
  });
});

// --- connectors ---------------------------------------------------------------------

const CONN_ID = 'io.github.tester/conns';

function rawEntry(
  slug: string,
  options: { name?: string; url?: string; registration?: string; clientRef?: string | null } = {},
): Record<string, unknown> {
  return {
    name: options.name ?? `test.${slug}/mcp`,
    title: `Fake ${slug}`,
    description: `测试应用 ${slug}`,
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: options.url ?? `https://mcp.${slug}.test/mcp` }],
    _meta: {
      'app.kepcup/connector': {
        slug,
        icon: `${slug}.svg`,
        category: 'productivity',
        tier: 'builtin',
        auth: {
          kind: 'oauth',
          registration: options.registration ?? 'auto',
          clientRef: options.clientRef ?? null,
          scopes: { default: ['read:items'], write: ['write:items'] },
        },
        toolPolicy: {},
        skills: [],
        ui: false,
        privacyPolicy: 'https://example.com/privacy',
        releaseGate: 'test',
      },
    },
  };
}

function makeConnDir(entries: Array<{ slug: string; body: Record<string, unknown> }>): string {
  const dir = path.join(root, `conns-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const item of entries) {
    const entryDir = path.join(dir, 'connectors', item.slug);
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(path.join(entryDir, 'server.json'), JSON.stringify(item.body));
    writeFileSync(path.join(entryDir, `${item.slug}.svg`), '<svg/>');
  }
  return dir;
}

function connRig() {
  const catalogEvents: Array<{ connectorId: string; change: string }> = [];
  const disconnectCalls: string[] = [];
  const connections = new Map<string, string>(); // connection id → connector slug
  const catalogEntries: unknown[] = []; // pre-existing catalog rows for conflict checks
  const projector = new ConnectorsProjector({
    catalog: {
      list: () => catalogEntries,
      originOf: () => 'bundled',
      yieldedPluginSlugs: () => new Set(),
      attachPlugins: () => {},
    } as never,
    connectionStore: {
      listByConnector: (connectorId: string) =>
        [...connections.entries()]
          .filter(([, slug]) => slug === connectorId)
          .map(([id, slug]) => ({ id, connectorId: slug, status: 'connected' })) as never,
    },
    disconnector: {
      disconnect: async (connectionId: string) => {
        disconnectCalls.push(connectionId);
        connections.delete(connectionId);
      },
    },
    connections: { update: async () => undefined },
    events: {
      emit: (_name: string, payload: { connectorId: string; change: string }) => {
        catalogEvents.push(payload);
      },
    } as never,
    logger: stubLogger,
  });
  const ledger = new MemLedger();
  const ctxOf = (
    dir: string,
    options: {
      version?: string;
      slugs?: string[];
      owned?: Readonly<Record<ProjectedKind, ReadonlySet<string>>>;
    } = {},
  ): PluginProjectionContext => ({
    plugin: {
      id: CONN_ID,
      version: options.version ?? '1.0.0',
      origin: 'local',
      tier: 'developer',
    },
    manifest: pluginManifestSchema.parse({
      format_version: 1,
      id: CONN_ID,
      name: 'Conns',
      version: options.version ?? '1.0.0',
      contributions: {
        connectors: (options.slugs ?? []).map((slug) => ({
          file: `connectors/${slug}/server.json`,
        })),
      },
    }),
    dir,
    userConfig: {},
    ledger,
    owned: options.owned ?? emptyOwned(),
  });
  return { projector, ledger, ctxOf, catalogEvents, disconnectCalls, connections, catalogEntries };
}

describe('ConnectorsProjector.update', () => {
  it('端点不变：条目原位替换、连接保留；端点变化：连接被断开（两次扫描）', async () => {
    const rig = connRig();
    const oldDir = makeConnDir([{ slug: 'acme', body: rawEntry('acme') }]);
    const oldCtx = rig.ctxOf(oldDir, { slugs: ['acme'] });
    await rig.projector.project(oldCtx);
    rig.connections.set('conn_1', 'acme');

    // Same endpoint → the entry is replaced (meta re-derived) and the connection survives.
    const sameDir = makeConnDir([{ slug: 'acme', body: rawEntry('acme') }]);
    const sameCtx = rig.ctxOf(sameDir, {
      version: '2.0.0',
      slugs: ['acme'],
      owned: ownedOf([['connector', ['acme']]]),
    });
    await rig.projector.update(oldCtx, sameCtx);
    expect(rig.disconnectCalls).toEqual([]);
    expect(rig.ledger.list('connector')).toEqual(['acme']);
    expect(rig.catalogEvents.at(-1)).toEqual({ connectorId: 'acme', change: 'added' });

    // Changed endpoint → EVERY connection of the connector is swept (twice, same as
    // uninstall) — including conn_1, which legitimately survived the identical update.
    const movedDir = makeConnDir([
      { slug: 'acme', body: rawEntry('acme', { url: 'https://mcp.acme.test/v2/mcp' }) },
    ]);
    rig.connections.set('conn_2', 'acme');
    await rig.projector.update(
      sameCtx,
      rig.ctxOf(movedDir, {
        version: '2.0.0',
        slugs: ['acme'],
        owned: ownedOf([['connector', ['acme']]]),
      }),
    );
    expect([...rig.disconnectCalls].sort()).toEqual(['conn_1', 'conn_2']);
    expect(rig.connections.size).toBe(0);
    expect(rig.ledger.list('connector')).toEqual(['acme']);
  });

  it('auth registration 变化也是绑定变化；新增 / 删除 slug 各自登记与清理', async () => {
    const rig = connRig();
    const oldDir = makeConnDir([
      { slug: 'acme', body: rawEntry('acme') },
      { slug: 'gone', body: rawEntry('gone') },
    ]);
    const oldCtx = rig.ctxOf(oldDir, { slugs: ['acme', 'gone'] });
    await rig.projector.project(oldCtx);
    rig.connections.set('conn_1', 'acme');

    const nextDir = makeConnDir([
      {
        slug: 'acme',
        body: rawEntry('acme', { registration: 'preregistered', clientRef: 'client_1' }),
      },
      { slug: 'added', body: rawEntry('added') },
    ]);
    await rig.projector.update(
      oldCtx,
      rig.ctxOf(nextDir, {
        version: '2.0.0',
        slugs: ['acme', 'added'],
        owned: ownedOf([['connector', ['acme', 'gone']]]),
      }),
    );
    expect(rig.disconnectCalls).toEqual(['conn_1']);
    expect(rig.connections.size).toBe(0);
    expect(rig.ledger.list('connector')).toEqual(['acme', 'added']);
  });

  it('slug 相同但 name 漂移 → PLUGIN_INVALID（目录仍是旧条目）', async () => {
    const rig = connRig();
    const oldDir = makeConnDir([{ slug: 'acme', body: rawEntry('acme') }]);
    const oldCtx = rig.ctxOf(oldDir, { slugs: ['acme'] });
    await rig.projector.project(oldCtx);
    const renamedDir = makeConnDir([
      { slug: 'acme', body: rawEntry('acme', { name: 'other.name/mcp' }) },
    ]);
    await expect(
      rig.projector.update(
        oldCtx,
        rig.ctxOf(renamedDir, {
          version: '2.0.0',
          slugs: ['acme'],
          owned: ownedOf([['connector', ['acme']]]),
        }),
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('inspect 的 owned 排除：更新自己不报 slug 冲突，别人的占位仍冲突', async () => {
    const rig = connRig();
    rig.catalogEntries.push({
      name: 'test.acme/mcp',
      _meta: { 'app.kepcup/connector': { slug: 'acme' } },
    });
    const dir = makeConnDir([{ slug: 'acme', body: rawEntry('acme') }]);
    const own = await rig.projector.inspect({
      ...rig.ctxOf(dir, { version: '2.0.0', slugs: ['acme'] }),
      owned: ownedOf([['connector', ['acme']]]),
    });
    expect(own.conflicts).toEqual([]);
    const plain = await rig.projector.inspect(
      rig.ctxOf(dir, { version: '2.0.0', slugs: ['acme'] }),
    );
    expect(plain.conflicts).toHaveLength(1);
    expect(plain.conflicts[0]!.kind).toBe('connector');
  });
});

// --- mail -------------------------------------------------------------------------

function mailManifest(version: string, ids: string[]): PluginManifest {
  return pluginManifestSchema.parse({
    format_version: 1,
    id: 'io.github.tester/mail',
    name: 'Mail',
    version,
    contributions: {
      mail: ids.map((id) => ({
        id,
        label: `Mail ${id}`,
        imap: { host: 'imap.test', port: 993, secure: 'ssl' },
        smtp: { host: 'smtp.test', port: 465, secure: 'ssl' },
      })),
    },
  });
}

describe('MailProjector.update', () => {
  it('只同步账本：新增登记、删除移除', async () => {
    const projector = new MailProjector();
    const ledger = new MemLedger();
    const oldCtx: PluginProjectionContext = {
      plugin: { id: 'io.github.tester/mail', version: '1.0.0', origin: 'local', tier: 'developer' },
      manifest: mailManifest('1.0.0', ['alpha', 'beta']),
      dir: '/nowhere',
      userConfig: {},
      ledger,
      owned: emptyOwned(),
    };
    await projector.project(oldCtx);
    const newCtx: PluginProjectionContext = {
      ...oldCtx,
      plugin: { ...oldCtx.plugin, version: '2.0.0' },
      manifest: mailManifest('2.0.0', ['beta', 'gamma']),
    };
    await projector.update(oldCtx, newCtx);
    expect(ledger.list('mail')).toEqual(['beta', 'gamma']);
  });

  it('inspect 的 owned 排除：自己已拥有的模板 id 不冲突', async () => {
    const projector = new MailProjector();
    const own = await projector.inspect({
      plugin: { id: 'io.github.tester/mail', version: '2.0.0', origin: 'local', tier: 'developer' },
      manifest: mailManifest('2.0.0', ['corporate']),
      dir: '/nowhere',
      userConfig: {},
      ledger: new MemLedger(),
      owned: ownedOf([['mail', ['corporate']]]),
    });
    expect(own.conflicts).toEqual([]);
  });
});

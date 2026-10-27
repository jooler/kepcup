import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AppError,
  pluginManifestSchema,
  type PluginConflict,
  type PluginManifest,
} from '@kepcup/shared';
import { buildPluginFixture } from '@kepcup/testkit';

import { PluginPackager } from '../../src/plugins/package.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginStore } from '../../src/plugins/store.js';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import type { Clock } from '../../src/infra/clock.js';
import { resolvePaths } from '../../src/infra/paths.js';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjector,
  PluginProjectionContext,
  ProjectedKind,
} from '../../src/plugins/projectors/index.js';

/**
 * PluginRegistry（D104 P0a-2 步骤 8）：真 PluginStore + 真 PluginPackager + 假投影器。
 * 成功安装的状态 / 账本 / 目录 / 事件 / 审计；中途失败回滚；sha256 绑定；同 id 冲突；
 * 保留命名空间；冲突 / blocker 错误码；setEnabled 顺序与幂等；卸载尽力而为；
 * 崩溃恢复；activate 容错；互斥串行。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-registry-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child: () => noopLogger,
};

function refsOf(manifest: PluginManifest, kind: ProjectedKind): string[] {
  switch (kind) {
    case 'skill':
      return manifest.contributions.skills.map((skill) => skill.dir.split('/').pop() ?? skill.dir);
    case 'connector':
      return manifest.contributions.connectors.map((connector) => connector.file);
    case 'mcp':
      return manifest.contributions.mcp.map((contribution) => contribution.id);
    case 'mail':
      return manifest.contributions.mail.map((template) => template.id);
  }
}

class FakeProjector implements PluginProjector {
  readonly kind: ProjectedKind;
  inspected = 0;
  readonly projected: Array<{ pluginId: string; ref: string }> = [];
  readonly unprojected: Array<{ pluginId: string; refs: readonly string[] }> = [];
  readonly setEnabledCalls: Array<{ pluginId: string; refs: readonly string[]; enabled: boolean }> =
    [];
  readonly activated: string[] = [];
  conflicts: PluginConflict[] = [];
  blockers: string[] = [];
  /** project 在写完第 N 项后抛错（null = 不抛）。 */
  failProjectAt: number | null = null;
  failUnproject = false;
  failActivate = false;
  /** project 开始 / 结束时往共享 log 里写（互斥测试用）。 */
  log: string[] | null = null;
  projectDelayMs = 0;
  // --- P1-2 update hooks ---
  readonly updates: Array<{ from: string; to: string }> = [];
  readonly committed: Array<{ pluginId: string; snapshot: string | null }> = [];
  readonly rolledBack: Array<{ pluginId: string; snapshot: string | null }> = [];
  /** update 抛错（补偿路径测试）。 */
  failUpdate = false;
  /**
   * true 时「实现」beginUpdate / commitUpdate / rollbackUpdate（快照驱动的补偿）；
   * false 时与真技能 / 连接器 / 邮件投影器一样没有这三个钩子 → 补偿走反向 update。
   */
  #snapshotDriven = false;
  /** update 开始时回调（注册表此刻的账本 / 日志状态断言）。 */
  onUpdate: (() => void) | null = null;
  /** inspect 返回的条目（默认空；权限差异测试按 ctx.plugin.version 区分新旧）。 */
  inspectItemsFor: ((ctx: PluginProjectionContext) => unknown[]) | null = null;
  /** beginUpdate / commitUpdate / rollbackUpdate 往共享 log 写（顺序测试用）。 */
  opLog: string[] | null = null;

  get snapshotDriven(): boolean {
    return this.#snapshotDriven;
  }

  set snapshotDriven(value: boolean) {
    this.#snapshotDriven = value;
    this.beginUpdate =
      value === true
        ? async (plugin: PluginIdentity) => {
            if (this.opLog !== null) this.opLog.push(`${this.kind}.begin`);
            return `snap:${this.kind}@${plugin.version}`;
          }
        : async () => null;
    this.commitUpdate =
      value === true
        ? async (plugin: PluginIdentity, snapshot: string | null) => {
            if (this.opLog !== null) this.opLog.push(`${this.kind}.commit`);
            this.committed.push({ pluginId: plugin.id, snapshot });
          }
        : undefined;
    this.rollbackUpdate =
      value === true
        ? async (plugin: PluginIdentity, snapshot: string | null) => {
            this.rolledBack.push({ pluginId: plugin.id, snapshot });
          }
        : undefined;
  }

  constructor(kind: ProjectedKind) {
    this.kind = kind;
    this.snapshotDriven = false;
  }

  async inspect(ctx: PluginProjectionContext) {
    this.inspected += 1;
    return {
      items: this.inspectItemsFor?.(ctx) ?? [],
      conflicts: this.conflicts,
      blockers: this.blockers,
    };
  }

  async update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void> {
    this.updates.push({ from: oldCtx.plugin.version, to: newCtx.plugin.version });
    this.onUpdate?.();
    if (this.opLog !== null) this.opLog.push(`${this.kind}.update:${newCtx.plugin.version}`);
    // 与真投影器同一契约：账本同步到新清单（新增登记、删除移除）。
    const refs = refsOf(newCtx.manifest, this.kind);
    for (const ref of refs) newCtx.ledger.add(this.kind, ref);
    for (const ref of refsOf(oldCtx.manifest, this.kind)) {
      if (!refs.includes(ref)) oldCtx.ledger.remove(this.kind, ref);
    }
    if (this.failUpdate) throw new Error(`update ${this.kind} failed`);
  }

  beginUpdate: PluginProjector['beginUpdate'] = async () => null;
  commitUpdate: PluginProjector['commitUpdate'] = undefined;
  rollbackUpdate: PluginProjector['rollbackUpdate'] = undefined;

  async project(ctx: PluginProjectionContext): Promise<void> {
    this.log?.push(`${this.kind}.project.begin:${ctx.plugin.id}`);
    if (this.projectDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.projectDelayMs));
    const refs = refsOf(ctx.manifest, this.kind);
    for (const [index, ref] of refs.entries()) {
      ctx.ledger.add(this.kind, ref);
      this.projected.push({ pluginId: ctx.plugin.id, ref });
      if (this.failProjectAt !== null && index + 1 >= this.failProjectAt) {
        this.log?.push(`${this.kind}.project.end:${ctx.plugin.id}`);
        throw new Error(`project ${this.kind} failed at ${ref}`);
      }
    }
    this.log?.push(`${this.kind}.project.end:${ctx.plugin.id}`);
  }

  async unproject(
    plugin: PluginIdentity,
    refs: readonly string[],
    ledger: PluginLedger,
  ): Promise<void> {
    this.unprojected.push({ pluginId: plugin.id, refs });
    if (this.failUnproject) throw new Error(`unproject ${this.kind} failed`);
    for (const ref of refs) ledger.remove(this.kind, ref);
  }

  async setEnabled(
    ctx: PluginProjectionContext,
    refs: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    this.setEnabledCalls.push({ pluginId: ctx.plugin.id, refs, enabled });
  }

  async activate(ctx: PluginProjectionContext): Promise<void> {
    this.activated.push(ctx.plugin.id);
    if (this.failActivate) throw new Error(`activate ${this.kind} failed`);
  }
}

interface Rig {
  registry: PluginRegistry;
  store: PluginStore;
  packager: PluginPackager;
  pluginsDir: string;
  fakes: Record<ProjectedKind, FakeProjector>;
  events: Array<{ name: string; payload: unknown }>;
  audits: Array<{ action: string; detail: Record<string, unknown> }>;
  home: string;
}

function makeRig(): Rig {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let tick = 0;
  const clock: Clock = { now: () => 5_000_000 + tick++ };
  const store = new PluginStore(db);
  const packager = new PluginPackager({
    pluginsDir: paths.pluginsDir,
    logger: noopLogger,
    appVersion: '0.0.0-test',
  });
  const fakes = {
    skill: new FakeProjector('skill'),
    mcp: new FakeProjector('mcp'),
    connector: new FakeProjector('connector'),
    mail: new FakeProjector('mail'),
  };
  const events: Array<{ name: string; payload: unknown }> = [];
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const registry = new PluginRegistry({
    store,
    packager,
    projectors: [fakes.skill, fakes.mcp, fakes.connector, fakes.mail],
    pluginsDir: paths.pluginsDir,
    clock,
    logger: noopLogger,
    events: {
      emit: (name, payload) => events.push({ name, payload }),
    },
    audit: {
      recordSystem: (action, detail) => {
        audits.push({ action, detail });
        return null;
      },
    },
  });
  return { registry, store, packager, pluginsDir: paths.pluginsDir, fakes, events, audits, home };
}

/** 手工插入一行（更新 / 恢复 / 孤儿清理测试用）；dir 按小写槽位默认推导。 */
function rowOf(id: string, patch: Partial<Parameters<PluginStore['insert']>[0]> = {}) {
  const version = patch.version ?? '1.0.0';
  return {
    id,
    version,
    origin: 'local' as const,
    tier: 'developer' as const,
    state: 'installed' as const,
    enabled: true,
    packageSha256: 'a'.repeat(64),
    marketplace: null,
    dir: `${id}@${version}`.toLowerCase(),
    updateTo: null,
    updateSnapshot: null,
    installedAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

/** 在磁盘上铺一个可读的旧版插件目录（v1 清单，含一个技能贡献）。 */
function seedDir(pluginsDir: string, id: string, version: string, skillName = 'alpha'): string {
  const dir = path.join(pluginsDir, `${id}@${version}`.toLowerCase());
  mkdirSync(path.join(dir, 'skills', skillName), { recursive: true });
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      format_version: 1,
      id,
      name: 'Seeded',
      version,
      contributions: { skills: [{ dir: `skills/${skillName}` }] },
    }),
  );
  writeFileSync(
    path.join(dir, 'skills', skillName, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: seeded\n---\nbody`,
  );
  return dir;
}

/** 市场服务桩：`current()` / `endpointId()`，find 恒返回 entry，download 给出指定文件。 */
function makeMarketFake(id: string, endpointId: string) {
  let entry: Record<string, unknown> | null = null;
  let downloadPath = '';
  return {
    setEntry(next: Record<string, unknown> | null): void {
      entry = next;
    },
    setDownload(path: string): void {
      downloadPath = path;
    },
    service: {
      current: () => ({
        find: () => entry,
        revocationOf: () => null,
        download: async () => downloadPath,
        entries: () => (entry === null ? [] : [entry]),
        incompatibleReason: () => null,
      }),
      endpointId: () => endpointId,
    } as never,
  };
}

/** 内置插件桩（D104 P0b）：只提供 summaries / get，验证 list 头部插入与启停 / 卸载拒绝。 */
function makeRigWithBuiltin(): Rig & { builtinIds: string[] } {
  const rig = makeRig();
  const builtinIds = ['com.kepcup/starter-skills', 'com.kepcup/connections'];
  const builtinSummaries = builtinIds.map((id) => ({
    id,
    name: id,
    version: '1.0.0',
    description: '',
    author: null,
    origin: 'builtin' as const,
    tier: 'builtin' as const,
    state: 'installed' as const,
    enabled: true,
    dirPath: null,
    marketplace: null,
    installedAt: null,
    updatedAt: null,
    counts: { skills: 0, connectors: 0, mcp: 0, mail: 0 },
    items: [],
    updateAvailable: null,
  }));
  const registry = new PluginRegistry({
    store: rig.store,
    packager: rig.packager,
    projectors: [rig.fakes.skill, rig.fakes.mcp, rig.fakes.connector, rig.fakes.mail],
    builtin: {
      summaries: () => builtinSummaries,
      get: (id: string) => (builtinIds.includes(id) ? ({ id } as never) : null),
    },
    pluginsDir: rig.pluginsDir,
    clock: { now: () => 9_000_000 },
    logger: noopLogger,
    events: { emit: () => {} },
  });
  return { ...rig, registry, builtinIds };
}

let fixtureCounter = 0;
async function makeFixture(
  options: {
    id?: string;
    version?: string;
    skills?: string[];
    mail?: string[];
  } = {},
): Promise<{ path: string; sha256: string; manifest: PluginManifest }> {
  fixtureCounter += 1;
  const id = options.id ?? 'io.github.tester/reg';
  const version = options.version ?? `1.0.${fixtureCounter}`;
  const built = await buildPluginFixture({
    dir: path.join(root, `fixtures-${Math.random().toString(36).slice(2, 8)}`),
    manifest: {
      id,
      version,
      contributions: {
        skills: (options.skills ?? ['alpha', 'beta']).map((name) => ({ dir: `skills/${name}` })),
        connectors: [],
        mcp: [],
        mail: (options.mail ?? ['mailtest']).map((mailId) => ({
          id: mailId,
          label: `Mail ${mailId}`,
          imap: { host: 'imap.test', port: 993, secure: 'ssl' },
          smtp: { host: 'smtp.test', port: 465, secure: 'ssl' },
        })),
      },
    },
    skills: (options.skills ?? ['alpha', 'beta']).map((name) => ({ name })),
  });
  return {
    path: built.path,
    sha256: built.sha256,
    manifest: pluginManifestSchema.parse(built.manifest),
  };
}

function expectCode(error: unknown, code: string): AppError {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

const installArgs = (fixture: { path: string; sha256: string }) => ({
  source: { kind: 'file', path: fixture.path } as const,
  sha256: fixture.sha256,
  userConfig: {},
  via: 'file' as const,
});

describe('PluginRegistry', () => {
  it('成功安装：状态 / 账本 / 目录 / 事件 / 审计', async () => {
    const rig = makeRig();
    const fixture = await makeFixture();
    const summary = await rig.registry.install(installArgs(fixture));
    expect(summary).toMatchObject({
      id: 'io.github.tester/reg',
      version: fixture.manifest.version,
      origin: 'local',
      tier: 'developer',
      state: 'installed',
      enabled: true,
      counts: { skills: 2, connectors: 0, mcp: 0, mail: 1 },
    });
    expect(summary.dirPath).toBe(
      path.join(rig.pluginsDir, `io.github.tester/reg@${fixture.manifest.version}`.toLowerCase()),
    );
    expect(existsSync(summary.dirPath!)).toBe(true);
    expect(rig.store.get('io.github.tester/reg')).toMatchObject({
      state: 'installed',
      packageSha256: fixture.sha256,
      dir: `io.github.tester/reg@${fixture.manifest.version}`.toLowerCase(),
    });
    expect(rig.store.items('io.github.tester/reg')).toEqual([
      { kind: 'skill', ref: 'alpha' },
      { kind: 'skill', ref: 'beta' },
      { kind: 'mail', ref: 'mailtest' },
    ]);
    expect(rig.events).toEqual([
      { name: 'plugins.changed', payload: { ids: ['io.github.tester/reg'] } },
    ]);
    expect(rig.audits).toEqual([
      {
        action: 'plugin_install',
        detail: {
          pluginId: 'io.github.tester/reg',
          version: fixture.manifest.version,
          origin: 'local',
          tier: 'developer',
          via: 'file',
        },
      },
    ]);
  });

  it('第 2 项投影失败 → 按账本回滚、目录与行被清、重抛原错误', async () => {
    const rig = makeRig();
    rig.fakes.skill.failProjectAt = 2;
    const fixture = await makeFixture();
    const error = await rig.registry.install(installArgs(fixture)).then(
      () => null,
      (caught: unknown) => caught,
    );
    // Non-AppError projection failures are wrapped (original message kept, logged).
    expect((error as AppError).code).toBe('INTERNAL');
    expect((error as Error).message).toContain('project skill failed at beta');
    expect(rig.store.get('io.github.tester/reg')).toBeNull();
    expect(rig.store.items('io.github.tester/reg')).toEqual([]);
    expect(
      existsSync(
        path.join(rig.pluginsDir, `io.github.tester/reg@${fixture.manifest.version}`.toLowerCase()),
      ),
    ).toBe(false);
    // 回滚按逆序：mail / connector / mcp 无账本项被跳过，skill 收到已写项
    expect(rig.fakes.skill.unprojected).toEqual([
      { pluginId: 'io.github.tester/reg', refs: ['alpha', 'beta'] },
    ]);
    expect(rig.fakes.mail.unprojected).toEqual([]);
    expect(rig.events).toEqual([]); // 失败不发 changed
  });

  it('sha256 不符 → PLUGIN_INVALID 且无残留；市场来源已装 + 本地安装 → PLUGIN_CONFLICT；保留命名空间 → PLUGIN_INVALID', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/sha' });
    const error = await rig.registry
      .install({ ...installArgs(fixture), sha256: 'b'.repeat(64) })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expectCode(error, 'PLUGIN_INVALID');
    expect(rig.store.get('io.github.tester/sha')).toBeNull();

    // P1-2：同 id 的本地重装走更新流；「市场来源的行 + 本地来源」仍冲突。
    const marketId = 'io.github.tester/mkt';
    const v1 = await makeFixture({ id: marketId, version: '1.0.0' });
    rig.store.insert(
      rowOf(marketId, {
        version: '1.0.0',
        origin: 'marketplace',
        tier: 'community',
        marketplace: 'https://market.test/plugins/v1',
        dir: `${marketId}@1.0.0`.toLowerCase(),
      }),
    );
    const localAgainstMarket = await makeFixture({ id: marketId, version: '2.0.0' });
    const conflict = await rig.registry.install(installArgs(localAgainstMarket)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expectCode(conflict, 'PLUGIN_CONFLICT');
    expect(conflict!.message).toContain('已安装同 id 插件');
    expect(rig.store.get(marketId)).toMatchObject({ version: '1.0.0' });

    const reserved = await makeFixture({ id: 'com.kepcup/evil' });
    const reservedError = await rig.registry.install(installArgs(reserved)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expectCode(reservedError, 'PLUGIN_INVALID');
    expect((reservedError as AppError).message).toMatch(/保留/);
  });

  it('inspect：冲突 → install 抛 PLUGIN_CONFLICT；blocker → PLUGIN_INCOMPATIBLE', async () => {
    const rig = makeRig();
    const conflicted = await makeFixture({ id: 'io.github.tester/conf' });
    rig.fakes.skill.conflicts = [{ kind: 'skill', ref: 'alpha', withWhat: '已有同名公共技能' }];
    const inspect = await rig.registry.inspect({ kind: 'file', path: conflicted.path });
    expect(inspect.installable).toBe(false);
    expect(inspect.conflicts).toEqual([
      { kind: 'skill', ref: 'alpha', withWhat: '已有同名公共技能' },
    ]);
    const conflict = await rig.registry.install(installArgs(conflicted)).then(
      () => null,
      (caught: unknown) => caught,
    );
    const conflictError = expectCode(conflict, 'PLUGIN_CONFLICT');
    expect(conflictError.message).toContain('alpha（已有同名公共技能）');
    expect(rig.store.get('io.github.tester/conf')).toBeNull();

    rig.fakes.skill.conflicts = [];
    rig.fakes.mail.blockers = ['内置模板冲突'];
    const blocked = await makeFixture({ id: 'io.github.tester/block' });
    const blocker = await rig.registry.install(installArgs(blocked)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expectCode(blocker, 'PLUGIN_INCOMPATIBLE');
    expect(rig.store.get('io.github.tester/block')).toBeNull();
  });

  it('inspect：市场来源已装 + 本地检视 → existing + blocker；installable=false', async () => {
    const rig = makeRig();
    const marketId = 'io.github.tester/twice';
    rig.store.insert(
      rowOf(marketId, {
        origin: 'marketplace',
        tier: 'verified',
        marketplace: 'https://market.test/plugins/v1',
      }),
    );
    const again = await makeFixture({ id: marketId });
    const output = await rig.registry.inspect({ kind: 'file', path: again.path });
    expect(output.existing).toEqual({ version: '1.0.0' });
    expect(output.blockers.some((line) => line.includes('已安装同 id 插件'))).toBe(true);
    expect(output.installable).toBe(false);
    expect(output.update).toBeNull();
  });

  it('setEnabled：禁用逆序、启用正序；相同值幂等', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/toggle' });
    await rig.registry.install(installArgs(fixture));
    rig.fakes.skill.setEnabledCalls.length = 0;
    rig.fakes.mail.setEnabledCalls.length = 0;

    await rig.registry.setEnabled('io.github.tester/toggle', false);
    // 禁用按逆序：mail 先于 skill
    expect(rig.fakes.mail.setEnabledCalls.map((call) => [call.enabled, call.refs])).toEqual([
      [false, ['mailtest']],
    ]);
    expect(rig.fakes.skill.setEnabledCalls.map((call) => [call.enabled, call.refs])).toEqual([
      [false, ['alpha', 'beta']],
    ]);
    expect(rig.store.get('io.github.tester/toggle')).toMatchObject({ enabled: false });

    rig.fakes.skill.setEnabledCalls.length = 0;
    rig.fakes.mail.setEnabledCalls.length = 0;
    await rig.registry.setEnabled('io.github.tester/toggle', true);
    expect(rig.fakes.skill.setEnabledCalls.map((call) => call.enabled)).toEqual([true]);
    expect(rig.fakes.mail.setEnabledCalls.map((call) => call.enabled)).toEqual([true]);

    // 相同值：直接返回当前摘要，不再调用投影器
    const before = rig.fakes.skill.setEnabledCalls.length;
    const summary = await rig.registry.setEnabled('io.github.tester/toggle', true);
    expect(summary.enabled).toBe(true);
    expect(rig.fakes.skill.setEnabledCalls).toHaveLength(before);

    const missing = await rig.registry.setEnabled('io.github.tester/none', true).then(
      () => null,
      (caught: unknown) => caught,
    );
    expectCode(missing, 'NOT_FOUND');
  });

  it('uninstall：某投影器抛错仍清完其余并抛首个错误', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/gone' });
    await rig.registry.install(installArgs(fixture));
    rig.fakes.mail.failUnproject = true;
    const error = await rig.registry.uninstall('io.github.tester/gone').then(
      () => null,
      (caught: unknown) => caught,
    );
    const appError = expectCode(error, 'INTERNAL');
    expect(appError.message).toContain('unproject mail failed');
    // 尽力而为：skill 的清理照做，行与目录都被清
    expect(rig.fakes.skill.unprojected).toEqual([
      { pluginId: 'io.github.tester/gone', refs: ['alpha', 'beta'] },
    ]);
    expect(rig.store.get('io.github.tester/gone')).toBeNull();
    expect(
      existsSync(
        path.join(
          rig.pluginsDir,
          `io.github.tester/gone@${fixture.manifest.version}`.toLowerCase(),
        ),
      ),
    ).toBe(false);
    expect(rig.audits.at(-1)).toMatchObject({ action: 'plugin_uninstall' });

    const none = await rig.registry.uninstall('io.github.tester/none').then(
      () => null,
      (caught: unknown) => caught,
    );
    expectCode(none, 'NOT_FOUND');
  });

  it('崩溃恢复：installing 行回滚、uninstalling 行继续完成', async () => {
    const rig = makeRig();
    // 手工造一个中断的安装：行 + 账本 + 目录
    const id = 'io.github.tester/crash';
    const version = '2.0.0';
    const dir = path.join(rig.pluginsDir, 'io.github.tester', 'crash@2.0.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({}));
    rig.store.insert({
      id,
      version,
      origin: 'local',
      tier: 'developer',
      state: 'installing',
      enabled: true,
      packageSha256: 'c'.repeat(64),
      marketplace: null,
      dir: 'io.github.tester/crash@2.0.0',
      updateTo: null,
      updateSnapshot: null,
      installedAt: 1,
      updatedAt: 1,
    });
    rig.store.addItem(id, 'skill', 'alpha');
    rig.store.addItem(id, 'mcp', 'plg_orphan');
    const recovered = await rig.registry.recoverInterrupted();
    expect(recovered).toBe(1);
    expect(rig.store.get(id)).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(rig.fakes.skill.unprojected).toEqual([{ pluginId: id, refs: ['alpha'] }]);
    expect(rig.fakes.mcp.unprojected).toEqual([{ pluginId: id, refs: ['plg_orphan'] }]);

    // uninstalling 行同理：继续完成卸载
    const dir2 = path.join(rig.pluginsDir, 'io.github.tester', 'mid@1.0.0');
    mkdirSync(dir2, { recursive: true });
    rig.store.insert({
      id: 'io.github.tester/mid',
      version: '1.0.0',
      origin: 'local',
      tier: 'developer',
      state: 'uninstalling',
      enabled: false,
      packageSha256: 'd'.repeat(64),
      marketplace: null,
      dir: 'io.github.tester/mid@1.0.0',
      updateTo: null,
      updateSnapshot: null,
      installedAt: 2,
      updatedAt: 2,
    });
    rig.store.addItem('io.github.tester/mid', 'mail', 'mailleft');
    const recovered2 = await rig.registry.recoverInterrupted();
    expect(recovered2).toBe(1);
    expect(rig.store.get('io.github.tester/mid')).toBeNull();
    expect(rig.fakes.mail.unprojected.at(-1)).toEqual({
      pluginId: 'io.github.tester/mid',
      refs: ['mailleft'],
    });
  });

  it('start()：activate 抛错只告警不失败；installed+enabled 才激活', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/act' });
    await rig.registry.install(installArgs(fixture));
    rig.fakes.skill.failActivate = true;
    rig.fakes.skill.activated.length = 0;
    rig.fakes.mail.activated.length = 0;
    await expect(rig.registry.start()).resolves.toBeUndefined();
    expect(rig.fakes.skill.activated).toEqual(['io.github.tester/act']);
    expect(rig.fakes.mail.activated).toEqual(['io.github.tester/act']);

    await rig.registry.setEnabled('io.github.tester/act', false);
    rig.fakes.skill.activated.length = 0;
    await rig.registry.start();
    expect(rig.fakes.skill.activated).toEqual([]); // disabled → not activated
  });

  it('互斥：并发两个 install 串行（投影不交错）', async () => {
    const rig = makeRig();
    const shared: string[] = [];
    rig.fakes.skill.log = shared;
    rig.fakes.skill.projectDelayMs = 15;
    const first = await makeFixture({ id: 'io.github.tester/mutex-a' });
    const second = await makeFixture({ id: 'io.github.tester/mutex-b' });
    await Promise.all([
      rig.registry.install(installArgs(first)),
      rig.registry.install(installArgs(second)),
    ]);
    const begins = shared.filter((line) => line.includes('.project.begin:'));
    const ends = shared.filter((line) => line.includes('.project.end:'));
    expect(begins).toHaveLength(2);
    expect(ends).toHaveLength(2);
    // 同一插件的 begin/end 必须成对连续（无交错）
    expect(shared[0]).toBe(begins[0]);
    expect(shared[1]).toBe(ends[0]);
    expect(shared[2]).toBe(begins[1]);
    expect(shared[3]).toBe(ends[1]);
  });

  it('setEnabled：清单不可读 → PLUGIN_INVALID，标志与投影都不动；卸载仍可用', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/corrupt' });
    await rig.registry.install(installArgs(fixture));
    // 内容在应用外被破坏：清单解析失败
    const dir = path.join(
      rig.pluginsDir,
      'io.github.tester',
      `corrupt@${fixture.manifest.version}`,
    );
    writeFileSync(path.join(dir, 'plugin.json'), '{broken');
    rig.fakes.skill.setEnabledCalls.length = 0;
    const error = await rig.registry.setEnabled('io.github.tester/corrupt', false).then(
      () => null,
      (caught: unknown) => caught,
    );
    expectCode(error, 'PLUGIN_INVALID');
    // 标志不翻转（enabled 与投影保持一致，绝不出现「已停用但投影还活着」）
    expect(rig.store.get('io.github.tester/corrupt')).toMatchObject({ enabled: true });
    expect(rig.fakes.skill.setEnabledCalls).toHaveLength(0);
    // 卸载不依赖清单（走账本），照常清干净
    await rig.registry.uninstall('io.github.tester/corrupt');
    expect(rig.store.get('io.github.tester/corrupt')).toBeNull();
    expect(
      existsSync(
        path.join(rig.pluginsDir, 'io.github.tester', `corrupt@${fixture.manifest.version}`),
      ),
    ).toBe(false);
  });

  it('大小写变体 id：目录槽位冲突 → inspect 冲突 / install PLUGIN_CONFLICT，原插件不受影响', async () => {
    const rig = makeRig();
    const first = await makeFixture({ id: 'io.github.tester/slot' });
    await rig.registry.install(installArgs(first));
    const slotDir = path.join(rig.pluginsDir, 'io.github.tester', `slot@${first.manifest.version}`);
    expect(existsSync(slotDir)).toBe(true);

    // 同版本大小写变体 → lower-cased 后是同一个目录槽位
    const variant = await makeFixture({
      id: 'io.github.tester/SLOT',
      version: first.manifest.version,
    });
    const output = await rig.registry.inspect({ kind: 'file', path: variant.path });
    expect(output.installable).toBe(false);
    expect(output.conflicts).toEqual([
      {
        kind: 'plugin',
        ref: 'io.github.tester/SLOT',
        withWhat: '安装目录槽位已被插件 io.github.tester/slot 占用（目录名仅大小写不同）',
      },
    ]);
    const error = await rig.registry.install(installArgs(variant)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expectCode(error, 'PLUGIN_CONFLICT');
    // 原插件的行、账本与目录完好（rm(finalDir) 之前已被拒绝）
    expect(rig.store.get('io.github.tester/slot')).toMatchObject({ state: 'installed' });
    expect(rig.store.items('io.github.tester/slot')).toHaveLength(3);
    expect(existsSync(slotDir)).toBe(true);
  });

  it('start() 对禁用插件也读清单：list 显示名称与描述；不触发 activate', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/named' });
    await rig.registry.install(installArgs(fixture));
    await rig.registry.setEnabled('io.github.tester/named', false);
    rig.fakes.skill.activated.length = 0;
    rig.fakes.mail.activated.length = 0;

    // 新的注册表实例（新进程语义：清单缓存为空，只有 start() 会填）
    const second = new PluginRegistry({
      store: rig.store,
      packager: rig.packager,
      projectors: [rig.fakes.skill, rig.fakes.mcp, rig.fakes.connector, rig.fakes.mail],
      pluginsDir: rig.pluginsDir,
      clock: { now: () => 9_000_000 },
      logger: noopLogger,
      events: { emit: () => {} },
    });
    await second.start();
    const summary = second.list().find((entry) => entry.id === 'io.github.tester/named');
    expect(summary).toMatchObject({
      name: fixture.manifest.name,
      description: fixture.manifest.description,
      enabled: false,
    });
    expect(rig.fakes.skill.activated).toEqual([]); // 禁用 → 不激活
    expect(rig.fakes.mail.activated).toEqual([]);
  });

  it('ownerOf / list 的 missing 标记', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/own' });
    await rig.registry.install(installArgs(fixture));
    expect(rig.registry.ownerOf('skill', 'alpha')).toBe('io.github.tester/own');
    expect(rig.registry.ownerOf('skill', 'ghost')).toBeNull();

    // 投影器报告 missing → list 的 items 标记
    rig.fakes.skill.missing = (plugin, refs) => refs.filter((ref) => ref === 'alpha');
    const summary = rig.registry.list().find((entry) => entry.id === 'io.github.tester/own')!;
    const alpha = summary.items.find((item) => item.ref === 'alpha');
    expect(alpha).toMatchObject({ kind: 'skill', missing: true });
    expect(summary.items.find((item) => item.ref === 'beta')?.missing).toBeUndefined();
  });

  it('内置插件：list 头部插入只读摘要，setEnabled / uninstall 报 INVALID_INPUT', async () => {
    const rig = makeRigWithBuiltin();
    const fixture = await makeFixture();
    await rig.registry.install(installArgs(fixture));

    const listed = rig.registry.list();
    expect(
      listed.filter((plugin) => plugin.origin === 'builtin').map((plugin) => plugin.id),
    ).toEqual(rig.builtinIds);
    // 已装插件跟在内置之后。
    expect(listed[rig.builtinIds.length]).toMatchObject({ id: 'io.github.tester/reg' });

    await expect(rig.registry.setEnabled('com.kepcup/starter-skills', false)).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
      },
    );
    await expect(rig.registry.uninstall('com.kepcup/connections')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // 拒绝后无副作用：两个内置仍在列。
    expect(rig.registry.list()).toHaveLength(3);
  });
});

// --- P1-2 更新流 -----------------------------------------------------------------

const skillItem = (name: string) => ({
  name,
  description: '',
  runtimeDeps: [],
  compatible: true,
  incompatibleReason: null,
});

const MARKET = 'https://market.test/plugins/v1';
const MARKET_ID = 'io.github.tester/mkt';

describe('PluginRegistry updates (P1-2)', () => {
  it('更新成功：顺序 = 日志 → 文件 → 投影 → 提交翻转 → 提交钩子 → 删旧目录', async () => {
    const rig = makeRig();
    const id = 'io.github.tester/upd';
    rig.fakes.skill.snapshotDriven = true; // commitUpdate 钩子可见
    const opLog: string[] = [];
    for (const fake of Object.values(rig.fakes)) fake.opLog = opLog;
    const first = await makeFixture({ id, version: '1.0.0', skills: ['alpha'] });
    await rig.registry.install(installArgs(first));
    const oldDir = path.join(rig.pluginsDir, `${id}@1.0.0`.toLowerCase());

    let duringUpdate: { updateTo: string | null; version: string; oldDirExists: boolean } | null =
      null;
    rig.fakes.skill.onUpdate = () => {
      const row = rig.store.get(id)!;
      duringUpdate = {
        updateTo: row.updateTo,
        version: row.version,
        oldDirExists: existsSync(oldDir),
      };
    };

    const second = await makeFixture({ id, version: '2.0.0', skills: ['alpha', 'beta'] });
    const summary = await rig.registry.install(installArgs(second));

    // ④ 日志先于 ⑥ 投影：投影运行时 updateTo 已写、行版本未翻转、旧目录还在
    expect(duringUpdate).toEqual({ updateTo: '2.0.0', version: '1.0.0', oldDirExists: true });
    // begin（快照驱动者才记日志）→ update（投影顺序）→ commit（同为投影顺序）
    expect(opLog).toEqual([
      'skill.begin',
      'skill.update:2.0.0',
      'mail.update:2.0.0',
      'skill.commit',
    ]);
    expect(rig.fakes.skill.committed[0]).toMatchObject({ snapshot: 'snap:skill@1.0.0' });
    // ⑦ 单条 update 翻转一切
    expect(summary).toMatchObject({ version: '2.0.0', state: 'installed' });
    expect(rig.store.get(id)).toMatchObject({ version: '2.0.0', updateTo: null, updateSnapshot: null });
    // 账本按 rowid：更新新增的 beta 追加在尾部。
    expect(rig.store.items(id)).toEqual([
      { kind: 'skill', ref: 'alpha' },
      { kind: 'mail', ref: 'mailtest' },
      { kind: 'skill', ref: 'beta' },
    ]);
    expect(existsSync(oldDir)).toBe(false); // 旧目录被 GC
    expect(existsSync(path.join(rig.pluginsDir, `${id}@2.0.0`.toLowerCase()))).toBe(true);
    expect(rig.audits.at(-1)).toMatchObject({
      action: 'plugin_update',
      detail: {
        pluginId: id,
        from: '1.0.0',
        to: '2.0.0',
        origin: 'local',
        tier: 'developer',
        via: 'file',
        permissionsExpanded: false,
      },
    });
    expect(rig.events.at(-1)).toEqual({ name: 'plugins.changed', payload: { ids: [id] } });
  });

  it('update 抛错 → 逆序补偿（rollbackUpdate 优先于反向 update）、sameDir 的 .prev 换回、日志清空、重抛原错误', async () => {
    const rig = makeRig();
    const id = 'io.github.tester/rollback';
    const version = '5.0.0'; // 同版本重装 = sameDir → 走 .prev 换入
    rig.fakes.skill.snapshotDriven = true;
    rig.fakes.skill.failUpdate = true;
    const first = await makeFixture({ id, version, skills: ['alpha'] });
    await rig.registry.install(installArgs(first));
    const slotDir = path.join(rig.pluginsDir, `${id}@${version}`.toLowerCase());
    const prevDir = `${slotDir}.prev`;
    expect(existsSync(slotDir)).toBe(true);

    const second = await makeFixture({ id, version, skills: ['alpha', 'beta'] });
    const error = await rig.registry.install(installArgs(second)).then(
      () => null,
      (caught: unknown) => caught,
    );
    // 非 AppError 的投影失败被包装为 INTERNAL，但原始信息保留
    expectCode(error, 'INTERNAL');
    expect((error as Error).message).toContain('update skill failed');
    // 逆序补偿：mail 没有 rollbackUpdate → 反向 update（updates 记一条反转）；
    // skill 实现了 rollbackUpdate → 优先于反向 update，不被反向调用。
    expect(rig.fakes.skill.rolledBack).toEqual([
      { pluginId: id, snapshot: 'snap:skill@5.0.0' },
    ]);
    expect(rig.fakes.mail.updates).toEqual([
      { from: version, to: version }, // 反向（update 在 skill 就抛了，没到 mail）
    ]);
    // 文件还原：.prev 没了、旧目录回来；日志清空；账本回到旧集合
    expect(existsSync(slotDir)).toBe(true);
    expect(existsSync(prevDir)).toBe(false);
    expect(rig.store.get(id)).toMatchObject({ version, updateTo: null, updateSnapshot: null });
    expect(rig.store.items(id)).toEqual([
      { kind: 'skill', ref: 'alpha' },
      { kind: 'mail', ref: 'mailtest' },
    ]);
    expect(rig.audits.at(-1)).toMatchObject({
      action: 'plugin_update',
      detail: { failed: true, error: 'INTERNAL', to: version },
    });
    expect(rig.events).toHaveLength(1); // 只有首次安装发过 changed
  });

  it('权限扩大且无 acknowledgeDiff → INVALID_INPUT（零写入）；带 acknowledgeDiff 成功', async () => {
    const rig = makeRig();
    const id = 'io.github.tester/diff';
    rig.fakes.skill.inspectItemsFor = (ctx) =>
      ctx.plugin.version === '2.0.0'
        ? [skillItem('alpha'), skillItem('beta')]
        : [skillItem('alpha')];
    const first = await makeFixture({ id, version: '1.0.0', skills: ['alpha'] });
    await rig.registry.install(installArgs(first));
    const before = rig.store.get(id);

    const second = await makeFixture({ id, version: '2.0.0', skills: ['alpha', 'beta'] });
    const refused = await rig.registry.install(installArgs(second)).then(
      () => null,
      (caught: unknown) => caught,
    );
    const appError = expectCode(refused, 'INVALID_INPUT');
    expect(appError.message).toContain('更新新增了权限');
    expect(appError.details).toMatchObject({ permissionsExpanded: true, added: ['skill:beta'] });
    // 零写入：行、账本、投影器调用、审计都不动
    expect(rig.store.get(id)).toEqual(before);
    expect(rig.fakes.skill.updates).toEqual([]);
    expect(rig.audits.filter((entry) => entry.action === 'plugin_update')).toEqual([]);
    expect(rig.events).toHaveLength(1);

    // inspect 暴露差异；带 acknowledgeDiff 后成功
    const view = await rig.registry.inspect({ kind: 'file', path: second.path });
    expect(view.existing).toEqual({ version: '1.0.0' });
    expect(view.update).toEqual({
      from: '1.0.0',
      permissionsExpanded: true,
      added: ['新增技能 beta（对所有 Bot 可见）'],
    });
    expect(view.installable).toBe(true);

    const done = await rig.registry.install({ ...installArgs(second), acknowledgeDiff: true });
    expect(done).toMatchObject({ version: '2.0.0' });
    // 账本按 rowid：更新新增的 beta 追加在已有行之后。
    expect(rig.store.items(id)).toEqual([
      { kind: 'skill', ref: 'alpha' },
      { kind: 'mail', ref: 'mailtest' },
      { kind: 'skill', ref: 'beta' },
    ]);
  });

  it('权限不扩大无需 acknowledgeDiff；本地允许同版本 / 更低版本', async () => {
    const rig = makeRig();
    const id = 'io.github.tester/same';
    rig.fakes.skill.inspectItemsFor = () => [skillItem('alpha')];
    const first = await makeFixture({ id, version: '2.0.0', skills: ['alpha'] });
    await rig.registry.install(installArgs(first));

    // 同版本、不同内容 → sameDir 更新
    const same = await makeFixture({ id, version: '2.0.0', skills: ['alpha'] });
    const sameSummary = await rig.registry.install(installArgs(same));
    expect(sameSummary).toMatchObject({ version: '2.0.0' });
    expect(rig.store.get(id)).toMatchObject({ updateTo: null });

    // 更低版本也允许（本地来源）
    const lower = await makeFixture({ id, version: '1.0.0', skills: ['alpha'] });
    const lowerSummary = await rig.registry.install(installArgs(lower));
    expect(lowerSummary).toMatchObject({ version: '1.0.0' });
    expect(existsSync(path.join(rig.pluginsDir, `${id}@1.0.0`.toLowerCase()))).toBe(true);
    expect(rig.audits.filter((entry) => entry.action === 'plugin_update')).toHaveLength(2);
  });

  it('市场来源：不允许降级 / 同版本；row.marketplace 与当前 endpoint 不符 → 拒；update 对 local 行 → INVALID_INPUT', async () => {
    const rig = makeRig();
    const market = makeMarketFake(MARKET_ID, MARKET);
    const marketRig: Rig = {
      ...rig,
      registry: new PluginRegistry({
        store: rig.store,
        packager: rig.packager,
        projectors: [rig.fakes.skill, rig.fakes.mcp, rig.fakes.connector, rig.fakes.mail],
        marketplace: market.service,
        pluginsDir: rig.pluginsDir,
        clock: { now: () => 7_000_000 },
        logger: noopLogger,
        events: { emit: () => {} },
        audit: { recordSystem: () => null },
      }),
    };
    const oldDir = seedDir(marketRig.pluginsDir, MARKET_ID, '2.0.0');
    marketRig.store.insert(
      rowOf(MARKET_ID, {
        version: '2.0.0',
        origin: 'marketplace',
        tier: 'community',
        marketplace: MARKET,
        dir: `${MARKET_ID}@2.0.0`.toLowerCase(),
      }),
    );

    const newer = await makeFixture({ id: MARKET_ID, version: '2.0.0' });
    market.setDownload(newer.path);
    market.setEntry({
      id: MARKET_ID,
      version: '2.0.0',
      tier: 'community',
      sha256: newer.sha256,
      size: newer.sha256.length,
      downloadUrl: '',
      manifestDigest: '',
      engines: null,
      platforms: [],
      categories: [],
      summary: { name: 'M', description: '', author: null, iconUrl: null },
      updatedAt: 1,
    });
    const downgrade = await marketRig.registry
      .update({ id: MARKET_ID, sha256: newer.sha256, userConfig: {}, acknowledgeDiff: true, via: 'marketplace' })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expectCode(downgrade, 'PLUGIN_INVALID');
    expect((downgrade as AppError).message).toContain('不允许降级');

    // endpoint 不符
    const mismatchedRig: Rig = {
      ...rig,
      registry: new PluginRegistry({
        store: rig.store,
        packager: rig.packager,
        projectors: [rig.fakes.skill, rig.fakes.mcp, rig.fakes.connector, rig.fakes.mail],
        marketplace: makeMarketFake(MARKET_ID, 'https://other.test/plugins/v1').service,
        pluginsDir: rig.pluginsDir,
        clock: { now: () => 7_000_001 },
        logger: noopLogger,
        events: { emit: () => {} },
      }),
    };
    const mismatch = await mismatchedRig.registry
      .update({ id: MARKET_ID, sha256: 'a'.repeat(64), userConfig: {}, acknowledgeDiff: true, via: 'marketplace' })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expectCode(mismatch, 'INVALID_INPUT');
    expect((mismatch as AppError).message).toContain('另一个市场');

    // local 行不能走 update RPC；不存在的 id → NOT_FOUND
    const localId = 'io.github.tester/local';
    marketRig.store.insert(rowOf(localId));
    const localRefusal = await marketRig.registry
      .update({ id: localId, sha256: 'a'.repeat(64), userConfig: {}, acknowledgeDiff: true, via: 'marketplace' })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expectCode(localRefusal, 'INVALID_INPUT');
    expect((localRefusal as AppError).message).toContain('本地插件请重新选择');
    const missing = await marketRig.registry
      .update({ id: 'io.github.tester/none', sha256: 'a'.repeat(64), userConfig: {}, acknowledgeDiff: true, via: 'marketplace' })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expectCode(missing, 'NOT_FOUND');
    expect(existsSync(oldDir)).toBe(true); // 拒绝路径不碰旧目录
  });

  it('市场来源更新成功：版本升高走完整事务（fake 市场提供更高版本）', async () => {
    const rig = makeRig();
    const market = makeMarketFake(MARKET_ID, MARKET);
    const registry = new PluginRegistry({
      store: rig.store,
      packager: rig.packager,
      projectors: [rig.fakes.skill, rig.fakes.mcp, rig.fakes.connector, rig.fakes.mail],
      marketplace: market.service,
      pluginsDir: rig.pluginsDir,
      clock: { now: () => 7_100_000 },
      logger: noopLogger,
      events: { emit: () => {} },
      audit: { recordSystem: (action, detail) => void rig.audits.push({ action, detail }) },
    });
    seedDir(rig.pluginsDir, MARKET_ID, '1.0.0');
    rig.store.insert(
      rowOf(MARKET_ID, {
        origin: 'marketplace',
        tier: 'community',
        marketplace: MARKET,
        dir: `${MARKET_ID}@1.0.0`.toLowerCase(),
      }),
    );
    rig.store.addItem(MARKET_ID, 'skill', 'alpha');
    const next = await makeFixture({ id: MARKET_ID, version: '3.0.0', skills: ['alpha', 'beta'] });
    market.setDownload(next.path);
    market.setEntry({
      id: MARKET_ID,
      version: '3.0.0',
      tier: 'community',
      sha256: next.sha256,
      size: next.sha256.length,
      downloadUrl: '',
      manifestDigest: '',
      engines: null,
      platforms: [],
      categories: [],
      summary: { name: 'M', description: '', author: null, iconUrl: null },
      updatedAt: 1,
    });
    const summary = await registry.update({
      id: MARKET_ID,
      sha256: next.sha256,
      userConfig: {},
      acknowledgeDiff: true,
      via: 'marketplace',
    });
    expect(summary).toMatchObject({ version: '3.0.0', origin: 'marketplace', tier: 'community' });
    expect(rig.store.get(MARKET_ID)).toMatchObject({
      version: '3.0.0',
      marketplace: MARKET,
      updateTo: null,
    });
    expect(existsSync(path.join(rig.pluginsDir, `${MARKET_ID}@1.0.0`.toLowerCase()))).toBe(false);
    expect(rig.audits.at(-1)).toMatchObject({
      action: 'plugin_update',
      detail: { via: 'marketplace', origin: 'marketplace', tier: 'community', from: '1.0.0', to: '3.0.0' },
    });
  });

  it('崩溃恢复：newDir 存在 → 按快照补偿回滚；newDir 不存在 → 只清日志', async () => {
    const rig = makeRig();
    const id = 'io.github.tester/crashupd';
    const oldDir = seedDir(rig.pluginsDir, id, '1.0.0');
    rig.fakes.skill.snapshotDriven = true;
    rig.store.insert(rowOf(id, { updateTo: '2.0.0', updateSnapshot: JSON.stringify({ skill: 'snap:skill@1.0.0' }) }));
    rig.store.addItem(id, 'skill', 'alpha');

    // 分支一：newDir 已落盘（更新进行到投影 / 提交前崩溃）
    const newDir = seedDir(rig.pluginsDir, id, '2.0.0', 'beta');
    const recovered = await rig.registry.recoverInterrupted();
    expect(recovered).toBe(1);
    expect(rig.fakes.skill.rolledBack).toEqual([{ pluginId: id, snapshot: 'snap:skill@1.0.0' }]);
    expect(existsSync(newDir)).toBe(false); // 新目录删除
    expect(existsSync(oldDir)).toBe(true); // 旧目录完好（不同版本 → 无 .prev）
    expect(rig.store.get(id)).toMatchObject({ version: '1.0.0', updateTo: null, updateSnapshot: null });
    expect(rig.store.items(id)).toEqual([{ kind: 'skill', ref: 'alpha' }]);
    expect(rig.audits.at(-1)).toMatchObject({ action: 'plugin_update', detail: { failed: true } });

    // 分支二：newDir 不存在（崩溃发生在文件步之前）→ 只清日志
    rig.fakes.skill.rolledBack.length = 0;
    rig.store.update(id, { updateTo: '3.0.0', updateSnapshot: JSON.stringify({}) });
    const recovered2 = await rig.registry.recoverInterrupted();
    expect(recovered2).toBe(1);
    expect(rig.fakes.skill.rolledBack).toEqual([]); // 没有投影器被调用
    expect(rig.store.get(id)).toMatchObject({ version: '1.0.0', updateTo: null });
    expect(existsSync(oldDir)).toBe(true);

    // 分支二变体：sameDir 崩溃留下了 .prev → 换回旧目录并清日志
    const prevDir = `${oldDir}.prev`;
    await (await import('node:fs/promises')).rename(oldDir, prevDir);
    rig.store.update(id, { updateTo: '1.0.0', updateSnapshot: JSON.stringify({}) });
    await rig.registry.recoverInterrupted();
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(prevDir)).toBe(false);
    expect(rig.store.get(id)).toMatchObject({ updateTo: null });
  });

  it('start() 孤儿目录清理：无行的 {name}@{version} 与失效 .prev 被删，不符模式的目录不动；更新中的 .prev 先被恢复换回', async () => {
    const rig = makeRig();
    const id = 'io.github.tester/orphan';
    const keepDir = seedDir(rig.pluginsDir, id, '1.0.0');
    rig.store.insert(rowOf(id));
    // 更新中的行：旧目录已停进 .prev（盘上只有 .prev）→ start() 先恢复换回，再清扫
    const updatingId = 'io.github.tester/orphanupd';
    const updatingSlot = path.join(rig.pluginsDir, `${updatingId}@1.0.0`.toLowerCase());
    rig.store.insert(rowOf(updatingId, { updateTo: '2.0.0' }));
    mkdirSync(`${updatingSlot}.prev`, { recursive: true });
    // 孤儿：无行的版本目录、行存在但没在更新的失效 .prev
    const orphan = seedDir(rig.pluginsDir, id, '9.9.9');
    const stalePrev = seedDir(rig.pluginsDir, id, '4.0.0') + '.prev';
    mkdirSync(stalePrev, { recursive: true });
    // 不符合模式：不应被动
    const foreign = path.join(rig.pluginsDir, 'io.github.tester', 'README.md');
    writeFileSync(foreign, 'keep me');

    await rig.registry.start();
    expect(existsSync(keepDir)).toBe(true); // 有行 → 保留
    expect(existsSync(updatingSlot)).toBe(true); // 更新中的 .prev → 恢复换回旧目录
    expect(existsSync(`${updatingSlot}.prev`)).toBe(false);
    expect(rig.store.get(updatingId)).toMatchObject({ updateTo: null });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(stalePrev)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });
});

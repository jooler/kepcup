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
import { openDatabase, closeDatabase } from '../../src/infra/db.js';
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
  readonly setEnabledCalls: Array<{ pluginId: string; refs: readonly string[]; enabled: boolean }> = [];
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

  constructor(kind: ProjectedKind) {
    this.kind = kind;
  }

  async inspect(ctx: PluginProjectionContext) {
    this.inspected += 1;
    return { items: [], conflicts: this.conflicts, blockers: this.blockers };
  }

  async project(ctx: PluginProjectionContext): Promise<void> {
    this.log?.push(`${this.kind}.project.begin:${ctx.plugin.id}`);
    if (this.projectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.projectDelayMs));
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

  async unproject(plugin: PluginIdentity, refs: readonly string[], ledger: PluginLedger): Promise<void> {
    this.unprojected.push({ pluginId: plugin.id, refs });
    if (this.failUnproject) throw new Error(`unproject ${this.kind} failed`);
    for (const ref of refs) ledger.remove(this.kind, ref);
  }

  async setEnabled(ctx: PluginProjectionContext, refs: readonly string[], enabled: boolean): Promise<void> {
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
  const packager = new PluginPackager({ pluginsDir: paths.pluginsDir, logger: noopLogger, appVersion: '0.0.0-test' });
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
  return { path: built.path, sha256: built.sha256, manifest: pluginManifestSchema.parse(built.manifest) };
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
    expect(rig.events).toEqual([{ name: 'plugins.changed', payload: { ids: ['io.github.tester/reg'] } }]);
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
      existsSync(path.join(rig.pluginsDir, `io.github.tester/reg@${fixture.manifest.version}`.toLowerCase())),
    ).toBe(false);
    // 回滚按逆序：mail / connector / mcp 无账本项被跳过，skill 收到已写项
    expect(rig.fakes.skill.unprojected).toEqual([
      { pluginId: 'io.github.tester/reg', refs: ['alpha', 'beta'] },
    ]);
    expect(rig.fakes.mail.unprojected).toEqual([]);
    expect(rig.events).toEqual([]); // 失败不发 changed
  });

  it('sha256 不符 → PLUGIN_INVALID 且无残留；同 id 已装 → PLUGIN_CONFLICT；保留命名空间 → PLUGIN_INVALID', async () => {
    const rig = makeRig();
    const fixture = await makeFixture({ id: 'io.github.tester/sha' });
    const error = await rig.registry
      .install({ ...installArgs(fixture), sha256: 'b'.repeat(64) })
      .then(() => null, (caught: unknown) => caught);
    expectCode(error, 'PLUGIN_INVALID');
    expect(rig.store.get('io.github.tester/sha')).toBeNull();

    const ok = await makeFixture({ id: 'io.github.tester/dup' });
    await rig.registry.install(installArgs(ok));
    const dup = await makeFixture({ id: 'io.github.tester/dup' });
    const conflict = await rig.registry.install(installArgs(dup)).then(() => null, (caught: unknown) => caught);
    expectCode(conflict, 'PLUGIN_CONFLICT');

    const reserved = await makeFixture({ id: 'com.kepcup/evil' });
    const reservedError = await rig.registry.install(installArgs(reserved)).then(() => null, (caught: unknown) => caught);
    expectCode(reservedError, 'PLUGIN_INVALID');
    expect((reservedError as AppError).message).toMatch(/保留/);
  });

  it('inspect：冲突 → install 抛 PLUGIN_CONFLICT；blocker → PLUGIN_INCOMPATIBLE', async () => {
    const rig = makeRig();
    const conflicted = await makeFixture({ id: 'io.github.tester/conf' });
    rig.fakes.skill.conflicts = [{ kind: 'skill', ref: 'alpha', withWhat: '已有同名公共技能' }];
    const inspect = await rig.registry.inspect({ kind: 'file', path: conflicted.path });
    expect(inspect.installable).toBe(false);
    expect(inspect.conflicts).toEqual([{ kind: 'skill', ref: 'alpha', withWhat: '已有同名公共技能' }]);
    const conflict = await rig.registry.install(installArgs(conflicted)).then(() => null, (caught: unknown) => caught);
    const conflictError = expectCode(conflict, 'PLUGIN_CONFLICT');
    expect(conflictError.message).toContain('alpha（已有同名公共技能）');
    expect(rig.store.get('io.github.tester/conf')).toBeNull();

    rig.fakes.skill.conflicts = [];
    rig.fakes.mail.blockers = ['内置模板冲突'];
    const blocked = await makeFixture({ id: 'io.github.tester/block' });
    const blocker = await rig.registry.install(installArgs(blocked)).then(() => null, (caught: unknown) => caught);
    expectCode(blocker, 'PLUGIN_INCOMPATIBLE');
    expect(rig.store.get('io.github.tester/block')).toBeNull();
  });

  it('inspect：同 id 已装 → existing + blocker；installable=false', async () => {
    const rig = makeRig();
    const first = await makeFixture({ id: 'io.github.tester/twice' });
    await rig.registry.install(installArgs(first));
    rig.fakes.skill.conflicts = [];
    const again = await makeFixture({ id: 'io.github.tester/twice' });
    const output = await rig.registry.inspect({ kind: 'file', path: again.path });
    expect(output.existing).toEqual({ version: first.manifest.version });
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
    expect(rig.fakes.skill.unprojected).toEqual([{ pluginId: 'io.github.tester/gone', refs: ['alpha', 'beta'] }]);
    expect(rig.store.get('io.github.tester/gone')).toBeNull();
    expect(
      existsSync(path.join(rig.pluginsDir, `io.github.tester/gone@${fixture.manifest.version}`.toLowerCase())),
    ).toBe(false);
    expect(rig.audits.at(-1)).toMatchObject({ action: 'plugin_uninstall' });

    const none = await rig.registry.uninstall('io.github.tester/none').then(() => null, (caught: unknown) => caught);
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
      installedAt: 2,
      updatedAt: 2,
    });
    rig.store.addItem('io.github.tester/mid', 'mail', 'mailleft');
    const recovered2 = await rig.registry.recoverInterrupted();
    expect(recovered2).toBe(1);
    expect(rig.store.get('io.github.tester/mid')).toBeNull();
    expect(rig.fakes.mail.unprojected.at(-1)).toEqual({ pluginId: 'io.github.tester/mid', refs: ['mailleft'] });
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
});

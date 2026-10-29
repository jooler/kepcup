import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pluginManifestSchema, type PluginManifest, type PluginItemKind } from '@kepcup/shared';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import type { Clock } from '../../src/infra/clock.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { hashDirectory } from '../../src/skills/library.js';
import { SkillsService } from '../../src/skills/registry.js';
import { SkillsProjector } from '../../src/plugins/projectors/skills.js';
import {
  emptyOwned,
  type PluginIdentity,
  type PluginLedger,
  type PluginProjectionContext,
  type ProjectedKind,
} from '../../src/plugins/projectors/index.js';

/**
 * 技能投影器（D104 P0a-2 步骤 3）：inspect 的同名冲突（Bot 私有同名不算）、
 * project 后 public_skills 行与 `plugin://` 来源标记、unproject 只删自己的、
 * setEnabled 往返、missing 判定；内置预置（保留命名空间来源、从不进账本）装的
 * 同名公共技能被收编而不是冲突。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-projector-skills-'));
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

interface Rig {
  skills: SkillsService;
  db: SqliteDatabase;
  projector: SkillsProjector;
}

function makeRig(depAvailable?: (dep: string) => boolean): Rig {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let tick = 0;
  const clock: Clock = { now: () => 2_000_000 + tick++ };
  const skills = new SkillsService({
    paths,
    db,
    clock,
    logger: stubLogger,
    bots: {
      get: (id) => (id === 'bot_a' ? { id, name: id, status: 'active' } : null),
    },
    publish: () => {},
  });
  const projector = new SkillsProjector({
    skills,
    logger: stubLogger,
    ...(depAvailable !== undefined ? { environment: { depAvailable } } : {}),
  });
  return { skills, db, projector };
}

function makeContentDir(
  entries: Array<{ name: string; description?: string; script?: string }>,
): string {
  const dir = path.join(root, `content-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const skillDir = path.join(dir, 'skills', entry.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${entry.name}\ndescription: ${entry.description ?? `${entry.name} 技能`}\n---\n正文`,
    );
    if (entry.script !== undefined) {
      mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(path.join(skillDir, 'scripts', 'run.sh'), entry.script);
    }
  }
  return dir;
}

function manifestOf(dirs: string[]): PluginManifest {
  return pluginManifestSchema.parse({
    format_version: 1,
    id: 'io.github.tester/skills',
    name: 'Skills',
    version: '1.0.0',
    contributions: { skills: dirs.map((dir) => ({ dir: `skills/${dir}` })) },
  });
}

const identity: PluginIdentity = {
  id: 'io.github.tester/skills',
  version: '1.0.0',
  origin: 'local',
  tier: 'developer',
};

function ctxOf(
  rig: Rig,
  contentDir: string,
  manifest: PluginManifest,
  ledger: PluginLedger,
  owned: Readonly<Record<ProjectedKind, ReadonlySet<string>>> = emptyOwned(),
): PluginProjectionContext {
  return { plugin: identity, manifest, dir: contentDir, userConfig: {}, ledger, owned };
}

/** 直接往公共域装一份技能（模拟预置 / 其它来源），返回其库行 id。 */
function installPublicFrom(
  rig: Rig,
  input: { name: string; dir: string; sourceUrl: string; commitOid?: string },
): string {
  rig.skills.installPublic({
    name: input.name,
    scan: {
      compatibility: 'compatible',
      compatibilityReasons: [],
      runtimeDeps: [],
      sandboxDeclaration: null,
      files: [],
    } as never,
    sourceUrl: input.sourceUrl,
    commitOid: input.commitOid ?? '0.9.0',
    contentHash: hashDirectory(input.dir),
    stagingDir: input.dir,
  });
  return rig.skills.publicSkillRow(input.name)!.library_id;
}

const STARTER_SOURCE = 'plugin://com.kepcup/starter-skills/beta';
const OWN_SOURCE = 'plugin://io.github.tester/skills/beta';

describe('SkillsProjector', () => {
  it('inspect：同名公共技能冲突（任何来源），Bot 私有同名不算；无法解析进 blockers', async () => {
    const rig = makeRig();
    const contentDir = makeContentDir([{ name: 'alpha' }, { name: 'beta', script: 'echo hi' }]);
    // 预置来源的同名公共技能 → 冲突
    rig.skills.installPublic({
      name: 'beta',
      scan: {
        compatibility: 'compatible',
        compatibilityReasons: [],
        runtimeDeps: [],
        sandboxDeclaration: null,
        files: [],
      } as never,
      sourceUrl: 'preset://beta',
      commitOid: '9.9.9',
      contentHash: `hash-beta-${Math.random()}`,
      stagingDir: path.join(contentDir, 'skills', 'beta'),
    });
    // Bot 私有同名技能只是遮蔽，不冲突
    rig.db
      .prepare(
        "insert into bot_skills (bot_id, name, kind, library_id, status, status_reason, created_at, updated_at) values ('bot_a', 'alpha', 'authored', null, 'active', null, 1, 1)",
      )
      .run();

    const ledger = new MemLedger();
    const result = await rig.projector.inspect(
      ctxOf(rig, contentDir, manifestOf(['alpha', 'beta']), ledger),
    );
    expect(result.items.map((item) => [item.name, item.compatible])).toEqual([
      ['alpha', true],
      ['beta', true],
    ]);
    expect(result.items[1]!.runtimeDeps).toEqual(['bash']); // echo 脚本经 shell 运行
    expect(result.conflicts).toEqual([
      { kind: 'skill', ref: 'beta', withWhat: '已有同名公共技能' },
    ]);
    expect(result.blockers).toEqual([]);
  });

  it('inspect：其它可安装插件的同名公共技能仍是冲突（收编只认保留命名空间）', async () => {
    const rig = makeRig();
    const contentDir = makeContentDir([{ name: 'beta' }]);
    installPublicFrom(rig, {
      name: 'beta',
      dir: path.join(makeContentDir([{ name: 'beta', description: '别家插件' }]), 'skills', 'beta'),
      sourceUrl: 'plugin://io.github.other/pack/beta',
    });
    const result = await rig.projector.inspect(
      ctxOf(rig, contentDir, manifestOf(['beta']), new MemLedger()),
    );
    expect(result.conflicts).toEqual([
      { kind: 'skill', ref: 'beta', withWhat: '已有同名公共技能' },
    ]);
  });

  it('收编：内置预置装的同名公共技能不算冲突，project 换成插件来源并回收旧版本，之后卸载能删', async () => {
    const rig = makeRig();
    const contentDir = makeContentDir([{ name: 'beta' }]);
    // 插件系统上线前从技能市场装的预置（0054 迁移后的来源标记），内容是另一个版本
    const presetDir = path.join(
      makeContentDir([{ name: 'beta', description: '旧版预置' }]),
      'skills',
      'beta',
    );
    const presetLibraryId = installPublicFrom(rig, {
      name: 'beta',
      dir: presetDir,
      sourceUrl: STARTER_SOURCE,
    });

    const ledger = new MemLedger();
    const ctx = ctxOf(rig, contentDir, manifestOf(['beta']), ledger);
    expect((await rig.projector.inspect(ctx)).conflicts).toEqual([]);

    await rig.projector.project(ctx);
    const row = rig.skills.publicSkillRow('beta')!;
    const library = rig.skills.libraryGet(row.library_id)!;
    expect(library.source_url).toBe(OWN_SOURCE);
    expect(library.content_hash).toBe(hashDirectory(path.join(contentDir, 'skills', 'beta')));
    expect(ledger.list('skill')).toEqual(['beta']);
    // 旧预置版本无人引用：行与目录都回收
    expect(rig.skills.libraryGet(presetLibraryId)).toBeNull();
    expect(
      existsSync(rig.skills.libraryDirOf({ name: 'beta', content_hash: hashDirectory(presetDir) })),
    ).toBe(false);

    // 归属已在插件名下：卸载插件删得掉（之前 source_url 不匹配会被跳过而留下孤儿）
    await rig.projector.unproject(identity, ['beta'], ledger);
    expect(rig.skills.publicSkillRow('beta')).toBeNull();
    expect(ledger.list('skill')).toEqual([]);
  });

  it('收编同内容预置且有 Bot 私有引用：库行保留，来源标记与版本改成插件的', async () => {
    const rig = makeRig();
    const contentDir = makeContentDir([{ name: 'beta' }]);
    const skillDir = path.join(contentDir, 'skills', 'beta');
    const libraryId = installPublicFrom(rig, {
      name: 'beta',
      dir: skillDir,
      sourceUrl: STARTER_SOURCE,
      commitOid: '0.9.0',
    });
    // bot_a 私有导入了同一份内容（同一库行）
    rig.db
      .prepare(
        "insert into bot_skills (bot_id, name, kind, library_id, status, status_reason, created_at, updated_at) values ('bot_a', 'beta', 'imported', ?, 'active', null, 1, 1)",
      )
      .run(libraryId);

    const ledger = new MemLedger();
    await rig.projector.project(ctxOf(rig, contentDir, manifestOf(['beta']), ledger));
    const library = rig.skills.libraryGet(libraryId)!;
    expect(library.source_url).toBe(OWN_SOURCE);
    expect(library.commit_oid).toBe(identity.version);
    expect(existsSync(rig.skills.libraryDirOf(library))).toBe(true);
    expect(rig.skills.publicSkillRow('beta')!.library_id).toBe(libraryId);

    // 卸载插件：公共行删掉；库行因 Bot 私有引用保留
    await rig.projector.unproject(identity, ['beta'], ledger);
    expect(rig.skills.publicSkillRow('beta')).toBeNull();
    expect(rig.skills.libraryGet(libraryId)).not.toBeNull();
    expect(existsSync(rig.skills.libraryDirOf(library))).toBe(true);
  });

  it('inspect：SKILL.md 解析失败 → blocker；运行时依赖出现在条目里', async () => {
    const rig = makeRig(() => true);
    const contentDir = makeContentDir([
      { name: 'good', script: '#!/usr/bin/env python3\nprint(1)' },
    ]);
    mkdirSync(path.join(contentDir, 'skills', 'broken'), { recursive: true });
    writeFileSync(path.join(contentDir, 'skills', 'broken', 'SKILL.md'), 'not-frontmatter');
    const manifest = manifestOf(['good', 'broken']);
    const ledger = new MemLedger();
    const result = await rig.projector.inspect(ctxOf(rig, contentDir, manifest, ledger));
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain('无法解析');
    const good = result.items.find((item) => item.name === 'good');
    expect(good?.runtimeDeps).toContain('python');
  });

  it('project 后 public_skills 行存在且 skill_library.source_url 是 plugin://…；unproject 只删自己的', async () => {
    const rig = makeRig();
    const contentDir = makeContentDir([{ name: 'alpha' }, { name: 'beta' }]);
    const manifest = manifestOf(['alpha', 'beta']);
    const ledger = new MemLedger();
    const ctx = ctxOf(rig, contentDir, manifest, ledger);
    await rig.projector.project(ctx);
    expect(rig.skills.publicSkillRow('alpha')).not.toBeNull();
    expect(rig.skills.publicSkillRow('beta')).not.toBeNull();
    expect(ledger.list('skill')).toEqual(['alpha', 'beta']);
    const sourceUrls = rig.db
      .prepare("select source_url from skill_library where name in ('alpha','beta')")
      .all() as Array<{ source_url: string }>;
    expect(sourceUrls.map((row) => row.source_url).sort()).toEqual([
      'plugin://io.github.tester/skills/alpha',
      'plugin://io.github.tester/skills/beta',
    ]);

    // 另一来源装同名公共技能，并硬塞进账本：unproject 绝不删别人的
    rig.skills.installPublic({
      name: 'gamma',
      scan: {
        compatibility: 'compatible',
        compatibilityReasons: [],
        runtimeDeps: [],
        sandboxDeclaration: null,
        files: [],
      } as never,
      sourceUrl: 'preset://gamma',
      commitOid: '9.9.9',
      contentHash: `hash-gamma-${Math.random()}`,
      stagingDir: makeContentDir([{ name: 'gamma' }]) + '/skills/gamma',
    });
    ledger.add('skill', 'gamma');
    await rig.projector.unproject(identity, ledger.list('skill'), ledger);
    expect(rig.skills.publicSkillRow('alpha')).toBeNull();
    expect(rig.skills.publicSkillRow('beta')).toBeNull();
    expect(rig.skills.publicSkillRow('gamma')).not.toBeNull(); // 别人的技能安然无恙
    expect(ledger.list('skill')).toEqual([]);
    // 幂等：再跑一遍不抛
    await rig.projector.unproject(identity, ['alpha'], ledger);
  });

  it('setEnabled 往返：false 摘掉公共行（账本不动），true 重新投影', async () => {
    const rig = makeRig();
    const contentDir = makeContentDir([{ name: 'alpha' }]);
    const manifest = manifestOf(['alpha']);
    const ledger = new MemLedger();
    const ctx = ctxOf(rig, contentDir, manifest, ledger);
    await rig.projector.project(ctx);
    expect(rig.skills.publicSkillRow('alpha')).not.toBeNull();

    await rig.projector.setEnabled(ctx, ['alpha'], false);
    expect(rig.skills.publicSkillRow('alpha')).toBeNull();
    expect(ledger.list('skill')).toEqual(['alpha']);

    await rig.projector.setEnabled(ctx, ['alpha'], true);
    expect(rig.skills.publicSkillRow('alpha')).not.toBeNull();
  });

  it('missing：行不存在或目录被应用外删除时报告', async () => {
    const rig = makeRig();
    const contentDir = makeContentDir([{ name: 'alpha' }]);
    const manifest = manifestOf(['alpha']);
    const ledger = new MemLedger();
    await rig.projector.project(ctxOf(rig, contentDir, manifest, ledger));
    expect(rig.projector.missing(identity, ['alpha', 'ghost'])).toEqual(['ghost']);

    // 内容在应用外被删除
    const row = rig.skills.publicSkillRow('alpha')!;
    const library = rig.skills.libraryGet(row.library_id)!;
    rmSync(rig.skills.libraryDirOf(library), { recursive: true, force: true });
    expect(rig.projector.missing(identity, ['alpha'])).toEqual(['alpha']);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openRepository } from 'es-git';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import type { Clock } from '../../src/infra/clock.js';
import { botSkillDir, botSkillsRoot, resolvePaths } from '../../src/infra/paths.js';
import { SkillsService } from '../../src/skills/registry.js';
import { scanSkillDir } from '../../src/skills/scan.js';
import { parseSkillDir } from '../../src/skills/parse.js';

/**
 * D88 P1 技能复制（`SkillsService.copyForHandover`，设计 37 §3）：导入的给 B 加一行指向
 * 同一 library 版本（不重复克隆、不走 skill_import 审批）；自写的复制目录进 B 的自写技能
 * 仓库并提交「从 {A} 复制 {name}」（真实 es-git 仓库）；停用状态照搬；同名拒绝；重复执行
 * 不出第二份。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'handover-skill-copy-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => stubLogger };

interface Rig {
  skills: SkillsService;
  db: SqliteDatabase;
  paths: ReturnType<typeof resolvePaths>;
}

function makeRig(): Rig {
  const home = path.join(dir, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let tick = 0;
  const clock: Clock = { now: () => 1_000_000 + tick++ };
  const skills = new SkillsService({
    paths,
    db,
    clock,
    logger: stubLogger,
    bots: {
      get: (id) => (id === 'bot_a' || id === 'bot_b' ? { id, name: id, status: 'active' } : null),
    },
    publish: () => {},
    jobs: { enqueue: () => 'job_x' },
  });
  return { skills, db, paths };
}

function installImported(rig: Rig, botId: string, name: string): void {
  const stagingDir = path.join(rig.paths.cacheDir, 'staging', `${name}-${botId}`);
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    path.join(stagingDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的描述\n---\n正文`,
  );
  rig.skills.installImported({
    botId,
    conversationId: 'conv_x',
    name,
    scan: scanSkillDir(stagingDir, parseSkillDir(stagingDir)),
    sourceUrl: `https://example.com/${name}.git`,
    commitOid: '0123456789abcdef0123456789abcdef01234567',
    contentHash: `hash-${name}`,
    stagingDir,
    reuseExisting: false,
  });
}

async function authorSkill(rig: Rig, botId: string, name: string): Promise<void> {
  const draft = path.join(rig.paths.cacheDir, 'drafts', `${name}-${botId}`);
  mkdirSync(path.join(draft, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(draft, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 自己写的 ${name}\n---\n步骤……`,
  );
  writeFileSync(path.join(draft, 'scripts', 'run.sh'), '#!/usr/bin/env bash\necho ok\n');
  await rig.skills.promoteAuthored({ botId, name, draftDir: draft });
  rig.skills.activateAuthored(botId, name);
}

describe('SkillsService.copyForHandover (D88 P1)', () => {
  it('imported: B gets a row on the same library version; status carries over; idempotent', async () => {
    const rig = makeRig();
    installImported(rig, 'bot_a', 'deploy');
    rig.skills.disable('bot_a', 'deploy');
    const libraries = () =>
      (rig.db.prepare('select count(*) as n from skill_library').get() as { n: number }).n;
    expect(libraries()).toBe(1);

    expect(rig.skills.isHandoverCopy('bot_a', 'bot_b', 'deploy')).toBe(false);
    await rig.skills.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      name: 'deploy',
      fromName: 'A',
    });
    const source = rig.skills.botSkillRow('bot_a', 'deploy')!;
    const copy = rig.skills.botSkillRow('bot_b', 'deploy')!;
    expect(copy).toMatchObject({
      kind: 'imported',
      library_id: source.library_id,
      status: 'disabled',
    });
    // No re-clone: still one library version, shared by reference.
    expect(libraries()).toBe(1);
    expect(rig.skills.isHandoverCopy('bot_a', 'bot_b', 'deploy')).toBe(true);
    // Re-entrant.
    await rig.skills.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      name: 'deploy',
      fromName: 'A',
    });
    expect(rig.skills.rowsForBot('bot_b')).toHaveLength(1);
    // A uninstalling keeps B's reference alive (reference-counted library).
    rig.skills.uninstall('bot_a', 'deploy');
    expect(libraries()).toBe(1);
    expect(rig.skills.entryFor('bot_b', 'deploy')!.description).toContain('deploy');
  });

  it('a same-name private skill on B is never overwritten', async () => {
    const rig = makeRig();
    installImported(rig, 'bot_a', 'deploy');
    await authorSkill(rig, 'bot_b', 'deploy');
    await expect(
      rig.skills.copyForHandover({
        fromBotId: 'bot_a',
        toBotId: 'bot_b',
        name: 'deploy',
        fromName: 'A',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(rig.skills.botSkillRow('bot_b', 'deploy')!.kind).toBe('authored');
  });

  it('authored: the directory is copied into B’s repository and committed「从 A 复制」(real git)', async () => {
    const rig = makeRig();
    await authorSkill(rig, 'bot_a', 'weekly');
    await authorSkill(rig, 'bot_b', 'other');
    await rig.skills.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      name: 'weekly',
      fromName: 'A',
    });
    const target = botSkillDir(rig.paths, 'bot_b', 'weekly');
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('自己写的 weekly');
    expect(existsSync(path.join(target, 'scripts', 'run.sh'))).toBe(true);
    expect(rig.skills.botSkillRow('bot_b', 'weekly')).toMatchObject({
      kind: 'authored',
      status: 'active',
      library_id: null,
    });
    const history = await rig.skills.history('bot_b', 'weekly');
    expect(history.map((entry) => entry.message)).toEqual(['从 A 复制 weekly']);
    // A's repository and B's other skill are untouched.
    expect((await rig.skills.history('bot_a', 'weekly')).map((e) => e.message)).toEqual([
      'skill: weekly',
    ]);
    expect(existsSync(botSkillDir(rig.paths, 'bot_b', 'other'))).toBe(true);
    const repo = await openRepository(botSkillsRoot(rig.paths, 'bot_b'));
    expect(repo.head().target()).toBeTruthy();
    expect(rig.skills.isHandoverCopy('bot_a', 'bot_b', 'weekly')).toBe(true);
    // Edits on one side do not affect the other (an independent copy).
    rig.skills.disable('bot_a', 'weekly');
    expect(rig.skills.botSkillRow('bot_b', 'weekly')!.status).toBe('active');
  });

  it('authored: a disabled skill stays disabled on B', async () => {
    const rig = makeRig();
    await authorSkill(rig, 'bot_a', 'weekly');
    rig.skills.disable('bot_a', 'weekly');
    await rig.skills.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      name: 'weekly',
      fromName: 'A',
    });
    expect(rig.skills.botSkillRow('bot_b', 'weekly')).toMatchObject({
      kind: 'authored',
      status: 'disabled',
    });
    expect((await rig.skills.history('bot_b', 'weekly')).map((e) => e.message)).toEqual([
      '从 A 复制 weekly',
    ]);
  });

  it('authored crash recovery: a half-copied directory without a row is redone', async () => {
    const rig = makeRig();
    await authorSkill(rig, 'bot_a', 'weekly');
    const target = botSkillDir(rig.paths, 'bot_b', 'weekly');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'SKILL.md'), 'half');
    await rig.skills.copyForHandover({
      fromBotId: 'bot_a',
      toBotId: 'bot_b',
      name: 'weekly',
      fromName: 'A',
    });
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('自己写的 weekly');
    expect(rig.skills.isHandoverCopy('bot_a', 'bot_b', 'weekly')).toBe(true);
  });
});

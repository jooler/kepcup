import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import type { Clock } from '../../src/infra/clock.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { SkillsService } from '../../src/skills/registry.js';
import { SkillPresetsService, PRESET_SOURCE_PREFIX } from '../../src/skills/presets.js';
import { scanSkillDir } from '../../src/skills/scan.js';
import { parseSkillDir } from '../../src/skills/parse.js';

/**
 * 技能市场服务（skills/presets.ts）：公共作用域语义——安装一次写入
 * public_skills，所有 Bot 发现并调用；私有同名技能对该 Bot 遮蔽公共版本；
 * 预置版本原位替换；同名非预置公共条目拒改。
 */

const root = mkdtempSync(path.join(tmpdir(), 'skills-presets-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => stubLogger };

interface Rig {
  skills: SkillsService;
  db: SqliteDatabase;
  paths: ReturnType<typeof resolvePaths>;
}

function makeRig(publish: (event: string, payload: unknown) => void = () => {}): Rig {
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
      get: (id) => (id === 'bot_a' || id === 'bot_b' ? { id, name: id, status: 'active' } : null),
    },
    publish,
  });
  return { skills, db, paths };
}

/** 夹具预置目录：catalog + 技能目录（可选脚本做依赖推断）。 */
function makePresetDir(entries: { dir: string; name: string; description: string; script?: string }[]): string {
  const presetDir = path.join(root, `presets-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(presetDir, { recursive: true });
  const catalog = {
    version: 1,
    presets: entries.map((entry, index) => ({
      id: entry.name,
      dir: entry.dir,
      section: 'starter',
      displayName: `预置 ${entry.name}`,
      summary: `${entry.name} 的一句话`,
      icon: 'puzzle',
      version: `1.0.${index}`,
      tryIt: `试试 ${entry.name}`,
    })),
  };
  writeFileSync(path.join(presetDir, 'catalog.json'), JSON.stringify(catalog));
  for (const entry of entries) {
    const dir = path.join(presetDir, entry.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n正文`,
    );
    if (entry.script !== undefined) {
      mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      writeFileSync(path.join(dir, 'scripts', 'run.sh'), entry.script);
    }
  }
  return presetDir;
}

function makeService(rig: Rig, presetDir: string | null, depAvailable?: (dep: string) => boolean) {
  return new SkillPresetsService({
    env: presetDir !== null ? { KEPCUP_PRESET_SKILLS: presetDir } : {},
    logger: stubLogger,
    skills: rig.skills,
    ...(depAvailable !== undefined ? { environment: { depAvailable } } : {}),
  });
}

describe('SkillPresetsService（公共作用域）', () => {
  it('list：目录缺失时退化为空数组', () => {
    const rig = makeRig();
    // env 覆盖指向不存在的路径 → resolvePresetSkillsDir 返回 null（打包异常场景）
    const presets = makeService(rig, path.join(root, 'does-not-exist'));
    expect(presets.list()).toEqual([]);
  });

  it('catalog 指向不存在的技能目录时跳过该条目', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: 'alpha 技能' }]);
    writeFileSync(
      path.join(presetDir, 'catalog.json'),
      JSON.stringify({
        version: 1,
        presets: [
          { id: 'alpha', dir: 'alpha', section: 'starter', displayName: 'A', summary: 's', icon: 'puzzle', version: '1.0.0', tryIt: '' },
          { id: 'ghost', dir: 'ghost', section: 'starter', displayName: 'G', summary: 's', icon: 'puzzle', version: '1.0.0', tryIt: '' },
        ],
      }),
    );
    const presets = makeService(rig, presetDir);
    expect(presets.list().map((item) => item.id)).toEqual(['alpha']);
  });

  it('安装一次：所有 Bot 的清单都能看到（scope=public、active）', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: 'alpha 技能描述' }]);
    const presets = makeService(rig, presetDir);

    expect(presets.list()).toEqual([
      expect.objectContaining({ id: 'alpha', installed: false, upToDate: false, foreign: false }),
    ]);

    const after = presets.install('alpha');
    expect(after[0]).toEqual(expect.objectContaining({ id: 'alpha', installed: true, upToDate: true }));

    for (const botId of ['bot_a', 'bot_b']) {
      const list = rig.skills.listForBot(botId);
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(
        expect.objectContaining({ name: 'alpha', scope: 'public', status: 'active', kind: 'imported' }),
      );
      expect(list[0]!.sourceUrl).toBe(`${PRESET_SOURCE_PREFIX}alpha`);
      // 提示词/沙箱可见面：activeSkills 包含公共技能
      expect(rig.skills.activeSkills(botId).map((skill) => skill.name)).toEqual(['alpha']);
    }

    // 幂等：同内容重装是刷新，不产生第二个版本
    presets.install('alpha');
    expect(rig.skills.publicRows()).toHaveLength(1);
  });

  it('missingDeps：环境检查器判定缺失的运行依赖透出', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([
      { dir: 'py', name: 'pyskill', description: '需要 python 的技能', script: '#!/usr/bin/env python3\nprint("hi")\n' },
    ]);
    const withEnv = makeService(rig, presetDir, (dep) => dep !== 'python');
    expect(withEnv.list()[0]!.missingDeps).toEqual(['python']);
    const satisfied = makeService(rig, presetDir, () => true);
    expect(satisfied.list()[0]!.missingDeps).toEqual([]);
    // 检查器缺席时按缺失处理（保守提示）
    const strict = makeService(rig, presetDir);
    expect(strict.list()[0]!.missingDeps).toEqual(['python']);
  });

  it('预置版本升级：公共条目原位替换，旧库版本被引用计数回收', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: '第一版描述' }]);
    const presets = makeService(rig, presetDir);
    presets.install('alpha');
    const oldLibraryId = rig.skills.publicSkillRow('alpha')!.library_id;

    // 应用发版：随包技能内容变化
    writeFileSync(
      path.join(presetDir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: 第二版描述\n---\n新正文',
    );
    expect(presets.list()[0]).toEqual(
      expect.objectContaining({ installed: true, upToDate: false, foreign: false }),
    );

    presets.install('alpha');
    for (const botId of ['bot_a', 'bot_b']) {
      const list = rig.skills.listForBot(botId);
      expect(list).toHaveLength(1);
      expect(list[0]!.description).toContain('第二版描述');
    }
    // 旧版本无引用 → 库行被回收（目录随行删除，由 registry GC 负责）
    expect(rig.skills.libraryGet(oldLibraryId)).toBeNull();
  });

  it('同名非预置公共条目：拒绝覆盖（ALREADY_EXISTS）', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: '预置版描述' }]);
    const presets = makeService(rig, presetDir);

    // 公共作用域里先有一个非预置来源的同名技能
    const staging = path.join(root, 'foreign-alpha');
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      path.join(staging, 'SKILL.md'),
      '---\nname: alpha\ndescription: 用户导入的版本\n---\n正文',
    );
    const parsed = parseSkillDir(staging);
    const scan = scanSkillDir(staging, parsed);
    rig.skills.installPublic({
      name: 'alpha',
      scan,
      sourceUrl: 'https://example.com/alpha.git',
      commitOid: 'a'.repeat(40),
      contentHash: 'foreignhash',
      stagingDir: staging,
    });

    let code: string | undefined;
    try {
      presets.install('alpha');
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('ALREADY_EXISTS');
    expect(rig.skills.listForBot('bot_a')[0]!.description).toContain('用户导入的版本');
    expect(presets.list()[0]).toEqual(
      expect.objectContaining({ installed: true, upToDate: false, foreign: true }),
    );
  });

  it('私有同名技能遮蔽公共版本（仅对该 Bot），不影响其他 Bot', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: '公共版本' }]);
    const presets = makeService(rig, presetDir);
    presets.install('alpha');

    // bot_a 私有导入同名技能
    const staging = path.join(root, 'private-alpha');
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      path.join(staging, 'SKILL.md'),
      '---\nname: alpha\ndescription: bot_a 的私有版本\n---\n正文',
    );
    const parsed = parseSkillDir(staging);
    rig.skills.installImported({
      botId: 'bot_a',
      conversationId: 'conv',
      name: 'alpha',
      scan: scanSkillDir(staging, parsed),
      sourceUrl: 'https://example.com/alpha.git',
      commitOid: 'b'.repeat(40),
      contentHash: 'privatehash',
      stagingDir: staging,
      reuseExisting: false,
    });

    // bot_a：只见私有版本（遮蔽公共）；bot_b：仍见公共版本
    const a = rig.skills.listForBot('bot_a');
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual(expect.objectContaining({ scope: 'private', description: expect.stringContaining('bot_a 的私有版本') }));
    const b = rig.skills.listForBot('bot_b');
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual(expect.objectContaining({ scope: 'public' }));
    expect(rig.skills.activeSkills('bot_a').map((skill) => skill.name)).toEqual(['alpha']);

    // 公共安装不再是冲突：预置更新对 bot_a 也只是更新公共行（仍被遮蔽）
    writeFileSync(
      path.join(presetDir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: 第二版公共\n---\n正文',
    );
    presets.install('alpha');
    expect(rig.skills.listForBot('bot_a')).toHaveLength(1);
    expect(rig.skills.listForBot('bot_b')[0]!.description).toContain('第二版公共');
  });

  it('启停与卸载是全局的：从任意 Bot 面板操作，全体生效', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: '公共版本' }]);
    const presets = makeService(rig, presetDir);
    presets.install('alpha');

    // 从 bot_a 的面板停用 → 所有 Bot 停用
    const disabled = rig.skills.disable('bot_a', 'alpha');
    expect(disabled.scope).toBe('public');
    expect(rig.skills.listForBot('bot_b')[0]!.status).toBe('disabled');
    expect(rig.skills.activeSkills('bot_a')).toHaveLength(0);

    rig.skills.enable('bot_b', 'alpha');
    expect(rig.skills.listForBot('bot_a')[0]!.status).toBe('active');

    // 从 bot_a 的面板卸载（无私有行 → 公共卸载）→ 全体消失，库回收
    const libraryId = rig.skills.publicSkillRow('alpha')!.library_id;
    rig.skills.uninstall('bot_a', 'alpha');
    expect(rig.skills.publicSkillRow('alpha')).toBeNull();
    expect(rig.skills.listForBot('bot_a')).toHaveLength(0);
    expect(rig.skills.listForBot('bot_b')).toHaveLength(0);
    expect(rig.skills.libraryGet(libraryId)).toBeNull();

    // 安装态回到未安装
    expect(presets.list()[0]).toEqual(expect.objectContaining({ installed: false }));
  });

  it('未知 presetId → NOT_FOUND', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: 'alpha 技能' }]);
    const presets = makeService(rig, presetDir);
    expect(() => presets.install('nope')).toThrowError(/不存在/);
  });

  it('私有技能卸载不回收仍被公共引用的库版本', () => {
    const rig = makeRig();
    const presetDir = makePresetDir([{ dir: 'alpha', name: 'alpha', description: '公共版本' }]);
    const presets = makeService(rig, presetDir);
    presets.install('alpha');
    // bot_a 又私有导入同名（同内容，哈希一致 → 引用同一库版本）
    const libraryId = rig.skills.publicSkillRow('alpha')!.library_id;
    const dir = rig.skills.libraryGet(libraryId)!.rel_path;
    const absDir = path.join(rig.paths.home, dir);
    const parsed = parseSkillDir(absDir);
    rig.skills.installImported({
      botId: 'bot_a',
      conversationId: 'conv',
      name: 'alpha',
      scan: scanSkillDir(absDir, parsed),
      sourceUrl: `${PRESET_SOURCE_PREFIX}alpha`,
      commitOid: 'c'.repeat(40),
      contentHash: rig.skills.libraryGet(libraryId)!.content_hash,
      stagingDir: absDir,
      reuseExisting: true,
    });
    // 卸载私有行：公共行还在 → 库版本不回收
    rig.skills.uninstall('bot_a', 'alpha');
    expect(rig.skills.libraryGet(libraryId)).not.toBeNull();
    expect(rig.skills.listForBot('bot_a')[0]).toEqual(expect.objectContaining({ scope: 'public' }));
  });

  it('库目录在应用外被删除：列表/读取/市场各发现一次 skills.missing（去重）；purgeMissing 清掉 DB 行后可重装', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const rig = makeRig((event, payload) => events.push({ event, payload }));
    const presetDir = makePresetDir([{ dir: 'gone', name: 'gone-skill', description: '会被删掉' }]);
    const service = makeService(rig, presetDir);
    service.install('gone-skill');
    const row = rig.skills.publicSkillRow('gone-skill')!;
    const library = rig.skills.libraryGet(row.library_id)!;
    const dir = rig.skills.libraryDirOf(library);
    rmSync(dir, { recursive: true, force: true });
    events.length = 0;

    rig.skills.listForBot('bot_a');
    rig.skills.listForBot('bot_b');
    expect(rig.skills.activeSkills('bot_a')).toHaveLength(0);
    expect(() => rig.skills.readSkill('bot_a', 'gone-skill')).toThrow(/技能目录不存在/);
    // 市场：按「可更新」显示而非「✓ 已添加」。
    expect(service.list().find((preset) => preset.id === 'gone-skill')).toMatchObject({
      installed: true,
      upToDate: false,
      foreign: false,
    });
    const missing = events.filter((entry) => entry.event === 'skills.missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.payload).toEqual({
      name: 'gone-skill',
      scope: 'public',
      botId: null,
      libraryId: library.id,
      dirPath: dir,
    });

    // 「知道了」→ 清理：public_skills + skill_library 行都没了，广播全局变更。
    events.length = 0;
    expect(rig.skills.purgeMissing('gone-skill')).toBe(1);
    expect(rig.skills.publicSkillRow('gone-skill')).toBeNull();
    expect(rig.skills.libraryGet(library.id)).toBeNull();
    expect(events.some((entry) => entry.event === 'skills.changed')).toBe(true);
    expect(rig.skills.purgeMissing('gone-skill')).toBe(0);
    expect(service.list().find((preset) => preset.id === 'gone-skill')).toMatchObject({
      installed: false,
    });

    // 清理后重新添加：目录重建，再次缺失会再报一次（去重记录已清）。
    service.install('gone-skill');
    expect(rig.skills.publicSkillRow('gone-skill')).not.toBeNull();
    expect(rig.skills.readSkill('bot_a', 'gone-skill').content).toContain('gone-skill');
    rmSync(rig.skills.libraryDirOf(rig.skills.libraryGet(rig.skills.publicSkillRow('gone-skill')!.library_id)!), {
      recursive: true,
      force: true,
    });
    events.length = 0;
    rig.skills.listForBot('bot_a');
    expect(events.filter((entry) => entry.event === 'skills.missing')).toHaveLength(1);
  });

  it('closeDatabase 释放夹具库', () => {
    const rig = makeRig();
    closeDatabase(rig.db);
    expect(true).toBe(true);
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { copySkillTree } from '../../src/skills/library.js';
import { scanSkillDir } from '../../src/skills/scan.js';
import { parseSkillDir } from '../../src/skills/parse.js';
import type { SkillScan } from '@kepcup/shared';

const dir = mkdtempSync(path.join(tmpdir(), 'skills-registry-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  skills: SkillsService;
  db: SqliteDatabase;
  paths: ReturnType<typeof resolvePaths>;
}

function makeRig(enhancedSandbox?: { available: () => boolean; installHint: () => string }): Rig {
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
  const events: string[] = [];
  const skills = new SkillsService({
    paths,
    db,
    clock,
    logger: stubLogger,
    bots: {
      get: (id) => (id === 'bot_a' || id === 'bot_b' ? { id, name: id, status: 'active' } : null),
    },
    publish: (event) => events.push(event),
    ...(enhancedSandbox !== undefined ? { enhancedSandbox } : {}),
  });
  return { skills, db, paths };
}

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => stubLogger };

function stagingFor(rig: Rig, name: string): { stagingDir: string; scan: SkillScan } {
  const stagingDir = path.join(rig.paths.cacheDir, 'staging', name);
  mkdirSync(path.join(stagingDir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(stagingDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的描述\n---\n正文`,
  );
  writeFileSync(path.join(stagingDir, 'scripts', 'greet.sh'), '#!/usr/bin/env bash\necho hi\n');
  const parsed = parseSkillDir(stagingDir);
  return { stagingDir, scan: scanSkillDir(stagingDir, parsed) };
}

function installDirect(rig: Rig, botId: string, name: string, hashSuffix = ''): void {
  const { stagingDir, scan } = stagingFor(rig, name);
  rig.skills.installImported({
    botId,
    conversationId: 'conv_x',
    name,
    scan,
    sourceUrl: `https://example.com/${name}.git`,
    commitOid: '0123456789abcdef0123456789abcdef01234567',
    contentHash: `hash-${name}${hashSuffix}`,
    stagingDir,
    reuseExisting: false,
  });
}

/** SKILL.md 声明 `sandbox: enhanced` 的安装（P12 增强级门控）。 */
function installEnhancedDirect(rig: Rig, botId: string, name: string): void {
  const stagingDir = path.join(rig.paths.cacheDir, 'staging', name);
  mkdirSync(path.join(stagingDir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(stagingDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的描述\nsandbox: enhanced\n---\n正文`,
  );
  writeFileSync(path.join(stagingDir, 'scripts', 'greet.sh'), '#!/usr/bin/env bash\necho hi\n');
  const parsed = parseSkillDir(stagingDir);
  rig.skills.installImported({
    botId,
    conversationId: 'conv_x',
    name,
    scan: scanSkillDir(stagingDir, parsed),
    sourceUrl: `https://example.com/${name}.git`,
    commitOid: '0123456789abcdef0123456789abcdef01234567',
    contentHash: `hash-${name}`,
    stagingDir,
    reuseExisting: false,
  });
}

describe('skills/registry（P08 任务 4：安装/冲突/引用回收）', () => {
  it('安装 → active；同名冲突拒绝；列表带描述与来源', () => {
    const rig = makeRig();
    installDirect(rig, 'bot_a', 'deploy');
    const list = rig.skills.listForBot('bot_a');
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('active');
    expect(list[0]!.kind).toBe('imported');
    expect(list[0]!.description).toContain('deploy');
    expect(list[0]!.sourceUrl).toContain('example.com');

    // 同名不同内容（不同哈希）→ 拒绝；相同内容重复导入 → 幂等重新激活。
    expect(() => installDirect(rig, 'bot_a', 'deploy', '-v2')).toThrowError(/同名/);
    installDirect(rig, 'bot_a', 'deploy');
    expect(rig.skills.listForBot('bot_a')).toHaveLength(1);
    closeDatabase(rig.db);
  });

  it('两个 Bot 安装同一版本 → 库中一份；卸载一个仍在；两个都卸载后被回收', () => {
    const rig = makeRig();
    installDirect(rig, 'bot_a', 'shared');
    const libraryId = rig.skills.listForBot('bot_a')[0]!.libraryId!;
    installDirect(rig, 'bot_b', 'shared');
    const row = rig.db
      .prepare('select count(*) as n from skill_library')
      .get() as { n: number };
    expect(row.n).toBe(1);

    const dirAfterInstall = rig.skills.libraryGet(libraryId) !== null;
    expect(dirAfterInstall).toBe(true);

    // 卸载 bot_a：bot_b 仍引用，目录保留
    rig.skills.uninstall('bot_a', 'shared');
    expect(existsSync(rig.skills.libraryDirOf(rig.skills.libraryGet(libraryId)!))).toBe(true);
    expect(rig.skills.listForBot('bot_b')).toHaveLength(1);

    // 卸载 bot_b：无引用 → 行与目录一起回收
    rig.skills.uninstall('bot_b', 'shared');
    expect(rig.skills.libraryGet(libraryId)).toBeNull();
    expect(existsSync(rig.skills.libraryDirOf({ name: 'shared', content_hash: 'hash-shared' }))).toBe(
      false,
    );
    closeDatabase(rig.db);
  });

  it('enable/disable 状态切换；still-incompatible 拒绝启用、可用性翻转后可重新启用（BR-P12-002）', () => {
    // 增强沙箱可用性可翻转的注入 facade（默认 rig = 不可用）。
    let enhancedAvailable = false;
    const rig = makeRig({
      available: () => enhancedAvailable,
      installHint: () => '安装 Lima 作为增强沙箱（brew install lima）',
    });
    installDirect(rig, 'bot_a', 'toggle');
    rig.skills.disable('bot_a', 'toggle');
    expect(rig.skills.entryFor('bot_a', 'toggle')!.status).toBe('disabled');
    rig.skills.enable('bot_a', 'toggle');
    expect(rig.skills.entryFor('bot_a', 'toggle')!.status).toBe('active');

    // 声明 sandbox: enhanced 的技能在增强沙箱缺席时导入 → 存储 incompatible。
    installEnhancedDirect(rig, 'bot_a', 'vm-only');
    expect(rig.skills.entryFor('bot_a', 'vm-only')!.status).toBe('incompatible');
    // 仍然不兼容（增强沙箱缺席）→ enable 拒绝（fail-closed，含提示文案）。
    expect(() => rig.skills.enable('bot_a', 'vm-only')).toThrowError(/增强沙箱/);

    // 安装增强沙箱（可用性翻转）→ 导入说明承诺的「技能面板重新启用」成立：
    // 存储状态不再是闸门，当前判定说了算，enable 回写 active。
    enhancedAvailable = true;
    rig.skills.enable('bot_a', 'vm-only');
    expect(rig.skills.entryFor('bot_a', 'vm-only')!.status).toBe('active');
    // 翻转回缺席后：active 行 fail-closed 退出可读目录（既有语义不回归）。
    enhancedAvailable = false;
    expect(rig.skills.readableDirs('bot_a').some((p) => p.includes('vm-only'))).toBe(false);
    closeDatabase(rig.db);
  });

  it('未安装的技能 enable/disable/uninstall 报 NOT_FOUND', () => {
    const rig = makeRig();
    expect(() => rig.skills.enable('bot_a', 'ghost')).toThrowError();
    expect(() => rig.skills.disable('bot_a', 'ghost')).toThrowError();
    expect(() => rig.skills.uninstall('bot_a', 'ghost')).toThrowError();
    closeDatabase(rig.db);
  });

  it('卸载 authored 技能只删引用，目录（git 历史）保留', async () => {
    const rig = makeRig();
    const drafts = path.join(rig.paths.home, 'drafts-tmp');
    mkdirSync(drafts, { recursive: true });
    writeFileSync(path.join(drafts, 'SKILL.md'), '---\nname: authored-one\ndescription: d\n---\n正文');
    await rig.skills.promoteAuthored({ botId: 'bot_a', name: 'authored-one', draftDir: drafts });
    rig.skills.activateAuthored('bot_a', 'authored-one');
    expect(rig.skills.entryFor('bot_a', 'authored-one')!.kind).toBe('authored');

    rig.skills.uninstall('bot_a', 'authored-one');
    expect(
      existsSync(path.join(rig.paths.home, 'bots', 'bot_a', 'skills', 'authored-one', 'SKILL.md')),
    ).toBe(true);
    closeDatabase(rig.db);
  });

  it('删除 Bot 级联：引用行清空，无引用库版本被回收（lifecycle 消费的钩子）', () => {
    const rig = makeRig();
    installDirect(rig, 'bot_a', 'solo'); // 只有 bot_a 引用
    installDirect(rig, 'bot_a', 'shared2');
    installDirect(rig, 'bot_b', 'shared2'); // bot_b 也引用
    const soloId = rig.skills.entryFor('bot_a', 'solo')!.libraryId!;
    const soloDir = rig.skills.libraryDirOf(rig.skills.libraryGet(soloId)!);

    rig.skills.prepareBotDeletion('bot_a');
    expect(rig.skills.rowsForBot('bot_a')).toHaveLength(0);
    expect(rig.skills.libraryGet(soloId)).toBeNull(); // 无引用 → 回收
    expect(existsSync(soloDir)).toBe(false);
    expect(rig.skills.entryFor('bot_b', 'shared2')).not.toBeNull(); // 他人引用保留
    closeDatabase(rig.db);
  });

  it('copySkillTree 复制内容并排除 .git；库文件只读（0444）', () => {
    const rig = makeRig();
    const source = path.join(rig.paths.cacheDir, 'copy-src');
    mkdirSync(path.join(source, '.git'), { recursive: true });
    mkdirSync(path.join(source, 'scripts'), { recursive: true });
    writeFileSync(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: copy\ndescription: d\n---\n正文');
    writeFileSync(path.join(source, 'scripts', 'x.sh'), 'echo hi');
    const target = path.join(rig.paths.cacheDir, 'copy-target');
    copySkillTree(source, target);
    expect(existsSync(path.join(target, '.git'))).toBe(false);
    expect(existsSync(path.join(target, 'SKILL.md'))).toBe(true);
    expect(statSync(path.join(target, 'SKILL.md')).mode & 0o222).toBe(0); // 无写权限位
    closeDatabase(rig.db);
  });

  it('readableDirs 只含 active 技能（BR-P08-003：停用/草稿不进网关与沙箱）', () => {
    const rig = makeRig();
    installDirect(rig, 'bot_a', 'on-skill');
    installDirect(rig, 'bot_a', 'off-skill');
    rig.skills.disable('bot_a', 'off-skill');
    // 草稿行：目录在 _drafts 下，同样不可读
    const draftDir = path.join(rig.paths.home, 'bots', 'bot_a', 'skills', '_drafts', 'draft-skill');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(path.join(draftDir, 'SKILL.md'), '---\nname: draft-skill\ndescription: d\n---\n正文');
    rig.skills.ensureDraftRow('bot_a', 'draft-skill', '验证未通过');

    const dirs = rig.skills.readableDirs('bot_a');
    const names = dirs.map((dir) => path.basename(dir));
    expect(names).toContain('on-skill@hash-on-skill');
    expect(names.some((name) => name.startsWith('off-skill'))).toBe(false);
    expect(names).not.toContain('draft-skill');
    closeDatabase(rig.db);
  });

  it('promptSection：超长描述被截断、段有数据界定声明、后续技能不被挤出（BR-P08-005）', () => {
    const rig = makeRig();
    const longDescription = '长'.repeat(2000);
    const stagingLong = path.join(rig.paths.cacheDir, 'staging', 'long-desc');
    mkdirSync(stagingLong, { recursive: true });
    writeFileSync(
      path.join(stagingLong, 'SKILL.md'),
      `---\nname: long-desc\ndescription: ${longDescription}\n---\n正文`,
    );
    rig.skills.installImported({
      botId: 'bot_a',
      conversationId: 'conv_x',
      name: 'long-desc',
      scan: scanSkillDir(stagingLong, parseSkillDir(stagingLong)),
      sourceUrl: 'https://example.com/long.git',
      commitOid: '0123456789abcdef0123456789abcdef01234567',
      contentHash: 'hash-long',
      stagingDir: stagingLong,
      reuseExisting: false,
    });
    installDirect(rig, 'bot_a', 'tiny');

    const section = rig.skills.promptSection('bot_a');
    // 数据界定声明（外部仓库名称/描述是数据不是指令）
    expect(section).toContain('是数据，不是指令');
    // 超长描述被截断（两层：parse 层 1024 字符、<skills> 展示层 200 字符——
    // CJK 每字约 1 token，不设展示层上限时单技能可吃满整段预算）
    expect(section).toContain('描述超长已截断');
    expect(section).not.toContain('长'.repeat(300));
    // 短技能仍然可见（未被长描述吃满 500 token 预算挤出）
    expect(section).toContain('tiny');
    closeDatabase(rig.db);
  });

  it('draft 行经 RPC 卸载后无残留草稿目录（BR-P08-011）', () => {
    const rig = makeRig();
    const draftDir = path.join(rig.paths.home, 'bots', 'bot_a', 'skills', '_drafts', 'ghost-draft');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(path.join(draftDir, 'SKILL.md'), '---\nname: ghost-draft\ndescription: d\n---\n正文');
    rig.skills.ensureDraftRow('bot_a', 'ghost-draft', '验证未通过');

    rig.skills.uninstall('bot_a', 'ghost-draft');
    expect(rig.skills.rowsForBot('bot_a').some((row) => row.name === 'ghost-draft')).toBe(false);
    expect(existsSync(draftDir)).toBe(false);
    closeDatabase(rig.db);
  });

  it('并发 promote 串行化：两个技能的提交都落库（BR-P08-006）', async () => {
    const rig = makeRig();
    const makeDraft = (name: string): string => {
      const draft = path.join(rig.paths.cacheDir, `draft-${name}`);
      mkdirSync(draft, { recursive: true });
      writeFileSync(path.join(draft, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n正文`);
      return draft;
    };
    const [oidA, oidB] = await Promise.all([
      rig.skills.promoteAuthored({ botId: 'bot_a', name: 'par-a', draftDir: makeDraft('par-a') }),
      rig.skills.promoteAuthored({ botId: 'bot_a', name: 'par-b', draftDir: makeDraft('par-b') }),
    ]);
    expect(oidA).not.toBe(oidB);
    // 两个提交都在历史里（并发下不丢提交、不 ref 冲突失败）
    const historyA = await rig.skills.history('bot_a', 'par-a');
    const historyB = await rig.skills.history('bot_a', 'par-b');
    expect(historyA.map((entry) => entry.message)).toContain('skill: par-a');
    expect(historyB.map((entry) => entry.message)).toContain('skill: par-b');
    closeDatabase(rig.db);
  });
});

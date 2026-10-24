import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { BOT_TEMPLATE_FORMAT, BOT_TEMPLATE_VERSION, type BotTemplate } from '@kepcup/shared';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import type { Clock } from '../../src/infra/clock.js';
import { botSkillDir, resolvePaths } from '../../src/infra/paths.js';
import { BotsService } from '../../src/domain/bots.js';
import { BotAvatarService } from '../../src/domain/avatars.js';
import { BotTemplateService } from '../../src/domain/bot-templates.js';
import { SkillsService } from '../../src/skills/registry.js';
import { scanSkillDir } from '../../src/skills/scan.js';
import { parseSkillDir } from '../../src/skills/parse.js';

/**
 * D48 Bot 模板（docs/design/48-bot-template-export.md）：
 *  - 导出：runtime 本机引用（MCP/连接/浏览器资料/InkCop/域名白名单）清空；preset
 *    头像保留、upload 头像内嵌字节；自写技能带文件、已导入技能只记来源。
 *  - 导入：sha256 防确认后替换；runtime 再清洗（防御纵深）；本机没有的智能体
 *    引擎回退内置；自写技能 staging 校验后 promote（真实 git 提交），单个失败
 *    跳过不回滚 Bot；已导入技能不安装、列清单提示。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'bot-templates-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => stubLogger };

interface Rig {
  db: SqliteDatabase;
  paths: ReturnType<typeof resolvePaths>;
  bots: BotsService;
  avatars: BotAvatarService;
  skills: SkillsService;
  templates: BotTemplateService;
}

function makeRig(agentSelectable?: (agentId: string) => boolean): Rig {
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
  const bots = new BotsService(db, clock);
  const avatars = new BotAvatarService({ paths, clock, bots });
  const skills = new SkillsService({
    paths,
    db,
    clock,
    logger: stubLogger,
    bots: {
      get: (id) => {
        const bot = bots.get(id);
        return bot === null ? null : { id: bot.id, name: bot.name, status: bot.status };
      },
    },
    publish: () => {},
    jobs: { enqueue: () => 'job_x' },
  });
  const templates = new BotTemplateService({
    paths,
    clock,
    logger: stubLogger,
    bots,
    avatars,
    skills,
    ...(agentSelectable !== undefined ? { agentSelectable } : {}),
  });
  return { db, paths, bots, avatars, skills, templates };
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

/** 写一份合法的模板 JSON 到临时文件（供 inspect/import 的拒绝路径用）。 */
function writeTemplateJson(mutate: (template: BotTemplate) => void): string {
  const template: BotTemplate = {
    format: BOT_TEMPLATE_FORMAT,
    version: BOT_TEMPLATE_VERSION,
    exportedAt: 1_000_000,
    profile: {
      identity: { name: '模板Bot', bio: '来自模板' },
      persona: { personality: '耐心', tone: '', style: '', values: '', sample_dialogues: '' },
      role: { expertise: '排版', responsibilities: '' },
      boundaries: [],
      runtime: {
        model: '',
        light_model: '',
        network_policy: 'open',
        network_allowlist: [],
        mcp_server_ids: [],
        app_connection_ids: [],
        browser_profile: '',
        message_transport: '',
        inkcop_agent_keys: [],
        agent: { id: '', model: '', effort: '', permission: 'workspace', capabilities: null },
      },
      behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: null },
    },
    skills: { authored: [], imported: [] },
  };
  mutate(template);
  const file = path.join(dir, `crafted-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify(template), 'utf8');
  return file;
}

describe('Bot 模板导出', () => {
  it('runtime 本机引用清空；模型/网络模式/能力包保留；preset 头像原样', () => {
    const rig = makeRig();
    const bot = rig.bots.create({
      identity: { name: '小秘', bio: '整理助手', avatar: 'preset:circle:blue' },
      persona: { personality: '细致', tone: '温和', style: '', values: '', sample_dialogues: '' },
      runtime: {
        model: 'zhipu/glm-4.7',
        light_model: '',
        network_policy: 'allowlist',
        network_allowlist: ['intranet.corp'],
        mcp_server_ids: ['mcp_local'],
        app_connection_ids: [],
        browser_profile: 'shared-1',
        message_transport: '',
        inkcop_agent_keys: ['ink-1'],
        agent: { id: '', model: '', effort: '', permission: 'workspace', capabilities: ['web'] },
      },
    });
    const template = rig.templates.buildTemplate(bot.id);
    expect(template.profile.runtime).toMatchObject({
      model: 'zhipu/glm-4.7',
      network_policy: 'allowlist',
      network_allowlist: [],
      mcp_server_ids: [],
      app_connection_ids: [],
      browser_profile: '',
      inkcop_agent_keys: [],
      agent: { capabilities: ['web'] },
    });
    expect(template.profile.identity.avatar).toBe('preset:circle:blue');
    expect(template.avatar).toBeUndefined();
    // preview 摘要给出剥离计数，确认页据此提示。
    const preview = rig.templates.preview(bot.id);
    expect(preview.stripped).toEqual({
      mcpServers: 1,
      appConnections: 0,
      browserProfile: true,
      inkcopAgents: 1,
      networkAllowlist: 1,
    });
    expect(preview.model).toBe('zhipu/glm-4.7');
  });

  it('upload 头像内嵌字节、Profile 里剥离引用；自写技能带文件、已导入只记来源', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '猫猫', bio: '' } });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    rig.avatars.upload(bot.id, 'image/png', png);
    await authorSkill(rig, bot.id, 'weekly-report');
    rig.skills.disable(bot.id, 'weekly-report');
    installImported(rig, bot.id, 'deploy');

    const template = rig.templates.buildTemplate(bot.id);
    expect(template.profile.identity.avatar).toBeUndefined();
    expect(template.avatar).toEqual({ mime: 'image/png', base64: png.toString('base64') });
    expect(template.skills.authored).toEqual([
      {
        name: 'weekly-report',
        status: 'disabled',
        files: [
          { path: 'SKILL.md', base64: expect.any(String) },
          { path: 'scripts/run.sh', base64: expect.any(String) },
        ],
      },
    ]);
    expect(template.skills.imported).toEqual([
      { name: 'deploy', sourceUrl: 'https://example.com/deploy.git' },
    ]);
  });

  it('导出写文件且 JSON 可读（格式/版本字段齐全）', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '导出者', bio: '' } });
    await authorSkill(rig, bot.id, 'hello');
    const target = path.join(dir, `export-${Math.random().toString(36).slice(2, 8)}.json`);
    const result = rig.templates.exportTo(bot.id, target);
    expect(result.counts).toEqual({ authoredSkills: 1, importedSkills: 0, hasAvatar: false });
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    expect(parsed.format).toBe(BOT_TEMPLATE_FORMAT);
    expect(parsed.version).toBe(BOT_TEMPLATE_VERSION);
    expect(parsed.skills.authored[0].name).toBe('hello');
  });
});

describe('Bot 模板导入', () => {
  it('跨设备往返：新 Bot 人设一致、自写技能落盘且 active、已导入技能只列清单', async () => {
    const source = makeRig();
    const bot = source.bots.create({
      identity: { name: '原机', bio: 'bio' },
      persona: { personality: '沉稳', tone: '', style: '', values: '', sample_dialogues: '' },
    });
    await authorSkill(source, bot.id, 'weekly-report');
    installImported(source, bot.id, 'deploy');
    const file = path.join(dir, `roundtrip-${Math.random().toString(36).slice(2, 8)}.json`);
    source.templates.exportTo(bot.id, file);

    // 另一台设备：全新的 home/db。
    const target = makeRig();
    const { sha256, name } = target.templates.inspect(file);
    expect(name).toBe('原机');
    const result = await target.templates.importFrom(file, sha256);
    expect(result.installedSkills).toEqual([{ name: 'weekly-report', status: 'active' }]);
    expect(result.skippedImportedSkills).toEqual([
      { name: 'deploy', sourceUrl: 'https://example.com/deploy.git' },
    ]);
    expect(result.failedSkills).toEqual([]);

    const created = target.bots.getOrThrow(result.botId);
    expect(created.profile.identity.name).toBe('原机');
    expect(created.profile.persona.personality).toBe('沉稳');
    expect(created.profile.runtime.mcp_server_ids).toEqual([]);
    expect(created.setupState ?? null).toBeNull();

    const skillDir = botSkillDir(target.paths, result.botId, 'weekly-report');
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain(
      '自己写的 weekly-report',
    );
    expect(target.skills.botSkillRow(result.botId, 'weekly-report')).toMatchObject({
      kind: 'authored',
      status: 'active',
    });
    // deploy 未安装。
    expect(target.skills.botSkillRow(result.botId, 'deploy')).toBeNull();
  });

  it('upload 头像随模板恢复；agent 引擎在本机不可用回退内置', async () => {
    const source = makeRig();
    const bot = source.bots.create({
      identity: { name: '带图', bio: '' },
      runtime: {
        agent: {
          id: 'ghost-agent',
          model: 'm1',
          effort: '',
          permission: 'ask',
          capabilities: ['web'],
        },
      },
    });
    const png = Buffer.from([1, 2, 3, 4]);
    source.avatars.upload(bot.id, 'image/png', png);
    const file = path.join(dir, `agent-${Math.random().toString(36).slice(2, 8)}.json`);
    source.templates.exportTo(bot.id, file);

    const target = makeRig(() => false); // 本机没有任何可用智能体
    const { sha256 } = target.templates.inspect(file);
    const result = await target.templates.importFrom(file, sha256);
    const created = target.bots.getOrThrow(result.botId);
    expect(created.profile.runtime.agent.id).toBe('');
    expect(created.profile.runtime.agent.model).toBe('');
    // 档位与能力包保留（应用级语义）。
    expect(created.profile.runtime.agent.permission).toBe('ask');
    expect(created.profile.runtime.agent.capabilities).toEqual(['web']);
    // 头像恢复为 upload: 引用且字节可读。
    expect(created.avatar?.startsWith('upload:')).toBe(true);
    const read = target.avatars.read(result.botId, created.avatar!.slice('upload:'.length));
    expect(Buffer.from(read.base64, 'base64')).toEqual(png);
  });

  it('sha256 不匹配拒绝（确认后文件被替换）', async () => {
    const rig = makeRig();
    const file = writeTemplateJson(() => {});
    await expect(rig.templates.importFrom(file, '0'.repeat(64))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('未知版本 / 非法 JSON / 路径穿越与绝对路径拒绝', () => {
    const rig = makeRig();
    const badVersion = writeTemplateJson((template) => {
      (template as unknown as { version: number }).version = 99;
    });
    expect(() => rig.templates.inspect(badVersion)).toThrowError(/version/);

    const notJson = path.join(dir, `notjson-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(notJson, 'not json', 'utf8');
    expect(() => rig.templates.inspect(notJson)).toThrowError(/JSON/);

    const traversal = writeTemplateJson((template) => {
      template.skills.authored = [
        {
          name: 'evil',
          status: 'active',
          files: [
            {
              path: '../evil.sh',
              base64: Buffer.from('x').toString('base64'),
            },
          ],
        },
      ];
    });
    expect(() => rig.templates.inspect(traversal)).toThrowError(/校验失败/);

    const absolute = writeTemplateJson((template) => {
      template.skills.authored = [
        {
          name: 'evil2',
          status: 'active',
          files: [{ path: '/etc/evil', base64: Buffer.from('x').toString('base64') }],
        },
      ];
    });
    expect(() => rig.templates.inspect(absolute)).toThrowError(/校验失败/);
  });

  it('单个技能安装失败（超单文件上限 / SKILL.md 名字不一致）跳过并报告，Bot 仍创建', async () => {
    const rig = makeRig();
    const big = Buffer.alloc(300 * 1024, 7).toString('base64');
    const mismatch = `---\nname: other-name\ndescription: 名字对不上\n---\n正文`;
    const file = writeTemplateJson((template) => {
      template.skills.authored = [
        { name: 'too-big', status: 'active', files: [{ path: 'SKILL.md', base64: big }] },
        {
          name: 'wrong-name',
          status: 'active',
          files: [{ path: 'SKILL.md', base64: Buffer.from(mismatch).toString('base64') }],
        },
      ];
    });
    const { sha256 } = rig.templates.inspect(file);
    const result = await rig.templates.importFrom(file, sha256);
    expect(result.installedSkills).toEqual([]);
    expect(result.failedSkills.map((skill) => skill.name).sort()).toEqual([
      'too-big',
      'wrong-name',
    ]);
    expect(rig.bots.getOrThrow(result.botId).profile.identity.name).toBe('模板Bot');
  });

  it('模板里残留的本机引用在导入时被强制清空（防御纵深）', async () => {
    const rig = makeRig();
    const file = writeTemplateJson((template) => {
      template.profile.runtime.mcp_server_ids = ['leaked-mcp'];
      template.profile.runtime.browser_profile = 'leaked-profile';
      template.profile.runtime.inkcop_agent_keys = ['leaked-ink'];
      template.profile.runtime.app_connection_ids = ['leaked-conn'];
      template.profile.runtime.network_allowlist = ['intranet.corp'];
      (template.profile.runtime as { message_transport: string }).message_transport =
        'inkcop-local';
    });
    const { sha256 } = rig.templates.inspect(file);
    const result = await rig.templates.importFrom(file, sha256);
    const runtime = rig.bots.getOrThrow(result.botId).profile.runtime;
    expect(runtime.mcp_server_ids).toEqual([]);
    expect(runtime.browser_profile).toBe('');
    expect(runtime.inkcop_agent_keys).toEqual([]);
    expect(runtime.app_connection_ids).toEqual([]);
    expect(runtime.network_allowlist).toEqual([]);
    expect(runtime.message_transport).toBe('');
  });
});

describe('Bot 模板边界与限额', () => {
  it('头像只保留可移植的 preset 引用：脏值 / 超长值 / 裸 upload 引用全部丢弃', async () => {
    const rig = makeRig();
    const dirty = rig.bots.create({
      identity: { name: '脏头像', bio: '', avatar: 'not-a-preset' as unknown as string },
    });
    expect(rig.templates.buildTemplate(dirty.id).profile.identity.avatar).toBeUndefined();

    const huge = rig.bots.create({
      identity: { name: '超长头像', bio: '', avatar: `preset:${'x'.repeat(5000)}` },
    });
    expect(rig.templates.buildTemplate(huge.id).profile.identity.avatar).toBeUndefined();

    const legacy = rig.bots.create({
      identity: { name: '旧相对路径', bio: '', avatar: 'avatars/legacy.png' },
    });
    expect(rig.templates.buildTemplate(legacy.id).profile.identity.avatar).toBeUndefined();

    const preset = rig.bots.create({
      identity: { name: '正常预置', bio: '', avatar: 'preset:hex:red' },
    });
    expect(rig.templates.buildTemplate(preset.id).profile.identity.avatar).toBe('preset:hex:red');
  });

  it('imported 技能 library_id 为 null 时 sourceUrl 为 null，不抛错', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '来源', bio: '' } });
    installImported(rig, bot.id, 'deploy');
    rig.db.prepare("update bot_skills set library_id = null where name = 'deploy'").run();
    const template = rig.templates.buildTemplate(bot.id);
    expect(template.skills.imported).toEqual([{ name: 'deploy', sourceUrl: null }]);
  });

  it('authored 技能目录已不在磁盘（外部删除）时静默跳过', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '目录丢失', bio: '' } });
    await authorSkill(rig, bot.id, 'vanished');
    rmSync(botSkillDir(rig.paths, bot.id, 'vanished'), { recursive: true, force: true });
    const template = rig.templates.buildTemplate(bot.id);
    expect(template.skills.authored).toEqual([]);
  });

  it('模板序列化超过 jsonBytes 上限时 exportTo 拒绝（不静默截断）', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '大模板', bio: '' } });
    // 5 个技能 × 3 个 256KB 文件 ≈ 3.9MB 二进制 → base64 ≈ 5.2MB > 4MB JSON 上限。
    for (let i = 0; i < 5; i++) {
      const name = `bulky-${i}`;
      const draft = path.join(rig.paths.cacheDir, 'drafts', `${name}-${bot.id}`);
      mkdirSync(draft, { recursive: true });
      writeFileSync(
        path.join(draft, 'SKILL.md'),
        `---\nname: ${name}\ndescription: 大文件技能 ${i}\n---\n正文`,
      );
      for (let j = 0; j < 3; j++) {
        writeFileSync(path.join(draft, `blob-${j}.bin`), Buffer.alloc(256 * 1024, i * 3 + j));
      }
      await rig.skills.promoteAuthored({ botId: bot.id, name, draftDir: draft });
      rig.skills.activateAuthored(bot.id, name);
    }
    const target = path.join(dir, `too-big-${Math.random().toString(36).slice(2, 8)}.json`);
    expect(() => rig.templates.exportTo(bot.id, target)).toThrowError(/上限/);
    expect(rig.templates.buildTemplate(bot.id).skills.authored).toHaveLength(5);
  });

  it('exportTo 目标路径的父目录是文件时抛错，不产生半截文件', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '坏路径', bio: '' } });
    const notADir = path.join(dir, `plain-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(notADir, '占位', 'utf8');
    expect(() => rig.templates.exportTo(bot.id, path.join(notADir, 'out.json'))).toThrow();
    // mkdirSync 在写临时文件之前就失败：占位文件原样、目标从未被创建。
    expect(readFileSync(notADir, 'utf8')).toBe('占位');
  });

  it('技能目录含点文件 / 中文文件名时报可读错误并列出路径（不是 INTERNAL）', async () => {
    const rig = makeRig();
    const dotfile = rig.bots.create({ identity: { name: '点文件', bio: '' } });
    await authorSkill(rig, dotfile.id, 'with-dotfile');
    writeFileSync(path.join(botSkillDir(rig.paths, dotfile.id, 'with-dotfile'), '.gitignore'), 'x');
    // buildTemplate / preview / exportTo 都是同步抛 AppError（不是裸 ZodError）。
    expect(() => rig.templates.buildTemplate(dotfile.id)).toThrowError(/\.gitignore.*不可移植/s);
    expect(() => rig.templates.preview(dotfile.id)).toThrowError(/\.gitignore/);

    const cjk = rig.bots.create({ identity: { name: '中文名', bio: '' } });
    await authorSkill(rig, cjk.id, 'with-cjk');
    writeFileSync(path.join(botSkillDir(rig.paths, cjk.id, 'with-cjk'), '说明.md'), '说明');
    expect(() => rig.templates.exportTo(cjk.id, path.join(dir, 'cjk.json'))).toThrowError(
      /说明\.md/,
    );
  });

  it('自写技能超过 20 个时导出拒绝（不静默截断）', async () => {
    const rig = makeRig();
    const bot = rig.bots.create({ identity: { name: '多技能', bio: '' } });
    for (let i = 0; i < 21; i++) {
      await authorSkill(rig, bot.id, `tiny-${i}`);
    }
    expect(() => rig.templates.buildTemplate(bot.id)).toThrowError(/超过 20 个/);
  });
});

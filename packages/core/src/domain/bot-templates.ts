import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AppError,
  BOT_TEMPLATE_FORMAT,
  BOT_TEMPLATE_LIMITS,
  BOT_TEMPLATE_VERSION,
  botTemplateSchema,
  botProfileSchema,
  isPortableSkillFilePath,
  type Bot,
  type BotProfile,
  type BotTemplate,
  type BotTemplateAuthoredSkill,
  type BotsTemplateImportOutput,
  type BotsTemplateInspectOutput,
  type BotsTemplatePreviewOutput,
} from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { BotsService } from './bots.js';
import type { BotAvatarService } from './avatars.js';
import type { SkillsService } from '../skills/registry.js';
import { parseSkillDir } from '../skills/parse.js';

/**
 * Bot 模板导出/导入（docs/design/48-bot-template-export.md）。模板 = 单个 JSON
 * 文件（`*.kepcup-bot.json`）：清洗掉本机引用的完整 Profile + 自写技能文件 +
 * 头像字节。对话、记忆、知识库、任务、组件、密钥全部在独立表/目录里，不在导出
 * 路径上——「不读那些表」即干净排除；唯一要清洗的就是 `profile.runtime` 里的
 * 本机引用字段（MCP/连接/浏览器资料/InkCop/域名白名单）。导入 = 从模板新建
 * Bot（复用 BotsService.create 的校验管线），runtime 再强制清洗一次（防御纵深：
 * 无论模板里残留什么都清空），本机不存在的智能体引擎回退内置。
 */

export interface BotTemplateDeps {
  paths: AppPaths;
  clock: Clock;
  logger: CoreLogger;
  bots: BotsService;
  avatars: BotAvatarService;
  skills: SkillsService;
  /**
   * 导入时外部智能体引擎在本机是否可用（实验开关 + 目录）；不可用 → 回退内置
   * 引擎。未装配（单测）时视为可用，保留模板原值。
   */
  agentSelectable?: ((agentId: string) => boolean) | undefined;
}

const AVATAR_MAX_BYTES = 3_000_000;

/** 可移植头像引用：`preset:{shapeId}:{colorId}`（渲染端 SVG，任何设备可用）。 */
const PORTABLE_AVATAR_RE = /^preset:[a-z][a-z0-9]{0,31}:[a-z][a-z0-9]{0,31}$/;

/** 深拷贝 Profile 后清空所有指向本机全局配置的引用字段。 */
function sanitizeProfileForTemplate(profile: BotProfile): BotProfile {
  const next = botProfileSchema.parse({
    ...profile,
    identity: { ...profile.identity },
    runtime: {
      ...profile.runtime,
      app_connection_ids: [],
      mcp_server_ids: [],
      browser_profile: '',
      inkcop_agent_keys: [],
      network_allowlist: [],
      message_transport: '',
    },
  });
  // `upload:` 头像在导出侧提取为 template.avatar 字节（导入侧没有字节，一律丢）；
  // 非法/遗留值（旧数据目录相对路径等）与超长脏值也丢——落回首字母占位头像。
  if (next.identity.avatar !== undefined && !PORTABLE_AVATAR_RE.test(next.identity.avatar)) {
    next.identity.avatar = undefined;
  }
  return next;
}

/** 模板 → 建 Bot 用的 Profile：再清洗一次（防御纵深）+ 引擎不可用回退。 */
function profileForImport(
  template: BotTemplate,
  agentSelectable: (agentId: string) => boolean,
): BotProfile {
  const profile = sanitizeProfileForTemplate(template.profile);
  const { agent } = profile.runtime;
  if (agent.id.length > 0 && !agentSelectable(agent.id)) {
    profile.runtime.agent = { ...agent, id: '', model: '' };
  }
  return profile;
}

function personaFilled(profile: BotProfile): boolean {
  const persona = profile.persona;
  return [
    persona.personality,
    persona.tone,
    persona.style,
    persona.values,
    persona.sample_dialogues,
  ].some((text) => text.trim().length > 0);
}

function roleFilled(profile: BotProfile): boolean {
  return (
    profile.role.expertise.trim().length > 0 || profile.role.responsibilities.trim().length > 0
  );
}

function avatarKind(profile: BotProfile): 'none' | 'preset' | 'upload' {
  const avatar = profile.identity.avatar ?? '';
  if (avatar.length === 0) return 'none';
  return avatar.startsWith('upload:') ? 'upload' : 'preset';
}

/** sha256 of the file bytes (lowercase hex) — import 必须回传 inspect 看到的值。 */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class BotTemplateService {
  constructor(private readonly deps: BotTemplateDeps) {}

  #agentSelectable(agentId: string): boolean {
    if (agentId.length === 0) return true;
    return this.deps.agentSelectable?.(agentId) ?? true;
  }

  #requireActiveBot(botId: string): Bot {
    const bot = this.deps.bots.getOrThrow(botId);
    if (bot.status !== 'active') {
      throw new AppError('CONVERSATION_READ_ONLY', `Bot ${botId} has been deleted`);
    }
    return bot;
  }

  // --- export -------------------------------------------------------------------

  /** 组装模板（超限抛 INVALID_INPUT，不静默截断）。 */
  buildTemplate(botId: string): BotTemplate {
    const bot = this.#requireActiveBot(botId);
    const source = bot.profile;
    const profile = sanitizeProfileForTemplate(source);

    let avatar: { mime: string; base64: string } | undefined;
    if (avatarKind(source) === 'upload') {
      try {
        avatar = this.deps.avatars.read(botId, source.identity.avatar!.slice('upload:'.length));
        if (Buffer.from(avatar.base64, 'base64').byteLength > AVATAR_MAX_BYTES) avatar = undefined;
      } catch (error) {
        // 头像文件已不在磁盘上：跳过内嵌（模板仍可导出，落默认头像）。
        this.deps.logger.warn({ botId, error }, 'template avatar read skipped');
        avatar = undefined;
      }
    }

    const authored: BotTemplateAuthoredSkill[] = [];
    const imported: { name: string; sourceUrl: string | null }[] = [];
    for (const row of this.deps.skills.rowsForBot(botId)) {
      if (row.status === 'draft') continue;
      if (row.kind === 'authored') {
        const dir = this.deps.skills.dirOf(row);
        if (dir === null) continue; // 目录已不在磁盘上（另有 skills.missing 上报）
        authored.push({
          name: row.name,
          status: row.status === 'active' ? 'active' : 'disabled',
          files: this.#readSkillFiles(row.name, dir),
        });
      } else if (row.kind === 'imported') {
        const library =
          row.library_id === null ? null : this.deps.skills.libraryGet(row.library_id);
        imported.push({ name: row.name, sourceUrl: library?.source_url ?? null });
      }
    }
    if (authored.length > BOT_TEMPLATE_LIMITS.authoredSkills) {
      throw new AppError(
        'INVALID_INPUT',
        `自写技能超过 ${BOT_TEMPLATE_LIMITS.authoredSkills} 个，无法导出为模板`,
      );
    }

    // 遮罩形状只在需要非默认值且确实内嵌了上传头像时写入；旧模板无该项 → circle。
    const avatarMask = avatar !== undefined && bot.avatarMask === 'rounded' ? 'rounded' : undefined;

    // 防御纵深：文件名已过滤，这里 safeParse 兜底任何残余的 schema 违规，
    // 不让裸 ZodError 变成 INTERNAL 吐给用户。
    const parsed = botTemplateSchema.safeParse({
      format: BOT_TEMPLATE_FORMAT,
      version: BOT_TEMPLATE_VERSION,
      exportedAt: this.deps.clock.now(),
      profile,
      ...(avatar !== undefined ? { avatar } : {}),
      ...(avatarMask !== undefined ? { avatarMask } : {}),
      skills: { authored, imported },
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AppError(
        'INVALID_INPUT',
        `模板构建校验失败：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      );
    }
    return parsed.data;
  }

  /** 读取一个自写技能目录的全部文件（跳过 .git/node_modules，同 copySkillTree）。 */
  #readSkillFiles(name: string, dir: string): { path: string; base64: string }[] {
    const files: { path: string; base64: string }[] = [];
    let total = 0;
    const walk = (current: string, prefix: string): void => {
      // 字节序排序（非 localeCompare）：同一技能在任何机器上导出的字节序一致，
      // 模板内容相同 → sha256 相同。
      const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile()) {
          // authoring 管线对文件名没有约束（LLM 会写出 .gitignore / 说明.md），
          // 不可移植的文件名在这里显式报错（列出路径），而不是等 schema 兜底炸
          // 成 INTERNAL；静默跳过会产出残缺技能，同样不可取。
          if (!isPortableSkillFilePath(rel)) {
            throw new AppError(
              'INVALID_INPUT',
              `技能 ${name} 里的 ${rel} 文件名不可移植（模板仅支持 ASCII 字母/数字/点/连字符/下划线），无法导出`,
            );
          }
          if (files.length >= BOT_TEMPLATE_LIMITS.filesPerSkill) {
            throw new AppError(
              'INVALID_INPUT',
              `技能 ${name} 的文件数超过 ${BOT_TEMPLATE_LIMITS.filesPerSkill}，无法导出为模板`,
            );
          }
          const bytes = readFileSync(abs);
          if (bytes.byteLength > BOT_TEMPLATE_LIMITS.fileBytes) {
            throw new AppError(
              'INVALID_INPUT',
              `技能 ${name} 里的 ${rel} 超过 ${BOT_TEMPLATE_LIMITS.fileBytes} 字节，无法导出为模板`,
            );
          }
          total += bytes.byteLength;
          if (total > BOT_TEMPLATE_LIMITS.skillBytes) {
            throw new AppError(
              'INVALID_INPUT',
              `技能 ${name} 的文件总量超过 ${BOT_TEMPLATE_LIMITS.skillBytes} 字节，无法导出为模板`,
            );
          }
          files.push({ path: rel, base64: bytes.toString('base64') });
        }
      }
    };
    walk(dir, '');
    if (files.length === 0) {
      throw new AppError('INVALID_INPUT', `技能 ${name} 目录为空，无法导出为模板`);
    }
    return files;
  }

  /** 导出确认页摘要。 */
  preview(botId: string): BotsTemplatePreviewOutput {
    const bot = this.#requireActiveBot(botId);
    const source = bot.profile;
    const template = this.buildTemplate(botId);
    return {
      name: source.identity.name,
      bio: source.identity.bio,
      personaFilled: personaFilled(source),
      roleFilled: roleFilled(source),
      boundariesCount: source.boundaries.length,
      model: source.runtime.model,
      lightModel: source.runtime.light_model,
      agentId: source.runtime.agent.id,
      authoredSkills: template.skills.authored.map((skill) => ({
        name: skill.name,
        status: skill.status,
        fileCount: skill.files.length,
      })),
      importedSkills: template.skills.imported,
      // 以清洗后的产物为准：头像读取失败 / 脏值被丢弃时这里如实报 none，
      // 不虚报「将包含头像」。
      avatar: template.avatar !== undefined ? 'upload' : avatarKind(template.profile),
      stripped: {
        mcpServers: source.runtime.mcp_server_ids.length,
        appConnections: source.runtime.app_connection_ids.length,
        browserProfile: source.runtime.browser_profile.length > 0,
        inkcopAgents: source.runtime.inkcop_agent_keys.length,
        networkAllowlist: source.runtime.network_allowlist.length,
      },
    };
  }

  /** 序列化并原子写入目标路径（保存对话框选出的位置）。 */
  exportTo(
    botId: string,
    target: string,
  ): {
    path: string;
    bytes: number;
    counts: { authoredSkills: number; importedSkills: number; hasAvatar: boolean };
  } {
    const template = this.buildTemplate(botId);
    const text = JSON.stringify(template, null, 2);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > BOT_TEMPLATE_LIMITS.jsonBytes) {
      throw new AppError(
        'INVALID_INPUT',
        `模板超过 ${BOT_TEMPLATE_LIMITS.jsonBytes} 字节上限，无法导出`,
      );
    }
    const dir = path.dirname(target);
    mkdirSync(dir, { recursive: true });
    // 随机后缀：同进程并发导出到同目录同名时不互踩临时文件。
    const tmp = path.join(
      dir,
      `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    writeFileSync(tmp, text, 'utf8');
    try {
      renameSync(tmp, target);
    } finally {
      // rename 成功后文件已不在原位（force 无害）；失败时清掉残留的临时文件。
      rmSync(tmp, { force: true });
    }
    this.deps.logger.info({ botId, target, bytes }, 'bot template exported');
    return {
      path: target,
      bytes,
      counts: {
        authoredSkills: template.skills.authored.length,
        importedSkills: template.skills.imported.length,
        hasAvatar: template.avatar !== undefined || avatarKind(template.profile) === 'preset',
      },
    };
  }

  // --- import -------------------------------------------------------------------

  #readTemplateFile(file: string): { bytes: Buffer; template: BotTemplate; sha256: string } {
    const stats = statSync(file);
    if (!stats.isFile()) {
      throw new AppError('INVALID_INPUT', '模板路径不是文件');
    }
    if (stats.size > BOT_TEMPLATE_LIMITS.readBytes) {
      throw new AppError('INVALID_INPUT', '模板文件过大');
    }
    const bytes = readFileSync(file);
    // stat 与 read 之间文件可能被换大：按实际读到的字节数再复核一次。
    if (bytes.byteLength > BOT_TEMPLATE_LIMITS.readBytes) {
      throw new AppError('INVALID_INPUT', '模板文件过大');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new AppError('INVALID_INPUT', '模板文件不是合法 JSON');
    }
    const template = botTemplateSchema.safeParse(parsed);
    if (!template.success) {
      const issue = template.error.issues[0];
      throw new AppError(
        'INVALID_INPUT',
        `模板文件校验失败：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      );
    }
    return { bytes, template: template.data, sha256: sha256Of(bytes) };
  }

  #summaryOf(template: BotTemplate): Omit<BotsTemplateInspectOutput, 'sha256'> {
    const { profile, skills, avatar } = template;
    return {
      name: profile.identity.name,
      bio: profile.identity.bio,
      personaFilled: personaFilled(profile),
      roleFilled: roleFilled(profile),
      boundariesCount: profile.boundaries.length,
      model: profile.runtime.model,
      lightModel: profile.runtime.light_model,
      agentId: profile.runtime.agent.id,
      authoredSkills: skills.authored.map((skill) => ({
        name: skill.name,
        status: skill.status,
        fileCount: skill.files.length,
      })),
      importedSkills: skills.imported,
      hasAvatar: avatar !== undefined || avatarKind(profile) === 'preset',
    };
  }

  /** 导入确认页摘要 + 文件 sha256。 */
  inspect(file: string): BotsTemplateInspectOutput {
    const { template, sha256 } = this.#readTemplateFile(file);
    return { sha256, ...this.#summaryOf(template) };
  }

  /** 校验并落盘一个自写技能（staging → 校验 → promote → 状态行）。失败抛错。 */
  async #installAuthoredSkill(
    botId: string,
    skill: BotTemplateAuthoredSkill,
  ): Promise<'active' | 'disabled'> {
    const staging = mkdtempSync(path.join(tmpdir(), 'kepcup-template-skill-'));
    try {
      const stagingRoot = path.resolve(staging);
      let total = 0;
      for (const file of skill.files) {
        const bytes = Buffer.from(file.base64, 'base64');
        if (bytes.byteLength > BOT_TEMPLATE_LIMITS.fileBytes) {
          throw new AppError('INVALID_INPUT', `文件 ${file.path} 超过单文件上限`);
        }
        total += bytes.byteLength;
        if (total > BOT_TEMPLATE_LIMITS.skillBytes) {
          throw new AppError('INVALID_INPUT', '技能文件总量超过上限');
        }
        const target = path.resolve(staging, file.path);
        // 防路径穿越：schema 已拒绝 `..`/绝对路径，这里按解析结果再拦一次。
        if (target !== stagingRoot && !target.startsWith(stagingRoot + path.sep)) {
          throw new AppError('INVALID_INPUT', `非法的技能文件路径：${file.path}`);
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      const parsed = parseSkillDir(staging);
      if (parsed === null) {
        throw new AppError('INVALID_INPUT', 'SKILL.md 缺失或不完整（需要 name 与 description）');
      }
      if (parsed.name !== skill.name) {
        throw new AppError(
          'INVALID_INPUT',
          `SKILL.md 的 name（${parsed.name}）与模板技能名（${skill.name}）不一致`,
        );
      }
      await this.deps.skills.promoteAuthored({ botId, name: skill.name, draftDir: staging });
      if (skill.status === 'active') {
        this.deps.skills.activateAuthored(botId, skill.name);
      } else {
        this.deps.skills.parkAuthored(botId, skill.name, '从模板导入，默认停用');
      }
      return skill.status;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** 从模板新建 Bot（skills 里 imported 只列清单不安装）。 */
  async importFrom(file: string, expectSha256: string): Promise<BotsTemplateImportOutput> {
    const { template, sha256 } = this.#readTemplateFile(file);
    if (sha256 !== expectSha256) {
      throw new AppError('INVALID_INPUT', '模板文件在确认后发生了变化，请重新选择并确认');
    }

    const profile = profileForImport(template, (id) => this.#agentSelectable(id));
    const bot = this.deps.bots.create(profile, { skipDefaultAgent: true });

    if (template.avatar !== undefined) {
      try {
        this.deps.avatars.upload(
          bot.id,
          template.avatar.mime,
          Buffer.from(template.avatar.base64, 'base64'),
        );
      } catch (error) {
        // 头像失败不阻塞导入（Bot 已建好），留默认头像。
        this.deps.logger.warn({ botId: bot.id, error }, 'template avatar import skipped');
      }
    }
    // 遮罩形状单独一列（不在 Profile 里），建完 Bot 再写；上传失败时写了也无害。
    if (template.avatar !== undefined && template.avatarMask === 'rounded') {
      this.deps.bots.setAvatarMask(bot.id, template.avatarMask);
    }

    const installedSkills: { name: string; status: 'active' | 'disabled' }[] = [];
    const failedSkills: { name: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const skill of template.skills.authored) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      try {
        const status = await this.#installAuthoredSkill(bot.id, skill);
        installedSkills.push({ name: skill.name, status });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn(
          { botId: bot.id, skill: skill.name, error },
          'template skill import failed',
        );
        failedSkills.push({ name: skill.name, reason });
      }
    }

    this.deps.logger.info(
      { botId: bot.id, file, installed: installedSkills.length, failed: failedSkills.length },
      'bot template imported',
    );
    return {
      botId: bot.id,
      installedSkills,
      failedSkills,
      skippedImportedSkills: template.skills.imported,
    };
  }
}

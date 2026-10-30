import { z } from 'zod';
import { botAvatarMaskSchema, botProfileSchema } from './types.js';

/**
 * Bot 模板（docs/design/48-bot-template-export.md）：把一个 Bot 导出为单个 JSON
 * 文件，供他人快速套用或自己换设备恢复。模板只含「能力 + 人设」：Profile（清洗
 * 掉本机引用后）、自写技能文件、头像；对话、记忆、知识库、任务、组件、密钥与
 * 本机连接引用永不包含。导入 = 从模板新建一个 Bot（`bots.template.*` RPC）。
 */

export const BOT_TEMPLATE_FORMAT = 'kepcup-bot-template';
export const BOT_TEMPLATE_VERSION = 1;

/** 导出/导入侧共用的限额（超限直接报错，不静默截断）。 */
export const BOT_TEMPLATE_LIMITS = {
  /** 最多打包的自写技能数。 */
  authoredSkills: 20,
  /** 每个技能目录内最多文件数。 */
  filesPerSkill: 32,
  /** 单个文件上限（字节）。 */
  fileBytes: 256 * 1024,
  /** 单个技能目录合计上限（字节）。 */
  skillBytes: 1024 * 1024,
  /** 序列化后的模板文件上限（字节）。 */
  jsonBytes: 4 * 1024 * 1024,
  /** inspect/import 读取文件的上限（字节）。 */
  readBytes: 8 * 1024 * 1024,
} as const;

/** Agent Skills 名字规则（与 core `sanitizeSkillName` 一致）。 */
const skillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid skill name');

/**
 * 技能内文件路径的可移植性规则（POSIX 风格相对路径）：ASCII 字母/数字/点/
 * 连字符/下划线，无反斜杠、无 `.`/`..`/`.git`/`node_modules` 段。schema 校验与
 * core 导出侧的文件过滤共用同一实现，避免两处漂移——authoring 管线对技能目录
 * 的文件名没有约束（LLM 会写出 `说明.md`、`.gitignore`），导出时必须显式报错
 * 而不是靠 schema 兜底炸成 INTERNAL。
 */
export function isPortableSkillFilePath(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9._\-/]*$/.test(value) &&
    !value
      .split('/')
      .some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          segment === '.git' ||
          segment === 'node_modules',
      )
  );
}

export const botTemplateSkillFilePathSchema = z
  .string()
  .max(200)
  .refine(isPortableSkillFilePath, 'invalid skill file path');

export const botTemplateSkillFileSchema = z.object({
  path: botTemplateSkillFilePathSchema,
  base64: z.string().base64(),
});
export type BotTemplateSkillFile = z.infer<typeof botTemplateSkillFileSchema>;

export const botTemplateAuthoredSkillSchema = z.object({
  name: skillNameSchema,
  /** draft 不进模板；disabled 照搬（导入后装上但停用）。 */
  status: z.enum(['active', 'disabled']),
  files: z.array(botTemplateSkillFileSchema).min(1).max(BOT_TEMPLATE_LIMITS.filesPerSkill),
});
export type BotTemplateAuthoredSkill = z.infer<typeof botTemplateAuthoredSkillSchema>;

/** 已导入技能只记清单（内容在本机 git 技能库里，导入端提示用户自行重新导入）。 */
export const botTemplateImportedSkillSchema = z.object({
  name: skillNameSchema,
  sourceUrl: z.string().nullable(),
});
export type BotTemplateImportedSkill = z.infer<typeof botTemplateImportedSkillSchema>;

export const botTemplateAvatarSchema = z.object({
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  base64: z.string().base64(),
});
export type BotTemplateAvatar = z.infer<typeof botTemplateAvatarSchema>;

export const botTemplateSchema = z
  .object({
    format: z.literal(BOT_TEMPLATE_FORMAT),
    /** 未知版本拒绝导入（明确的错误而不是猜语义）。 */
    version: z
      .number()
      .int()
      .refine((value) => value === BOT_TEMPLATE_VERSION, {
        message: `unsupported bot template version (expected ${BOT_TEMPLATE_VERSION})`,
      }),
    /** 导出时刻（epoch ms）。 */
    exportedAt: z.number().int().positive(),
    /** 清洗后的完整 Profile（本机引用字段已清空；导入侧会再强制清洗一次）。 */
    profile: botProfileSchema,
    /** `upload:` 头像内嵌字节；`preset:` 标识直接留在 profile.identity.avatar。 */
    avatar: botTemplateAvatarSchema.optional(),
    /**
     * 上传头像的遮罩形状（'rounded' 圆角方；缺省 = 'circle'）。只在上传头像需要
     * 非默认遮罩时写入，旧模板缺这一项照样能读——不破坏模板格式版本。
     */
    avatarMask: botAvatarMaskSchema.optional(),
    skills: z
      .object({
        authored: z.array(botTemplateAuthoredSkillSchema).max(BOT_TEMPLATE_LIMITS.authoredSkills),
        imported: z.array(botTemplateImportedSkillSchema).max(100),
      })
      .default({ authored: [], imported: [] }),
  })
  .refine((template) => template.profile.identity.name.trim().length > 0, {
    path: ['profile', 'identity', 'name'],
    message: 'Bot name must not be empty',
  });
export type BotTemplate = z.infer<typeof botTemplateSchema>;

/** 建议的模板文件名（保存对话框默认名）。 */
export function botTemplateFileName(name: string): string {
  const cleaned =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-\u4e00-\u9fff]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'bot';
  return `${cleaned}.kepcup-bot.json`;
}

// --- RPC 契约（bots.template.*）----------------------------------------------

const pathInput = z.string().min(1).max(4096);

export const botsTemplatePreviewInputSchema = z.object({ botId: z.string().min(1) });

/** 导出确认页摘要：将包含什么、哪些本机引用会被剥离。 */
export const botsTemplatePreviewOutputSchema = z.object({
  name: z.string(),
  bio: z.string(),
  personaFilled: z.boolean(),
  roleFilled: z.boolean(),
  boundariesCount: z.number().int(),
  model: z.string(),
  lightModel: z.string(),
  /** 外部智能体引擎 id（'' = 内置）。 */
  agentId: z.string(),
  authoredSkills: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['active', 'disabled']),
      fileCount: z.number().int(),
    }),
  ),
  importedSkills: z.array(z.object({ name: z.string(), sourceUrl: z.string().nullable() })),
  avatar: z.enum(['none', 'preset', 'upload']),
  /** 将被剥离（不进模板）的本机引用计数。 */
  stripped: z.object({
    mcpServers: z.number().int(),
    appConnections: z.number().int(),
    browserProfile: z.boolean(),
    inkcopAgents: z.number().int(),
    networkAllowlist: z.number().int(),
  }),
});
export type BotsTemplatePreviewOutput = z.infer<typeof botsTemplatePreviewOutputSchema>;

export const botsTemplateExportInputSchema = z.object({
  botId: z.string().min(1),
  /** 保存对话框选出的目标路径（.kepcup-bot.json）。 */
  path: pathInput,
});
export const botsTemplateExportOutputSchema = z.object({
  path: z.string(),
  bytes: z.number().int(),
  counts: z.object({
    authoredSkills: z.number().int(),
    importedSkills: z.number().int(),
    hasAvatar: z.boolean(),
  }),
});

export const botsTemplateInspectInputSchema = z.object({ path: pathInput });

/** 导入确认页摘要 + 文件 sha256（import 必须回传同一个值，防确认后被替换）。 */
export const botsTemplateInspectOutputSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string(),
  bio: z.string(),
  personaFilled: z.boolean(),
  roleFilled: z.boolean(),
  boundariesCount: z.number().int(),
  model: z.string(),
  lightModel: z.string(),
  agentId: z.string(),
  authoredSkills: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['active', 'disabled']),
      fileCount: z.number().int(),
    }),
  ),
  importedSkills: z.array(z.object({ name: z.string(), sourceUrl: z.string().nullable() })),
  hasAvatar: z.boolean(),
});
export type BotsTemplateInspectOutput = z.infer<typeof botsTemplateInspectOutputSchema>;

export const botsTemplateImportInputSchema = z.object({
  path: pathInput,
  /** inspect 返回的 sha256；与现读文件不符 → 拒绝（文件在确认后被替换）。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const botsTemplateImportOutputSchema = z.object({
  botId: z.string(),
  /** 已安装的自写技能。 */
  installedSkills: z.array(z.object({ name: z.string(), status: z.enum(['active', 'disabled']) })),
  /** 安装失败被跳过的自写技能（Bot 本身已创建，不回滚）。 */
  failedSkills: z.array(z.object({ name: z.string(), reason: z.string() })),
  /** 已导入技能清单：未安装，提示用户自行重新导入。 */
  skippedImportedSkills: z.array(z.object({ name: z.string(), sourceUrl: z.string().nullable() })),
});
export type BotsTemplateImportOutput = z.infer<typeof botsTemplateImportOutputSchema>;

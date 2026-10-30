import { z } from 'zod';

/**
 * Bot 分类（`bot.kind`）：初始化访谈中由 LLM 根据对话内容设置，之后用于
 * 提示词与能力选择（例如 `coding` 触发编程任务规则）。内置分类是稳定 id；
 * 内置都不合适时允许写一个短的自定义分类（如「法务」「招聘」）。旧数据 /
 * 非访谈创建的 Bot 为 NULL，读取方应回退到画像关键词判断。
 */

/** 自定义分类的最大长度（按字符计）。 */
export const BOT_KIND_MAX_CHARS = 32;

export const botKindSchema = z
  .string()
  .trim()
  .min(1, '分类不能为空')
  .max(BOT_KIND_MAX_CHARS, `分类不能超过 ${BOT_KIND_MAX_CHARS} 个字符`);

export interface BotKindPreset {
  /** 稳定 id，写入 `bot.kind`。 */
  id: string;
  label: string;
  labelEn: string;
}

/**
 * 内置分类。id 只增不改（已落库的值要长期可读）；新增分类时同时补
 * `isCodingBot` 等消费方的映射。
 */
export const BOT_KIND_PRESETS = [
  { id: 'coding', label: '编程与开发', labelEn: 'Programming & development' },
  { id: 'writing', label: '写作与文档', labelEn: 'Writing & documents' },
  { id: 'data', label: '数据分析与报告', labelEn: 'Data analysis & reports' },
  { id: 'marketing', label: '营销与增长', labelEn: 'Marketing & growth' },
  { id: 'research', label: '研究与学习', labelEn: 'Research & learning' },
  { id: 'design', label: '设计与创意', labelEn: 'Design & creative' },
  { id: 'operations', label: '运营与行政', labelEn: 'Operations & admin' },
  { id: 'life', label: '生活与个人事务', labelEn: 'Life & personal' },
  { id: 'general', label: '通用助手', labelEn: 'General assistant' },
] as const satisfies readonly BotKindPreset[];

export type BotKindPresetId = (typeof BOT_KIND_PRESETS)[number]['id'];

export function isBotKindPresetId(value: string): value is BotKindPresetId {
  return BOT_KIND_PRESETS.some((preset) => preset.id === value);
}

export function botKindPreset(id: string): BotKindPreset | undefined {
  return BOT_KIND_PRESETS.find((preset) => preset.id === id);
}

/**
 * 规范化写入值：去掉控制字符与尖括号（分类会进入系统提示词），合并空白；
 * 内置 id 大小写不敏感（`Coding` → `coding`）；自定义分类保留原文。
 */
export function normalizeBotKind(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = cleaned.toLowerCase();
  if (isBotKindPresetId(lower)) return lower;
  // 模型可能直接回内置标签（「编程与开发」/「Programming & development」）：
  // 同样归一成 id，保证落库的是稳定分类。
  const byLabel = BOT_KIND_PRESETS.find(
    (preset) => preset.label === cleaned || preset.labelEn.toLowerCase() === lower,
  );
  return byLabel?.id ?? cleaned;
}

/**
 * 读侧归一：列值 → 合法分类或 `null`（未分类 / 非法 / 缺列）。
 *
 * 行对象可能没有这一列（迁移编号 0059 排在已上线的 0060 之前，`user_version`
 * 已到 60 的库会跳过 0059），因此接受 `null` / `undefined`，不做任何抛错；
 * 读侧统一走这里，避免各处自己 `normalize + safeParse` 时漏掉缺列分支。
 */
export function parseBotKind(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = normalizeBotKind(raw);
  return botKindSchema.safeParse(normalized).success ? normalized : null;
}

/** 展示名：内置分类给本地化标签，自定义分类原样返回。 */
export function botKindLabel(kind: string, language: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const preset = botKindPreset(kind);
  if (preset === undefined) return kind;
  return language === 'en-US' ? preset.labelEn : preset.label;
}

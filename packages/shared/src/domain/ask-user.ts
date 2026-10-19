import { z } from 'zod';

import { ASK_USER_OPTION_MAX_CHARS } from '../constants.js';

/**
 * `ask_user` 表单化（D87 P4 L2，设计 32 §12.2）：任务向用户提问时除了单选，还可以多选或填一张简单
 * 表单。缺省 `single`，与 D75 的现状一致。回答经问题卡提交（`tasks.answer` 的 `values`），core 按卡
 * 上登记的模式 / 字段校验，再以结构化 JSON（`<untrusted>` 包裹）交回任务；卡片上显示可读的一行。
 * 对话轮仍「在回复里问」，不加这个工具（D75 对话轮纪律不变）。
 */

export const askUserModeSchema = z.enum(['single', 'multi', 'form']);
export type AskUserMode = z.infer<typeof askUserModeSchema>;

/** 多选最多选中的条目数（含自定义条目）。 */
export const ASK_USER_MULTI_MAX = 12;

/** 表单字段上限。 */
export const ASK_USER_FIELDS_MAX = 8;
export const ASK_USER_FIELD_LABEL_MAX_CHARS = 60;
/** 单个表单值的长度上限（字符）。 */
export const ASK_USER_FIELD_VALUE_MAX_CHARS = 1_000;
/**
 * 卡片上那一行可读回答的上限（字符）：表单最多 8 × 1000 字，整行可能远超 `tasks.answer` 的
 * `answer` 上限；完整内容走结构化 `values` / JSON，这一行只给人看，超出截断。
 */
export const ASK_USER_DISPLAY_MAX_CHARS = 500;

function clipDisplay(text: string): string {
  return text.length > ASK_USER_DISPLAY_MAX_CHARS
    ? `${text.slice(0, ASK_USER_DISPLAY_MAX_CHARS - 1)}…`
    : text;
}

export const askUserFieldSchema = z
  .object({
    /** 机器可读的键（回答 JSON 里的键）。 */
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    label: z.string().min(1).max(ASK_USER_FIELD_LABEL_MAX_CHARS),
    type: z.enum(['text', 'number', 'date', 'select']),
    /** select 的候选（2–12 个）。 */
    options: z.array(z.string().min(1).max(100)).min(2).max(12).optional(),
    required: z.boolean().default(false),
  })
  .strict()
  .refine((field) => field.type !== 'select' || field.options !== undefined, {
    message: 'select 字段需要 options',
  });
export type AskUserField = z.infer<typeof askUserFieldSchema>;

export const askUserFieldsSchema = z
  .array(askUserFieldSchema)
  .min(1)
  .max(ASK_USER_FIELDS_MAX)
  .refine((fields) => new Set(fields.map((f) => f.name)).size === fields.length, {
    message: '字段 name 不能重复',
  });

/** 卡片提交的结构化回答：多选 = 选中的条目（含自定义）；表单 = 字段名 → 文本。 */
export const askUserValuesSchema = z.union([
  z.array(z.string().max(ASK_USER_OPTION_MAX_CHARS)).max(ASK_USER_MULTI_MAX),
  z.record(z.string(), z.string().max(ASK_USER_FIELD_VALUE_MAX_CHARS)),
]);
export type AskUserValues = z.infer<typeof askUserValuesSchema>;

/**
 * 校验并整理一份结构化回答（core 用它，渲染端也可以先用它给即时提示）：
 * 成功给出卡片上显示的一行（`display`，截到 {@link ASK_USER_DISPLAY_MAX_CHARS}）与交给任务的
 * JSON（`structured`，不截断）。
 */
export function checkAskUserAnswer(
  question: { mode: AskUserMode; options: readonly string[]; fields: readonly AskUserField[] },
  values: unknown,
):
  | { ok: true; display: string; structured: string[] | Record<string, string | number> }
  | { ok: false; message: string } {
  if (question.mode === 'multi') {
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) {
      return { ok: false, message: '多选的回答必须是候选答案的列表' };
    }
    // 自定义输入也算一条：先去空格再去重；卡片上的候选原样收录，其余的算自定义条目。
    const trimmed = (values as string[]).map((v) => v.trim());
    if (trimmed.length === 0 || trimmed.every((v) => v === '')) {
      return { ok: false, message: '至少选一项' };
    }
    if (trimmed.some((v) => v === '')) {
      return { ok: false, message: '自定义选项不能是空白' };
    }
    const picked = [...new Set(trimmed)];
    if (picked.length > ASK_USER_MULTI_MAX) {
      return { ok: false, message: `最多选 ${ASK_USER_MULTI_MAX} 项` };
    }
    if (picked.some((v) => !question.options.includes(v) && v.length > ASK_USER_OPTION_MAX_CHARS)) {
      return {
        ok: false,
        message: `自定义选项最多 ${ASK_USER_OPTION_MAX_CHARS} 字`,
      };
    }
    // 按卡片上的顺序（不按点击顺序），自定义条目按给出顺序跟在后面。
    const ordered = [
      ...question.options.filter((option) => picked.includes(option)),
      ...picked.filter((v) => !question.options.includes(v)),
    ];
    return { ok: true, display: clipDisplay(ordered.join('、')), structured: ordered };
  }
  if (question.mode === 'form') {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return { ok: false, message: '表单的回答必须是「字段 → 值」' };
    }
    const record = values as Record<string, unknown>;
    const out: Record<string, string | number> = {};
    const shown: string[] = [];
    for (const field of question.fields) {
      const raw = record[field.name];
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') {
        if (field.required) return { ok: false, message: `「${field.label}」必填` };
        continue;
      }
      if (text.length > ASK_USER_FIELD_VALUE_MAX_CHARS) {
        return { ok: false, message: `「${field.label}」太长` };
      }
      if (field.type === 'number') {
        const n = Number(text);
        if (!Number.isFinite(n)) return { ok: false, message: `「${field.label}」要填数字` };
        out[field.name] = n;
      } else if (field.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
          return { ok: false, message: `「${field.label}」要填日期（YYYY-MM-DD）` };
        }
        out[field.name] = text;
      } else if (field.type === 'select') {
        if (!(field.options ?? []).includes(text)) {
          return { ok: false, message: `「${field.label}」只能选给出的选项` };
        }
        out[field.name] = text;
      } else {
        out[field.name] = text;
      }
      shown.push(`${field.label}：${out[field.name]}`);
    }
    for (const key of Object.keys(record)) {
      if (!question.fields.some((field) => field.name === key)) {
        return { ok: false, message: `没有名为「${key}」的字段` };
      }
    }
    if (shown.length === 0) return { ok: false, message: '表单是空的' };
    return { ok: true, display: clipDisplay(shown.join('；')), structured: out };
  }
  return { ok: false, message: '单选题直接点选项回答' };
}

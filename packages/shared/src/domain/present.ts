import { z } from 'zod';

/**
 * 声明式展示卡（D87 P4 L1，设计 32 §12.1）：Bot 只给数据（JSON），宿主用自己的组件渲染——表格、
 * 柱 / 折 / 饼图、指标卡、步骤、时间线、方案对比。展示类结果的大多数不需要 Bot 写代码：弱模型
 * 基本零 bug，也不需要代码确认。
 *
 * 每种 kind 一个**自定的最小 schema**（不用 Vega-Lite：可选项越少，弱模型越不出错，渲染端也越小）。
 * 校验失败时工具把 zod 的第一条错误转成「哪一字段、期望什么」交回模型重试。
 */

/** 卡片消息的 `cardType`。 */
export const PRESENT_CARD_TYPE = 'present';
/** `data` 的 JSON 体积上限（字节）。 */
export const PRESENT_DATA_MAX_BYTES = 64 * 1024;
/** 上下文回放（Bot 记得自己展示过什么）的紧凑文本上限（字符）。 */
export const PRESENT_CONTEXT_MAX_CHARS = 1_200;
export const PRESENT_TITLE_MAX_CHARS = 120;
/** 一次执行（run）里最多发几张展示卡（防循环刷屏，与组件卡同数）。 */
export const PRESENT_CARDS_PER_RUN_MAX = 8;

const label = z.string().max(200);
const shortText = z.string().max(500);
const cell = z.union([z.string().max(1_000), z.number(), z.boolean(), z.null()]);
const num = z.number().finite();

export const presentKindSchema = z.enum([
  'table',
  'bar',
  'line',
  'pie',
  'kpi',
  'steps',
  'timeline',
  'compare',
]);
export type PresentKind = z.infer<typeof presentKindSchema>;

/** 表格：列名 + 行（每行与列数相同）。 */
export const presentTableSchema = z
  .object({
    columns: z.array(label).min(1).max(20),
    rows: z.array(z.array(cell)).max(500),
  })
  .strict()
  .refine((data) => data.rows.every((row) => row.length === data.columns.length), {
    message: '每一行的单元格数必须等于 columns 的数量',
    path: ['rows'],
  });

/** 柱 / 折线：类目（x）+ 一组或多组数列（每组值数等于类目数）。 */
const seriesChartSchema = z
  .object({
    categories: z.array(label).min(1).max(100),
    series: z
      .array(z.object({ name: label, values: z.array(num) }).strict())
      .min(1)
      .max(8),
    unit: z.string().max(20).optional(),
  })
  .strict()
  .refine((data) => data.series.every((s) => s.values.length === data.categories.length), {
    message: '每个 series 的 values 数量必须等于 categories 的数量',
    path: ['series'],
  });
export const presentBarSchema = seriesChartSchema;
export const presentLineSchema = seriesChartSchema;

/** 饼图：若干份额（非负）。 */
export const presentPieSchema = z
  .object({
    slices: z
      .array(z.object({ label, value: num.min(0) }).strict())
      .min(1)
      .max(12),
    unit: z.string().max(20).optional(),
  })
  .strict();

/** 指标卡：若干「名称 · 数值 · 可选变化与说明」。 */
export const presentKpiSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            label,
            value: z.union([num, z.string().max(60)]),
            unit: z.string().max(20).optional(),
            /** 相对变化（如 +12.5 表示 +12.5%）。 */
            change: num.optional(),
            note: shortText.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

/** 步骤：有序步骤，可标状态。 */
export const presentStepsSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            title: label,
            detail: shortText.optional(),
            status: z.enum(['done', 'current', 'todo']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

/** 时间线：带时间的事件（时间是给人看的文本，不解析）。 */
export const presentTimelineSchema = z
  .object({
    events: z
      .array(
        z.object({ time: z.string().max(60), title: label, detail: shortText.optional() }).strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

/** 方案对比：若干方案 × 若干维度（每个方案在每个维度上一格）+ 可选推荐。 */
export const presentCompareSchema = z
  .object({
    options: z.array(label).min(2).max(6),
    criteria: z
      .array(z.object({ name: label, values: z.array(cell) }).strict())
      .min(1)
      .max(20),
    recommended: label.optional(),
  })
  .strict()
  .refine((data) => data.criteria.every((c) => c.values.length === data.options.length), {
    message: '每个 criteria 的 values 数量必须等于 options 的数量',
    path: ['criteria'],
  })
  .refine((data) => data.recommended === undefined || data.options.includes(data.recommended), {
    message: 'recommended 必须是 options 之一',
    path: ['recommended'],
  });

export const PRESENT_DATA_SCHEMAS = {
  table: presentTableSchema,
  bar: presentBarSchema,
  line: presentLineSchema,
  pie: presentPieSchema,
  kpi: presentKpiSchema,
  steps: presentStepsSchema,
  timeline: presentTimelineSchema,
  compare: presentCompareSchema,
} as const satisfies Record<PresentKind, z.ZodType>;

export type PresentData<K extends PresentKind = PresentKind> = z.infer<
  (typeof PRESENT_DATA_SCHEMAS)[K]
>;

/** 卡片描述符（`content.present`）：数据本身就在卡片里（是 Bot 自己给的内容，不是代码）。 */
export const presentCardSchema = z.object({
  kind: presentKindSchema,
  title: z.string().max(PRESENT_TITLE_MAX_CHARS).default(''),
  data: z.unknown(),
  /**
   * 发卡的 Bot（审查修复）：上下文回放标明「谁展示的」，并把数据包进 `<untrusted>`——数据可能来自
   * 网页等外部内容，项目组里别的 Bot 不能把它当系统指令。存量卡缺省。
   */
  botId: z.string().optional(),
});
export type PresentCard = z.infer<typeof presentCardSchema>;

/**
 * 校验一张展示卡：kind 合法、data 不超过体积上限且符合该 kind 的 schema。失败返回给模型看的
 * 「哪一字段、期望什么」。
 */
export function validatePresent(
  kind: unknown,
  data: unknown,
): { ok: true; kind: PresentKind; data: PresentData } | { ok: false; message: string } {
  const parsedKind = presentKindSchema.safeParse(kind);
  if (!parsedKind.success) {
    return { ok: false, message: `kind 只能是 ${presentKindSchema.options.join(' / ')}` };
  }
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(data) ?? '').length;
  } catch {
    return { ok: false, message: 'data 必须是可 JSON 序列化的对象' };
  }
  if (size > PRESENT_DATA_MAX_BYTES) {
    return {
      ok: false,
      message: `data 过大（${size} 字节，上限 ${PRESENT_DATA_MAX_BYTES}）：精简行数或只展示要点`,
    };
  }
  const parsed = PRESENT_DATA_SCHEMAS[parsedKind.data].safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue !== undefined && issue.path.length > 0 ? `data.${issue.path.join('.')}` : 'data';
    return {
      ok: false,
      message: `${parsedKind.data} 的 ${where} 不对：${issue?.message ?? '格式错误'}`,
    };
  }
  return { ok: true, kind: parsedKind.data, data: parsed.data as PresentData };
}

/**
 * 上下文回放（设计 32 §12.1）：展示数据就是 Bot 自己给的内容，按 kind 渲染成紧凑文本行，截断到
 * {@link PRESENT_CONTEXT_MAX_CHARS}——Bot 记得自己展示过什么，又不让一张大表撑满上下文。
 */
export function presentContextText(card: {
  kind: PresentKind;
  title: string;
  data: unknown;
}): string {
  const head = `[展示卡·${card.kind}]${card.title !== '' ? ` ${card.title}` : ''}`;
  const parsed = PRESENT_DATA_SCHEMAS[card.kind].safeParse(card.data);
  if (!parsed.success) return `${head}（数据已损坏）`;
  const lines: string[] = [head];
  const fmt = (value: unknown): string => (value === null ? '—' : String(value));
  switch (card.kind) {
    case 'table': {
      const data = parsed.data as z.infer<typeof presentTableSchema>;
      lines.push(data.columns.join(' | '));
      for (const row of data.rows) lines.push(row.map(fmt).join(' | '));
      break;
    }
    case 'bar':
    case 'line': {
      const data = parsed.data as z.infer<typeof seriesChartSchema>;
      for (const series of data.series) {
        lines.push(
          `${series.name}：${data.categories.map((c, i) => `${c}=${series.values[i]}${data.unit ?? ''}`).join('，')}`,
        );
      }
      break;
    }
    case 'pie': {
      const data = parsed.data as z.infer<typeof presentPieSchema>;
      lines.push(data.slices.map((s) => `${s.label}=${s.value}${data.unit ?? ''}`).join('，'));
      break;
    }
    case 'kpi': {
      const data = parsed.data as z.infer<typeof presentKpiSchema>;
      for (const item of data.items) {
        lines.push(
          `${item.label}：${item.value}${item.unit ?? ''}${item.change !== undefined ? `（${item.change >= 0 ? '+' : ''}${item.change}%）` : ''}`,
        );
      }
      break;
    }
    case 'steps': {
      const data = parsed.data as z.infer<typeof presentStepsSchema>;
      data.steps.forEach((step, i) =>
        lines.push(
          `${i + 1}. ${step.title}${step.status !== undefined ? `（${step.status}）` : ''}`,
        ),
      );
      break;
    }
    case 'timeline': {
      const data = parsed.data as z.infer<typeof presentTimelineSchema>;
      for (const event of data.events) lines.push(`${event.time} ${event.title}`);
      break;
    }
    case 'compare': {
      const data = parsed.data as z.infer<typeof presentCompareSchema>;
      lines.push(
        `方案：${data.options.join(' / ')}${data.recommended !== undefined ? `（推荐 ${data.recommended}）` : ''}`,
      );
      for (const c of data.criteria) lines.push(`${c.name}：${c.values.map(fmt).join(' / ')}`);
      break;
    }
  }
  const text = lines.join('\n');
  return text.length > PRESENT_CONTEXT_MAX_CHARS
    ? `${text.slice(0, PRESENT_CONTEXT_MAX_CHARS - 12)}…（已截断）`
    : text;
}

import { z } from 'zod';

/**
 * Bot 组件制作流程（D87，设计 32 §11）：任务面只有 `widget_craft`，编码在宿主状态机驱动的
 * 独立制作 loop 里完成（每个阶段一个 `loop_type='widget_authoring'` 的 pi run，
 * `parent_run_id` = 发起的任务 run），交付前必经确定性检查（S0 静态 / S1 JS / S2 预览），
 * 交付凭检查回执。发起任务只拿到 ≤ {@link WIDGET_CRAFT_RESULT_MAX_CHARS} 字的回执——
 * HTML、diff、检查报告都不进任务上下文。
 *
 * 这里是 core 与渲染端共用的契约：参数常量、检查报告 / 验收点 / 审查结论 / 制作清单的
 * schema，以及卡片上的自检状态。
 */

// --- 参数（设计 32 §11.6） ----------------------------------------------------

/** GATE 与 REVIEW 触发的 FIX 合计轮数。 */
export const WIDGET_CRAFT_FIX_ROUNDS_MAX = 4;
/** 审查轮数；第二轮只核对上一轮的 P0/P1 是否修好，再看有无新 P0。 */
export const WIDGET_CRAFT_REVIEW_ROUNDS_MAX = 2;
/** 整次制作的时限。 */
export const WIDGET_CRAFT_TIMEOUT_MS = 900_000;
/** 每个任务 run 至多发起几次制作。 */
export const WIDGET_CRAFTS_PER_RUN_MAX = 3;
/** 给发起任务的工具回执上限（字符）。 */
export const WIDGET_CRAFT_RESULT_MAX_CHARS = 1_500;
/** 未交付草稿的保留天数（供 `resume_craft_id` 续做）。 */
export const WIDGET_CRAFT_DRAFT_TTL_DAYS = 7;
/** 单阶段 run 的轮数兜底。 */
export const WIDGET_CRAFT_PHASE_MAX_TURNS = { spec: 6, build: 30, fix: 15, review: 10 } as const;
/** 检查报告交给模型时的文本上限（字符）。 */
export const WIDGET_CHECK_REPORT_MAX_CHARS = 3_000;
/** 单次检查（含 S2 预览）的总时限。 */
export const WIDGET_CHECK_TIMEOUT_MS = 20_000;
/** S2 的两个视口：窄屏亮色 + 宽屏暗色。 */
export const WIDGET_PREVIEW_VIEWPORTS = [
  { width: 360, theme: 'light' },
  { width: 720, theme: 'dark' },
] as const;
/** S2 乱点冒烟至多操作的元素数。 */
export const WIDGET_PREVIEW_MONKEY_MAX_ELEMENTS = 30;
/** 卡片上「已知问题」的条数上限。 */
export const WIDGET_KNOWN_ISSUES_MAX = 5;
/** `widget_craft` 的 brief 长度上限（字符）。 */
export const WIDGET_CRAFT_BRIEF_MAX_CHARS = 4_000;
/** 每条用户验收提示的长度上限与条数上限。 */
export const WIDGET_CRAFT_ACCEPTANCE_HINT_MAX_CHARS = 300;
export const WIDGET_CRAFT_ACCEPTANCE_HINTS_MAX = 8;
/** 验收点的条数范围（SPEC 提示要求 1–8 条，schema 放宽到 1–12）。 */
export const WIDGET_ACCEPTANCE_ITEMS_MAX = 12;
/** 草稿目录里单个文件的体积上限（index.html 同 BOT_WIDGET_HTML_MAX_BYTES，其余文件更小）。 */
export const WIDGET_CRAFT_AUX_FILE_MAX_BYTES = 256 * 1024;

// --- 卡片上的自检状态（设计 32 §11.12） ----------------------------------------

/**
 * 交付版本的自检状态：`legacy` = D87 之前的存量版本（不显示徽标）；`passed` = 检查全绿且
 * 审查无 P0/P1；`issues` = 无阻断项但有已知问题；`unverified` = 没有经过运行验证（S2 不可用）。
 */
export const widgetCheckStatusSchema = z.enum(['legacy', 'passed', 'issues', 'unverified']);
export type WidgetCheckStatus = z.infer<typeof widgetCheckStatusSchema>;

/** `widget_versions.check_summary_json`：交付时的检查摘要（不含源码）。 */
export const widgetCheckSummarySchema = z.object({
  craftId: z.string(),
  /** GATE 跑了几轮。 */
  gateRounds: z.number().int().min(0),
  /** 审查跑了几轮（P3a 没有审查 = 0）。 */
  reviewRounds: z.number().int().min(0),
  /** 有审查轮次没有提交结论（记 skipped，不阻断交付）。 */
  reviewSkipped: z.boolean().default(false),
  /** S2 是否真的运行过。 */
  previewed: z.boolean().default(false),
  /** 面向用户的已知问题（中文，≤ WIDGET_KNOWN_ISSUES_MAX 条）。 */
  knownIssues: z.array(z.string()).max(WIDGET_KNOWN_ISSUES_MAX).default([]),
});
export type WidgetCheckSummary = z.infer<typeof widgetCheckSummarySchema>;

// --- 检查报告（设计 32 §11.8） --------------------------------------------------

export const widgetCheckStageSchema = z.enum(['S0', 'S1', 'S2']);
export type WidgetCheckStage = z.infer<typeof widgetCheckStageSchema>;
export const widgetCheckLevelSchema = z.enum(['error', 'warning']);
export type WidgetCheckLevel = z.infer<typeof widgetCheckLevelSchema>;

/** 草稿目录里会被检查的文件。 */
export const widgetDraftFileSchema = z.enum([
  'index.html',
  'queries.json',
  'acceptance.json',
  'fixtures.json',
]);
export type WidgetDraftFile = z.infer<typeof widgetDraftFileSchema>;

export const widgetCheckIssueSchema = z.object({
  /** 规则 id（规则注册表，如 `sandbox.storage`）。 */
  rule: z.string().min(1),
  level: widgetCheckLevelSchema,
  stage: widgetCheckStageSchema,
  /** 阻断项（任何一项存在都不可交付）：由规则注册表决定。 */
  blocking: z.boolean(),
  file: widgetDraftFileSchema.default('index.html'),
  /** 1 起的行 / 列（文件级问题缺省）。 */
  line: z.number().int().min(1).optional(),
  col: z.number().int().min(1).optional(),
  /** 问题（具体到这一处）。 */
  message: z.string().min(1),
  /** 怎么改。 */
  hint: z.string().default(''),
  /** S2：触发它的操作（乱点的元素「选择器 + 文字」或验收点 id）。 */
  trigger: z.string().optional(),
  /** S2：出现在哪个视口（如 `360/light`）。 */
  viewport: z.string().optional(),
});
export type WidgetCheckIssue = z.infer<typeof widgetCheckIssueSchema>;

// --- 验收点（设计 32 §11.8.4） ------------------------------------------------

const selector = z.string().min(1).max(200);

export const widgetAcceptanceStepSchema = z.union([
  z.object({ click: selector }).strict(),
  z.object({ fill: selector, value: z.string().max(500) }).strict(),
  z.object({ select: selector, value: z.string().max(200) }).strict(),
  z.object({ check: selector, value: z.boolean().default(true) }).strict(),
  z.object({ press: z.string().min(1).max(40), selector: selector.optional() }).strict(),
  z.object({ wait: z.number().int().min(0).max(1_000) }).strict(),
]);
export type WidgetAcceptanceStep = z.infer<typeof widgetAcceptanceStepSchema>;

export const widgetAcceptanceExpectSchema = z.union([
  z.object({ selector, exists: z.boolean() }).strict(),
  z.object({ selector, textContains: z.string().max(500) }).strict(),
  z.object({ selector, textEquals: z.string().max(500) }).strict(),
  z.object({ selector, valueEquals: z.string().max(500) }).strict(),
  z.object({ selector, count: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ noBadText: z.literal(true) }).strict(),
  z.object({ noErrors: z.literal(true) }).strict(),
]);
export type WidgetAcceptanceExpect = z.infer<typeof widgetAcceptanceExpectSchema>;

export const widgetAcceptanceItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  desc: z.string().min(1).max(300),
  must: z.boolean().default(false),
  steps: z.array(widgetAcceptanceStepSchema).max(20).default([]),
  expect: z.array(widgetAcceptanceExpectSchema).min(1).max(10),
});
export type WidgetAcceptanceItem = z.infer<typeof widgetAcceptanceItemSchema>;

export const widgetAcceptanceSchema = z
  .array(widgetAcceptanceItemSchema)
  .min(1)
  .max(WIDGET_ACCEPTANCE_ITEMS_MAX)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: '验收点 id 不能重复',
  });
export type WidgetAcceptance = z.infer<typeof widgetAcceptanceSchema>;

export const widgetAcceptanceResultSchema = z.object({
  id: z.string(),
  must: z.boolean(),
  passed: z.boolean(),
  /** 失败时的实际值 / 原因。 */
  detail: z.string().default(''),
  viewport: z.string().optional(),
});
export type WidgetAcceptanceResult = z.infer<typeof widgetAcceptanceResultSchema>;

/** 每一级的执行情况：`skipped` 带原因（如 S2 的预览宿主未绑定）。 */
export const widgetCheckStageRunSchema = z.object({
  status: z.enum(['ran', 'skipped']),
  reason: z.string().default(''),
});

/**
 * 判定：`pass` = 没有任何问题；`issues` = 没有阻断项（可交付，带已知问题）；
 * `blocked` = 有阻断项（不可交付）。
 */
export const widgetCheckVerdictSchema = z.enum(['pass', 'issues', 'blocked']);
export type WidgetCheckVerdict = z.infer<typeof widgetCheckVerdictSchema>;

export const widgetCheckReportSchema = z.object({
  /** 检查时文件的摘要（回执关卡用）。 */
  htmlSha256: z.string(),
  queriesSha256: z.string(),
  stages: z.object({
    S0: widgetCheckStageRunSchema,
    S1: widgetCheckStageRunSchema,
    S2: widgetCheckStageRunSchema,
  }),
  issues: z.array(widgetCheckIssueSchema),
  acceptance: z.array(widgetAcceptanceResultSchema).default([]),
  /** S2 的 DOM 文本大纲（≤2000 字；S2 未运行为空）。 */
  outline: z.string().default(''),
  /** 越小越好：阻断项 ×100 + 其余错误 ×10 + 警告 ×1 + 未通过的 must 验收点 ×50（设计 32 §11.6）。 */
  score: z.number().int().min(0),
  blockers: z.number().int().min(0),
  errors: z.number().int().min(0),
  warnings: z.number().int().min(0),
  verdict: widgetCheckVerdictSchema,
  createdAt: z.number(),
});
export type WidgetCheckReport = z.infer<typeof widgetCheckReportSchema>;

// --- 审查结论（设计 32 §11.10，P3c） -------------------------------------------

export const widgetReviewFindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']),
  line: z.number().int().min(1).optional(),
  problem: z.string().min(1).max(500),
  /** 具体失败场景（输入 / 操作 → 错误结果）；没有场景的条目宿主丢弃。 */
  scenario: z.string().max(500).default(''),
  fixHint: z.string().max(500).default(''),
});
export type WidgetReviewFinding = z.infer<typeof widgetReviewFindingSchema>;

export const widgetReviewResultSchema = z.object({
  verdict: z.enum(['pass', 'fix']),
  findings: z.array(widgetReviewFindingSchema).max(20).default([]),
});
export type WidgetReviewResult = z.infer<typeof widgetReviewResultSchema>;

// --- 制作清单（草稿目录 manifest.json，宿主独占写；设计 32 §11.5） --------------

export const widgetCraftPhaseSchema = z.enum([
  'spec',
  'build',
  'gate',
  'fix',
  'review',
  'deliver',
  'done',
]);
export type WidgetCraftPhase = z.infer<typeof widgetCraftPhaseSchema>;

/** GATE 的检查回执：DELIVER 复算文件摘要，必须与其中一条一致才交付。 */
export const widgetCraftReceiptSchema = z.object({
  round: z.number().int().min(1),
  htmlSha256: z.string(),
  queriesSha256: z.string(),
  verdict: widgetCheckVerdictSchema,
  score: z.number().int().min(0),
  /** S2 是否运行（未运行时交付状态最多是 `unverified`）。 */
  previewed: z.boolean(),
  at: z.number(),
});
export type WidgetCraftReceipt = z.infer<typeof widgetCraftReceiptSchema>;

export const widgetCraftStatusSchema = z.enum(['running', 'delivered', 'failed', 'cancelled']);
export type WidgetCraftStatus = z.infer<typeof widgetCraftStatusSchema>;

export const widgetCraftManifestSchema = z.object({
  craftId: z.string().min(1),
  botId: z.string().min(1),
  conversationId: z.string().nullable(),
  /** 发起制作的任务 run（每次续做更新为新的发起者）。 */
  parentRunId: z.string(),
  /** 修改已有组件时的 widgetId 与起点版本。 */
  widgetId: z.string().nullable().default(null),
  baseVersion: z.number().int().nullable().default(null),
  title: z.string(),
  scope: z.enum(['conversation', 'bot']),
  brief: z.string(),
  acceptanceHints: z.array(z.string()).default([]),
  phase: widgetCraftPhaseSchema,
  rounds: z.object({
    gate: z.number().int().min(0),
    fix: z.number().int().min(0),
    review: z.number().int().min(0),
  }),
  /** 最佳快照（分数最低的一次 GATE）；还没 GATE 过为 null。 */
  best: z.object({ round: z.number().int().min(1), score: z.number().int().min(0) }).nullable(),
  receipts: z.array(widgetCraftReceiptSchema).default([]),
  status: widgetCraftStatusSchema,
  /** 未交付时的原因（≤5 条，给任务的回执用）。 */
  failure: z.array(z.string()).default([]),
  /** 各阶段 run id（审计用）。 */
  stageRunIds: z.array(z.string()).default([]),
  tokensUsed: z.number().int().min(0).default(0),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WidgetCraftManifest = z.infer<typeof widgetCraftManifestSchema>;

/** 草稿 fixtures.json：预览用的模拟数据（S2，P3b）。 */
export const widgetFixturesSchema = z.object({
  storage: z.record(z.string(), z.unknown()).default({}),
  queries: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
});
export type WidgetFixtures = z.infer<typeof widgetFixturesSchema>;

// --- S2 预览（设计 32 §11.8.3 / §11.9，P3b） ------------------------------------

/**
 * 能力桥与预览的 postMessage 协议来源标记（正式卡片与预览外壳共用一份，不各写一份）：
 * 组件 → 宿主 `kepcup-widget`、宿主 → 组件 `kepcup-host`；预览探针 → 外壳 `kepcup-probe`、
 * 外壳 → 探针 `kepcup-probe-host`。
 */
export const WIDGET_BRIDGE_WIDGET_SOURCE = 'kepcup-widget';
export const WIDGET_BRIDGE_HOST_SOURCE = 'kepcup-host';
export const WIDGET_PROBE_SOURCE = 'kepcup-probe';
export const WIDGET_PROBE_HOST_SOURCE = 'kepcup-probe-host';
/** 宿主推送主题变更的事件名（`{source: 'kepcup-host', event: 'theme', theme}`）。 */
export const WIDGET_HOST_THEME_EVENT = 'theme';

export const widgetThemeSchema = z.enum(['light', 'dark']);
export type WidgetTheme = z.infer<typeof widgetThemeSchema>;

/** 预览组件资源的 host 前缀（每次预览一个新的随机 host，避免被分进还没回收的进程）。 */
export const WIDGET_PREVIEW_HOST_PREFIX = 'widget-preview-';
/**
 * 预览 HTML 的上限：组件原文上限（BOT_WIDGET_HTML_MAX_BYTES，2MB；这里不 import——widgets-ui
 * 反向依赖本文件，循环引用下顶层常量会是 undefined）+ 注入的垫片 / kit / 探针余量。
 */
export const WIDGET_PREVIEW_HTML_MAX_CHARS = 2 * 1024 * 1024 + 256 * 1024;
/** 单个视口的硬时限（含加载、渲染体检、验收、乱点）；超时 = 死循环 / 长阻塞 → preview.timeout。 */
export const WIDGET_PREVIEW_VIEWPORT_TIMEOUT_MS = 8_000;
/** 加载后的 DOM 静默窗口与上限。 */
export const WIDGET_PREVIEW_SETTLE_MS = 300;
export const WIDGET_PREVIEW_SETTLE_MAX_MS = 3_000;
/** DOM 文本大纲上限（字符）。 */
export const WIDGET_PREVIEW_OUTLINE_MAX_CHARS = 2_000;

/** 预览报回的问题（规则 id 只能是 S2 规则；级别 / 阻断 / 改法由 core 的规则注册表决定）。 */
export const widgetPreviewRuleSchema = z.enum([
  'runtime.error',
  'runtime.rejection',
  'console.error',
  'console.warn',
  'csp.violation',
  'render.blank',
  'render.overflow-x',
  'render.bad-text',
  'preview.timeout',
]);
export type WidgetPreviewRule = z.infer<typeof widgetPreviewRuleSchema>;

export const widgetPreviewFindingSchema = z.object({
  rule: widgetPreviewRuleSchema,
  message: z.string().max(2_000),
  line: z.number().int().min(1).optional(),
  col: z.number().int().min(1).optional(),
  /** 触发它的操作：乱点的元素（选择器 + 文字）或 `验收点 id`；加载期出现的没有。 */
  trigger: z.string().max(300).optional(),
});
export type WidgetPreviewFinding = z.infer<typeof widgetPreviewFindingSchema>;

export const widgetPreviewViewportSchema = z.object({
  width: z.number().int().min(200).max(1_600),
  theme: widgetThemeSchema,
  /** 该视口的预览 HTML（core 已注入垫片〔按该主题〕与探针；只在内存里）。 */
  html: z.string().min(1).max(WIDGET_PREVIEW_HTML_MAX_CHARS),
});

/** 平台方法 `widgetPreview.run`（core → 主进程，端口 B）。 */
export const widgetPreviewRunInputSchema = z.object({
  viewports: z.array(widgetPreviewViewportSchema).min(1).max(4),
  acceptance: widgetAcceptanceSchema.nullable(),
  fixtures: widgetFixturesSchema,
  monkeyMax: z.number().int().min(0).max(100),
  /** 是否回传截图（制作模型支持图片时的自查用；GATE 不要）。 */
  screenshots: z.boolean(),
  /**
   * 调用方愿意等的总时长（毫秒，从宿主收到请求起算，含排队）：排队等到剩余时间不够跑一个视口
   * 就不再跑，直接按「宿主繁忙」返回 failed——调用方已经放弃的预览不占队列，也不把宿主繁忙
   * 冒充成组件超时。缺省不限。
   */
  budgetMs: z.number().int().min(1_000).max(600_000).optional(),
});
export type WidgetPreviewRunInput = z.infer<typeof widgetPreviewRunInputSchema>;

export const widgetPreviewViewportResultSchema = z.object({
  width: z.number().int(),
  theme: widgetThemeSchema,
  /** ok = 跑完；timeout = 超时被回收；crashed = 组件进程崩溃；failed = 宿主自身出错（detail 写原因）。 */
  status: z.enum(['ok', 'timeout', 'crashed', 'failed']),
  detail: z.string().default(''),
  findings: z.array(widgetPreviewFindingSchema).max(200),
  acceptance: z
    .array(
      z.object({
        id: z.string(),
        must: z.boolean(),
        passed: z.boolean(),
        detail: z.string().default(''),
      }),
    )
    .max(WIDGET_ACCEPTANCE_ITEMS_MAX),
  outline: z.string().max(WIDGET_PREVIEW_OUTLINE_MAX_CHARS + 100).default(''),
  /** PNG（base64），只在 screenshots=true 且出图成功时有。 */
  screenshot: z.string().optional(),
  /** 组件调用 kepcup.openLink 的网址（只记录，不打开）。 */
  openedLinks: z.array(z.string()).max(50).default([]),
});
export type WidgetPreviewViewportResult = z.infer<typeof widgetPreviewViewportResultSchema>;

export const widgetPreviewRunOutputSchema = z.object({
  viewports: z.array(widgetPreviewViewportResultSchema),
});
export type WidgetPreviewRunOutput = z.infer<typeof widgetPreviewRunOutputSchema>;

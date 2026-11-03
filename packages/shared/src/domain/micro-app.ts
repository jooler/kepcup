import { z } from 'zod';
import {
  MICRO_APP_CAPABILITY_IDS,
  MICRO_APP_IMPLEMENTED_CAPABILITIES,
  MICRO_APP_SPEC_VERSION,
  MICRO_APP_TOKENS_PER_SESSION_MAX,
} from '../micro-app-sdk/spec.js';
import { BOT_WIDGET_QUERIES_MAX, widgetQueryDefSchema } from './widget-query.js';

/**
 * 微应用（D112，设计 55）：带 `micro-app.json` 清单、可声明能力、可多文件、有独立会话
 * 状态的 Bot 交付物。存量「组件」= `manifest_json` 为空的退化微应用，行为完全不变
 * （55 §13.2：不做双运行时，同一套服务 / 桥 / 卡片）。
 *
 * 本文件是清单 / 能力面指纹 / 卡片与 RPC 契约的 zod 层；能力枚举、API 索引、错误
 * hint 的**单一事实来源**在 `micro-app-sdk/spec.ts`，这里只引用不重复定义。
 */

// --- 清单（55 §4.2）--------------------------------------------------------------

/** 微应用版本的总字节与文件数上限（P0 只有入口文件；P2 多文件包同限）。 */
export const MICRO_APP_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
export const MICRO_APP_BUNDLE_FILES_MAX = 64;
/** 清单本身的体积上限。 */
export const MICRO_APP_MANIFEST_MAX_BYTES = 64 * 1024;
/** 清单人读字段的长度上限。 */
export const MICRO_APP_NAME_MAX_CHARS = 60;
export const MICRO_APP_SLUG_MAX_CHARS = 48;
export const MICRO_APP_DESCRIPTION_MAX_CHARS = 300;

export const microAppNetModeSchema = z.enum(['open', 'allowlist', 'none']);
export type MicroAppNetMode = z.infer<typeof microAppNetModeSchema>;

/** `net` 档位：缺省 `open`（Q10 已拍板：默认联网，提示面补偿）；allowlist 必须给域名数组。 */
export const microAppNetSchema = z
  .object({
    mode: microAppNetModeSchema.default('open'),
    /** allowlist 档必须非空；每项是规范化的 https 主机名（core 校验），确认卡逐项可见。 */
    allowlist: z.array(z.string().min(1).max(253)).max(32).default([]),
  })
  .strict()
  .default({ mode: 'open', allowlist: [] });
export type MicroAppNet = z.infer<typeof microAppNetSchema>;

export const microAppManifestSchema = z.object({
  /** 清单格式版本；未知 → 拒绝交付（MICRO_APP_UNSUPPORTED_SPEC），不静默忽略。 */
  spec: z.literal(MICRO_APP_SPEC_VERSION),
  /** 包内唯一短名（小写字母 / 数字 / `-`）。 */
  slug: z
    .string()
    .min(1)
    .max(MICRO_APP_SLUG_MAX_CHARS)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug 只能含小写字母、数字和 -'),
  /** 用户可见名（确认卡标题）。 */
  name: z.string().min(1).max(MICRO_APP_NAME_MAX_CHARS),
  description: z.string().max(MICRO_APP_DESCRIPTION_MAX_CHARS).default(''),
  /** 入口页（P0 必须是包内存在的 html；多文件路径在 P2 校验）。 */
  entry: z.string().min(1).max(200),
  display: z
    .object({
      mode: z.enum(['inline', 'immersive']).default('immersive'),
      minWidth: z.number().int().min(200).max(2000).default(360),
      minHeight: z.number().int().min(200).max(4000).default(520),
    })
    .strict()
    .default({ mode: 'immersive', minWidth: 360, minHeight: 520 }),
  /**
   * 能力闭合枚举（spec.ts）；未知项 → 拒绝交付。声明了当前运行时未实现的能力 →
   * 拒绝交付并如实回执（MICRO_APP_MANIFEST_INVALID）。`net.fetch` 不在枚举里——
   * 网络由 `net.mode` 表达（默认开放，作者可收紧）。
   */
  permissions: z.array(z.enum(MICRO_APP_CAPABILITY_IDS as [string, ...string[]])).max(16).default([]),
  ai: z
    .object({
      /** 请求档位只是「轻量 / 默认」的意愿，最终模型由宿主策略裁决（55 §8.2）。 */
      profile: z.string().max(60).default('micro-app.light'),
      maxTokensPerSession: z.number().int().min(1000).max(MICRO_APP_TOKENS_PER_SESSION_MAX).default(20_000),
    })
    .strict()
    .default({ profile: 'micro-app.light', maxTokensPerSession: 20_000 }),
  net: microAppNetSchema,
  /** 只读查询模板清单（沿用组件的预审管线）。 */
  queries: z.array(widgetQueryDefSchema).max(BOT_WIDGET_QUERIES_MAX).default([]),
}).strict();
export type MicroAppManifest = z.infer<typeof microAppManifestSchema>;

// --- 能力面指纹（55 §5.2 / Q8：重复确认的粒度）--------------------------------------

/**
 * 能力面指纹：`permissions` 集合 + `net.mode` + `net.allowlist`（排序后）的规范化串。
 * 指纹不变 → 代码更新沿用上次确认（卡片标「代码已更新，权限未扩大」）；指纹变化
 * （新增能力、放宽网络、扩大域名）→ 强制重新确认。只对带清单的微应用生效；存量
 * 组件沿用 `(html sha256 | queries sha256)` 逐版本确认（零变化硬验收）。
 */
export function microAppCapabilityFingerprint(
  permissions: readonly string[],
  net: { mode: MicroAppNetMode; allowlist: readonly string[] },
): string {
  const perms = [...permissions].sort().join(',');
  const domains = net.mode === 'allowlist' ? [...net.allowlist].sort().join(',') : '';
  return `v1|perm:${perms || '-'}|net:${net.mode}${domains ? `:${domains}` : ''}`;
}

export function microAppFingerprintOfManifest(manifest: MicroAppManifest): string {
  return microAppCapabilityFingerprint(manifest.permissions, manifest.net);
}

/** 声明的能力是否全部在当前运行时的已实现集合里（交付裁决用）。 */
export function microAppUnimplementedCapabilities(permissions: readonly string[]): string[] {
  return permissions.filter((id) => !MICRO_APP_IMPLEMENTED_CAPABILITIES.includes(id));
}

// --- 卡片描述符增量（zod default 兼容旧卡）------------------------------------------

/** 微应用卡片的清单摘要（确认卡 / 预检 / 外壳用；不含包内容）。 */
export const microAppCardSummarySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  permissions: z.array(z.string()).default([]),
  netMode: microAppNetModeSchema,
  netAllowlist: z.array(z.string()).default([]),
  /** 清单 `ai.maxTokensPerSession`（确认卡的预计成本行）。 */
  maxTokensPerSession: z.number().int().min(1).optional(),
  /** 清单 `display.mode`（P1 外壳初始模式）。 */
  displayMode: z.enum(['inline', 'immersive']).default('immersive'),
});
export type MicroAppCardSummary = z.infer<typeof microAppCardSummarySchema>;

export function microAppCardSummaryOf(manifest: MicroAppManifest): MicroAppCardSummary {
  return {
    name: manifest.name,
    slug: manifest.slug,
    permissions: [...manifest.permissions],
    netMode: manifest.net.mode,
    netAllowlist: [...manifest.net.allowlist],
    ...(manifest.permissions.includes('ai.chat')
      ? { maxTokensPerSession: manifest.ai.maxTokensPerSession }
      : {}),
    displayMode: manifest.display.mode,
  };
}



export const MICRO_APP_CONSENT_STORAGE_KEY = 'kepcup.microApp.consents.v1';
export const MICRO_APP_CONSENTS_MAX = 200;

/** 微应用确认记录（值 = 指纹 → 记录；与组件的 sha256→boolean 分开存）。 */
export interface MicroAppConsentRecord {
  fingerprint: string;
  /** 确认时的 bundle 摘要——同指纹不同代码时卡片标「代码已更新，权限未扩大」。 */
  bundleSha256: string;
  at: number;
}

// --- RPC：能力可用性预检（55 §5.2 / §15 第 15 条）------------------------------------

/**
 * `microApps.preflight {messageId}`：出卡前对清单声明的每个能力做宿主可用性预检
 * （缺 ASR / TTS / 模型配置等）。预检描述「这台机器现在能不能跑」，不改变指纹、
 * 不写版本；不可用项带设置深链。
 */
export const microAppsPreflightInputSchema = z.object({ messageId: z.string().min(1) });
export const microAppsPreflightItemSchema = z.object({
  capability: z.string().min(1),
  available: z.boolean(),
  /** 不可用的人话原因（确认卡展示）。 */
  reason: z.string().optional(),
  /** 设置页深链（section + anchor）；能力与设置无关时缺省。 */
  settingDeepLink: z
    .object({ section: z.string().min(1), anchor: z.string().min(1).optional() })
    .optional(),
});
export type MicroAppsPreflightItem = z.infer<typeof microAppsPreflightItemSchema>;
export const microAppsPreflightOutputSchema = z.object({
  widgetId: z.string(),
  /** 生效版本（= `widgets.next_version ?? 卡片钉住版本`，卡片「有新版本」徽标用）。 */
  version: z.number().int(),
  /** 生效版本的能力面指纹（确认门控用它，而不是卡片上可能过期的指纹）。 */
  capabilityFingerprint: z.string(),
  /** 生效版本的 bundle 摘要（「代码已更新，权限未扩大」徽标的判定）。 */
  bundleSha256: z.string(),
  /**
   * 生效版本的清单摘要：确认卡展示的能力清单 / 网络行 / 成本必须来自**将要运行的
   * 版本**（卡片自带的摘要钉在发卡时，双指针前移后会过期）。
   */
  microApp: microAppCardSummarySchema,
  /** 生效版本带查询模板且未展开审查 SQL（卡片「先查看源码」门控跟着生效版本走）。 */
  queriesNeedReview: z.boolean().default(false),
  /** 生效版本登记的查询模板数（审查态提示文案用）。 */
  queriesCount: z.number().int().min(0).default(0),
  /** 当前的 context.update 进度摘要（卡片上可见可清除；null = 无）。 */
  contextHeadline: z.string().nullable().default(null),
  items: z.array(microAppsPreflightItemSchema),
});
export type MicroAppsPreflightOutput = z.infer<typeof microAppsPreflightOutputSchema>;

// --- 模型平面（P1，55 §6.2 / §8）----------------------------------------------------

/** `kepcup.ai.chat` 的消息（system / user / assistant；无工具面）。 */
export const microAppAiMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(32_000),
});
export type MicroAppAiMessage = z.infer<typeof microAppAiMessageSchema>;

/** 实例键：渲染端桥宿主铸造（`mai_…`），预算 / 并发 / 会话按它记账（续期不变）。 */
export const microAppInstanceRefSchema = z.object({
  resourceId: z.string().min(1),
  instanceId: z.string().regex(/^mai_[a-z0-9_]+$/i),
});

export const microAppsAiChatInputSchema = microAppInstanceRefSchema.extend({
  messages: z.array(microAppAiMessageSchema).min(1).max(64),
  /** 流式：回执带 streamId，增量经 `micro-app.stream` 事件投递（渲染端转桥 v2 event 帧）。 */
  stream: z.boolean().default(false),
});
export const microAppsAiChatOutputSchema = z.union([
  z.object({ stream: z.literal(false), text: z.string() }),
  z.object({ stream: z.literal(true), streamId: z.string() }),
]);
export type MicroAppsAiChatInput = z.infer<typeof microAppsAiChatInputSchema>;
export type MicroAppsAiChatOutput = z.infer<typeof microAppsAiChatOutputSchema>;

export const microAppsAiSessionCreateInputSchema = microAppInstanceRefSchema.extend({
  id: z.string().min(1).max(64).optional(),
  /** 微应用声明的角色设定——宿主包 `<untrusted source="micro-app-prompt">` 边界（55 §8.2）。 */
  system: z.string().max(8_000).optional(),
  maxTurns: z.number().int().min(1).max(500).optional(),
});
export const microAppsAiSessionCreateOutputSchema = z.object({ sessionId: z.string() });

export const microAppsAiSessionSendInputSchema = microAppInstanceRefSchema.extend({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(16_000),
  stream: z.boolean().default(false),
});
export const microAppsAiSessionSendOutputSchema = microAppsAiChatOutputSchema;

export const microAppsAiSessionHistoryInputSchema = microAppInstanceRefSchema.extend({
  sessionId: z.string().min(1),
});
export const microAppsAiSessionHistoryOutputSchema = z.object({
  messages: z.array(microAppAiMessageSchema),
});

export const microAppsAiSessionResetInputSchema = microAppInstanceRefSchema.extend({
  sessionId: z.string().min(1),
});

/** 取消在途调用 / 流（`cancel` 帧映射；关闭实例即全部取消）。 */
export const microAppsAiCancelInputSchema = microAppInstanceRefSchema.extend({
  target: z.string().min(1),
});

/** 实例收口（卡片关闭 / 桥断开）：取消在途、释放会话与预算计数。 */
export const microAppsAiDisposeInputSchema = microAppInstanceRefSchema;

/** `micro-app.stream` 事件（core → 渲染端 → 桥 v2 event 帧）：delta / done / error。 */
export const microAppStreamEventSchema = z.object({
  instanceId: z.string(),
  streamId: z.string(),
  kind: z.enum(['delta', 'done', 'error']),
  delta: z.string().optional(),
  code: z.string().optional(),
});
export type MicroAppStreamEvent = z.infer<typeof microAppStreamEventSchema>;

// --- 音频平面（P1，55 §7）-----------------------------------------------------------

/** `microApps.media.transcribe`：宿主代理采集的分段 → ASR（记账归微应用 / Bot）。 */
export const microAppsMediaTranscribeInputSchema = microAppInstanceRefSchema.extend({
  audioBase64: z.string().min(1),
  audioMime: z.string().min(1),
  language: z.string().max(16).optional(),
});
export const microAppsMediaTranscribeOutputSchema = z.object({ text: z.string() });

/** `microApps.media.synthesize`：TTS 合成（播放队列在渲染端；打断在渲染端）。 */
export const microAppsMediaSynthesizeInputSchema = microAppInstanceRefSchema.extend({
  text: z.string().min(1).max(2_000),
  voice: z.string().max(64).optional(),
  rate: z.number().min(0.5).max(2).optional(),
});
export const microAppsMediaSynthesizeOutputSchema = z.object({
  audioBase64: z.string(),
  mimeType: z.string(),
});

// --- 多文件包（P2，55 §4.1）----------------------------------------------------------

/** 包内单文件上限与包总量。 */
export const MICRO_APP_FILE_MAX_BYTES = 1024 * 1024;
export const MICRO_APP_BUNDLE_FILE_NAME_MAX_CHARS = 120;

/** 包内文件定义（交付时 base64；`..`、绝对路径、反斜杠一律拒绝）。 */
export const microAppFileDefSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(MICRO_APP_BUNDLE_FILE_NAME_MAX_CHARS)
      .regex(/^[a-z0-9][a-z0-9/._-]*$/i, '路径只能含字母、数字、/、.、_、-，且不能以 / 开头'),
    mime: z.string().min(3).max(100),
    contentBase64: z.string().min(1),
  })
  .strict();
export type MicroAppFileDef = z.infer<typeof microAppFileDefSchema>;

/** 路径规范化守卫：拒绝 `..` 段、绝对路径、反斜杠与嵌入空字节（防穿越）。 */
export function isSafeMicroAppPath(path: string): boolean {
  if (path === '' || path.length > MICRO_APP_BUNDLE_FILE_NAME_MAX_CHARS) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/') || path.includes('://')) return false;
  const segments = path.split('/');
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes(':'),
  );
}

// --- collections（P2，55 §10）---------------------------------------------------------

export const MICRO_APP_COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MICRO_APP_COLLECTIONS_MAX = 10;
export const MICRO_APP_COLLECTION_DOC_ID_MAX_CHARS = 120;
export const MICRO_APP_COLLECTION_QUOTA_BYTES = 5 * 1024 * 1024;

export const microAppsCollectionsPutInputSchema = microAppInstanceRefSchema.extend({
  name: z.string().regex(MICRO_APP_COLLECTION_NAME_PATTERN),
  doc: z.object({ id: z.string().min(1).max(MICRO_APP_COLLECTION_DOC_ID_MAX_CHARS) }).passthrough(),
});
export const microAppsCollectionsGetInputSchema = microAppInstanceRefSchema.extend({
  name: z.string().regex(MICRO_APP_COLLECTION_NAME_PATTERN),
  id: z.string().min(1).max(MICRO_APP_COLLECTION_DOC_ID_MAX_CHARS),
});
export const microAppsCollectionsListInputSchema = microAppInstanceRefSchema.extend({
  name: z.string().regex(MICRO_APP_COLLECTION_NAME_PATTERN),
});
export const microAppsCollectionsQueryInputSchema = microAppInstanceRefSchema.extend({
  name: z.string().regex(MICRO_APP_COLLECTION_NAME_PATTERN),
  where: z
    .array(
      z.object({
        field: z.string().min(1).max(60),
        op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists']),
        value: z.unknown(),
      }),
    )
    .max(8)
    .default([]),
  limit: z.number().int().min(1).max(200).default(50),
});
export const microAppsCollectionsDeleteInputSchema = microAppsCollectionsGetInputSchema;

/** collections 文档回执（get → doc；list / query → docs）。 */
export const microAppsDocOutputSchema = z.object({ doc: z.unknown() });
export const microAppsDocsOutputSchema = z.object({ docs: z.array(z.unknown()) });

/** `kepcup.context.update` 的结构化摘要（55 §8.5）。 */
export const MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS = 80;
export const MICRO_APP_CONTEXT_DATA_MAX_BYTES = 1024;
export const microAppContextSummarySchema = z
  .object({
    headline: z.string().min(1).max(MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type MicroAppContextSummary = z.infer<typeof microAppContextSummarySchema>;

export const microAppsContextUpdateInputSchema = microAppInstanceRefSchema.extend({
  summary: microAppContextSummarySchema,
  /** 接受时机（55 §8.5：仅用户手势或 pause / close）。 */
  reason: z.enum(['gesture', 'pause', 'close']),
});
export const microAppsContextClearInputSchema = microAppInstanceRefSchema;

// --- 诊断回流（P2，55 §9.4）-----------------------------------------------------------

export const MICRO_APP_DIAGNOSTIC_DETAIL_MAX_CHARS = 200;
export const microAppsDiagnosticsRecordInputSchema = microAppInstanceRefSchema.extend({
  phase: z.enum(['prepare', 'run', 'stream']),
  code: z.string().min(1).max(80),
  detail: z.string().max(MICRO_APP_DIAGNOSTIC_DETAIL_MAX_CHARS).default(''),
});
/** Bot 任务面只读工具 `micro_app_diagnostics_read` 的入参（widget_id）。 */
export const microAppDiagnosticsReadInputSchema = z.object({ widgetId: z.string().min(1) });
export const microAppDiagnosticsReadOutputSchema = z.object({
  widgetId: z.string(),
  /** 最近 24h 聚合（code、次数、首次 / 末次、栈顶帧）。 */
  entries: z
    .array(
      z.object({
        version: z.number().int(),
        phase: z.string(),
        code: z.string(),
        detail: z.string(),
        count: z.number().int(),
        firstAt: z.number(),
        lastAt: z.number(),
      }),
    )
    .max(50),
  truncated: z.boolean(),
});

// --- 管理入口（P2，55 §14：微应用管理页）----------------------------------------------

export const microAppsListItemSchema = z.object({
  widgetId: z.string(),
  title: z.string(),
  description: z.string(),
  scope: z.enum(['conversation', 'bot']),
  conversationId: z.string().nullable(),
  version: z.number().int(),
  /** 版本指针（`next_version ?? latest`；回退用）。 */
  nextVersion: z.number().int().nullable(),
  latestVersion: z.number().int(),
  permissions: z.array(z.string()).default([]),
  netMode: microAppNetModeSchema,
  netAllowlist: z.array(z.string()).default([]),
  /** 今日用量（ai_calls / ai_tokens / asr_ms / tts_chars）。 */
  usage: z.object({
    aiCalls: z.number().int(),
    aiTokens: z.number().int(),
    asrMs: z.number().int(),
    ttsChars: z.number().int(),
  }),
  /** 最近 24h 诊断聚合（管理页「运行问题」只显示次数）。 */
  diagnostics24h: z.array(z.object({ code: z.string(), count: z.number().int(), version: z.number().int() })),
  /** 当前 context.update 摘要（可清除；null = 无）。 */
  contextHeadline: z.string().nullable(),
  updatedAt: z.number(),
});
export const microAppsListInputSchema = z.object({ botId: z.string().min(1) });
export const microAppsListOutputSchema = z.object({ items: z.array(microAppsListItemSchema) });

/** 版本回退：把 next_version 指回旧版本（不热替换在跑实例；被修剪的版本拒绝）。 */
export const microAppsRollbackInputSchema = z.object({
  botId: z.string().min(1),
  widgetId: z.string().min(1),
  version: z.number().int().min(1),
});
export const microAppsRollbackOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
});

/** 清除某微应用的 context.update 摘要。 */
export const microAppsClearContextInputSchema = z.object({
  botId: z.string().min(1),
  widgetId: z.string().min(1),
});
export const microAppsClearContextOutputSchema = z.object({ ok: z.boolean() });

export type MicroAppsListItem = z.infer<typeof microAppsListItemSchema>;

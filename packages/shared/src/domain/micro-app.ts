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

// --- 微应用确认记忆（渲染端 localStorage，按 widgetId 记指纹）------------------------

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
  items: z.array(microAppsPreflightItemSchema),
});
export type MicroAppsPreflightOutput = z.infer<typeof microAppsPreflightOutputSchema>;

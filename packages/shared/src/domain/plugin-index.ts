import { z } from 'zod';
import {
  CONNECTOR_INDEX_INITIAL_DELAY_MS,
  CONNECTOR_INDEX_RETRY_MS,
  CONNECTOR_INDEX_STALE_AFTER_MS,
  CONNECTOR_INDEX_SYNC_INTERVAL_MS,
  CONNECTOR_INDEX_SYNC_JITTER_RATIO,
  connectorIndexKeyIdSchema,
  generatedAtSchema,
  type ConnectorIndexPublicKey,
} from './directory-index.js';
import { pluginContributionKindSchema } from './plugins.js';
import { pluginIdSchema, pluginVersionSchema } from './plugin-manifest.js';

/**
 * Signed plugin-marketplace index (D104 P1-1, docs/design/51-plugin-system.md §6.1).
 *
 * Same detached-signature mechanism as the connector directory (design 29 §11.4 / §15.2):
 * `{base}/index.json` + `index.json.sig` (Ed25519 over the EXACT bytes), pulled daily,
 * verified against an independent public-key list, ratcheted against rollbacks, cached.
 * The contract lives here; verification / sync is core's `infra/signed-index.ts`, signing
 * is `scripts/sign-plugin-index.mjs`.
 *
 * Deliberate difference from design 51 §6.1: entries carry no `manifestDigest` and no
 * `summary.icon` — remote rich-text / icon fetch is out of scope for P1-1 (DEV-053).
 */

// --- constants -----------------------------------------------------------------------------

/** 官方市场索引根（只 https）。 */
export const PLUGIN_INDEX_BASE_URL = 'https://dl.kepcup.com/plugins/v1';
export const PLUGIN_INDEX_FILE = 'index.json';
export const PLUGIN_INDEX_SIG_FILE = 'index.json.sig';
/** 索引体积上限；超过即拒绝（防内存 / 磁盘耗尽）。 */
export const PLUGIN_INDEX_MAX_BYTES = 8 * 1024 * 1024;
export const PLUGIN_INDEX_SIG_MAX_BYTES = 1024;
/** 条目数上限。 */
export const PLUGIN_INDEX_MAX_ENTRIES = 5000;
/** 撤销名单上限。 */
export const PLUGIN_INDEX_MAX_REVOKED = 1000;
/** 单个插件包的体积上限（= `@kepcup/package-guard` 的 ZIP_MAX_FILE_BYTES）。 */
export const PLUGIN_PACKAGE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * 生产公钥列表（形态同 CONNECTOR_INDEX_PUBLIC_KEYS）。**空 = 市场关闭**；用户生成密钥并
 * 登记前保持为空（见 infra/cloudflare/plugins/README.md 的用户待办）。
 */
export const PLUGIN_INDEX_PUBLIC_KEYS: readonly ConnectorIndexPublicKey[] = [];

/**
 * 同步节奏：与连接器目录通道完全一致（每日 + 失败约 1 小时重试 + ±10% 抖动 + 3 天算过期），
 * 不另造一套常量。
 */
export const PLUGIN_INDEX_SYNC_INTERVAL_MS = CONNECTOR_INDEX_SYNC_INTERVAL_MS;
export const PLUGIN_INDEX_RETRY_MS = CONNECTOR_INDEX_RETRY_MS;
export const PLUGIN_INDEX_SYNC_JITTER_RATIO = CONNECTOR_INDEX_SYNC_JITTER_RATIO;
export const PLUGIN_INDEX_INITIAL_DELAY_MS = CONNECTOR_INDEX_INITIAL_DELAY_MS;
export const PLUGIN_INDEX_STALE_AFTER_MS = CONNECTOR_INDEX_STALE_AFTER_MS;

// --- index schema --------------------------------------------------------------------------

const pluginSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const httpsUrl = (max: number) =>
  z
    .string()
    .url()
    .max(max)
    .refine((value) => value.startsWith('https://'), { message: 'must be an https URL' });

/** One marketplace entry; per-entry validation happens in core so a bad entry skips alone. */
export const pluginIndexEntrySchema = z.object({
  id: pluginIdSchema,
  version: pluginVersionSchema,
  tier: z.enum(['verified', 'community']),
  /** 整包 `.kepcup` 字节的 sha256（下载后强校验）。 */
  sha256: pluginSha256Schema,
  size: z.number().int().min(1).max(PLUGIN_PACKAGE_MAX_BYTES),
  /** 内容寻址的包下载地址（CI 写 `{download-base}/{sha256}.kepcup`）。 */
  downloadUrl: httpsUrl(500),
  engines: z.object({ kepcup: z.string().min(1).max(100) }).optional(),
  platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).min(1).optional(),
  /** 签名时由贡献推导写入（skills→skill、connectors→connector、mcp→mcp、mail→mail）。 */
  categories: z.array(pluginContributionKindSchema).max(4),
  summary: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(''),
    author: z.string().max(100).nullable().default(null),
  }),
  updatedAt: z.number().int().min(0),
});
export type PluginIndexEntry = z.infer<typeof pluginIndexEntrySchema>;

export const pluginIndexRevokedSchema = z.object({
  id: pluginIdSchema,
  version: pluginVersionSchema.optional(),
  action: z.enum(['warn', 'disable']).default('warn'),
  reason: z.string().max(200).default(''),
});
export type PluginIndexRevoked = z.infer<typeof pluginIndexRevokedSchema>;

/**
 * 索引信封。`entries` 在这里只校验为数组：逐条的 `pluginIndexEntrySchema` 校验由 core 做
 * （`MarketplaceSync.entries()`），坏条目单独跳过（新版市场里出现老客户端不认识的形状不应
 * 让整份索引失效）。`revoked` 有默认值，CI 脚本仍始终写它。
 */
export const pluginIndexSchema = z.object({
  version: z.literal(1),
  generatedAt: generatedAtSchema,
  keyId: connectorIndexKeyIdSchema,
  entries: z.array(z.unknown()).max(PLUGIN_INDEX_MAX_ENTRIES),
  revoked: z.array(pluginIndexRevokedSchema).max(PLUGIN_INDEX_MAX_REVOKED).default([]),
});
export type PluginIndex = z.infer<typeof pluginIndexSchema>;

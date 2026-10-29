import { z } from 'zod';
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
 * Deliberate difference from design 51 §6.1: entries carry no `manifestDigest` (remote
 * rich-text / README fetch is out of scope, DEV-053). `summary.icon` IS carried inline as
 * a data URI so marketplace cards can show the plugin's own icon without any remote image
 * fetch; a missing / unusable icon degrades to the host default icon.
 */

// --- signed-index primitives（原 directory-index 的通用部分；连接器目录通道已移除）---------

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const indexKeyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/**
 * 编进应用的公钥条目（支持轮换）：`publicKey` 是 Ed25519 **原始** 32 字节公钥的 base64；
 * `validFrom` / `validUntil` 是该密钥可签发索引的 `generatedAt` 范围（毫秒，含起不含止，
 * `validUntil` 缺省 = 无期限）。轮换：先发带新密钥的应用版本，再切签名密钥，旧密钥设
 * `validUntil`，泄露设 `revoked: true`（infra/cloudflare/plugins/README.md）。
 */
export const indexPublicKeySchema = z.object({
  keyId: indexKeyIdSchema,
  publicKey: z.string().length(44).regex(BASE64_PATTERN),
  validFrom: z.number().int().min(0),
  validUntil: z.number().int().min(0).optional(),
  revoked: z.boolean().default(false),
});
export type IndexPublicKey = z.input<typeof indexPublicKeySchema>;

export type IndexKeySelection =
  | { ok: true; key: IndexPublicKey }
  | { ok: false; reason: 'unknown_key' | 'revoked_key' | 'key_not_valid_at' };

/** 按 `keyId` 取验签用的公钥：未知 / 已吊销 / `generatedAt` 不在其有效期内都拒绝。 */
export function selectIndexKey(
  keys: readonly IndexPublicKey[],
  keyId: string,
  generatedAt: number,
): IndexKeySelection {
  const key = keys.find((candidate) => candidate.keyId === keyId);
  if (key === undefined) return { ok: false, reason: 'unknown_key' };
  if (key.revoked === true) return { ok: false, reason: 'revoked_key' };
  if (
    generatedAt < key.validFrom ||
    (key.validUntil !== undefined && generatedAt >= key.validUntil)
  ) {
    return { ok: false, reason: 'key_not_valid_at' };
  }
  return { ok: true, key };
}

/** `generatedAt`：ISO 8601 字符串或 epoch 毫秒；统一规范化为毫秒。 */
export const generatedAtSchema = z
  .union([
    z.number().int().min(1),
    z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'generatedAt must be an ISO 8601 date or epoch milliseconds',
    }),
  ])
  .transform((value) => (typeof value === 'number' ? value : Date.parse(value)));

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
 * 生产公钥列表。**空 = 市场关闭**。这是编译进应用的
 * 信任锚：只能通过应用发版增删，绝不从设置 / 环境运行时读取。私钥只存在于发布侧
 * （CI 机密 / 本机 `.env` 的 `KEPCUP_PLUGIN_SIGNING_KEY`），与这里永不同处。
 */
export const PLUGIN_INDEX_PUBLIC_KEYS: readonly IndexPublicKey[] = [
  {
    keyId: 'kepcup-plugins-2026-1',
    publicKey: '743SNAR3ZSUjoNZETb/NV1WDup6fFPtMcLT5LXrjtDw=',
    validFrom: Date.UTC(2026, 9, 27),
    revoked: false,
  },
];

/** 同步节奏：每日 + 失败约 1 小时重试 + ±10% 抖动 + 3 天算过期。 */
export const PLUGIN_INDEX_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_INDEX_RETRY_MS = 60 * 60 * 1000;
export const PLUGIN_INDEX_SYNC_JITTER_RATIO = 0.1;
export const PLUGIN_INDEX_INITIAL_DELAY_MS = { min: 20_000, max: 120_000 } as const;
export const PLUGIN_INDEX_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

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
  platforms: z
    .array(z.enum(['darwin', 'win32', 'linux']))
    .min(1)
    .optional(),
  /** 签名时由贡献推导写入（skills→skill、connectors→connector、mcp→mcp、mail→mail）。 */
  categories: z.array(pluginContributionKindSchema).max(4),
  /** 签名时由贡献推导的一句话能力概述（D105 P4）；老索引没有此字段，消费端按 categories 回退推导。 */
  capabilitySummary: z.string().max(200).optional(),
  summary: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(''),
    author: z.string().max(100).nullable().default(null),
    /**
     * Package icon inlined by the signer (`data:image/svg+xml;base64,…` /
     * `data:image/png;base64,…`, ≤ `PLUGIN_MARKET_ICON_MAX_BYTES` raw). Old indexes and
     * packages without an icon carry null; the market card then shows the default icon.
     * Not range-checked here: a bad value must not drop the whole entry — core sanitizes
     * with `isPluginIconDataUri` before exposing it to the renderer.
     */
    icon: z.string().nullable().default(null),
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
  keyId: indexKeyIdSchema,
  entries: z.array(z.unknown()).max(PLUGIN_INDEX_MAX_ENTRIES),
  revoked: z.array(pluginIndexRevokedSchema).max(PLUGIN_INDEX_MAX_REVOKED).default([]),
});
export type PluginIndex = z.infer<typeof pluginIndexSchema>;

import { z } from 'zod';
import { connectorNameSchema } from './connector-catalog.js';

/**
 * 签名目录索引（docs/design/29-connected-apps.md §11.4 / §15.2，执行方案 §7.1，D73 P3）。
 *
 * 目录服务（`dl.kepcup.com/connectors/v1/`）托管 CI 离线签名后的静态文件：
 *
 * - `index.json`：`{ version, generatedAt, keyId, entries: server.json[], deltas? }`；
 * - `index.json.sig`：对 `index.json` **原始字节**的 Ed25519 分离签名（base64，64 字节签名）；
 * - `deltas/{fromHash}-{toHash}.json`：内容寻址、不可变的增量文件。`fromHash` / `toHash` 是
 *   两份 `entries` 的**条目集哈希**（{@link stableStringify} 规范化后取 sha256 hex，哈希在
 *   core / 脚本里算——shared 不依赖 Node）。索引始终携带完整 `entries`，增量只是带宽优化。
 *
 * 本文件只放契约与纯函数（schema、常量、公钥列表、密钥选择、增量应用、规范化序列化）。
 * 验签（Node `crypto`）与同步在 core 的 `apps/directory-sync.ts`，签名在
 * `scripts/sign-connector-index.mjs`；两处的规范化序列化必须与这里逐字节一致（有测试锁定）。
 */

// --- 常量 -----------------------------------------------------------------------------

/** 目录服务根（只 https）。 */
export const CONNECTOR_DIRECTORY_BASE_URL = 'https://dl.kepcup.com/connectors/v1';
export const CONNECTOR_INDEX_FILE = 'index.json';
export const CONNECTOR_INDEX_SIG_FILE = 'index.json.sig';
/** 索引（含增量文件）体积上限；超过即拒绝（防内存 / 磁盘耗尽）。 */
export const CONNECTOR_INDEX_MAX_BYTES = 4 * 1024 * 1024;
export const CONNECTOR_INDEX_SIG_MAX_BYTES = 1024;
/** 条目数上限（千级目录绰绰有余）。 */
export const CONNECTOR_INDEX_MAX_ENTRIES = 5000;
/** 每日拉取；抖动 ±10%，避免整点齐发。 */
export const CONNECTOR_INDEX_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 拉取失败后的重试间隔（约 1 小时，带同样的抖动），成功后回到每日。 */
export const CONNECTOR_INDEX_RETRY_MS = 60 * 60 * 1000;
export const CONNECTOR_INDEX_SYNC_JITTER_RATIO = 0.1;
/** 启动后首次拉取的延迟范围（毫秒）：错开启动高峰。 */
export const CONNECTOR_INDEX_INITIAL_DELAY_MS = { min: 20_000, max: 120_000 } as const;
/** 距上次成功拉取超过此时长 = `stale`（仍使用已验签的缓存）。 */
export const CONNECTOR_INDEX_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// --- 公钥列表 -------------------------------------------------------------------------

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const connectorIndexKeyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/**
 * 编进应用的公钥条目（支持轮换）：
 * - `publicKey`：Ed25519 **原始** 32 字节公钥的 base64（44 字符）；
 * - `validFrom` / `validUntil`：该密钥可签发索引的 `generatedAt` 范围（毫秒，含起、不含止；
 *   `validUntil` 缺省 = 无期限）。轮换流程：先发带新密钥的应用版本，再让 CI 切到新密钥，
 *   旧密钥设 `validUntil`，泄露时设 `revoked: true`（见 infra/cloudflare/directory/README.md）。
 */
export const connectorIndexPublicKeySchema = z.object({
  keyId: connectorIndexKeyIdSchema,
  publicKey: z.string().length(44).regex(BASE64_PATTERN),
  validFrom: z.number().int().min(0),
  validUntil: z.number().int().min(0).optional(),
  revoked: z.boolean().default(false),
});
export type ConnectorIndexPublicKey = z.input<typeof connectorIndexPublicKeySchema>;

/**
 * 生产公钥列表。**目前为空**：真正的签名密钥由用户生成（执行方案 U5，私钥只放 CI 机密、
 * 绝不进仓库），生成后把公钥登记在这里并发版。列表为空 = 目录同步关闭，只用随应用打包的快照。
 */
export const CONNECTOR_INDEX_PUBLIC_KEYS: readonly ConnectorIndexPublicKey[] = [];

export type IndexKeySelection =
  | { ok: true; key: ConnectorIndexPublicKey }
  | { ok: false; reason: 'unknown_key' | 'revoked_key' | 'key_not_valid_at' };

/** 按 `keyId` 取验签用的公钥：未知 / 已吊销 / `generatedAt` 不在其有效期内都拒绝。 */
export function selectIndexKey(
  keys: readonly ConnectorIndexPublicKey[],
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

// --- 索引 / 增量 schema -----------------------------------------------------------------

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** `generatedAt`：ISO 8601 字符串或 epoch 毫秒；统一规范化为毫秒。 */
const generatedAtSchema = z
  .union([
    z.number().int().min(1),
    z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'generatedAt must be an ISO 8601 date or epoch milliseconds',
    }),
  ])
  .transform((value) => (typeof value === 'number' ? value : Date.parse(value)));

/** `deltas/{from}-{to}.json` 的相对路径（固定形状，不含 `..`）。 */
export function connectorDeltaPath(from: string, to: string): string {
  return `deltas/${from}-${to}.json`;
}

export const connectorIndexDeltaRefSchema = z
  .object({
    from: sha256HexSchema,
    to: sha256HexSchema,
    path: z.string(),
    /** 增量文件**原始字节**的 sha256（索引已签名，所以下载后用它校验）。 */
    sha256: sha256HexSchema,
  })
  .refine((ref) => ref.path === connectorDeltaPath(ref.from, ref.to), {
    message: 'delta path must be deltas/{from}-{to}.json',
    path: ['path'],
  });
export type ConnectorIndexDeltaRef = z.infer<typeof connectorIndexDeltaRefSchema>;

/**
 * 索引信封。`entries` 在这里只校验为数组：逐条的 `connectorCatalogEntrySchema` 校验由
 * 消费方做，坏条目单独跳过（新版目录里出现老客户端不认识的枚举值不应让整份索引失效）。
 */
export const connectorIndexSchema = z.object({
  version: z.literal(1),
  generatedAt: generatedAtSchema,
  keyId: connectorIndexKeyIdSchema,
  entries: z.array(z.unknown()).max(CONNECTOR_INDEX_MAX_ENTRIES),
  deltas: z.array(connectorIndexDeltaRefSchema).max(64).optional(),
});
export type ConnectorIndex = z.infer<typeof connectorIndexSchema>;

/** 增量文件：从条目集 `from` 到 `to`——新增 / 更新的条目（按 `name`）与删除的条目名。 */
export const connectorDeltaFileSchema = z.object({
  version: z.literal(1),
  from: sha256HexSchema,
  to: sha256HexSchema,
  upsert: z.array(z.unknown()).max(CONNECTOR_INDEX_MAX_ENTRIES),
  remove: z.array(connectorNameSchema).max(CONNECTOR_INDEX_MAX_ENTRIES),
});
export type ConnectorDeltaFile = z.infer<typeof connectorDeltaFileSchema>;

// --- 纯函数 ---------------------------------------------------------------------------

/**
 * 规范化 JSON 序列化：对象键按字典序、无空白、`undefined` 键省略。条目集哈希与 CI 脚本
 * 共用它——两边必须逐字节一致。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** 条目集的规范化形态（按 `name` 排序）——条目集哈希的输入。 */
export function canonicalEntriesJson(entries: readonly unknown[]): string {
  const named = entries.map((entry) => ({ name: directoryEntryName(entry), entry }));
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return stableStringify(named.map((item) => item.entry));
}

/** 未校验条目的 `name`（取不到 = 空串）。 */
export function directoryEntryName(entry: unknown): string {
  if (entry !== null && typeof entry === 'object' && 'name' in entry) {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** 把增量应用到条目集：先删后 upsert（按 `name`）。纯函数；哈希核对由调用方做。 */
export function applyDirectoryDelta(
  entries: readonly unknown[],
  delta: Pick<ConnectorDeltaFile, 'upsert' | 'remove'>,
): unknown[] {
  const byName = new Map<string, unknown>();
  for (const entry of entries) byName.set(directoryEntryName(entry), entry);
  for (const name of delta.remove) byName.delete(name);
  for (const entry of delta.upsert) byName.set(directoryEntryName(entry), entry);
  return [...byName.values()];
}

// --- RPC 视图 ---------------------------------------------------------------------------

export const directorySyncStateSchema = z.enum(['disabled', 'ok', 'degraded', 'stale']);
export type DirectorySyncState = z.infer<typeof directorySyncStateSchema>;

/** `apps.directory.status` / `apps.directory.sync` 的返回：不含任何密钥材料。 */
export const appsDirectoryStatusSchema = z.object({
  state: directorySyncStateSchema,
  /** 最近一次**成功**同步（200 验签通过 / 304 / 内容未变）的时间；从未成功 = null。 */
  lastSync: z.number().nullable(),
  /** 正在使用的已验签索引的 `generatedAt`（毫秒）；只用快照 = null。 */
  version: z.number().nullable(),
  keyId: z.string().nullable(),
  /** 合并进目录的远端条目数（已验签索引中通过校验的条目）。 */
  remoteEntries: z.number().int().min(0),
  /** 最近一次失败的原因（脱敏文案）；成功后清空。 */
  error: z.string().nullable(),
  /** 为何关闭（`disabled` 时）：no_keys = 公钥列表为空；setting_off = 设置关闭。 */
  disabledReason: z.enum(['no_keys', 'setting_off']).nullable(),
});
export type AppsDirectoryStatus = z.infer<typeof appsDirectoryStatusSchema>;

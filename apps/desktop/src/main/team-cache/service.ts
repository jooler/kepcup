import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { ZodType } from 'zod';
import {
  TEAM_CACHE_MEMBER_ID_PATTERN,
  TEAM_CACHE_SERVER_HASH_PATTERN,
  platformTeamCacheClearPartitionInputSchema,
  platformTeamCacheClearServerInputSchema,
  platformTeamCacheCloseInputSchema,
  platformTeamCacheGetAttachmentInputSchema,
  platformTeamCacheGetConversationsInputSchema,
  platformTeamCacheGetMessagesInputSchema,
  platformTeamCacheOpenInputSchema,
  platformTeamCachePutAttachmentInputSchema,
  platformTeamCachePutConversationsInputSchema,
  platformTeamCachePutMessagesInputSchema,
  platformTeamCacheSetAttachmentLimitInputSchema,
  platformTeamCacheUsageInputSchema,
} from '@kepcup/shared';
import { teamRpcError, type IpcRegistrar, type SafeStorageLike } from '../team-servers';
import { CachePartition, partitionPathsOf, sanitizePathSegment } from './partition';

/**
 * T8（62.10 D136 / T8 §2）：`platform.teamCache.*` 的桌面主进程实现。
 *
 * 每 (serverHash, memberId) 一个分区（`<userData>/team-cache/<serverHash>/<memberId>/`），
 * 整库加密 + 独立分区密钥（safeStorage 保护）；附件逐文件 AEAD + LRU 上限
 * （默认 1 GB，设置可调，偏好落 `<userData>/team-cache/prefs.json`——非敏感，
 * 成员域不入开源设置目录，62.03 §5）。
 *
 * 休眠铁律：构造零副作用；分区目录只在首次 open（同步引擎启动）时创建。
 * `safeStorage` 不可用 → open 拒绝 → 渲染层同步引擎整体禁用缓存（写缓存跳过、
 * 读路径直连服务端），**不做明文兜底**。
 *
 * 分区内部不校验成员（调用方由渲染层同步引擎保证——桌面只打开当前登录成员的
 * 分区，62.10 §3）；输入经 shared zod schema 校验（仿 team-servers 的登记模式）。
 */

/** 附件 LRU 默认上限：1 GB（62.10 §4「按累计字节数」）。 */
export const DEFAULT_ATTACHMENT_LIMIT_BYTES = 1024 * 1024 * 1024;

const PREFS_FILE = 'prefs.json';

interface PrefsFile {
  version: 1;
  attachmentLimitBytes: number;
}

export interface TeamCacheDeps {
  /** `<userData>/team-cache`（index.ts 注入；测试注入 tmpdir）。 */
  baseDir(): string;
  safeStorage: SafeStorageLike;
  /** 分区密钥 / 附件 nonce 的随机源（默认 node crypto；测试可固定）。 */
  randomBytes?: (size: number) => Buffer;
  /** LRU 的时钟（默认 Date.now；测试可注入单调钟）。 */
  now?: () => number;
  /** 主进程只允许 console.warn / console.error（BR-P13-008：无文案进程）。 */
  log?(message: string, error?: unknown): void;
}

function parseJsonInput<T>(schema: ZodType<T>, input: unknown): T {
  const check = schema.safeParse(input);
  if (!check.success) throw teamRpcError('INVALID_INPUT', '参数不合法');
  return check.data;
}

export function partitionMapKey(serverHash: string, memberId: string): string {
  return `${serverHash}\n${memberId}`;
}

/**
 * 分区标识的 service 层校验（T8 审查修正：schema 层的 zod regex 只挡 IPC 入口，
 * 直连 in-process 调用走这里——与 shared 同款白名单。任何 `..` / `/` / `\` /
 * 绝对路径形状在拼进文件系统路径之前被拒；partition.ts 的 sanitizePathSegment
 * 是其下的防御性兜底，不作为唯一防线）。
 */
export function assertPartitionSegments(serverHash: string, memberId?: string): void {
  if (!TEAM_CACHE_SERVER_HASH_PATTERN.test(serverHash)) {
    throw teamRpcError('INVALID_INPUT', '参数不合法');
  }
  if (memberId !== undefined && !TEAM_CACHE_MEMBER_ID_PATTERN.test(memberId)) {
    throw teamRpcError('INVALID_INPUT', '参数不合法');
  }
}

export class TeamCacheService {
  readonly #deps: TeamCacheDeps;
  /** 已打开分区（`<serverHash>\n<memberId>` → 分区）。 */
  readonly #partitions = new Map<string, CachePartition>();
  #attachmentLimitBytes: number | null = null;

  constructor(deps: TeamCacheDeps) {
    this.#deps = deps;
  }

  /** 注册 ipcMain handlers（channel：`platform:teamCache:<verb>`，仿 teamServers）。 */
  registerIpc(register: IpcRegistrar): void {
    register('platform:teamCache:open', (_event, input) =>
      this.open(parseJsonInput(platformTeamCacheOpenInputSchema, input)),
    );
    register('platform:teamCache:close', (_event, input) =>
      this.close(parseJsonInput(platformTeamCacheCloseInputSchema, input)),
    );
    register('platform:teamCache:putConversations', (_event, input) =>
      this.putConversations(parseJsonInput(platformTeamCachePutConversationsInputSchema, input)),
    );
    register('platform:teamCache:putMessages', (_event, input) =>
      this.putMessages(parseJsonInput(platformTeamCachePutMessagesInputSchema, input)),
    );
    register('platform:teamCache:getConversations', (_event, input) =>
      this.getConversations(parseJsonInput(platformTeamCacheGetConversationsInputSchema, input)),
    );
    register('platform:teamCache:getMessages', (_event, input) =>
      this.getMessages(parseJsonInput(platformTeamCacheGetMessagesInputSchema, input)),
    );
    register('platform:teamCache:putAttachment', (_event, input) =>
      this.putAttachment(parseJsonInput(platformTeamCachePutAttachmentInputSchema, input)),
    );
    register('platform:teamCache:getAttachment', (_event, input) =>
      this.getAttachment(parseJsonInput(platformTeamCacheGetAttachmentInputSchema, input)),
    );
    register('platform:teamCache:clearPartition', (_event, input) =>
      this.clearPartition(parseJsonInput(platformTeamCacheClearPartitionInputSchema, input)),
    );
    register('platform:teamCache:clearServer', (_event, input) =>
      this.clearServer(parseJsonInput(platformTeamCacheClearServerInputSchema, input)),
    );
    register('platform:teamCache:usage', (_event, input) =>
      this.usage(parseJsonInput(platformTeamCacheUsageInputSchema, input)),
    );
    register('platform:teamCache:setAttachmentLimit', (_event, input) =>
      this.setAttachmentLimit(parseJsonInput(platformTeamCacheSetAttachmentLimitInputSchema, input)),
    );
  }

  /** 应用退出 / 测试 teardown：关掉全部打开的分区（数据保留）。 */
  closeAll(): void {
    for (const partition of this.#partitions.values()) partition.close();
    this.#partitions.clear();
  }

  // --- 方法实现 ---------------------------------------------------------------

  open(input: { serverHash: string; memberId: string }): { ok: true } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    partition.open();
    // 打开时就把当前偏好上限生效一次（设置改小后未淘汰的旧附件收敛）。
    try {
      partition.enforceAttachmentLimit(this.attachmentLimitBytes());
    } catch (error) {
      this.#deps.log?.(`team-cache limit enforcement failed (${input.serverHash})`, error);
    }
    return { ok: true };
  }

  close(input: { serverHash: string; memberId: string }): { ok: true } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const key = partitionMapKey(input.serverHash, input.memberId);
    const partition = this.#partitions.get(key);
    if (partition !== undefined) {
      partition.close();
      this.#partitions.delete(key);
    }
    return { ok: true };
  }

  putConversations(input: {
    serverHash: string;
    memberId: string;
    conversations: Array<Record<string, unknown>>;
    replace?: boolean;
  }): { ok: true } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    partition.open();
    partition.putConversations(input.conversations as never, input.replace === true);
    return { ok: true };
  }

  putMessages(input: {
    serverHash: string;
    memberId: string;
    conversationId: string;
    messages: Array<Record<string, unknown>>;
    replace?: boolean;
  }): { ok: true } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    partition.open();
    partition.putMessages(input.conversationId, input.messages as never, input.replace === true);
    return { ok: true };
  }

  getConversations(input: { serverHash: string; memberId: string }): { conversations: unknown[] } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    if (!this.#tryEnsureOpen(partition)) return { conversations: [] };
    return { conversations: partition.getConversations() };
  }

  getMessages(input: {
    serverHash: string;
    memberId: string;
    conversationId: string;
    limit?: number;
    beforeSeq?: number;
  }): { messages: unknown[] } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    if (!this.#tryEnsureOpen(partition)) return { messages: [] };
    return {
      messages: partition.getMessages(input.conversationId, {
        limit: input.limit,
        beforeSeq: input.beforeSeq,
      }),
    };
  }

  putAttachment(input: {
    serverHash: string;
    memberId: string;
    key: string;
    bytes: string;
  }): { ok: true } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    partition.open();
    partition.putAttachment(input.key, Buffer.from(input.bytes, 'base64'));
    try {
      partition.enforceAttachmentLimit(this.attachmentLimitBytes());
    } catch (error) {
      this.#deps.log?.(`team-cache attachment eviction failed (${input.serverHash})`, error);
    }
    return { ok: true };
  }

  getAttachment(input: {
    serverHash: string;
    memberId: string;
    key: string;
  }): { bytes: string } | { missing: true } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    if (!this.#tryEnsureOpen(partition)) return { missing: true };
    const bytes = partition.getAttachment(input.key);
    return bytes === null ? { missing: true } : { bytes: bytes.toString('base64') };
  }

  clearPartition(input: { serverHash: string; memberId: string }): { ok: true } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const key = partitionMapKey(input.serverHash, input.memberId);
    const partition = this.#partitions.get(key);
    if (partition !== undefined) {
      partition.destroy();
      this.#partitions.delete(key);
      return { ok: true };
    }
    // 未打开过的分区也可能有残留（上次会话缓存）：直接删目录。
    rmSync(partitionPathsOf(this.#deps.baseDir(), input.serverHash, input.memberId).dir, {
      recursive: true,
      force: true,
    });
    return { ok: true };
  }

  clearServer(input: { serverHash: string }): { ok: true } {
    assertPartitionSegments(input.serverHash);
    for (const [key, partition] of [...this.#partitions]) {
      if (partition.serverHash === input.serverHash) {
        partition.destroy();
        this.#partitions.delete(key);
      }
    }
    rmSync(path.join(this.#deps.baseDir(), sanitizePathSegment(input.serverHash)), {
      recursive: true,
      force: true,
    });
    return { ok: true };
  }

  usage(input: { serverHash: string; memberId: string }): {
    cacheBytes: number | null;
    attachmentLimitBytes: number;
  } {
    assertPartitionSegments(input.serverHash, input.memberId);
    const paths = partitionPathsOf(this.#deps.baseDir(), input.serverHash, input.memberId);
    if (!existsSync(paths.dir)) {
      return { cacheBytes: null, attachmentLimitBytes: this.attachmentLimitBytes() };
    }
    // 尝试打开（同 #tryEnsureOpen 的静默退化）——目录存在但库损坏时仍报目录占用。
    const partition = this.#partitionFor(input.serverHash, input.memberId);
    this.#tryEnsureOpen(partition);
    return {
      cacheBytes: directoryBytes(paths.dir),
      attachmentLimitBytes: this.attachmentLimitBytes(),
    };
  }

  setAttachmentLimit(input: { limitBytes: number }): { ok: true } {
    this.#attachmentLimitBytes = input.limitBytes;
    const prefs: PrefsFile = { version: 1, attachmentLimitBytes: input.limitBytes };
    mkdirSync(this.#deps.baseDir(), { recursive: true });
    const file = path.join(this.#deps.baseDir(), PREFS_FILE);
    writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    // 立即对已打开分区生效。
    for (const partition of this.#partitions.values()) {
      if (!partition.opened) continue;
      try {
        partition.enforceAttachmentLimit(input.limitBytes);
      } catch (error) {
        this.#deps.log?.('team-cache limit enforcement failed', error);
      }
    }
    return { ok: true };
  }

  attachmentLimitBytes(): number {
    if (this.#attachmentLimitBytes === null) this.#attachmentLimitBytes = this.#loadPrefs();
    return this.#attachmentLimitBytes;
  }

  // --- internals ---------------------------------------------------------------

  #partitionFor(serverHash: string, memberId: string): CachePartition {
    const key = partitionMapKey(serverHash, memberId);
    let partition = this.#partitions.get(key);
    if (partition === undefined) {
      partition = new CachePartition(
        serverHash,
        memberId,
        partitionPathsOf(this.#deps.baseDir(), serverHash, memberId),
        {
          safeStorage: this.#deps.safeStorage,
          randomBytes: this.#deps.randomBytes ?? nodeRandomBytes,
          now: this.#deps.now,
        },
      );
      this.#partitions.set(key, partition);
    }
    return partition;
  }

  /** 读路径（get*）对损坏 / 未建分区静默退化：不抛错、返回空集（缓存可丢弃）。 */
  #tryEnsureOpen(partition: CachePartition): boolean {
    try {
      partition.open();
      return true;
    } catch (error) {
      // safeStorage 不可用 / 磁盘故障：读缓存视为未命中，调用方直连服务端。
      this.#deps.log?.(`team-cache open failed (${partition.serverHash}/${partition.memberId})`, error);
      return false;
    }
  }

  #loadPrefs(): number {
    const file = path.join(this.#deps.baseDir(), PREFS_FILE);
    if (!existsSync(file)) return DEFAULT_ATTACHMENT_LIMIT_BYTES;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PrefsFile>;
      if (
        parsed.version === 1 &&
        typeof parsed.attachmentLimitBytes === 'number' &&
        Number.isFinite(parsed.attachmentLimitBytes) &&
        parsed.attachmentLimitBytes >= 1
      ) {
        return parsed.attachmentLimitBytes;
      }
    } catch (error) {
      this.#deps.log?.('team-cache prefs unreadable; using default limit', error);
    }
    return DEFAULT_ATTACHMENT_LIMIT_BYTES;
  }
}

/** 目录磁盘占用（含子目录；并发删除时对消失的条目按 0 计）。 */
function directoryBytes(dir: string): number {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(full);
      continue;
    }
    try {
      total += statSync(full).size;
    } catch {
      // 并发删除：跳过。
    }
  }
  return total;
}

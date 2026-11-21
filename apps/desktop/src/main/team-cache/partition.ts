import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { ConversationCache, MessageCache } from '@kepcup/shared';
import type { SafeStorageLike } from '../team-servers';

/**
 * T8（62.10 D136 / T8 §2）：一个 (服务器, 成员) 分区的本地缓存库与附件文件。
 *
 * 布局：`<userData>/team-cache/<serverHash>/<memberId>/`——`cache.db`（整库加密，
 * pragma 口径与 core `infra/db.ts` 完全一致：先 cipher 后 key）、`key.bin`
 * （分区密钥 32 字节经 safeStorage 加密落盘，0600）、`attachments/`（逐文件
 * AEAD：分区密钥经 HKDF-SHA256 派生每文件子密钥 + 随机 nonce 的 AES-256-GCM，
 * AAD 绑定附件 key；文件名 = key 的 sha256，防路径注入）。
 *
 * 打不开 / schema 不符 / key 不匹配（safeStorage 解不开、sqlite 校验失败）→
 * 删除 `cache.db` 与 `key.bin` 重建空库，绝不抛出（缓存是可丢弃镜像）。分区内
 * 不校验成员资格——分区只服务当前登录成员，由渲染层同步引擎保证（62.10 §3）。
 */

export const TEAM_CACHE_SCHEMA_VERSION = 1;

const KEY_FILE = 'key.bin';
const KEY_PREFIX = 'v1:';
const DB_FILE = 'cache.db';
const ATTACHMENTS_DIR = 'attachments';
/** 附件文件头（nonce 前缀 + 密文），换格式时升版本。 */
const ATTACHMENT_MAGIC = Buffer.from('KTC1', 'ascii');
const ATTACHMENT_NONCE_BYTES = 12;
const HKDF_SALT = 'kepcup-team-cache';
const HKDF_INFO_PREFIX = 'team-cache-attachment:';

export type SqliteDatabase = InstanceType<typeof Database>;

/** safeStorage 的结构面（同 team-servers.ts 的注入约定；主进程注入真实 electron 对象）。 */
export type { SafeStorageLike };

export interface PartitionPaths {
  dir: string;
  dbFile: string;
  keyFile: string;
  attachmentsDir: string;
}

/** memberId / serverHash 落进文件系统路径前的清洗（两层都来自主进程状态，防御性）。 */
export function sanitizePathSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : '_';
}

export function partitionPathsOf(baseDir: string, serverHash: string, memberId: string): PartitionPaths {
  const dir = path.join(baseDir, sanitizePathSegment(serverHash), sanitizePathSegment(memberId));
  return {
    dir,
    dbFile: path.join(dir, DB_FILE),
    keyFile: path.join(dir, KEY_FILE),
    attachmentsDir: path.join(dir, ATTACHMENTS_DIR),
  };
}

export class CachePartition {
  readonly serverHash: string;
  readonly memberId: string;
  readonly paths: PartitionPaths;
  readonly #safeStorage: SafeStorageLike;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #now: () => number;
  #db: SqliteDatabase | null = null;

  constructor(
    serverHash: string,
    memberId: string,
    paths: PartitionPaths,
    options: {
      safeStorage: SafeStorageLike;
      randomBytes?: (size: number) => Buffer;
      now?: () => number;
    },
  ) {
    this.serverHash = serverHash;
    this.memberId = memberId;
    this.paths = paths;
    this.#safeStorage = options.safeStorage;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#now = options.now ?? Date.now;
  }

  get opened(): boolean {
    return this.#db !== null;
  }

  /** 幂等打开（必要时建目录 / 建密钥 / 重建损坏库）。safeStorage 不可用时抛错。 */
  open(): void {
    if (this.#db !== null) return;
    if (!this.#safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage unavailable: team cache partition disabled');
    }
    mkdirSync(this.paths.dir, { recursive: true });
    let key = this.#loadOrCreateKey();
    let db = this.#tryOpen(key);
    if (db === null) {
      // 打不开 / schema 不符 / key 不匹配：整分区重建（密钥与库文件一起重置）。
      this.#wipeDbFiles();
      key = this.#createKey();
      db = this.#tryOpen(key);
      if (db === null) {
        // 重造之后的全新文件还打不开 = 磁盘 / 环境问题（不是缓存语义），上抛。
        throw new Error(`team cache partition cannot be created at ${this.paths.dir}`);
      }
    }
    this.#db = db;
    // 空库建表（已建好的库 #tryOpen 的 schema 校验已确认表齐全）。
    this.ensureSchema();
  }

  close(): void {
    const db = this.#db;
    if (db === null) return;
    this.#db = null;
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // 库已损坏时的收尾尽力而为。
    }
    db.close();
  }

  /** 清空并关闭（clearPartition）：目录整体删除（库 + 附件 + 密钥文件）。 */
  destroy(): void {
    this.close();
    rmSync(this.paths.dir, { recursive: true, force: true });
  }

  // --- 会话 ---------------------------------------------------------------

  putConversations(conversations: ConversationCache[], replace: boolean): void {
    const db = this.#requireDb();
    const upsert = db.prepare(
      `insert into conversations(id, payload, sort_at) values (?, ?, ?)
       on conflict(id) do update set payload = excluded.payload, sort_at = excluded.sort_at`,
    );
    const run = db.transaction(() => {
      const keep = new Set<string>();
      for (const conversation of conversations) {
        keep.add(conversation.id);
        upsert.run(
          conversation.id,
          JSON.stringify(conversation),
          conversation.lastMessageAt ?? conversation.createdAt,
        );
      }
      if (replace && keep.size > 0) {
        const placeholders = [...keep].map(() => '?').join(', ');
        db.prepare(`delete from conversations where id not in (${placeholders})`).run(...keep);
      } else if (replace) {
        db.prepare('delete from conversations').run();
      }
    });
    run();
  }

  getConversations(): ConversationCache[] {
    const db = this.#requireDb();
    const rows = db
      .prepare('select id, payload from conversations order by sort_at desc, id asc')
      .all() as Array<{ id: string; payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ConversationCache);
  }

  // --- 消息 ---------------------------------------------------------------

  putMessages(conversationId: string, messages: MessageCache[], replace: boolean): void {
    const db = this.#requireDb();
    const upsert = db.prepare(
      `insert into messages(conversation_id, seq, message_id, payload, changed_at)
       values (?, ?, ?, ?, ?)
       on conflict(conversation_id, seq) do update set
         message_id = excluded.message_id,
         payload = excluded.payload,
         changed_at = excluded.changed_at`,
    );
    const run = db.transaction(() => {
      if (replace) {
        db.prepare('delete from messages where conversation_id = ?').run(conversationId);
      }
      for (const message of messages) {
        upsert.run(
          conversationId,
          message.seq,
          message.id,
          JSON.stringify(message),
          message.updatedAt ?? message.createdAt,
        );
      }
    });
    run();
  }

  /** 语义对齐 core messages.list：desc 取页再反转（升序返回）。 */
  getMessages(
    conversationId: string,
    options: { limit?: number; beforeSeq?: number } = {},
  ): MessageCache[] {
    const db = this.#requireDb();
    const limit = options.limit ?? 60;
    const rows =
      options.beforeSeq === undefined
        ? (db
            .prepare(
              `select payload from messages where conversation_id = ?
               order by seq desc limit ?`,
            )
            .all(conversationId, limit) as Array<{ payload: string }>)
        : (db
            .prepare(
              `select payload from messages where conversation_id = ? and seq < ?
               order by seq desc limit ?`,
            )
            .all(conversationId, options.beforeSeq, limit) as Array<{ payload: string }>);
    return rows.map((row) => JSON.parse(row.payload) as MessageCache).reverse();
  }

  /** 该会话缓存内的最大 seq（无行 = 0）。重连补拉与 seq 越界检测的基准。 */
  maxSeqOf(conversationId: string): number {
    const db = this.#requireDb();
    const row = db
      .prepare('select max(seq) as max from messages where conversation_id = ?')
      .get(conversationId) as { max: number | null } | undefined;
    return row?.max ?? 0;
  }

  // --- 附件（cache-aside + LRU） ---------------------------------------------

  putAttachment(key: string, bytes: Buffer): void {
    const db = this.#requireDb();
    const partitionKey = this.#key;
    if (partitionKey === null) throw new Error('partition key missing');
    mkdirSync(this.paths.attachmentsDir, { recursive: true });
    const file = attachmentFileName(key);
    const sealed = sealAttachment(bytes, key, partitionKey, this.#randomBytes);
    const target = path.join(this.paths.attachmentsDir, file);
    writeFileSync(target, sealed, { mode: 0o600 });
    chmodSync(target, 0o600);
    db.prepare(
      `insert into attachments(key, file, bytes, accessed_at) values (?, ?, ?, ?)
       on conflict(key) do update set file = excluded.file, bytes = excluded.bytes, accessed_at = excluded.accessed_at`,
    ).run(key, file, bytes.length, this.#now());
  }

  /** 命中返回明文字节；未命中 / 密文损坏返回 null（密文损坏顺带清理行与文件）。 */
  getAttachment(key: string): Buffer | null {
    const db = this.#requireDb();
    const partitionKey = this.#key;
    if (partitionKey === null) throw new Error('partition key missing');
    const row = db
      .prepare('select file from attachments where key = ?')
      .get(key) as { file: string } | undefined;
    if (row === undefined) return null;
    const file = path.join(this.paths.attachmentsDir, row.file);
    let bytes: Buffer | null;
    try {
      bytes = openAttachment(readFileSync(file), key, partitionKey);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      // 密文被挪动 / 损坏：等价于未缓存，清理后由调用方走服务端重拉。
      db.prepare('delete from attachments where key = ?').run(key);
      rmSync(file, { force: true });
      return null;
    }
    db.prepare('update attachments set accessed_at = ? where key = ?').run(this.#now(), key);
    return bytes;
  }

  /** 附件缓存累计字节数（LRU 分母）。 */
  attachmentBytes(): number {
    const db = this.#requireDb();
    const row = db
      .prepare('select sum(bytes) as total from attachments')
      .get() as { total: number | null } | undefined;
    return row?.total ?? 0;
  }

  /** 超 limit 时按 accessed_at 升序（平手按行序）淘汰到上限内。 */
  enforceAttachmentLimit(limitBytes: number): void {
    const db = this.#requireDb();
    for (;;) {
      if (this.attachmentBytes() <= limitBytes) return;
      const victim = db
        .prepare(
          'select key, file from attachments order by accessed_at asc, rowid asc limit 1',
        )
        .get() as { key: string; file: string } | undefined;
      if (victim === undefined) return;
      db.prepare('delete from attachments where key = ?').run(victim.key);
      rmSync(path.join(this.paths.attachmentsDir, victim.file), { force: true });
    }
  }

  /** 分区目录的磁盘占用（库 + wal/shm + 密钥文件 + 附件文件）。 */
  diskBytes(): number {
    return directoryBytes(this.paths.dir);
  }

  // --- 密钥与库 ---------------------------------------------------------------

  #loadOrCreateKey(): Buffer {
    if (existsSync(this.paths.keyFile)) {
      try {
        const sealed = readFileSync(this.paths.keyFile);
        const text = this.#safeStorage.decryptString(sealed);
        if (text.startsWith(KEY_PREFIX)) {
          const key = Buffer.from(text.slice(KEY_PREFIX.length), 'hex');
          if (key.length === 32) return key;
        }
      } catch {
        // 解不开（系统钥匙串换了 / 文件被挪动）：按无密钥处理，走重建。
      }
    }
    return this.#createKey();
  }

  #createKey(): Buffer {
    const key = this.#randomBytes(32);
    const sealed = this.#safeStorage.encryptString(KEY_PREFIX + key.toString('hex'));
    writeFileSync(this.paths.keyFile, sealed, { mode: 0o600 });
    chmodSync(this.paths.keyFile, 0o600);
    return key;
  }

  #key: Buffer | null = null;

  #wipeDbFiles(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(this.paths.dbFile + suffix, { force: true });
    }
    // 附件表的元数据随库一起没了：孤儿密文一并清（同 key 会由下次 put 重写）。
    rmSync(this.paths.attachmentsDir, { recursive: true, force: true });
  }

  /** 尝试用 key 打开并校验 schema；任何失败返回 null（调用方决定重建）。 */
  #tryOpen(key: Buffer): SqliteDatabase | null {
    let db: SqliteDatabase;
    try {
      db = new Database(this.paths.dbFile);
    } catch {
      return null;
    }
    this.#key = key;
    try {
      // pragma 口径照 core infra/db.ts：cipher 必须先于 key。
      db.pragma("cipher='chacha20'");
      db.pragma(`key="x'${key.toString('hex')}'"`);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = ON');
      db.pragma('temp_store = MEMORY');
      // 强制密钥校验（错 key 在这里失败，而不是拖到首次查询）。
      db.prepare('select count(*) as n from sqlite_master').get();
      // 'fresh'（空库）放行——建表交给 ensureSchema；只有真正的 schema 不符才重建。
      if (this.#schemaState(db) === 'mismatch') {
        db.close();
        this.#key = null;
        return null;
      }
      return db;
    } catch {
      try {
        db.close();
      } catch {
        // 双重失败忽略。
      }
      this.#key = null;
      return null;
    }
  }

  /** 'ok' = 版本与表齐全；'fresh' = 空库（建表）；否则视为不符（重建）。 */
  #schemaState(db: SqliteDatabase): 'ok' | 'fresh' | 'mismatch' {
    const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (version === 0) {
      const row = db
        .prepare('select count(*) as n from sqlite_master where type = ?')
        .get('table') as { n: number } | undefined;
      return (row?.n ?? 0) === 0 ? 'fresh' : 'mismatch';
    }
    if (version !== TEAM_CACHE_SCHEMA_VERSION) return 'mismatch';
    const names = new Set(
      (db
        .prepare('select name from sqlite_master where type = ?')
        .all('table') as Array<{ name: string }>).map((row) => row.name),
    );
    for (const required of ['conversations', 'messages', 'attachments']) {
      if (!names.has(required)) return 'mismatch';
    }
    return 'ok';
  }

  /** fresh 库建表并写 schema 版本 pragma（在 #tryOpen 内被调用）。 */
  ensureSchema(): void {
    const db = this.#db;
    if (db === null) return;
    if (this.#schemaState(db) === 'ok') return;
    db.exec(`
      create table if not exists conversations(
        id text primary key,
        payload text not null,
        sort_at integer not null
      );
      create table if not exists messages(
        conversation_id text not null,
        seq integer not null,
        message_id text not null,
        payload text not null,
        changed_at integer not null,
        primary key(conversation_id, seq)
      );
      create index if not exists messages_changed on messages(changed_at);
      create table if not exists attachments(
        key text primary key,
        file text not null,
        bytes integer not null,
        accessed_at integer not null
      );
      pragma user_version = ${TEAM_CACHE_SCHEMA_VERSION};
    `);
  }

  #requireDb(): SqliteDatabase {
    const db = this.#db;
    if (db === null) throw new Error('team cache partition is not open');
    return db;
  }
}

// --- 附件密封（每文件子密钥 AEAD） ---------------------------------------------

export function attachmentFileName(key: string): string {
  return `${createHash('sha256').update(key, 'utf8').digest('hex')}.bin`;
}

function attachmentSubKey(partitionKey: Buffer, key: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', partitionKey, Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO_PREFIX + key, 'utf8'), 32),
  );
}

/** `[magic|nonce|ciphertext+tag]`，AAD 绑定附件 key（换名 / 挪用即解密失败）。 */
export function sealAttachment(
  bytes: Buffer,
  key: string,
  partitionKey: Buffer,
  randomBytes: (size: number) => Buffer,
): Buffer {
  const nonce = randomBytes(ATTACHMENT_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', attachmentSubKey(partitionKey, key), nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(key, 'utf8'));
  const sealed = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([ATTACHMENT_MAGIC, nonce, sealed]);
}

/** 解密封；任何不匹配（magic / 长度 / tag / AAD）都抛错，由调用方按未缓存处理。 */
export function openAttachment(sealed: Buffer, key: string, partitionKey: Buffer): Buffer {
  const header = ATTACHMENT_MAGIC.length + ATTACHMENT_NONCE_BYTES;
  if (sealed.length < header + 16 || !sealed.subarray(0, ATTACHMENT_MAGIC.length).equals(ATTACHMENT_MAGIC)) {
    throw new Error('attachment blob header mismatch');
  }
  const nonce = sealed.subarray(ATTACHMENT_MAGIC.length, header);
  const body = sealed.subarray(header, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', attachmentSubKey(partitionKey, key), nonce);
  decipher.setAAD(Buffer.from(key, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function directoryBytes(dir: string): number {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else {
      try {
        total += statSync(full).size;
      } catch {
        // 并发删除：跳过。
      }
    }
  }
  return total;
}

import type { ConversationCache, MessageCache } from '@kepcup/shared';
import type { TeamCachePartition, TeamCacheStore } from './team-cache-store';

/**
 * T8（62.10 §3 web / PWA）：团队缓存的 IndexedDB 适配器——与桌面 platform 实现
 * 共用 `TeamCacheStore` 接口。库名 `kepcup-team-cache:<serverHash>:<memberId>`
 * （账号分区），单一 `kv` object store（keyPath `k`），行形如 `{k, v}`。
 *
 * 平台限制（62.10 §3 文档明示）：浏览器端不加密，以同源边界 + 登出/设置里的
 * 「清除本地缓存」为界；无逐条 LRU（配额交浏览器管理，超限时 IndexedDB 写入
 * 自然失败并被调用方按未缓存处理）。
 *
 * 休眠：任何 IndexedDB 操作都只在 store 方法被调用时发生（同步引擎连接建立后
 * 才 open）——未配置团队服务器 = 不建库。已建库名登记在 localStorage
 * （`kepcup.teamCache.dbs`），clearServer 据此删掉该服务器的全部分区库。
 */

const DB_NAME_PREFIX = 'kepcup-team-cache:';
const STORE_NAME = 'kv';
const DB_REGISTRY_KEY = 'kepcup.teamCache.dbs';

export function idbNameOf(partition: TeamCachePartition): string {
  return `${DB_NAME_PREFIX}${partition.serverHash}:${partition.memberId}`;
}

// --- 可注入的最小 IDB 面（测试用内存替身；生产用 window.indexedDB 包装） ---------

export interface IdbStoreHandle {
  get(key: string): Promise<unknown>;
  getAll(): Promise<unknown[]>;
  put(value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface IdbFactoryLike {
  open(name: string): Promise<IdbStoreHandle>;
  remove(name: string): Promise<void>;
}

/** 内存替身：同一套 adapter 用例跑在它上面（仓库无 fake-indexeddb，不新增依赖）。 */
export function createMemoryIdbFactory(): IdbFactoryLike {
  const databases = new Map<string, Map<string, unknown>>();
  return {
    async open(name) {
      let db = databases.get(name);
      if (db === undefined) {
        db = new Map();
        databases.set(name, db);
      }
      const store = db;
      return {
        async get(key) {
          return store.get(key);
        },
        async getAll() {
          return [...store.values()];
        },
        async put(value) {
          const record = value as { k: string };
          store.set(record.k, value);
        },
        async delete(key) {
          store.delete(key);
        },
        async clear() {
          store.clear();
        },
      };
    },
    async remove(name) {
      databases.delete(name);
    },
  };
}

/** 浏览器 IndexedDB 的最小包装（单 store、无索引——数据量按会话分页可控）。 */
export function createBrowserIdbFactory(indexedFactory: IDBFactory): IdbFactoryLike {
  return {
    open(name) {
      return new Promise((resolve, reject) => {
        const openReq = indexedFactory.open(name, 1);
        openReq.onupgradeneeded = () => {
          const db = openReq.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'k' });
        };
        openReq.onerror = () => reject(openReq.error ?? new Error('indexeddb open failed'));
        openReq.onsuccess = () => {
          const db = openReq.result;
          const withStore = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
            new Promise((resolve, reject) => {
              const tx = db.transaction(STORE_NAME, mode);
              const store = tx.objectStore(STORE_NAME);
              const req = run(store);
              tx.oncomplete = () => resolve(req === undefined ? undefined : req.result);
              tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
              tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
            });
          resolve({
            async get(key) {
              return (await withStore('readonly', (store) => store.get(key))) as unknown;
            },
            async getAll() {
              return (await withStore('readonly', (store) => store.getAll())) as unknown[];
            },
            async put(value) {
              await withStore('readwrite', (store) => void store.put(value));
            },
            async delete(key) {
              await withStore('readwrite', (store) => void store.delete(key));
            },
            async clear() {
              await withStore('readwrite', (store) => void store.clear());
            },
          });
        };
      });
    },
    remove(name) {
      return new Promise((resolve, reject) => {
        const req = indexedFactory.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('indexeddb delete failed'));
        req.onblocked = () => resolve();
      });
    },
  };
}

// --- 行编解码 -----------------------------------------------------------------

interface KvRecord {
  k: string;
  v: unknown;
}

function conversationKey(id: string): string {
  return `conv:${id}`;
}

function messageKey(conversationId: string, seq: number): string {
  // seq 定宽：字符串序 = 数值序（未来直接游标遍历时用得上；当前排序在 JS 里做）。
  return `msg:${conversationId}:${String(seq).padStart(15, '0')}`;
}

function attachmentKey(key: string): string {
  return `att:${key}`;
}

// --- 适配器 -------------------------------------------------------------------

export function createIdbTeamCacheStore(options?: { factory?: IdbFactoryLike }): TeamCacheStore {
  const factory = options?.factory ?? createBrowserIdbFactory(window.indexedDB);
  const handles = new Map<string, Promise<IdbStoreHandle>>();
  const handleFor = (name: string): Promise<IdbStoreHandle> => {
    let handle = handles.get(name);
    if (handle === undefined) {
      handle = factory.open(name).then((opened) => {
        rememberDbName(name);
        return opened;
      });
      handles.set(name, handle);
    }
    return handle;
  };
  const dbOf = (partition: TeamCachePartition): Promise<IdbStoreHandle> =>
    handleFor(idbNameOf(partition));
  const recordsOf = async (handle: IdbStoreHandle, prefix: string): Promise<KvRecord[]> => {
    const all = (await handle.getAll()) as KvRecord[];
    return all.filter((record) => typeof record?.k === 'string' && record.k.startsWith(prefix));
  };

  return {
    async open(partition) {
      await dbOf(partition);
    },
    async close(partition) {
      // 浏览器端无显式连接句柄：丢弃缓存的 handle（下次操作重开）。
      handles.delete(idbNameOf(partition));
    },
    async putConversations(partition, conversations, replace) {
      const handle = await dbOf(partition);
      const keep = new Set<string>();
      for (const conversation of conversations) {
        keep.add(conversation.id);
        await handle.put({ k: conversationKey(conversation.id), v: conversation });
      }
      if (replace === true) {
        for (const record of await recordsOf(handle, 'conv:')) {
          const id = record.k.slice('conv:'.length);
          if (!keep.has(id)) await handle.delete(record.k);
        }
      }
    },
    async putMessages(partition, conversationId, messages, replace) {
      const handle = await dbOf(partition);
      if (replace === true) {
        for (const record of await recordsOf(handle, `msg:${conversationId}:`)) {
          await handle.delete(record.k);
        }
      }
      for (const message of messages) {
        await handle.put({ k: messageKey(conversationId, message.seq), v: message });
      }
    },
    async getConversations(partition) {
      const handle = await dbOf(partition);
      const records = await recordsOf(handle, 'conv:');
      const conversations = records
        .map((record) => record.v as ConversationCache)
        .sort((a, b) => {
          const sa = a.lastMessageAt ?? a.createdAt;
          const sb = b.lastMessageAt ?? b.createdAt;
          if (sa !== sb) return sb - sa;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      return conversations;
    },
    async getMessages(partition, conversationId, options) {
      const handle = await dbOf(partition);
      const prefix = `msg:${conversationId}:`;
      let records = await recordsOf(handle, prefix);
      if (options?.beforeSeq !== undefined) {
        const before = options.beforeSeq;
        records = records.filter((record) => {
          const seq = Number(record.k.slice(prefix.length));
          return Number.isFinite(seq) && seq < before;
        });
      }
      const messages = records
        .map((record) => record.v as MessageCache)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, options?.limit ?? 60);
      return messages.reverse();
    },
    async putAttachment(partition, key, bytesBase64) {
      const handle = await dbOf(partition);
      await handle.put({ k: attachmentKey(key), v: { bytesBase64 } });
    },
    async getAttachment(partition, key) {
      const handle = await dbOf(partition);
      const record = (await handle.get(attachmentKey(key))) as KvRecord | undefined;
      const payload = record?.v as { bytesBase64?: string } | undefined;
      return typeof payload?.bytesBase64 === 'string'
        ? { bytesBase64: payload.bytesBase64 }
        : { missing: true };
    },
    async clearPartition(partition) {
      handles.delete(idbNameOf(partition));
      const name = idbNameOf(partition);
      await factory.remove(name);
      forgetDbName(name);
    },
    async clearServer(serverHash) {
      const prefix = `${DB_NAME_PREFIX}${serverHash}:`;
      for (const name of knownDbNames()) {
        if (name.startsWith(prefix)) {
          handles.delete(name);
          await factory.remove(name);
          forgetDbName(name);
        }
      }
    },
  };
}

// --- localStorage 库名登记（clearServer 的删除清单；IndexedDB 本身无枚举 API 的
// 稳定跨浏览器实现——databases() 在旧内核缺失，登记表是最低公分母）。 ------------

function knownDbNames(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DB_REGISTRY_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

function rememberDbName(name: string): void {
  if (typeof localStorage === 'undefined') return;
  const names = knownDbNames();
  if (names.includes(name)) return;
  try {
    localStorage.setItem(DB_REGISTRY_KEY, JSON.stringify([...names, name]));
  } catch {
    // 配额满 / 隐私模式：登记失败不影响缓存本身（clearServer 只少删一个旧库）。
  }
}

function forgetDbName(name: string): void {
  if (typeof localStorage === 'undefined') return;
  const names = knownDbNames().filter((entry) => entry !== name);
  try {
    localStorage.setItem(DB_REGISTRY_KEY, JSON.stringify(names));
  } catch {
    // 同上：尽力而为。
  }
}

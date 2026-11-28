/**
 * 渲染层通用的 IndexedDB KV 封装：单库多 store，每个操作一个事务。
 *
 * 用途：按会话一条记录、随使用量长期累积的渲染层数据（消息隐藏覆盖
 * `message-visibility.svelte.ts`、composer 草稿 `composer-drafts.svelte.ts`）
 * ——这类数据放 localStorage 只能单键整表重写，会撞每源配额，还会挤占同一
 * 源下小偏好（宽度 / 语言 / 上次会话等）的写入空间；小偏好本身直接覆盖、
 * 不膨胀，继续留在 localStorage（同 chat-display.svelte.ts 通知游标先行迁
 * IndexedDB 的结论）。
 *
 * 连接按库名缓存复用；open 失败会丢弃缓存条目（factory 层可重试）。注意现存
 * 调用方在启动时把 open promise 存死整个会话：open / 读写失败即本次会话只留
 * 内存态，重启后才重试。操作失败原样抛给调用方：写路径由调用方静默（少一次
 * 落盘无碍），读路径按空表兜底。
 *
 * node 单测用 `createMemoryIdbKvFactory` 内存替身（仓库无 fake-indexeddb，
 * 不新增依赖，同 team-cache-idb.ts 的做法）。
 */

/** store 里的一条记录（key + value）。 */
export interface IdbKvEntry {
  key: string;
  value: unknown;
}

export interface IdbKvStore {
  /** 全部条目（getAllKeys + getAll 同一事务，顺序一一对应）。 */
  getEntries(): Promise<IdbKvEntry[]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IdbKvDatabase {
  /** 按名取 store；每个操作各自开事务。 */
  store(name: string): IdbKvStore;
}

export interface IdbKvFactory {
  /**
   * 打开（并按需建 store）；`migrate` 在 upgradeneeded 里执行（建 object
   * store 等）。库版本只增不减。
   */
  open(name: string, version: number, migrate?: (db: IDBDatabase) => void): Promise<IdbKvDatabase>;
}

/** 开一个事务跑 `run`（同步发起请求），等事务完成（结果可从事务外读）。 */
function runTx(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    run(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
  });
}

/** 浏览器 IndexedDB 的最小 KV 包装（连接按库名缓存，失败时丢缓存可重试）。 */
export function createBrowserIdbKvFactory(indexedFactory: IDBFactory): IdbKvFactory {
  const connections = new Map<string, Promise<IDBDatabase>>();
  const connectionOf = (
    name: string,
    version: number,
    migrate?: (db: IDBDatabase) => void,
  ): Promise<IDBDatabase> => {
    let connection = connections.get(name);
    if (connection === undefined) {
      connection = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedFactory.open(name, version);
        request.onupgradeneeded = () => migrate?.(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
        // onblocked（升级被旧连接阻塞）立即失败而非等待：调用方把 open promise
        // 存死并用于启动载入（ready()），挂起会卡住 bootstrap；两库版本恒为 1、
        // 首次建库后不再升级，实际几乎不可触发。
        request.onblocked = () => reject(new Error('indexeddb open blocked'));
      });
      connection.catch(() => connections.delete(name));
      connections.set(name, connection);
    }
    return connection;
  };
  return {
    open(name, version, migrate) {
      return connectionOf(name, version, migrate).then((db) => ({
        store(storeName: string): IdbKvStore {
          return {
            async getEntries() {
              let keys: IDBValidKey[] = [];
              let values: unknown[] = [];
              await runTx(db, storeName, 'readonly', (store) => {
                const keysRequest = store.getAllKeys();
                const valuesRequest = store.getAll();
                keysRequest.onsuccess = () => {
                  keys = keysRequest.result;
                };
                valuesRequest.onsuccess = () => {
                  values = valuesRequest.result;
                };
              });
              return keys.map((key, index) => ({ key: String(key), value: values[index] }));
            },
            async put(key, value) {
              await runTx(db, storeName, 'readwrite', (store) => void store.put(value, key));
            },
            async delete(key) {
              await runTx(db, storeName, 'readwrite', (store) => void store.delete(key));
            },
          };
        },
      }));
    },
  };
}

/** 内存替身：同一套 adapter 用例跑在它上面（node 单测无真实 IndexedDB）。 */
export function createMemoryIdbKvFactory(): IdbKvFactory {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  return {
    async open(name) {
      let stores = databases.get(name);
      if (stores === undefined) {
        stores = new Map();
        databases.set(name, stores);
      }
      return {
        store(storeName: string): IdbKvStore {
          let rows = stores.get(storeName);
          if (rows === undefined) {
            rows = new Map();
            stores.set(storeName, rows);
          }
          return {
            async getEntries() {
              return [...rows.entries()].map(([key, value]) => ({ key, value }));
            },
            async put(key, value) {
              rows.set(key, value);
            },
            async delete(key) {
              rows.delete(key);
            },
          };
        },
      };
    },
  };
}

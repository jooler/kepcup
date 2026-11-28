import type { Message } from '@kepcup/shared';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';
import { teamContext } from '$lib/features/team/team-context.svelte';
import {
  createBrowserIdbKvFactory,
  type IdbKvDatabase,
  type IdbKvFactory,
} from '$lib/persist/idb-kv';

/** Renderer-only overlay; core/team caches keep the plain shared Message shape. */
export type DisplayMessage = Message & { hidden?: boolean };

export type MessageVisibilityScopeResolver = (source: SourceId) => string;

/** Personal local stays stable; team scopes include the active viewer account. */
export function messageVisibilityScope(source: SourceId): string {
  if (source === 'local') {
    if (!teamContext.endpointIsTeam && !teamContext.active) return 'local';
    const memberId = teamContext.active ? teamContext.member?.id : null;
    return memberId === null ? 'local:team:identity-pending' : `local:team:${memberId}`;
  }
  const memberId = connections.get(source).memberId;
  return memberId === null ? `${source}:identity-pending` : `${source}:${memberId}`;
}

export function isVisibilityScopePending(scope: string): boolean {
  return scope.endsWith(':identity-pending');
}

/**
 * Per-device UI overlay for hidden Bot messages. Only identifiers are persisted;
 * message content always stays in the renderer's raw conversation state so the
 * model transcript and core/team storage remain unchanged.
 *
 * 持久化走 IndexedDB（`kepcup.message-visibility`，按会话一条记录：hidden /
 * preview 两个 store，键为 `conversationKey`）——用户隐藏的每条消息都会累积、
 * 无淘汰，localStorage 单键整表重写会随使用量撞每源配额，还会挤占同一源下
 * 小偏好（宽度 / 语言 / 上次会话）的写入空间。读取仍全部走内存 `$state`
 * （启动时一次性载入，App bootstrap 等它完成后再渲染会话），过滤保持同步。
 * 旧版 localStorage 整表键（v2）启动时一次性导入并删除。
 */

export const MESSAGE_VISIBILITY_STORAGE_KEY = 'kepcup.message-visibility.v2';

const VISIBILITY_DB_NAME = 'kepcup.message-visibility';
const VISIBILITY_DB_VERSION = 1;
const HIDDEN_STORE = 'hidden';
const PREVIEW_STORE = 'preview';

/** 旧版 localStorage 缝（一次性导入用；node 单测可注入）。 */
export type LegacyVisibilityStorage = Pick<Storage, 'getItem' | 'removeItem'>;

export interface MessageVisibilityPersist {
  /** 新记录库（IndexedDB，按会话一条）。null = 不可用（node 测试 / 隐私模式），只留内存。 */
  kv: IdbKvFactory | null;
  /** 旧版整表键所在存储。null = 跳过导入。 */
  legacy: LegacyVisibilityStorage | null;
}

interface PreviewOverride {
  seq: number;
  messageId: string;
}

function storageOrNull(): LegacyVisibilityStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultPersist(): MessageVisibilityPersist {
  const factory = globalThis.indexedDB;
  return {
    kv: factory === undefined || factory === null ? null : createBrowserIdbKvFactory(factory),
    legacy: storageOrNull(),
  };
}

function conversationKey(scope: string, conversationId: string): string {
  return JSON.stringify([scope, conversationId]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// --- 旧版整表键的解析（一次性导入；坏数据整条丢弃） -----------------------------

interface LegacyVisibility {
  hidden: Array<[string, string, string]>;
  previewHidden: Array<[string, string, number, string]>;
}

function readLegacyVisibility(raw: string): LegacyVisibility {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { hidden: [], previewHidden: [] };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { hidden: [], previewHidden: [] };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 2) return { hidden: [], previewHidden: [] };
  const hidden = Array.isArray(record.hidden)
    ? record.hidden.filter(
        (entry): entry is [string, string, string] =>
          Array.isArray(entry) && entry.length === 3 && entry.every(isIdentifier),
      )
    : [];
  const previewHidden = Array.isArray(record.previewHidden)
    ? record.previewHidden.filter(
        (entry): entry is [string, string, number, string] =>
          Array.isArray(entry) &&
          entry.length === 4 &&
          isIdentifier(entry[0]) &&
          isIdentifier(entry[1]) &&
          typeof entry[2] === 'number' &&
          Number.isInteger(entry[2]) &&
          entry[2] >= 0 &&
          isIdentifier(entry[3]),
      )
    : [];
  return { hidden, previewHidden };
}

// --- IndexedDB 记录值的校验（坏记录整条丢弃，当没存过） -------------------------

/** hidden 记录值 = 该会话全部被隐藏消息的 id 数组。 */
function hiddenIdValues(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isIdentifier) ? (value as string[]) : null;
}

/** preview 记录值 = 该会话的「最新一条已隐藏」覆盖。 */
function previewOverrideValue(value: unknown): PreviewOverride | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 0) {
    return null;
  }
  return isIdentifier(record.messageId) ? { seq: record.seq, messageId: record.messageId } : null;
}

export class MessageVisibilityStore {
  #kv: IdbKvFactory | null;
  #legacy: LegacyVisibilityStorage | null;
  #resolveScope: MessageVisibilityScopeResolver;
  #db: Promise<IdbKvDatabase> | null;
  #ready: Promise<void>;
  /**
   * Per-conversation index (`conversationKey` → messageId set). Keeping ids
   * grouped makes `hasHiddenMessages` / `hiddenMessageIds` O(1) / O(that
   * conversation) instead of scanning every hidden id on each sidebar row or
   * search keystroke. Still `$state` so readonly reactivity is preserved.
   */
  #hidden = $state<Record<string, Record<string, true>>>({});
  #previewHidden = $state<Record<string, PreviewOverride>>({});

  constructor(
    persist: MessageVisibilityPersist = defaultPersist(),
    resolveScope: MessageVisibilityScopeResolver = messageVisibilityScope,
  ) {
    this.#kv = persist.kv;
    this.#legacy = persist.legacy;
    this.#resolveScope = resolveScope;
    this.#db =
      persist.kv === null
        ? null
        : persist.kv.open(VISIBILITY_DB_NAME, VISIBILITY_DB_VERSION, (db) => {
            if (!db.objectStoreNames.contains(HIDDEN_STORE)) db.createObjectStore(HIDDEN_STORE);
            if (!db.objectStoreNames.contains(PREVIEW_STORE)) db.createObjectStore(PREVIEW_STORE);
          });
    this.#ready = this.#load();
  }

  /**
   * 启动载入（旧键一次性导入 + IndexedDB 全量）完成；App bootstrap await 它
   * 之后才渲染会话，避免已隐藏的消息先闪现、载入完成后又消失。
   */
  ready(): Promise<void> {
    return this.#ready;
  }

  isIdentityPending(source: SourceId): boolean {
    return isVisibilityScopePending(this.#resolveScope(source));
  }

  isHidden(source: SourceId, conversationId: string, messageId: string): boolean {
    const scope = this.#resolveScope(source);
    if (isVisibilityScopePending(scope)) return true;
    return this.#hidden[conversationKey(scope, conversationId)]?.[messageId] === true;
  }

  hiddenMessageIds(source: SourceId, conversationId: string): string[] {
    const scope = this.#resolveScope(source);
    if (isVisibilityScopePending(scope)) return [];
    return Object.keys(this.#hidden[conversationKey(scope, conversationId)] ?? {});
  }

  hasHiddenMessages(source: SourceId, conversationId: string): boolean {
    const scope = this.#resolveScope(source);
    if (isVisibilityScopePending(scope)) return true;
    const key = conversationKey(scope, conversationId);
    if (this.#previewHidden[key] !== undefined) return true;
    return this.#hasHiddenId(key);
  }

  previewHidden(source: SourceId, conversationId: string, latestSeq?: number): boolean {
    const scope = this.#resolveScope(source);
    if (isVisibilityScopePending(scope)) return true;
    const override = this.#previewHidden[conversationKey(scope, conversationId)];
    return override !== undefined && (latestSeq === undefined || override.seq >= latestSeq);
  }

  previewOverride(source: SourceId, conversationId: string): PreviewOverride | null {
    return this.#previewHidden[conversationKey(this.#resolveScope(source), conversationId)] ?? null;
  }

  setHidden(source: SourceId, conversationId: string, messageId: string, hidden: boolean): void {
    const scope = this.#resolveScope(source);
    if (isVisibilityScopePending(scope)) return;
    const key = conversationKey(scope, conversationId);
    const ids = this.#hidden[key] ?? {};
    if (hidden) {
      if (ids[messageId] === true) return;
      this.#hidden = { ...this.#hidden, [key]: { ...ids, [messageId]: true } };
    } else {
      if (ids[messageId] !== true) return;
      const next = { ...ids };
      delete next[messageId];
      const all = { ...this.#hidden };
      if (Object.keys(next).length === 0) delete all[key];
      else all[key] = next;
      this.#hidden = all;
    }
    this.#saveHidden(key);
  }

  setPreviewHidden(
    source: SourceId,
    conversationId: string,
    hidden: boolean,
    seq = 0,
    messageId = '',
  ): void {
    const scope = this.#resolveScope(source);
    if (isVisibilityScopePending(scope)) return;
    const key = conversationKey(scope, conversationId);
    if (hidden) {
      const current = this.#previewHidden[key];
      if (current?.seq === seq && current.messageId === messageId) return;
      this.#previewHidden = { ...this.#previewHidden, [key]: { seq, messageId } };
    } else {
      if (this.#previewHidden[key] === undefined) return;
      const next = { ...this.#previewHidden };
      delete next[key];
      this.#previewHidden = next;
    }
    this.#savePreview(key);
  }

  apply(source: SourceId, conversationId: string, message: Message): DisplayMessage {
    const hidden = this.isHidden(source, conversationId, message.id);
    const display = { ...message } as DisplayMessage;
    delete display.hidden;
    return hidden ? { ...display, hidden: true } : display;
  }

  applyMany(
    source: SourceId,
    conversationId: string,
    messages: readonly Message[],
  ): DisplayMessage[] {
    return messages.map((message) => this.apply(source, conversationId, message));
  }

  /** Forget one message, or every hidden message and preview override in a conversation. */
  forget(source: SourceId, conversationId: string, messageId?: string): void {
    const scope = this.#resolveScope(source);
    const prefix = conversationKey(scope, conversationId);
    let changed = false;
    const ids = this.#hidden[prefix];
    if (ids !== undefined) {
      if (messageId === undefined) {
        changed = true;
        const hidden = { ...this.#hidden };
        delete hidden[prefix];
        this.#hidden = hidden;
      } else if (ids[messageId] === true) {
        changed = true;
        const next = { ...ids };
        delete next[messageId];
        const hidden = { ...this.#hidden };
        if (Object.keys(next).length === 0) delete hidden[prefix];
        else hidden[prefix] = next;
        this.#hidden = hidden;
      }
    }
    if (messageId === undefined && this.#previewHidden[prefix] !== undefined) {
      const previews = { ...this.#previewHidden };
      delete previews[prefix];
      this.#previewHidden = previews;
      changed = true;
    }
    if (changed) {
      this.#saveHidden(prefix);
      this.#savePreview(prefix);
    }
  }

  /** O(1) presence check: keys are only created when at least one id is hidden. */
  #hasHiddenId(conversationKeyValue: string): boolean {
    return this.#hidden[conversationKeyValue] !== undefined;
  }

  // --- 载入与落盘（IndexedDB 按会话一条记录；失败只影响跨重启记忆） ------------

  /**
   * 启动载入：IndexedDB 全量并入（IDB 是迁移后的权威来源，先并入）→ 旧
   * localStorage 整表键一次性导入（只补 IDB 缺口，落库确认成功才删键）。
   * 打开 / 读取失败时按无库处理：内存态照常，旧键保留（可能是唯一持久副本）。
   */
  async #load(): Promise<void> {
    let handle: IdbKvDatabase | null = null;
    const db = this.#db;
    if (db !== null) {
      try {
        handle = await db;
      } catch {
        // 打开失败：本会话内存态照常（仅不跨重启记忆）；旧键保留重试。
        handle = null;
      }
    }
    if (handle !== null) {
      try {
        const [hiddenEntries, previewEntries] = await Promise.all([
          handle.store(HIDDEN_STORE).getEntries(),
          handle.store(PREVIEW_STORE).getEntries(),
        ]);
        // 合并方向：载入窗口内（await 之前）的内存改动是更新的——hidden 并集，
        // preview 内存已有则保留。
        const hidden = { ...this.#hidden };
        for (const { key, value } of hiddenEntries) {
          const ids = hiddenIdValues(value);
          if (ids === null) continue;
          hidden[key] = { ...(hidden[key] ?? {}), ...Object.fromEntries(ids.map((id) => [id, true])) };
        }
        this.#hidden = hidden;
        const previews = { ...this.#previewHidden };
        for (const { key, value } of previewEntries) {
          const override = previewOverrideValue(value);
          if (override === null || previews[key] !== undefined) continue;
          previews[key] = override;
        }
        this.#previewHidden = previews;
      } catch {
        // 读取失败：当无库处理（旧键不删，下次启动重试迁移）。
        handle = null;
      }
    }
    await this.#importLegacy(handle);
  }

  /**
   * 旧版整表键一次性导入：并入内存 → 涉及的会话记录逐条 await 落库 → 全部
   * 成功才删键。`handle` 为 null（无 IDB / 打开或读取失败）时只并入内存、
   * 不删键——旧键可能是唯一持久副本，删了就真丢了。
   */
  async #importLegacy(handle: IdbKvDatabase | null): Promise<void> {
    if (this.#legacy === null) return;
    let raw: string | null;
    try {
      raw = this.#legacy.getItem(MESSAGE_VISIBILITY_STORAGE_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    const persisted = readLegacyVisibility(raw);
    if (persisted.hidden.length === 0 && persisted.previewHidden.length === 0) {
      // 键在但没有任何有效条目（坏数据 / 空表）：没有可迁移的东西，直接删键。
      this.#forgetLegacyKey();
      return;
    }
    const hidden = { ...this.#hidden };
    for (const [scope, conversationId, messageId] of persisted.hidden) {
      const key = conversationKey(scope, conversationId);
      hidden[key] = { ...(hidden[key] ?? {}), [messageId]: true };
    }
    this.#hidden = hidden;
    const previews = { ...this.#previewHidden };
    for (const [scope, conversationId, seq, messageId] of persisted.previewHidden) {
      const key = conversationKey(scope, conversationId);
      if (previews[key] === undefined) previews[key] = { seq, messageId };
    }
    this.#previewHidden = previews;
    if (handle === null) return;
    try {
      for (const key of new Set(
        persisted.hidden.map(([scope, conversationId]) => conversationKey(scope, conversationId)),
      )) {
        await this.#putHiddenRecord(handle, key);
      }
      for (const key of new Set(
        persisted.previewHidden.map(([scope, conversationId]) =>
          conversationKey(scope, conversationId),
        ),
      )) {
        await this.#putPreviewRecord(handle, key);
      }
      this.#forgetLegacyKey();
    } catch {
      // 落库失败：键保留，下次启动重试导入（本会话内存态已并入，行为正确）。
      // 极端时序下（上次会话落库失败、期间用户取消隐藏、本次 hidden 并集导入）
      // 可能复活一条覆盖记录——仅在 IDB 持续不可用的异常环境可能发生，接受。
    }
  }

  #forgetLegacyKey(): void {
    try {
      this.#legacy?.removeItem(MESSAGE_VISIBILITY_STORAGE_KEY);
    } catch {
      // 删不掉也无碍：下次启动再导一次（IDB 已有的键不会被旧值覆盖）。
    }
  }

  /** 该会话的 hidden 记录写库（内存无记录 = 删记录）。 */
  async #putHiddenRecord(handle: IdbKvDatabase, key: string): Promise<void> {
    const ids = this.#hidden[key];
    const store = handle.store(HIDDEN_STORE);
    if (ids === undefined) await store.delete(key);
    else await store.put(key, Object.keys(ids));
  }

  /** 该会话的 preview 记录写库（内存无记录 = 删记录）。 */
  async #putPreviewRecord(handle: IdbKvDatabase, key: string): Promise<void> {
    const override = this.#previewHidden[key];
    const store = handle.store(PREVIEW_STORE);
    if (override === undefined) await store.delete(key);
    else await store.put(key, { seq: override.seq, messageId: override.messageId });
  }

  /** 该会话的 hidden 记录落库（写失败静默，内存态仍正确）。 */
  #saveHidden(key: string): void {
    const db = this.#db;
    if (db === null) return;
    void db
      .then((handle) => this.#putHiddenRecord(handle, key))
      .catch(() => {
        // 同旧 localStorage 行为：存储不可用 / 配额满时尽力而为。
      });
  }

  /** 该会话的 preview 记录落库。 */
  #savePreview(key: string): void {
    const db = this.#db;
    if (db === null) return;
    void db
      .then((handle) => this.#putPreviewRecord(handle, key))
      .catch(() => {
        // 同上：尽力而为。
      });
  }
}

export const messageVisibility = new MessageVisibilityStore();

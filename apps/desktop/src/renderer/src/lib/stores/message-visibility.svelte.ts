import type { Message } from '@kepcup/shared';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';
import { teamContext } from '$lib/features/team/team-context.svelte';

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
 */

export const MESSAGE_VISIBILITY_STORAGE_KEY = 'kepcup.message-visibility.v2';

export type MessageVisibilityStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface PreviewOverride {
  seq: number;
  messageId: string;
}

interface PersistedVisibility {
  version: 2;
  hidden: Array<[string, string, string]>;
  previewHidden: Array<[string, string, number, string]>;
}

function storageOrNull(): MessageVisibilityStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function conversationKey(scope: string, conversationId: string): string {
  return JSON.stringify([scope, conversationId]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readPersisted(storage: MessageVisibilityStorage | null): PersistedVisibility {
  if (storage === null) return { version: 2, hidden: [], previewHidden: [] };
  let raw: string | null;
  try {
    raw = storage.getItem(MESSAGE_VISIBILITY_STORAGE_KEY);
  } catch {
    return { version: 2, hidden: [], previewHidden: [] };
  }
  if (raw === null) return { version: 2, hidden: [], previewHidden: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 2, hidden: [], previewHidden: [] };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { version: 2, hidden: [], previewHidden: [] };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 2) return { version: 2, hidden: [], previewHidden: [] };
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
  return { version: 2, hidden, previewHidden };
}

export class MessageVisibilityStore {
  #storage: MessageVisibilityStorage | null;
  #resolveScope: MessageVisibilityScopeResolver;
  /**
   * Per-conversation index (`conversationKey` → messageId set). Keeping ids
   * grouped makes `hasHiddenMessages` / `hiddenMessageIds` O(1) / O(that
   * conversation) instead of scanning every hidden id on each sidebar row or
   * search keystroke. Still `$state` so readonly reactivity is preserved.
   */
  #hidden = $state<Record<string, Record<string, true>>>({});
  #previewHidden = $state<Record<string, PreviewOverride>>({});

  constructor(
    storage: MessageVisibilityStorage | null = storageOrNull(),
    resolveScope: MessageVisibilityScopeResolver = messageVisibilityScope,
  ) {
    this.#storage = storage;
    this.#resolveScope = resolveScope;
    const persisted = readPersisted(storage);
    const hidden: Record<string, Record<string, true>> = {};
    for (const [scope, conversationId, messageId] of persisted.hidden) {
      const key = conversationKey(scope, conversationId);
      hidden[key] = { ...hidden[key], [messageId]: true };
    }
    this.#hidden = hidden;
    this.#previewHidden = Object.fromEntries(
      persisted.previewHidden.map(([scope, conversationId, seq, messageId]) => [
        conversationKey(scope, conversationId),
        { seq, messageId },
      ]),
    );
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
    this.#persist();
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
    this.#persist();
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
    if (changed) this.#persist();
  }

  /** O(1) presence check: keys are only created when at least one id is hidden. */
  #hasHiddenId(conversationKeyValue: string): boolean {
    return this.#hidden[conversationKeyValue] !== undefined;
  }

  #persist(): void {
    if (this.#storage === null) return;
    const hidden: PersistedVisibility['hidden'] = [];
    for (const [key, ids] of Object.entries(this.#hidden)) {
      const [scope, conversationId] = JSON.parse(key) as [string, string];
      for (const messageId of Object.keys(ids)) hidden.push([scope, conversationId, messageId]);
    }
    const previewHidden: PersistedVisibility['previewHidden'] = [];
    for (const [key, override] of Object.entries(this.#previewHidden)) {
      const [scope, conversationId] = JSON.parse(key) as [string, string];
      previewHidden.push([scope, conversationId, override.seq, override.messageId]);
    }
    try {
      this.#storage.setItem(
        MESSAGE_VISIBILITY_STORAGE_KEY,
        JSON.stringify({ version: 2, hidden, previewHidden } satisfies PersistedVisibility),
      );
    } catch {
      // Storage can be unavailable or full. The in-memory overlay still works.
    }
  }
}

export const messageVisibility = new MessageVisibilityStore();

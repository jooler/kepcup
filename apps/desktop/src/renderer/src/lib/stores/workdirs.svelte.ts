import type { Workdir } from '@kepcup/shared';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { toast } from 'svelte-sonner';

/**
 * P04 client state: recent workdirs (selector), the bound workdir of the
 * current conversation and per-run lease-waiting info (status line +
 * force-revoke). Mirrors core events; refetches on conversation switch.
 */
class WorkdirsState {
  recent = $state<Workdir[]>([]);
  /**
   * 不在 `recent`（只有最近 10 条）里的已绑定工作目录，按 id 回源补齐。
   * 终态为 null（目录已不存在 / 已被移除）也记一笔，避免 effect 反复请求。
   */
  #resolved = $state<Record<string, Workdir | null>>({});
  #resolving = new Set<string>();
  /** runId -> lease waiting info (holder names the blocking bot). */
  leaseWaiting = $state<
    Record<string, { path: string; holderBotId: string | null; holderConversationId: string | null }>
  >({});
  #started = false;

  /**
   * The bound workdir of a conversation. `workdirs.list` only carries the ten
   * most recently used records, so a conversation bound to an older workdir
   * is looked up by id (`ensure`) instead of rendering 「未设置」.
   */
  boundOf(conversationId: string | null | undefined, workdirId: string | null | undefined): Workdir | null {
    void conversationId;
    if (!workdirId) return null;
    return this.recent.find((p) => p.id === workdirId) ?? this.#resolved[workdirId] ?? null;
  }

  /**
   * Resolves a bound workdir that isn't in `recent` yet (idempotent, safe to
   * call from an effect). Covers bindings older than the recent list and any
   * `workdir.updated` missed before the panel opened.
   */
  ensure(workdirId: string | null | undefined): void {
    if (!workdirId) return;
    if (this.recent.some((p) => p.id === workdirId)) return;
    if (workdirId in this.#resolved || this.#resolving.has(workdirId)) return;
    this.#resolving.add(workdirId);
    void this.#lookup(workdirId);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('workdir.updated', (payload) => {
      const data = payload as { workdir: Workdir };
      this.#upsert(data.workdir);
    });
    core.onEvent('workdir.removed', (payload) => {
      const data = payload as { id: string };
      this.recent = this.recent.filter((p) => p.id !== data.id);
    });
    core.onEvent('lease.waiting', (payload) => {
      const data = payload as {
        runId: string;
        path: string;
        holder: { botId: string | null; conversationId: string | null };
      };
      this.leaseWaiting = {
        ...this.leaseWaiting,
        [data.runId]: {
          path: data.path,
          holderBotId: data.holder.botId,
          holderConversationId: data.holder.conversationId,
        },
      };
    });
    core.onEvent('run.status', (payload) => {
      const data = payload as { run: { id: string; status: string } };
      // D75: a write task waits for its (pinned) lease while still `queued`.
      if (data.run.status !== 'waiting_lease' && data.run.status !== 'queued') {
        const { [data.run.id]: _gone, ...rest } = this.leaseWaiting;
        void _gone;
        if (_gone !== undefined) this.leaseWaiting = rest;
      }
    });
  }

  async refresh(): Promise<void> {
    const result = (await core.call('workdirs.list')) as { workdirs: Workdir[] };
    this.recent = result.workdirs;
  }

  async select(conversationId: string, path: string): Promise<Workdir> {
    try {
      const result = (await core.call('workdirs.select', { conversationId, path })) as {
        workdir: Workdir;
      };
      this.#upsert(result.workdir);
      return result.workdir;
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      throw error;
    }
  }

  /** Opens the system directory picker and returns the chosen path without binding. */
  async pickPath(): Promise<string | null> {
    return window.kepcup.platform.selectDirectory();
  }

  async update(
    id: string,
    patch: { protectRules?: Workdir['protectRules']; allowedPorts?: Workdir['allowedPorts'] },
  ): Promise<void> {
    try {
      const result = (await core.call('workdirs.update', { id, ...patch })) as { workdir: Workdir };
      this.#upsert(result.workdir);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await core.call('workdirs.remove', { id });
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      throw error;
    }
  }

  async revokeLease(conversationId: string): Promise<boolean> {
    try {
      const result = (await core.call('workdirs.revokeLease', { conversationId })) as {
        revoked: boolean;
      };
      return result.revoked;
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  async #lookup(workdirId: string): Promise<void> {
    try {
      const result = (await core.call('workdirs.get', { id: workdirId })) as {
        workdir: Workdir | null;
      };
      if (result.workdir !== null) this.#upsert(result.workdir);
      this.#resolved = { ...this.#resolved, [workdirId]: result.workdir };
    } catch (error) {
      console.warn('[kepcup] workdir lookup failed', { workdirId, error });
      this.#resolved = { ...this.#resolved, [workdirId]: null };
    } finally {
      this.#resolving.delete(workdirId);
    }
  }

  #upsert(workdir: Workdir): void {
    const index = this.recent.findIndex((p) => p.id === workdir.id);
    if (index >= 0) {
      this.recent[index] = workdir;
      this.recent = [...this.recent];
    } else {
      this.recent = [workdir, ...this.recent];
    }
  }
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

export const workdirs = new WorkdirsState();

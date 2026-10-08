import type { Project } from '@kepcup/shared';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { toast } from 'svelte-sonner';

/**
 * P04 client state: recent projects (selector), the bound project of the
 * current conversation and per-run lease-waiting info (status line +
 * force-revoke). Mirrors core events; refetches on conversation switch.
 */
class ProjectsState {
  recent = $state<Project[]>([]);
  /** runId -> lease waiting info (holder names the blocking bot). */
  leaseWaiting = $state<
    Record<string, { path: string; holderBotId: string | null; holderConversationId: string | null }>
  >({});
  #started = false;

  /** The bound project of a conversation, resolved against the recent list. */
  boundOf(conversationId: string | null | undefined, projectId: string | null | undefined): Project | null {
    void conversationId;
    if (!projectId) return null;
    return this.recent.find((p) => p.id === projectId) ?? null;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('project.updated', (payload) => {
      const data = payload as { project: Project };
      this.#upsert(data.project);
    });
    core.onEvent('project.removed', (payload) => {
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
    const result = (await core.call('projects.list')) as { projects: Project[] };
    this.recent = result.projects;
  }

  async select(conversationId: string, path: string): Promise<void> {
    try {
      const result = (await core.call('projects.select', { conversationId, path })) as {
        project: Project;
      };
      this.#upsert(result.project);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      throw error;
    }
  }

  /** Opens the system directory picker, then binds the chosen path. */
  async selectWithDialog(conversationId: string): Promise<void> {
    const path = await window.kepcup.platform.selectDirectory();
    if (path === null) return;
    await this.select(conversationId, path);
  }

  async update(
    id: string,
    patch: { protectRules?: Project['protectRules']; allowedPorts?: Project['allowedPorts'] },
  ): Promise<void> {
    try {
      const result = (await core.call('projects.update', { id, ...patch })) as { project: Project };
      this.#upsert(result.project);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await core.call('projects.remove', { id });
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      throw error;
    }
  }

  async revokeLease(conversationId: string): Promise<boolean> {
    try {
      const result = (await core.call('projects.revokeLease', { conversationId })) as {
        revoked: boolean;
      };
      return result.revoked;
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  #upsert(project: Project): void {
    const index = this.recent.findIndex((p) => p.id === project.id);
    if (index >= 0) {
      this.recent[index] = project;
      this.recent = [...this.recent];
    } else {
      this.recent = [project, ...this.recent];
    }
  }
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

export const projects = new ProjectsState();

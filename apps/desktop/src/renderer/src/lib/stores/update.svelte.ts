import { updateStatusPayloadSchema, type UpdateStatusPayload } from '@kepcup/shared';
import { t } from '$lib/i18n';
import { toast } from 'svelte-sonner';

/**
 * Renderer-side snapshot of the main process's update gate (P13 任务 2).
 * The main process pushes every transition over `update:status`; the initial
 * `updateStatus()` invoke covers transitions that happened before load.
 */
class UpdateState {
  status = $state<UpdateStatusPayload>({ phase: 'idle' });
  /**
   * Message of the most recent `error` phase push (BR-P13-008: the manual
   * check settles event-driven and surfaces it instead of guessing "up to
   * date" from a timer). Cleared before each manual check.
   */
  lastCheckError = $state<string | null>(null);
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void window.kepcup.updateStatus().then((status) => this.#absorb(status));
    window.kepcup.onUpdateStatus((status) => this.#absorb(status));
  }

  #absorb(raw: unknown): void {
    const parsed = updateStatusPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    this.status = parsed.data;
    if (parsed.data.phase === 'error') {
      this.lastCheckError = parsed.data.message ?? '';
    }
  }

  /** User-confirmed install (gate cancels in-flight runs first). */
  async installNow(): Promise<{ ok: boolean; message?: string }> {
    return window.kepcup.installUpdateNow();
  }

  /**
   * Shared apply entry (settings row + sidebar round button): a failed install
   * surfaces as a toast with a View-logs action (BR-P13-008), not just console.
   */
  async applyWithFeedback(
    viewLogs: () => void = () => void window.kepcup.openLogsDir(),
  ): Promise<void> {
    const result = await this.installNow();
    if (!result.ok) {
      toast.error(t('update.installFailed', { reason: result.message ?? '' }), {
        action: { label: t('update.viewLogs'), onClick: viewLogs },
      });
    }
  }

  /** Manual check (settings row / tray); failures are quiet. */
  async checkNow(): Promise<{ ok: boolean; message?: string }> {
    return window.kepcup.checkForUpdate();
  }

  /** BR-P13-002 「继续等待」: re-arms the gate's drain poll (real semantics). */
  async keepWaiting(): Promise<void> {
    await window.kepcup.keepWaitingOnUpdate();
  }
}

export const updateStore = new UpdateState();

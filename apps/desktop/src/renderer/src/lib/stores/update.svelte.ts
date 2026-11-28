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
  /**
   * 全局更新进度卡片的开关（UpdateProgressCard 直接绑定）。卡片实例只有一
   * 份（App 壳层渲染），侧栏圆钮与核心错误页的「检查更新」都指向它—— narrow
   * 布局（无侧栏）下错误页入口也能展开同一张卡。
   */
  progressOpen = $state(false);
  /**
   * 「检查更新后自动展开进度卡片」的待决标记：核心错误页入口先置位再发起
   * 手动检查，卡片的 effect 在首个活动相位（downloading / available-skipped
   * 等）消费它。检查落定但没查到更新时由 checkInteractive 撤回，避免之后
   * 无关的下载被误展开。
   */
  autoOpenRequested = $state(false);
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

  /**
   * 「取消更新」：停下本次下载并跳过该版本（相位守卫在主进程 gate——只有
   * downloading 相位有效；取消后 gate 回 idle，按钮与卡片随之收起。跳过的
   * 版本不再自动下载，但设置页手动检查仍能查到并可手动下载）。
   */
  async cancelDownload(): Promise<void> {
    await window.kepcup.cancelUpdateDownload();
  }

  /**
   * 「下载此版本」：手动检查查到被跳过的版本（available-skipped）后的显式
   * 下载入口——主进程把该版本移出跳过集合并手动启动下载。失败以
   * { ok: false, message } 返回，由调用方提示（BR-P13-008 失败可见）。
   */
  async downloadSkipped(version: string): Promise<{ ok: boolean; message?: string }> {
    return window.kepcup.downloadSkippedUpdate(version);
  }

  /**
   * 「下载此版本」+ 失败 toast（BR-P13-008）：设置行与进度卡片共用。
   */
  async downloadSkippedInteractive(): Promise<void> {
    const result = await this.downloadSkipped(this.status.version ?? '');
    if (!result.ok) {
      toast.error(t('update.downloadFailed', { reason: result.message ?? '' }));
    }
  }

  /**
   * 手动检查（设置行 / 核心错误页共用）：事件驱动 settle（BR-P13-008——
   * checkNow resolve 时本次检查的结果推送已经在渲染层生效，不靠墙钟猜）。
   * 结果以 toast 提示；查到更新时不打扰（autoOpenRequested 的消费在进度卡
   * 片），检查落定但没有可展开的更新流时撤回待展开标记。
   */
  async checkInteractive(): Promise<void> {
    this.lastCheckError = null;
    try {
      const result = await this.checkNow();
      if (!result.ok) {
        toast.error(t('update.checkFailed', { reason: result.message ?? '' }));
      } else if (this.lastCheckError !== null) {
        toast.error(t('update.checkFailed', { reason: this.lastCheckError }));
      } else if (this.status.phase === 'idle') {
        toast.success(t('update.upToDate'));
      }
    } catch (error) {
      toast.error(t('update.checkFailed', { reason: String((error as Error).message ?? '') }));
    }
    if (this.status.phase === 'idle' || this.status.phase === 'error') {
      // 检查落定但没有查到更新（或失败）：撤回待展开标记。
      this.autoOpenRequested = false;
    }
  }
}

export const updateStore = new UpdateState();

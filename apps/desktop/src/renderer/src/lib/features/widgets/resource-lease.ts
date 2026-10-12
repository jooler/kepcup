/**
 * 已挂载 Bot 组件卡的资源租约（D81 审查修复，设计 32 §5）：持有当前 resourceId，
 * 能力桥调用都经 {@link WidgetResourceLease.call} 发出。core 的内存资源有滑动 TTL 与
 * LRU 上限，卡片挂着不动超过 TTL / 被淘汰 / 版本被修剪后，下一次调用会得
 * `WIDGET_RESOURCE_EXPIRED`——租约据此重新 open 换一个新 id 并**重放这次调用**
 * （iframe 不重载、组件内状态不丢），而不是让写入静默失败、卡片还显示「已就绪」。
 *
 * - 并发的过期调用共用一次重开（single-flight）；
 * - 重开失败（组件已删除 / 版本已修剪 / 需要重新审查）只回调一次 `onRenewFailed`，
 *   原调用以原错误失败；
 * - `close()` 之后到达的重开结果交给 `discard` 释放，不会复活租约。
 */
export interface WidgetResourceLeaseOptions {
  resourceId: string;
  /** 重新登记资源（`widgets.ui.open`），返回新的 resourceId。 */
  reopen(): Promise<string>;
  /** 释放一个不再需要的 resourceId（`widgets.ui.close`，租约已关闭时的迟到结果）。 */
  discard(resourceId: string): void;
  /** 重开失败：卡片转错误态。 */
  onRenewFailed(error: unknown): void;
}

export const WIDGET_RESOURCE_EXPIRED_CODE = 'WIDGET_RESOURCE_EXPIRED';

export class WidgetResourceLease {
  readonly #options: WidgetResourceLeaseOptions;
  #resourceId: string;
  #renewing: Promise<string | null> | null = null;
  #closed = false;

  constructor(options: WidgetResourceLeaseOptions) {
    this.#options = options;
    this.#resourceId = options.resourceId;
  }

  get resourceId(): string {
    return this.#resourceId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 带当前 resourceId 发一次调用；资源过期则重开并重放一次。 */
  async call<T>(fn: (resourceId: string) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error('组件界面已关闭');
    const used = this.#resourceId;
    try {
      return await fn(used);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== WIDGET_RESOURCE_EXPIRED_CODE) throw error;
      const renewed = await this.#renew(used);
      if (renewed === null) throw error;
      return fn(renewed);
    }
  }

  /** 关闭租约，返回当前 resourceId（调用方负责 `widgets.ui.close`）；重复关闭返回 null。 */
  close(): string | null {
    if (this.#closed) return null;
    this.#closed = true;
    return this.#resourceId;
  }

  #renew(stale: string): Promise<string | null> {
    // 别的调用已经换过新 id：直接用它。
    if (this.#resourceId !== stale) return Promise.resolve(this.#resourceId);
    if (this.#renewing === null) {
      const pending = this.#reopen();
      this.#renewing = pending;
      void pending.finally(() => {
        if (this.#renewing === pending) this.#renewing = null;
      });
    }
    return this.#renewing;
  }

  async #reopen(): Promise<string | null> {
    try {
      const fresh = await this.#options.reopen();
      if (this.#closed) {
        this.#options.discard(fresh);
        return null;
      }
      this.#resourceId = fresh;
      return fresh;
    } catch (error) {
      if (!this.#closed) this.#options.onRenewFailed(error);
      return null;
    }
  }
}

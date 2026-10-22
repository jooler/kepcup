import type { ShareFailedItem, ShareTarget } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 分享失败恢复（D94 §8.1）的状态与动作。
 *
 * 逻辑放在 store 里（而不是组件里）以便单测：面板只是它的视图。写操作一律
 * 走 core 的 `share.failed.*`——面板不碰文件，也不自己判断该不该重试。
 */
export class ShareRecoveryState {
  items = $state<ShareFailedItem[]>([]);
  loading = $state(false);
  /** 正在处理的批次 id（重试 / 删除中）。 */
  busyId = $state<string | null>(null);
  /** 正在重选目标的批次 id；null = 没有正在重选的。 */
  reselecting = $state<string | null>(null);
  query = $state('');

  #started = false;
  #refreshSeq = 0;

  /** 挂载时订阅 core 事件（分享批次状态变化 → 重拉列表）。 */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('share.failed.changed', () => {
      void this.refresh();
    });
  }

  /** 拉一次失败列表；并发刷新只应用最后一次的结果。 */
  async refresh(): Promise<void> {
    const seq = ++this.#refreshSeq;
    this.loading = true;
    try {
      const result = (await core.call('share.failed.list')) as { items: ShareFailedItem[] };
      if (seq === this.#refreshSeq) this.items = result.items;
    } catch {
      // 拿不到失败列表不该打扰用户（面板本来就是补丁性的入口）。
    } finally {
      if (seq === this.#refreshSeq) this.loading = false;
    }
  }

  /** 重选目标并重试；成功时收起重选块。 */
  async retry(intakeId: string, target: ShareTarget): Promise<'done' | 'failed'> {
    this.busyId = intakeId;
    try {
      const result = (await core.call('share.failed.retry', { intakeId, target })) as {
        state: string;
      };
      if (result.state === 'done') {
        this.reselecting = null;
        this.query = '';
        await this.refresh();
        return 'done';
      }
      await this.refresh();
      return 'failed';
    } catch {
      await this.refresh();
      return 'failed';
    } finally {
      this.busyId = null;
    }
  }

  /** 删除失败批次（行与暂存文件一起删）。 */
  async discard(intakeId: string): Promise<boolean> {
    this.busyId = intakeId;
    try {
      await core.call('share.failed.discard', { intakeId });
      await this.refresh();
      return true;
    } catch {
      return false;
    } finally {
      this.busyId = null;
    }
  }

  /** 打开 / 收起某个批次的重选块。 */
  toggleReselect(intakeId: string): void {
    this.reselecting = this.reselecting === intakeId ? null : intakeId;
    this.query = '';
  }
}

export const shareRecovery = new ShareRecoveryState();

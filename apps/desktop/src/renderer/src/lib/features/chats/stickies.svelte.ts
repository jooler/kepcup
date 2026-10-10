import { newId, type Stickie, type StickiePosition, type StickieScope } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { isStickieVisible } from './stickies';

function logRpcFailure(operation: string, error: unknown): void {
  console.error(`stickies.${operation} failed`, error);
}

/**
 * 便签状态（辅助阅读；行持久化在 main.db stickies）：本地乐观更新即时
 * 上屏，RPC 异步落库（失败只记日志，不影响界面）。拖拽中的位置只改
 * 本地，拖拽结束 / 默认落点回写 / 容器收缩夹取后经 commitPosition 落库。
 * 删除对话时 core 侧随 conversations FK 级联清理，这里监听同一事件修剪
 * 本地缓存。
 */
class StickiesState {
  items = $state<Stickie[]>([]);
  /** z 层号发牌机：新钉与点击置顶都从这里取下一层，保证唯一且单调。 */
  #topZ = 0;
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('conversation.deleted', (payload) => {
      const { id } = payload as { id: string };
      this.items = this.items.filter((stickie) => stickie.conversationId !== id);
    });
  }

  /** 启动水合：恢复已钉便签（z 发牌机接到库里的最大层号之后）。 */
  async load(): Promise<void> {
    this.start();
    const result = (await core.call('stickies.list', {})) as { stickies: Stickie[] };
    this.items = result.stickies;
    this.#topZ = this.items.reduce((max, stickie) => Math.max(max, stickie.z), 0);
  }

  pin(text: string, conversationId: string, scope: StickieScope): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // 时间戳仅本地展示用，落库值以 create 返回行为准。
    const now = Date.now();
    const stickie: Stickie = {
      id: newId('stc'),
      text: trimmed,
      scope,
      conversationId,
      position: null,
      z: ++this.#topZ,
      createdAt: now,
      updatedAt: now,
    };
    this.items = [...this.items, stickie];
    void core
      .call('stickies.create', {
        // id 随 create 落库：后续 update/delete 都按本地同一个 id 定位。
        id: stickie.id,
        conversationId,
        text: trimmed,
        scope,
        position: null,
        z: stickie.z,
      })
      .catch((error: unknown) => logRpcFailure('create', error));
  }

  remove(id: string): void {
    this.items = this.items.filter((stickie) => stickie.id !== id);
    void core
      .call('stickies.delete', { id })
      .catch((error: unknown) => logRpcFailure('delete', error));
  }

  /** 点击置顶：z 取下一层号；已是顶层时跳过（避免无谓的重写）。 */
  bringToFront(id: string): void {
    const target = this.items.find((stickie) => stickie.id === id);
    if (target === undefined || target.z === this.#topZ) return;
    const z = ++this.#topZ;
    this.items = this.items.map((stickie) => (stickie.id === id ? { ...stickie, z } : stickie));
    void core
      .call('stickies.update', { id, z })
      .catch((error: unknown) => logRpcFailure('update', error));
  }

  /** 便签上直接改作用域：local → global，或 global → 回到来源对话。 */
  setScope(id: string, scope: StickieScope): void {
    this.items = this.items.map((stickie) => (stickie.id === id ? { ...stickie, scope } : stickie));
    void core
      .call('stickies.update', { id, scope })
      .catch((error: unknown) => logRpcFailure('update', error));
  }

  /** 拖拽中的即时位置：只改本地（高频），落库走 commitPosition。 */
  moveTo(id: string, position: StickiePosition): void {
    this.items = this.items.map((stickie) =>
      stickie.id === id ? { ...stickie, position } : stickie,
    );
  }

  /** 位置落库（拖拽结束、默认落点回写、容器收缩夹取后调用）。 */
  commitPosition(id: string): void {
    const stickie = this.items.find((entry) => entry.id === id);
    if (stickie === undefined || stickie.position === null) return;
    void core
      .call('stickies.update', { id, position: stickie.position })
      .catch((error: unknown) => logRpcFailure('update', error));
  }

  visibleIn(conversationId: string): Stickie[] {
    return this.items.filter((stickie) => isStickieVisible(stickie, conversationId));
  }
}

export const stickies = new StickiesState();

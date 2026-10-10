import { APP_STEP_UP_WINDOW_MS, type SetupRequirement } from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';

/** 受 step-up 限流约束的需求所属的连接 id：`reason: 'scope'` 且指明连接的 `connect-app`；其余 null。 */
export function stepUpConnectionOf(requirement: SetupRequirement): string | null {
  return requirement.kind === 'connect-app' &&
    requirement.reason === 'scope' &&
    requirement.connectionId !== undefined
    ? requirement.connectionId
    : null;
}

/**
 * 权限追加（step-up）限流（D73 P2 §6.1，design 29 §5.4）：以（对话, 连接）为键，
 * {@link APP_STEP_UP_WINDOW_MS} 窗口内至多放出 1 张 step-up 卡；超出的请求由调用方改成
 * 普通失败文本（不出 SETUP_REQUIRED、不出卡）。
 *
 * 名额在卡片真正随 run 一起发出时才占用（`tryAcquire`）；工具调用当下只用 `isAvailable`
 * 检查——同一次 run 里多个连接各自要求追加权限、最终只有一个需求胜出（后写覆盖），
 * 落选的不该白白烧掉名额。
 *
 * 为什么按（对话, 连接）而不是按 run：用户确认后的 `runs.retry` 会产生新 run，按 run 计数
 * 会被绕过——一个不断要求更多权限的服务端就能让卡片无限弹出。进程内 Map 即可，重启清零可接受。
 */
export class AppStepUpLimiter {
  readonly #clock: Clock;
  readonly #windowMs: number;
  /** key → 上一张 step-up 卡放出的时间。 */
  readonly #issuedAt = new Map<string, number>();

  constructor(clock: Clock, windowMs: number = APP_STEP_UP_WINDOW_MS) {
    this.#clock = clock;
    this.#windowMs = windowMs;
  }

  static keyOf(conversationId: string | null, connectionId: string): string {
    return `${conversationId ?? ''}\u0000${connectionId}`;
  }

  /** 窗口内是否还能放出一张卡（不占用名额）：工具调用时用它决定「出卡 / 普通失败」。 */
  isAvailable(conversationId: string | null, connectionId: string): boolean {
    const last = this.#issuedAt.get(AppStepUpLimiter.keyOf(conversationId, connectionId));
    return last === undefined || this.#clock.now() - last >= this.#windowMs;
  }

  /**
   * 申请放出一张 step-up 卡：窗口内还没放过 → 记下并返回 true；否则 false（不改变记录，
   * 窗口从第一张卡算起，不会因被拒绝的请求而顺延）。
   */
  tryAcquire(conversationId: string | null, connectionId: string): boolean {
    const now = this.#clock.now();
    this.#prune(now);
    const key = AppStepUpLimiter.keyOf(conversationId, connectionId);
    const last = this.#issuedAt.get(key);
    if (last !== undefined && now - last < this.#windowMs) return false;
    this.#issuedAt.set(key, now);
    return true;
  }

  /** 窗口外的记录没有意义，顺手清掉（Map 不会无限增长）。 */
  #prune(now: number): void {
    for (const [key, at] of this.#issuedAt) {
      if (now - at >= this.#windowMs) this.#issuedAt.delete(key);
    }
  }
}

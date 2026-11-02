import type { ImAccountRecord } from './store.js';
import { ILinkSessionExpiredError, type ILinkClient, type ILinkMessage } from './ilink.js';

/**
 * 每个账号至多一条长轮询会话（D109，54 号文档 §5）。宿主确定性轮询，Bot 禁止
 * 自行收信（同 D84 收信立场）。断开按指数退避重连；iLink `-14` 触发一小时会话
 * 暂停（status='paused'，定时自动重试，连续多轮仍失效转 auth_failed 等重扫）。
 */

/** 连上（长轮询正常返回）后很快又失败的判定阈值，与 mail 同口径。 */
const STABLE_LOOP_MS = 30_000;
/** -14 暂停时长（协议行为，54 §4）。 */
const SESSION_PAUSE_MS = 60 * 60 * 1000;
/** 连续多少轮 -14 暂停后判定 token 失效（等用户重扫）。 */
const MAX_EXPIRED_CYCLES = 3;

export interface ImSessionHubDeps {
  load: (accountId: string) => ImAccountRecord | null;
  token: (accountId: string) => string | null;
  saveCursor: (accountId: string, cursor: string) => void;
  /** 长轮询正常返回（含空批）：连接就绪。 */
  onReady: (accountId: string) => void;
  onMessages: (accountId: string, messages: ILinkMessage[]) => void;
  /** 一般失败（退避重连）；streak 从 1 计。 */
  onFailure: (accountId: string, error: string, streak: number) => void;
  /** 会话失效（-14）：本调用方已置 paused，一小时后由 hub 自动重试。 */
  onSessionExpired: (accountId: string) => void;
  /** 连续多轮 -14：token 失效，等用户重扫（status='auth_failed'，停止自动重试）。 */
  onAuthFailed: (accountId: string) => void;
  /** 会话实现（每账号一个客户端：transport 隔离点实例化）。 */
  openClient: (account: ImAccountRecord) => ILinkClient;
  /** 测试注入：缩短退避 / 暂停。 */
  backoffMs?: (streak: number) => number;
  sessionPauseMs?: number | undefined;
}

interface LoopState {
  generation: number;
  tick: AbortController;
  streak: number;
  readyAt: number | null;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
}

export class ImSessionHub {
  readonly #deps: ImSessionHubDeps;
  readonly #loops = new Map<string, LoopState>();
  /**
   * 跨重启累计的连续 -14 次数（按账号）：暂停后自动重启会换新 LoopState，
   * 计数放在 loop 里会被清零——失效 token 会永远每小时重试而不转 auth_failed。
   * 长轮询正常返回（onReady）即视为会话恢复，清零。
   */
  readonly #expiredCycles = new Map<string, number>();
  #stopped = false;

  constructor(deps: ImSessionHubDeps) {
    this.#deps = deps;
  }

  startAll(accounts: readonly ImAccountRecord[]): void {
    for (const account of accounts) {
      // auth_failed 等用户重扫（materializer update 重跑）；paused 由暂停定时器接管。
      if (account.status !== 'auth_failed') this.start(account.id);
    }
  }

  start(accountId: string): void {
    if (this.#stopped) return;
    this.stop(accountId);
    const state: LoopState = {
      generation: (this.#loops.get(accountId)?.generation ?? 0) + 1,
      tick: new AbortController(),
      streak: 0,
      readyAt: null,
      pauseTimer: null,
      done: Promise.resolve(),
    };
    this.#loops.set(accountId, state);
    state.done = this.#run(accountId, state);
  }

  stop(accountId: string): void {
    const state = this.#loops.get(accountId);
    if (state === undefined) return;
    state.generation += 1;
    state.tick.abort();
    if (state.pauseTimer !== null) clearTimeout(state.pauseTimer);
    this.#loops.delete(accountId);
  }

  stopAll(): void {
    this.#stopped = true;
    for (const accountId of [...this.#loops.keys()]) this.stop(accountId);
  }

  /** 休眠恢复或游标推进：打断当前等待，立刻补拉。 */
  wake(accountId?: string): void {
    const ids = accountId !== undefined ? [accountId] : [...this.#loops.keys()];
    for (const id of ids) {
      this.#loops.get(id)?.tick.abort();
    }
  }

  async #run(accountId: string, state: LoopState): Promise<void> {
    const generation = state.generation;
    const backoff = this.#deps.backoffMs;
    while (this.#alive(accountId, state, generation)) {
      state.readyAt = null;
      const account = this.#deps.load(accountId);
      if (account === null) return;
      const token = this.#deps.token(accountId);
      if (token === null) {
        // 无 token（secrets 已被清）：等用户重扫，不再空转。
        this.#deps.onAuthFailed(accountId);
        return;
      }
      const client = this.#deps.openClient(account);
      try {
        await client.notify(token, 'start');
        while (this.#alive(accountId, state, generation)) {
          const current = this.#deps.load(accountId);
          if (current === null) return;
          let batch: { cursor: string; msgs: ILinkMessage[] } | null = null;
          try {
            batch = await client.getUpdates(token, readCursor(current));
          } catch (error) {
            if (error instanceof ILinkSessionExpiredError) throw error;
            // 长轮询被打断（stop / wake）：静默回到外层判断存活。
            if (state.tick.signal.aborted) break;
            throw error;
          }
          if (!this.#alive(accountId, state, generation)) return;
          if (batch === null) continue; // 被打断（stop / wake）：回到外层判断存活。
          state.streak = 0;
          this.#expiredCycles.delete(accountId);
          if (state.readyAt === null) state.readyAt = Date.now();
          if (batch.cursor !== readCursor(current)) {
            this.#deps.saveCursor(accountId, batch.cursor);
          }
          this.#deps.onReady(accountId);
          if (batch.msgs.length > 0) this.#deps.onMessages(accountId, batch.msgs);
        }
        // aborted：外层 while 判定存活后按需重启。
      } catch (error) {
        if (!this.#alive(accountId, state, generation)) return;
        if (error instanceof ILinkSessionExpiredError) {
          const expiredCycles = (this.#expiredCycles.get(accountId) ?? 0) + 1;
          this.#expiredCycles.set(accountId, expiredCycles);
          if (expiredCycles >= MAX_EXPIRED_CYCLES) {
            this.#expiredCycles.delete(accountId);
            this.#deps.onAuthFailed(accountId);
            return;
          }
          this.#deps.onSessionExpired(accountId);
          // 一小时后自动重试一次（协议的一小时暂停）。
          const pauseMs = this.#deps.sessionPauseMs ?? SESSION_PAUSE_MS;
          const timer = setTimeout(() => {
            if (this.#alive(accountId, state, generation)) this.start(accountId);
          }, pauseMs);
          timer.unref?.();
          state.pauseTimer = timer;
          return;
        }
        state.streak += 1;
        const lasted = state.readyAt === null ? null : Date.now() - state.readyAt;
        // 抖动放大退避：稳定运行过则回到 1 秒起。
        const effectiveStreak = lasted !== null && lasted >= STABLE_LOOP_MS ? 1 : state.streak;
        const message = error instanceof Error ? error.message : String(error);
        this.#deps.onFailure(accountId, message, effectiveStreak);
        if (state.tick.signal.aborted) state.tick = new AbortController();
        await delay((backoff ?? defaultBackoff)(effectiveStreak), state.tick.signal);
      }
      if (state.tick.signal.aborted && this.#alive(accountId, state, generation)) {
        state.tick = new AbortController();
      }
    }
  }

  #alive(accountId: string, state: LoopState, generation: number): boolean {
    return !this.#stopped && this.#loops.get(accountId) === state && state.generation === generation;
  }
}

/** 账号 config_json 里的 getUpdates 游标（非敏感元数据，54 §3）。 */
export function readCursor(account: ImAccountRecord): string {
  try {
    const config = JSON.parse(account.configJson) as { cursor?: unknown };
    return typeof config.cursor === 'string' ? config.cursor : '';
  } catch {
    return '';
  }
}

function defaultBackoff(streak: number): number {
  const shift = Math.min(10, Math.max(0, streak - 1));
  return Math.min(15 * 60 * 1000, 1000 * 2 ** shift);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

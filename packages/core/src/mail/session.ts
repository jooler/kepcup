import type { MailListen } from '@kepcup/shared';
import { AppError, resolveMailListen } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import { classifyMailAuthFailure, MAX_AUTH_LIKE_FAILURES } from './errors.js';
import type { FetchedMail, MailImap, MailImapOpener, MailboxState } from './message.js';
import { mailBackoffMs } from './store.js';
import type { MailAccountRecord } from './store.js';

/**
 * 每个账号至多一条 IMAP 连接（D84 §3 / §4.2）。
 *
 * auto 且服务器有 IDLE → IDLE，约 9 分钟主动重入；否则在同一条连接上按间隔
 * NOOP + UID 搜索。断开后指数退避重连，从 UID 游标补洞。工具调用打断 IDLE，
 * 用完再回到收信循环，避免再开一条连接（163 忌频繁新建连接）。
 *
 * IDLE 与 mail_* 共用 `#locked` 的 gate 串行，保证不会在 IDLE 未 DONE 时发命令。
 * 有工具调用在排队（`waiting`）时主循环不进 IDLE，否则后到的调用会被 IDLE 卡到超时。
 *
 * 失败分两种：一般错误按指数退避重连；凭据被拒（认证失败）停止重试并等用户更新授权码
 * ——继续试只会把 163/QQ 的账号试到限流或锁定。
 */

/** 连上后不到这么久就又掉线，视为抖动：退避继续往上走，不因为「连上过」而回到 1 秒。 */
const STABLE_CONNECTION_MS = 30_000;

export interface MailFailureInfo {
  /** 凭据被拒：会话循环已经停止，不会再重试，需要用户更新授权码后重启。 */
  fatal: boolean;
}

export interface MailSessionHubDeps {
  open: MailImapOpener;
  load: (accountId: string) => MailAccountRecord | null;
  password: (accountId: string) => string | null;
  /** SELECT 成功、连接真正就绪。UIDVALIDITY 校验与首次基线都在这里做（先于补拉）。 */
  onReady: (accountId: string, listen: MailListen, mailbox: MailboxState) => void;
  onMessages: (accountId: string, messages: FetchedMail[]) => void;
  onFailure: (accountId: string, error: string, streak: number, info: MailFailureInfo) => void;
  logger: CoreLogger;
  /** 测试注入：缩短退避。默认 {@link mailBackoffMs}。 */
  backoffMs?: (streak: number) => number;
}

interface LoopState {
  generation: number;
  client: MailImap | null;
  tick: AbortController;
  /** Serialises tool commands with the IDLE/poll loop (one IMAP connection). */
  gate: Promise<void>;
  /** 排队或执行中的 use()。大于 0 时主循环不进 IDLE。 */
  waiting: number;
  /** 连续失败次数；连接真正就绪（SELECT 成功）时清零。 */
  streak: number;
  /** 就绪后不久就掉线的次数，只用来放大退避，不影响对外的 streak。 */
  flaps: number;
  /** 连续的认证类失败（含限流措辞的模糊拒绝）；连接就绪时清零。到上限就不再重试。 */
  authLike: number;
  readyAt: number | null;
  done: Promise<void>;
}

export class MailSessionHub {
  readonly #deps: MailSessionHubDeps;
  readonly #loops = new Map<string, LoopState>();
  #stopped = false;

  constructor(deps: MailSessionHubDeps) {
    this.#deps = deps;
  }

  startAll(accounts: readonly MailAccountRecord[]): void {
    for (const account of accounts) {
      if (account.status !== 'paused') this.start(account.id);
    }
  }

  start(accountId: string): void {
    if (this.#stopped) return;
    this.stop(accountId);
    const state: LoopState = {
      generation: (this.#loops.get(accountId)?.generation ?? 0) + 1,
      client: null,
      tick: new AbortController(),
      gate: Promise.resolve(),
      waiting: 0,
      streak: 0,
      flaps: 0,
      authLike: 0,
      readyAt: null,
      done: Promise.resolve(),
    };
    // stop() above may have cleared a previous loop; write the new one after.
    this.#loops.set(accountId, state);
    state.done = this.#run(accountId, state);
  }

  /** 配置变更：丢掉当前连接，按新模式重连。 */
  restart(accountId: string): void {
    const account = this.#deps.load(accountId);
    if (account === null || account.status === 'paused' || account.deletedAt !== null) {
      this.stop(accountId);
      return;
    }
    this.start(accountId);
  }

  stop(accountId: string): void {
    const state = this.#loops.get(accountId);
    if (state === undefined) return;
    state.generation += 1;
    state.tick.abort();
    const client = state.client;
    state.client = null;
    this.#loops.delete(accountId);
    if (client !== null) void client.close().catch(() => undefined);
  }

  stopAll(): void {
    this.#stopped = true;
    for (const accountId of [...this.#loops.keys()]) this.stop(accountId);
  }

  /** 休眠恢复或测试：打断当前等待，立刻补拉。 */
  wake(accountId?: string): void {
    const ids = accountId !== undefined ? [accountId] : [...this.#loops.keys()];
    for (const id of ids) {
      const state = this.#loops.get(id);
      if (state === undefined) continue;
      this.#interrupt(state);
    }
  }

  /**
   * 在该账号的连接上执行一条命令。没有活连接时（暂停、尚未连上）另开短连接。
   * 出口钉死在 openImapflow 内完成，这里不再单独 assert（避免二次解析窗口）。
   */
  async use<T>(account: MailAccountRecord, fn: (client: MailImap) => Promise<T>): Promise<T> {
    const state = this.#loops.get(account.id);
    const live = state?.client ?? null;
    if (state !== undefined && live !== null) {
      // 先登记再打断：主循环排在 gate 里的 IDLE 开始前会看到 waiting，不会把这次调用堵在 IDLE 后面。
      state.waiting += 1;
      this.wake(account.id);
      return await this.#locked(state, async () => {
        try {
          return await fn(live);
        } finally {
          state.waiting -= 1;
        }
      });
    }
    const password = this.#deps.password(account.id);
    if (password === null) {
      throw new Error('邮箱授权码不存在');
    }
    const client = await this.#deps.open({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      username: account.username,
      password,
    });
    try {
      await client.selectInbox();
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async #run(accountId: string, state: LoopState): Promise<void> {
    const generation = state.generation;
    const backoff = this.#deps.backoffMs ?? mailBackoffMs;
    while (this.#alive(accountId, state, generation)) {
      state.readyAt = null;
      try {
        const outcome = await this.#connect(accountId, state, generation);
        // 账号没了或已暂停：没有可连的东西，别空转。
        if (outcome === 'ended') return;
      } catch (error) {
        if (!this.#alive(accountId, state, generation)) return;
        const authClass = classifyMailAuthFailure(error);
        state.authLike = authClass === null ? 0 : state.authLike + 1;
        const fatal = authClass === 'auth' || state.authLike >= MAX_AUTH_LIKE_FAILURES;
        state.streak += 1;
        // 没连上（lasted===null）不动 flaps：否则「就绪后秒掉」之后夹一次连接失败就把惩罚清零，
        // 抖动的服务器会被持续快速重连。只有稳定连接超过阈值后才清零。
        const lasted = state.readyAt === null ? null : Date.now() - state.readyAt;
        if (lasted !== null) {
          state.flaps = lasted < STABLE_CONNECTION_MS ? state.flaps + 1 : 0;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.#deps.logger.info({ accountId, streak: state.streak, fatal, error: message }, 'mail session failed');
        this.#deps.onFailure(accountId, message, state.streak, { fatal });
        if (fatal) return;
        // onError/wake 可能在补拉期间 abort 了 tick；退避必须用新信号，否则会立刻返回、跳过退避。
        if (state.tick.signal.aborted) state.tick = new AbortController();
        await delay(backoff(state.streak + state.flaps), state.tick.signal);
      }
    }
  }

  async #connect(
    accountId: string,
    state: LoopState,
    generation: number,
  ): Promise<'ended' | 'reconnect'> {
    const alive = (): boolean => this.#alive(accountId, state, generation);
    const account = this.#deps.load(accountId);
    if (account === null || account.status === 'paused') return 'ended';
    const password = this.#deps.password(accountId);
    if (password === null) throw new AppError('MAIL_AUTH_FAILED', '邮箱授权码不存在');
    const client = await this.#deps.open({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      username: account.username,
      password,
    });
    if (!alive()) {
      await client.close().catch(() => undefined);
      return 'ended';
    }
    // 连接级错误（库在空闲时 emit 的 error）：记下并打断当前等待，让循环立刻走重连，而不是睡到下次轮询。
    let failure: Error | null = null;
    const unsubscribe = client.onError((error) => {
      failure ??= error;
      this.#interrupt(state);
    });
    const checkFailure = (): void => {
      if (failure !== null) throw failure;
    };
    try {
      const listen = resolveMailListen(account.mode, client.capabilities);
      const box = await client.selectInbox();
      checkFailure();
      // 连接建立期间被暂停 / 删除 / 重启：迟到的就绪回调不能再把状态改回 running。
      if (!alive()) return 'ended';
      // SELECT 完成后才对工具调用可见：此前 use() 在这条连接上发 SEARCH 会撞上还没选中邮箱。
      state.client = client;
      state.streak = 0;
      state.authLike = 0;
      state.readyAt = Date.now();
      this.#deps.onReady(accountId, listen, box);
      while (alive()) {
        const current = this.#deps.load(accountId);
        if (current === null || current.status === 'paused') return 'ended';
        if (resolveMailListen(current.mode, client.capabilities) !== listen) return 'reconnect';
        await this.#locked(state, () => this.#catchUp(accountId, client, alive));
        checkFailure();
        if (!alive()) return 'ended';
        if (listen === 'idle') {
          const result = await this.#locked(state, async () => {
            // 有工具调用在排队：让它们先走，别把它们堵在 IDLE 后面。
            if (state.waiting > 0) return 'timeout' as const;
            return await client.idle(state.tick.signal);
          });
          checkFailure();
          if (result === 'close') throw new Error('IMAP 连接已断开');
          // 被 wake 打断后换一个新的等待信号，否则下一次 idle 会立刻返回。
          if (state.tick.signal.aborted && alive()) state.tick = new AbortController();
        } else {
          await delay(current.pollIntervalSec * 1000, state.tick.signal);
          if (state.tick.signal.aborted && alive()) state.tick = new AbortController();
          checkFailure();
          if (!alive()) return 'ended';
          await this.#locked(state, () => client.noop());
        }
      }
      return 'ended';
    } finally {
      unsubscribe();
      if (state.client === client) state.client = null;
      await client.close().catch(() => undefined);
    }
  }

  /** 补拉 lastUid 之后的新信。每一批取完立刻入库（游标逐批前进），入库前都确认会话还活着。 */
  async #catchUp(accountId: string, client: MailImap, alive: () => boolean): Promise<void> {
    const account = this.#deps.load(accountId);
    if (account === null || account.lastUid === null) return;
    const uids = (await client.search({ minUid: account.lastUid + 1 }))
      .filter((uid) => uid > (account.lastUid ?? 0))
      .sort((left, right) => left - right);
    for (let index = 0; index < uids.length; index += 20) {
      if (!alive()) return;
      const batch = await client.fetch(uids.slice(index, index + 20), true);
      // 停止 / 暂停 / 重启之后抓回来的信不再入库、不再产生提醒；游标不动，下一轮会话会重新补拉。
      if (!alive()) return;
      if (batch.length > 0) this.#deps.onMessages(accountId, batch);
    }
  }

  /**
   * 打断当前等待（IDLE / 轮询间隔 / 退避）。
   * 只 abort，不在这里换新的 AbortController——换新会丢掉「补拉和 delay/idle 之间」到达的 wake：
   * 轮询间隔常是几十分钟，丢掉一次就表现为新信一直不来（macOS CI 上 UIDVALIDITY 用例因此挂过）。
   * 等在 signal 上的一方在返回后自行 `state.tick = new AbortController()`。
   */
  #interrupt(state: LoopState): void {
    state.tick.abort();
  }

  #locked<T>(state: LoopState, fn: () => Promise<T>): Promise<T> {
    const run = state.gate.then(fn, fn);
    state.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #alive(accountId: string, state: LoopState, generation: number): boolean {
    return !this.#stopped && this.#loops.get(accountId) === state && state.generation === generation;
  }
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

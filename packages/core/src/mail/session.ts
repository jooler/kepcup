import type { MailListen } from '@kepcup/shared';
import { resolveMailListen } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { FetchedMail, MailImap, MailImapOpener } from './message.js';
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
 */

export interface MailSessionHubDeps {
  open: MailImapOpener;
  load: (accountId: string) => MailAccountRecord | null;
  password: (accountId: string) => string | null;
  onReady: (accountId: string, listen: MailListen, unseen: number | null) => void;
  onBaseline: (accountId: string, uid: number, unseen: number | null) => void;
  onMessages: (accountId: string, messages: FetchedMail[]) => void;
  onFailure: (accountId: string, error: string, streak: number) => void;
  logger: CoreLogger;
}

interface LoopState {
  generation: number;
  client: MailImap | null;
  tick: AbortController;
  /** Serialises tool commands with the IDLE/poll loop (one IMAP connection). */
  gate: Promise<void>;
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
      state.tick.abort();
      state.tick = new AbortController();
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
      this.wake(account.id);
      return await this.#locked(state, () => fn(live));
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
    let streak = 0;
    while (this.#alive(accountId, state, generation)) {
      try {
        await this.#connect(accountId, state, generation);
        streak = 0;
        if (!this.#alive(accountId, state, generation)) return;
      } catch (error) {
        if (!this.#alive(accountId, state, generation)) return;
        streak += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.#deps.logger.info({ accountId, streak, error: message }, 'mail session failed');
        this.#deps.onFailure(accountId, message, streak);
        await delay(mailBackoffMs(streak), state.tick.signal);
      }
    }
  }

  async #connect(accountId: string, state: LoopState, generation: number): Promise<void> {
    const account = this.#deps.load(accountId);
    if (account === null || account.status === 'paused') return;
    const password = this.#deps.password(accountId);
    if (password === null) throw new Error('邮箱授权码不存在');
    const client = await this.#deps.open({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      username: account.username,
      password,
    });
    if (!this.#alive(accountId, state, generation)) {
      await client.close().catch(() => undefined);
      return;
    }
    state.client = client;
    try {
      const listen = resolveMailListen(account.mode, client.capabilities);
      const box = await client.selectInbox();
      this.#deps.onReady(accountId, listen, box.unseen);
      const opened = this.#deps.load(accountId);
      if (opened !== null && opened.lastUid === null) {
        this.#deps.onBaseline(accountId, Math.max(0, box.uidNext - 1), box.unseen);
      }
      while (this.#alive(accountId, state, generation)) {
        const current = this.#deps.load(accountId);
        if (current === null || current.status === 'paused') return;
        if (resolveMailListen(current.mode, client.capabilities) !== listen) return;
        await this.#locked(state, () => this.#catchUp(accountId, client));
        if (!this.#alive(accountId, state, generation)) return;
        if (listen === 'idle') {
          const result = await this.#locked(state, () => client.idle(state.tick.signal));
          if (result === 'close') throw new Error('IMAP 连接已断开');
          // 被 wake 打断后换一个新的等待信号，否则下一次 idle 会立刻返回。
          if (state.tick.signal.aborted && this.#alive(accountId, state, generation)) {
            state.tick = new AbortController();
          }
        } else {
          await delay(current.pollIntervalSec * 1000, state.tick.signal);
          if (state.tick.signal.aborted && this.#alive(accountId, state, generation)) {
            state.tick = new AbortController();
          }
          if (!this.#alive(accountId, state, generation)) return;
          await this.#locked(state, () => client.noop());
        }
      }
    } finally {
      if (state.client === client) state.client = null;
      await client.close().catch(() => undefined);
    }
  }

  async #catchUp(accountId: string, client: MailImap): Promise<void> {
    const account = this.#deps.load(accountId);
    if (account === null || account.lastUid === null) return;
    const uids = (await client.search({ minUid: account.lastUid + 1 }))
      .filter((uid) => uid > (account.lastUid ?? 0))
      .sort((left, right) => left - right);
    if (uids.length === 0) return;
    const messages: FetchedMail[] = [];
    for (let index = 0; index < uids.length; index += 20) {
      messages.push(...(await client.fetch(uids.slice(index, index + 20), true)));
    }
    if (messages.length > 0) this.#deps.onMessages(accountId, messages);
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

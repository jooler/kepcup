import { AppError } from '@kepcup/shared';

/** 等锁的上限：超过就报错，不让一条卡住的写路径拖住所有设置写入。 */
export const SETTINGS_WRITE_LOCK_WAIT_MS = 10_000;

/**
 * core 的设置写锁（todo/conversational-app-setup.md §4.1「在 core 的设置写锁内读 → 只比对并改
 * 本条目的字段 → 写回」）。
 *
 * 锁里只放「读 → 比对 → 合并 → 写」这段同步的关键区：设置页的 `settings.update` 与目录适配器的
 * 条目写入 / 撤销都在这里串行；网络副作用（MCP 断连、撤销授权）一律在锁外做，锁不跨网络等待。
 * 等锁有上限（{@link SETTINGS_WRITE_LOCK_WAIT_MS}）：超时的调用以 TIMEOUT 失败、它的任务不再执行；
 * 后面的调用仍按顺序排队。
 *
 * 只是进程内的 promise 链互斥：不跨进程（core 只有一个进程），不可重入（锁内不要再取锁）。
 */
export class SettingsWriteLock {
  #tail: Promise<void> = Promise.resolve();
  readonly #waitMs: number;

  constructor(options: { waitMs?: number } = {}) {
    this.#waitMs = options.waitMs ?? SETTINGS_WRITE_LOCK_WAIT_MS;
  }

  /** 排队执行 `task`；前一个任务失败不影响后一个。等锁超时 → AppError('TIMEOUT')。 */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const previous = this.#tail;
    let releaseTail!: () => void;
    // 队尾 = 本任务真正结束（或因超时被跳过）；超时的调用方先返回，但不让后来者越过仍在执行的任务。
    this.#tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new AppError('TIMEOUT', '设置正在被其他操作写入，暂时无法保存，请稍后再试'));
      }, this.#waitMs);
      timer.unref?.();
      void previous.then(async () => {
        clearTimeout(timer);
        if (timedOut) {
          releaseTail();
          return;
        }
        try {
          resolve(await task());
        } catch (error) {
          reject(error as Error);
        } finally {
          releaseTail();
        }
      });
    });
  }
}

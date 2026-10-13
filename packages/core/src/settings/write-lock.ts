/**
 * core 的设置写锁（todo/conversational-app-setup.md §4.1「在 core 的设置写锁内读 → 只比对并改
 * 本条目的字段 → 写回」）。
 *
 * `SettingsService.update` 本身是同步的「读整行 → 合并顶层键 → 写回」，单线程下不会被打断；
 * 但 `settings.update` RPC 在读取旧值与写回之间有 await（MCP 断连、撤销授权），条目适配器的
 * CAS 若落在这个窗口里，就可能读到「旧值」、而随后被 RPC 拿旧快照写回的顶层键覆盖。所以两条
 * 写路径（设置页的 `settings.update`、目录适配器的条目写入 / 撤销）都在这把锁里串行执行。
 *
 * 只是进程内的 promise 链互斥：不跨进程（core 只有一个进程），不可重入（锁内不要再取锁）。
 */
export class SettingsWriteLock {
  #tail: Promise<unknown> = Promise.resolve();

  /** 排队执行 `task`；前一个任务失败不影响后一个。 */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

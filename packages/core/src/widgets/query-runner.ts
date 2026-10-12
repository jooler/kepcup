import { spawn, type ChildProcess, type Serializable } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  AppError,
  BOT_WIDGET_QUERIES_MAX,
  BOT_WIDGET_QUERY_MEMORY_MAX_BYTES,
  BOT_WIDGET_QUERY_QUEUE_MAX,
  BOT_WIDGET_QUERY_TIMEOUT_MS,
  type WidgetsUiQueryOutput,
} from '@kepcup/shared';
import { unpackedAsarPath } from '../infra/asar-path.js';
import { WIDGET_QUERY_DENIED_OPCODES } from './query-gate.js';

/**
 * 组件查询的执行边界（D81 审查修复，设计 32 §6.1）：模板 SQL 不在 core 的主库连接上
 * 跑，而是在一个**独立子进程**（本运行时以 `ELECTRON_RUN_AS_NODE=1` 起的 Node）里，
 * 用只读方式（`readonly` + `PRAGMA query_only=ON`）另开一条到同一 main.db 的连接执行。
 *
 * 为什么是子进程而不是 worker_threads：better-sqlite3 同步执行、编译时去掉了进度回调
 * （SQLITE_OMIT_PROGRESS_CALLBACK），也不暴露 sqlite3_interrupt——一条卡在原生
 * sqlite3_step 里的 `WITH RECURSIVE … count(*)` 不会回到 JS，`worker.terminate()`
 * 永远不 resolve（实测连 `process.exit` 都会被这个线程拖住）。只有进程边界能真正
 * 止损：超时 / 内存超限即 SIGKILL，排队的下一条查询再起新进程。
 *
 * 子进程常驻、串行执行（单连接），空闲一段时间后自行退出；每条查询前按卡片作用域
 * 在 temp schema 里重建作用域视图，再做物理闸（EXPLAIN 的 OpenRead rootpage →
 * sqlite_schema 表名 ∈ 白名单），然后迭代取行（行数 / 回执字节上限）。
 *
 * 公平性（第二轮审查修复）：子进程是所有组件共用的串行资源，一个恶意组件并发灌满
 * 递归 CTE（每条 3s 超时才杀、再重起进程）不能把别人的查询拖死——
 * - 排队按**归属**（`job.owner` = widgetId）分桶，派活取「最久没被服务」的归属
 *   （轮转），别的组件的查询最多等当前这条 + 一条；
 * - 每个归属同时（排队 + 执行中）至多 {@link WidgetQueryRunnerOptions.perOwnerMax} 条，
 *   超出立即 `WIDGET_RATE_LIMITED`（全局 `queueMax` 只是兜底）；
 * - 同一归属**连续**超时 / 内存超限达到 {@link WidgetQueryRunnerOptions.breakerStrikes}
 *   次即熔断 `breakerCooldownMs`：它排队中的查询立即失败，冷却期内新查询直接拒绝；
 *   冷却后首条再超时立即重新熔断（半开），成功一次才清零。
 */

export interface WidgetQueryJob {
  /** 公平性 / 熔断的归属键（服务层传 widgetId：同一组件的多个资源共用额度）。 */
  owner: string;
  sql: string;
  params: Record<string, string | number | bigint | null>;
  /** 本次查询的作用域视图（temp schema，按卡片作用域实例化）。 */
  views: Array<{ name: string; select: string }>;
  /** 视图展开后允许 OpenRead 的物理表。 */
  tables: readonly string[];
  /** 物理闸 `EXPLAIN` 用的占位绑定（全 null，见 query-gate.ts `explainBindings`）。 */
  explainArgs: unknown[];
  rowsMax: number;
  bytesMax: number;
}

export interface WidgetQueryExecutor {
  run(job: WidgetQueryJob): Promise<WidgetsUiQueryOutput>;
  dispose(): void;
}

export interface WidgetQueryRunnerOptions {
  database: { path: string; key: Uint8Array };
  /** 单条查询的执行时限（不含子进程启动）。 */
  timeoutMs?: number;
  /** 子进程常驻内存上限（Linux 上按 /proc 采样；其他平台只靠时限）。 */
  memoryMaxBytes?: number;
  /** 全局排队上限（兜底；公平性靠下面的每归属上限与轮转）。 */
  queueMax?: number;
  /** 每个归属同时排队 + 执行中的上限（默认 = 每版本模板数上限，看板一次拉全部模板不被拒）。 */
  perOwnerMax?: number;
  /** 同一归属连续超时多少次熔断。 */
  breakerStrikes?: number;
  /** 熔断时长。 */
  breakerCooldownMs?: number;
  /** 空闲多久后让子进程退出。 */
  idleMs?: number;
  /** 子进程启动 + 开库的时限。 */
  startupTimeoutMs?: number;
  /** 子进程 require 的 SQLite 驱动入口（默认 {@link resolveQueryDriverPath}；测试 / 诊断用）。 */
  driverPath?: string;
  /** 熔断计时用的时钟（毫秒）。 */
  now?: () => number;
  /** 执行环境不可用时的诊断日志（完整原因 + 驱动路径 + 运行时）。 */
  logger?: { warn(fields: Record<string, unknown>, msg: string): void };
}

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_BREAKER_STRIKES = 2;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const MEMORY_SAMPLE_MS = 100;
/** 轮转记忆（归属 → 上次被服务序号）的条目上限。 */
const SERVED_MEMORY_MAX = 256;
const DRIVER_PACKAGE = 'better-sqlite3-multiple-ciphers';

/**
 * 子进程 require 的 SQLite 驱动入口。打包应用里 core 的模块解析落在
 * `app.asar/node_modules/better-sqlite3-multiple-ciphers/lib/index.js`；子进程优先用
 * `app.asar.unpacked` 下的真实文件（electron-builder smartUnpack 会把含 `.node` 的整个
 * 包目录解出，该包运行时无其他依赖），不依赖 Electron 在 Node 模式下的 asar 补丁；
 * 解出目录不存在（非打包环境 / 打包配置变化）时退回原路径。
 */
export function resolveQueryDriverPath(
  resolve: () => string = () => createRequire(import.meta.url).resolve(DRIVER_PACKAGE),
  exists: (file: string) => boolean = existsSync,
): string {
  const resolved = resolve();
  const unpacked = unpackedAsarPath(resolved);
  return unpacked !== resolved && exists(unpacked) ? unpacked : resolved;
}

interface Pending {
  job: WidgetQueryJob;
  resolve(value: WidgetsUiQueryOutput): void;
  reject(error: unknown): void;
}

type ChildReply =
  | { type: 'ready' }
  | { type: 'fatal'; message: string; runtime: string }
  | { type: 'result'; id: number; ok: true; result: WidgetsUiQueryOutput }
  | { type: 'result'; id: number; ok: false; denied: boolean; message: string };

interface Worker {
  child: ChildProcess;
  modulePath: string;
  ready: boolean;
  /** 我们主动杀掉它的原因（exit 时据此给出错误）。 */
  killedFor: 'timeout' | 'memory' | 'startup' | 'idle' | 'error' | 'dispose' | null;
  /** 子进程 / IPC 报告的错误（spawn 失败、send 失败、子进程 fatal），用于诊断文案。 */
  failure: string | null;
}

interface Breaker {
  /** 连续超时次数（成功一次清零）。 */
  strikes: number;
  /** 熔断截止时刻（0 = 未熔断）。 */
  openUntil: number;
  /** 熔断过且尚未成功过：冷却后首条再超时立即重新熔断。 */
  tripped: boolean;
}

export class WidgetQueryRunner implements WidgetQueryExecutor {
  readonly #options: Required<
    Omit<WidgetQueryRunnerOptions, 'database' | 'driverPath' | 'logger'>
  > & {
    database: WidgetQueryRunnerOptions['database'];
    driverPath: string | undefined;
    logger: WidgetQueryRunnerOptions['logger'];
  };
  /** 按归属分桶的排队（Map 顺序无语义；派活按 {@link #served} 选最久没被服务的）。 */
  readonly #queues = new Map<string, Pending[]>();
  /** 归属上次被派活的序号（越小越优先；没被服务过的视为最优先）。 */
  readonly #served = new Map<string, number>();
  readonly #breakers = new Map<string, Breaker>();
  #queued = 0;
  #worker: Worker | null = null;
  #active: { pending: Pending; id: number; timer: NodeJS.Timeout; sampler: NodeJS.Timeout | null } | null =
    null;
  #startupTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #seq = 0;
  #servedSeq = 0;
  #disposed = false;

  constructor(options: WidgetQueryRunnerOptions) {
    this.#options = {
      database: options.database,
      timeoutMs: options.timeoutMs ?? BOT_WIDGET_QUERY_TIMEOUT_MS,
      memoryMaxBytes: options.memoryMaxBytes ?? BOT_WIDGET_QUERY_MEMORY_MAX_BYTES,
      queueMax: options.queueMax ?? BOT_WIDGET_QUERY_QUEUE_MAX,
      perOwnerMax: options.perOwnerMax ?? BOT_WIDGET_QUERIES_MAX,
      breakerStrikes: options.breakerStrikes ?? DEFAULT_BREAKER_STRIKES,
      breakerCooldownMs: options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS,
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      driverPath: options.driverPath,
      now: options.now ?? Date.now,
      logger: options.logger,
    };
  }

  /** 当前子进程 pid（测试观察用；没有子进程为 null）。 */
  get pid(): number | null {
    return this.#worker?.child.pid ?? null;
  }

  run(job: WidgetQueryJob): Promise<WidgetsUiQueryOutput> {
    if (this.#disposed) {
      return Promise.reject(new AppError('WIDGET_QUERY_FAILED', '执行服务已关闭'));
    }
    const suspended = this.#breakerError(job.owner);
    if (suspended !== null) return Promise.reject(suspended);
    const mine =
      (this.#queues.get(job.owner)?.length ?? 0) + (this.#active?.pending.job.owner === job.owner ? 1 : 0);
    if (mine >= this.#options.perOwnerMax) {
      return Promise.reject(
        new AppError(
          'WIDGET_RATE_LIMITED',
          `这个组件同时在排队 / 执行的查询已达 ${this.#options.perOwnerMax} 条，请等前面的查询完成后再试`,
        ),
      );
    }
    if (this.#queued >= this.#options.queueMax) {
      return Promise.reject(new AppError('WIDGET_RATE_LIMITED', '排队的查询太多，请稍后再试'));
    }
    return new Promise<WidgetsUiQueryOutput>((resolve, reject) => {
      const list = this.#queues.get(job.owner);
      if (list === undefined) this.#queues.set(job.owner, [{ job, resolve, reject }]);
      else list.push({ job, resolve, reject });
      this.#queued += 1;
      this.#pump();
    });
  }

  /**
   * 关闭：在途与排队的查询**立即**失败（不等子进程的 exit 事件——关闭途中它可能永远
   * 不来），然后杀子进程；之后迟到的 exit / message 一律忽略。
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new AppError('WIDGET_QUERY_FAILED', '执行服务已关闭');
    this.#settleActive(error);
    this.#rejectQueued(() => true, error);
    this.#kill('dispose');
    this.#worker = null;
    this.#clearStartup();
    this.#clearIdle();
  }

  #pump(): void {
    if (this.#disposed || this.#active !== null || this.#queued === 0) return;
    this.#clearIdle();
    const worker = this.#ensureWorker();
    // 'ready' 到达后再泵；正在被杀的进程不再派活（exit 后起新进程再泵）。
    if (worker === null || !worker.ready || worker.killedFor !== null) return;
    const pending = this.#dequeue();
    if (pending === null) return;
    const id = ++this.#seq;
    const timer = setTimeout(() => this.#abortActive(id, 'timeout'), this.#options.timeoutMs);
    const sampler = this.#memorySampler(worker, id);
    this.#active = { pending, id, timer, sampler };
    this.#send(worker, { type: 'query', id, job: pending.job });
  }

  /** 取「最久没被服务」的归属的队首（新归属优先）；单个归属灌满队列也只占轮转里的一格。 */
  #dequeue(): Pending | null {
    let owner: string | null = null;
    let oldest = Infinity;
    for (const key of this.#queues.keys()) {
      const served = this.#served.get(key) ?? -1;
      if (served < oldest) {
        oldest = served;
        owner = key;
      }
    }
    if (owner === null) return null;
    const list = this.#queues.get(owner)!;
    const pending = list.shift()!;
    this.#queued -= 1;
    this.#served.set(owner, ++this.#servedSeq);
    if (list.length === 0) this.#queues.delete(owner);
    // 「上次被服务」要跨越排队清空保留：否则一个每次只排一条的组件每轮都被当成新来的
    // 插到别人前面。只在表过大时清掉没有排队的旧条目。
    if (this.#served.size > SERVED_MEMORY_MAX) {
      for (const key of [...this.#served.keys()]) {
        if (!this.#queues.has(key) && key !== owner) this.#served.delete(key);
      }
    }
    return pending;
  }

  #ensureWorker(): Worker | null {
    if (this.#worker !== null) return this.#worker;
    let modulePath: string;
    try {
      modulePath = this.#options.driverPath ?? resolveQueryDriverPath();
    } catch (error) {
      this.#unavailable(`找不到查询驱动 ${DRIVER_PACKAGE}：${errorMessage(error)}`, null);
      return null;
    }
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [`--max-old-space-size=128`, '-e', CHILD_SOURCE], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      });
    } catch (error) {
      this.#unavailable(`无法启动子进程：${errorMessage(error)}`, modulePath);
      return null;
    }
    const worker: Worker = { child, modulePath, ready: false, killedFor: null, failure: null };
    this.#worker = worker;
    // 不让查询子进程拖住宿主退出（dispose 会显式杀它）。
    child.unref();
    (child as unknown as { channel?: { unref(): void } }).channel?.unref();
    child.on('message', (message: ChildReply) => this.#onMessage(worker, message));
    child.on('exit', () => this.#onExit(worker));
    // 'error' 不一定意味着进程已死（IPC send 失败时子进程仍活着）：先杀再按退出处理，
    // 不留孤儿。
    child.on('error', (error) => this.#onChildError(worker, error));
    this.#startupTimer = setTimeout(() => this.#kill('startup'), this.#options.startupTimeoutMs);
    this.#send(worker, {
      type: 'init',
      modulePath,
      path: this.#options.database.path,
      keyHex: Buffer.from(this.#options.database.key).toString('hex'),
    });
    return worker;
  }

  /** IPC 发送：同步抛出（序列化失败）与异步失败（通道已关）都按子进程错误处理。 */
  #send(worker: Worker, message: Serializable): void {
    try {
      worker.child.send(message, (error) => {
        if (error !== null && error !== undefined) this.#onChildError(worker, error);
      });
    } catch (error) {
      this.#onChildError(worker, error);
    }
  }

  #onChildError(worker: Worker, error: unknown): void {
    worker.failure ??= errorMessage(error);
    if (worker.killedFor === null) worker.killedFor = 'error';
    try {
      worker.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    this.#onExit(worker);
  }

  #onMessage(worker: Worker, message: ChildReply): void {
    if (this.#worker !== worker) return;
    if (message.type === 'ready') {
      worker.ready = true;
      this.#clearStartup();
      this.#pump();
      return;
    }
    if (message.type === 'fatal') {
      this.#clearStartup();
      worker.failure ??= message.message;
      this.#unavailable(message.message, worker.modulePath, message.runtime);
      this.#kill('dispose');
      return;
    }
    const active = this.#active;
    if (active === null || message.id !== active.id) return;
    // 查询正常结束（含 SQL 报错 / 被闸拒绝）：该归属的连续超时清零。
    this.#clearStrikes(active.pending.job.owner);
    if (message.ok) {
      this.#settleActive(null, message.result);
    } else {
      this.#settleActive(
        new AppError(
          'WIDGET_QUERY_FAILED',
          message.denied ? message.message : `执行失败：${humanizeSqlError(message.message)}`,
        ),
      );
    }
    this.#pump();
    this.#armIdle();
  }

  #onExit(worker: Worker): void {
    if (this.#worker !== worker) return;
    this.#worker = null;
    this.#clearStartup();
    const reason = worker.killedFor;
    if (this.#active !== null) {
      // 超时 / 内存超限在杀的当下已结算（#abortActive）；走到这里是意外退出。
      this.#settleActive(
        new AppError(
          'WIDGET_QUERY_FAILED',
          worker.failure === null ? '执行环境意外退出' : `执行环境意外退出：${worker.failure}`,
        ),
      );
    } else if (reason === 'startup') {
      this.#unavailable('启动超时', worker.modulePath);
      return;
    } else if (!worker.ready && (reason === null || reason === 'error')) {
      this.#unavailable(worker.failure === null ? '启动失败' : `启动失败：${worker.failure}`, worker.modulePath);
      return;
    }
    // 排队的下一条在新进程里跑（被杀的进程不复用）。
    this.#pump();
  }

  /**
   * 超时 / 内存超限：杀子进程，并**当下**结算这条查询、给归属记一次超时（不等 exit
   * 事件——结算不依赖子进程何时被回收）。排队的下一条等 exit 后在新进程里跑。
   */
  #abortActive(id: number, reason: 'timeout' | 'memory'): void {
    const active = this.#active;
    if (active === null || active.id !== id) return;
    this.#kill(reason);
    this.#settleActive(
      reason === 'timeout'
        ? new AppError(
            'WIDGET_QUERY_TIMEOUT',
            `执行超过 ${this.#options.timeoutMs} 毫秒，已中止（缩小扫描范围或加条件后再试）`,
          )
        : new AppError('WIDGET_QUERY_TIMEOUT', '占用内存过多，已中止（缩小结果或计算量后再试）'),
    );
    this.#strike(active.pending.job.owner);
  }

  #settleActive(error: unknown, result?: WidgetsUiQueryOutput): void {
    const active = this.#active;
    if (active === null) return;
    this.#active = null;
    clearTimeout(active.timer);
    if (active.sampler !== null) clearInterval(active.sampler);
    if (error !== null) active.pending.reject(error);
    else active.pending.resolve(result!);
  }

  #rejectQueued(match: (owner: string) => boolean, error: unknown): void {
    for (const [owner, list] of [...this.#queues]) {
      if (!match(owner)) continue;
      this.#queues.delete(owner);
      this.#queued -= list.length;
      for (const pending of list) pending.reject(error);
    }
  }

  /**
   * 执行环境不可用（找不到驱动 / 起不来 / 开库失败）：在途与排队的全部失败，带可诊断
   * 信息（原因 + 驱动路径 + 子进程运行时），同时写诊断日志。
   */
  #unavailable(reason: string, modulePath: string | null, runtime?: string): void {
    const details = [
      modulePath === null ? null : `驱动 ${modulePath}`,
      runtime ?? `宿主 ${runtimeSummary()}`,
    ].filter((part): part is string => part !== null);
    const message = `执行环境不可用：${reason}（${details.join('；')}）`;
    this.#options.logger?.warn(
      { reason, modulePath, runtime: runtime ?? runtimeSummary(), execPath: process.execPath },
      'widget query sandbox unavailable',
    );
    const error = new AppError('WIDGET_QUERY_FAILED', message);
    this.#settleActive(error);
    this.#rejectQueued(() => true, error);
  }

  #breakerError(owner: string): AppError | null {
    const breaker = this.#breakers.get(owner);
    if (breaker === undefined || breaker.openUntil === 0) return null;
    const remaining = breaker.openUntil - this.#options.now();
    if (remaining <= 0) {
      // 冷却结束：放行，但保持半开（再超时一次立即重新熔断）。
      breaker.openUntil = 0;
      return null;
    }
    return new AppError(
      'WIDGET_RATE_LIMITED',
      `这个组件的查询连续超时，已暂停 ${Math.ceil(remaining / 1000)} 秒（缩小扫描范围或加条件后再试）`,
    );
  }

  #strike(owner: string): void {
    const breaker = this.#breakers.get(owner) ?? { strikes: 0, openUntil: 0, tripped: false };
    breaker.strikes += 1;
    this.#breakers.set(owner, breaker);
    if (!breaker.tripped && breaker.strikes < this.#options.breakerStrikes) return;
    breaker.strikes = 0;
    breaker.tripped = true;
    breaker.openUntil = this.#options.now() + this.#options.breakerCooldownMs;
    // 它排队中的查询不再给机会（每条都可能再占满一个时限）。
    const error = this.#breakerError(owner);
    if (error !== null) this.#rejectQueued((key) => key === owner, error);
  }

  #clearStrikes(owner: string): void {
    const breaker = this.#breakers.get(owner);
    if (breaker !== undefined && breaker.openUntil === 0) this.#breakers.delete(owner);
  }

  #kill(reason: NonNullable<Worker['killedFor']>): void {
    const worker = this.#worker;
    if (worker === null) return;
    if (worker.killedFor === null) worker.killedFor = reason;
    try {
      worker.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  /** Linux：按 /proc/<pid>/status 的 VmRSS 采样，超限即杀。其他平台只靠时限。 */
  #memorySampler(worker: Worker, id: number): NodeJS.Timeout | null {
    const pid = worker.child.pid;
    if (process.platform !== 'linux' || pid === undefined) return null;
    const limitKb = Math.floor(this.#options.memoryMaxBytes / 1024);
    const timer = setInterval(() => {
      readFile(`/proc/${pid}/status`, 'utf8')
        .then((status) => {
          const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
          if (match !== null && Number(match[1]) > limitKb && this.#worker === worker) {
            this.#abortActive(id, 'memory');
          }
        })
        .catch(() => undefined);
    }, MEMORY_SAMPLE_MS);
    timer.unref();
    return timer;
  }

  #armIdle(): void {
    if (this.#active !== null || this.#queued > 0 || this.#worker === null) return;
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => this.#kill('idle'), this.#options.idleMs);
    this.#idleTimer.unref();
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #clearStartup(): void {
    if (this.#startupTimer !== null) clearTimeout(this.#startupTimer);
    this.#startupTimer = null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 宿主运行时摘要（子进程起不来、拿不到它自己的摘要时用）。 */
function runtimeSummary(): string {
  const electron = (process.versions as Record<string, string | undefined>).electron;
  return `node ${process.versions.node}${electron === undefined ? '' : ` / electron ${electron}`}，${process.platform}-${process.arch}`;
}

/** 常见绑定错误的人话化（其余原样透出）。 */
function humanizeSqlError(message: string): string {
  const missing = /^Missing named parameter "(.+)"$/.exec(message);
  if (missing !== null) {
    return `缺少参数「${missing[1]}」（模板里的 :${missing[1]} 没有在 params 里给值）`;
  }
  return message;
}

/**
 * 子进程脚本（CommonJS，经 `-e` 执行；不落盘、不依赖打包产物路径）。只信父进程经
 * IPC 发来的 init / query；密钥只走 IPC（不进 argv / 环境变量）。
 */
const CHILD_SOURCE = `'use strict';
const DENIED = new Set(${JSON.stringify([...WIDGET_QUERY_DENIED_OPCODES])});
const P2ISREG = 0x10;
let db = null;
function deny(message) { const e = new Error(message); e.denied = true; throw e; }
function runtime() {
  const v = process.versions;
  return '子进程 node ' + v.node + (v.electron ? ' / electron ' + v.electron : '') + '，' + process.platform + '-' + process.arch +
    '，ELECTRON_RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE || '');
}
function init(msg) {
  const Database = require(msg.modulePath);
  db = new Database(msg.path, { readonly: true, fileMustExist: true });
  db.pragma("cipher='chacha20'");
  db.pragma('key="x\\'' + msg.keyHex + '\\'"');
  db.pragma('busy_timeout = 1000');
  db.pragma('trusted_schema = OFF');
  db.pragma('query_only = ON');
  db.prepare('select count(*) as n from sqlite_master').get();
}
function safeRow(raw) {
  const out = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    out[key] = value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value;
  }
  return out;
}
function run(job) {
  const schemaRow = db.prepare('select type, tbl_name from main.sqlite_schema where rootpage = ?');
  const clash = db.prepare('select 1 from main.sqlite_schema where name = ? collate nocase');
  db.pragma('query_only = OFF');
  try {
    for (const view of job.views) {
      if (clash.get(view.name) !== undefined) deny('数据范围视图与库里的表重名，拒绝执行');
      db.exec('drop view if exists temp."' + view.name + '"');
      db.exec('create temp view "' + view.name + '" as ' + view.select);
    }
  } finally {
    db.pragma('query_only = ON');
  }
  const head = job.sql.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ').replace(/--[^\\n]*/g, ' ').trimStart();
  if (!/^(select|with)\\b/i.test(head)) deny('只允许 SELECT / WITH…SELECT，拒绝执行');
  const statement = db.prepare(job.sql);
  if (statement.readonly !== true) deny('已不是只读语句，拒绝执行');
  const allowed = new Set(job.tables);
  for (const op of db.prepare('explain ' + job.sql).all(...job.explainArgs)) {
    if (DENIED.has(op.opcode)) deny('含有不允许的操作（' + op.opcode + '），拒绝执行');
    if (op.opcode === 'OpenRead' || op.opcode === 'ReopenIdx') {
      if (op.p3 !== 0 || (op.p5 & P2ISREG) !== 0) deny('读取了数据范围之外的库，拒绝执行');
      const row = schemaRow.get(op.p2);
      if (row === undefined || !allowed.has(row.tbl_name)) deny('读取了数据范围之外的表，拒绝执行');
    }
  }
  const rows = [];
  let bytes = 0;
  let truncated = false;
  for (const raw of statement.iterate(job.params)) {
    // 多取一行判断截断：恰好 rowsMax 行不算截断。
    if (rows.length >= job.rowsMax) { truncated = true; break; }
    const row = safeRow(raw);
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > job.bytesMax) { truncated = true; break; }
    bytes += size;
    rows.push(row);
  }
  return { rows, truncated };
}
process.on('message', (msg) => {
  if (msg === null || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    try { init(msg); process.send({ type: 'ready' }); }
    catch (e) { process.send({ type: 'fatal', message: String(e && e.message || e), runtime: runtime() }, () => process.exit(1)); }
    return;
  }
  if (msg.type === 'query') {
    let reply;
    try { reply = { type: 'result', id: msg.id, ok: true, result: run(msg.job) }; }
    catch (e) { reply = { type: 'result', id: msg.id, ok: false, denied: e && e.denied === true, message: String(e && e.message || e) }; }
    process.send(reply);
  }
});
process.on('disconnect', () => process.exit(0));
`;

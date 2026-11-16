import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  PLUGIN_RUNTIME_HOST_API_VERSION,
  PLUGIN_RUNTIME_INSTANCE_ID_FEATURE,
  PLUGIN_RUNTIME_MAX_CALL_TIMEOUT_MS,
  isPluginHostApiRequest,
  isPluginHostApiResponse,
  pluginRuntimeInitFrameSchema,
  pluginRuntimeInvokeFrameSchema,
  pluginRuntimePluginToHostFrameSchema,
  type PluginHostApiRequest,
  type PluginRuntimeProgressPayload,
  type PluginRuntimeStatus,
  type PluginToHostFrame,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import { ensurePluginDataDir } from '../../infra/paths.js';
import type { PluginRegistry } from '../registry.js';
import type { CapabilityBridge } from './bridge.js';
import { ProgressRelay } from './bridge.js';
import {
  capabilityContract,
  type CapabilityContract,
  type CapabilityContractMethod,
} from './contracts.js';
import { HostedAdapter } from './hosted-adapter.js';

/**
 * 插件运行时宿主（D125 P2，docs/design/61-plugin-runtime-platform.md §3）。
 *
 * 一插件一进程（`child_process.fork`，`serialization:'advanced'`、`execArgv:[]`、
 * cwd = 插件私有数据目录 `{home}/plugin-data/{ns}/{name}/`（D125 补丁；相对路径
 * 写入落在那里，安装树只读且随更新替换）、最小 env 白名单）；状态机
 * `stopped → starting → ready ⇄ busy → error`，懒启动、空闲 5 分钟优雅停、崩溃后
 * 下次调用自动重启。调用级看门狗（能力契约超时，超时 = cancel → 宽限 → 击杀 →
 * `PLUGIN_TIMEOUT`）与进程心跳（15s ping ×2 无响应击杀）双线；每插件串行队列
 * （`maxConcurrent` 预留）。每次调用进 50 条环形历史，状态迁移广播 `plugin.runtime`。
 *
 * Host API 通道（net / secrets / storage / ping）走独立的 `host-api` 信封
 * （shared `plugin-runtime/protocol.ts`，DEV-113）：九帧调用协议不动，能力桥裁决全部
 * 边界。子进程代码只通过 `@kepcup/plugin-sdk` 的 `host` 命名空间使用这些能力。
 */

export const PLUGIN_RUNTIME_HISTORY_LIMIT = 50;

/**
 * P4 观测项（61 §3.3）：插件进程 RSS 超过该值记一条 warn（不强制、不击杀）。
 * 数据来源是插件进程在心跳 pong 里自报的 `process.memoryUsage().rss`——零新依赖、
 * 零额外进程；恶意插件可以谎报，但这只是观测不是治理边界。
 */
export const PLUGIN_RUNTIME_RSS_WARN_BYTES = 512 * 1024 * 1024;

export type PluginProcessStatus = PluginRuntimeStatus;

/** 一次调用的历史记录（shape 与 shared `pluginRuntimeCallRecordSchema` 一致）。 */
export interface PluginCallRecord {
  at: number;
  contract: string;
  method: string;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
  message: string | null;
}

/** `plugins.runtime.list` 的一行（shape 与 shared `pluginRuntimePluginStateSchema` 一致）。 */
export interface PluginRuntimeState {
  pluginId: string;
  status: PluginProcessStatus;
  detail: string | null;
  lastError: string | null;
  recent: PluginCallRecord[];
}

/** 调用上下文：条目 / 实例定位 + run 进度通道 + 取消信号。 */
export interface PluginCallContext {
  /** 条目 id（manifest `contributions.capabilityModels[].id`）。 */
  entryId: string;
  /** 厂商模型 id。 */
  model: string;
  /** 调用方语言（缺省 zh-CN）。 */
  locale?: string;
  /** 条目 params 合并（原样进 wire context.params）。 */
  params?: Record<string, unknown>;
  /** 实例 id：宿主据此注入该实例的敏感凭据（空 = 不注入）。 */
  instanceId: string;
  /** 调用所属 run 的进度回调（D106/D55 通道；宿主限速 ≤1 次/秒）。 */
  onProgress?: (payload: PluginRuntimeProgressPayload) => void;
  /** 用户取消 / 工具超时的联动：abort → 发 cancel 帧；到点强杀。 */
  signal?: AbortSignal;
}

/** 运行时阈值（可注入以便测试调小；生产用 {@link DEFAULT_PLUGIN_HOST_TIMINGS}）。 */
export interface PluginHostTimings {
  /** 心跳间隔（61 §3.1：15s）。 */
  heartbeatIntervalMs: number;
  /** 连续无响应的心跳次数上限（2 次击杀）。 */
  heartbeatMisses: number;
  /** 空闲回收（61 §3.1：5 分钟）。 */
  idleStopMs: number;
  /** 启动握手超时。 */
  startTimeoutMs: number;
  /** 优雅停 / 超时 cancel 后的强杀宽限（61 §3.1：2s）。 */
  killGraceMs: number;
  /** 单进程日志输出速率上限（条 / 分钟）。 */
  outputLinesPerMinute: number;
  /** 调用级超时覆盖：键 = `${contract}.${method}`（测试调小；缺省用契约）。 */
  callTimeoutOverride: Record<string, number>;
}

export const DEFAULT_PLUGIN_HOST_TIMINGS: PluginHostTimings = {
  heartbeatIntervalMs: 15_000,
  heartbeatMisses: 2,
  idleStopMs: 5 * 60_000,
  startTimeoutMs: 30_000,
  killGraceMs: 2_000,
  outputLinesPerMinute: 100,
  callTimeoutOverride: {},
};

/** 宿主看到的一份执行型插件描述（清单 + 安装目录 + 入口）。 */
export interface PluginRuntimeDescriptor {
  pluginId: string;
  name: string;
  pluginDir: string;
  entryPath: string;
  manifestDigest: string;
  hostApi: string;
  networkAllow: readonly string[];
  maxConcurrent: number;
  /** 插件声明的方法级调用超时（`<contract>.<method>` → ms；缺省空 = 用契约默认）。 */
  timeouts: Readonly<Record<string, number>>;
}

export interface PluginHostDeps {
  registry: Pick<PluginRegistry, 'manifestOf' | 'isConsumable' | 'list' | 'runtimeDirOf'>;
  bridge: CapabilityBridge;
  /**
   * 执行型插件私有数据根（D125 补丁）：`{home}/plugin-data/`。每次拉进程前确保
   * `{root}/{ns}/{name}/` 存在（0700）并作为 fork 的 cwd；builtin 执行型插件
   * （store 无行）在首次拉起时按需创建。
   */
  pluginDataDir: string;
  events: {
    emit(
      name: 'plugin.runtime',
      payload: { pluginId: string; status: PluginProcessStatus; detail?: string },
    ): void;
  };
  logger: CoreLogger;
  timings?: Partial<Omit<PluginHostTimings, 'callTimeoutOverride'>> & {
    callTimeoutOverride?: Record<string, number>;
  };
  /** 测试缝：替换 fork 实现。 */
  forkImpl?: typeof fork;
  /** 子进程环境白名单的来源（缺省 process.env）。 */
  baseEnv?: NodeJS.ProcessEnv;
  /** RSS warn 阈值覆盖（测试调小；缺省 {@link PLUGIN_RUNTIME_RSS_WARN_BYTES}）。 */
  rssWarnBytes?: number;
}

/** 在途调用（一次 invoke 的生命周期）。 */
interface PendingCall {
  callId: string;
  contract: string;
  method: string;
  startedAt: number;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  abortCleanup: (() => void) | null;
  progress: ProgressRelay;
  logCount: number;
  logWarned: boolean;
  settled: boolean;
  /** D125 P3：调用被 AbortSignal 取消过（活动历史标 CANCELLED，与厂商错误区分）。 */
  cancelled: boolean;
  resolve(output: unknown): void;
  reject(error: unknown): void;
}

/** 一个活进程（含握手 promise、在途调用与心跳 / 空闲计时器）。 */
interface LiveProcess {
  descriptor: PluginRuntimeDescriptor;
  child: ChildProcess;
  ready: Promise<void>;
  readyResolve: (() => void) | null;
  readyReject: ((error: unknown) => void) | null;
  handshaken: boolean;
  contracts: string[];
  /** D125 P4：插件在 ready 帧声明的可选协议能力（旧 SDK 为空）。 */
  features: string[];
  pending: Map<string, PendingCall>;
  heartbeat: NodeJS.Timeout | null;
  pingMisses: number;
  /** P4 观测项：本次进程生命周期内已对「RSS > 512MB」记过一次 warn。 */
  rssWarned: boolean;
  idle: NodeJS.Timeout | null;
  gone: boolean;
  stopReason: string | null;
  seq: number;
  output: { windowStart: number; count: number; dropped: number };
}

interface PluginStateRecord {
  status: PluginProcessStatus;
  detail: string | null;
  lastError: string | null;
  recent: PluginCallRecord[];
}

const HISTORY_MAX = PLUGIN_RUNTIME_HISTORY_LIMIT;

/** 子进程最小 env 白名单（61 §3.1：PATH / TEMP / locale，不传透宿主环境）。 */
export function minimalPluginEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'Path',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    // Windows 上 node 自身依赖 SystemRoot / SystemDrive 才能启动。
    'SystemRoot',
    'SystemDrive',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = base[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}

/** AbortSignal 是否已取消（函数边界避免 TS 把 await 前后的检查错误地窄化掉）。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * 插件进程宿主管线：`call` 是唯一入口（HostedAdapter / 探测都走它）。
 * 队列按插件串行（61 §3.1 v1）：同一插件的同时调用排队，不同插件互不影响。
 */
export class PluginHost {
  readonly #deps: PluginHostDeps;
  readonly #timings: PluginHostTimings;
  readonly #live = new Map<string, LiveProcess>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #queued = new Map<string, number>();
  readonly #states = new Map<string, PluginStateRecord>();
  readonly #adapters = new Map<string, HostedAdapter>();
  readonly #rssWarnBytes: number;
  #disposed = false;

  constructor(deps: PluginHostDeps) {
    this.#deps = deps;
    this.#timings = {
      heartbeatIntervalMs:
        deps.timings?.heartbeatIntervalMs ?? DEFAULT_PLUGIN_HOST_TIMINGS.heartbeatIntervalMs,
      heartbeatMisses: deps.timings?.heartbeatMisses ?? DEFAULT_PLUGIN_HOST_TIMINGS.heartbeatMisses,
      idleStopMs: deps.timings?.idleStopMs ?? DEFAULT_PLUGIN_HOST_TIMINGS.idleStopMs,
      startTimeoutMs: deps.timings?.startTimeoutMs ?? DEFAULT_PLUGIN_HOST_TIMINGS.startTimeoutMs,
      killGraceMs: deps.timings?.killGraceMs ?? DEFAULT_PLUGIN_HOST_TIMINGS.killGraceMs,
      outputLinesPerMinute:
        deps.timings?.outputLinesPerMinute ?? DEFAULT_PLUGIN_HOST_TIMINGS.outputLinesPerMinute,
      callTimeoutOverride: deps.timings?.callTimeoutOverride ?? {},
    };
    this.#rssWarnBytes = deps.rssWarnBytes ?? PLUGIN_RUNTIME_RSS_WARN_BYTES;
  }

  // --- 查询面 -------------------------------------------------------------------

  /** 一个插件的运行状态（未加载 = stopped）。 */
  statusOf(pluginId: string): PluginRuntimeState {
    const state = this.#stateOf(pluginId);
    return {
      pluginId,
      status: state.status,
      detail: state.detail,
      lastError: state.lastError,
      recent: [...state.recent],
    };
  }

  /** 全部已安装执行型插件的状态（`plugins.runtime.list`）。 */
  async list(): Promise<PluginRuntimeState[]> {
    const rows: PluginRuntimeState[] = [];
    const seen = new Set<string>();
    for (const summary of this.#deps.registry.list()) {
      if (seen.has(summary.id)) continue;
      const manifest = await this.#deps.registry.manifestOf(summary.id);
      if (manifest?.runtime === undefined) continue;
      seen.add(summary.id);
      rows.push(this.statusOf(summary.id));
    }
    return rows;
  }

  /** 插件 → 托管适配器（media 契约代理；同插件复用同一实例）。 */
  adapterFor(pluginId: string): HostedAdapter {
    let adapter = this.#adapters.get(pluginId);
    if (adapter === undefined) {
      adapter = new HostedAdapter(this, pluginId);
      this.#adapters.set(pluginId, adapter);
    }
    return adapter;
  }

  // --- 调用面 -------------------------------------------------------------------

  /**
   * 能力调用：懒启动 + 串行队列 + 契约校验 + 调用级超时 + 历史记录。
   * `params` 先按契约 schema 校验（输入不合契约 = `PLUGIN_CONTRACT_VIOLATION`，
   * 不进入插件进程）。
   */
  call(
    pluginId: string,
    contractId: string,
    method: string,
    params: unknown,
    ctx: PluginCallContext,
  ): Promise<unknown> {
    if (this.#disposed)
      return Promise.reject(new AppError('PROVIDER_UNAVAILABLE', '核心服务正在关闭'));
    return this.#call(pluginId, contractId, method, params, ctx);
  }

  async #call(
    pluginId: string,
    contractId: string,
    method: string,
    params: unknown,
    ctx: PluginCallContext,
  ): Promise<unknown> {
    if (pluginId === '') {
      throw new AppError('INTERNAL', '插件调用缺少插件 id');
    }
    const descriptor = await this.#describe(pluginId);
    if (descriptor === null) {
      throw new AppError('NOT_IMPLEMENTED', `插件 ${pluginId} 不是执行型插件`);
    }
    if (!this.#deps.registry.isConsumable(pluginId)) {
      // 停用 / 卸载 / 更新窗口：顺手终止可能残留的进程（kill switch 兜底）。
      this.dispose(pluginId);
      throw new AppError('PROVIDER_UNAVAILABLE', '插件已停用或未安装');
    }
    if (isAborted(ctx.signal)) {
      throw new AppError('PROVIDER_UNAVAILABLE', '调用已取消');
    }
    const contract = capabilityContract(contractId);
    if (contract === null) {
      throw new AppError('PLUGIN_CONTRACT_VIOLATION', `未知能力契约：${contractId}`);
    }
    const methodSpec = contract.methods[method];
    if (methodSpec === undefined) {
      throw new AppError('NOT_IMPLEMENTED', `${contractId} 契约没有方法：${method}`);
    }
    const parsedParams = methodSpec.params.safeParse(params ?? {});
    if (!parsedParams.success) {
      throw new AppError(
        'PLUGIN_CONTRACT_VIOLATION',
        `调用参数不符合 ${contractId}.${method} 契约 schema`,
      );
    }
    this.#queued.set(pluginId, (this.#queued.get(pluginId) ?? 0) + 1);
    const previous = this.#queues.get(pluginId) ?? Promise.resolve();
    const run = previous.then(
      () => this.#callQueued(descriptor, contract, methodSpec, method, parsedParams.data, ctx),
      () => this.#callQueued(descriptor, contract, methodSpec, method, parsedParams.data, ctx),
    );
    this.#queues.set(
      pluginId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await run;
    } finally {
      const remaining = (this.#queued.get(pluginId) ?? 1) - 1;
      if (remaining <= 0) this.#queued.delete(pluginId);
      else this.#queued.set(pluginId, remaining);
      const live = this.#live.get(pluginId);

      if (remaining <= 0 && live !== undefined && !live.gone && live.pending.size === 0) {
        if (live.stopReason === null) this.#setStatus(pluginId, 'ready');
      }
    }
  }

  async #callQueued(
    descriptor: PluginRuntimeDescriptor,
    contract: CapabilityContract,
    methodSpec: CapabilityContractMethod,
    method: string,
    params: unknown,
    ctx: PluginCallContext,
  ): Promise<unknown> {
    const pluginId = descriptor.pluginId;
    if (this.#disposed) {
      throw new AppError('PROVIDER_UNAVAILABLE', '核心服务正在关闭');
    }
    if (isAborted(ctx.signal)) {
      throw new AppError('PROVIDER_UNAVAILABLE', '调用已取消');
    }
    // 队列等待期间插件可能被停用 / 卸载：kill switch 必须拒绝排队中的调用，不能让
    // 队首之后的下一次调用重新拉起进程。
    if (!this.#deps.registry.isConsumable(pluginId)) {
      this.dispose(pluginId);
      throw new AppError('PROVIDER_UNAVAILABLE', '插件已停用或未安装');
    }
    const live = await this.#ensureLive(descriptor);
    // 启动握手期间调用方可能已经取消：不要发出 invoke（cancel 帧早于 invoke 会被插件
    // 当作未知 callId 忽略，等于丢取消）。
    if (isAborted(ctx.signal)) {
      throw new AppError('PROVIDER_UNAVAILABLE', '调用已取消');
    }
    if (!live.contracts.includes(contract.id)) {
      throw new AppError('NOT_IMPLEMENTED', `插件未实现能力契约：${contract.id}`);
    }
    // 调用级超时优先级（61 §3.1 / §3.3）：测试覆盖 > 插件清单声明（runtime.timeouts，
    // 按自己的厂商协议给合理时长，宿主钳制上限）> 契约默认。应用不预设一个固定值。
    const declaredTimeout = live.descriptor.timeouts[`${contract.id}.${method}`];
    const timeoutMs =
      this.#timings.callTimeoutOverride[`${contract.id}.${method}`] ??
      (declaredTimeout !== undefined
        ? Math.min(declaredTimeout, PLUGIN_RUNTIME_MAX_CALL_TIMEOUT_MS)
        : methodSpec.timeoutMs);
    const callId = `pc_${++live.seq}`;
    const startedAt = Date.now();
    this.#clearIdle(live);
    this.#setStatus(pluginId, 'busy');
    const outcome = new Promise<unknown>((resolve, reject) => {
      const pending: PendingCall = {
        callId,
        contract: contract.id,
        method,
        startedAt,
        timeoutTimer: null,
        killTimer: null,
        abortCleanup: null,
        progress: new ProgressRelay((payload) => {
          try {
            ctx.onProgress?.(payload);
          } catch {
            // 进度回调失败不影响调用。
          }
        }),
        logCount: 0,
        logWarned: false,
        settled: false,
        cancelled: false,
        resolve: (output) => {
          this.#settle(live, pending, null);
          resolve(output);
        },
        reject: (error) => {
          this.#settle(live, pending, error);
          reject(error);
        },
      };
      live.pending.set(callId, pending);
      // 调用级超时：cancel → 宽限 → 击杀（PLUGIN_TIMEOUT）。
      pending.timeoutTimer = setTimeout(() => {
        if (pending.settled) return;
        try {
          this.#send(live, { type: 'cancel', callId });
        } catch {
          // 通道已关闭：宽限计时器仍会走到击杀，不能因发送失败跳过收尾。
        }
        pending.killTimer = setTimeout(() => {
          if (pending.settled) return;
          this.#failLive(
            live,
            '调用超时，看门狗已终止插件进程',
            'PLUGIN_TIMEOUT',
            `插件 ${descriptor.name} 无响应，本次调用已终止`,
          );
        }, this.#timings.killGraceMs);
      }, timeoutMs);
      // AbortSignal（用户取消 / 工具超时）→ cancel 帧；不主动击杀，等插件返回或调用超时。
      if (ctx.signal !== undefined) {
        const onAbort = (): void => {
          if (pending.settled) return;
          // 历史里标 cancelled（D125 P3）：即使插件按自己的语义返回了结果，这次
          // 调用也是被用户取消的，插件活动抽屉据此显示「已取消」。
          pending.cancelled = true;
          try {
            this.#send(live, { type: 'cancel', callId });
          } catch {
            // 通道已关闭：调用由超时 / 进程退出路径收尾。
          }
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        pending.abortCleanup = () => ctx.signal?.removeEventListener('abort', onAbort);
      }
      const frame = pluginRuntimeInvokeFrameSchema.parse({
        type: 'invoke' as const,
        callId,
        contract: contract.id,
        method,
        params,
        context: {
          entryId: ctx.entryId.length > 0 ? ctx.entryId : 'unknown',
          model: ctx.model.length > 0 ? ctx.model : 'unknown',
          locale: ctx.locale ?? 'zh-CN',
          // 凭据只进帧：不写日志、不进历史、不进错误消息（61 §4）。
          credentials:
            ctx.instanceId === '' ? {} : this.#deps.bridge.credentialsFor(pluginId, ctx.instanceId),
          // D125 P4（DEV-114）：多实例插件用 instanceId 把凭据与实例的非敏感配置对齐。
          // 旧 SDK 没有该字段且帧 schema 是 strictObject——只发给在 ready.features 里
          // 声明认识它的插件，否则旧插件会丢弃整帧、调用挂到超时（兼容面）。
          ...(ctx.instanceId !== '' && live.features.includes(PLUGIN_RUNTIME_INSTANCE_ID_FEATURE)
            ? { instanceId: ctx.instanceId }
            : {}),
          params: ctx.params ?? {},
        },
      });
      try {
        this.#send(live, frame);
      } catch (error) {
        pending.reject(
          error instanceof AppError
            ? error
            : new AppError('PLUGIN_CRASHED', `插件进程不可用：${String(error)}`),
        );
      }
    });
    return outcome;
  }

  /** 成功 / 失败统一收尾：清计时器、出队、写历史、状态回落。 */
  #settle(live: LiveProcess, pending: PendingCall, error: unknown): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timeoutTimer !== null) clearTimeout(pending.timeoutTimer);
    if (pending.killTimer !== null) clearTimeout(pending.killTimer);
    pending.abortCleanup?.();
    pending.abortCleanup = null;
    live.pending.delete(pending.callId);
    const durationMs = Math.max(0, Date.now() - pending.startedAt);
    if (pending.cancelled) {
      // 取消优先于插件自己的返回（D125 P3）：用户取消 / 工具超时是这次调用的真实
      // 结局，活动抽屉据此标「已取消」而不是把插件迟到返回的结果当成功。
      this.#record(live.descriptor.pluginId, {
        at: pending.startedAt,
        contract: pending.contract,
        method: pending.method,
        durationMs,
        ok: false,
        errorCode: 'CANCELLED',
        message: '调用已取消',
      });
    } else if (error === null) {
      this.#record(live.descriptor.pluginId, {
        at: pending.startedAt,
        contract: pending.contract,
        method: pending.method,
        durationMs,
        ok: true,
        errorCode: null,
        message: null,
      });
    } else {
      const code = error instanceof AppError ? error.code : 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      this.#record(live.descriptor.pluginId, {
        at: pending.startedAt,
        contract: pending.contract,
        method: pending.method,
        durationMs,
        ok: false,
        errorCode: code,
        message: message.slice(0, 500),
      });
    }
    if (!live.gone && live.stopReason === null && live.pending.size === 0) {
      if ((this.#queued.get(live.descriptor.pluginId) ?? 0) <= 0) {
        this.#setStatus(live.descriptor.pluginId, 'ready');
      }
      this.#armIdle(live);
    }
  }

  // --- 生命周期 -----------------------------------------------------------------

  /** `plugins.runtime.restart`：终止当前进程并重新拉起（失败抛可读错误）。 */
  async restart(pluginId: string): Promise<void> {
    if (this.#disposed) {
      throw new AppError('PROVIDER_UNAVAILABLE', '核心服务正在关闭');
    }
    const descriptor = await this.#describe(pluginId);
    if (descriptor === null) {
      throw new AppError('NOT_FOUND', `没有执行型插件：${pluginId}`);
    }
    // 停用 = kill switch：restart 不能把已停用 / 未安装的插件重新拉起来。
    if (!this.#deps.registry.isConsumable(pluginId)) {
      this.dispose(pluginId);
      throw new AppError('PROVIDER_UNAVAILABLE', '插件已停用或未安装');
    }
    // 有活进程才走 dispose（其内部会保留状态历史）；无进程只清描述符缓存，
    // restart 不应抹掉插件卡上的最近调用记录。
    if (this.#live.has(pluginId)) this.dispose(pluginId);
    else this.#descriptorCache.delete(pluginId);
    const live = await this.#ensureLive(descriptor);
    await live.ready;
  }

  /** 停用 / 卸载：终止进程（有活进程时保留状态历史；teardown 另清 storage）。 */
  dispose(pluginId: string): void {
    const live = this.#live.get(pluginId);
    if (live === undefined) {
      // 状态历史保留（停用 / 更新后的插件卡仍显示最近调用）；卸载走 forget 清除。
      this.#descriptorCache.delete(pluginId);
      return;
    }
    this.#live.delete(pluginId);
    this.#descriptorCache.delete(pluginId);
    live.stopReason = 'dispose';
    this.#clearTimers(live);
    // 宿主代发的 net.fetch 不会随插件进程自动停止：显式取消，避免连接悬挂到自己的超时。
    this.#deps.bridge.abortFor(pluginId);
    // 在途调用随插件一起结束（插件已被停用 / 卸载）。
    for (const pending of [...live.pending.values()]) {
      pending.reject(new AppError('PLUGIN_CRASHED', '插件已被停用或卸载'));
    }
    if (live.handshaken) {
      live.readyResolve?.();
    } else {
      live.readyReject?.(new AppError('PLUGIN_CRASHED', '插件已被停用或卸载'));
    }
    try {
      if (live.child.connected) live.child.send({ type: 'shutdown' });
    } catch {
      // Channel already closed.
    }
    const timer = setTimeout(() => {
      if (!live.gone) {
        try {
          live.child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, this.#timings.killGraceMs);
    timer.unref?.();
    this.#setStatus(pluginId, 'stopped');
  }

  /** 卸载 / 回滚：终止进程并丢弃状态历史与适配器（注册表 teardown 钩子用）。 */
  forget(pluginId: string): void {
    this.dispose(pluginId);
    this.#states.delete(pluginId);
    this.#descriptorCache.delete(pluginId);
    this.#adapters.delete(pluginId);
  }

  /** 进程级失效（崩溃 / 看门狗 / 超时）：拒绝在途调用、置 error、广播。 */
  #failLive(live: LiveProcess, detail: string, code: string, message: string): void {
    if (live.gone) return;
    live.stopReason = 'failure';
    live.gone = true;
    this.#clearTimers(live);
    // 进程已死：宿主代发的在途 net.fetch 显式取消（否则会挂到自己的超时）。
    this.#deps.bridge.abortFor(live.descriptor.pluginId);
    this.#setStatus(live.descriptor.pluginId, 'error', detail);
    for (const pending of [...live.pending.values()]) {
      pending.reject(new AppError(code, message));
    }
    this.#live.delete(live.descriptor.pluginId);
    try {
      live.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    live.readyReject?.(new AppError(code, message));
  }

  /** 全局关闭（core close）：杀掉全部进程，不等待。 */
  disposeAll(): void {
    this.#disposed = true;
    for (const pluginId of [...this.#live.keys()]) this.dispose(pluginId);
  }

  // --- 进程启动与握手 -----------------------------------------------------------

  readonly #descriptorCache = new Map<string, PluginRuntimeDescriptor>();
  readonly #inflightStart = new Map<string, Promise<LiveProcess>>();

  async #describe(pluginId: string): Promise<PluginRuntimeDescriptor | null> {
    const cached = this.#descriptorCache.get(pluginId);
    if (cached !== undefined) return cached;
    const manifest = await this.#deps.registry.manifestOf(pluginId);
    if (manifest?.runtime === undefined) return null;
    const dir = await this.#deps.registry.runtimeDirOf(pluginId);
    if (dir === null) return null;
    // 符号链接逃逸防线（61 §2 包防护的运行时复核）：安装管线已拒绝包内符号链接，
    // 但 builtin 只读目录不经过 packager——这里对安装根与入口都取 realpath，确保
    // fork 的脚本解析后仍在插件目录内。
    let pluginDir: string;
    let entryPath: string;
    try {
      pluginDir = await realpath(dir);
      const lexical = path.resolve(pluginDir, ...manifest.runtime.entry.split('/'));
      if (!lexical.startsWith(pluginDir + path.sep)) return null;
      entryPath = await realpath(lexical);
    } catch {
      return null;
    }
    if (!entryPath.startsWith(pluginDir + path.sep)) return null;
    const descriptor: PluginRuntimeDescriptor = {
      pluginId,
      name: manifest.name,
      pluginDir,
      entryPath,
      manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      hostApi: manifest.runtime.hostApi,
      networkAllow: manifest.runtime.network?.allow ?? [],
      maxConcurrent: manifest.runtime.maxConcurrent ?? 1,
      timeouts: manifest.runtime.timeouts ?? {},
    };
    this.#descriptorCache.set(pluginId, descriptor);
    return descriptor;
  }

  async #ensureLive(descriptor: PluginRuntimeDescriptor): Promise<LiveProcess> {
    const existing = this.#live.get(descriptor.pluginId);
    if (existing !== undefined && !existing.gone) {
      await existing.ready;
      return existing;
    }
    const inflight = this.#inflightStart.get(descriptor.pluginId);
    if (inflight !== undefined) return inflight;
    const start = this.#startProcess(descriptor).finally(() => {
      this.#inflightStart.delete(descriptor.pluginId);
    });
    this.#inflightStart.set(descriptor.pluginId, start);
    return start;
  }

  async #startProcess(descriptor: PluginRuntimeDescriptor): Promise<LiveProcess> {
    const pluginId = descriptor.pluginId;
    this.#setStatus(pluginId, 'starting');
    // D125 补丁：cwd 是插件私有数据目录（不是安装目录——更新会替换它、目录只读语义
    // 也要求相对路径写入落在用户数据区）。创建失败 = 进程无法以安全 cwd 启动。
    let dataDir: string;
    try {
      dataDir = ensurePluginDataDir(this.#deps.pluginDataDir, pluginId);
    } catch (error) {
      this.#setStatus(pluginId, 'error', '插件数据目录不可用');
      throw new AppError(
        'PLUGIN_CRASHED',
        `插件 ${descriptor.name} 的数据目录不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const forkImpl = this.#deps.forkImpl ?? fork;
    let child: ChildProcess;
    try {
      child = forkImpl(descriptor.entryPath, [], {
        serialization: 'advanced',
        execArgv: [],
        cwd: dataDir,
        env: minimalPluginEnv(this.#deps.baseEnv ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (error) {
      this.#setStatus(pluginId, 'error', '插件进程启动失败');
      throw new AppError(
        'PLUGIN_CRASHED',
        `插件 ${descriptor.name} 启动失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: unknown) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    ready.catch(() => undefined);
    const live: LiveProcess = {
      descriptor,
      child,
      ready,
      readyResolve,
      readyReject,
      handshaken: false,
      contracts: [],
      features: [],
      pending: new Map(),
      heartbeat: null,
      pingMisses: 0,
      rssWarned: false,
      idle: null,
      gone: false,
      stopReason: null,
      seq: 0,
      output: { windowStart: Date.now(), count: 0, dropped: 0 },
    };
    this.#live.set(pluginId, live);
    this.#wireProcess(live);
    const startTimer = setTimeout(() => {
      if (live.handshaken || live.gone) return;
      this.#failLive(
        live,
        '握手超时，插件进程未就绪',
        'PLUGIN_TIMEOUT',
        `插件 ${descriptor.name} 启动超时`,
      );
    }, this.#timings.startTimeoutMs);
    startTimer.unref?.();
    try {
      this.#send(
        live,
        pluginRuntimeInitFrameSchema.parse({
          type: 'init',
          hostApiVersion: PLUGIN_RUNTIME_HOST_API_VERSION,
          manifestDigest: descriptor.manifestDigest,
          instances: this.#deps.bridge.instancesFor(pluginId),
        }),
      );
    } catch (error) {
      clearTimeout(startTimer);
      this.#failLive(
        live,
        '握手初始化失败',
        'PLUGIN_CRASHED',
        `插件 ${descriptor.name} 初始化失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await ready;
    } catch (error) {
      clearTimeout(startTimer);
      throw error;
    }
    clearTimeout(startTimer);
    if (live.gone) throw new AppError('PLUGIN_CRASHED', `插件 ${descriptor.name} 进程已退出`);
    this.#setStatus(pluginId, 'ready');
    this.#startHeartbeat(live);
    this.#armIdle(live);
    return live;
  }

  #wireProcess(live: LiveProcess): void {
    const { child, descriptor } = live;
    child.on('message', (message: unknown) => {
      if (live.gone) return;
      // dispose / idle / 失败收尾已开始：迟到的帧（含 host-api 写请求）一律忽略，
      // 避免卸载清空 plugin_storage 后旧进程又写回一行。
      if (live.stopReason !== null) return;
      // 任何入站消息都证明事件循环还在跑（心跳的响应语义）。
      live.pingMisses = 0;
      const frame = pluginRuntimePluginToHostFrameSchema.safeParse(message);
      if (frame.success) {
        this.#handleFrame(live, frame.data);
        return;
      }
      if (isPluginHostApiRequest(message)) {
        void this.#handleHostApiRequest(live, message);
        return;
      }
      // 心跳 ping 的 pong（host-api-response）只用于存活判定；P4 起顺带读取插件
      // 自报 RSS 做「>512MB 记 warn」观测（61 §3.3，不参与治理判定）。
      if (isPluginHostApiResponse(message)) {
        this.#notePluginMemory(live, message);
        return;
      }
      // 非法 host-api 信封（超长 url / 未知 api / 多余字段）：若 requestId 可回显，
      // 回一个失败应答让插件立即失败，而不是等 SDK 侧 30s / 120s 超时。
      const envelope = message as { type?: unknown; requestId?: unknown } | null;
      if (
        envelope !== null &&
        typeof envelope === 'object' &&
        envelope.type === 'host-api' &&
        typeof envelope.requestId === 'string' &&
        envelope.requestId.length > 0 &&
        envelope.requestId.length <= 64
      ) {
        try {
          this.#send(live, {
            type: 'host-api-response',
            requestId: envelope.requestId,
            ok: false,
            code: 'INVALID_INPUT',
            message: '非法的宿主 API 请求',
          });
        } catch {
          // 通道已关闭。
        }
        return;
      }
      this.#deps.logger.warn(
        { plugin: descriptor.pluginId, type: envelope?.type },
        'plugin runtime: 收到非法宿主协议消息，已忽略',
      );
    });
    child.on('error', (error) => {
      this.#deps.logger.warn(
        { plugin: descriptor.pluginId, error: error.message },
        'plugin process error',
      );
      // 启动 / IPC 级错误：没有 exit 事件时也必须让等待握手的调用尽早失败，而不是
      // 挂到 startTimeout。
      if (!live.gone && live.stopReason === null) {
        this.#failLive(
          live,
          '插件进程错误',
          'PLUGIN_CRASHED',
          `插件 ${descriptor.name} 进程错误：${error.message}`,
        );
      }
    });
    // IPC 通道断开但进程未退出（或 exit 尚未到达）：视同崩溃，避免心跳 / 超时发送
    // 在已关闭的通道上抛异常，也避免状态永久停在 busy。
    child.on('disconnect', () => {
      if (live.gone || live.stopReason !== null) return;
      this.#failLive(
        live,
        '插件进程通道已断开',
        'PLUGIN_CRASHED',
        `插件 ${descriptor.name} 的连接已断开`,
      );
    });
    child.on('exit', (code, signal) => {
      // 迟到的 exit（超时 / 停用已主动击杀旧进程）不得覆盖新进程的状态与映射。
      const current = this.#live.get(descriptor.pluginId) === live;
      live.gone = true;
      this.#clearTimers(live);
      if (!current) return;
      this.#live.delete(descriptor.pluginId);
      if (!live.handshaken) {
        live.readyReject?.(
          new AppError('PLUGIN_CRASHED', `插件 ${descriptor.name} 进程启动失败（code=${code}）`),
        );
      }
      const message = `插件进程退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`;
      for (const pending of [...live.pending.values()]) {
        pending.reject(new AppError('PLUGIN_CRASHED', `${descriptor.name}：${message}`));
      }
      if (live.stopReason === 'dispose' || live.stopReason === 'idle') {
        this.#setStatus(descriptor.pluginId, 'stopped');
        return;
      }
      if (live.stopReason === 'failure' || live.stopReason === 'restart') return;
      this.#setStatus(descriptor.pluginId, 'error', message);
    });
    if (child.stderr !== null) this.#wireOutput(live, child.stderr, 'warn');
    if (child.stdout !== null) this.#wireOutput(live, child.stdout, 'info');
  }

  /** stderr / stdout 进插件日志：插件前缀 + 单行截断 + 每分钟限速（超出丢弃并汇总）。 */
  #wireOutput(live: LiveProcess, stream: NodeJS.ReadableStream, level: 'info' | 'warn'): void {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) this.#logOutput(live, level, line);
      // 无换行的超长输出不得无限占内存：超过 16KB 就按一行记（日志侧再截断）。
      if (buffer.length > 16 * 1024) {
        this.#logOutput(live, level, buffer);
        buffer = '';
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) this.#logOutput(live, level, buffer);
      buffer = '';
    });
    stream.on('error', (error: Error) => {
      this.#deps.logger.warn(
        { plugin: live.descriptor.pluginId, error: error.message },
        'plugin output stream error',
      );
    });
  }

  #logOutput(live: LiveProcess, level: 'info' | 'warn', line: string): void {
    const text = line.trimEnd();
    if (text.trim().length === 0) return;
    const now = Date.now();
    const output = live.output;
    if (now - output.windowStart > 60_000) {
      if (output.dropped > 0) {
        this.#deps.logger.warn(
          { plugin: live.descriptor.pluginId, dropped: output.dropped },
          'plugin output rate limited（其余输出已丢弃）',
        );
      }
      output.windowStart = now;
      output.count = 0;
      output.dropped = 0;
    }
    if (output.count >= this.#timings.outputLinesPerMinute) {
      output.dropped += 1;
      return;
    }
    output.count += 1;
    this.#deps.logger[level](
      { plugin: live.descriptor.pluginId, line: text.slice(0, 500) },
      `plugin output: ${text.slice(0, 200)}`,
    );
  }

  // --- 帧处理 -------------------------------------------------------------------

  #handleFrame(live: LiveProcess, frame: PluginToHostFrame): void {
    switch (frame.type) {
      case 'ready': {
        if (live.handshaken) return;
        if (frame.hostApiVersion !== PLUGIN_RUNTIME_HOST_API_VERSION) {
          this.#failLive(
            live,
            'Host API 版本不匹配',
            'PLUGIN_UPGRADE_REQUIRED',
            `插件 ${live.descriptor.name} 需要 Host API ${frame.hostApiVersion}，当前 ${PLUGIN_RUNTIME_HOST_API_VERSION}`,
          );
          return;
        }
        live.handshaken = true;
        live.contracts = [...frame.contracts];
        live.features = [...(frame.features ?? [])];
        live.readyResolve?.();
        return;
      }
      case 'result': {
        const pending = live.pending.get(frame.callId);
        if (pending === undefined) {
          this.#deps.logger.warn(
            { plugin: live.descriptor.pluginId, callId: frame.callId },
            'plugin runtime: 未知 callId 的 result 帧',
          );
          return;
        }
        const methodSpec = capabilityContract(pending.contract)?.methods[pending.method];
        const checked = methodSpec?.output.safeParse(frame.output);
        if (checked === undefined || !checked.success) {
          pending.reject(
            new AppError(
              'PLUGIN_CONTRACT_VIOLATION',
              `${pending.contract}.${pending.method} 输出不符合契约 schema，已整体丢弃`,
            ),
          );
          return;
        }
        pending.resolve(checked.data);
        return;
      }
      case 'error': {
        if (frame.callId !== undefined) {
          const pending = live.pending.get(frame.callId);
          if (pending === undefined) {
            this.#deps.logger.warn(
              { plugin: live.descriptor.pluginId, callId: frame.callId, code: frame.code },
              'plugin runtime: 未知 callId 的 error 帧',
            );
            return;
          }
          pending.reject(new AppError(frame.code, frame.message, frame.details));
          return;
        }
        if (!live.handshaken) {
          live.readyReject?.(new AppError(frame.code, frame.message));
          this.#failLive(live, frame.message, frame.code, frame.message);
          return;
        }
        this.#deps.logger.warn(
          { plugin: live.descriptor.pluginId, code: frame.code, message: frame.message },
          'plugin runtime: 连接级错误帧',
        );
        return;
      }
      case 'event': {
        const pending = live.pending.get(frame.callId);
        if (pending === undefined) return;
        if (frame.kind === 'progress') {
          pending.progress.push(frame.payload);
          return;
        }
        // log 事件：限速 100 条/调用（61 §3.3），超出丢弃并 warn 一次。
        if (pending.logCount >= 100) {
          if (!pending.logWarned) {
            pending.logWarned = true;
            this.#deps.logger.warn(
              { plugin: live.descriptor.pluginId, callId: frame.callId },
              'plugin log rate limited（超出 100 条/调用，其余已丢弃）',
            );
          }
          return;
        }
        pending.logCount += 1;
        this.#deps.logger[frame.payload.level](
          {
            plugin: live.descriptor.pluginId,
            callId: frame.callId,
            data: frame.payload.data,
          },
          `plugin: ${frame.payload.message}`,
        );
        return;
      }
      case 'state': {
        // 插件主动上报状态：只接受 ready / busy（error 保留原因）。starting / stopped
        // 是宿主侧生命周期值，插件上报无效（协议注释：state 帧是 ready ⇄ busy）。
        if (frame.status === 'error') {
          this.#setStatus(live.descriptor.pluginId, 'error', frame.detail ?? '插件上报错误');
        } else if (live.handshaken && (frame.status === 'ready' || frame.status === 'busy')) {
          this.#setStatus(live.descriptor.pluginId, frame.status, frame.detail);
        }
        return;
      }
    }
  }

  // --- Host API 通道 ------------------------------------------------------------

  async #handleHostApiRequest(live: LiveProcess, request: PluginHostApiRequest): Promise<void> {
    const pluginId = live.descriptor.pluginId;
    const respond = (frame: Record<string, unknown>): void => {
      try {
        this.#send(live, frame);
      } catch {
        // 通道已关闭（进程退出 / 停用）：应答没有接收方，静默丢弃。
      }
    };
    try {
      const value = await this.#dispatchHostApi(pluginId, request);
      respond({
        type: 'host-api-response',
        requestId: request.requestId,
        ok: true,
        value,
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL';
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      this.#deps.logger.warn(
        { plugin: pluginId, api: request.api, code },
        'plugin host-api request failed',
      );
      respond({
        type: 'host-api-response',
        requestId: request.requestId,
        ok: false,
        code,
        message,
      });
    }
  }

  async #dispatchHostApi(pluginId: string, request: PluginHostApiRequest): Promise<unknown> {
    const bridge = this.#deps.bridge;
    switch (request.api) {
      case 'ping':
        return { pong: true };
      case 'net.fetch':
        return bridge.netFetch(pluginId, request.url, request.init);
      case 'secrets.get':
        return { value: bridge.secretsGet(pluginId, request.key) };
      case 'storage.get':
        return { value: bridge.storageGet(pluginId, request.key) };
      case 'storage.set':
        bridge.storageSet(pluginId, request.key, request.value);
        return { ok: true };
      case 'storage.delete':
        bridge.storageDelete(pluginId, request.key);
        return { ok: true };
      case 'storage.list':
        return { keys: bridge.storageList(pluginId, request.prefix) };
    }
  }

  // --- 心跳 / 空闲 / 状态 -------------------------------------------------------

  /**
   * 心跳 pong 里的 RSS 观测（61 §3.3）：超过 512MB 记一条 warn，每进程一次（避免
   * 15s 一条刷屏）。RSS 由插件自报，缺失 / 非数值静默忽略（老 SDK 不带该字段）。
   */
  #notePluginMemory(live: LiveProcess, response: unknown): void {
    if (live.rssWarned) return;
    const value = (response as { value?: unknown }).value;
    if (value === null || typeof value !== 'object') return;
    const rss = (value as { rssBytes?: unknown }).rssBytes;
    if (typeof rss !== 'number' || !Number.isFinite(rss) || rss <= this.#rssWarnBytes) {
      return;
    }
    live.rssWarned = true;
    this.#deps.logger.warn(
      {
        plugin: live.descriptor.pluginId,
        rssBytes: rss,
        thresholdBytes: this.#rssWarnBytes,
      },
      'plugin process RSS exceeded the observation threshold (warn only)',
    );
  }

  #startHeartbeat(live: LiveProcess): void {
    live.heartbeat = setInterval(() => {
      if (live.gone) return;
      if (live.pingMisses >= this.#timings.heartbeatMisses) {
        this.#failLive(
          live,
          '心跳无响应，看门狗已终止插件进程',
          'PLUGIN_TIMEOUT',
          `插件 ${live.descriptor.name} 无响应，已终止进程`,
        );
        return;
      }
      live.pingMisses += 1;
      try {
        this.#send(live, {
          type: 'host-api',
          requestId: `ping_${++live.seq}`,
          api: 'ping',
        });
      } catch {
        this.#failLive(
          live,
          '心跳发送失败，插件进程已失效',
          'PLUGIN_CRASHED',
          `插件 ${live.descriptor.name} 的连接已断开`,
        );
      }
    }, this.#timings.heartbeatIntervalMs);
    live.heartbeat.unref?.();
  }

  #armIdle(live: LiveProcess): void {
    if (this.#timings.idleStopMs <= 0) return;
    this.#clearIdle(live);
    live.idle = setTimeout(() => {
      live.idle = null;
      if (live.gone || live.pending.size > 0) return;
      // 空闲回收：优雅停（shutdown 帧）→ 宽限 → 强杀。先把 live 从映射里摘掉：
      // 宽限窗口内到达的新调用必须拉起新进程，不能复用正在退出的旧进程。
      live.stopReason = 'idle';
      if (this.#live.get(live.descriptor.pluginId) === live) {
        this.#live.delete(live.descriptor.pluginId);
      }
      // 下次调用重新读清单 / 入口（开发目录热更新后不沿用旧描述符）。
      this.#descriptorCache.delete(live.descriptor.pluginId);
      this.#clearTimers(live);
      try {
        if (live.child.connected) live.child.send({ type: 'shutdown' });
      } catch {
        // Channel already closed.
      }
      const timer = setTimeout(() => {
        if (live.gone) return;
        try {
          live.child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, this.#timings.killGraceMs);
      timer.unref?.();
      this.#setStatus(live.descriptor.pluginId, 'stopped');
    }, this.#timings.idleStopMs);
    live.idle.unref?.();
  }

  #clearIdle(live: LiveProcess): void {
    if (live.idle !== null) {
      clearTimeout(live.idle);
      live.idle = null;
    }
  }

  #clearTimers(live: LiveProcess): void {
    if (live.heartbeat !== null) {
      clearInterval(live.heartbeat);
      live.heartbeat = null;
    }
    this.#clearIdle(live);
  }

  #stateOf(pluginId: string): PluginStateRecord {
    let state = this.#states.get(pluginId);
    if (state === undefined) {
      state = { status: 'stopped', detail: null, lastError: null, recent: [] };
      this.#states.set(pluginId, state);
    }
    return state;
  }

  #setStatus(pluginId: string, status: PluginProcessStatus, detail?: string): void {
    const state = this.#stateOf(pluginId);
    const nextDetail = detail ?? null;
    if (state.status === status && state.detail === nextDetail) return;
    state.status = status;
    state.detail = nextDetail;
    if (status === 'error' && nextDetail !== null) state.lastError = nextDetail;
    this.#deps.events.emit('plugin.runtime', {
      pluginId,
      status,
      ...(nextDetail !== null ? { detail: nextDetail } : {}),
    });
  }

  #record(pluginId: string, record: PluginCallRecord): void {
    const state = this.#stateOf(pluginId);
    state.recent.unshift(record);
    if (state.recent.length > HISTORY_MAX) state.recent.length = HISTORY_MAX;
    // 取消不是插件错误（D125 P3 / DEV-120）：活动历史照记 CANCELLED，但「最近错误」
    // 只收真实失败，避免插件卡 error tooltip 被「调用已取消」污染。
    if (!record.ok && record.errorCode !== 'CANCELLED' && record.message !== null) {
      state.lastError = record.message;
    }
  }

  #send(live: LiveProcess, frame: Record<string, unknown> | object): void {
    if (live.gone || live.stopReason !== null || !live.child.connected) {
      throw new AppError('PLUGIN_CRASHED', '插件进程通道已关闭');
    }
    live.child.send(frame as never, (error: Error | null) => {
      if (error !== null) {
        this.#deps.logger.warn(
          { plugin: live.descriptor.pluginId, error: error.message },
          'plugin runtime: 帧发送失败',
        );
      }
    });
  }
}

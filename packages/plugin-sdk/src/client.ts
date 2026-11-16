import {
  MEDIA_CONTRACT_METHODS,
  PLUGIN_RUNTIME_HOST_API_VERSION,
  PLUGIN_RUNTIME_INSTANCE_ID_FEATURE,
  imageGenerationParamsSchema,
  imageGenerationResultSchema,
  pluginRuntimeHostToPluginFrameSchema,
  speechParamsSchema,
  speechResultSchema,
  transcriptionParamsSchema,
  transcriptionResultSchema,
  understandImageParamsSchema,
  understandImageResultSchema,
  videoGenerationHandleSchema,
  videoGenerationParamsSchema,
  videoTaskStatusSchema,
  type HostToPluginFrame,
  type PluginRuntimeProgressPayload,
  type PluginToHostFrame,
} from '@kepcup/shared';
import { host, wireHostApi, type HostApiWiring } from './host.js';
import { connectHostApiChannel, type HostApiChannel, type HostChannelIpc } from './host-channel.js';
import {
  PluginInvokeError,
  type MediaCallContext,
  type MediaContractImpl,
  type PluginSpec,
} from './plugin.js';

/**
 * 插件侧运行时客户端（D125 P1，todo P1 步骤 2.3）：从 IPC 通道读宿主帧 → 校验 →
 * dispatch 到 `definePlugin` 的实现 → 写回帧。与宿主 PluginHost（P2）共用 shared
 * `plugin-runtime/protocol.ts` 的同一份帧 schema——两侧无第二份类型。
 *
 * 内置行为（todo P1 步骤 2.3）：
 * - 调用并发 = 1：在途调用未结束又收到 invoke → 回 `PLUGIN_CONTRACT_VIOLATION`
 *   error 帧（61 §3.1 的串行排队由宿主负责，插件侧只防御）；
 * - `host.signal` 与 cancel 帧联动：cancel 命中在途调用即 abort；
 * - progress 限速 1 次/秒：首事件立即发，窗口内的后续事件合并为最新一条尾随发送。
 *
 * 边界（61 §3.2）：invoke 输入按 shared media wire schema 校验，失败回 error 帧；
 * result 输出在发送前自检同一 schema，失败改发 `PLUGIN_CONTRACT_VIOLATION`——
 * fail-safe，绝不把不合契约的输出交给宿主。
 */

/** 协议通道抽象：`nodeProcessTransport(process)`（fork 内置 IPC）之外的测试 / 移植面。 */
export interface PluginFrameTransport {
  send(frame: PluginToHostFrame): void;
  /** 订阅宿主帧；返回退订函数。 */
  onFrame(handler: (frame: HostToPluginFrame) => void): () => void;
  /** 订阅通道断开；返回退订函数。 */
  onClose(handler: () => void): () => void;
}

/** Node 进程 / MessagePort 形通道的最小结构类型（避免依赖 @types/node）。 */
export interface PluginIpcLike {
  /** 无 IPC 通道时缺省（如非 fork 环境）。 */
  send?(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'disconnect', listener: () => void): unknown;
  off(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown;
}

/** fork 内置 IPC（61 §3.1）适配：宿主 PluginHost `fork(entry, { serialization: 'advanced' })`。 */
export function nodeProcessTransport(
  ipc: PluginIpcLike,
  options: { skipMessage?: (message: unknown) => boolean } = {},
): PluginFrameTransport {
  return {
    send(frame) {
      try {
        ipc.send?.(frame);
      } catch {
        // 通道已死：宿主侧看门狗会发现进程无响应；这里无需也无法上报。
      }
    },
    onFrame(handler) {
      const listener = (message: unknown): void => {
        // Host API 通道的信封（D125 P2 能力桥）不是调用协议帧：跳过，由通道自己处理。
        if (options.skipMessage?.(message) === true) return;
        const parsed = pluginRuntimeHostToPluginFrameSchema.safeParse(message);
        if (!parsed.success) {
          // 宿主→插件方向校验失败 = 拒绝（61 §3.2）；帧可能没有 callId 可回，忽略并留痕。
          console.error('[kepcup-plugin] 收到非法宿主帧，已忽略');
          return;
        }
        handler(parsed.data);
      };
      ipc.on('message', listener);
      return () => ipc.off('message', listener);
    },
    onClose(handler) {
      const listener = (): void => handler();
      ipc.once('disconnect', listener);
      return () => ipc.off('disconnect', listener);
    },
  };
}

const PROGRESS_MIN_INTERVAL_MS = 1000;

/**
 * progress 限速（1 次/秒）：窗口内只保留最新一条，在 1s 边界尾随发送。调用结束丢弃
 * 尾随事件（过期进度不该漂进下一次调用）。
 */
class ProgressRateLimiter {
  readonly #emit: (payload: PluginRuntimeProgressPayload) => void;
  #lastSentAt = 0;
  #pending: PluginRuntimeProgressPayload | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(emit: (payload: PluginRuntimeProgressPayload) => void) {
    this.#emit = emit;
  }

  send(payload: PluginRuntimeProgressPayload): void {
    const now = Date.now();
    const elapsed = now - this.#lastSentAt;
    if (elapsed >= PROGRESS_MIN_INTERVAL_MS) {
      this.#pending = null;
      this.#lastSentAt = now;
      this.#emit(payload);
      return;
    }
    this.#pending = payload; // 窗口内只保留最新一条
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        const pending = this.#pending;
        this.#pending = null;
        if (pending !== null) {
          this.#lastSentAt = Date.now();
          this.#emit(pending);
        }
      }, PROGRESS_MIN_INTERVAL_MS - elapsed);
    }
  }

  /** 调用结束：丢弃尾随事件（过期进度不漂进下一次调用）。 */
  discardPending(): void {
    this.#pending = null;
  }

  dispose(): void {
    this.discardPending();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

// --- media 契约 dispatch 表 ---------------------------------------------------
// params / output schema 全部来自 shared `media/schema.ts`（单一事实源）；invoke 闭包
// 把 wire 形状收编成契约方法调用（cancelVideo 的 void → null）。

interface MediaDispatchEntry {
  params: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } };
  output: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } };
  /** 方法是否已实现（未实现 → NOT_IMPLEMENTED，61 §3.1 与 core 网关同语义）。 */
  has(impl: MediaContractImpl): boolean;
  invoke(impl: MediaContractImpl, ctx: MediaCallContext, params: unknown): Promise<unknown>;
}

type SecondArg<T> = T extends (...args: [...first: unknown[], second: infer S]) => unknown
  ? S
  : never;

const MEDIA_DISPATCH: Record<string, MediaDispatchEntry> = {
  generateImage: {
    params: imageGenerationParamsSchema,
    output: imageGenerationResultSchema,
    has: (impl) => impl.generateImage !== undefined,
    invoke: (impl, ctx, params) =>
      Promise.resolve(
        impl.generateImage?.(ctx, params as SecondArg<typeof impl.generateImage>) ?? null,
      ),
  },
  synthesizeSpeech: {
    params: speechParamsSchema,
    output: speechResultSchema,
    has: (impl) => impl.synthesizeSpeech !== undefined,
    invoke: (impl, ctx, params) =>
      Promise.resolve(
        impl.synthesizeSpeech?.(ctx, params as SecondArg<typeof impl.synthesizeSpeech>) ?? null,
      ),
  },
  transcribeSpeech: {
    params: transcriptionParamsSchema,
    output: transcriptionResultSchema,
    has: (impl) => impl.transcribeSpeech !== undefined,
    invoke: (impl, ctx, params) =>
      Promise.resolve(
        impl.transcribeSpeech?.(ctx, params as SecondArg<typeof impl.transcribeSpeech>) ?? null,
      ),
  },
  understandImage: {
    params: understandImageParamsSchema,
    output: understandImageResultSchema,
    has: (impl) => impl.understandImage !== undefined,
    invoke: (impl, ctx, params) =>
      Promise.resolve(
        impl.understandImage?.(ctx, params as SecondArg<typeof impl.understandImage>) ?? null,
      ),
  },
  submitVideo: {
    params: videoGenerationParamsSchema,
    output: videoGenerationHandleSchema,
    has: (impl) => impl.submitVideo !== undefined,
    invoke: (impl, ctx, params) =>
      Promise.resolve(
        impl.submitVideo?.(ctx, params as SecondArg<typeof impl.submitVideo>) ?? null,
      ),
  },
  videoStatus: {
    params: videoGenerationHandleSchema,
    output: videoTaskStatusSchema,
    has: (impl) => impl.videoStatus !== undefined,
    invoke: (impl, ctx, params) =>
      Promise.resolve(
        impl.videoStatus?.(ctx, params as SecondArg<typeof impl.videoStatus>) ?? null,
      ),
  },
  cancelVideo: {
    params: videoGenerationHandleSchema,
    output: {
      safeParse: () => ({ success: true, data: null }) as { success: true; data: unknown },
    },
    has: (impl) => impl.cancelVideo !== undefined,
    invoke: async (impl, ctx, params) => {
      await impl.cancelVideo?.(ctx, params as SecondArg<typeof impl.cancelVideo>);
      return null;
    },
  },
};

// --- 客户端主体 ----------------------------------------------------------------

export interface PluginRuntimeController {
  /** `shutdown` 帧 / 通道断开 / `stop()` 后 resolve（优雅退出点：此后进程可 exit）。 */
  readonly done: Promise<void>;
  /** 测试 / 强制退出用：退订通道、清限速器并 resolve `done`。 */
  stop(): void;
}

export function runPluginRuntime(
  spec: PluginSpec,
  ipcOrTransport?: PluginIpcLike | PluginFrameTransport,
): PluginRuntimeController {
  const isProcessEntry = ipcOrTransport === undefined;
  // 进程入口模式：自动接入宿主 API 通道（D125 P2 能力桥）。通道与调用协议共用同一
  // fork IPC，用独立信封（`host-api` / `host-api-response`）互不干扰。
  const processIpc: PluginIpcLike | null = isProcessEntry ? globalThisProcess() : null;
  const hostChannel: HostApiChannel | null =
    processIpc === null ? null : connectHostApiChannel(processIpc as HostChannelIpc);
  const transport =
    processIpc !== null
      ? nodeProcessTransport(processIpc, {
          skipMessage: (message) => hostChannel?.isChannelMessage(message) === true,
        })
      : isTransport(ipcOrTransport as PluginIpcLike | PluginFrameTransport)
        ? (ipcOrTransport as PluginFrameTransport)
        : nodeProcessTransport(ipcOrTransport as PluginIpcLike);

  const media = spec.contracts?.media;
  const declaredContracts = media === undefined ? [] : ['media'];

  let readySent = false;
  let finished = false;
  let active: { callId: string; abort: AbortController } | null = null;
  let finishRuntime: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    finishRuntime = () => {
      if (finished) return;
      finished = true;
      limiter.dispose();
      hostChannel?.dispose();
      wireHostApi(null);
      resolve();
    };
  });
  const finish = (): void => finishRuntime?.();

  const limiter = new ProgressRateLimiter((payload) => {
    if (active === null) return; // progress 属于调用：无在途调用时静默丢弃
    send({ type: 'event', callId: active.callId, kind: 'progress', payload });
  });

  // Host API 接线（61 §4）：progress / log / signal 是协议自带能力；net / secrets /
  // storage 由 P2 能力桥经 `host-api` 通道注入（进程入口模式自动接线）。
  const wiring: HostApiWiring = {
    progress: (payload) => limiter.send(payload),
    log: (level, message, data) => {
      if (active === null) return; // log 事件必须归属调用（event 帧必带 callId）
      send({
        type: 'event',
        callId: active.callId,
        kind: 'log',
        payload: { level, message, data },
      });
    },
    signal: () => active?.abort.signal ?? new AbortController().signal,
    ...(hostChannel !== null
      ? {
          net: hostChannel.net,
          secrets: hostChannel.secrets,
          storage: hostChannel.storage,
        }
      : {}),
  };
  wireHostApi(wiring);

  function send(frame: PluginToHostFrame): void {
    if (finished) return;
    transport.send(frame);
  }

  function failCall(callId: string, code: string, message: string, details?: unknown): void {
    send({
      type: 'error',
      callId,
      code,
      message: message.slice(0, 2000) || '插件内部错误（无消息）',
      ...(details !== undefined ? { details } : {}),
    });
  }

  const offFrame = transport.onFrame((frame) => {
    switch (frame.type) {
      case 'init':
        void handleInit(frame);
        break;
      case 'invoke':
        void handleInvoke(frame);
        break;
      case 'cancel':
        // 只中止当前在途调用；过路 cancel（未知 callId）静默忽略。
        if (active?.callId === frame.callId) active.abort.abort();
        break;
      case 'shutdown':
        active?.abort.abort();
        finish();
        break;
    }
  });
  const offClose = transport.onClose(() => {
    active?.abort.abort();
    finish();
  });

  async function handleInit(frame: Extract<HostToPluginFrame, { type: 'init' }>): Promise<void> {
    if (readySent) {
      send({
        type: 'error',
        code: 'PLUGIN_CONTRACT_VIOLATION',
        message: '收到重复 init 帧（握手只发生一次）',
      });
      return;
    }
    // Host API 版本：P1 只支持 v1（协议 init.hostApiVersion 为整数版本号）；不匹配 =
    // 复用既有 PLUGIN_UPGRADE_REQUIRED（61 §3.1），回连接级 error 帧后退出。
    if (frame.hostApiVersion !== PLUGIN_RUNTIME_HOST_API_VERSION) {
      send({
        type: 'error',
        code: 'PLUGIN_UPGRADE_REQUIRED',
        message: `Host API 版本不匹配：宿主 ${frame.hostApiVersion}，插件支持 ${PLUGIN_RUNTIME_HOST_API_VERSION}`,
      });
      finish();
      return;
    }
    try {
      await spec.ready?.({
        hostApiVersion: frame.hostApiVersion,
        manifestDigest: frame.manifestDigest,
        instances: frame.instances,
      });
    } catch (error) {
      send({
        type: 'error',
        code: 'PLUGIN_CRASHED',
        message: `ready() 失败：${errorMessage(error)}`,
      });
      finish();
      return;
    }
    readySent = true;
    send({
      type: 'ready',
      hostApiVersion: PLUGIN_RUNTIME_HOST_API_VERSION,
      contracts: declaredContracts,
      // D125 P4：声明认识的增量 invoke 字段；旧 SDK 不带，宿主据此不发送 instanceId。
      features: [PLUGIN_RUNTIME_INSTANCE_ID_FEATURE],
    });
  }

  async function handleInvoke(
    frame: Extract<HostToPluginFrame, { type: 'invoke' }>,
  ): Promise<void> {
    if (!readySent) {
      failCall(frame.callId, 'PLUGIN_CONTRACT_VIOLATION', '握手完成前收到 invoke');
      return;
    }
    if (active !== null) {
      failCall(
        frame.callId,
        'PLUGIN_CONTRACT_VIOLATION',
        '插件客户端调用并发为 1，宿主必须串行排队（61 §3.1）',
      );
      return;
    }
    if (media === undefined) {
      failCall(frame.callId, 'NOT_IMPLEMENTED', `插件未实现 ${frame.contract} 契约`);
      return;
    }
    if (frame.contract !== 'media') {
      failCall(frame.callId, 'PLUGIN_CONTRACT_VIOLATION', `未知契约：${frame.contract}`);
      return;
    }
    const entry = MEDIA_DISPATCH[frame.method];
    if (entry === undefined) {
      if ((MEDIA_CONTRACT_METHODS as readonly string[]).includes(frame.method)) {
        failCall(frame.callId, 'NOT_IMPLEMENTED', `media 契约未实现方法：${frame.method}`);
      } else {
        failCall(frame.callId, 'PLUGIN_CONTRACT_VIOLATION', `media 契约未知方法：${frame.method}`);
      }
      return;
    }
    if (!entry.has(media)) {
      failCall(frame.callId, 'NOT_IMPLEMENTED', `media 契约未实现方法：${frame.method}`);
      return;
    }
    const parsed = entry.params.safeParse(frame.params);
    if (!parsed.success) {
      failCall(
        frame.callId,
        'PLUGIN_CONTRACT_VIOLATION',
        `invoke.params 不符合 ${frame.method} 契约 schema`,
      );
      return;
    }
    const abort = new AbortController();
    active = { callId: frame.callId, abort };
    const ctx: MediaCallContext = {
      host,
      entryId: frame.context.entryId,
      model: frame.context.model,
      instanceId: frame.context.instanceId ?? '',
      locale: frame.context.locale,
      params: frame.context.params,
      credentials: frame.context.credentials,
      signal: abort.signal,
    };
    try {
      const output = await entry.invoke(media, ctx, parsed.data);
      const checked = entry.output.safeParse(output);
      if (!checked.success) {
        // fail-safe：不合契约的输出绝不投递（61 决策 6 / §3.2）。
        failCall(
          frame.callId,
          'PLUGIN_CONTRACT_VIOLATION',
          `${frame.method} 输出不符合契约 schema，已整体丢弃`,
        );
        return;
      }
      send({ type: 'result', callId: frame.callId, output: checked.data });
    } catch (error) {
      failCall(frame.callId, errorCodeOf(error), errorMessage(error), errorDetailsOf(error));
    } finally {
      active = null;
      limiter.discardPending();
    }
  }

  // 进程入口模式（未传通道）：done resolve 即进程生命周期结束——shutdown / 通道断开后
  // 插件进程自行退出（61 §3.1 空闲回收的「尽快退出」）。传入显式通道 = 嵌入 / 测试，
  // 进程生命周期归调用方管理。
  if (isProcessEntry) {
    void done.then(() => globalThisProcessExit());
  }

  return {
    done,
    stop() {
      offFrame();
      offClose();
      active?.abort.abort();
      finish();
    },
  };
}

function isTransport(value: PluginIpcLike | PluginFrameTransport): value is PluginFrameTransport {
  return typeof (value as PluginFrameTransport).onFrame === 'function';
}

/**
 * Node 进程（fork IPC 对端）的结构化取用：不 import NodeJS 命名空间，非 Node 环境
 * （没有 process 全局）给出可读错误。
 */
function globalThisProcess(): PluginIpcLike {
  const proc = (globalThis as { process?: PluginIpcLike }).process;
  if (proc === undefined) {
    throw new Error('当前环境没有 Node process：请显式传入 runPluginRuntime 的通道参数');
  }
  return proc;
}

/** 进程入口模式的优雅退出点（shutdown / 通道断开后的 process.exit(0)）。 */
function globalThisProcessExit(): void {
  (globalThis as { process?: { exit(code?: number): void } }).process?.exit(0);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof PluginInvokeError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'PROVIDER_UNAVAILABLE';
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : '插件方法抛错（无消息）';
}

function errorDetailsOf(error: unknown): unknown {
  return error instanceof PluginInvokeError ? error.details : undefined;
}

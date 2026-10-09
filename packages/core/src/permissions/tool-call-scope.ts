import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One executing tool call (D75 / D37 收紧：「仅这一次」= 单次工具调用).
 * `executeToolSafely` opens a scope around every tool execution — built-in
 * engine and the host MCP bridge alike — so code deep inside the tool
 * (gateway path checks, sandbox policy) can bind work to "this call" and
 * have it finalized when the call returns. Parallel tool calls each get
 * their own scope (AsyncLocalStorage follows the async chain).
 */
export interface ToolCallScope {
  /** Finalizers keyed for dedupe; run once when the tool call ends. */
  readonly onEnd: Map<string, () => void>;
  /**
   * True once the call returned. Work the tool left running in the background
   * still sees this scope; it must finalize on the spot instead of queueing.
   */
  ended: boolean;
  /**
   * W2 外部副作用台账的钩子（agent/effects/recorder.ts 经 executeToolSafely
   * 注入；没有台账时缺省）。深处的代码据此报告「这次调用将产生外部副作用」
   * （网关在沙箱外执行已批准的命令前）与「本次调用的审批」（审批行创建时）。
   */
  readonly effect?: ToolCallEffectHooks;
}

export interface ToolCallEffectHooks {
  /**
   * The call is about to leave the sandbox / machine (e.g. an approved
   * unsandboxed command). `runId`: the run doing it — ignored when it is not
   * the call's own run.
   */
  escalate(reason: string, runId?: string): void;
  /** An approval was created for this call (main.approvals.id) by `runId`. */
  noteApproval(approvalId: string, runId?: string): void;
}

const storage = new AsyncLocalStorage<ToolCallScope>();

/** Runs `fn` as one tool call; finalizers run after it settles (success or throw). */
export async function runInToolCall<T>(
  fn: () => Promise<T>,
  options: { effect?: ToolCallEffectHooks } = {},
): Promise<T> {
  const scope: ToolCallScope = {
    onEnd: new Map(),
    ended: false,
    ...(options.effect !== undefined ? { effect: options.effect } : {}),
  };
  try {
    return await storage.run(scope, fn);
  } finally {
    scope.ended = true;
    for (const finalize of scope.onEnd.values()) {
      try {
        finalize();
      } catch {
        // A finalizer failure must never turn into a tool failure.
      }
    }
  }
}

/** The tool call the current async chain belongs to (undefined outside any). */
export function currentToolCall(): ToolCallScope | undefined {
  return storage.getStore();
}

/**
 * W2 effect hooks of the tool call still in progress (undefined when outside
 * any call, or when the call already returned — background work it left
 * running must not touch its ledger row).
 */
export function activeEffectHooks(): ToolCallEffectHooks | undefined {
  const scope = storage.getStore();
  return scope !== undefined && !scope.ended ? scope.effect : undefined;
}

/**
 * Runs `fn` outside any tool call: work that is only *started* by a tool call
 * but belongs to another run (a scheduler job — a delegated / mentioned bot's
 * turn, a task, a timer delivery) must not inherit the call's scope (its once
 * grants, its effect-ledger row).
 */
export function outsideToolCall<T>(fn: () => T): T {
  return storage.exit(fn);
}

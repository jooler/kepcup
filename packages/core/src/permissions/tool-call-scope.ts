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
  /**
   * W4 审批去重门（ApprovalsService.request 在建卡前调用，`kind` 为审批类别）：
   * 同一任务链里有没有同工具、同参数的更早台账行，以及按它应当如何处理
   * （completed → mcp_tool 不建卡、DUPLICATE_EFFECT，其他类别 repeat → 建卡并
   * 提示「已执行过」；用户拒绝过的 denied → 不建卡、拒绝；uncertain → 照常建卡并
   * 提示）。null = 照常审批（无台账行、不在任务里、别的 run、参数含脱敏占位、
   * 没有可比的更早行）。
   */
  approvalGate?(runId?: string, kind?: string): EffectApprovalGate | null;
  /** W4: the call now waits on the user's decision — its ledger row is `intended`. */
  approvalWaiting?(runId?: string): void;
  /** W4: the approval was granted — the row goes back to `executing`. */
  approvalGranted?(runId?: string): void;
}

/** W4: what the approval dedupe gate found (see ToolCallEffectHooks.approvalGate). */
export interface EffectApprovalGate {
  /**
   * completed / denied: answered without a card. uncertain / repeat (a
   * completed earlier attempt of a non-MCP kind — git_remote, unsandboxed …
   * are state-dependent): a card flagged with the earlier attempt.
   */
  verdict: 'completed' | 'denied' | 'uncertain' | 'repeat';
  /** The earlier ledger row the verdict comes from. */
  prior: {
    id: string;
    status: string;
    /** Its approval (a user-denied one for `denied`). */
    approvalId: string | null;
    summary: string;
    receipt: { url?: string; externalId?: string; note?: string } | null;
    createdAt: number;
    settledAt: number | null;
  };
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

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
}

const storage = new AsyncLocalStorage<ToolCallScope>();

/** Runs `fn` as one tool call; finalizers run after it settles (success or throw). */
export async function runInToolCall<T>(fn: () => Promise<T>): Promise<T> {
  const scope: ToolCallScope = { onEnd: new Map(), ended: false };
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

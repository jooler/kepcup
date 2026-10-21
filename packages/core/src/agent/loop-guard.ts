import { createHash } from 'node:crypto';
import {
  TASK_IDLE_STOP_AFTER,
  TASK_IDLE_WARN_AFTER,
  TASK_IDLE_WINDOW_CALLS,
} from '@kepcup/shared';

/**
 * 任务空转检测（D93，docs/design/43-task-loop-harness.md §5.2）。
 *
 * 只统计「同一工具 + 同一参数 + 同一结果」的重复调用：参数或结果变化都不
 * 计数（文件被外部修改、命令输出变化不算空转）。纯逻辑，PiEngine 负责在
 * 工具执行前检查 block、执行后 record，并在收到 steer 时 reset。
 */

export interface LoopGuardOptions {
  warnAfter?: number;
  stopAfter?: number;
  windowCalls?: number;
}

export interface LoopGuardCheck {
  /** true = 不再执行本次调用（返回 LOOP_DETECTED）。 */
  block: boolean;
  /** 被阻止后仍重复：中止任务并结算为 failed。 */
  fatal: boolean;
}

export interface LoopGuardRecord {
  /** 达到提醒阈值：在本次结果末尾追加提示。 */
  warn: boolean;
  /** 窗口内同 key 的重复次数。 */
  count: number;
}

interface Entry {
  signature: string;
  resultHash: string;
}

/** 稳定键序 JSON：同一组参数无论键顺序如何都得到同一个签名。 */
export function canonicalArgs(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set())) ?? 'null';
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? null : value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, seen));
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = canonicalize(record[key], seen);
  }
  return out;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function callSignature(toolName: string, args: unknown): string {
  return digest(`${toolName}\n${canonicalArgs(args)}`);
}

export function resultHash(result: { ok: boolean; content: string }): string {
  return digest(`${result.ok ? 'ok' : 'error'}\n${result.content}`);
}

export class LoopGuard {
  readonly #warnAfter: number;
  readonly #stopAfter: number;
  readonly #windowCalls: number;
  #entries: Entry[] = [];
  #warned = new Set<string>();
  #blocked = new Set<string>();

  constructor(options: LoopGuardOptions = {}) {
    this.#warnAfter = options.warnAfter ?? TASK_IDLE_WARN_AFTER;
    this.#stopAfter = options.stopAfter ?? TASK_IDLE_STOP_AFTER;
    this.#windowCalls = options.windowCalls ?? TASK_IDLE_WINDOW_CALLS;
  }

  /** 工具执行前：窗口内同一调用已重复到中止阈值 → 阻止。 */
  check(toolName: string, args: unknown): LoopGuardCheck {
    const signature = callSignature(toolName, args);
    const last = [...this.#entries].reverse().find((entry) => entry.signature === signature);
    if (last === undefined) return { block: false, fatal: false };
    const count = this.#entries.filter(
      (entry) => entry.signature === signature && entry.resultHash === last.resultHash,
    ).length;
    if (count < this.#stopAfter) return { block: false, fatal: false };
    if (this.#blocked.has(signature)) return { block: true, fatal: true };
    this.#blocked.add(signature);
    return { block: true, fatal: false };
  }

  /** 工具执行后：记录「调用 + 结果」，达到提醒阈值时返回 warn。 */
  record(
    toolName: string,
    args: unknown,
    result: { ok: boolean; content: string },
  ): LoopGuardRecord {
    const signature = callSignature(toolName, args);
    const hash = resultHash(result);
    this.#entries.push({ signature, resultHash: hash });
    if (this.#entries.length > this.#windowCalls) {
      this.#entries = this.#entries.slice(-this.#windowCalls);
    }
    const count = this.#entries.filter(
      (entry) => entry.signature === signature && entry.resultHash === hash,
    ).length;
    const warnKey = `${signature}:${hash}`;
    const warn = count >= this.#warnAfter && !this.#warned.has(warnKey);
    if (warn) this.#warned.add(warnKey);
    return { warn, count };
  }

  /** steer / inject_task：用户新指令可能确实要求重试，计数清零。 */
  reset(): void {
    this.#entries = [];
    this.#warned.clear();
    this.#blocked.clear();
  }

  /** 测试 / 审计：当前窗口内的记录数。 */
  get size(): number {
    return this.#entries.length;
  }
}

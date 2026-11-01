import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions
} from 'node:child_process'
import { win32 as pathWin32 } from 'node:path'

/**
 * KepCup 垫片：orca 的 `@orca/process-host` / `@orca/process-host/process-spec` /
 * `@orca/process-host/windows-system-binary` 在本目录内被引用部分的同名同签名替代
 * （解耦点 1）。只实现 computer/ 编排层实际用到的导出：spawnProcess、runProcess、
 * windowsPowerShellPath 与相关类型。orca 原版的 Windows cmd-shim 解析、进程树终止、
 * 输出截断等能力不在此复制——computer-use 的宿主进程调用都是绝对路径的受控程序。
 */

export type ChildProcessHandle = ChildProcess

export type ProcessSpec = {
  /** Prefer an absolute Windows path; stripped Electron PATHs may not resolve bare names. */
  program: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number | null
  /** Written to stdin then closed. Omit to leave stdin empty and closed. */
  input?: string
  /** Cap on captured stdout/stderr; output past it is discarded. */
  maxOutputBytes?: number
  /** Aborting still resolves with the process exit result. */
  signal?: AbortSignal
  detached?: boolean
  stdio?: SpawnOptions['stdio']
}

export type PipedChildProcess = ChildProcessWithoutNullStreams

export type PipedProcessSpec = Omit<ProcessSpec, 'stdio'> & {
  stdio?: 'pipe' | ['pipe', 'pipe', 'pipe']
}

export type PipedProcessSpawner = (spec: PipedProcessSpec) => PipedChildProcess

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Callers own stream error handling; unhandled stream errors can crash the host process. */
export function spawnProcess(spec: PipedProcessSpec): PipedChildProcess
export function spawnProcess(spec: ProcessSpec): ChildProcess
export function spawnProcess(spec: ProcessSpec): ChildProcess {
  return spawn(spec.program, [...(spec.args ?? [])], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
    // GUI-subsystem parents otherwise spawn visible consoles that steal foreground input.
    windowsHide: true,
    detached: spec.detached,
    // shell:true loses argument escaping and disables windowsHide.
    shell: false
  })
}

/** Nonzero exits resolve; spawn errors reject. Mirrors @orca/process-host run-process. */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  if (spec.signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false })
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const timeoutMs = spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(spec)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const settle = (act: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      act()
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < maxOutputBytes) {
        stdout += chunk
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < maxOutputBytes) {
        stderr += chunk
      }
    })
    // Stream errors (including stdin EPIPE) are otherwise uncaught; the exit still reaches callers.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {})
    }
    if (spec.input !== undefined && child.stdin) {
      child.stdin.end(spec.input)
    } else {
      child.stdin?.end()
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    if (typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref()
    }

    child.once('error', (error) => {
      settle(() => reject(error))
    })
    child.once('close', (code, signal) => {
      settle(() => resolve({ code, signal, stdout, stderr, timedOut }))
    })
    spec.signal?.addEventListener(
      'abort',
      () => {
        child.kill('SIGTERM')
      },
      { once: true }
    )
  })
}

// --- @orca/process-host/windows-system-binary (verbatim) -------------------------

// Use Windows separators even when planning commands or testing from a POSIX host.
// Absolute system paths avoid stripped or shadowed Electron PATH entries.
function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
}

export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return pathWin32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function windowsSystem32Binary(
  fileName: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return pathWin32.join(systemRoot(env), 'System32', fileName)
}

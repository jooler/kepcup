import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from './kepcup-process-host'
import { windowsPowerShellPath } from './kepcup-process-host'
import { DesktopScriptRuntimeHost } from './desktop-script-runtime-host'
import { startServeChannel } from './desktop-script-serve-channel'
import {
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  windowsPowerShellRuntimeArgs
} from './windows-powershell-execution-policy'

/**
 * 真 PowerShell 的组帧与刷新。P0 只 vendored macOS helper；Windows `runtime.ps1`
 * 留到 P1（docs/design/52-computer-use.md §8，todo/computer-use.md「desktop-script
 * 休眠」）。脚本不在树上时 `resolveDesktopScriptProviderPath('windows')` 为 null，
 * sidecar 报 unsupported_capability，不会对一个不存在的 -File 起 PowerShell。
 * 这组用例要等脚本入库才跑。
 */
// __dirname 在 vitest 的 ESM 源码直跑下未定义，用 import.meta.url 解析同一路径。
const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../native/computer-use-windows/runtime.ps1'
)
const runtimeVendored = existsSync(SCRIPT_PATH)
const describeServe = process.platform === 'win32' && runtimeVendored ? describe : describe.skip

describeServe(
  runtimeVendored
    ? 'runtime.ps1 serve mode'
    : 'runtime.ps1 serve mode — skipped until P1 vendors native/computer-use-windows/runtime.ps1 (Windows computer use stays unavailable)',
  () => {
  let host: DesktopScriptRuntimeHost | null = null
  let spawns = 0

  function startHost(): DesktopScriptRuntimeHost {
    spawns = 0
    host = new DesktopScriptRuntimeHost(SCRIPT_PATH, {
      warn: () => {},
      spawn: (spec) => {
        spawns++
        return spawnProcess(spec)
      }
    })
    return host
  }

  afterEach(() => {
    host?.dispose()
    host = null
  })

  it('answers repeated operations from a single PowerShell process', async () => {
    const runtime = startHost()

    await expect(runtime.request({ tool: 'handshake' })).resolves.toMatchObject({
      ok: true,
      capabilities: { protocolVersion: 1, provider: 'orca-computer-use-windows' }
    })

    const apps = await runtime.request({ tool: 'list_apps' })
    expect(apps.ok).toBe(true)
    expect(Array.isArray(apps.apps)).toBe(true)

    await expect(runtime.request({ tool: 'handshake' })).resolves.toMatchObject({ ok: true })

    expect(spawns).toBe(1)
  })

  it('returns a structured error for a bad request without killing the helper', async () => {
    const runtime = startHost()

    await expect(runtime.request({ tool: 'not_a_tool' })).resolves.toMatchObject({ ok: false })
    await expect(runtime.request({ tool: 'handshake' })).resolves.toMatchObject({ ok: true })
    expect(spawns).toBe(1)
  })

  /** Send malformed JSON directly: the host only emits well-formed requests. */
  it('echoes the id it can recover when a request will not parse', async () => {
    const answer = await answerRawLine('{"tool":"handshake","requestId":7')

    expect(answer).toMatchObject({ ok: false, requestId: 7 })
    expect(String(answer.error)).not.toBe('')
  })

  it('reports an error for a line with no recoverable id', async () => {
    const answer = await answerRawLine('{"tool":"handshake"')

    expect(answer).toMatchObject({ ok: false })
    expect(answer.requestId).toBeUndefined()
    expect(String(answer.error)).not.toBe('')
  })
})

function answerRawLine(raw: string): Promise<Record<string, unknown>> {
  return new Promise((settle, fail) => {
    const channel = startServeChannel(
      {
        program: windowsPowerShellPath(),
        args: windowsPowerShellRuntimeArgs(SCRIPT_PATH, PREFERRED_WINDOWS_EXECUTION_POLICY, [
          '-Serve'
        ]),
        env: process.env
      },
      spawnProcess,
      {
        onLine: (line) => {
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(line) as Record<string, unknown>
          } catch {
            return
          }
          if (parsed.ready === true) {
            channel.write(`${raw}\n`, fail)
            return
          }
          channel.stop()
          settle(parsed)
        },
        onGone: (detail) => fail(new Error(`helper exited before answering: ${detail}`)),
        onOverflow: () => {
          channel.stop()
          fail(new Error('helper overflowed the response buffer'))
        }
      }
    )
  })
}

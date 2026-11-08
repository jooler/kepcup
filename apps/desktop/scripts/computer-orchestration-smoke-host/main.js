// computer-use 编排层冒烟宿主（D105 WP2 验收，M1 后半）。
//
// 由 computer-orchestration-smoke.mjs 以 `Electron <本目录> <appQuery>` 启动。
// 验证「main 编排层」全链路（不经 core）：
//   sidecar 产物（out/main/computer-sidecar.js，ELECTRON_RUN_AS_NODE fork）
//   → provider lifecycle（darwin 门控 → MacOSNativeProviderClient）
//   → helper spawn + unix socket + peer 校验（本宿主即父进程）
//   → dispatch 方法面（capabilities / listApps / getAppState + tree diff）
//   → 并发第二实例（进程隔离，DEV-079：单实例内互斥由单测覆盖）
//   → disconnect → shutdownProviders → helper terminate（kill switch 同路径）
//
// 退出码：0 全过；3 断言失败；1 环境错误。

const { app } = require('electron')
const { fork } = require('node:child_process')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const scriptDir = path.dirname(__filename)
const appDir = path.resolve(scriptDir, '../..')
const sidecarEntry = path.join(appDir, 'out', 'main', 'computer-sidecar.js')
const argv = process.argv.slice(2)
// P-B1（todo/computer-use-cua-adapter.md WP7 D 层）：--provider=cua 走 cua-driver
// provider（真实 CuaDriver.app daemon + TCC 归宿主）；缺省仍为原生 helper。
const providerArg = argv.includes('--provider=cua')
  ? 'cua'
  : argv.includes('--provider=native')
    ? 'native'
    : null
const positional = argv.filter((arg) => !arg.startsWith('--provider='))
const appQuery = positional[0] ?? 'Notes'
const providerEnv = providerArg ? { KEPCUP_COMPUTER_PROVIDER: providerArg } : {}
const userDataDir = path.join(require('node:os').tmpdir(), `kepcup-orchestration-smoke-${process.pid}`)

function providerProcessPattern() {
  return providerArg === 'cua' ? 'CuaDriver.app/Contents/MacOS/cua-driver' : 'orca-computer-use-macos'
}

function fail(message) {
  console.error(`[smoke2] ${message}`)
  app.exit(1)
}

function helperProcessCount() {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', providerProcessPattern()], { encoding: 'utf8' })
    return out.split('\n').filter((line) => line.trim().length > 0).length
  } catch {
    return 0 // pgrep 无匹配退出非 0
  }
}

/** fork 一个 sidecar 实例（对齐 main 侧 sidecar-client 的 fork 形态）。 */
function startSidecar(label) {
  const child = fork(sidecarEntry, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      ...providerEnv,
      KEPCUP_COMPUTER_USER_DATA_DIR: userDataDir,
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
  const pending = new Map()
  let nextId = 1
  child.on('message', (message) => {
    const entry = pending.get(message.id)
    if (entry) {
      pending.delete(message.id)
      entry(message)
    }
  })
  const call = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${label} timeout: ${method}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.send({ id, method, params })
    })
  return { child, call, label }
}

function stopSidecar(session) {
  return new Promise((resolve) => {
    session.child.once('exit', () => resolve())
    session.child.disconnect()
    setTimeout(() => session.child.kill('SIGTERM'), 3_000).unref()
  })
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`[smoke2] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const { existsSync } = require('node:fs')
  if (!existsSync(sidecarEntry)) {
    fail(`sidecar 产物不存在：${sidecarEntry}（先 pnpm --filter @kepcup/desktop build）`)
  }
  app.dock?.hide()

  const before = helperProcessCount()
  const session = startSidecar('sidecar-1')

  const caps = await session.call('capabilities')
  const expectedProvider = providerArg === 'cua' ? 'cua-driver' : 'orca-computer-use-macos'
  check(
    `capabilities 握手（provider lifecycle → ${expectedProvider}）`,
    caps.ok === true && caps.result?.provider === expectedProvider,
    caps.ok ? `${caps.result.provider} v${caps.result.providerVersion} treeDiff=${caps.result.supports?.observation?.treeDiff}` : JSON.stringify(caps.error),
  )

  const apps = await session.call('listApps')
  const appNames = apps.ok ? apps.result.apps.map((a) => a.name) : []
  check('listApps', apps.ok === true && appNames.length > 0, apps.ok ? `${appNames.length} apps` : JSON.stringify(apps.error))

  if (providerArg === 'cua') {
    // P-B1 D 层人眼可判项：截图是否可读（点击命中走 live 测试 / 真机冒烟）。
    if (apps.ok && appNames.some((name) => name.toLowerCase() === appQuery.toLowerCase())) {
      const shot = await session.call('getAppState', { app: appQuery })
      const screenshotOk =
        shot.ok === true &&
        shot.result?.screenshotStatus?.state === 'captured' &&
        typeof shot.result?.screenshot?.data === 'string' &&
        shot.result.screenshot.data.length > 0
      check(
        'getAppState 含截图（cua-driver，截图可读性人眼复核）',
        screenshotOk,
        shot.ok
          ? `state=${shot.result.screenshotStatus?.state}${shot.result.screenshotStatus?.state === 'failed' ? ` (${shot.result.screenshotStatus.message})` : ''}`
          : JSON.stringify(shot.error),
      )
    }
  }

  const running = apps.ok && appNames.some((name) => name.toLowerCase() === appQuery.toLowerCase())
  if (running) {
    const state = await session.call('getAppState', { app: appQuery, noScreenshot: true })
    check(
      'getAppState 树文本（tree diff 基线在 sidecar 内）',
      state.ok === true && typeof state.result?.snapshot?.treeText === 'string' && state.result.snapshot.treeText.length > 0,
      state.ok ? `${state.result.snapshot.elementCount} elements` : JSON.stringify(state.error),
    )
    const second = await session.call('getAppState', { app: appQuery, noScreenshot: true })
    check(
      '第二次观察走 tree diff（或不降级）',
      second.ok === true,
      second.ok ? `treeDiff=${JSON.stringify(second.result.snapshot.treeDiff ?? null)}` : JSON.stringify(second.error),
    )
  } else {
    console.log(`[smoke2] SKIP getAppState：${appQuery} 未运行`)
  }

  // 并发说明（DEV-079）：两个 sidecar 实例各自 spawn 各自的 helper（进程隔离，
  // 允许）；「单会话互斥」是同一 helper 实例内的 AgentSessionOwnership 语义
  //（macos-native-provider-client.test.ts 覆盖）。KepCup main 单例拓扑下第二个
  // sidecar 不会出现。这里只验证第二个实例同样能独立工作，随后立即回收。
  const session2 = startSidecar('sidecar-2')
  const second = await session2.call('capabilities', {}, 20_000)
  console.log(
    `[smoke2] INFO 并发第二实例（进程隔离，允许）：${second.ok ? second.result.provider : JSON.stringify(second.error)}`,
  )
  await stopSidecar(session2)

  // stop：断开 sidecar（disconnect → shutdownProviders → helper terminate）。
  const during = helperProcessCount()
  await stopSidecar(session)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const after = helperProcessCount()
  check(
    'stop 清理 helper（disconnect → terminate）',
    after < Math.max(during, before + 1),
    `helper 进程：before=${before} during=${during} after=${after}`,
  )

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`[smoke2] ${checks.length - failed.length}/${checks.length} 项通过`)
  app.exit(failed.length > 0 ? 3 : 0)
}

app.whenReady().then(main, (error) => fail(`app ready 失败：${error}`))

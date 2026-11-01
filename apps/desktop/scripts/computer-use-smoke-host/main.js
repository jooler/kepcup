// computer-use 冒烟宿主（D105 WP1）。这是真正的 Electron 主进程（com.github.Electron，
// 注册 LaunchServices）——helper 的 peer 校验（isAuthorizedAgentPeer）对 sidecar 的
// 父进程查 bundle id，AS_NODE 子进程自身在 NSRunningApplication 里是 nil，所以冒烟
// 必须经由这样的宿主 fork 客户端，等价于 dev 壳里 main fork sidecar 的真实拓扑。
//
// 由 computer-use-smoke.mjs 启动：`<Electron> <本目录> <appQuery>`。
// 职责：spawn helper（--agent socket + token 文件）→ fork 冒烟客户端
// （computer-use-smoke-client/out/main/computer-sidecar.js，Electron fork 自动带
// ELECTRON_RUN_AS_NODE=1）→ 客户端退出后 terminate helper 并退出。

const { app } = require('electron')
const { fork, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const scriptDir = path.dirname(__filename)
const appDir = path.resolve(scriptDir, '../..')
const helperAppPath = path.join(appDir, 'resources', 'computer-use', 'darwin-arm64', 'KepCup Computer Use.app')
const helperExecutable = path.join(helperAppPath, 'Contents', 'MacOS', 'orca-computer-use-macos')
const clientScript = path.resolve(scriptDir, '../computer-use-smoke-client/out/main/computer-sidecar.js')

function fail(message) {
  console.error(`[smoke] ${message}`)
  app.exit(1)
}

if (!fs.existsSync(helperExecutable)) {
  fail(`helper 未构建：${helperExecutable} 不存在——先跑 node scripts/build-computer-use-macos.mjs`)
}

app.dock?.hide()

const appQuery = process.argv[2] ?? '备忘录'
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepcup-cu-smoke-'))
const socketPath = path.join(workdir, 'agent.sock')
const tokenFile = path.join(workdir, 'agent.token')
fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), 'utf8')

const helper = spawn(helperExecutable, ['--agent', socketPath, '--token-file', tokenFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
helper.stdout.on('data', (chunk) => process.stdout.write(`[helper:out] ${chunk}`))
helper.stderr.on('data', (chunk) => process.stderr.write(`[helper:err] ${chunk}`))

console.log(`[smoke] helper pid=${helper.pid} socket=${socketPath}`)
console.log(`[smoke] host: Electron main pid=${process.pid}; client app='${appQuery}'`)

const client = fork(clientScript, [socketPath, tokenFile, appQuery], {
  stdio: 'inherit',
  env: { ...process.env },
})

let exiting = false
const finish = (code) => {
  if (exiting) return
  exiting = true
  fs.rmSync(workdir, { recursive: true, force: true })
  if (helper.exitCode === null) helper.kill('SIGTERM')
  setTimeout(() => app.exit(code), 800)
}
client.on('exit', (code) => finish(code ?? 1))
helper.on('exit', (code) => {
  if (client.exitCode === null && code !== 0 && code !== null) {
    console.error(`[smoke] helper exited early (code ${code})`)
    client.kill('SIGKILL')
  }
})

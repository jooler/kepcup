// computer-use 冒烟客户端（D105 WP1，todo/computer-use.md「独立冒烟」项）。
//
// 由 computer-use-smoke.mjs 用 Electron 的 ELECTRON_RUN_AS_NODE=1 启动（模拟
// KepCup dev 壳里 sidecar 的真实跑法）。文件路径故意是
// `.../out/main/computer-sidecar.js`：helper 的 socket peer 校验
// （main.swift isAuthorizedAgentPeer）要求连接进程命令行包含该路径模式，且进程
// 本身在受信任 app bundle 内——dev 壳 Electron（com.github.Electron）在上游信任
// 列表里。别重命名/移动本文件，否则冒烟会被 helper 以 permission_denied 拒绝。
//
// 协议：unix socket 上的 JSON-line（每行一个请求 {id, method, params, token}）。

const net = require('node:net')
const fs = require('node:fs')

const socketPath = process.argv[2]
const tokenFile = process.argv[3]
const appQuery = process.argv[4] // 冒烟目标应用（备忘录 / 计算器等）
const token = fs.readFileSync(tokenFile, 'utf8').trim()

function send(socket, id, method, params) {
  socket.write(`${JSON.stringify({ id, method, params, token })}\n`)
}

async function main() {
  // helper 的 NSApplication run loop 起 listener 需要一小会，轮询连接（对齐 orca
  // macos-native-provider-socket 的 connectSocket 重试）。
  const socket = await connectWithRetry(socketPath, 100)
  let nextId = 1
  const pending = new Map()
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, resolve)
      send(socket, id, method, params)
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout: ${method}`))
      }, 30_000).unref()
    })

  const handshake = await call('handshake', {})
  if (!handshake.ok) {
    console.log(`[smoke] handshake FAILED: ${JSON.stringify(handshake)}`)
    console.log('[smoke] → peer/token 被拒：检查客户端是否以受信任 bundle（Electron dev 壳）+ computer-sidecar.js 路径运行。')
    await finish(socket)
    process.exitCode = 3
    return
  }
  console.log('[smoke] handshake ok:', JSON.stringify(handshake.result.provider), 'protocol', handshake.result.protocolVersion)

  const apps = await call('listApps', {})
  if (!apps.ok) throw new Error(`listApps failed: ${JSON.stringify(apps.error)}`)
  const names = apps.result.apps.map((app) => app.name)
  console.log(`[smoke] listApps ok: ${names.length} apps: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ' …' : ''}`)

  const target = names.find((name) => name.toLowerCase() === appQuery.toLowerCase())
  if (!target) {
    console.log(`[smoke] SKIP getAppState: app '${appQuery}' not running (start it and rerun for the full smoke)`)
    await finish(socket)
    return
  }

  const state = await call('getAppState', { app: target })
  if (!state.ok) {
    console.log(`[smoke] getAppState FAILED: ${JSON.stringify(state.error)}`)
    console.log('[smoke] → 若为 permission_denied：系统设置 › 隐私与安全性 › 辅助功能/屏幕录制，授给「KepCup Computer Use」，然后重跑冒烟。')
    await finish(socket)
    process.exitCode = 3
    return
  }
  const snapshot = state.result.snapshot
  const treeLines = snapshot.treeText.split('\n')
  console.log(`[smoke] getAppState ok: app=${target} window="${snapshot.window.title}" elements=${snapshot.elementCount} treeText=${treeLines.length} lines`)
  console.log('[smoke] tree head:')
  for (const line of treeLines.slice(0, 12)) console.log(`    ${line}`)
  const screenshot = state.result.screenshot
  console.log(
    screenshot && screenshot.data
      ? `[smoke] screenshot ok: ${screenshot.width}x${screenshot.height} png (${Math.round(screenshot.data.length / 1024)}KB base64)`
      : `[smoke] screenshot unavailable: ${JSON.stringify(state.result.screenshotStatus)}`,
  )

  // click 冒烟（WP1 验收项）：解析 treeText 行首索引，点一个安全目标（搜索框——
  // 只是聚焦，无破坏性）；找不到就跳过。
  const searchLine = treeLines.find((line) => /^\s*\d+ search\b|search field/i.test(line))
  const searchIndex = searchLine ? Number((searchLine.match(/^\s*(\d+)/) ?? [])[1]) : undefined
  if (searchIndex === undefined || Number.isNaN(searchIndex)) {
    console.log('[smoke] SKIP click: tree has no search field')
  } else {
    console.log(`[smoke] clicking search field (element ${searchIndex}): ${searchLine.trim().slice(0, 80)}`)
    const click = await call('click', { app: target, elementIndex: searchIndex })
    if (!click.ok) {
      console.log(`[smoke] click FAILED: ${JSON.stringify(click.error)}`)
      process.exitCode = 3
    } else {
      const action = click.result.action ?? {}
      console.log(
        `[smoke] click ok: path=${action.path} action=${action.actionName ?? '-'} delivery=${action.delivery} verification=${JSON.stringify(action.verification ?? null)}`,
      )
    }
  }

  await finish(socket)
}

function finish(socket) {
  return new Promise((resolve) => {
    socket.end(`${JSON.stringify({ id: 9999, method: 'terminate', params: {}, token })}\n`, () => {
      socket.destroy()
      resolve()
    })
  })
}

function connectWithRetry(socketPath, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const retry = (reason) => {
      socket.destroy()
      if (attemptsLeft <= 0) {
        reject(new Error(`helper socket never appeared: ${reason}`))
        return
      }
      setTimeout(() => resolve(connectWithRetry(socketPath, attemptsLeft - 1)), 100)
    }
    socket.once('error', retry)
    socket.once('connect', () => {
      socket.off('error', retry)
      socket.once('error', () => {})
      resolve(socket)
    })
  })
}

main().catch((error) => {
  console.error(`[smoke] FAILED: ${error.message}`)
  process.exit(1)
})

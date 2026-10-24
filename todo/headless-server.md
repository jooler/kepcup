# Headless 服务端（D102）· 执行方案

> 状态：**P1 已实现，待真机验收**（2026-10-24 拍板并实现，设计见 [docs/design/49-headless-server.md](../docs/design/49-headless-server.md)，分支 `feat/headless-server`）。
>
> 背景讨论：用户自托管 NAS / 云服务器常驻大脑，任意位置客户端直连同一数据源，替代「桌面常开 + 公共中转遥控」的体验瓶颈。约束（用户原话归纳）：① headless 是**现有基础上的新增模式**，不破坏现有功能；② npm 包优先发行、tar 包补充，都进 GitHub CI / Release 工作流随版本发布；③ **不需要**旧数据迁移与向后兼容。

## 0 前置结论（已核实，非推测）

| 事实 | 出处 |
|---|---|
| core 全包无 `import 'electron'`；`createCoreServices` 纯 Node，外部依赖全经 `CoreServicesOptions` 注入 | `packages/core/src/start.ts:330-506` |
| hub 有 `relayClientFactory` DI 缝（测试注入假中转的同一接口）；帧处理在 envelope 层与传输无关 | `packages/core/src/remote/hub.ts:93,220-237` |
| hub 按需断线：无人用 2 分钟后 `#dropRelay('idle')`，此后 `#relay === null` 时入站帧全丢——常驻服务端必须 `alwaysOn` | `hub.ts:53,185-192,387` |
| viewer（PWA `WsTransport`）连接 URL 完全由配对链接第一段 relayUrl 决定，`ws://` 也合法 | `ws-transport.ts:885`、`shared/domain/remote.ts:81` |
| `ping` 帧由中转回 `pong`，hub 注释明确 ping/pong 不应到 anchor | `hub.ts:417`、relay-session.ts:253 |
| viewer 依赖 `viewer_left`（hub 5s 宽限清端点）与 `replaced`（避免互踢循环）信号 | `hub.ts:47,392-398`、`ws-transport.ts:1332` |
| 配对链接 `pairingQrUrl` 由 relayUrl 推导 origin（ws→http / wss→https），PWA 与中转同源托管 | `pairing.ts:85-89` |
| `createPairing`/`confirmPairing`/`devices`/`revoke` 都是 hub 公开方法，不依赖 renderer | `hub.ts:303-365`、`rpc/bindings.ts:1970-1997` |
| `createFileKeystore` 已从 `@kepcup/core` 导出（`selectKeystore` 的测试钩子分支无需动） | `core/src/index.ts:5`、`infra/keystore.ts:81` |
| 发版触发 = `apps/desktop/package.json` 版本号 + tag 不存在；publish 收集 `dist-*` 工件 | `.github/workflows/release.yml`（prepare/publish） |
| 测试矩阵在根 `vitest.config.ts` projects 列表；`run-tests.mjs` 以 Electron-as-Node 跑 | `vitest.config.ts`、`scripts/run-tests.mjs` |

## 1 Phase 1 — core 增量（默认路径零差异）

- [x] `packages/core/src/remote/hub.ts`：`RemoteHubDeps` 增 `alwaysOn?: boolean`；`#evaluateRelay` 在 `remoteEnabled && alwaysOn` 时不进 idle 拆线分支（复用既有「有用即连」路径）。
- [x] `packages/core/src/start.ts`：`CoreServicesOptions` 增 `remote?: RemoteHostOptions`（`{ alwaysOn?: boolean; relayClientFactory?: (options: RelayClientOptions) => RelayClientLike }`），传给 `RemoteHubDeps`（`start.ts:3096` 构造点）。
- [x] `packages/core/src/index.ts`：导出 `RemoteHostOptions`、`RelayClientLike`、`RelayClientOptions` 类型（server 包消费）。
- [x] 回归：`node scripts/run-tests.mjs run packages/core/test/unit/remote-hub.test.ts packages/core/test/unit/remote-codec.test.ts packages/core/test/unit/remote-devices-migration.test.ts`（31 用例全绿，hub 默认路径断言在内）。

## 2 Phase 2 — apps/server 包

- [x] `apps/server/package.json`：`@kepcup/server`，`bin.kepcup-server`，deps：`@kepcup/core`、`@kepcup/shared`、`ws`、`uqr`（终端二维码）；`test`/`typecheck` 脚本对齐 core。
- [x] `src/direct-relay.ts`：直连适配层 `DirectRelayServer`（ws server + `DirectRelayAdapter implements RelayClientLike`）：
  - 入站：`/ws/{sid}?role=viewer` 校验（sid ULID 且等于会话、role=anchor 拒、Origin 同源或缺省、单帧 ≤512KB、并发连接上限）；首个带 did 帧注册路由；`ping` → 回 `pong` info 帧；其余喂 `onFrame`。
  - 出站：`send/sendAll` 按 `envelope.did` 定向、无 did 广播。
  - 合成信号：close → `viewer_left{did}`；同 did 新连接 → 旧 socket 收 `replaced` 后关闭。
  - 生命周期：`connect()` → 监听已就绪即 `online`；`close()` 断 viewer socket 不关监听；dormant 期新连接收 `anchor_offline` 后断。
- [x] `src/server.ts` 装配：`createCoreServices({ home, keystore, appVersion, remote: { alwaysOn: true, relayClientFactory } })`；启动后 `settings.update({ remoteEnabled: true, remoteRelayUrl: publicUrl })` **并显式 `hub.syncConfig()`**（直接调 settings.update 不经 RPC 层、不广播 `settings.changed`，见实施记录）；`platform.notify` 类平台事件落日志；SIGTERM/SIGINT → `services.close()`。配对流实现在 server.ts 内（`startPairingFlow`），未单拆文件。
- [x] `src/admin.ts`：`POST /admin/pair`、`GET /admin/status`、`GET /admin/devices`、`POST /admin/devices/revoke`、`POST /admin/pairing/confirm`（manual 模式的 `pair --accept` 后端）；仅环回 + Bearer token（首启生成 0600 `<data-dir>/admin-token`）；CLI 侧薄客户端同文件。
- [x] `src/static.ts`：PWA 静态托管（`--web-dir`，默认包内 `web/`；SPA 回退 index.html、hashed 资产强缓存）。
- [x] `src/cli.ts` + bin：子命令 `run`（缺省）、`pair [--accept <requestId>] [--json]`、`devices [list]` / `devices revoke <id>`、`version`；参数解析 `src/config.ts`（node:util 风格单遍解析，环境变量 `KEPCUP_SERVER_*` 兜底）。
- [x] `apps/server/README.md`：部署指南（systemd、Caddy/nginx TLS 反代、Tailscale、内网 ws 边界、file keystore 风险、npm/tar 安装两种方式）。
- [x] `.gitignore`：`apps/server/web/`（构建产物）。

## 3 Phase 3 — 发布链路

- [x] `apps/desktop/vite.config.web.ts`：outDir 支持 `KEPCUP_WEB_OUTDIR` 覆盖（默认值不变，桌面 / 中转 Worker 路径零改动）。
- [x] `scripts/pack-server.mjs`：web 构建（`KEPCUP_WEB_OUTDIR` 改投 `apps/server/web`，须给**绝对路径**——vite 配置以 apps/desktop 为基 resolve）→ server 构建 → `pnpm deploy --prod --legacy` → 改写 `dependencies → bundledDependencies`、发布名 `kepcup-server`、版本取 desktop → chmod 入口 → `tar.gz`。
- [x] `.github/workflows/release.yml`：新增 `server` job（needs prepare；matrix linux-x64 / linux-arm64；pack → 解压冒烟（`dist/cli.js version` + `web/index.html` 在包）→ upload `dist-server-*`）；`publish.needs` 加入 `server`（`dist-*` 下载 pattern 原样收编，无需改收集逻辑）。
- [x] 根 `vitest.config.ts`：新增 `server` project（`apps/server/test/**/*.test.ts`）。
- [x] 发版验收：本地 `node scripts/pack-server.mjs` → 干净目录解压 → `./dist/cli.js version`（0.2.1）/ `devices`（正确报 ECONNREFUSED）冒烟通过（darwin-arm64 本机 tarball；linux 双架构由 CI 产出并附同款冒烟步骤）。

## 4 Phase 4 — 测试

- [x] `apps/server/test/direct-relay.test.ts`（15 用例）：真 `ws` socket 对打——升级校验（role=anchor 拒、坏 sid 拒、跨源 CSWSH 拒、dormant 收 anchor_offline）、ping→pong（不到 anchor）、did 注册与定向 / 无 did 广播、replaced、viewer_left、坏帧 bad_frame + 断开、adapter.close 转 dormant。
- [x] `apps/server/test/server-integration.test.ts`（3 用例）：临时数据目录 + memory keystore 起完整服务端 → 脚本化 viewer（core `FrameCodec` 同构编解码）走 配对（`testInjectPairingRequest` 注入 + 手动 confirm）→ accept/done 出帧 → hello 自举 → `system.ping` RPC → 断线重连（计数器续号）→ admin 401/200。两个实现期踩坑记录在案：①初始状态快照经 **rpc 帧**（birpc 推送 `q.m`）而非 event 帧下发；②配对 done 帧与 hello 后帧流是两个独立计数空间（真实 viewer 在 done 后清计数器，测试须同构换 codec）。
- [x] `apps/server/test/config.test.ts`（7 用例）：默认值、publicUrl 推导与通配 host 报错、--relay 互斥、环境变量兜底、子命令 / 非法值。实现期修掉一个真 bug：位置参数识别把 flag 的值误当子命令。
- [x] 定向收口：`node scripts/run-tests.mjs run apps/server/test packages/core/test/unit/remote-*.test.ts` 全绿（6 文件 55 用例）；`pnpm lint` / `pnpm typecheck`（含 desktop svelte-check）全绿；阶段收口 `pnpm test` 全量一次（结果见实施记录）。

## 5 验收清单（P1 Definition of Done）

1. [x] 桌面全量测试零回归（`pnpm test` 收口，见实施记录）。
2. [ ] `kepcup-server` 起服务 → 扫码 → 手机 PWA（指向自托管 origin）完成对话 + 审批 + 设置读写（**待真机验收**；等价链路已由集成测试覆盖：配对 / hello / ping / 事件 / 重连 / admin）。
3. [x] `pack-server.mjs` 产出的 tar.gz 在干净目录可直接运行（无需编译工具链；本机 darwin-arm64 验证，CI 出 linux 双架构并带冒烟步骤）。
4. [x] release.yml 逻辑核对：`dist-server-*` 命中 publish 的 `dist-*` 下载 pattern、`publish.needs` 已含 server、资产名与桌面产物无重名。

## 6 明确不做（本期）

- 旧桌面数据迁移 / 向后兼容（用户明确不需要）。
- 多租户 / 多用户路由；Docker 镜像；内置 TLS。
- 客户端能力回传（browser-over-WS）、Web Push、桌面远程模式壳（P2）。
- 服务端 MCP server 对外暴露（P3）。
- Windows headless tar（源码路径可用，文档注明）。

## 7 实施记录

- 2026-10-24：设计定稿（D102）；worktree `feat/headless-server`（基线 `e02ee7ca`）；Phase 1–4 一日落地。
  - 定向：`apps/server/test`（25 用例）+ `packages/core/test/unit/remote-*.test.ts`（31 用例）全绿。
  - 收口：`pnpm lint` / `pnpm typecheck`（含 desktop svelte-check）全绿；`pnpm test` 全量 **573 文件 6188 用例全绿零失败**（2 文件 / 37 用例既有 skip）；`pnpm test:e2e` 按 AGENTS 约定留待合并前统一跑。
  - 打包：`node scripts/pack-server.mjs` 本地产出 `kepcup-server-v0.2.1-darwin-arm64.tar.gz`（69MB，含 web PWA），干净目录解压 `./dist/cli.js version` / `devices` 冒烟通过。
  - 实现期修正（均已修）：settings.update 不经 RPC 层不广播 `settings.changed`（补 `hub.syncConfig()`）；`KEPCUP_WEB_OUTDIR` 相对路径被 resolve 到 apps/desktop 下（改绝对路径）；CLI 位置参数识别把 flag 值误当子命令（单遍解析重写）；eslint 扫到 web 构建产物 4 万+ 报错（ignores 收编）。
  - 待办：手机真机扫码验收（验收清单 #2）；首次发版时观察 CI server job 产物进 Release。

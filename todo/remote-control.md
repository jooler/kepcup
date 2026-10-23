# 远程遥控（D96）— 执行方案

> 状态：**WP1–WP6（含收口审查）+ WP7 部署已完成**（2026-10-23：`remote.kepcup.com` 已上线，版本 `31229d6e`；剩真机验收与首周用量观察）。设计见 [docs/design/46-remote-control.md](../docs/design/46-remote-control.md)（D96，先读它的 §4 架构与 §4.5 帧协议再开工）。
> 约定：迭代中只跑定向测试（AGENTS.md）；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；收口跑一次全量 `pnpm test`。Cloudflare 操作一律经 `infra/cloudflare/with-env.sh`，部署用 wrangler、其余用 `cf`。

## 0 工作包总览与依赖

```
G0 用户动作 ─┬─► WP1 shared 契约 ─► WP2 core（hub/codec/pairing/relay-client/迁移/设置目录）
             │        └──────────► WP3 中转 Worker + DO（可与 WP2 并行，联调互相等）
             └──────────────────► WP5 PWA web 构建（依赖 WP1 的 capabilities 契约）
WP2 + WP3 ─► WP4 桌面入口（设置页/托盘/二维码/设备管理） ─► WP6 联调加固 ─► WP7 部署上线
```

## G0 用户动作（Cloudflare 侧，开工前确认）✅

- [x] 确认 `kepcup.com` 账号侧允许创建 `remote.kepcup.com` custom domain（令牌 A 现有权限覆盖 Workers Scripts / DNS，理论无需新权限；若 DO 绑定需要额外权限以 `cf cli search` 结果为准）。（2026-10-23 只读自检：token verify 端点 401 但实际 API 全通——zones / accounts / workers scripts（6 个）/ workers domains / dns_records / DO namespaces 全部 200，custom domain 走 workers/domains 既有路径（registry / dl 已用）；免费套餐确认。注：本机 shell 无 `cf`/`wrangler` CLI、bash 3.2 跑不了 with-env.sh 的 `declare -A`，自检用 node 直连 API 等价完成；WP7 部署需先补 wrangler（`pnpm dlx wrangler`）。）
- [x] 决策：免费套餐起步（DO SQLite 型免费可用；WS 每消息计请求，10 万次/天）——**默认免费起步**，用量逼近再升 Workers Paid（$5/月，仅用户可操作，见 `infra/cloudflare/README.md` §4.3）。
- [x] 无需提供任何密钥：中转零持久化，不引入 VAPID（P1 推送时再要）。

## WP1 shared 契约 ✅（feat/remote-control，验收：shared 32 文件 / 390 用例全绿）

文件：`packages/shared/src/domain/remote.ts`（新）、`packages/shared/src/rpc/methods.ts`、`packages/shared/src/rpc/events.ts`、`packages/shared/src/domain/host-capabilities.ts`。

- [x] `remote.ts`：`relayEndpointSchema`、`pairedDeviceSchema`、`pairingOfferSchema`、`remoteAnchorStateSchema`、帧 envelope / handshake payload schema（pairing、hello、rpc、event、kick、ping、error；含 `frag` 分片字段与 `v` 版本）。（补充设计清单外的 `pong`/`signal` 两个 DO 自产帧类型与 `info` 明文负载；事件目录补 `remote.pairingRequested` 供确认卡）
- [x] `methods.ts`：`remote.status` / `remote.createPairing` / `remote.confirmPairing` / `remote.revokeDevice` / `remote.devices` / `remote.config.get` / `remote.config.set`，全部 zod 输入输出，登记进 `APP_RPC_METHODS`。
- [x] `events.ts`：`remote.anchorState`、`remote.deviceChanged`（+ `remote.pairingRequested`）。
- [x] `host-capabilities.ts`：远程端点能力集（`DESKTOP_ONLY_CAPABILITIES` + `endpointHasCapability`，desktop-only 项标记，供 renderer 裁剪）。
- [x] 单元：schema round-trip、方法目录完整性（`packages/shared/test/unit/remote-contracts.test.ts`）。
- 验收：`pnpm --filter @kepcup/shared build && pnpm --filter @kepcup/shared test`。

## WP2 core 收发中枢 ✅（验收：remote 定向 6 文件 67 用例 + 设置四件套 90 用例全绿）

文件：`packages/core/src/remote/`（新：`hub.ts`、`relay-client.ts`、`pairing.ts`、`codec.ts`、`audit.ts`）、`packages/core/migrations/main/0049_remote_devices.sql`、settings 目录五层（`packages/shared/src/settings-catalog/items.ts` + `packages/core/src/settings/contributions/` + 渲染层卡片 `apps/desktop/src/renderer/src/lib/features/settings-card/cards/index.ts` + `SettingCardEmbed.svelte` + 设置页锚点）。

- [x] `codec.ts`：AES-256-GCM 加解密（AAD = envelope）、双向计数器防重放（滑动窗口 64）、>128KB 分片 / 重组、8MB 逻辑上限、版本不匹配断开。Node `crypto` 实现，与手机端 WebCrypto 实现互测向量一致（`remote-codec.test.ts` 固化派生 / round-trip / 篡改 / 重放 / 分片向量；AAD 序列化两端共用 shared 的 `envelopeAadString`）。
- [x] `pairing.ts`：配对码（16B、5 分钟、一次性、内存态）；X25519 ECDH + HKDF-SHA256（`psk` 回退 HKDF(PSK)，设备行留痕）；设备登记 / 撤销 / token 哈希校验 / 重连校验（AEAD 持钥证明 + token 比对）。
- [x] `relay-client.ts`：Node 22 全局 WebSocket 外连、指数退避（上限 5 分钟）、30s 心跳、anchor join（URL role 参数）；DI 接缝支持测试注入。
- [x] `hub.ts`：端点注册表；每远程端点一个 `createRpcServer`（同一 bindings，`withRemoteSource` 包审计来源）；事件总线订阅 → `event` 帧广播；`run.progress` 合流 ≤10Hz（按 runId 分键、保留最新）；rpc 响应帧带目标 `did` 与 birpc rid。
- [x] 迁移 `0049_remote_devices.sql`：`remote_devices(deviceId PK, name, keyFingerprint, pskMode, tokenHash 可空, createdAt, lastSeenAt, revokedAt)`；密钥材料入 `secrets`（`remote:{deviceId}`），配对码不落盘；会话 id 入 `secrets`（`remote:session`，重启后遥控端免重配对）。
- [x] `audit.ts`：远程动作审计来源 `remote:{deviceId}`（AsyncLocalStorage 调用链传播，`AuditService.record/recordSystem` detail 自动带 source；已测）。
- [x] 设置目录五层：`remote.enabled` / `remote.relay` 走 `generic: true` + `field-editor`（开关不标 widensPermission——扩权发生在配对，配对与撤销是 `remote.devices` 条目 user-only + widensPermission）；设备管理专用贡献组（`contributions/remote.ts` 只读概要适配器）+ `RemoteDevicesCard` 卡片 + `SettingCardEmbed` 分支 + 设置页 `remote` 分区（`RemoteSection`，锚点 `remote-enabled` / `remote-relay` / `remote-devices`）；`EXPLICIT_ADAPTER_FALLBACK` 零静默登记。
- [x] 单元：codec（round-trip / 重放 / 回退 / 篡改 / 分片，9 用例）、hub 配对状态机与路由（广播 vs 定向 vs 合流 vs 审计来源，12 用例）、迁移升级路径（1 用例）。
- 验收：`node scripts/run-tests.mjs run packages/core/test/unit/remote-*` 全绿；设置四件套 90 用例全绿；desktop typecheck 0 错。

## WP3 中转 Worker（Cloudflare）✅（验收：DO 单测 33 用例全绿；三端本地联调随 WP6）

文件：`infra/cloudflare/relay/`（新：`wrangler.jsonc`、`src/worker.ts`、`src/relay-session.ts`、`src/envelope.ts`、`README.md`、`verify.mjs`、`public/index.html` 占位接 WP5 产物）。

- [x] `worker.ts`：`/healthz`、`/ws/{sid}` 按 `role=anchor|viewer` 路由到 DO（sid 非 ULID 400）、静态资产（SPA 回退，`run_worker_first` 保住 `/ws/*` 与 `/healthz`）、per-IP 并发会话上限（每 isolate 内存，上限 10）。
- [x] `relay-session.ts`（DO）：anchor ≤1（新 anchor 顶替旧的）/ viewers ≤5、`did→socket` 路由表；按帧类型转发（event 广播、viewer→anchor、anchor 带 did 定向、kick/error 点对点、ping→pong）；anchor 断开 → `anchor_offline` 广播 + 10 分钟保活 TTL（isolate 内 setTimeout，零 durable 写）→ `session_idle` 逐出；每连接令牌桶（30 msg/s、突发 60）、帧 ≤512KB、`v` 不识别断开；hibernation API（acceptWebSocket + tags，did 挂 attachment 跨休眠）。核心逻辑抽纯类 `RelaySessionLogic`（mock socket 测试），DO 只做接线。
- [x] 测试：33 用例（转发规则全表、多会话隔离、限流、anchor 重连 / TTL、viewer 上限 / kick / 顶替、坏帧矩阵、envelope 与 shared 契约同步守护）。**工具偏离**：设计提的 `vitest-pool-workers` 在本仓 Electron-as-Node 测试运行时下不可用 → 纯类 + mock socket（同 registry Worker 的测试取向），真实 WSS 路径留给 WP6 `wrangler dev` 联调；偏离记录在 relay README。
- [x] 本地联调形态：`wrangler dev` 起中转，core 与假 viewer 连 `ws://127.0.0.1:8977`（WP6 完成，见下）。
- 验收：DO 单测绿（33/33）；三端打通随 WP6 ✅。

## WP4 桌面入口 ✅（验收：e2e 2 用例绿 + desktop typecheck 0 错 0 警 + eslint 干净）

文件：`apps/desktop/src/main/`（tray.ts、core-host.ts、index.ts）、`src/preload/index.ts`、renderer 本机侧（`lib/features/remote/RemotePairDialog.svelte` + `remote-pairing.svelte.ts`、设置页 `RemoteSection`、`RemoteDevicesCard`、App.svelte 挂载）。

- [x] 托盘：「远程遥控」开关项 + 「连接手机…」（关闭时禁用）；状态文案后缀（未开无后缀 / 中转已连接 / 手机已连接 (n) / 中转重连中 / 中转连接异常）。状态经新增平台事件 `platform.remoteState`（shared 契约）从 core 推到主进程，core ready 时再拉一次 `remote.status` 初值；勾选动作经端口 B 的 `remote.config.set`（新登记进 `PLATFORM_RPC_METHODS`，core 侧 `createPlatformMethods` 绑定同一 hub）。
- [x] 二维码小窗：`RemotePairDialog`（App.svelte 全局挂载，托盘与设置页共用）——`remote.createPairing` 产物 QR（uqr，零依赖）+ 5 分钟倒计时 + 过期「重新生成」；`remote.pairingRequested` 事件 + 打开期间 3s 状态轮询双驱动；确认卡显示设备名 + UA 摘要，「允许 / 拒绝」走 `remote.confirmPairing`；配对成功显示 `paired:{name}`。
- [x] 设置页「远程遥控」分区（WP2 已落）+「连接手机…」按钮（`remote-pairing.svelte.ts` store 汇聚两个入口）。
- [x] e2e（Playwright）：`test/e2e/remote-control.spec.ts` 两条——开关 → 配对码 → 注入配对请求（测试缝 `remote.testInjectPairing`，仅 `__KEPCUP_TEST_HOOKS__` 装配：用当前 offer 的配对码算真实 PSK HMAC + 真 X25519 epub，走完整 `handleRequest` 路径）→ 确认卡「允许」→ 设备出现（密钥落 secrets）→ 撤销二次确认 → revokedAt 置位；开关未开时 `createPairing` 拒绝。
- 验收：`npx playwright test test/e2e/remote-control.spec.ts` 2/2 绿；desktop typecheck / eslint / prettier 干净。真实中转与手机浏览器路径归 WP6 联调。

## WP5 PWA web 构建 ✅（验收：定向 23/23 + web 冒烟 3/3 绿；desktop typecheck 0 错 0 警；Electron 构建无回归）

文件：`apps/desktop/src/renderer/src/lib/rpc/ws-transport.ts`（新）、`lib/features/web-shell/`（新：Gate / endpoint / shim / 横滑返回）、`src/web-main.ts` + `index.web.html`（新入口）、`public/`（manifest / sw.js / 图标）、`vite.config.web.ts`（产物直出 `infra/cloudflare/relay/public`）、`playwright.web.config.ts` + `test/web/smoke.spec.ts`、package.json（`build:web` / `test:web`）、`client.svelte.ts`（isWeb 分支，Electron 路径不变）+ capabilities 裁剪（Composer 附件 / FileViewer 系统打开 / 诊断日志目录 / 通用登录项与更新行 / 沙箱向导，统一置灰不隐藏）。

- [x] `WsTransport` 实现 `RpcTransport`：WebCrypto 版帧编解码（AES-256-GCM / AAD=shared `envelopeAadString` / 双向计数器+滑动窗口 64 / >128KB 分片 / 8MB 上限）+ 配对状态机（X25519 探测、psk 回退、request→accept→done、凭证入 localStorage）+ hello 重连自举 + 30s 心跳 + `anchor_offline` 等信号处理 + 事件帧→birpc 事件消息转换。socket/crypto/storage 全可注入，19 个单测含与 core `FrameCodec` 的互测向量。
- [x] capabilities 裁剪：desktop-only 项显示「仅桌面」不可用态（置灰 + aria-disabled + title），不隐藏入口。
- [x] 安全区（viewport-fit=cover + `env(safe-area-inset-*)`，standalone 模式生效）与横滑返回（web+窄屏覆盖搜索 / Bot 详情 / 窄屏设置 / 会话详情四层，集中处理不改窄屏组件）。
- [x] manifest + 图标（复用 resources 素材出 SVG+PNG）+ 添加到主屏幕引导（beforeinstallprompt）；SW 壳缓存（hash 资产 cache-first；**页面导航 network-first**——偏离任务书字面，避免部署后旧 index.html 引用已消失的 hash 资产白屏）。
- [x] Playwright 冒烟（`test:web`）：web 构建打开 → 未配对门渲染 → 假配对链接 → 设备名 → 连接失败态 + 重试。真机安装 / 真配对归 WP6 联调或 WP7 部署后验收。
- 配套修复（子代理上报的两个契约缺口，已修并加回归用例）：
  - shared `relayPairingPayloadSchema` 的 `epub`/`apub` 允许空串（psk 模式；此前 strict parse 会丢 psk 握手帧，`remote-contracts.test.ts` 补 psk 空串用例）。viewer 侧的全零占位 epub 兜底保留（无害，transcript 按线上值计算）。
  - hub 收到 hello 且端点已存在时**重建端点**（清防重放窗口；hello 解密成功即证持有密钥）——viewer 重连后计数器清零不再被判 REPLAY（`remote-hub.test.ts` 补「计数器清零重连」用例）。viewer 侧的计数器持久化 + 自愈兜底保留。

- 验收：`node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/rpc apps/desktop/src/renderer/src/lib/features/web-shell` 23/23；`pnpm --filter @kepcup/desktop test:web` 3/3；`build:web` 产物落 relay/public；`test:web` headless chromium 冒烟绿；`pnpm --filter @kepcup/desktop typecheck` 0 错 0 警；`build`（Electron）成功。

## WP6 联调加固 ✅（验收：三端集成 14/14 绿 + web 冒烟 3/3 + WP4 e2e 2/2 回归绿；修复 4 处联调暴露缺陷）

文件：`packages/core/test/integration/remote-relay.e2e.test.ts`（新，env 守卫：`KEPCUP_RELAY_E2E=1` 才跑，全量不受影响）。
形态：beforeAll 用系统 node 直跑 `wrangler-dist/cli.js dev`（apps/website 依赖带入 4.151.x；Electron-as-Node 运行时下
spawn pnpm 会 ENOENT、bin 包装器会 argv 错乱，都绕开）+ 临时 home + memory keystore 起真实 core（生产 RelayClient 路径）+
假 viewer（Node 全局 WebSocket + core FrameCodec，走完整配对协议）+ 真 web 构建（Playwright chromium 驱动 relay/public
PWA，真实 WsTransport + WebCrypto）。

- [x] 端到端全链路：配对 → RPC 定向（审计来源 `remote:{did}`）→ 事件广播 → 桌面断开/重连（anchor_offline / anchor_online 信号 + 重新自举）→ viewer 断线重连（端点重建、防重放窗口清零）→ 撤销生效（kick + revokedAt + 撤销后自举被拒）→ 中转重启（anchor 退避重连 + viewer 重自举）。
- [x] 穿透用例：重放帧（不执行、不断连）、超大帧 >512KB（error + close 1009）、错误 `v`（error + close 1008）、未配对 join（错密钥 hello 被忽略 / 坏配对码 reject / 无 anchor 会话静默）、超限 viewer（第 6 个 429）、限流（ratelimit kick + close 1008）——全部被拒且错误可见。
- [x] 多端点并发：两台遥控端同时在线，RPC 各自定向、事件按设备各封一帧都到（含 B 上线的 deviceChanged 到 A）。
- [x] 合流核对：40Hz 发 `run.progress`，viewer 实收 ≤10Hz 且保留最新，本机事件总线 40/40 零丢失（UI 无感）。
- [x] 真实 web 构建 leg：PWA 扫码 → 确认设备名 → 桌面允许 → app-shell 渲染 → 启动 RPC 在 core 上执行（审计来源正确）→ 撤销 → 页面 kicked。
- [x] 收口：一次全量 `pnpm test`——**565 文件 / 6081 用例全绿**（37 skipped 为 env 守卫用例，含本文件的 relay 集成测试；首轮暴露 public-skills 迁移回放清单缺 0049 的 `remote_devices` 摘除，已补并复跑全绿）。

联调暴露并已修复的缺陷（这正是 WP6 的价值）：

1. **中转 worker 入口不可导出常量/类**：`worker.ts` 把 `MAX_SESSIONS_PER_IP`（number）与 `IpSessionLimiter` 作为具名导出，
   workerd 要求入口导出只能是 handler 函数或绑定的 DO 类——runtime 直接拒载（部署同样会挂）。拆出 `src/ip-limiter.ts`。
2. **per-IP 名额按连接计**（`sid#seq` 键）：10 分钟 TTL 内第 11 次连接就把正常用户锁在门外，与「并发会话上限」语义相悖。
   改为名额键 = sid，同会话重连幂等续期。
3. **event 盲广播与按设备加密互斥**：DO 把 anchor 的每帧转给所有 viewer，多端点时 B 收到 A 的密文（AUTH_FAILED，web 端
   甚至被误踢）。修订为 anchor 按端点各封一帧带 `did` 定向（design §4.3 路由表已更新）+ 新增 `viewer_left` DO 信号
   （viewer 断开通知 anchor，5s 宽限 + 入站帧取消，设备列表/托盘不再虚高）。
4. **web 端两处协议 bug**（单测没抓到、真浏览器才暴露）：`x25519SharedWeb` 的 deriveBits 参数名应为 `public` 而非
   `publicKey`（ECDH 直接抛错，配对卡死）；birpc 请求参数过 JSON 时 `undefined` 变 `null`，无参方法（system.info 等
   voidInput）全被 INVALID_INPUT 拒掉且 best-effort 静默——发送前归一化回无参调用。
   另修 `App.svelte` web 分支 `{kepCupApp()}` 少 `@render`（snippet 被当表达式调用，state_unsafe_mutation 崩溃）。

- 验收：`KEPCUP_RELAY_E2E=1 node scripts/run-tests.mjs run packages/core/test/integration/remote-relay.e2e.test.ts` 14/14 绿；
  relay DO + envelope-sync + hub 单测 51 用例绿（含 viewer_left 宽限清理新用例）；ws-transport 19 用例绿；
  web 冒烟 3/3、WP4 e2e 2/2 回归绿；desktop typecheck 0 错 0 警；eslint/prettier 干净。

## WP6.5 收口前独立审查与全级别修复（2026-10-23）

WP6 收口后、WP7 动手前，拉 3 个独立子代理（core/密码学安全、中转与部署就绪度、桌面端与测试质量）对全部改动做只读交叉
审查，共 38 项发现（P0×1 / P1×5 / P2×15 / P3×17），逐条核实后全部修复：

- **P0（两个审查员独立命中，现有测试恰好固化了错误前提）**：hub 在 hello 重建端点时把出站计数归零（注释「双方回到零点」），
  而 viewer 重连会恢复持久化的入站水位——手机刷新/重连一次后新流全部被判 REPLAY，且自愈路径又恢复同一份陈旧窗口，
  livelock。修复：`FrameCodec.adoptCountersFrom`——hub 重建端点时移植旧 codec 双向计数（出站续号 + 入站窗口保留，
  顺带堵死「捕获的 hello 可被中转无限重放」的 P1）；viewer 侧入站窗口改为**每连接从零重建**（出站计数仍随凭证持久化
  单调），桌面重启（无旧端点可移植）由此兜底；`WsTransport`/`FakeViewer`/hub 测试三处同步语义并补 P0 回归用例
  （hub 侧「重连后旧 viewer codec 仍能解开续号响应」+ web 侧「桌面重启后从零的帧被接受」）。
- **P1**：配对码 HMAC 与 token 哈希改 `timingSafeEqual`；anchor 离场期间错过的 `viewer_left` 在 DO 内存暂存、回场补发；
  anchor 令牌桶按 1+viewer 数放大（定向扇出会让单连接 30 msg/s 自我踢除）；relay README 部署步骤补「先 build:web」
  （fresh clone 无 `public/` 部署必败）。
- **P2/P3 要点**：viewer WSS 升级加 Origin 同源校验（CSWSH）；从未等到 anchor 的会话按同一 TTL 逐出；anchor 被限流/
  坏帧拒绝时清路由表（死 socket 残留）；`#broadcast` 封帧异常不再被 EventBus 吞掉；AES-GCM IV 改方向标签‖计数器派生
  （消除同密钥长期使用的随机 IV 碰撞面）；分片重组补并发上限与序号越界校验（两端对齐）；`syncConfig` 非法中转地址记
  warn；`remote.testInjectPairing` 不再进远程方法表；x25519 缺共享秘密抛错（不静默退化）；epub/apub 空串本就在契约内
  （`{0,64}`）——删掉 `PSK_EPUB_PLACEHOLDER` 与 `laxAcceptPayload` 两个建立在误读上的兜底；shared `channel.call`
  无参方法零参发起（ws-transport 归一化降级为纵深防御）；配对对话框补配对链接文本 + 复制按钮（文案早承诺了这条路）；
  sw.js 导航缓存只写根路径；web 构建前清理 hash 资产；托盘「连接手机」窗口未加载完时事件改 `did-finish-load` 后补发；
  `#ensureDeviceId` 存储异常不再炸配对；DO kick 的 retryAfterMs 被 viewer 用于退避；visibilitychange 回前台立即重连；
  删死代码（`reopen`/`remoteSourceOf`/`#inflight`）与失实注释（ULID 128bit→80bit 随机段、event 广播→定向）；文档同步
  （design §4.4 重连方向、§4.5 帧清单补 pong/signal、§5.5/§7 同源托管边界、域名 .app→.com、relay README 转发表）。
- **新增覆盖**：relay `worker.test.ts`（sid/role/426/403/429/ASSETS 兜底 5 例）+ relay-session 审查修复 5 例；
  codec 审查回归 3 例（IV 确定/移植/抛错）。
- 验证：relay 46/46、core/shared remote 40/40、ws-transport+卡片+shared 单测 429/429、三端 e2e 14/14（新语义下
  FakeViewer 重连按真实路径）、WP4 e2e 2/2；**收口全量 `pnpm test` 566 文件 / 6095 用例全绿**（37 skipped 为 env 守卫）；
  desktop/shared typecheck 0 错；eslint/prettier 干净。

## WP7 部署上线

- [x] `wrangler deploy`（relay worker，含 DO migration v1）；custom domain `remote.kepcup.com`（DNS 由 wrangler 建）；静态资产 434 文件随 worker 部署。（2026-10-23 上线，版本 `31229d6e`；dry-run 先行确认 wrangler 4.151.1 接受全部配置。wrangler 用 `apps/website` 依赖带入的 4.151.1 直跑 `wrangler-dist/cli.js`——本机无全局 wrangler，且测试运行时的 Electron-as-Node 坑不适用于正常 shell。`with-env.sh` 顺手修到 stock bash 3.2 可用。）
- [x] `verify.mjs` 冒烟（`/healthz`、WSS 握手、静态资产 200）。（全部 OK；补充冒烟：跨源 Origin viewer 403、无效 sid 400、`/` 与 manifest 200。）
- [x] 线上变更记入 `infra/cloudflare/README.md` §7 与 `docs/dev/PROGRESS.md`；design 46 状态行更新（README（仓库）路线图未见远程遥控条目惯例，未加）。
- [ ] 真机验收：手机浏览器扫码 → 配对 → 完整操作清单（对话 / 远程审批 / 任务 / 工作台 / 设置读写）→ 撤销。（等用户手机实操；桌面端需先拉取本分支构建。）
- [ ] 用量观察项（免费额度）：首周看 WS 请求数趋势，逼近 10 万/天提示升级 Workers Paid。（上线后观察。）

## 风险与既有结论引用

- 免费套餐限速规则仅 1 条已被 registry 占用 → 中转限流全在 DO 内（设计 §4.3）。
- D83 的「Cloudflare 仅承担 OAuth」范围限于供应商服务，不约束本中转（设计 §10）。
- birpc / `RpcTransport` 三方法接口是传输无关的既有事实（`packages/shared/src/rpc/transport.ts`），本方案不动它。

# 远程遥控（D96）— 执行方案

> 状态：**待实施**。设计见 [docs/design/46-remote-control.md](../docs/design/46-remote-control.md)（D96，先读它的 §4 架构与 §4.5 帧协议再开工）。
> 约定：迭代中只跑定向测试（AGENTS.md）；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；收口跑一次全量 `pnpm test`。Cloudflare 操作一律经 `infra/cloudflare/with-env.sh`，部署用 wrangler、其余用 `cf`。

## 0 工作包总览与依赖

```
G0 用户动作 ─┬─► WP1 shared 契约 ─► WP2 core（hub/codec/pairing/relay-client/迁移/设置目录）
             │        └──────────► WP3 中转 Worker + DO（可与 WP2 并行，联调互相等）
             └──────────────────► WP5 PWA web 构建（依赖 WP1 的 capabilities 契约）
WP2 + WP3 ─► WP4 桌面入口（设置页/托盘/二维码/设备管理） ─► WP6 联调加固 ─► WP7 部署上线
```

## G0 用户动作（Cloudflare 侧，开工前确认）

- [ ] 确认 `kepcup.com` 账号侧允许创建 `remote.kepcup.com` custom domain（令牌 A 现有权限覆盖 Workers Scripts / DNS，理论无需新权限；若 DO 绑定需要额外权限以 `cf cli search` 结果为准）。
- [ ] 决策：免费套餐起步（DO SQLite 型免费可用；WS 每消息计请求，10 万次/天）——**默认免费起步**，用量逼近再升 Workers Paid（$5/月，仅用户可操作，见 `infra/cloudflare/README.md` §4.3）。
- [ ] 无需提供任何密钥：中转零持久化，不引入 VAPID（P1 推送时再要）。

## WP1 shared 契约

文件：`packages/shared/src/domain/remote.ts`（新）、`packages/shared/src/rpc/methods.ts`、`packages/shared/src/rpc/events.ts`、`packages/shared/src/domain/host-capabilities.ts`。

- [ ] `remote.ts`：`relayEndpointSchema`、`pairedDeviceSchema`、`pairingOfferSchema`、`remoteAnchorStateSchema`、帧 envelope / handshake payload schema（pairing、hello、rpc、event、kick、ping、error；含 `frag` 分片字段与 `v` 版本）。
- [ ] `methods.ts`：`remote.status` / `remote.createPairing` / `remote.confirmPairing` / `remote.revokeDevice` / `remote.devices` / `remote.config.get` / `remote.config.set`，全部 zod 输入输出，登记进 `APP_RPC_METHODS`。
- [ ] `events.ts`：`remote.anchorState`、`remote.deviceChanged`。
- [ ] `host-capabilities.ts`：远程端点能力集（desktop-only 项标记，供 renderer 裁剪）。
- [ ] 单元：schema round-trip、方法目录完整性（沿用现有 methods 测试模式）。
- 验收：`pnpm --filter @kepcup/shared build && pnpm --filter @kepcup/shared test`。

## WP2 core 收发中枢

文件：`packages/core/src/remote/`（新：`hub.ts`、`relay-client.ts`、`pairing.ts`、`codec.ts`、`audit.ts`）、`packages/core/migrations/main/0048_remote_devices.sql`、settings 目录五层（`packages/shared/src/settings-catalog/items.ts` + `packages/core/src/settings/contributions/` + 渲染层卡片 `apps/desktop/src/renderer/src/lib/features/settings-card/cards/index.ts` + `SettingCardEmbed.svelte` + 设置页锚点）。

- [ ] `codec.ts`：AES-256-GCM 加解密（AAD = envelope）、双向计数器防重放（滑动窗口 64）、>128KB 分片 / 重组、8MB 逻辑上限、版本不匹配断开。Node `crypto` 实现，与手机端 WebCrypto 实现互测向量一致。
- [ ] `pairing.ts`：配对码（16B、5 分钟、一次性、内存态）；X25519 ECDH + HKDF-SHA256（WebCrypto 无 X25519 的端回退 HKDF(PSK)，降级在握手帧标记）；设备登记 / 撤销 / token 哈希校验 / 重连 challenge。
- [ ] `relay-client.ts`：Node 22 全局 WebSocket 外连、指数退避（上限 5 分钟）、30s 心跳、anchor join。
- [ ] `hub.ts`：端点注册表；每远程端点一个 `createRpcServer`（同一 bindings）；事件总线订阅 → `event` 帧广播；`run.progress` 等高频事件合流 ≤10Hz；响应帧带目标 `did`。
- [ ] 迁移 `0048_remote_devices.sql`：`remote_devices(deviceId PK, name, keyFingerprint, tokenHash, createdAt, lastSeenAt, revokedAt)`；密钥材料入 `secrets`（`remote:{deviceId}`），配对码不落盘。
- [ ] `audit.ts`：远程动作审计来源 `remote:{deviceId}`（审批、设置写入、任务取消先行）。
- [ ] 设置目录：开关 + 中转地址走 `generic: true` + `field-editor`；设备管理专用贡献组与卡片；设置页锚点；`EXPLICIT_ADAPTER_FALLBACK` 不允许静默登记。
- [ ] 单元（testkit）：codec（round-trip / 重放 / 回退 / 篡改 / 分片）、pairing 状态机、hub 路由（广播 vs 定向 vs 合流）。
- 验收：定向 `node scripts/run-tests.mjs run packages/core/test/unit/remote-*`；设置四件套 `node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts packages/core/test/unit/settings-item-writes.test.ts packages/core/test/unit/settings-adapters-coverage.test.ts apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts`。

## WP3 中转 Worker（Cloudflare）

文件：`infra/cloudflare/relay/`（新：`wrangler.jsonc`、`src/worker.ts`、`src/relay-session.ts`、`README.md`、`verify.mjs`；静态资产目录接 WP5 产物）。

- [ ] `worker.ts`：WSS 升级、按 sessionId 路由到 DO；静态资产服务（hash 文件名长缓存）；`/healthz`。
- [ ] `relay-session.ts`（DO）：anchor ≤1 / viewers ≤5、`did→socket` 路由表；按帧类型转发（event 广播、viewer→anchor、anchor 带目标 did 定向、kick/error 点对点）；anchor 断开 → `anchor_offline` 广播 + 10 分钟保活 TTL；每连接令牌桶（30 msg/s、突发 60）、帧 ≤512KB、每 IP 并发会话上限；**无 durable 写、不记录 IP**。
- [ ] 测试：`vitest-pool-workers`——多会话隔离、限流、anchor 重连、viewer 上限 / kick、`ping` 活性。
- [ ] 本地联调形态：`wrangler dev` 起中转，core 与假 viewer 连 `ws://127.0.0.1:8787`。
- 验收：DO 单测绿；本地三端（core + 双假 viewer）打通配对 → RPC → 广播。

## WP4 桌面入口

文件：`apps/desktop/src/main/`（托盘、二维码小窗）、renderer 本机侧（设置页「远程遥控」分区、配对确认卡、设备管理）。

- [ ] 托盘：「远程遥控」开关项 + 「连接手机…」；状态文案（未开 / 已连 (n) / 重连中）。
- [ ] 二维码小窗：展示 `remote.createPairing` 产物倒计时；确认卡显示设备名 / UA 摘要。
- [ ] 设置页「远程遥控」分区渲染（锚点对齐 WP2 的设置目录条目）；设备管理列表（名称、最后在线、撤销按钮、撤销二次确认）。
- [ ] e2e（Playwright）：开关 → 生成配对码 → mock 确认 → 设备出现 → 撤销。
- 验收：`node scripts/run-tests.mjs run apps/desktop/test/e2e`（新增用例）。

## WP5 PWA web 构建

文件：renderer 构建配置（vite 多 target 或 `apps/remote`）、`apps/desktop/src/renderer/src/lib/rpc/`（`WsTransport`）、manifest / 图标 / SW 壳。

- [ ] `WsTransport` 实现 `RpcTransport`（post/onData/close + 重连自举触发）。
- [ ] capabilities 裁剪：desktop-only 项显示「仅桌面」不可用态（不隐藏入口）。
- [ ] 安全区（`env(safe-area-inset-*)`）与横滑返回；D82 窄屏布局直接复用。
- [ ] manifest + 图标 + 添加到主屏幕引导；P0 的 SW 只做静态壳缓存。
- [ ] Playwright 冒烟：web 构建打开 → 配对态渲染 → 假 anchor 下对话收发。
- 验收：手机真机浏览器可安装、可完成配对（依赖 WP3 本地联调或已部署环境）。

## WP6 联调加固

- [ ] 端到端全链路（miniflare + core + web 构建）：配对 → 对话收发（流式）→ 远程审批 → 任务分派 / 进度广播 → 断线（手机 / 桌面 / 中转分别断）→ 重连自举 → 撤销生效。
- [ ] 穿透用例：重放帧、超大帧、错误 `v`、未配对 join、超限 viewer、限流触发——全部被拒且错误可见。
- [ ] 多端点并发：两台遥控端同时在线，事件都到、RPC 各自定向。
- [ ] 合流核对：长任务 `run.progress` 帧率 ≤10Hz，UI 无感。
- [ ] 收口：一次全量 `pnpm test`。

## WP7 部署上线

- [ ] `wrangler deploy`（relay worker，含 DO migration）；custom domain `remote.kepcup.com`（DNS 由 wrangler 建）；静态资产随 worker 部署。
- [ ] `verify.mjs` 冒烟（`/healthz`、WSS 握手、静态资产 200）。
- [ ] 线上变更记入 `infra/cloudflare/README.md` §7 与 `docs/dev/PROGRESS.md`；README（仓库）路线图加条目。
- [ ] 真机验收：手机浏览器扫码 → 配对 → 完整操作清单（对话 / 远程审批 / 任务 / 工作台 / 设置读写）→ 撤销。
- [ ] 用量观察项（免费额度）：首周看 WS 请求数趋势，逼近 10 万/天提示升级 Workers Paid。

## 风险与既有结论引用

- 免费套餐限速规则仅 1 条已被 registry 占用 → 中转限流全在 DO 内（设计 §4.3）。
- D83 的「Cloudflare 仅承担 OAuth」范围限于供应商服务，不约束本中转（设计 §10）。
- birpc / `RpcTransport` 三方法接口是传输无关的既有事实（`packages/shared/src/rpc/transport.ts`），本方案不动它。

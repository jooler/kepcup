# Headless 服务端（D102）

> 状态：**P1 已实现，待真机验收**（2026-10-24 拍板并实现，分支 `feat/headless-server`，执行方案与验收记录见 [todo/headless-server.md](../../todo/headless-server.md)）。

## 0 摘要

把「大脑」从桌面搬进用户自托管的常驻进程：`kepcup-server`（npm 包 / tar 包，跑在 NAS 或云服务器上）内嵌与桌面完全相同的 core（`createCoreServices`，纯 Node、零 Electron 依赖），对外一个端口同时提供——

- **直连 WebSocket 入口**：手机 PWA / 桌面 web 构建 / 任意位置的客户端**直连**服务端（不经公共中转），帧协议、配对、E2E 加密、RemoteHub 端点全部复用 D96 既有实现；
- **PWA 静态托管**：web 构建产物由服务端同源托管，配对链接指向服务端自身 origin，扫码即用；
- **本机 admin 接口**：配对出码、设备管理（CLI 子命令 `kepcup-server pair / devices` 的后端）。

桌面应用路径零改动：headless 是**新增的宿主形态**，不是重构。现有按需断线（idle 驻留）策略对常驻服务端不适用，通过 hub 新增 `alwaysOn` 选项（默认关）解决。不做数据迁移与向后兼容（明确非目标）；不做多租户（单用户单实例，多人 = 多实例多端口）。

动机：D96 远程遥控缓解了「人在外面」的问题，但体验受制于两点——桌面必须醒着在线（核心可用性瓶颈）、流量绕公共中转多一跳。用户把 headless 版跑在 NAS / 云服务器上后，任何客户端从任何位置连的都是同一个常驻大脑，数据不一致在构造上不存在；部署无 UI、无 Docker，`node >= 22.19` 单依赖。

## 1 决策（D102）

1. **新增宿主，不动桌面**：core 已与 Electron 解耦（全包无 `import 'electron'`，`createCore` 已在纯 Node 进程内跑）。headless = `apps/server` 新包 + core 三处**增量**改动（`RemoteHostOptions` 选项、hub `alwaysOn`、类型导出），全部默认关闭 / 默认值不变。
2. **直连为主、中转为辅**：服务端默认内嵌**直连监听适配层**（实现 hub 既有 `RelayClientLike` DI 缝——测试注入假中转用的同一接口）：本地起 WS server，按帧类型 + `did` 路由，synthesize `pong / viewer_left / replaced` 信号。viewer（PWA 的 `WsTransport`）**零改动**——连接 URL 完全由配对链接第一段决定，指向 `ws(s)://<服务端>` 即直连。`--relay <url>` 保留公共/自建中转出站模式（现有 RelayClient 路径），覆盖不开端口的部署。
3. **单端口三职责**：`/ws/{sid}?role=viewer`（WS 升级）+ `/`（PWA 静态托管，SPA 回退）+ `/admin/*`（仅环回 + token）。TLS 不内置，交反代（Caddy/nginx）或 Tailscale 场景，文档给配置样例。
4. **配对复用、确认自动化可选**：`PairingService` / 配对链接（`pairingQrUrl`）原样复用。headless 无本机 UI，默认 **auto-accept**（16B 一次性配对码即带外授权，持码者 ≡ 管理员；码 5 分钟一次性）；`--pairing-manual` 回退手动确认（CLI 列出待确认请求再 accept）。首启无设备时自动循环出码打印（URL + 终端二维码），有设备后不再自动出码。
5. **keystore 策略**：默认尝试系统钥匙串（Linux = Secret Service）；不可用时**显式失败**并提示 `--keystore file`——file keystore（0600）作为 headless 生产路径直接注入 `CoreServicesOptions.keystore`（`selectKeystore` 的测试钩子分支不动）。明文密钥文件的风险在部署文档中明示。
6. **能力降级而非模拟**：port B 宿主能力（browser×15 / shell.openExternal / widgetPreview.run）保持未绑定——浏览器工具返回 `BROWSER_UNAVAILABLE`（既有降级）；`platform.notify` 落日志。依赖本地环境的客户端能力回传（browser-over-WS、客户端技能经 MCP 管道挂载）是 P2，不在本期。
7. **发布形态**：单一产物双用法——CI 在 linux-x64 / linux-arm64（NAS 主场景）runner 上 `pnpm deploy` 出自包含目录（workspace 依赖内联、原生模块按平台预构建），改写 `dependencies → bundledDependencies` 后打成 `kepcup-server-v{v}-{platform}-{arch}.tar.gz`，同一文件支持 `npm i -g <url>`（npm 方式，优先）与下载解压直接跑（tar 方式，补充）；进 `release.yml` 既有 `dist-*` 工件流，随桌面版一起发 GitHub Release。桌面版本号仍是唯一发版触发（未另设 server 版本轨道）。
8. **永不做**（本设计范围内）：多租户 / 多用户路由、旧桌面数据迁移工具、Docker 镜像、内置 TLS 证书管理。

## 2 目标与非目标

### 2.1 目标（P1）

- `kepcup-server` 一条命令起服务：`kepcup-server --data-dir ~/.kepcup-server`（或全默认）→ 监听、打印配对二维码 → 手机扫码 → 完整客户端可用（对话、审批、工作台、设置——与 D96 手机端同一份 `APP_RPC_METHODS`）。
- 常驻可用：调度、邮件轮询、watch 等在服务端 7×24 跑；客户端断线重连自举（既有 hello/token 重连路径）。
- 不破坏现状：桌面全部测试与行为不变；core 改动默认路径零差异；新增代码全部在 `apps/server` + 三处增量。
- CI/Release 自动化：发版时 server 产物随桌面产物一起出现在 GitHub Release。

### 2.2 非目标

- 旧数据迁移 / 向后兼容（用户明确不需要；服务端从空库开始）。
- 多租户：一个数据目录 = 一个用户一份 core；多人多实例。
- 客户端本地能力回传（浏览器、本地 skills 在客户端执行并回传）——P2 另案。
- 服务端工具以 MCP server 形式对第三方 agent 暴露（HostMcpBridge 扩展）——P3 另案。
- 离线 Web Push（客户端不在线时的事件推送）——P2；v1 靠重连自举 + `approvals.list`（落库）。

## 3 架构

### 3.1 进程形态

```
NAS / 云服务器（常驻，node >= 22.19）
┌────────────────────────── kepcup-server（单进程）──────────────────────────┐
│  createCoreServices(home=~/.kepcup-server, keystore=system|file,           │
│                     remote={alwaysOn:true, relayClientFactory:直连适配层}) │
│    ├─ 全部业务域（对话 / 调度 / 邮件 / MCP / 审批 / 沙箱降级）              │
│    └─ RemoteHub（端点注册表 / 事件扇出 / remote.*，D96 原样）               │
│  HTTP server（单端口，默认 8642）                                          │
│    ├─ GET /ws/{sid}?role=viewer  → WS 升级 → 直连适配层（did 路由）        │
│    ├─ GET /*                      → PWA 静态托管（web 构建产物，SPA 回退） │
│    └─ /admin/*（仅 127.0.0.1 + Bearer token）→ pair / status / devices     │
└────────────────────────────────────────────────────────────────────────────┘
        ▲ 直连 WS（E2E 帧协议，D96 codec）         ▲ HTTP(S)
   手机 PWA / 桌面浏览器 / 任意设备              CLI 子命令（pair/devices）
```

进程内没有 renderer、没有 Electron 主进程：`appMethods` 只服务远程端点（hub `#createEndpoint` 包装、剔除 `LOCAL_ONLY_METHODS`，既有逻辑）；port B 的宿主方法不绑定（降级见 §3.4）。

### 3.2 直连适配层（本设计唯一的新传输代码）

hub 的 `relayClientFactory` DI 缝（`remote/hub.ts`，测试注入假中转的同一接口）注入 **DirectRelayAdapter**：

- **入站**：WS server 接受 `/ws/{sid}?role=viewer`（sid 必须 ULID 且等于本会话；role=anchor 拒绝——anchor 是本进程）。每条连接首个带 `did` 的帧注册进 `did → socket` 路由表；`ping` 帧直接回 `pong` info 帧（hub 注释明确 ping 不该到 anchor）；其余帧原样喂 `onFrame`（hub 的 pairing / hello / rpc / event 处理零改动）。
- **出站**（`send / sendAll`）：按 `envelope.did` 定向到 socket；无 `did` 广播（实际扇出帧恒带 did）。
- **合成信号**：socket close → `signal viewer_left {did}`（hub 5s 宽限清端点，既有语义）；同 did 新连接 → 先给旧 socket 发 `signal replaced` 再关闭（viewer 依赖它避免互踢循环）。
- **生命周期**：`connect()` → 监听已就绪即 `onStateChange('online')`（监听 socket 属于 server 应用，比 hub 会话活得久）；`close()` 只断 viewer socket（hub 因关开关 / 换地址拆线时，新连接在 hub 重新建连前收到 `anchor_offline` 后断开，viewer 进入等待重连态）。
- **边界防护**（对齐中转 Worker 的最低集）：单帧 ≤512KB、并发连接数上限、Origin 校验（同源或缺省，防 CSWSH）、sid/role/版本不合法即断。令牌桶限流不搬（直连场景由反代 / 内网边界承担）。

**hub 增量——`alwaysOn`**：`RemoteHubDeps.alwaysOn?: boolean`（默认 false）。`#evaluateRelay` 在 `remoteEnabled && alwaysOn` 时永不进入 idle 拆线分支（常驻监听零边际成本，且 hub 在 `#relay === null` 时丢弃入站帧，常驻服务端不能进入该状态）。桌面路径（默认 false）行为逐字节不变。

### 3.3 配对与管理

- **设置自举**：服务端启动时 `settings.update({ remoteEnabled: true, remoteRelayUrl: <publicUrl> })`（headless 下服务端配置是唯一事实来源；`settings.changed` 事件触发 hub 重估，既有机制）。`publicUrl` 由 `--public-url` 给出（wss://nas.example.com 反代场景），缺省从 `--host/--port` 推导（`ws://<host>:<port>`，host 为通配地址时必须显式给）。配对链接的 origin 由 `pairingQrUrl` 从 relayUrl 推导（ws→http / wss→https），因此 **publicUrl 的 origin 必须能打开本服务**（反代同源转发或直连）。
- **首配**：启动时 `devices()` 为空 → 自动 `createPairing()` 并打印 URL + 终端二维码；`--pairing-manual` 时不 auto-accept，轮询打印待确认请求，由 `kepcup-server pair --accept <requestId>` 确认。出码 5 分钟过期自动续（无设备期间）。
- **admin 接口**：`POST /admin/pair`（出码）、`GET /admin/status`、`GET /admin/devices`、`POST /admin/devices/revoke`。仅接受环回地址 + `Authorization: Bearer <token>`；token 首启生成、0600 存 `<data-dir>/admin-token` 并打印。CLI 子命令（`pair` / `devices`）是 admin 接口的薄客户端。
- **认证边界**：业务流量 = D96 既有边界（配对设备 + AEAD + token 重连 + 审计标记）；admin = 环回 + token（管理面不暴露到网络）。

### 3.4 能力降级与安全

| 能力 | 桌面 | headless 服务端 |
|---|---|---|
| 浏览器工具（15 个） | Electron WebContentsView + CDP | 未绑定 → `BROWSER_UNAVAILABLE`（既有降级路径） |
| `shell.openExternal` / `widgetPreview.run` | 主进程实现 | 未绑定，调用返回不可用 |
| `platform.notify`（系统通知） | 主进程弹通知 | 落结构化日志（不阻塞既有事件流） |
| 沙箱命令执行 | 宿主后端（srt/WSL/…） | 探测宿主环境，无后端时落既有确认模式白名单（`KEPCUP_SANDBOX=off` 可整体关闭） |
| 审批 | 桌面弹卡 | 远程客户端弹卡（`approvals.decide` 既有 RPC）；无人值守用既有 `UnattendedService` |
| 密钥 | OS 钥匙串 | 系统钥匙串（Linux Secret Service）或 file keystore（0600 明文，文档明示风险） |

安全模型不变的部分：帧负载 E2E 加密（中转/反代不可信前提继续成立——反代只见密文路由头）；secrets 卫生规则（D96 决策 6）对远程端点统一适用。新增注意点写入部署文档：公网直连必须 TLS（反代）、明文 ws 仅限可信内网、admin token 与 file keystore 的文件权限。

### 3.5 与桌面的关系

- 桌面应用 = 现状不动（本机 core 宿主）。桌面与 headless 服务端**不互通、不同步**（单一大脑原则：用户选定哪个设备当大脑，其他都是客户端）。
- 桌面作为 headless 客户端：打开服务端托管的 PWA（浏览器 / PWA 安装）即是——web 构建与 Electron renderer 同源（D96 WP5）。独立「桌面远程模式」壳（Electron 里加载远程端点）留 P2 便利项。

## 4 发布与部署

- **产物**：`kepcup-server-v{version}-{platform}-{arch}.tar.gz`，内容为自包含包（`bin/kepcup-server` + `dist/` + `web/`（PWA）+ `node_modules/`（bundledDependencies 内联，原生模块为该平台预构建产物））。同一文件两种用法：
  - npm 方式（优先）：`npm i -g https://github.com/…/releases/download/v{v}/kepcup-server-v{v}-linux-x64.tar.gz`
  - tar 方式（补充）：下载解压，`./bin/kepcup-server` 直接跑（离线可装）。
- **CI/Release**：`release.yml` 新增 `server` job（needs prepare；matrix linux-x64 / linux-arm64）：`pnpm install → pnpm -r build → KEPCUP_WEB_OUTDIR=… build:web → scripts/pack-server.mjs → 上传工件 dist-server-{platform}[-{arch}]`。publish job 的 `dist-*` 下载 pattern 原样收编（无需改动收集逻辑，`needs` 加 server 即可）。`ci.yml` 无需新 job——lint/typecheck/test 覆盖新包。
- **平台矩阵**：linux-x64 / linux-arm64（NAS 主场景）。其余平台走源码路径（`pnpm --filter @kepcup/server start`），文档注明。
- **部署文档**（`apps/server/README.md`）：systemd 单元样例、Caddy/nginx 反代 TLS 样例、Tailscale 场景说明、内网直连（ws + E2E）边界说明。

## 5 测试与验收

- **单元**（`apps/server/test/`）：直连适配层路由（did 定向 / 广播 / pong 回复 / viewer_left / replaced / 越界帧拒绝）用真 `ws` socket 对打；CLI 参数解析。
- **集成**：临时数据目录 + memory keystore 起完整服务端 → 用 core 的 `FrameCodec` + `PairingService` 原语编写脚本化 viewer 客户端走完 配对（auto-accept）→ hello 自举 → `system.ping` RPC → 事件扇出 → 断线重连 全链路。
- **回归**：core 定向测试（remote / settings 相关文件）+ hub 默认路径（alwaysOn=false）行为不变；阶段收口跑一次全量。
- **发版验收**：本地跑 `scripts/pack-server.mjs` 产出 tar.gz，解压后在干净目录 `./bin/kepcup-server` 冒烟（起服务、出码、admin pair）。

## 6 分期

- **P1（本期）**：上述全部。core 改动 = `RemoteHostOptions`（start 选项）+ hub `alwaysOn` + 类型导出；其余在 `apps/server`。
- **P2**：客户端本地能力回传（browser-over-WS：直连富客户端声明能力，core 的 deferred facade 绑定到该客户端通道）；离线 Web Push；桌面「远程模式」壳。
- **P3**：服务端工具以 MCP server 对外暴露（HostMcpBridge 模式扩展，token 认证）；多实例管理 CLI。

# relay — 远程遥控中转（`remote.kepcup.com`）

D96 远程遥控的**公共哑中转**（设计 46 §4.3 / §7，执行方案 `todo/remote-control.md` WP3）：Cloudflare Worker + Durable Object。
桌面（anchor）与每个遥控端（viewer）各连一条 WebSocket，中转按 envelope 明文头转发帧，**不理解内容**——负载全程端到端加密，
中转不可信。**零持久化**：无 durable 写、不记录 IP、不落任何日志存储；会话 id 是不可猜的 ULID，多用户靠每会话一个 DO 实例天然隔离。

```
infra/cloudflare/relay/
  wrangler.jsonc    Worker + DO 绑定（RELAY_SESSION）+ 静态资产 + 路由 remote.kepcup.com
  src/worker.ts     入口：/healthz、/ws/{sid}?role=anchor|viewer → DO（ULID 校验、per-IP 会话上限）、其余走资产
  src/relay-session.ts RelaySessionLogic 纯类（全部路由/生命周期/滥用防护）+ RelaySession DO 接线（hibernation API）
  src/envelope.ts   自包含的 envelope 视图与协议常量（packages/shared/src/domain/remote.ts 的手工副本，测试守护同步）
  src/cf-types.d.ts 本地声明的最小 Cloudflare 类型（真实的 @cloudflare/workers-types 可直接替换）
  public/           PWA 构建产物（`pnpm --filter @kepcup/desktop build:web` 产出，不入 git——部署前必须先构建）
  verify.mjs        部署后冒烟：/healthz、静态资产 200、WSS 握手（WP7 用）
  tsconfig.json     独立类型检查：npx tsc -p infra/cloudflare/relay --noEmit（不在 pnpm 工作区内）
  test/             vitest（根 vitest.config.ts 的 `infra-relay` 项目）+ mock socket / 假时钟
```

## 转发规则（设计 §4.3 的表，验收基准）

| 帧类型 | 来源 | DO 动作 |
| --- | --- | --- |
| `event`（带目标 did） | anchor | 定向给该 viewer；**未注册 did 静默丢弃**（E2E 按设备加密，见偏离 6） |
| `event`（无 did，协议保留） | anchor | 广播给全部 viewers（密文原样透传） |
| `rpc` / `pairing` / `hello` | viewer | 转发给 anchor；首个带 did 的帧把 did 注册进路由表 |
| `rpc`（带目标 did） | anchor | 定向给该 viewer；**未注册 did 静默丢弃** |
| `kick` / `error`（带目标 did） | anchor | 定向给该 viewer（kick 送达后关闭目标连接，释放名额） |
| `ping` | 任一 | 应用层回 `pong`（维持 hibernation 活性；也消耗令牌桶） |

- viewer 伪造的 `event` / `kick` / `error` / `signal` / `pong` 一律丢弃。
- anchor ≤1：第二个 anchor 顶掉旧的（旧连接收 `signal replaced` 后关闭）；同 did 的新 viewer 连接同理顶掉旧连接。
- DO 自产帧（`pong` / `signal` / 服务端 `kick` / `error`）负载走 envelope 的 `info` 明文字段（结构对齐 shared 的
  `relayInfoSchema`），`n` 恒 0，永不含密钥 / token。

## 生命周期与滥用防护

- **生命周期**：anchor 断开 → viewers 收 `signal anchor_offline`；DO 保活 TTL 10 分钟等桌面重连（重连 → `signal anchor_online`）；
  到期 `signal session_idle` 并关闭全部；全空即逐出（DO 无 durable 写，重建零成本）。从未等到 anchor 的 viewer 会话
  同样按 10 分钟上限逐出（不能靠 ping 无限续住；hibernation 唤醒后该计时丢失，尽力而为）。
- **滥用防护**（全在 DO / Worker 内，免费套餐全站限速规则已被 registry 占用）：每连接令牌桶（持续 30 msg/s、突发 60；
  anchor 按 1+viewer 数放大——同一事件按端点各封一帧，定向扇出不应把桌面自己踢下线，超限 `kick info.ratelimit` 后断开）；
  单帧（序列化后）≤ 512KB（超限 `error info.bad_frame` + 1009）；每会话 viewers ≤5（满员在 WSS 升级前 429）；
  Worker 每 isolate per-IP 并发会话上限 10（内存 Map）；viewer 的 WSS 升级要求 Origin 缺省（Node 客户端）或与站点同源
  （CSWSH 防护，跨源网页不能拿访客 IP 占名额）；协议版本 `v` 不识别即断开（不做静默降级）。
- **成员资格校验在中转之外**：DO 只防会话 id 枚举与滥用；join 后的合法性由 anchor 在 E2E 帧内校验（加密 hello 自证
  密钥持有 + token 哈希比对），失败由 anchor 发 `kick`（设计 §4.3）。

## 本地联调（`wrangler dev`）

```bash
cd infra/cloudflare/relay
npx wrangler dev            # 默认 127.0.0.1:8787;DO 与静态资产都在本地模拟
```

- 桌面 core（WP2 的 `relay-client`）外连 `ws://127.0.0.1:8787/ws/{sessionId}?role=anchor`（sessionId 是 ULID 形状的 26 位串）。
- 假 viewer 连 `ws://127.0.0.1:8787/ws/{sessionId}?role=viewer`，第一个带 `did` 的帧注册进路由表。
- `curl http://127.0.0.1:8787/healthz` → 200 `ok`；`/` → 占位页（SPA 回退对所有未命中路径生效）。
- 本地冒烟：`node infra/cloudflare/relay/verify.mjs http://127.0.0.1:8787`。

## 测试

```bash
# 仅在 Docker 中（见 docs/dev/05-testing.md / AGENTS.md）
node scripts/run-tests.mjs run infra/cloudflare/relay
# 类型检查（宿主机）
npx tsc -p infra/cloudflare/relay --noEmit
```

测试不依赖 wrangler / miniflare / 网络：`RelaySessionLogic` 是纯类（构造注入 socket 抽象与定时器），用内存 mock socket +
假时钟驱动；`test/envelope-sync.test.ts` import `@kepcup/shared` 钉住 relay 侧副本与 shared 契约不漂移。

## 部署（用户操作，见 `infra/cloudflare/README.md` 的令牌与约定）

> Agent 只准备材料；Cloudflare 操作经 `infra/cloudflare/with-env.sh`，部署用 wrangler。**不要把 API token 写进仓库。**

0. 先构建 PWA 产物（`public/` 整体由构建产出、不入 git，fresh clone 没有它则 `assets.directory` 不存在、部署必败）：
   `pnpm --filter @kepcup/desktop build:web`（产物输出到本目录 `public/`）。
1. 令牌 A（`kepcup-deploy`）现有权限已覆盖 Workers Scripts / DNS（DO 绑定不额外要权限）；令牌经 `.env` 提供。
2. `cd infra/cloudflare/relay && npx wrangler deploy --dry-run`，确认后 `npx wrangler deploy`——DO migration（`v1` /
   `RelaySession`）随首次部署生效；custom domain `remote.kepcup.com` 的 DNS 记录与证书由 wrangler 自动创建。
3. 冒烟：`node infra/cloudflare/relay/verify.mjs`（/healthz、静态资产 200、WSS 握手）。
4. 免费套餐：DO SQLite 型免费可用；WebSocket 每消息计一次请求，免费 10 万次/天，首周观察用量（设计 §7），逼近再升
   Workers Paid（$5/月，仅用户可在控制台操作）。
5. PWA 产物更新：重跑步骤 0 再 `wrangler deploy` 即带上新资产（构建会先清掉上一轮的 hash 资产，见
   `apps/desktop/vite.config.web.ts`）。托管路径约定为站点根（manifest / SW / start_url 都是根绝对路径）。

## 与设计的偏离记录

1. **测试工具**：设计 §8 建议用 `vitest-pool-workers`（miniflare）测 DO；本仓测试跑在 Electron-as-Node 运行时下
   （`scripts/run-tests.mjs`，见 `docs/dev/05-testing.md`），miniflare 不可用。因此核心路由逻辑抽成纯类
   `RelaySessionLogic`（socket / 定时器抽象注入），DO 类只做接线；多会话隔离、限流、生命周期、viewer 上限全部在纯类上
   验证，DO 接线层（hibernation 唤醒重建）留给 WP6 联调（真实 `wrangler dev` + 双假端点）。
2. **viewer 的 hibernation tag**：设计写 `view:{did}`，但 did 只在首帧出现，而 `acceptWebSocket` 的 tags 在 accept 后不可变
   ——accept 时标 `view:pending`，did 登记后挂到 socket 的 **attachment**（`serializeAttachment`，跨 hibernation 随连接存活，
   不写 DO storage），唤醒重建时据此恢复路由表。anchor 的 tag `anchor` 与设计一致。
3. **per-IP 名额的递减**：Worker 把 DO 返回的 101 直通浏览器后观察不到连接关闭，「连接关闭时递减」无法实现——名额改为按
   会话最长寿命（anchor TTL 10 分钟）过期，近似并发上限；仍为每 isolate 内存 Map、不落盘。窗口内正常重连不受影响。
4. **anchor TTL 用 isolate 内 `setTimeout`**：设计要求无 durable 写，因此不用 `storage.setAlarm`；DO hibernation 会丢弃定时器
   （有 viewer 消息唤醒时连接重建、语义自愈），session_idle 信号是尽力而为——纯遥控器方案下 viewer 本就以 anchor 在线为准。
5. **kick 送达后关闭目标 viewer**：设计表只写「定向给目标 viewer」；实现额外关闭连接以释放 viewer 名额（§4.4 撤销链路的
   自然收尾，中转侧仍无需任何撤销名单）。
6. **event 定向而非盲广播**（WP6 三端联调修订，设计 §4.3 路由表已更新）：E2E 按设备加密，一帧密文只能服务一个端点；
   DO 对 event 盲广播会把 A 的密文转给 B（B 解不开，多端点下互相污染甚至被误踢）。anchor 按端点各封一帧带 `did` 定向，
   DO 只对无 did 的 event（协议保留）广播。
7. **新增 DO 自产信号 `viewer_left`**（WP6）：viewer 断开时定向通知 anchor，桌面清端点（5s 宽限 + 入站帧取消），
   设备列表 / 托盘在线状态不再虚高；设计原表无此信号。
8. **per-IP 名额键 = 会话 sid**（WP6 修复）：最初按连接计名额（每次连接新名额、TTL 过期），10 分钟内第 11 次重连
   （手机网络闪断 / 刷新页面）就会把正常用户锁在门外。改为同 sid 幂等续期、不同 sid 计数，符合「并发会话上限」语义。
9. **审查修复（WP6 收口前的独立审查，2026-10）**：
   - anchor 令牌桶按 1+viewer 数放大（原单连接 30 msg/s 会被定向扇出放大后自我踢除）；
   - anchor 被限流 / 坏帧拒绝时同步清路由表（原残留死 socket，close 事件到达前 viewer 帧会发给已关连接）；
   - anchor 离场期间错过的 `viewer_left` 在 DO 内存暂存、回场补发（原直接丢弃，桌面端点永久残留）；
   - viewer 升级要求 Origin 缺省或同源（CSWSH 防护）；
   - 从未等到 anchor 的会话按 anchor TTL 同限逐出；
   - `utf8Bytes` 模块级复用 TextEncoder、per-IP 名额表周期性全表清扫、冗余判断清理。

# 多客户端协作（D119–D121）— 执行方案

> 状态：**P1 + P2 + P3 已实施（在线状态 / 共享草稿 / 远端光标 / 消息与审批归属 / 每客户端显示名，2026-11-09）**。设计见 [docs/design/57-multi-client-collaboration.md](../docs/design/57-multi-client-collaboration.md)（先读 §3 在线状态、§4 共享草稿、§6 冲突矩阵再开工）。
> 相关：[46 远程遥控](../docs/design/46-remote-control.md)（多端点广播）、[49 headless](../docs/design/49-headless-server.md)（多客户端在线）、[01 对话](../docs/design/01-conversation.md)（输入与发送）、[12 界面](../docs/design/12-ui-layout.md)（输入区）。
> 约定：迭代中只跑定向测试（AGENTS.md）：`node scripts/run-tests.mjs run <测试文件或目录>`；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；收口跑一次全量 `pnpm test`。渲染层用例在 `desktop-svelte` 项目（`node scripts/run-tests.mjs run <文件>` 会自动按目录选项目）。

## P1 实施记录（2026-11-09）

- **已落地**：`collab.presence.update/leave/list` + `collab.presenceChanged`；core 纯内存 `PresenceService`（按 clientId 聚合、多标签页连接集合、200ms 会话合流、90s TTL 清扫）；SessionHub / RemoteHub / app-port 断开清理；渲染层客户端身份、presence store（20s 心跳、typing 3s 降级、`visibilitychange` 报 away、`pagehide` 尽力 leave）、输入区头像行与「X 正在输入…」。
- **测试**：`packages/shared/test/unit/collab-contracts.test.ts`、`packages/core/test/unit/collab-presence.test.ts`、`apps/desktop/src/renderer/src/lib/features/collab/presence.svelte.test.ts`；两条真实 `/rpc` 连接的多客户端用例并入 `apps/server/test/session-hub.test.ts`。typecheck（shared/core/server/desktop）与 eslint 干净；`build:web` 成功。全量 `pnpm test`：8081 passed / 49 skipped；2 例在 761 个 worker 满载下超时（`permission-bridge`、`delegation` 重启恢复），单跑均通过，符合 AGENTS.md 的偶发负载判定。
- **未做（P2/P3）**：草稿 schema/RPC/表、远端光标、接管、消息与审批归属；`selection` 字段已进契约但 P1 不上报（租约校验随 P2 接入）。
- **已知无关失败**：`test:web` 的两条配对门用例在 `vite preview` 下失败——preview 对 `/api/auth/whoami` 走 SPA 回退返回 200 HTML，web 客户端因此进密码登录门而非配对门；与 P1 改动无关（未改认证探测与 Gate），真机 / headless 同源托管路径不受影响。

## P2 实施记录（2026-11-09）

- **已落地**：迁移 `0072_composer_drafts`；`DraftService`（单写者租约 20s、版本化整份快照、300ms 会话合流、大草稿降频、发送原子清空、租约过期清扫）；`collab.draft.get/claim/update/release/send` + `collab.draftChanged/draftOwnerChanged/draftCleared`；渲染层 v3 草稿快照（version/dirty，v2 自动升级）、`sharedDraft` store（claim / 只读镜像 / 接管 / IME 组合期不广播 / 断线恢复）、只读 TipTap 镜像、远端光标 Decoration、输入区只读横幅与「接管」按钮；附件孤儿清扫跳过草稿仍引用的 id。
- **测试**：`collab-drafts`（14 例：含 connectionId 租约、事务内清草稿、深度/mention 上限）、`collab-drafts-migration`（列 / 默认值 / FK CASCADE）、`attachments-sweep` 草稿引用与跨会话保护、shared 契约、`shared-draft.svelte.test`（12：含 stale 恢复、离线 pending 重推、接管降级、本地迁移）、`presence.svelte.test`（10：含心跳、visibility away、显式 null 光标）、`client-name`（4）、`remote-caret-model`（2）、`composer-draft-persist` v2→v3 键清理；`session-hub` 真实 WS 全链路（claim → update → 对方看到快照 → force 接管 → 发送 → 全端清空 + DRAFT_BUSY/身份冒用断言）。全量 `pnpm test`：**8128 passed / 49 skipped（exit 0）**。
- **已知简化（留 P3）**：服务端草稿只存 `replyTo` id，另一台设备没有引用预览；跨设备旧草稿同时存在时服务端优先，未做「恢复本地内容」横幅；消息 / 审批归属（D121 归属部分）未做。

### 审查修复（2026-11-09，三路子代理审查）

- **P0/P1**：每个 Composer 独立 `SharedDraftStore`（主对话与看板卡片不再共用一个会话）；`loaded/docConversationId` 区分「未加载」与「权威空草稿」，enter 重置不再清空编辑器；offline 时保留 pending，重连 claim 后重推本地而不是被旧服务端快照覆盖；`draft.send` 的草稿行通过 orchestrator `onPersisted` 在消息事务内删除，消除崩溃重复发送窗口。
- **租约/协议**：lease 增加 `ownerConnectionId`（同一设备多标签页按连接归属，旧标签页 pagehide 不误释放）；`draft.get` 返回 `{draft, lease}`；mention/reply/attachment 单条上限 + 整份载荷 256KB + 深度 100/节点 20k；presence/draft 限流（drop / RATE_LIMITED）；presence leave、草稿、消息、审批统一连接级 clientId 绑定；宿主断开即时释放草稿租约；未知会话映射 NOT_FOUND；附件清扫只保护同会话引用并一次构建引用集合；草稿发送在消息事务内清行，路由失败不再让客户端重试（消息已落库即成功）。
- **前端**：光标显式发 `selection: null`（服务端不会保留旧光标）；回复/附件变化同步共享草稿；读端收到他人发送后清附件 chip；`whenReady` 竞态按 promise 身份判定；core 重启后 reader 也重新 get+claim；v2 键在 v3 空写时清除；远端光标匹配抽成纯函数 + 单测；presence 增加 source 栈（卡片关闭回落到主对话）。
- **文档**：§4.3 / §4.4 / §4.5 / §4.6 / §8 / §11 已对齐实现。

## P3 实施记录（2026-11-09）

- **已落地**：`messages.send` / `collab.draft.send` 携带可选 `client`，core 写入消息 `content.client`（`textContentSchema` 显式字段），Composer 走共享草稿与普通发送两条路径都带上当前客户端；`approvals.decide` 携带可选 `client`，写入 `decision.decidedBy`，`approval.resolved` 事件与首胜冲突的 `INVALID_INPUT` details 都带 `decidedBy`；消息行显示「来自 X」，审批折叠行显示「已被 X 处理」，竞争失败 toast 用 `details.decidedBy`；`ChatSession.send` 增加可选 `client`。
- **未做**：`runs.cancel` 的归属提示（设计列为可选）；真机双端视觉验收。
- **每客户端显示名**：`clientNameState`（localStorage `kepcup.collab.clientName`）+ `ClientNameDialog`；入口在侧栏用户菜单与窄屏「我」页；改名即时 `presence.refresh()`，后续消息 / 审批 / 租约使用新名字。
- **测试**：shared 契约 attribution round-trip；server 全链路用 `messages.list` 断言 `content.client`；core approvals integration 走 `core.rpc.call('approvals.decide')` 断言 `decidedBy`、列表回读与首胜冲突 details；typecheck / eslint / `build:web`。全量 `pnpm test`：**8128 passed / 49 skipped（exit 0）**。
- **顺手修复**：`clientIdentity` 不再间接 import `endpoint.ts`（后者在模块加载期读 `window`，无 DOM 的渲染层单测会整文件加载失败）；默认设备名提取为 DOM 安全的 `lib/device-name.ts`，`endpoint.ts` 原 API 保持 re-export。

## 0 工作包总览与依赖

```
WP1 shared 契约与常量
      │
      ├─► WP2 core Presence ─────────┐
      ├─► WP3 core Drafts + 迁移 ────┼─► WP4 归属（消息 / 审批）─► WP5 渲染层 ─► WP6 测试与收口
      └─► WP4 可并行（只依赖 WP1）   ┘
```

- WP2 与 WP3 可在 WP1 之后并行；两者都改 `start.ts` / `bindings.ts`，合并时注意同一文件的接线顺序。
- WP4 只依赖 WP1，可与 WP2/WP3 并行；它改 `messages.send` / `approvals.decide` 的入参与事件，不改协作服务本身。
- WP5 依赖 WP2–WP4 的契约稳定；WP6 最后收口。
- 单客户端桌面路径必须零行为变化：所有新逻辑默认关闭或空表，只有客户端主动 `presence.update` / `draft.claim` 才启用。

## WP1 shared 契约与常量

文件：`packages/shared/src/domain/collab.ts`（新）、`packages/shared/src/rpc/methods.ts`、`packages/shared/src/rpc/events.ts`、`packages/shared/src/constants.ts`、`packages/shared/src/index.ts`。

- [x] `domain/collab.ts`（P1）：`collabClientRefSchema`、`collabPresenceEntrySchema`、`collabSelectionSchema`、颜色派生函数。
- [x] `domain/collab.ts`（P2）：`composerDraftSchema`、`composerDocSchema`、`collabDraftAttachmentSchema`、`collabLeaseSchema`、draft RPC 入参 / 出参与三个事件 payload。
- [x] `rpc/methods.ts`（P2）：登记 `collab.draft.get` / `claim` / `update` / `release` / `send`；`draft.send` 的 `text` 沿用 100k 字符上限，`mentions` / `attachmentIds` 沿用既有消息 schema。
- [x] `rpc/methods.ts`（P3）：`messagesSendInputSchema` 增加可选 `client: collabClientRefSchema`；`approvalsDecideInputSchema` 增加可选 `client: collabClientRefSchema`。
- [x] `domain/types.ts`（P3）：`textContentSchema` 增加可选 `client`；`approvalDecisionSchema` 增加可选 `decidedBy`（zod 默认剥掉未知键，不显式加就会在 `messageSchema` 输出里丢失归属）。
- [x] `rpc/events.ts`（P1）：新增 `collab.presenceChanged`。
- [x] `rpc/events.ts`（P2/P3）：新增 `collab.draftChanged`、`collab.draftOwnerChanged`、`collab.draftCleared`；`approvalResolvedPayloadSchema` 增加可选 `decidedBy`。
- [x] `constants.ts`（P1）：`COLLAB_PRESENCE_HEARTBEAT_MS = 20_000`、`COLLAB_PRESENCE_TTL_MS = 90_000`、`COLLAB_PRESENCE_BROADCAST_MS = 200`、`COLLAB_TYPING_IDLE_MS = 3_000`、`COLLAB_PRESENCE_SWEEP_MS = 5_000`。
- [x] `constants.ts`（P2）：`COLLAB_DRAFT_LEASE_MS = 20_000`、`COLLAB_DRAFT_BROADCAST_MIN_MS = 300`、`COLLAB_DRAFT_LARGE_BYTES = 64 * 1024`、`COLLAB_DRAFT_HUGE_BYTES = 256 * 1024`、`COLLAB_DRAFT_MAX_BYTES = 512 * 1024`、`COLLAB_DRAFT_LEASE_SWEEP_MS = 5_000`。
- [x] 契约测试（P1）：`packages/shared/test/unit/collab-contracts.test.ts`——presence schema round-trip、方法 / 事件目录、颜色派生、TTL 下限。
- 验收：`pnpm --filter @kepcup/shared build && node scripts/run-tests.mjs run packages/shared/test/unit/collab-contracts.test.ts`。

## WP2 core 在线状态（D119）

文件：`packages/core/src/collab/presence.ts`（新）、`packages/core/src/collab/index.ts`（新）、`packages/core/src/start.ts`、`packages/core/src/rpc/bindings.ts`、`packages/core/src/process-entry.ts`、`packages/core/src/remote/hub.ts`、`apps/server/src/session-hub.ts`。

- [x] `PresenceService`：内存 `Map<clientId, Entry>`；`update` 合并（conversationId / state / selection / clientName / connectionId / updatedAt 用服务端时钟）；`leave` 幂等；`list(conversationId?)`；TTL 清扫定时器（5s，`unref`）；关闭时清表。
- [x] 客户端身份绑定：同一传输连接首次 `presence.update` 的 `clientId` 绑定到该连接；后续同一连接换 `clientId` → `INVALID_INPUT`。SessionHub 用 `Map<SessionConnection, clientId>`；RemoteHub 端点强制 `clientId === deviceId`；app-port 用逐端口绑定集合。
- [x] 事件：presence 集合变化时发布 `collab.presenceChanged`，按 `conversationId` 合流（200ms），全量 entries；presence 事件不进审计。
- [x] 宿主断开清理：`SessionHub.#detach`、`RemoteHub.#dropEndpoint`、`process-entry` 的 app port `close` 调 `presence.leave`；没有绑定过身份的连接不调用。
- [x] `start.ts`：实例化并挂到 `services.collabPresence`；随 core 关闭 `close()`。
- [x] `bindings.ts`：三个 RPC；`update` 的 `clientName` 清洗（控制字符、80 字符上限）。`selection` 的草稿租约校验随 P2 接入（P1 无草稿租约，字段保留但不上报）。
- [x] 测试：`packages/core/test/unit/collab-presence.test.ts`（TestClock：合并 / TTL / leave / 合流 / 多标签页 / 名称清洗）；`apps/server/test/session-hub.test.ts` 新增真实 WS 多客户端用例（两条连接互见 presence → 断开后清理）。
- 验收：定向测试全绿；单客户端桌面不调用新 RPC 时无任何事件/写库。

## WP3 core 共享草稿（D120）

文件：`packages/core/migrations/main/0072_composer_drafts.sql`（新）、`packages/core/src/collab/drafts.ts`（新）、`packages/core/src/start.ts`、`packages/core/src/rpc/bindings.ts`、`packages/core/src/domain/attachments.ts`。

- [x] 迁移 `0072`：按设计 §4.2 建表；`conversation_id` 外键 `on delete cascade`。
- [x] `DraftService`：
  - 读：`get(conversationId)`；无行返回空 doc + `version: 0`。
  - 租约：内存 `Map<conversationId, {ownerClientId, ownerName, expiresAt}>`；`claim` / `renew` / `release` / `forceTakeover`；过期由时间判定 + 5s 清扫；持有者编辑器打开期间每 5s 重复 `claim` 续期；同持有者续期不广播。
  - 写：`update` 校验持有者与 `baseVersion`，大小 ≤ `COLLAB_DRAFT_MAX_BYTES`，写库 version+1，发布 `collab.draftChanged`（按会话合流 300ms，大文档 1–2s）。
  - 发：`send` 在同一个核心调用里校验持有者 + 版本 → `orchestrator.sendMessage` → 删行 → 释放租约 → 发布 `collab.draftCleared`；失败不改草稿、不释放租约。
  - 租约变化：发布 `collab.draftOwnerChanged`（`{conversationId, owner: {clientId, name} | null, expiresAt}`）。
- [x] 归属（P3）：`collab.draft.send` 把 `client {id, name}` 传给 `orchestrator.sendMessage`（WP4 的入参）。
- [x] 附件保护：`AttachmentsService.sweepOrphans` 跳过 `composer_drafts.attachments_json` 中仍引用的 id；补用例。
- [x] 会话删除：FK 级联覆盖；`DraftService` 无需额外监听（内存租约随会话不可用自然过期）。
- [x] 测试：`packages/core/test/unit/collab-drafts.test.ts`（claim 竞争 / 续期 / 过期 / force / version 冲突 / send 原子性 / 大小上限 / 合流）；`collab-drafts-migration.test.ts`；`attachments-sweep.test.ts` 草稿引用保护。
- [x] 验收：定向测试全绿；`DRAFT_BUSY` / `DRAFT_STALE` / `DRAFT_NOT_OWNER` 错误 details 完整（owner、version）。

## WP4 归属与审批冲突体验（D121 的归属部分）

文件：`packages/core/src/dispatch/orchestrator.ts`、`packages/core/src/domain/messages.ts`、`packages/core/src/permissions/approvals.ts`、`packages/core/src/rpc/bindings.ts`、`packages/shared/src/rpc/methods.ts`（WP1 已改 schema）。

- [x] `orchestrator.sendMessage` 入参增加可选 `client: {id, name}`；`MessagesService.append` 把 `client` 写入 `content_json.client`（`textContentSchema` 已在 WP1 加可选字段；不新增列）；模型上下文与 `search_messages` 不读取该字段。
- [x] `messages.send` binding 透传 `client`；`collab.draft.send` 自动带上租约持有者。
- [x] `ApprovalsService.decide` 入参增加可选 `client`；决定 JSON 记录 `decidedBy`；`approval.resolved` 事件带 `decidedBy`；非 pending 的冲突错误 details 增加 `decidedBy`（保持原错误码 `INVALID_INPUT`，避免破坏既有映射）。
- [x] `runs.cancel` 的归属提示列为 P3 可选项，本期不做（幂等语义不变）。
- [x] 测试：`packages/core/test/integration/approvals.test.ts`——`decidedBy` 落盘 + 首胜冲突 details；`apps/server/test/session-hub.test.ts` 用 `messages.list` 断言 `content.client`；shared 契约 round-trip。
- 验收：定向测试全绿；旧客户端不传 `client` 时输出与今天一致。

## WP5 渲染层

文件（新增）：`apps/desktop/src/renderer/src/lib/features/collab/client-identity.ts`、`presence.svelte.ts`、`remote-caret.ts`、`ComposerPresenceRow.svelte`、`ComposerTakeoverBanner.svelte`。
文件（修改）：`lib/features/chats/composer-drafts.svelte.ts`、`composer-draft-persist.ts`、`Composer.svelte`、`composer-editor.ts`、`lib/i18n/locales/{zh-CN,en-US}.ts`、消息行与审批卡组件。

- [x] `client-identity.ts`：clientId 持久化键 `kepcup.collab.clientId`；clientName 键 `kepcup.collab.clientName`（默认设备名，复用 `defaultDeviceName`）；connectionId 每次页面加载生成；`color` 优先用服务端下发，离线时本地按 clientId 派生。隐私模式 localStorage 不可用时退化为会话级随机 id；配对模式复用 `kepcup.remote.deviceId.v1`。
- [x] `presence.svelte.ts`：进入会话 `presence.list` + 心跳（20s）；`visibilitychange` 上报 `away`；typing 3s 自动降级；离开/卸载 `presence.leave`（`pagehide` best-effort）；订阅 `collab.presenceChanged` 并过滤当前会话。同一输入框 + 同一会话重复 `enter` 不发 RPC（Composer effect 会因击键重跑）。
- [x] `Composer.svelte`（P1）：会话 effect 上报 `presence.enter`，卸载 `presence.leave`；用户焦点内编辑触发 `noteTyping`；输入区上方渲染在线头像行与「X 正在输入…」；i18n 新增 `collab.online` / `collab.typing` / `collab.typingMany`。
- [x] 渲染端测试（P1）：`lib/features/collab/presence.svelte.test.ts`（进入/离开、typing 降级、事件按会话过滤、重复 enter 不发 RPC）。
- [x] `composer-drafts.svelte.ts`（P2）改造：服务端草稿应用（`applyServerDraft`）、v3 version/dirty、附件元数据、`clearDocState`；保留现有上传任务管道与附件 chip 逻辑。
- [x] `composer-draft-persist.ts`（P2）：新缓冲键 `kepcup.composer.drafts.v3`（`{doc, version, dirty, updatedAt}`）；读取旧 `v2` 自动升级；写入时删除旧键。
- [x] `Composer.svelte`（P2）：
  - 三态渲染：owner 正常编辑；reader 只读 TipTap + 远端光标 + 接管横幅；无 owner / loading 可编辑并在 focus 时 claim。`offline` 状态保留，断线时本地缓冲编辑。
  - 发送改走 `collab.draft.send`（带上 `baseVersion`）；loading 时等 `whenReady`，无 owner 时先尝试 claim，claim 失败再退回普通 `messages.send`；`DRAFT_STALE` → 重新拉取；`DRAFT_BUSY` → 转只读。
  - IME：`compositionstart` 起暂停共享草稿 update，`compositionend` 冲刷；光标仍可更新。
  - 会话切换：释放旧会话租约；卸载/unmount 释放当前租约（保留草稿）。
- [x] 远端光标（P2）：`remote-caret.ts` 的 ProseMirror Decoration；只在 `selection.docVersion === 当前 version` 时应用；颜色取 presence。
- [x] 展示（P1）：输入区头像行（最多 3 + N）与「X 正在输入…」。
- [x] 展示（P2）：只读徽标与「接管」按钮（`ComposerTakeoverBanner`）。
- [x] 展示（P3）：消息行显示「来自 X」（`ChatMessageRow`）；审批折叠行显示「已被 X 处理」（`ApprovalCard`）；竞争失败 toast 用 `details.decidedBy`。
- [x] i18n（P1/P2/P3）：`collab.online` / `typing` / `typingMany` / `draftOwner` / `draftReadonly` / `takeover` / `takeoverConfirm` / `messageFrom` / `approvalDecidedBy` / `approvalAlreadyDecided`（zh-CN / en-US）。
- [x] 渲染端测试（P2）：`shared-draft.svelte.test.ts`（claim / 镜像 / 接管 / 防抖 / IME / 发送清空）；`composer-draft-persist.test.ts` 补 v2→v3。`remote-caret` 与 Composer 三态未单独单测（由 typecheck 与真机手测覆盖）。
- 验收：单客户端 desktop 路径行为不变（无新请求、无新 UI 噪音）；双端手测三态与接管。

## WP6 测试与收口

- [x] 集成（P1）：真实 `SessionHub` 两条 WS 连接互相看到 presence、断开后清理——并入 `apps/server/test/session-hub.test.ts`。
- [x] 集成（P2）：`apps/server/test/session-hub.test.ts` 的真实 WS 全链路——管家会话 → A claim → A update（B 收到 draftChanged v1）→ B force 接管（A 收到 ownerChanged）→ B send → 全端 draftCleared → `draft.get` 回到 version 0 / lease null。
- [ ] e2e：`apps/desktop/test/e2e/collab.spec.ts`（需真实 headless 或测试内起服务）——两个浏览器上下文 + 一个 Electron 本地端点；覆盖输入镜像、远端光标、接管、发送清空、审批 `decidedBy`。若 e2e 起服务成本过高，至少保留集成测试并在真机清单里记录手测步骤。
- [ ] 真机验收清单（发布前）：
  1. 同一 headless、Chrome + Safari 两个窗口登录同一账号：A 输入，B 只读并看到光标与「正在输入」。
  2. B 点「接管」，A 立即只读；B 发送后两端清空。
  3. A 关闭浏览器，B 在 ≤20s 内可编辑；服务端重启后草稿仍在。
  4. Electron 本地端点与 headless 客户端同时在线：消息显示「来自 X」；审批竞争失败方看到「已被 X 处理」。
  5. 中文输入法：组合期间另一侧不出现拼音中间态，上屏后同步。
  6. 后台标签页：切走 5 分钟后回来，presence 不闪烁、不显示「正在输入」。
- [ ] 回归：core remote / messages / approvals / attachments 定向测试；共享契约变更后跑一次 `pnpm --filter @kepcup/shared test`；收口跑一次全量 `pnpm test`。
- [ ] 文档：设计 57 与执行文档互链；46 / 49 / 01 / 12 / 13 的修订按设计 §13 落地（已在本次文档变更中完成）。

## 风险与处理

| 风险 | 处理 |
|---|---|
| IME 中间态被广播 | 组合期暂停文本 update，`compositionend` 冲刷；用例覆盖 |
| 后台标签页定时器节流 | `visibilitychange` 立即上报 `away`；TTL 90s 容忍 1 分钟心跳 |
| 大草稿同步流量 | 512KB 上限 + 按大小自适应 1–2s 节流；超限提示 |
| 附件被孤儿清扫删掉 | 清扫跳过 `composer_drafts` 引用的 id（WP3 必做） |
| 租约持有者离线后无人接管 | 租约 20s 自动过期；UI 自动解除只读 |
| 同一 clientId 多标签页并发 | version 冲突 → `DRAFT_STALE` + 本地恢复缓冲，不静默覆盖 |
| 中转令牌桶被 presence 打满 | 服务端合流 ≤5Hz/会话；超预算优先丢光标 |
| SQLite 写放大 | 服务端按会话 300ms 合流写；典型草稿体积小 |

## 开放事项（不阻塞开工）

- 是否给用户提供「本机不共享输入」开关（P3；v1 默认开启协作）。
- 是否把 `MAX_SESSIONS = 8` 做成服务端配置（本期不动）。
- 真正同时编辑（Yjs）是否进入路线图（P4，本期明确不做）。

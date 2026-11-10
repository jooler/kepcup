# 57 多客户端协作（在线状态 / 共享草稿 / 远端光标）

headless（D102）让同一个大脑可以被任意设备连接：账号密码模式的 `SessionHub` 允许 8 条并发连接（[session-hub.ts](../../apps/server/src/session-hub.ts)），配对模式的中转允许 anchor + 5 个 viewer（[46](46-remote-control.md) §4.3），事件广播保证所有客户端随后收敛。但「能连」不等于「能一起用」：

- 每个客户端各自持有 localStorage 草稿（`kepcup.composer.drafts.v2`），谁也看不见谁在输入；
- 两个人同时打开同一会话时，唯一的协调手段是后写覆盖或先到先得，界面没有任何提示；
- 审批与运行控制虽然是首胜/幂等，但失败方只看到通用错误，不知道是谁先处理了。

本篇补齐多客户端协作的最小闭环：**谁在线、谁在输入、这份草稿归谁编辑、其余人看到什么**。决策 D119–D121。

> **状态：P1（D119 在线状态）、P2（D120 共享草稿 / D121 远端光标）与 P3（D121 消息与审批归属 / 每客户端显示名）已实施（2026-11-09）。** 实施记录见 [todo/multi-client-collaboration.md](../../todo/multi-client-collaboration.md) 的「P1/P2/P3 实施记录」。

相关：[46](46-remote-control.md)（多端点广播与一致性语义）、[49](49-headless-server.md)（常驻大脑与多客户端）、[01](01-conversation.md)（输入与发送）、[12](12-ui-layout.md)（输入区）、[13](13-permissions.md)（审批决定）、[11](11-storage.md)（数据目录与整库加密）。执行方案见 [todo/multi-client-collaboration.md](../../todo/multi-client-collaboration.md)。

## 决策

- **D119 客户端身份与在线状态**：每个客户端有稳定的 `clientId`、可读的 `clientName` 与派生颜色；core 新增纯内存 `PresenceService`，提供 `collab.presence.*` RPC 与 `collab.presenceChanged` 事件，按会话广播「谁在看 / 谁在输入 / 编辑者的光标在哪」。在线状态不落库、不进审计、不进 Bot 上下文。配对模式 `clientId` 复用已认证的 `deviceId`；账号密码模式由客户端生成并持久化，同一客户端的多个标签页折叠为一条 presence。
- **D120 共享草稿（单写者租约）**：草稿从各端 localStorage 升级为 core 的服务端单一事实来源（`composer_drafts` 表）；同一会话同一时刻只有一个编辑者（租约 20s，编辑续期，支持显式「接管」），其余客户端只读展示编辑者的实时草稿与光标。更新采用**整份文档快照 + version**，不做 OT/CRDT；发送经 `collab.draft.send` 原子完成「校验租约与版本 → 落消息 → 清草稿 → 释放租约」。localStorage 降级为断线/崩溃缓冲与旧版本迁移来源。
- **D121 远端光标与操作归属**：编辑者广播 ProseMirror 文档位置 `selection {anchor, head, docVersion}`，接收端在 `docVersion` 一致时用 Decoration 绘制彩色光标与名字标签；用户消息与审批决定携带 `client {id, name}`，多端在线时消息显示「来自 X」，审批竞争失败方看到「已被 X 处理」。这一层只做归属与感知，不改变任何业务语义（消息仍直发、审批仍首胜、运行仍幂等）。

## 1 目标与非目标

### 1.1 目标

- 同一会话内实时显示在线客户端（头像 + 名称）、谁正在输入、编辑者的光标位置。
- 同一会话同一时刻只有一个可编辑的输入框；其他人看到实时镜像与远端光标，可显式接管。
- 草稿跨设备连续：换设备打开同一会话能看到同一份未发送内容（服务端单一事实来源）。
- 多客户端下的操作可归属：消息与审批决定能显示「来自谁 / 已被谁处理」。
- 不改变既有语义：消息直发、运行中断言、审批首胜、数据单库；不引入 CRDT、不引入新同步层。

### 1.2 非目标

- 真正的同时编辑（两人同时改同一段文字）——需要 CRDT，见 §12 P4。
- 多租户 / 多用户权限体系：一个数据目录仍是一个用户一份 core（D102）；本篇的多客户端是**同一用户的多个设备/标签页**。
- 跨会话的全局在线状态、正在输入以外的富状态（例如「正在查看某条消息」）。
- 草稿版本历史、审计检索；草稿不是正式数据，只保留最新一份。
- 非输入框内容的协作（Bot 编辑、设置、看板等仍是 last-write-wins）。

## 2 连接模型与身份

### 2.1 现有的三种连接

| 形态 | 入口 | 并发上限 | 身份来源 |
|---|---|---|---|
| 本机 renderer | port A（MessagePort） | 每窗口一条 | 客户端生成 |
| 账号密码直连 | `SessionHub` 的 `/rpc` WS | 8 条连接 | 客户端生成（同账号共享 username，不能当身份） |
| 配对直连 / 中转 | `RemoteHub` 端点 | viewer ≤ 5 | 已认证的 `deviceId` |

三种形态都绑定同一份 `appMethods`，事件总线统一扇出，所以协作服务的接入点只有 core，不需要改帧协议，也不需要区分传输。

### 2.2 客户端身份

```text
clientId    稳定标识：配对模式 = deviceId；其他模式 = 客户端生成并持久化
clientName  展示名：默认为设备名（复用 web-shell 的 defaultDeviceName），可在客户端本地修改
color       由 clientId 派生的固定色（8 色面板，适配明暗主题），服务端计算并下发，避免各端不一致
connectionId 每次连接/标签页的短 id；用于同一 clientId 的多标签页去重与日志
```

- **不是账号身份**：密码模式下所有连接共享同一个 `username`，因此身份必须由客户端上报；服务端在连接上绑定**首个**上报的 clientId，之后不允许同一连接改身份。
- **多标签页**：同一 `clientId` 的多个标签页折叠为一条 presence（后到者覆盖 `connectionId` 与光标）；草稿租约也按 `clientId` 判定，同一人的两个标签页可以互相续租，但版本号仍会阻止并发写互相覆盖（见 §4.6）。
- **隐私模式**：localStorage 不可用时退化为会话级随机 id；协作仍可用，只是每次打开都是新身份。
- 身份只在 `collab.*` 方法中出现，不进入消息内容之外的业务字段；消息归属是可选展示信息（§6.3）。

## 3 在线状态（D119）

### 3.1 数据模型

```ts
interface CollabPresenceEntry {
  clientId: string;
  clientName: string;
  color: string;
  connectionId: string;
  conversationId: string | null; // null = 在线但不在任何会话
  state: 'viewing' | 'typing' | 'away';
  selection: {
    anchor: number;   // ProseMirror 文档位置
    head: number;
    docVersion: number; // 该光标对应的草稿版本
  } | null;
  updatedAt: number;  // 服务端时钟
}
```

- `selection` 只有**当前草稿租约持有者**上报；非编辑者的 focus 不产生光标（只报 `state`）。
- `typing` 是客户端在 3s 无输入后自行降回 `viewing` 的展示态，不是服务端推导的。
- `away` 由 `visibilitychange`（隐藏）立即上报，避免后台标签页的定时器被浏览器节流后仍显示「正在输入」。

### 3.2 RPC 与事件

| 方法 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `collab.presence.update` | `{clientId, clientName, connectionId, conversationId, state?, selection?}` | `ok` | 合并进内存表；`clientId` 首次出现时绑定到当前连接 |
| `collab.presence.leave` | `{clientId, connectionId?}` | `ok` | 页面卸载 / 切会话 / 连接关闭时调用；幂等 |
| `collab.presence.list` | `{conversationId?}` | `{entries}` | 初次进入会话时取快照 |

事件 `collab.presenceChanged`：`{conversationId: string | null, entries: CollabPresenceEntry[]}`。每次该会话的 presence 集合变化时广播**全量**列表（单会话条目很少，全量比增量简单且不会丢更新），按 `updatedAt` 升序。

### 3.3 生命周期与可靠性

- 客户端进入会话：`presence.list` 取快照 + 开始 `update` 心跳（20s 一次）。
- 编辑/光标变化：`update` 节流到 ≤10Hz；打字状态变化与 `visibilitychange` 立即上报。
- 服务端 TTL 90s：超过未更新的条目视为离线并广播新集合。TTL 必须大于浏览器后台标签页的定时器节流上限（Chrome 可降到 1 分钟一次），同时 `away` 已经避免把后台标签页显示成「正在输入」。
- 宿主在连接关闭时调用 `presence.leave`（能立即清）；TTL 只是兜底：
  - `SessionHub` 记录每条连接绑定的 clientId，`close` 时 leave；
  - `RemoteHub` 端点断开时用 `deviceId` leave；
  - core `process-entry` 的 app port `close` 时 leave 该端口绑定的 clientId。
- 服务端重启：在线表在内存中，全部清空；客户端重连后重新 `update` 自愈。

### 3.4 展示

- 输入区上方一行：最多 3 个头像 + 「N 人在此对话」；悬停显示名称与状态。
- `typing` 的编辑者显示「X 正在输入…」；非编辑者的 `typing` 不存在。
- 当前用户自己不出现在头像行里。

## 4 共享草稿（D120）

### 4.1 单一事实来源

草稿从「每端 localStorage」改为「core 里每个会话一行」。会话打开时先 `collab.draft.get`；之后所有编辑都发往 core，由 core 广播给所有在线客户端。localStorage 仍保留一份**本地缓冲**，只用于断线/崩溃恢复与旧版本迁移，不再作为协作事实来源。

好处：换设备草稿连续；服务端重启后草稿仍在；冲突判定有唯一版本号。

### 4.2 数据表

迁移 `0072_composer_drafts.sql`（main；外键随 `PRAGMA foreign_keys = ON` 生效，会话删除级联）：

```sql
-- 多客户端共享草稿（D120，57 §4.2）：每会话一行最新快照；编辑者租约只在内存，
-- 重启后由首个 claim 重建。version 每次服务端接受的更新 +1，0 = 空草稿。
CREATE TABLE composer_drafts (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  doc_json         TEXT NOT NULL,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  reply_to         TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
```

- `doc_json` 是 TipTap/ProseMirror 文档 JSON（含 mention、列表等富节点），服务端按不透明 JSON 存取；写入前校验整份载荷字节数（≤256KB）、文档深度（≤100）与节点数（≤20k），mention 单条 ≤4KB、reply id ≤128。
- `version` 每次被接受的服务端更新 +1；`0` 表示空草稿。
- 编辑者租约**不落库**（纯内存），服务端重启后租约清空、草稿保留，首个 claim 的客户端重新持有。
- `attachments_json` 中的附件 id 必须被孤儿清扫视为「仍被引用」，且只保护同会话的附件（见 §9）。
- 会话删除时级联删除；草稿不产生任何审计或 Bot 上下文。

### 4.3 租约

```text
未持有：{ owner: null }
持有：  { ownerClientId, ownerConnectionId, ownerName, expiresAt }   // 内存
```

- `claim`：空闲 → 授予并续期 20s；其他客户端持有且未过期 → `DRAFT_BUSY`（details 带 owner 与 expiresAt）；`force: true` → 撤销旧租约并通知（显式接管）。**同一 clientId 的另一条连接**（同一设备的新标签页 / reload）claim 会接管并广播，旧标签页立即转只读，避免两个标签页都自认持有者。返回值里的 `lease = {ownerClientId, ownerConnectionId, ownerName, expiresAt}`。
- 续期：编辑与持有者心跳（编辑器打开期间每 5s，重复 `claim` 即续期）；光标更新不单独续期。
- `release` 立即释放；连接关闭时宿主释放该连接持有的租约（SessionHub / RemoteHub / app-port 都接），TTL 只是兜底。
- 租约过期不丢草稿，只丢编辑权；任何客户端可立即 claim。

### 4.4 RPC

| 方法 | 输入 | 输出 | 规则 |
|---|---|---|---|
| `collab.draft.get` | `{conversationId}` | `{draft, lease}` | 无草稿返回 `version: 0` 的空文档；lease 可空 |
| `collab.draft.claim` | `{conversationId, clientId, clientName, connectionId?, force?}` | `{draft, lease}` | `DRAFT_BUSY{ownerClientId, ownerName, expiresAt}` |
| `collab.draft.update` | `{conversationId, clientId, connectionId?, baseVersion, doc, mentions?, replyTo?, attachments?}` | `{version, updatedAt}` | 仅持有者（clientId + connectionId）；`baseVersion` 必须等于当前 version，否则 `DRAFT_STALE{version}` |
| `collab.draft.release` | `{conversationId, clientId, connectionId?}` | `ok` | 幂等；非持有者调用为 no-op |
| `collab.draft.send` | `{conversationId, clientId, connectionId?, baseVersion, text, mentions?, replyTo?, attachmentIds?, voiceMode?}` | `{message, runId}` | 原子：校验租约与版本 → `orchestrator.sendMessage`（草稿行在消息事务内删除）→ 释放租约 |

- **为什么发送不走 `messages.send`**：发送必须与「清草稿 + 释放租约」在同一个核心调用里完成；草稿行通过 orchestrator 的 `onPersisted` 回调在消息落库事务内删除，避免崩溃/并发留下「消息已发、草稿还在」的重复发送窗口。`collab.draft.send` 同时写入 `client {id, name}` 归属（服务端清洗名字）。
- `messages.send` 保留给语音、脚本、组件回传等不经过共享输入框的路径，语义不变。
- `collab.draft.send` 的文本仍是客户端序列化后的 markdown（与今天一致）；服务端不解析富文档。文本上限沿用 `messages.send` 的 100k 字符，`mentions` / `attachmentIds` 上限也沿用既有消息 schema。
- 发送失败（例如会话只读）时不改草稿、不释放租约，客户端可重试。

### 4.5 更新管道

- 客户端在编辑器 `update` 后 200ms 防抖，发送整份 doc 快照 + `baseVersion`；服务端接受后 version+1，广播 `collab.draftChanged {conversationId, draft}`。
- **IME 保护**：`compositionstart` 到 `compositionend` 期间不发送文本更新（避免把拼音中间态广播给其他人），`compositionend` 后立即冲刷一次；光标位置仍可更新。
- 服务端按会话合流广播：最小间隔 300ms，保留最新快照；单份序列化 >64KB 时降到 1s，>128KB 时降到 2s（延迟档位变化会重排定时器）。
- 上限：`COLLAB_DRAFT_MAX_BYTES = 256KB`（整份 doc + mentions + reply + attachments 的序列化字节数，低于 512KB 的 RPC 帧上限，给 JSON-RPC 包装留余量）；超限返回 `INVALID_INPUT`，客户端提示「草稿过大」并保留本地内容。
- `DRAFT_STALE` 处理：客户端重新 `get` 最新草稿；若本地有未同步文本，放入恢复缓冲并提示「你的内容与最新草稿冲突，已保留本地副本」，由用户选择「恢复我的内容」（claim + 覆盖）或丢弃。

### 4.6 接管与并发

- 「接管」是显式按钮，不是自动抢锁；旧持有者收到 `collab.draftOwnerChanged` 后转为只读，其文字已在服务端，不会丢失。
- 同一 `clientId` 的多标签页按 **connectionId** 区分租约：新标签页 claim 会接管并让旧标签页立即转只读；旧标签页的 `pagehide` 只释放自己持有的租约，不会误释放新标签页。
- 两个客户端同时 claim：服务端串行处理，先到者持有，后到者收到 `DRAFT_BUSY`（UI 转只读）。
- 持有者离线：连接关闭时宿主立即释放；TTL（≤20s）兜底。
- 发送竞争：只有持有者能 `draft.send`；同一 `clientId` 的两个标签页同时发送时，只有持有连接的标签页能成功，另一个收到 `DRAFT_NOT_OWNER` 并转只读。

### 4.7 旧草稿迁移

- 打开会话时：`draft.get` 为空且本地旧草稿非空 → 自动 claim + `draft.update`（`baseVersion: 0`），一次性迁移。
- 服务端已有草稿且本地也有内容：服务端为准，输入区上方出现一次性提示「发现旧版本地草稿」+「恢复本地内容」（claim（必要时 force）+ update）与「忽略」；不做自动合并。
- 本地缓冲保留 `{doc, version, updatedAt, dirty}`；`dirty` 表示断线期间有未确认的修改。重连后：
  - 本地 `version` 等于服务端且 `dirty === false` → 丢弃缓冲；
  - 本地 `version` 小于服务端且 `dirty === false` → 丢弃；
  - `dirty === true` → claim 后自动重推本地（同客户端断线恢复）；若服务端已被其他客户端推进，仍以服务端为准（跨设备冲突横幅留 P3）。

## 5 远端光标（D121）

- `selection` 使用 ProseMirror 文档位置（`anchor`/`head`），不是字符 offset；它只对产生它的 `docVersion` 有效。
- 接收端只在 `entry.selection.docVersion === 当前渲染草稿.version` 时绘制；版本不一致时隐藏，等下一次 `collab.draftChanged`。
- 绘制：ProseMirror `Decoration.widget`（光标竖线 + 名字标签）与 `Decoration.inline`（选区背景）；颜色用 presence 下发的 `color`。
- 非编辑者以只读 TipTap 视图渲染共享草稿，远端光标直接叠加；编辑者不需要看到别人的光标（别人不可编辑）。
- 光标更新 ≤10Hz，服务端与 presence 一起合流；只上报位置，不重复上报文档。
- 名字标签使用客户端下发的 `clientName`（服务端做长度与控制字符清洗）。

## 6 与既有操作的关系

### 6.1 冲突矩阵

| 操作 | 今天 | 本篇之后 |
|---|---|---|
| 两人同时输入 | 各自本地草稿，互不可见 | 单写者；另一人只读 + 看到实时镜像与光标 |
| 持有者发送 | 本端清空，另一端不知道 | `draft.send` 广播 `draftCleared`，所有端清空 |
| 两人同时发送（同一草稿） | 两条消息都落库 | 只有持有者能发；同 clientId 多标签页由 version 决出唯一成功者 |
| 两人同时审批 | 首胜，失败方通用错误 | 首胜；失败方收到 `decidedBy` 并即时看到已处理 |
| 两人同时取消 run | 幂等 | 不变（P3 可加「已被 X 取消」提示） |
| 设置 / Bot 资料编辑 | last-write-wins | 不变（不在本期范围） |

### 6.2 消息发送不受协作锁限制

协作锁只约束**输入框的编辑权**；`messages.send` / `collab.draft.send` 本身仍是直发。运行中的消息注入/排队语义（[01](01-conversation.md) §输入与发送、[02](02-execution.md)）完全不变。

### 6.3 归属

- `messages.send` 与 `collab.draft.send` 增加可选 `client: {id, name}`；core 写入消息 `content.client`（不新增列）。`textContentSchema` 必须显式加这个可选字段——zod 默认会剥掉未知键，否则 `messageSchema` 解析后归属丢失。
- 渲染：同一会话有多个客户端在线、或消息的 `client.id` 不是当前客户端时，在用户消息旁显示「来自 X」；单客户端时隐藏，避免噪音。
- 消息正文与 Bot 上下文不包含归属字段；这是纯展示元数据。
- 审批：`approvals.decide` 增加可选 `client`，写入决定记录；`approval.resolved` 事件与冲突错误 details 带 `decidedBy {id, name}`。首胜语义不变。

## 7 UI 状态

输入区三种状态：

| 状态 | 条件 | 表现 |
|---|---|---|
| 可编辑（无人持有） | 无租约 | 正常输入框；首次 focus 时 claim，失败则转只读 |
| 编辑中（自己持有） | `ownerClientId === 自己` | 正常输入框；上方显示其他在线者头像 |
| 只读（他人持有） | 他人持有 | 只读渲染共享草稿 + 远端光标 + 「X 正在输入…」；输入框禁用；「接管」按钮 |

- 只读态下 Enter/发送按钮禁用；点击「接管」并在确认框中确认后 `claim({force:true})`；仅点击输入区只提示「X 正在输入，可接管」，不直接抢锁。
- 租约到期/持有者离线：只读态自动解除，显示「可以继续输入」；首个 focus 者 claim。
- 断线：输入区转为本地缓冲编辑（不显示远端光标），顶部提示「连接已断开，内容已保存在本地」；重连后按 §4.7 恢复。
- 空草稿 + 他人持有：只读区显示占位「X 正在输入…」而不是空白编辑器。
- 头像行与「正在输入」不阻塞布局：窄屏只显示第一个头像 + 「+N」。

## 8 安全与隐私

- **信任域不变**：同一自托管实例的所有已登录客户端本就共享全部数据（D96：配对设备 ≡ 本机用户；D102：账号密码）。草稿与在线状态不扩大数据面。
- **落盘**：草稿进 `main.db`，受整库加密保护（D25/D102 file keystore 的风险提示同样适用）；在线状态只在内存。
- **不进审计、不进 Bot 上下文**：presence/草稿心跳不调用 `AuditService`；草稿内容在发送前永远不进入模型。
- **身份防冒用**：服务端把 clientId 绑定到连接，覆盖 presence、草稿、消息与审批归属方法；同一连接不能改身份。配对模式直接用已认证 `deviceId`，不接受客户端自报。
- **限流**：presence update ≤10/s/client（超限丢帧）；draft update ≤5/s/client、claim ≤2/s（超限回 `RATE_LIMITED`，客户端保留 pending 重试）；不断开连接。`clientName` 在 presence / 草稿 / 消息 / 审批归属各写入点统一清洗控制字符并截断到 80 字符。
- **大小**：草稿 256KB 上限 + 深度/节点/mention/reply 上限；presence 条目字段长度上限；事件按会话合流，避免扇出放大。

## 9 性能与限额

- 事件：presence ≤5Hz/会话；draft 最小 300ms/会话（大文档自适应到 1–2s）；全量快照，不做增量。
- 连接：账号模式 8 条、配对模式 5 个 viewer 维持不变；协作不新增连接。
- 中转：viewer 数放大令牌桶（[46](46-remote-control.md) §4.3），presence + draft 的合流后流量在既有预算内；超出时优先丢光标更新，保草稿更新。
- 数据库：打字期间每 200–300ms 一次 `update`，SQLite WAL 足够；服务端可再按会话做 300ms 合流写。
- 附件：`AttachmentsService.sweepOrphans` 必须跳过 `composer_drafts.attachments_json` 中仍被引用的 id（否则 7 天未发送的长草稿附件会被清掉）。这是本篇唯一需要改动的既有清扫逻辑。

## 10 失败与恢复

| 场景 | 行为 |
|---|---|
| 客户端断线 | 宿主立即释放该连接租约（TTL 20s 兜底）；本地缓冲保留；重连按 §4.7 恢复 |
| 服务端重启 | 草稿在库中保留；presence 与租约清空；客户端重新 claim |
| 版本落后 | `DRAFT_STALE` → 重新拉取；本地未同步内容进入恢复缓冲，不静默丢弃 |
| 事件丢失 | 重连后 `draft.get` + `presence.list` 重新自举；version 用于发现落后 |
| 时钟漂移 | `updatedAt` / `expiresAt` 一律用服务端时钟；客户端只做展示 |
| 后台标签页 | `visibilitychange` 立即上报 `away`；TTL 90s 容忍定时器节流 |

## 11 测试

- **shared**：schema round-trip、RPC 目录登记、事件目录、常量边界。
- **core presence**：update 合并、TTL 过期、leave 幂等、按会话合流、连接绑定/改身份拒绝、宿主 close 清理。
- **core drafts**：claim / 续期 / 过期 / force 接管、connectionId 级租约、version 冲突、`draft.send` 事务内清草稿（含路由失败注入）、会话删除级联、迁移、附件清扫引用保护、大小/深度/mention 上限、限流。
- **集成**：临时数据目录 + 真实 `SessionHub`，3 条 WS 连接跑「A 输入 → B 看到草稿与光标 → B 接管 → A 只读 → 发送后全端清空」；身份冒用与 `DRAFT_BUSY` 有断言；租约过期由 core 单测覆盖。
- **渲染端**：三态状态机、远端光标版本校验（`remote-caret-model`）、selection 心跳/清理、IME 组合期不广播、旧草稿 v2→v3 迁移与键清理、断线 pending 保留与 stale 恢复、force takeover 降级。
- **e2e**：同一 headless 上两个浏览器上下文 + 一个 Electron 本地端点；A 输入时 B 只读并看到光标；B 接管；发送后两端清空；审批首胜提示 `decidedBy`（尚未落地，真机清单保留）。

## 12 分期

- **P1 在线状态（D119）**：身份、presence 服务与事件、输入区头像/正在输入。不改草稿，风险最低。**已实施（2026-11-09）**。
- **P2 共享草稿与光标（D120/D121）**：`composer_drafts`、租约、`draft.*` RPC、整份快照同步、远端光标、接管、发送原子清空、旧草稿迁移。核心体验在本期。**已实施（2026-11-09）**。
- **P3 归属与冲突体验**：消息「来自 X」、审批 `decidedBy`、断线恢复提示、每客户端显示名设置。**已实施（2026-11-09）**；断线恢复提示仍是简化版（offline 保留本地缓冲，无独立横幅）。
- **P4（可选）真正同时编辑**：Yjs + `y-prosemirror` + awareness；草稿表改存 Yjs 更新，presence 换成 awareness。本期明确不做。

## 13 与既有文档的关系

- [46](46-remote-control.md)：多端点广播与一致性语义不变；补充「多客户端协作见 57」。viewer ≤5 是传输并发上限，不是身份模型。
- [49](49-headless-server.md)：多客户端在线是既有能力；本篇补齐协作语义。单大脑、单数据目录原则不变。
- [01](01-conversation.md)：输入与发送的直发语义不变；草稿从「本地缓存」改为「服务端共享 + 本地缓冲」。
- [12](12-ui-layout.md)：输入区新增在线/只读/接管状态。
- [13](13-permissions.md)：审批首胜不变，仅补充归属展示。

## 修订记录

- 2026-11-09：初稿（D119–D121），待实施。
- 2026-11-09：P1 在线状态、P2 共享草稿与远端光标实施完成（D119–D121 的感知 / 编辑部分）；消息与审批归属（D121 的归属部分）留下期。
- 2026-11-09：P3 消息与审批归属实施完成（「来自 X」/「已被 X 处理」）；仅剩每客户端显示名设置。
- 2026-11-09：每客户端显示名设置实施完成（侧栏用户菜单 / 窄屏「我」页；只存本机，改名即时重报 presence）。

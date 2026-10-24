# 44 macOS Share Extension（系统分享接收）

**状态：P0 代码已实施（S1–S10，2026-10-22）；§15 验收中依赖真机的部分未做（见 §19.4）。决策编号 D94。P0 前置预研见 §16（结论见 §19）。**

## 0 摘要

KepCup 提供一个 macOS Share Extension，接收微信「合并转发 → 转发到其他应用」、Finder、Safari、邮件等系统分享来源的文件。用户在扩展内选择目标 **Bot 或项目组**，可附一句说明；KepCup 把文件落到会话附件库，并在发给模型的附件行里带上**当前 Bot workspace 内的稳定副本路径**。Bot 拿到的是路径，不是正文，也不是原始分享源路径；由 Bot 自己决定 `read`、`bash`、开任务解压、走文件技能还是进一步处理。

硬约束：

1. 不把 ZIP/TXT/PDF/微信聊天正文预灌进模型上下文。
2. 不把分享源的原始路径直接给 Bot（沙盒、TCC、临时文件、源应用删除都不可靠）。
3. 不把 `~/.kepcup/conversations/.../attachments/` 附件库路径直接给 Bot（不在 Bot 沙盒可读范围）。
4. 给 Bot 的路径必须是宿主物化的 **workspace 副本绝对路径**，可直接读取；原文件不动。

### 0.1 现状（实施前）

| 能力 | 现状 | 本设计是否改动 |
|---|---|---|
| 附件落盘 / 消息绑定 | `attachments.upload`、`{home}/conversations/{id}/attachments/`、`messages.send` 已有；附件行只有 id / 文件名 / mime / 大小 | 复用，不改表 |
| 附件读取 | `get_attachment` 文本返回 `<untrusted>` 内容，二进制复制到 workspace `.attachments/` 并返回路径 | 复用并抽出 `ensureShareAttachmentCopy` |
| 上下文附件行 | 现网格式无 path | **改为** 分享消息追加 workspace 副本 path |
| 系统分享接收 | 无 Share Extension、无 App Group、无 `kepcup://`、无 `.appex` 打包 | 新增 |
| main ↔ core | main 通过 port B 调用 core platform 方法 | 新增 `share.targets` / `share.consume` |
| 分享失败恢复 | 无 | 新增 `share_intakes` + 恢复面板 |

## 1 决策（D94）

| # | 决策 |
|---|---|
| D94-1 | **系统 Share Extension，不是微信 SDK / Open Platform。** macOS 应用包内提供 `NSExtension`（Share Extension），接收系统 Share sheet 交付的文件；微信只是首发流量来源，契约不绑微信。 |
| D94-2 | **产品路径**：分享 → 扩展选 Bot / 项目组（可附言）→ App Group inbox + manifest → URL 唤醒主应用 → 主应用移入 core inbox → core 事务落盘并发送消息 → 按既有路由唤醒对话轮。 |
| D94-3 | **路径引用 + 禁止正文灌模型（硬约束）。** 文件最终落盘到会话附件目录；上下文组装时按当前 Bot 物化 workspace 副本，附件行 = **附件 id、文件名、mime、大小、workspace 副本绝对路径**。不写原始分享源路径、附件库路径、ZIP/TXT/PDF 全文或解压文本。 |
| D94-4 | **消息语义**：普通用户文本消息（`senderType='user'`、`kind='text'`），`text` 只放附言（可为空）；`textContent` 增可选 `shareIntakeId`，用于 UI 来源标签与路径物化依据。**不新增 `origin` 枚举值**，`triggerFromUser` 判定不变（分享与用户手输同权；若安全评审要收紧，须单独修订 D89）。 |
| D94-5 | **投递通道**：扩展只写 App Group inbox 并发起 `kepcup://share-intake?id=…`；主应用无论是否已运行都从 inbox 消费。消息、附件绑定与 intake 状态由 core 的 `share.consume` 在一个事务里完成；`share_intakes` 表保证同一 intake 不重复发消息。 |
| D94-6 | **目标选择**：Bot 列表包含管家；项目组列表只含真实项目，不含隐藏系统实体。扩展展示主应用写入的只读快照，core 确认时按实时数据校验。目标会话已归档 → 自动取消归档；Bot / 项目已删 / 会话只读 → 进入失败恢复并保留文件。 |
| D94-7 | **大小与类型**：单文件沿用 `MAX_ATTACHMENT_BYTES` = 30MB；每次最多 10 个文件、总量 60MB；附言最多 2000 字符。系统分享的纯文本落为 `.txt` 附件。ZIP 整包保留，宿主 / 扩展不在投递时解压；Bot 可在任务中自行解压。超限在扩展内拒绝。 |
| D94-8 | **失败恢复（P0）**：目标失效、hash 不符、磁盘错误不丢文件；`share_intakes` 记 `failed*`，主窗口恢复面板允许重选目标、重试、删除；保留 7 天。 |
| D94-9 | **安全边界**：扩展只处理用户当次主动分享的 payload；不读微信数据库、不注入微信进程、不后台扫聊天；扩展不联网、不跑 LLM。文件名清洗、拒绝目录 / 符号链接 / 包、校验大小与 SHA256、处理云盘占位文件；P0 不解压，不承诺拒绝畸形 ZIP。 |
| D94-10 | **平台范围**：P0 仅 **macOS**（Electron 主程序 + 原生 Share Extension 目标）；Windows / Linux / iOS / Android 另案。 |
| D94-11 | **分发与签名**：扩展是独立 `.appex`，由 Xcode 目标构建，CI 用 `xcodebuild` 产出并签名，再由打包钩子放入 `KepCup.app/Contents/PlugIns/`，与主应用一起公证。扩展启用 App Sandbox 与 App Group；主应用虽不是 App Sandbox 构建，也要加 App Group entitlement。 |
| D94-12 | **不改附件表结构、不新增设置目录条目。** 不新增 `attachments.source`，不加「分享专用」模型注入通道；分享只是附件 + 普通用户消息。 |

## 2 目标与非目标

### 2.1 目标

- 系统分享列表出现「KepCup」，扩展内可选 Bot / 项目组。
- 微信合并转发 ZIP 及任意声明类型文件稳定进入选定会话，消息流可见文件 chip。
- 模型上下文只出现附件 id / 文件名 / mime / 大小 / **当前 Bot 可直接读取的 workspace 副本路径**；不出现原始路径和全文。
- Bot 不调用 `get_attachment` 也能直接 `read` / `bash`；解压 / 写产物按 D75 开任务。`get_attachment` 作为重新物化与文本读取入口。
- 投递幂等、崩溃可恢复、目标失效不丢文件。
- 项目组按查看 Bot 分别物化路径，不同 Bot 的路径互不串台。
- 原文件只被读取，不被修改；Bot 处理的是宿主副本。

### 2.2 非目标（P0 不做）

- 微信开放平台移动应用审核、App→微信分享、公众号 / 视频号 API。
- 依赖第三方「微信流 / WeChatBridge」；可参考形态，不捆绑安装。
- Windows / Linux / iOS / Android 分享接收。
- 自动粘贴进第三方 AI 输入框（Accessibility 模拟 ⌘V）。
- 扩展内跑 LLM、解压全文、建索引；重活在主应用与 core。
- 分享历史、场景提示词库、上次目标记忆（P1 / P2）。
- 把原始分享源路径或附件库路径直接给 Bot。
- 把文件正文、解压全文拼进上下文。
- P0 自动展开微信归档；P1 再评估宿主工具或 Bot 技能。

## 3 产品形态

### 3.1 用户路径（微信首发）

1. Mac 微信 ≥4.1.13：多选消息 → 合并转发 →「转发到其他应用」→ 选 **KepCup**。
2. Share Extension 弹出：列表 / 搜索 **Bot** 与 **项目组**；可填附言（≤2000 字符）。
3. 确认后：扩展把文件、manifest、`ready` 写入 App Group inbox，随后唤起主应用；主应用未开则冷启动。
4. 目标会话出现一条用户消息（附言；附言为空时正文为空）+ 文件 chip。UI 按 `shareIntakeId` 显示「通过系统分享导入」，不生成用户口吻的默认文案。
5. 对话轮被唤醒；模型看到附件行，例如：

```text
（附件：att_… chat.zip [application/zip] 2048KB path="/Users/…/.kepcup/bots/bot_x/workspaces/conv_y/.attachments/att_…_chat.zip"）
```

不是 TXT 全文，也不是原始分享源路径。Bot 可直接 `read` / `bash`；解压、转码等写入操作按 D75 开任务。副本丢失时 `get_attachment` 重建。

### 3.2 其它来源

Finder「共享」、Safari、邮件附件、Shortcuts 等走同一扩展与同一落盘路径。来源只在 `shareIntakeId`、宿主日志和恢复面板里体现；不往 `attachments` 表加来源字段，`share_origin` 启发式不做。

### 3.3 目标选择规则

| 目标 | 行为 |
|---|---|
| Bot | 投递到该 Bot 的**私聊**（无则创建；已归档则取消归档）；唤醒该 Bot 对话轮。 |
| 项目组 | 投递到该项目组会话（已归档则取消归档）；路由按 D92：无结构化 @ 时走上一位回话者续接 → 负责人网关。P0 附言里的 `@` 只是文本。 |

- 扩展 UI 数据源：主应用把 `targets.v1.json` 写到 App Group（id、显示名、类型、是否归档；不写密钥与消息正文）。主应用启动、Bot / 项目增删改、归档变化时原子重写。
- 快照过期（默认 24 小时）时扩展提示「列表可能过期，确认时以 KepCup 为准」，仍允许选缓存项；core 确认时按实时数据校验。
- 已删 Bot / 已删项目 / 只读会话在主应用确认时失败，不发送；进入失败恢复，文件保留。
- 管家作为 Bot 出现在列表；不出现隐藏系统实体、内部会话或任务。
- P0 头像用名称首字，不复制头像文件；项目组只显示名称与是否归档。

### 3.4 附言、纯文本与 @

- 附言非空 → 消息 `text` = 附言；附言为空 → `text = ''`，仍允许「空文本 + 附件」。
- 系统分享来的**纯文本内容**（不是附言）落成 `.txt` 附件；不把分享正文写进 `text`。
- P0 不提供 mention 选择器，也不解析附言里的 `@`；项目组按 D92 无 @ 路由。需要定向 Bot 时 P1 增加结构化提及。
- 禁止自动生成「以下是聊天记录全文：…」类占位。

### 3.5 失败与恢复（P0）

- **目标失效**：`share_intakes` 标 `failed_target`，文件保留 7 天；主窗口恢复面板用实时 Bot / 项目组列表让用户重选目标并重试，或删除该 intake。
- **扩展无法唤起主应用**：扩展仍完成写入并 `completeRequest`；inbox 留在 App Group，用户下次打开 KepCup 时启动扫描消费。
- **主应用 / core 处理失败**：文件留在 core inbox，`share_intakes` 标 `failed`；恢复面板提供重试 / 删除，不静默丢弃。
- **崩溃**：启动时把超时的 `processing` 重置为 `received` 并重试；已提交消息的按 `done` 处理，不重复发送。
- 失败提示用系统通知或恢复面板；不要求用户重新分享才能找回文件。

## 4 架构

### 4.1 总览

```text
macOS Share sheet（微信 / Finder / Safari / …）
        │  NSExtensionItem（文件 URL / 数据）
        ▼
┌──────────────────────────────────┐
│ KepCup Share Extension           │  选 Bot / 项目组 + 附言
│ （SwiftUI，App Sandbox）          │  复制文件 + manifest + ready 到 App Group
└──────────────┬───────────────────┘
               │ kepcup://share-intake?id=…（URL Scheme）
               ▼
┌──────────────────────────────────┐
│ Electron 主进程                   │  扫描 App Group inbox
│ ShareIntakeCoordinator            │  校验 / 移动到 {home}/inbox/share/{id}
│                                   │  调用 core platform RPC
└──────────────┬───────────────────┘
               │ share.targets / share.consume（port B 平台方法）
               ▼
┌──────────────────────────────────┐
│ core                             │  校验路径 / hash / 目标
│ ShareIntakeService               │  同一事务：share_intakes + 附件 + 消息
│                                   │  既有 mailbox / 路由唤醒
└──────────────┬───────────────────┘
               ▼
     目标会话消息 + 附件 chip
               │
               ▼
     上下文组装（按当前 Bot）：物化 workspace .attachments/<id>_<name>
               │  附件行带 path
               ▼
     对话轮：附件 id / 文件名 / mime / 大小 / workspace 副本路径
     Bot 直接 read / bash；解压等写入按 D75 开任务；get_attachment 可重建
```

### 4.2 分工

| 层 | 职责 |
|---|---|
| Share Extension | 接收 payload；展示目标选择与附言；复制文件、计算 SHA256、写 manifest；发起 URL；尽快 `completeRequest`。不读写 `~/.kepcup`，不调用 core。 |
| 主进程 | URL / 启动扫描；消费 App Group inbox；校验 manifest；移动到 core inbox；调用 `share.consume`；写 `targets.v1.json`；系统通知；不直接读附件库。 |
| core | 校验 intake 路径 / hash；解析目标并取消归档；事务落附件 + 消息 + intake 状态；启动扫描 core inbox；上下文按当前 Bot 物化路径；恢复 RPC。 |
| 渲染层 | 分享失败恢复面板；调用 core 的 `share.failed.*` app RPC；不改分享文件。 |

### 4.3 投递时序

1. 扩展生成 `shareIntakeId`（`shr_` + UUID），写 `share-inbox/{id}/files/`、`manifest.json`、`ready`。
2. 扩展打开 `kepcup://share-intake?id={id}`，然后 `completeRequest`；不等待主应用处理完成。
3. 主应用 `open-url` / 启动扫描发现完整目录；校验 manifest 与文件；移动到 `{home}/inbox/share/{id}/`；删除 App Group 目录。
4. 主应用调用 `share.consume`；core 校验路径与 hash、解析目标、必要时取消归档。
5. core 在事务内：幂等检查 → 上传附件数据库行 → 写用户消息（`shareIntakeId`）→ 绑定附件 → `share_intakes.done`；提交后走既有投递 / 路由 / 唤醒。
6. 对话轮组装上下文时，对带 `shareIntakeId` 的消息按当前 Bot 物化 workspace 副本，附件行带 `path`。
7. 成功后清理 core inbox；失败保留并进入恢复面板。

### 4.4 投递状态机

扩展只负责 `staged`（文件 + manifest + ready 完整）。core 的 `share_intakes.state`：

| 状态 | 含义 | 后续 |
|---|---|---|
| `received` | core 已发现完整目录，尚未提交。 | 自动 `share.consume`。 |
| `processing` | 正在落附件 / 发消息。启动时超过 10 分钟视为中断，重置为 `received`。 | 重试安全。 |
| `done` | 消息已提交；保留 `messageId`、附件 id。 | 清理暂存；重复调用直接返回。 |
| `failed_target` | 目标已删 / 只读 / 无法解析。 | 保留文件，等用户重选目标。 |
| `failed` | hash 不符、磁盘错误、manifest 损坏等。 | 保留文件，等用户重试 / 删除。 |

### 4.5 为什么不用原始路径 / 附件库路径 / base64

| 方案 | 结论 | 原因 |
|---|---|---|
| 直接给分享源原始路径 | 不做 | Share Extension 拿到的是安全作用域临时 URL；源文件可能被删、移动、在云盘占位或位于其他 App 沙盒；TCC 不保证主进程 / core 可读。 |
| 给 `~/.kepcup/conversations/.../attachments/` 路径 | 不做 | 附件库在 Bot 沙盒的 deny 区域；`read` / `bash` 不一定能读，D36 也不允许把应用数据目录作为普通可授权路径。 |
| 继续只给附件 id，让 Bot 调 `get_attachment` | 保留为兜底 | 能工作，但不是用户要的「首条消息就有路径」；本设计把物化提前并常驻。 |
| 通过 `attachments.upload` base64 搬 30MB ZIP | 不做 | base64 膨胀约 33%，且 30MB / 40MB 上限卡死微信大包；直接走受限文件路径。 |
| 复制到会话 workdir | P1 评估 | 会写入用户工作目录、需要写租约，且项目组 / 无 workdir 场景复杂；P0 先落 workspace。 |
| 项目组共享一个路径 | P0 不做 | 各 Bot workspace 不同；共享路径需要额外沙盒挂载 / 项目 workdir 设计。P0 按查看 Bot 各自物化。 |

## 5 数据与契约

### 5.1 App Group inbox 与 manifest

App Group 容器示例（不是 `Library/Caches`；Caches 可能被系统清理）：

```text
~/Library/Group Containers/<TeamID>.app.kepcup.desktop/share-inbox/{intakeId}/
  manifest.json
  ready
  files/
    000-chat.zip
    001-photo.png
```

`manifest.json`：

```json
{
  "version": 1,
  "intakeId": "shr_01J...",
  "createdAt": 1761196800000,
  "target": { "kind": "bot", "id": "bot_..." },
  "note": "帮我看下这个聊天记录",
  "files": [
    {
      "stagedName": "000-chat.zip",
      "originalName": "chat.zip",
      "mime": "application/zip",
      "size": 12345678,
      "sha256": "…"
    }
  ]
}
```

写入顺序：复制文件 → 逐文件算 SHA256 → 写 `manifest.json.tmp` → `rename` 为 `manifest.json` → 最后写 `ready`。失败则扩展清理未完成目录；主进程只消费带 `ready` 的完整目录。

限制：

- `intakeId` 只接受 `^shr_[A-Za-z0-9_-]{8,64}$`；目录名必须与 manifest 中的 id 一致，防止路径注入。
- 1–10 个文件；单文件 ≤ 30,000,000 字节；总量 ≤ 60,000,000 字节；附言 ≤ 2000 字符。
- 拒绝目录、符号链接、`.app` / `.bundle` 包、零字节文件、路径分隔符 / 控制字符文件名、hash 不符。
- 文件名用 `basename` 清洗；`stagedName` 使用序号 + 安全名，不使用原文件名作路径。
- 云盘占位文件先 `NSFileCoordinator` 协调下载，再复制；下载失败不写半成品。

### 5.2 `targets.v1.json`

主应用写入 App Group 根目录：

```json
{
  "version": 1,
  "generatedAt": 1761196800000,
  "bots": [
    { "id": "bot_...", "name": "阿甲", "kind": "bot", "archived": false }
  ],
  "projects": [
    { "id": "conv_...", "name": "项目讨论组", "kind": "project", "archived": false }
  ]
}
```

- 上限 256KB；tmp + rename 原子写。
- 只含 id、显示名、类型、是否归档；不含密钥、消息、备注、头像文件。项目组 id 是项目根会话 id（D92）。
- 主应用启动、Bot / 项目增删改、归档变化时重写；core 通过 `share.targets` 提供数据，变更时发 `share.targets.changed` 平台事件。
- 扩展读取失败或文件缺失 → 显示「打开 KepCup 同步列表」，禁止确认；快照超过 24 小时 → 提示可能过期，仍可选，core 确认时校验。

### 5.3 `share_intakes` 表（main.db，迁移 `0047_share_intakes.sql`）

```sql
CREATE TABLE share_intakes (
  id              TEXT PRIMARY KEY,
  state           TEXT NOT NULL CHECK (state IN
                    ('received','processing','done','failed_target','failed')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('bot','project')),
  target_id       TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX share_intakes_pending
  ON share_intakes(state, updated_at);
```

- `id` 来自扩展，重复使用同一 id 不重复发消息。
- `target_id`：Bot 目标为 bot id，项目组目标为项目根会话 id。
- `conversation_id` 在目标解析成功后写入；失败目标可为 NULL。
- `error_code` 使用 §5.6 的机器码；`error_message` 只放可展示短文案，不放正文。
- 失败记录保留 7 天；`done` 记录可在清理暂存后保留一段时间供审计或直接删除（P0 保留 7 天，随清扫删除）。
- 对话 / 消息删除时外键置 NULL；失败 intake 的文件仍按 TTL 或用户删除清理，不因会话删除阻塞。

### 5.4 消息与附件

- `attachments` 表与目录不变；不新增 `attachments.source`。
- `textContentSchema` 增可选 `shareIntakeId: string`。
- 消息：`senderType='user'`、`kind='text'`、`text` = 附言（可为空）、`attachmentIds` = 本次分享文件。
- 发送复用 `orchestrator.sendMessage` 的事务、触发批、项目组路由与唤醒逻辑；新增内部入口 `sendShareMessage`（或 `sendMessage` 的可选 `shareIntakeId` 参数），不新开路由通道。
- 不新增 `origin`；`triggerFromUser` 仍为 true（分享是用户主动动作）。若未来安全评审要求收紧，单独修订 D89。
- 项目组消息不带结构化 mentions，按 D92 无 @ 路由；P1 才增加提及选择器。
- 路径不写进 `text`、不写进 `attachments` 表；由上下文组装按查看 Bot 计算，避免项目组多 Bot 串台。

### 5.5 RPC 与事件

**平台方法（core 提供，主进程通过 port B 调用；不暴露给渲染层）**

| 方法 | 输入 | 输出 | 用途 |
|---|---|---|---|
| `share.targets` | `void` | `{ version, generatedAt, bots[], projects[] }` | 主应用生成 `targets.v1.json`。 |
| `share.consume` | `{ intakeId, target, note, files[] }` | `{ state, messageId?, conversationId?, attachmentIds?, errorCode? }` | 主应用移入 core inbox 后消费。 |

**App 方法（渲染层调用）**

| 方法 | 输入 | 输出 | 用途 |
|---|---|---|---|
| `share.failed.list` | `void` | `{ items: ShareFailedItem[] }` | 恢复面板列表。 |
| `share.failed.retry` | `{ intakeId, target }` | `{ state, messageId?, conversationId? }` | 重选目标并重试。 |
| `share.failed.discard` | `{ intakeId }` | `{ ok: true }` | 删除失败 intake 与文件。 |

`ShareFailedItem` 至少包含：`intakeId`、`createdAt`、`errorCode`、`errorMessage`、`target {kind,id}`、`files[{originalName,size,mime}]`、`expiresAt`。

**事件**

- `share.failed.changed`（app 事件，core → 渲染层）：`{ intakeId, state }`；恢复面板刷新。
- `share.targets.changed`（platform 事件，core → 主进程）：Bot / 项目 / 归档变化；主进程防抖后重新拉 `share.targets` 并原子写快照。

**类型草案**

```ts
type ShareTarget = { kind: 'bot' | 'project'; id: string };

type ShareTargetEntry = {
  id: string;
  name: string;
  kind: 'bot' | 'project';
  archived: boolean;
};

type ShareTargets = {
  version: 1;
  generatedAt: number;
  bots: ShareTargetEntry[];
  projects: ShareTargetEntry[];
};

type ShareFile = {
  path: string;          // core inbox 内绝对路径
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
};

type ShareConsumeInput = {
  intakeId: string;
  target: ShareTarget;
  note: string;
  files: ShareFile[];
};

type ShareConsumeOutput = {
  state: 'done' | 'processing' | 'failed_target' | 'failed';
  messageId?: string;
  conversationId?: string;
  attachmentIds?: string[];
  errorCode?: string;
  errorMessage?: string;
};

type ShareFailedItem = {
  intakeId: string;
  createdAt: number;
  expiresAt: number;
  errorCode: string;
  errorMessage: string;
  target: ShareTarget;
  files: Array<{ originalName: string; size: number; mime: string }>;
};
```

事件 payload：

```ts
type ShareFailedChanged = { intakeId: string; state: 'failed_target' | 'failed' | 'done' };
type ShareTargetsChanged = { reason: 'bot' | 'project' | 'archive' | 'startup' };
```

**语义约束**

- `done` 不可变：重复 `share.consume` 返回原 `messageId`，不允许换目标重发。
- `failed_target` / `failed` 才能走 `share.failed.retry`；重试更新 `target_*`、`attempts+1`。
- `processing` 未超时返回忙；超时由 core 启动清扫重置。
- `share.consume` 只接受 core inbox 前缀下的 `path`，不接受渲染层或任意本机路径。
- 事件只携带 id / 状态，不携带附言、文件名以外的正文。

### 5.6 错误码

新增到 `packages/shared/src/errors.ts`：

| 错误码 | 场景 |
|---|---|
| `SHARE_INTAKE_INVALID` | manifest / 路径 / 文件 / hash / 大小非法。 |
| `SHARE_TARGET_NOT_FOUND` | Bot / 项目不存在或已删除。 |
| `SHARE_TARGET_READ_ONLY` | 目标会话只读。 |
| `SHARE_FILE_TOO_LARGE` | 超过单文件 / 总量上限。 |
| `SHARE_MATERIALIZE_FAILED` | workspace 副本物化失败。 |

渲染层 i18n：`share.error.*`（zh-CN / en-US），恢复面板显示短文案；完整错误只进日志。

### 5.7 路径契约

- 目标：`workspacePathFor(botId, conversationId) + '/.attachments/' + attachmentId + '_' + safeFileName`。
- 与 `get_attachment` 当前二进制落点一致；存在且大小 / mtime / sidecar 元数据匹配则复用，否则从附件库重建。首次物化算一次 SHA256 并写 sidecar（`<path>.meta.json`：attachmentId、size、mtime、sha256）；不每轮重算 30MB。
- 物化为只读语义（建议 `0444`）；Bot 要修改文件先复制到 workspace 其它位置。helper 发现副本被改写会重建并恢复原始字节。
- 每个查看 Bot 一份；项目组不同 Bot 路径不同，同一 Bot 多轮复用。
- 上下文行格式：现网附件行 + `path="…"`；`path` 是绝对路径，带引号以保留空格。
- 物化失败：`path=unavailable`，保留 id / 元数据，Bot 用 `get_attachment`。
- 路径不写 DB、不进消息 `text`、不写日志正文；副本丢失可重建。
- `read` / `bash` 读取路径仍按既有规则包 `<untrusted>`；文件内容不预先进入上下文。
- 普通上传附件 P0 保持现网格式（id + 元数据 + `get_attachment`），P1 可评估统一。

## 6 核心实现

### 6.1 shared

新增 `packages/shared/src/domain/share.ts`：

- `shareManifestSchema` / `ShareManifest`
- `shareTargetSchema`（`bot` / `project`）
- `shareTargetsSchema` / `ShareTargets`
- `shareConsumeInputSchema` / `shareConsumeOutputSchema`
- `shareFailedItemSchema` / `shareFailedListOutputSchema`
- `shareFailedRetryInputSchema` / `shareFailedDiscardInputSchema`
- 常量：`SHARE_MAX_FILES=10`、`SHARE_MAX_TOTAL_BYTES=60_000_000`、`SHARE_NOTE_MAX_CHARS=2000`、`SHARE_FAILED_TTL_MS=7d`、`SHARE_PROCESSING_STALE_MS=10min`、`SHARE_TARGETS_STALE_MS=24h`。

修改：

- `packages/shared/src/domain/types.ts`：`textContentSchema.shareIntakeId?: string`。
- `packages/shared/src/errors.ts`：§5.6 错误码。
- `packages/shared/src/rpc/methods.ts`：App 方法 schema + `APP_METHODS`；`PlatformRpcMethods` 增 `share.targets` / `share.consume`；事件 schema。
- `packages/shared/src/rpc/events.ts`（或现有事件登记处）：`share.failed.changed`、`share.targets.changed`。

### 6.2 core 服务

新增 `packages/core/src/share/service.ts`（`ShareIntakeService`）：

- `consume(input)`：幂等检查 → 校验 intake 目录 / 文件 / hash → 解析目标 → 取消归档 → 事务落附件 + 消息 + done。
- `listFailed()` / `retry(input)` / `discard(input)`。
- `sweep()`：启动及定时清理；`processing` 超时重置；失败 TTL；无 DB 行的 core inbox 残留按 24h 清理。
- `targets()`：返回 `share.targets` 快照。
- 依赖注入：`db`、`paths`、`attachments`、`conversations`、`bots`、`orchestrator`、`clock`、`logger`。
- 不直接操作 Electron / App Group；只处理 core inbox 与 DB。

新增 `packages/core/src/share/materialize.ts`：

- `ensureShareAttachmentCopy({ paths, botId, conversationId, attachment, workspacePath })`。
- 校验附件归属与 sha256；`mkdir`、写 0444；复用 / 重建。
- 供上下文组装、`get_attachment`、恢复重试共用。

修改：

- `packages/core/src/start.ts`：注册 `ShareIntakeService`、platform methods、app methods、启动 `sweep`、事件 publish。
- `packages/core/src/domain/messages.ts`：`AppendMessageInput.shareIntakeId?`，content JSON 写入。
- `packages/core/src/dispatch/orchestrator.ts`：`sendMessage` 接受可选 `shareIntakeId`；新增 `sendShareMessage` 或复用；上下文组装传 attachment path map。
- `packages/core/src/agent/context/conversation.ts`：`RenderMessageOptions` 增 `attachmentPaths?: ReadonlyMap<string,string>`；附件行追加 `path`；仅对 `shareIntakeId` 消息。
- `packages/core/src/agent/context/system-prompt.ts`：附件说明补一句 path 语义（workspace 副本、可直接读、原始文件不在上下文、重建用 `get_attachment`）。
- `packages/core/src/tools/index.ts`：`get_attachment` 复用 `ensureShareAttachmentCopy`；文本仍返回 `<untrusted>` 内容。
- `packages/core/src/agent/tools.ts` / `messages.around`：渲染前物化并传入 path map。
- `packages/core/src/index.ts`：导出 share 类型 / 服务（如需要）。

### 6.3 事务与幂等

`share.consume`：

1. 校验 `intakeId` 格式；检查 `share_intakes`：
   - `done` → 返回已有 `messageId`；
   - `processing` 且未超时 → 返回 `processing` / 忙；
   - `failed_target` 且未带新目标 → 返回原失败；带新目标（恢复重试）→ 继续；
   - `failed` → 允许重试（attempts+1）；
   - 无行 → 新建。
2. 校验路径：`realpath` 后必须位于 `{home}/inbox/share/{intakeId}`；只接受普通文件；拒绝符号链接、`..`、目录、包。
3. 校验 manifest / 文件大小 / SHA256；上限见 §5.1。
4. 解析目标：
   - Bot：实时存在且未删；`openDirect` 后归档则 `setArchived(false)`；
   - 项目：实时存在、非只读；归档则 `setArchived(false)`；
   - 失败 → 写 `failed_target`，不发送。
5. 事务：
   - 置 `processing`；
   - `AttachmentsService.upload` 写文件 + 附件行（文件写可先于事务，DB 行在事务内）；
   - `orchestrator.sendShareMessage` 写消息 + claim 附件 + 触发批；
   - 更新 `share_intakes` → `done` + `messageId`；
   - 提交。
6. 提交后：发布消息事件、按既有路由唤醒；清理 core inbox（失败不清理）。
7. 异常：回滚事务；单独事务写 `failed` / `failed_target` + error；文件保留。

说明：

- 文件写入在 DB 行之前；回滚后孤儿文件由 `attachments.sweepOrphans` 回收。
- 同一 intake 的并发调用由 `share_intakes` 主键 + 主进程单飞锁 + core 事务状态检查共同保证。
- `share.consume` 不接受渲染层调用；只作为 port B 平台方法。

### 6.4 目标解析与归档

- 使用 `bots.get` / `conversations.get` / `conversations.openDirect` / `conversations.setArchived` 既有服务。
- 不新写「分享专用」会话创建逻辑。
- 项目组目标必须是 `type='project'` 且未删除；私聊目标必须是 `type='direct'` 或可 `openDirect`。
- 归档自动恢复只针对本次分享的目标；不批量恢复其他会话。
- 只读会话不自动解除只读，直接失败。

### 6.5 上下文路径物化

- 只对带 `shareIntakeId` 的消息启用。
- 上下文组装前，按当前 `botId` / `conversationId` 调用 `ensureShareAttachmentCopy`，构造 `Map<attachmentId, path>`。
- `turn`、`task`、历史消息、`messages.around`、任务简报 / 续接摘要全部共用；不能只改某一条渲染路径。
- 项目组按当前查看 Bot 物化；不同 Bot 路径不同。
- 只读 run 允许物化（复用 `checkHostCopyPath` 的 `.attachments/` 例外）。对话轮只读：可 `read` / 只读命令；解压、转码、写产物按 D75 开任务，任务上下文按任务 Bot 物化同一路径。
- 外部智能体：workspace 在 `allowRead` 内；`cwd=workdir` 的情况需预研确认，必要时回退 `get_attachment`。
- 物化失败不阻断消息投递；附件行标 `path=unavailable`，Bot 用 `get_attachment`。

### 6.6 `get_attachment`

- 文本类：保持返回 `<untrusted>` 内容（截断）。
- 二进制：复用 `ensureShareAttachmentCopy` 的路径；已存在且 hash 匹配则直接返回，不再重复写。
- 非分享附件仍按原逻辑复制到 `.attachments/`。
- 目标路径已存在但 sidecar / 大小 / mtime 不符或权限不对时，先 `unlink` / `chmod` 再用临时文件 + `rename` 原子替换，避免读到半文件；不跟随符号链接。需要强校验时再算 SHA256。
- 不把附件库路径暴露给模型；只返回 workspace 路径。

### 6.7 清理与恢复

- 启动时扫描 `{home}/inbox/share` 的未完成目录，发现 `manifest.json` + `ready` 即调用 `share.consume`；这是「主进程移动后崩溃」的兜底。
- 启动 + 每日：`share_intakes` 中 `processing` 超过 10 分钟 → `received`；`failed*` 超过 7 天 → 删除行 + core inbox；`done` 超过 7 天 → 删除行（文件已清理）。
- core inbox 中无对应 DB 行、且 mtime 超过 24 小时的目录 → 删除。
- App Group 中无 `ready` 或超过 24 小时的目录 → 主进程清理。
- workspace 副本不单独记账；随 workspace 清理消失，下次上下文组装重建。
- 恢复面板删除时同步删除 core inbox 与 DB 行；已发送消息不回收（属于会话历史）。

## 7 主进程

### 7.1 目录与常量

建议新增：

```text
apps/desktop/src/main/share-intake/
  coordinator.ts        # 扫描、单飞、移动、调用 core、清理
  app-group.ts          # group container URL、路径解析
  manifest.ts           # manifest 校验（与 shared schema 共用）
  targets.ts            # targets.v1.json 原子写
  url.ts                # kepcup:// 解析
```

- App Group：`FileManager.containerURL(forSecurityApplicationGroupIdentifier:)` 对应路径；主进程可用 `~/Library/Group Containers/<group>/`，测试 / dev 用 `KEPCUP_SHARE_GROUP_DIR` 覆盖。
- core inbox：`{KEPCUP_HOME ?? ~/.kepcup}/inbox/share/{intakeId}/`。
- 不在主进程写附件库；附件库只由 core 操作。

### 7.2 URL 与启动扫描

- `Info.plist` / `electron-builder.yml` 的 `extendInfo` 增 `CFBundleURLTypes`，注册 `kepcup` scheme。
- `app.on('open-url')`：`preventDefault`，解析 `kepcup://share-intake?id=…`，等待 app ready + core ready 后消费；冷启动排队。
- `requestSingleInstanceLock` 已有；macOS 下同一路径即可。Windows 另案。
- P0 默认把 KepCup 带到前台并定位到目标会话（已登记偏差：当前实现只聚焦主窗口，定位到目标会话待接线，见 §19.2 第 10 条）；静默导入（不抢焦点）作为 P1 体验优化。
- 启动时扫描 App Group 与 `{home}/inbox/share`：App Group 由主进程处理；core inbox 由 core 启动 `sweep` / `consume` 处理，主进程可补调一次 `share.consume` 防漏。
- 主进程未 ready / core 未 ready 时保留 inbox，不做破坏性清理。

### 7.3 消费流程

1. 列出 App Group `share-inbox/*`；只处理有 `ready` 的目录。
2. 校验 `intakeId` 与目录名一致、manifest schema、文件名、大小、hash。
3. 移动：
   - 同卷 `rename`；
   - 跨卷复制到 `{home}/inbox/share/.tmp-{intakeId}/`，逐文件校验后整体 `rename` 为最终目录；
   - 成功后删 App Group 目录；移动失败保留原目录，日志 + 通知，下次启动重试。
4. 调用 `share.consume`：
   - `done` / `failed*` 返回后记录日志；
   - 网络 / core 未就绪错误 → 保留 core inbox，等待 core 重启或下次启动重试；
   - 不自动重试 `failed_target`（等用户恢复面板）。
5. 单飞：每个 `intakeId` 一个 Promise / 锁；并发 URL 与启动扫描不双消费。
6. 失败恢复：core 的 `share.failed.*` 直接读 core inbox；主进程不参与重试写操作。

### 7.4 目标快照

- 启动后调用 `share.targets` 获取快照，写 `targets.v1.json`。
- 在 `CoreHost` 的 platform `eventHandlers` 注册 `share.targets.changed`，防抖 500ms 后重拉重写。
- 原子写：`targets.v1.json.tmp` → `rename`；目录权限 0700，文件 0600。
- 快照不含头像；扩展用名称首字。
- 主应用启动如果 core 未 ready，先写空 / 上次快照；core ready 后重写。

### 7.5 通知与日志

- 成功：可选系统通知「已导入到 {Bot / 项目组}」；不阻塞消息。
- 失败：系统通知 + 恢复面板；日志只记 `intakeId`、目标、文件数 / 字节、状态、耗时、错误码，不记附言和文件内容。
- 不把原始分享源路径写入日志（只记 staging 名与 intake id）。
- 审计：记录 `intakeId`、目标、文件数 / 字节、state、errorCode、耗时；不记附言与文件内容。

## 8 渲染层

### 8.1 恢复面板

建议新增 `apps/desktop/src/renderer/src/lib/features/share/ShareRecoveryPanel.svelte`：

- 启动时 / 收到 `share.failed.changed` 时调用 `share.failed.list`。
- 显示失败项：文件名、大小、时间、原因、原目标、过期时间。
- 操作：
  - 重选目标：复用现有 Bot / 项目选择组件；提交 `share.failed.retry { intakeId, target }`。
  - 重试：目标不变时直接 `share.failed.retry`。
  - 删除：`share.failed.discard`，二次确认。
- 面板挂在主窗口 / `App.svelte` 的全局 overlay；不在通知里直接执行写操作。
- 空列表不显示入口。

### 8.2 i18n

新增 `share.*` 命名空间：

- `share.recovery.title` / `share.recovery.empty`
- `share.recovery.retry` / `share.recovery.reselect` / `share.recovery.discard`
- `share.recovery.expiresAt`
- `share.error.*`（5 个错误码）
- `share.imported`（可选通知）
- 中英文两份；错误码映射到简短可操作文案。

### 8.3 消息流

- 分享消息与普通用户消息同构；UI 用 `shareIntakeId` 显示「通过系统分享导入」标签。
- 不显示 workspace 路径（路径只给模型）；附件 chip 仍可保存 / 查看原文件。
- 空正文 + 附件正常渲染。

## 9 原生 Share Extension

### 9.1 目录与目标

实际布局（实施时未拆 `Shared/` 子目录，全部 Swift 源码在 `ShareExtension/` 下；较原建议多出 `PayloadCollector.swift`——从 `NSExtensionItem` 提取文件 / 纯文本载荷）：

```text
apps/desktop/macos/ShareExtension/
  KepCupShare.xcodeproj/
  ShareExtension/
    Info.plist
    KepCupShare.entitlements
    ShareViewController.swift
    TargetPickerView.swift
    InboxWriter.swift
    PayloadCollector.swift
    SharedConfig.swift
    ShareManifest.swift
    ShareTargets.swift
```

- Bundle id：`app.kepcup.desktop.ShareExtension`（主应用 id 前缀）。
- `NSExtensionPointIdentifier = com.apple.share-services`。
- Activation rule 用 `NSExtensionActivationSupportsFileWithMaxCount`（10）等文件类键；图片 / 影片 / 文本按需声明；ZIP 作为普通文件，不把 `public.file-url` 当接收类型。
- App Group：`<TeamID>.app.kepcup.desktop`（与主应用 entitlements 一致，最终以 Apple 配置为准）。
- 扩展只写 App Group；不读写 `~/.kepcup`，不调用 core RPC。

### 9.2 UI

- SwiftUI：搜索框、Bot / 项目分段列表、最近目标（P1）、附言输入、文件摘要（数量 / 总大小）、确认 / 取消。
- 列表读 `targets.v1.json`；缺失或损坏显示「打开 KepCup 同步列表」，禁止确认。
- 附言限制 2000 字符；空附言允许确认。
- 目标选择只允许快照中的 Bot / 项目；不提供隐藏实体。
- 不在扩展内解压、预览全文或调用模型。

### 9.3 文件处理

- 遍历所有 `NSExtensionItem.attachments`（可多项），按 `hasItemConformingToTypeIdentifier` 判断类型；合并后仍受 10 文件 / 60MB 上限。
- 文件 URL：`loadItem(forTypeIdentifier: "public.file-url")`；对 security-scoped URL 调 `startAccessingSecurityScopedResource()`，复制后 `stopAccessing...`。
- 纯文本 / 字符串：写成 `.txt`（UTF-8），作为附件；不塞进消息正文。
- 图片 / 音视频：按文件处理；扩展不转码。MIME 用 `UTType` 推断，未知用 `application/octet-stream`；不信任扩展名。
- 云盘占位文件：`NSFileCoordinator` 协调读取；失败则该文件失败，不写半成品。
- 计算 SHA256 流式读取；超过单文件 / 总量上限立即失败并提示。
- 文件名清洗：`lastPathComponent` + 替换控制字符；`stagedName` 用 `000-` 序号。
- 拒绝目录、符号链接、包、零字节文件。

### 9.4 manifest 与 ready

- `intakeId`：`shr_` + UUID。
- 写 `manifest.json` 与 `ready` 的规则同 §5.1。
- `completeRequest` 在写完 `ready` 并尝试打开 URL 后调用；不等待主应用处理完成。
- 失败：显示错误，清理未完成目录，调用 `completeRequest` 返回错误（或取消）。

### 9.5 唤起主应用

- 尝试 `NSWorkspace.shared.open(URL(string: "kepcup://share-intake?id=..."))` 或扩展可用的等价 API。
- 若沙盒扩展不允许打开自定义 URL，预研后改用主应用轮询 / 登录项 / helper；不改变 inbox 契约。
- 打开 URL 失败不删除 inbox；用户下次打开 KepCup 时启动扫描。

### 9.6 entitlements

扩展：

- `com.apple.security.app-sandbox = true`
- `com.apple.security.application-groups = [<TeamID>.app.kepcup.desktop]`

主应用：

- 增加同一 `com.apple.security.application-groups`。
- 保持现有 hardened runtime；不引入 App Sandbox。

签名 / 公证：

- `.appex` 先签名，再签外层 app；嵌套代码顺序不能反。
- 使用 Developer ID Application；按需 provisioning profile；`--timestamp`。
- 公证后 `codesign --verify --deep --strict` + `spctl --assess`。
- 干净机器安装、升级、系统分享列表可见。

## 10 打包与发布

### 10.1 构建步骤

新增 `apps/desktop/scripts/build-share-extension.mjs`：

1. 读取目标 arch（arm64 / x64）。
2. `xcodebuild -project ... -scheme KepCupShare -configuration Release -arch ...`。
3. 输出 `apps/desktop/resources/share-extension/{arch}/KepCupShare.appex`。
4. 校验 `Info.plist`、bundle id、entitlements、签名。

`scripts/dist.mjs` 在 electron-builder 之前调用该脚本（仅 macOS）；Windows / Linux 跳过。

### 10.2 electron-builder

- `extraFiles` 或 `afterPack` 把 `.appex` 放到 `KepCup.app/Contents/PlugIns/KepCupShare.appex`。
- `pack-hooks.cjs` 的 `afterPack` 增加硬校验：
  - appex 存在、Info.plist 可解析、`NSExtensionPointIdentifier` 正确；
  - `codesign --verify --strict` 通过；
  - 主应用与扩展 App Group id 一致；
  - 不在 Windows / Linux 产物里出现。
- 签名顺序以 electron-builder 预研结论为准；必要时自定义 `codesign` 钩子。
- 自动更新：appex 随 app bundle 更新；测试从旧版本升级后扩展仍可用。
- 不因扩展上架 Mac App Store；主应用保持 Developer ID + 公证，不引入主应用 App Sandbox。

### 10.3 CI

- macOS build job 增加 Xcode 步骤与签名凭据（Developer ID、Team ID、必要时 provisioning profile）。
- 两个 macOS 架构分别构建；产物分别包含对应 arch 的 appex。
- `release.yml` 的签名 / 公证步骤覆盖嵌套 appex。
- 发版前跑一次「安装 → 分享 → 升级 → 再分享」手工/自动验收。

## 11 安全与隐私

- 原始分享源路径不进入模型、不写日志正文；只给 workspace 副本路径。
- 附件库路径不进入模型；只在 core 内部使用。
- workspace 副本 0444，SHA256 校验；被改写会重建。
- 文件内容通过 `read` / `bash` / `get_attachment` 读取时仍按既有规则包 `<untrusted>`；分享不绕过。
- 扩展沙盒 + 不联网 + 不跑模型；只处理用户当次分享。
- 不读微信数据库、不注入微信进程、不后台扫聊天。
- ZIP 在 P0 不解压；P1 解压必须做路径穿越、大小 / 数量上限、符号链接与压缩炸弹防护。
- App Group 目录 0700 / 文件 0600；manifest 只含元数据，不含正文。
- `share_intakes.error_message` 与日志不写附言 / 文件内容。
- 目标快照不含密钥、头像、消息；只有 id / 显示名 / 类型 / 归档状态。
- 不新增可被 Bot 调用的「读取任意路径」工具；路径只在上下文行出现，读取走既有工具。
- 不申请全磁盘访问 / 额外 TCC 权限：扩展只使用系统分享给它的 security-scoped 资源，主应用只读 App Group 与 core inbox 副本。
- 不执行分享文件；不信任 MIME / 扩展名，ZIP 在 P0 只按字节保存，不解压。

## 12 测试

### 12.1 shared / core 单测

- schema：manifest、targets、consume、failed item 的合法 / 非法输入。
- `ShareIntakeService.consume`：
  - 正常 Bot / 项目投递；
  - 同一 intake 两次调用一条消息；
  - 目标不存在 / 只读 / 已归档；
  - hash 不符 / 超限 / 空文件 / 目录 / 符号链接；
  - 事务回滚后无半条消息、孤儿文件可回收；
  - `processing` 超时重置；
  - 失败 7 天清理。
- 路径：
  - `ensureShareAttachmentCopy` 复用 / 重建 / 0444 / SHA；
  - 项目组两个 Bot 路径不同；
  - 只读 run 允许物化；
  - 物化失败 `path=unavailable`。
- 上下文：
  - 带 `shareIntakeId` 的消息含 path、id、文件名、mime、大小；
  - 不含原始路径、ZIP 内 TXT 全文、默认文案；
  - 普通附件行不变；
  - `messages.around` / 历史 / 任务路径同样带 path。
- `get_attachment`：文本 `<untrusted>`、二进制复用路径、删除副本后重建。
- 迁移：`0047` 在旧库上执行、重复执行、失败回滚 / 备份；`attachments` 表结构不变。
- 系统提示：path 语义存在且不影响其他附件说明。

### 12.2 主进程 / 集成

- App Group manifest 校验、`ready` 标记、原子移动、跨卷复制、失败保留。
- URL 解析、冷启动、已运行、重复 URL、core 未就绪。
- `targets.v1.json` 原子写、过期、缺失。
- 恢复面板 RPC：list / retry / discard。
- 事件：`share.failed.changed`、`share.targets.changed`。
- 打包：appex 存在、签名、公证、升级。

### 12.3 手工 / 真机

- Finder PDF、Safari 下载、Shortcuts、邮件附件。
- 微信 ≥4.1.13 合并转发 ZIP；未安装第三方微信流。
- 冷启动 / 已运行 / 重复分享 / 目标归档 / 目标删除 / 超 30MB / 多文件。
- Bot 不调 `get_attachment` 直接 `read` / `bash` / `unzip` 路径。
- 项目组不同 Bot 读各自 path。
- 升级安装后扩展仍显示。

### 12.4 发版验收

- `codesign --verify --deep --strict`、`spctl --assess`。
- 干净机器 / 旧版本升级 / 系统分享列表。
- 不把测试路径标记打进产物（沿用 `pack-hooks.cjs`）。

### 12.5 测试命令

迭代时只跑定向测试，沿用仓库约定：

```bash
node scripts/run-tests.mjs run packages/shared/test/unit/share-*.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/share-*.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/share-*.test.ts
node scripts/run-tests.mjs run apps/desktop/src/main/share-intake/share-intake.test.ts
node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/share/share-recovery.svelte.test.ts
```

涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；类型检查按包跑 `pnpm --filter @kepcup/core typecheck`、`pnpm --filter @kepcup/desktop typecheck`。全量测试只在收口 / 最终交付前跑一次。

## 13 实施任务清单

| ID | 任务 | 主要文件 | 依赖 | 完成标准 |
|---|---|---|---|---|
| S1 | shared 契约 | `packages/shared/src/domain/share.ts`、`types.ts`、`errors.ts`、`rpc/methods.ts`、事件登记 | — | schema / 错误码 / 常量单测通过。 |
| S2 | 迁移与表 | `packages/core/migrations/main/0047_share_intakes.sql` | S1 | 迁移可重复执行；状态约束 / 索引正确。 |
| S3 | core 服务 | `packages/core/src/share/service.ts`、`materialize.ts`、`start.ts` | S1/S2 | consume 幂等、事务、目标解析、失败恢复单测。 |
| S4 | 消息与上下文 | `domain/messages.ts`、`dispatch/orchestrator.ts`、`agent/context/conversation.ts`、`system-prompt.ts`、`tools/index.ts` | S3 | 分享消息带 path；普通附件不变；`get_attachment` 复用。 |
| S5 | 平台 / App RPC 与事件 | `core/src/start.ts`、`shared/rpc/methods.ts` | S3 | `share.targets` / `share.consume` / `share.failed.*` 可用。 |
| S6 | 主进程协调器 | `apps/desktop/src/main/share-intake/*`、`main/index.ts`、`electron-builder.yml` | S5 | URL / 启动扫描 / 移动 / 快照 / 通知通过单测。 |
| S7 | 恢复面板 | `renderer/features/share/*`、i18n、全局挂载 | S5 | list / retry / discard 可用；中文 / 英文文案。 |
| S8 | 原生扩展 | `apps/desktop/macos/ShareExtension/*` | S1 | 分享列表可见、选目标、写 manifest、打开 URL。 |
| S9 | 打包签名 | `build-share-extension.mjs`、`dist.mjs`、`pack-hooks.cjs`、`release.yml` | S8 | 签名 / 公证 / 安装 / 升级通过。 |
| S10 | 验收与文档 | 测试、本文件、README、`11-storage.md`、`dev/04-agent-runtime.md`、`20-conversation-media.md` | S1–S9 | §15 全部通过；目录 / 上下文行文档同步。 |

建议实施顺序：S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10。S1–S5 可在无扩展时用 fixture manifest 测试；S8 完成前不要合并到发布分支。

## 14 分期

| 期 | 范围 |
|---|---|
| **P0** | macOS Share Extension；App Group inbox + manifest + URL；选 Bot / 项目组；附言；附件落盘；上下文 workspace 副本 path；ZIP 整包；归档自动恢复；`share_intakes` 幂等；失败恢复面板；冷启动；签名 / 公证 / 发版验证。 |
| **P1** | 分享历史；上次目标；结构化 mention 选择器；普通附件统一 path 语义（可选）；解压微信归档工具（按需读盘 + `<untrusted>`）；静默导入；项目组共享 workdir / 减少副本。 |
| **P2** | Windows「打开方式 / 共享目标」；场景化附言模板；更多来源适配。 |

## 15 验收（P0）

1. 未安装第三方微信流时，Mac 微信「转发到其他应用」能进入系统 Share sheet 并看到 KepCup；若当前微信版本不走系统 Share sheet，P0 入口不成立，必须回到设计评审（可评估 §16 的降级入口），不能用 Finder 分享替代这条验收。
2. 转发 ZIP → 选某 Bot → 该 Bot 私聊出现附件 chip；打开 chip 可保存 / 查看原 ZIP；消息正文为空或仅为附言。
3. 抓取该轮送入模型的 user 内容：有附件 id、文件名、mime、大小和 `path`；`path` 指向当前 Bot 的 workspace 副本、文件 SHA256 与分享一致；无原始分享源路径、无 ZIP 内聊天 TXT 全文、无默认占位文案。
4. Bot 不调用 `get_attachment`，直接用 `read` / `bash` 读取 `path` 即可拿到与分享一致的字节（SHA256 相同）；解压 / 写产物由任务按 D75 执行；删除副本后 `get_attachment` 能重建。
5. 选项目组时消息出现在该项目组；无 @ 时路由符合 D92（续接 / 负责人网关）；不同成员 Bot 的上下文 path 在各自 workspace。
6. Finder 分享一个 PDF 到 KepCup 同样成功（证明非微信专用）。
7. 目标私聊已归档 → 分享后会话取消归档并可见；目标 Bot 已删 → 不发送、文件保留、恢复面板可重选。
8. 同一 intake 的重复 URL / 主应用崩溃重启不产生第二条消息；扩展中断留下的不完整目录不被消费。
9. 超过 30MB 的单文件在扩展内被拒绝，不产生会话消息；附言为空时仍可发送。
10. 安装 / 升级后的签名包在干净机器上 `spctl` 通过，系统分享列表仍显示 KepCup。
11. 普通上传附件的上下文行保持原格式（P0 不做统一）；分享附件不影响 D61 图片视觉通道。
12. 日志 / 错误面板不含附言或文件正文；原始分享源路径不进入模型上下文。

## 16 风险与 P0 前置预研

以下第 1–4 项在 P0 开工前必须有结论；任何一项不成立都先改设计，不进入实现。第 5–8 项可并行。

1. **微信是否走系统 Share sheet**：在目标版本取证（截图 / 系统日志 / 实际列表）。若微信用自有转发列表，KepCup 不会出现；需降级入口（Finder 打开方式、Services 菜单、拖到 Dock / 菜单栏、Shortcuts）或重新评估首发路径。
2. **真实 ZIP 体积**：采集含图片 / 视频的合并转发样本。若典型文件 >30MB，P0 必须决定提高分享附件上限还是改变附件合同；不能假设「通常远小于上限」。
3. **沙盒扩展唤起主应用**：验证 SwiftUI Share Extension 能否用 `NSWorkspace` 或可用 API 打开 `kepcup://`；不行则扩展写 inbox + 主应用轮询（已运行）/ 登录项或 helper 唤起（未运行）。
4. **electron-builder 嵌套签名与 App Group**：验证 `Contents/PlugIns/*.appex` 签名顺序、Developer ID + 非沙盒主应用的 App Group entitlement、公证、自动更新；必要时自定义签名钩子或主进程固定路径访问 group container。
5. **扩展资源限制**：SwiftUI 扩展内存 / 启动时间；30MB 复制与 SHA256 是否分块 / 流式。
6. **外部智能体 / 任务 cwd 的 path 可见性**：验证 `cwd=workdir` 的外部智能体与任务对 workspace `.attachments/` 的访问；不可见时回退 `get_attachment`，或把副本放到其 cwd（需单独设计）。
7. **项目组多副本成本**：每个查看 Bot 各一份副本；P1 评估项目共享 workdir、APFS clone / 硬链接（注意硬链接会共享修改，不可直接用于可写文件）。
8. **P1 解压归属**：微信归档展开是宿主工具还是 Bot 技能；无论哪种都必须按需读盘、不预展开、内容包 `<untrusted>`。

## 17 兼容与回滚

- 迁移只新增表，不改 `attachments` / `messages`；旧消息照常读取。
- `shareIntakeId` 为可选字段；旧客户端 / 旧消息忽略。
- 普通上传附件行为不变；只对带 `shareIntakeId` 的消息物化 path。
- 若扩展不可用 / 未签名，主应用仍可通过 Finder 打开方式或手工上传使用附件；不阻塞现有功能。
- 回滚：删除新表与 appex 即可；已发送分享消息仍按普通附件存在，`shareIntakeId` 未知时按普通附件处理。
- 旧版本升级后 appex 必须随 app bundle 更新；测试升级路径。

### 17.1 需同步的文档

| 文件 | 同步内容 |
|---|---|
| `docs/design/11-storage.md` | 增加 `{home}/inbox/share/{intakeId}/` 中转入库；注明分享附件仍落 `conversations/{id}/attachments/`。 |
| `docs/dev/04-agent-runtime.md` | 上下文附件行补 `path` 语义；`get_attachment` 复用 `ensureShareAttachmentCopy`；`messages.around` / 历史同样物化。 |
| `docs/design/20-conversation-media.md` | 注明 D94 分享消息在附件行追加 workspace 副本 path；普通上传 P0 不变。 |
| `docs/design/13-permissions.md` | 确认 `.attachments/` 的 host copy 例外同时覆盖上下文物化，不需要新的用户授权。 |
| `docs/design/README.md` | D94 与 44 索引（已更新）。 |

## 18 修订记录

| 日期 | 修改 |
|---|---|
| 2026-10-22 | 初版评审修订：补 App Group 路径、扩展沙盒、URL Scheme、`share_intakes` 幂等、失败恢复、归档恢复、空附言、纯文本 `.txt`、P0 不解析 @、去掉 `attachments.source`、修正 D22 → D63、D30 → D75。 |
| 2026-10-22 | 按用户确认改为 **workspace 稳定副本路径**：上下文附件行带 `path`，按查看 Bot 物化（项目组各 Bot 独立），路径不落消息 / DB；`get_attachment` 复用 / 重建；补完整实施任务、RPC、表结构、原生扩展、打包签名、测试与验收。 |
| 2026-10-22 | **P0 实施完成**（S1–S10）：shared 契约 + `share_intakes` 迁移 + core 分享服务（幂等 / 事务 / 目标解析 / 失败恢复 / 清扫）+ 上下文 workspace 副本 path + 平台与 App RPC + 主进程协调器（App Group inbox → core inbox → `share.consume`）+ 恢复面板 + 原生 Share Extension（Swift / Xcode 目标）+ 打包签名钩子；实施偏差与 §16 预研结论见 §19。代码与单测完成；**§15 验收中真机相关条目未做**（微信 / Finder 分享、签名包下 App Group 读写、公证与系统分享列表可见性，见 §19.4），完成前 P0 不算收口。 |
| 2026-10-22 | 承诺-实现偏差补登（§19.2 第 8–10 条）：扩展 Swift 常量组 id 缺 TeamID 前缀（修复中）、pack 钩子 App Group 一致性校验未真实实现（修复中）、分享导入未定位到目标会话（待接线）；§12.5 测试命令改为实际路径、§9.1 目录结构按实际布局修正、`11-storage.md` 补分享附件去向说明。 |
| 2026-10-24 | 修复空态分享面板关不掉（用户反馈）：payload 收集为空时只显示「没有可导入的内容」便挂起——不展示 picker（取消按钮所在）、不调 `cancelRequest`，而系统分享面板无关闭控件，面板永远关不掉；现按 §9.4 要求提示 4 秒后自动取消。同修两处：`showMessage` 复用同一 label（此前每次新添一条，loading 与空态文案叠印）；`loadFile` 的 `public.file-url` 载荷兼容 Data（URL 字符串 / plist 编码）与 String 形态（此前只认 URL，部分来源的文件分享被静默判成空态）。 |
| 2026-10-24 | 修复打包缺陷「扩展读不到目标列表」（用户反馈，真机取证）：electron-builder.yml 里 group.json 的 extraResources 单文件条目 `to: share-extension` 不带文件名，electron-builder 把它当目标文件路径，拷出一个名为 `share-extension` 的**文件**——主进程读不到 `Resources/share-extension/group.json`，回落无前缀组 id，把目标快照写进 `app.kepcup.desktop`（无 TeamID 前缀）容器，而扩展（entitlements 带前缀）读 `8CL9PRK85J.app.kepcup.desktop` 容器，两边永不对上。修复：`to` 写完整文件名 `share-extension/group.json`；pack 钩子 `assertShareExtension` 补硬校验（包内 group.json 必须存在且组 id 与构建基准一致），防同类静默回归。 |
| 2026-10-24 | 真机取证补登：**未签名本地构建的主应用写不了 App Group 容器**（GUI 启动即 `EPERM ... targets.v1.json.tmp`）——containermanagerd 管理的容器（schema 2，扩展创建）只放行带匹配 `application-groups` entitlement 的签名进程；终端启动「能写」是继承了终端的 Full Disk Access，属假象；旧无前缀容器是 schema 0 的非受管目录，任何进程可写（旧构建能写它纯属侥幸）。本地验证分享链路必须 `CSC_NAME="Pengfei Li (8CL9PRK85J)" pnpm dist`（**CSC_NAME 不带 `Developer ID Application:` 前缀**，electron-builder 拒绝带前缀的值；打包钩子按 group.json 的 TeamID 展开 entitlements，与扩展同组）；签名构建 GUI 启动实测可稳定写容器（替换安装后的**首次**启动出现过一次 EPERM，重启即恢复——疑似 AMFI 签名登记延迟）。另修既有 bug：恢复面板 `share.failed.list` 调用缺 `{}` 入参，被 zod 拒为 INVALID_INPUT（失败列表一直拉不到）。 |
| 2026-10-24 | **静默导入提前落地**（原 P1，用户反馈「发送后拉起了主窗口」）：`handleShareUrl` 消费成功不再 `showWindow()`，失败改走系统通知（点通知才开窗）；冷启动唤起（URL 先于 core ready 到达）置 `shareWakeLaunch` 标记，core **首次** ready 时跳过 `ensureWindow()`（失败 / 锁定等异常状态照常弹，之后 core 崩溃重启再 ready 也照常弹；点 Dock / 托盘随时可开）。同补一个洞：`drainShareIntakes` 此前丢弃队列消费结果——冷启动唤起的失败批次永远无通知，现并入 `notifyShareFailures`。同轮 UI 微调：附言输入框加 4px 内边距；确认按钮「导入 / Import」改「发送 / Send」。 |
| 2026-10-24 | 子代理审查收口（P1）：分享 URL 的排队依据从「协调器是否已建」改为「core 是否已 ready」（`coreReady` 标志）——协调器在 bootstrap 里同步创建而 core ready 晚数秒，窗口期到达的 URL 直接 consume 会因平台端口未连而失败，误发「分享导入失败」通知（几秒后 core 启动扫描会补消费成功）且 `shareWakeLaunch` 失效、ready 时照旧弹窗，恰好复现本次要修的「发送后拉起主窗口」。core down / failed 时复位 `coreReady`，期间到达的 URL 重新排队、恢复 ready 后由 drain 统一消费。配套：share-recovery 测试补 `params` 断言锁住 `{}` 入参回归（P2）。 |
| 2026-10-24 | 子代理审查 P2 全量收口：① `fileURLFromString` 对未编码裸路径（空格 / 非 ASCII）按 `URL(fileURLWithPath:)` 兜底；`fileURLFromData` 增加 plist 字典形态（`NS.relative` / `NSFileSystemPath`）与 keyed-archiver 归档 NSURL（`NSKeyedUnarchiver`）两种载荷。② `drainShareIntakes` 的通知按 intakeId 去重（搬移失败的批次会同时出现在 consumed 与 scan）。③ core down / failed 时同时复位 `shareWakeLaunch`——异常后恢复的 ready 不再静默，静默只属于一次完整的分享唤起启动。④ 扩展面板用户可见文案与「发送 / Send」按钮统一：标题「发送到 KepCup / Send to KepCup」、空态「没有可发送的内容。 / Nothing to send.」、失败「发送失败：%@ / Send failed: %@」；主应用侧「通过系统分享导入」消息标签与恢复面板标题保持「导入」措辞——那是 §7.4 钦定的 KepCup 侧动作描述，与用户侧「发送」互补不改。⑤ 审查另指 zh-CN.ts 一行格式 reflow 与 `update.readyToInstall` 相关——属同分支另一批未提交工作（bot-template / 桌面壳）的格式整理，非本轮改动，不动。 |

## 19 实施记录（P0，2026-10-22）

### 19.1 落地位置

| 任务 | 落地 |
|---|---|
| S1 | `packages/shared/src/domain/share.ts`（schema + 常量 + 事件 payload）、`domain/types.ts`（`textContentSchema.shareIntakeId`）、`errors.ts`（5 个错误码）、`rpc/methods.ts`（`share.targets` / `share.consume` 平台方法 + `share.failed.*` App 方法）、`rpc/events.ts`（`share.failed.changed` App 事件 + `share.targets.changed` 平台事件） |
| S2 | `packages/core/migrations/main/0047_share_intakes.sql` |
| S3 | `packages/core/src/share/service.ts`（`ShareIntakeService`）、`packages/core/src/share/materialize.ts`（`ensureShareAttachmentCopy`）、`packages/core/src/infra/paths.ts`（`shareInboxDir`） |
| S4 | `packages/core/src/domain/messages.ts`（`AppendMessageInput.shareIntakeId`）、`dispatch/orchestrator.ts`（`sendShareMessage` + 事务内/提交后两段）、`agent/context/conversation.ts`（`RenderMessageOptions.shareAttachmentPath` + 附件行 `path=`）、`agent/context/system-prompt.ts`（path 语义）、`tools/index.ts`（`get_attachment` 复用同一副本落点） |
| S5 | `packages/core/src/start.ts`（服务构造、平台方法、启动清扫、`share.targets.changed`）、`packages/core/src/rpc/bindings.ts`（`share.failed.*`） |
| S6 | `apps/desktop/src/main/share-intake/{coordinator,app-group,manifest,targets,url}.ts`、`main/index.ts`（`open-url` / 启动扫描 / 周期扫描 / 快照重写）、`main/core-host.ts`（平台事件）、`electron-builder.yml`（URL Scheme）、`resources/entitlements.mac.plist`（App Group） |
| S7 | `apps/desktop/src/renderer/src/lib/features/share/{ShareRecoveryPanel.svelte,share-recovery.svelte.ts}`、i18n `share.*`、消息流「通过系统分享导入」标签 |
| S8 | `apps/desktop/macos/ShareExtension/`（Xcode 目标 `KepCupShare`：显式 file reference 的 `.xcodeproj` + Swift 源码 `ShareExtension/`） |
| S9 | `apps/desktop/scripts/build-share-extension.mjs`、`scripts/dist.mjs`、`scripts/pack-hooks.cjs`（appex 落位与一致性硬校验） |
| S10 | 本节 + `docs/design/11-storage.md`、`docs/design/20-conversation-media.md`、`docs/design/13-permissions.md`、`docs/dev/04-agent-runtime.md` |

### 19.2 与设计的偏差

1. **上下文物化时机**：设计说「上下文组装前批量物化」，实现改为**渲染时按需物化**（`RenderMessageOptions.shareAttachmentPath` 回调，附件行渲染时才解析）。好处是所有渲染路径（对话轮、任务、历史、`messages.around`、`search_messages`）自动一致，且不必为整段历史窗口预扫附件。
2. **`share.consume` 的平台方法不经渲染层**：设计 §5.5 的「`share.consume` 只接受 core inbox 前缀下的 path」由 core 侧再校验一次（`realpath` 必须落在 `{home}/inbox/share/{intakeId}` 内）；主进程与 core 各校验一次，路径注入两面都堵。
3. **扩展唤起主应用**：实现同时提供两条路——`NSWorkspace.open`（沙盒扩展里通常被拒）与**主进程周期扫描**（30 秒一次扫 App Group inbox）。后者是 §16.3 的降级兜底：扩展唤起失败时文件照样进得来，用户下次打开 KepCup 也会扫。
4. **App Group 组 id 带 TeamID 前缀**：entitlements 里的 `$(TeamIdentifierPrefix)` 由 `scripts/build-share-extension.mjs` 解析签名身份得到 TeamID 后展开（electron-builder 不展开 entitlements 变量）；展开后的主应用 entitlements 落在 `resources/entitlements.mac.expanded.plist`（构建期产物，不入库），组 id 同时写进 `resources/share-extension/group.json` 供主进程定位容器目录。
5. **失败批次保留 7 天**、**`processing` 超时 10 分钟**、**目标快照 24 小时过期**均按设计实现；`done` 记录同样 7 天后清理。
6. **`get_attachment` 的二进制副本也是 0444**：设计 §6.6 要求它复用 `ensureShareAttachmentCopy` 的落点，而该 helper 统一写 0444（只读语义）。Bot 要改这个副本得先复制到 workspace 其它位置——与 §5.7 的语义一致。
7. **Xcode 目标用显式 file reference**（不是 file-system synchronized group）：后者在 `-arch x64` 时会把编译步骤静默跳过、产物里没有可执行文件。另外 `xcodebuild` 的架构名是 `x86_64`（不是 electron-builder 的 `x64`）——传 `x64` 会让 `ARCHS` 变成无效值、同样跳过编译。`scripts/build-share-extension.mjs` 负责这层名字映射，产物目录仍用 electron-builder 的 `${arch}` 命名。
8. **扩展 Swift 常量组 id 缺 TeamID 前缀**（§9.1 / §9.6 与 entitlements 不一致）：`SharedConfig.swift` 的组 id 常量是不带前缀的 `app.kepcup.desktop`，而 entitlements（扩展与主应用）用 `$(TeamIdentifierPrefix)app.kepcup.desktop`——签名产物里扩展代码查找的组与 entitlements 实际授权的组不一致，App Group 容器目录对不上。修复中：构建期把解析到的 TeamID 前缀注入扩展使用的组 id（与 §19.2 第 4 条的 entitlements 展开同一来源）。
9. **pack 钩子的 App Group 一致性校验未真实实现**（§10.2 承诺「主应用与扩展 App Group id 一致」）：`pack-hooks.cjs` 里对应分支的判定条件恒为假（bundle id 前缀在上一行已断言成立），从未真正比对过两边的组 id——形同没有校验。修复中：改为真实读取主应用与扩展的组 id 并比对（组 id 以构建脚本写入 `group.json` 的展开值为准）。
10. **分享导入未定位到目标会话**（§7.2「带到前台并定位到目标会话」）：主进程 `handleShareUrl` 只 `showWindow`，未调既有的 `showConversation`（消费结果里已有目标会话 id）。已登记：定位到目标会话待接线；接线前行为是「只聚焦主窗口，停在当前会话」，消息本身照常落入目标会话。

### 19.3 §16 预研项的落地结论

| # | 预研项 | P0 结论 |
|---|---|---|
| 1 | 微信是否走系统 Share sheet | **未取证**（需在真机微信 ≥4.1.13 上验证）。设计上不依赖微信——同一扩展对 Finder / Safari / 邮件附件一律可用；但若微信不走系统 Share sheet，§15 验收第 1 条不成立，需另找入口（见 §16.1 的降级方向）。 |
| 2 | 真实 ZIP 体积 | **未取证**。上限按设计保持单文件 30MB / 总量 60MB；超限在扩展内拒绝（用户看到明确提示）。 |
| 3 | 沙盒扩展唤起主应用 | **已实现双路**：`NSWorkspace.open` + 主进程周期扫描。唤起是否在沙盒里生效需真机验证；周期扫描保证文件不丢。 |
| 4 | electron-builder 嵌套签名与 App Group | **已实现**：扩展先签（`codesign` + 展开后的 entitlements + `--timestamp` + `--options runtime`），外层 app 由 electron-builder 后签；`pack-hooks.cjs` 硬校验 appex 落位 / 扩展点 / bundle id / 签名。公证与干净机安装仍需发版流水线验证。 |
| 5–8 | 扩展资源限制、多副本成本、P1 解压归属、外部智能体 cwd 可见性 | 未处理（按设计属 P1）。外部智能体的 `cwd=workdir` 场景下 workspace `.attachments/` 路径可能不可见，届时附件行仍给 path，Bot 需回退 `get_attachment`。 |

### 19.4 已知限制

- 未做真机端到端验收（微信 / Finder 分享、App Group 容器在真实签名包下的读写、公证后的系统分享列表可见性）——需要真实 macOS 环境与 Developer ID 凭据。
- 分享附件不进图片视觉通道（D61 保持不变）。
- 分享消息不解析 `@`、不选路由目标（P0 附言里的 `@` 只是文本）。

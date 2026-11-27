# AI 生成内容举报（Microsoft Store 11.16）

> 状态：**待开工确认**（关键决策已于 2026-11-27 确认；方案本身待最终点头）。
> 日期：2026-11-27。
> 目标：给 Bot 回信加 emoji 反馈入口，其中 👎 作为「举报不当内容」提交到 `reports.kepcup.com` 的独立 Worker；本机与服务端双重限流、双重去重，并为后续排查保留足够上下文。

---

## 0. 结论先行

- 这项需求可以拆成 **4 轮**：数据契约与本地核心 → Worker 与部署 → 桌面 UI 与本地表情 → 联调、隐私政策与验收。
- 推荐新增独立 Worker `kepcup-reports`，绑定 `reports.kepcup.com`，使用独立 D1 `kepcup-reports`。不复用 `registry` / `relay` Worker：举报数据和它们的生命周期、访问控制、限流策略完全不同。
- 本机队列落在 core 的 `main.db`（已有加密库），不在渲染层内存里：关应用不丢、启动自动续发；渲染层只负责交互。
- 去重按 **client 维度**：内容 hash（消息文字/卡片 JSON）与整份 payload hash 任一命中即丢弃。**不做全局去重**，否则 A 用户举报过的句子会让 B 用户永远无法举报。
- 默认建议：内容 hash 去重窗口 24 小时、payload hash 去重窗口 90 天；两者都可配置。实现用「时间桶」而不是滑动窗口：`bucket = floor(now / window)`，唯一索引带上 bucket，既能并发安全，也不会因为固定窗口把常见句永久封死。若你要求「永久去重」，把窗口设为 0（bucket 恒为 0）即可（见 §13 决策项）。
- 👎 不做额外隐私弹窗：点击 👎 本身就是明确动作；完整说明（发送哪些内容、接收方、用途、保留期、删除方式）放进产品协议与隐私政策。重复点击、限流排队都不弹提示。

---

## 1. 政策依据与验收边界

### 1.1 Microsoft Store 11.16 Live Generative AI Content

当前版本：**7.20**（发布 2026-09-15，生效 2026-10-22）。原文要求：

> Products that contain dynamic content created by generative AI models in response to user inputs must:
>
> - Disclose the use of live generative AI in the metadata.
> - Note the use of live generative AI in Partner Center during the submission process.
> - Ensure that dynamic content created by generative AI models complies with all applicable Store Policies.
> - **Provide a means for users to report inappropriate content to the developer.**
> - **You must take appropriate actions based on those reported concerns.**

来源：<https://learn.microsoft.com/en-us/windows/apps/publish/store-policies>

本需求对应最后两条。其余三条也要在提交商店时一起处理，不能只做举报按钮。

### 1.2 与本项目相关的其他条款

| 条款 | 要求 | 对本次开发的影响 |
|---|---|---|
| 11.16 | 元数据披露 live generative AI | 商店描述 / Partner Center 提交备注需要补充；不是代码，但属于上架清单 |
| 11.16 | 对举报采取适当行动 | 需要一个可检索、可标记处理状态的举报库 + 人工处置流程（本方案提供 `new / triaged / actioned / dismissed` 与 admin API） |
| 10.5.1 | 收集/传输个人信息必须有隐私政策 URL | 目前 `docs/dev/06-release.md` 仍把「隐私政策 URL」列为待补；本次举报会发送消息正文、Bot/模型信息，**必须在上架前补齐应用隐私政策** |
| 10.5.2 | 向外部服务发送个人信息需 opt-in，并说明接收方 | 点击 👎 是显式操作即视为同意；不弹二次确认（已确认）。产品协议/隐私政策写清接收方、用途、保留期、删除方式 |
| 10.5.4 | 安全传输/存储 | HTTPS；Cloudflare D1 静态加密；本机 `main.db` 已是加密库；不存 API Key |
| 11.12 | UGC（若适用） | 本应用主要是用户与自己的 Bot 对话，不构成公开 UGC 社区；但举报流程按更严格的 11.16 处理 |

### 1.3 本次不解决、但上架前要一起确认的

- 商店描述与 Partner Center 的 live generative AI 披露文案。
- 应用隐私政策页面（`apps/website` 现有 `/privacy/` 明确写了「本页不是应用的完整政策」，不能直接当应用隐私政策 URL）。
- 商店版更新界面、开机自启等既有 TODO（与本需求无关，但同属上架清单）。

---

## 2. 现状核查（2026-11-27）

### 2.1 消息操作

`apps/desktop/src/renderer/src/lib/features/chats/ChatMessageRow.svelte`：

- 普通消息的 hover 操作组当前顺序是：`引用 → 复制 → 固定 → 撤回`（按消息类型显示）。
- 没有 emoji / reaction 概念；`Message` schema 里也没有 reactions 字段。
- 右键菜单与 hover 操作共用同一组动作，窄屏只保留右键菜单。
- 消息行布局已把操作组放在气泡旁留白，新增一个按钮不会挤压气泡。

### 2.2 核心层

- `packages/core/src/rpc/bindings.ts` 是 app RPC 的唯一注册点；`packages/shared/src/rpc/methods.ts` 是输入/输出 schema 与 `APP_RPC_METHODS` 的唯一事实来源。
- `packages/core/migrations/main/` 当前最高为 `0083_d140_approvals_grants.sql`，新增迁移从 `0084` 开始。
- `main.db` 由 `openDatabase()` 打开，是加密库；`usage_ledger` 里有真实的 `provider` / `model` / `run_id`，`tool_usage_ledger` 里有工具名与调用次数，`bots.profile_json` 里有 Bot 画像与 `runtime.model`。
- 已有可复用的 `SecretsService.redact(text)`，用于把已知 API Key 从文本里替换为 `[REDACTED]`。

### 2.3 Cloudflare

- `infra/cloudflare/` 已有 `registry`、`relay`、`directory`、`oauth-cimd` 四个 Worker 的先例；`registry` 的 `D1Like` + `node:sqlite` 测试适配器可直接借鉴。
- `kepcup.com` zone 已存在且 active；当前没有 `reports.kepcup.com` DNS 记录，也没有 `kepcup-reports` D1。
- `.env` 里的 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` 可用（只读查询已验证）；`wrangler 4.151.1` 在 `apps/website/node_modules/.bin/wrangler`。
- **注意**：当前 shell 的 PATH 里找不到 `cf`（`cf auth whoami` 报 command not found）。部署用仓库内 wrangler 即可；custom domain 会由 wrangler 自动建 DNS 与证书。若坚持用 `cf`，需要先确认它装在哪个 Node 版本下，或重新 `npm i -g cf`。

### 2.4 目前没有的东西

- 没有 `reports.*` RPC、没有举报表、没有本机发送队列。
- 没有 `reports.kepcup.com` Worker / D1 / admin 入口。
- 没有 reaction 表或 UI。
- 没有完整的应用隐私政策 URL。

---

## 3. 范围与非目标

### 3.1 本期范围（v1）

- 桌面端 Bot 消息（`senderType === 'bot'`，`kind` 为 `text` 或 `card`，未撤回）的 emoji 反馈入口。
- 5 个快捷表情 + 可展开的常用表情；除 👎 外都是一次性本地 reaction。
- 👎 作为举报入口：点击即加 reaction 并入队 → 后台按 1 次/分钟/客户端发送。
- 本机去重、本机限流、核心 RPC、D1 Worker、admin 检索与处置。
- 举报 payload 包含：消息正文/卡片 JSON、前后文、Bot 画像与模型、实际 provider/model、工具调用、附件元数据、应用/系统/语言信息。
- 本地 reaction 持久化到 `main.db`（仅本机，不跨设备/不跨团队服务端同步）。

### 3.2 非目标（本期不做）

- 不做自动内容拦截、自动封禁、模型侧 guardrail；只做「举报 → 人工处置」。
- 不把图片/音频/视频的二进制上传到 Worker；只带附件文件名、MIME、大小（后续如 Store 审核要求可加“附带原始媒体”单独授权）。
- 不做跨设备 reaction 同步、不做团队服务端 reaction 广播。
- 不做 Web 管理后台；先提供 bearer-token admin API + 本地 CLI 脚本，够用于日常处置。
- 不把团队服务端（闭源）的 Bot 运行细节写进公开仓；团队来源消息用渲染层快照上报，模型信息可能缺失，标记 `source.kind='team'`。
- 不改变现有 Bot 对话行为、不改变模型调用路径。

---

## 4. UX 设计

### 4.1 hover 按钮

Bot 消息（可举报）在气泡右侧的 hover 操作组，顺序改为：

```
[😊 emoji]  [↩ 引用]  [⧉ 复制]  [📌 固定]  [↩ 撤回]
```

- emoji 按钮是**第一个**按钮（用户消息保持现有顺序，不加 emoji）。
- 图标用 lucide `Smile`，tooltip「添加表情」。
- 点击后弹出 emoji 面板；面板是 `bits-ui` Popover（已有依赖），不新增弹层库。
- 窄屏（`narrowLayout.narrow`）仍不渲染整组 hover 操作；但右键菜单增加「举报不当内容」，保证窄屏/键盘可达。

### 4.2 emoji 面板

- 第一行 5 个：`👍 👎 ❤️ 😂 🎉`。
- 右侧一个 `＋` 展开常用表情网格（🙏 🔥 👏 😮 😢 🤔 ✅ 等，固定集合，见 §5.6）。
- 点击非 👎：切换本机 reaction（同一消息同一 client 只保留一个；再点同一个即取消）。
- 点击 👎：走举报流程（见 §4.3），并把 👎 记为 reaction。
- 面板打开时当前已选中的 emoji 高亮；`aria-pressed` 正确。
- 选择后关闭面板，焦点回到触发按钮。

### 4.3 👎 举报流程

```
点击 👎
  → 加 👎 reaction（本机）
  → reports.submit（只入队，不等待网络）
  → 👎 chip 高亮；后台按 1 条/分钟发送
```

- **不弹隐私确认**（已确认）：点击 👎 是明确动作；发送什么、给谁、保留多久写在产品协议与隐私政策里。
- `reports.submit` 只做「入队」，不等待网络；点击后立即返回。
- 入队成功：**不弹 toast**（避免和「多次点击不提示」冲突），👎 chip 就是状态。
- 重复/限流：**完全静默**。
- 网络失败/Worker 4xx：本地标记失败并写日志，不打扰用户；用户可再次点击重试（本地已有同内容 hash 时会被判重，见 §6.4 的失败行处理）。
- 同一条消息再次点 👎：如果已经是 👎，UI 直接 no-op，不发 RPC、不弹提示。
- 举报不可撤回：👎 chip 点击不删除（其他 emoji 的 chip 点击可取消）；举报记录不会被“取消 reaction”撤销。

### 4.4 reaction chip

- 气泡下方一行 chip：`😊 3`（数量 >1 才显示数字）。
- 自己的 reaction 高亮（accent 边框/底色）。
- 多 client 共用同一个 core（远程手机 + 桌面）时，按 client 聚合显示数量；不跨设备同步。
- chip 不参与消息 merge 布局的圆角计算，单独一行。

### 4.5 右键菜单

Bot 消息的右键菜单增加：

```
举报不当内容   (ShieldAlert)
```

- 与 👎 走同一流程（直接加 👎 并入队，不弹确认）。
- 这样窄屏、键盘用户、找不到 hover 按钮的用户也能举报。

### 4.6 可访问性

- emoji 按钮有 `aria-label` / tooltip；👎 的 label 明确写「举报不当内容」。
- 面板内每个 emoji 有本地化 label（“赞”“不喜欢（举报）”“喜欢”…）。
- 举报菜单项有 `data-testid="context-message-report"`。

---

## 5. 数据契约（v1）

### 5.1 顶层结构

```json
{
  "schemaVersion": 1,
  "reportId": "rep_01J...",
  "createdAt": 1764212345678,
  "reason": "inappropriate",
  "client": {
    "id": "client-...",
    "surface": "desktop",
    "appVersion": "0.6.2",
    "platform": "win32",
    "osVersion": "Windows 11 10.0.26100",
    "arch": "x64",
    "locale": "zh-CN"
  },
  "source": { "kind": "local" },
  "conversation": {
    "id": "conv_...",
    "type": "direct"
  },
  "bot": {
    "id": "bot_...",
    "name": "小助手",
    "systemRole": null,
    "runtime": {
      "model": "openai/gpt-5.1",
      "lightModel": "",
      "backgroundModel": "",
      "agent": { "id": "builtin", "model": "", "effort": "" }
    },
    "profile": { "identity": {}, "persona": {}, "role": {}, "boundaries": [], "behavior": {} }
  },
  "message": {
    "id": "msg_...",
    "seq": 42,
    "kind": "text",
    "status": "normal",
    "createdAt": 1764212300000,
    "editedAt": null,
    "runId": "run_...",
    "text": "……Bot 回复正文……",
    "content": null,
    "truncated": false,
    "attachments": [
      { "fileName": "chart.png", "mime": "image/png", "size": 12345 }
    ]
  },
  "replyTo": { "messageId": "msg_...", "text": "被引用的原文" },
  "context": [
    { "messageId": "msg_...", "senderType": "user", "kind": "text", "text": "用户的上一句", "createdAt": 1764212290000 }
  ],
  "usage": [
    { "provider": "openai", "model": "gpt-5.1", "loopType": "turn", "calls": 3, "inputTokens": 1234, "outputTokens": 456 }
  ],
  "tools": [
    { "name": "web_search", "calls": 1 }
  ],
  "providers": [
    { "id": "openai", "name": "OpenAI", "vendor": "openai", "api": "openai-completions" }
  ],
  "hashes": {
    "content": "sha256-hex",
    "payload": "sha256-hex"
  }
}
```

### 5.2 字段来源

| 字段 | 来源 | 说明 |
|---|---|---|
| `reportId` | core `newId('rep')` | 客户端幂等 id；重试不变 |
| `createdAt` | core clock | 点击/入队时间（ms） |
| `client.id` | 渲染层 `clientIdentity.id` | localStorage 稳定 id；不是账号 |
| `client.appVersion` | core `options.appVersion` | `KEPCUP_APP_VERSION` |
| `client.platform/arch/osVersion` | `process.platform` / `process.arch` / `os.release()` | 诊断用 |
| `client.locale` | `settings.get().appLanguage` | zh-CN / en-US |
| `source` | 渲染层 `session.source` | `local` 或 `team:<serverHash>`；团队来源只带 hash，不带 URL |
| `conversation.type` | `conversations.get()` | local 可查；team 用快照 |
| `bot` | `bots.get()` + `profile_json` | 去掉插件/连接等无关字段，只保留 identity/persona/role/boundaries/behavior/runtime |
| `message` | local 从 `messages.getById()` 重读；team 用渲染层快照 | local 不信任渲染层正文 |
| `replyTo` | local 查 `messages.getById(replyTo)`；team 用快照 | 被引用原文对判断上下文很有用 |
| `context` | local `listVisible(beforeSeq)` 取最近 4 条；team 用渲染层快照 | 跳过 system_event / task_event |
| `usage` | `usage_ledger where run_id=? group by provider,model,loop_type` | 真实调用过的厂商/模型；可能多于一个（重试/压缩） |
| `tools` | `tool_usage_ledger where run_id=? group by tool_name` | 只带工具名与次数，不带工具输出 |
| `providers` | `settings.get().modelProviders` 中 usage 命中的实例 | 只带 id/name/vendor/api，不带 baseUrl、不带 Key |
| `hashes` | 见 §5.4 | 客户端计算，Worker 重算校验 |

### 5.3 内容上限与清洗

| 字段 | 上限 | 处理 |
|---|---|---|
| `message.text` | 32 KB UTF-8（约 1 万汉字） | 超出截断并置 `truncated: true`（可加字段） |
| `message.content`（卡片） | 16 KB | 递归截断字符串；只保留卡片内容 |
| `replyTo.text` | 2 KB | 截断 |
| 每条 `context.text` | 2 KB | 最多 4 条；从最旧开始丢弃以控制总大小 |
| `bot.profile` | 8 KB | 递归截断；去掉插件/连接/密钥相关字段 |
| `attachments` | 最多 20 条 | 只带文件名/MIME/大小，不带内容 |
| 整个 payload | 128 KB | core 构建后检查；Worker 再按 body 上限拒绝 |
| 文本控制字符 | 去掉 NUL 等 C0（保留 `\n` `\t`） | 避免 SQLite `length()`/JSON 边界问题 |

- 所有自由文本先过 `secrets.redact()`，再清洗、截断。
- 不发送：API Key、OAuth token、完整系统提示词、工具输出全文、记忆条目、附件二进制、团队 URL。
- 卡片消息的 `message.text` 为空时，`message.content` 必填；内容 hash 用卡片 JSON。

### 5.4 hash 定义

**内容 hash（消息文字本身）**

```
contentSource = message.kind === 'text'
  ? message.text
  : canonicalJson(message.content ?? { text: message.text })
contentHash = sha256(utf8(contentSource))   // 小写 hex
```

**整份 payload hash**

```
dedupePayload = 去掉 transport-only 字段后的 payload：
  - 去掉 reportId
  - 去掉 createdAt
  - 去掉 hashes
  - 其余字段全部保留（含 schemaVersion / reason / client / source / conversation / bot / message / replyTo / context / usage / tools / providers）
payloadHash = sha256(utf8(canonicalJson(dedupePayload)))
```

- `canonicalJson`：递归按 key 字典序排序、数组保持顺序、`JSON.stringify` 风格；必须跨 Node 与 Workers 一致。
- 为什么去掉 `reportId`/`createdAt`：否则每次点击都会生成新 hash，去重永远不命中。
- Worker 收到后必须重算两个 hash；不等则 `400`。客户端不能只发 hash 让服务端“相信”。
- 两边各有一份实现（core 用 `node:crypto`，Worker 用 `crypto.subtle`），用同一组固定向量做契约测试，禁止只改一边。

### 5.5 去重范围

- **按 client**：`(client_id, content_hash, content_bucket)` 与 `(client_id, payload_hash, payload_bucket)` 各自唯一。
- 不做全局去重：不同用户对同一句话的举报互不影响。
- 同一 client 下：
  - 同一消息重复点击 → `payloadHash` 命中（内容 hash 也通常命中）。
  - 不同消息但文字完全相同 → `contentHash` 命中。
- 默认窗口（推荐值，可改）：
  - `contentHash`：24 小时。
  - `payloadHash`：90 天。
  - 原因：永久按内容去重会让「好的」「我无法协助」这种常见句一旦被举报过就永远无法再举报，属于误伤；窗口足够覆盖“手滑重复点”。
  - 实现用**时间桶**：`content_bucket = floor(now / 24h)`、`payload_bucket = floor(now / 90d)`；唯一索引为 `(client_id, content_hash, content_bucket)` 与 `(client_id, payload_hash, payload_bucket)`。同一桶内重复 → 丢弃；跨桶边界最多允许一次（近似窗口），换取并发安全与实现简单。
  - 若你要求严格按需求「永久丢弃」，把两个窗口都设为 0（bucket 恒为 0）即可，代码只是一个常量。
- 本机与 Worker 都存 hash 与 bucket；bucket 各自用本地/服务端时间计算，不参与 payload hash，避免时钟差异导致 hash 不匹配。
- 窗口常量放 `packages/shared/src/constants.ts`（core）与 Worker `vars`（服务端），默认值保持一致：内容 24h、payload 90d。

### 5.6 reaction 集合

固定集合（shared 常量，core 校验、渲染层展示共用）：

```ts
export const MESSAGE_REACTION_EMOJIS = [
  '👍', '👎', '❤️', '😂', '🎉',
  '🙏', '🔥', '👏', '😮', '😢', '🤔', '✅',
] as const;
```

- 只允许这个集合，避免任意字符串进 DB / payload。
- 每个 `(scope, message_id, client_id)` 最多一个 emoji。
- `scope = session.source`（`local` 或 `team:<serverHash>`），避免本机/团队会话 id 碰撞。
- reaction 只存本机 `main.db`，不进入消息内容、不进入 Bot 上下文、不参与团队同步。

---

## 6. 本机架构

### 6.1 新迁移 `0084_ai_reporting.sql`

```sql
CREATE TABLE report_outbox (
  id               TEXT PRIMARY KEY,              -- rep_...
  client_id        TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  content_bucket   INTEGER NOT NULL,
  payload_hash     TEXT NOT NULL,
  payload_bucket   INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER
);
CREATE UNIQUE INDEX report_outbox_content
  ON report_outbox(client_id, content_hash, content_bucket);
CREATE UNIQUE INDEX report_outbox_payload
  ON report_outbox(client_id, payload_hash, payload_bucket);
CREATE INDEX report_outbox_due
  ON report_outbox(status, next_attempt_at);
CREATE INDEX report_outbox_client_due
  ON report_outbox(client_id, next_attempt_at);

CREATE TABLE message_reactions (
  scope            TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  emoji            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (scope, message_id, client_id)
);
CREATE INDEX message_reactions_conv
  ON message_reactions(scope, conversation_id);
```

- 不建 FK 到 `messages`：团队来源消息不在本机 `messages` 表；团队/本机同 id 用 `scope` 隔离。
- 去重窗口用 `content_bucket` / `payload_bucket` 的时间桶实现；`INSERT OR IGNORE` 直接由唯一索引判重，并发安全。sent/failed 行保留（用户自己的库，量很小），不做清理。
- 如果最终选择永久去重，窗口设为 0，bucket 恒为 0。

### 6.2 `ReportService`（`packages/core/src/domain/reports.ts`）

职责：

1. `submit(input)`：
   - 校验来源与消息可举报性（bot / text|card / 未撤回）。
   - local：用 `messages.getById()` 重读，忽略渲染层正文；team：用快照。
   - 收集 Bot、conversation、usage、tools、providers、context、replyTo。
   - 清洗/redact/截断，构建 normalized payload。
   - 计算 contentHash / payloadHash，以及 `content_bucket` / `payload_bucket`（用本机 clock + 配置窗口；窗口 0 → bucket 0）。
   - `INSERT OR IGNORE` 到 outbox；唯一索引命中（同 client + hash + bucket）→ `duplicate`；`changes === 0` 即重复（并发兜底）。
   - 计算 `next_attempt_at`：按该 client 的 pending/sending/sent 最后时间 + 60s 排队。
   - `kick()` 发送器；立即返回 `queued`。
2. `#tick()`：
   - 单飞（同时只有一个 in-flight）。
   - 取 `status='pending' AND next_attempt_at<=now` 的最早一行。
   - `UPDATE ... SET status='sending' WHERE id=? AND status='pending'`；changes=0 则跳过。
   - POST `https://reports.kepcup.com/v1/reports`。
   - 2xx（201/200）→ `sent`，`sent_at=now`。
   - 429 → 读 `Retry-After` / JSON `retryAfterMs`，`next_attempt_at=now+max(retryAfter, 60s)`。
   - 408/425/5xx/网络错误 → 指数退避（60s × 2^n，上限 1h，±20% jitter），保留 pending。
   - 其他 4xx / 3xx → `failed`，`last_error='HTTP 4xx'`，不再重试（schema 不兼容/端点配错需要发版修）。
   - 最多 20 次；超过 → `failed`。
   - 只记录 `reportId` / `status` / 错误码，不记录正文。
3. `start()/stop()`：
   - start 时 `UPDATE report_outbox SET status='pending' WHERE status='sending'`（崩溃恢复）。
   - 定时器 `unref()`，不阻止进程退出；启动后立即 tick 一次。
   - `close()` 清理定时器；不等待网络。
4. `listPending()` / 测试用 `now`、`fetch` 注入。

构造依赖：

```ts
new ReportService({
  db: mainDb,
  clock,
  logger,
  bots,
  messages,
  conversations,
  settings,
  secrets,
  appVersion,
  endpoint: process.env.KEPCUP_REPORT_ENDPOINT ?? 'https://reports.kepcup.com/v1/reports',
  fetch: globalThis.fetch,   // 测试注入
})
```

- `endpoint` 只在测试/开发用 `KEPCUP_REPORT_ENDPOINT` 覆盖；打包产物默认固定官方域名，避免被环境变量重定向（可选加 dev-only 门控）。
- 不经过用户代理/自定义 dispatcher；固定 HTTPS 官方域名，`redirect: 'error'`，15s 超时。

### 6.3 队列时序

```
点击 1： now        → 立即发
点击 2： now + 60s  → 排队
点击 3： now +120s  → 排队
```

- 限流是“发送”限流，不是“点击”限流；用户连续点 5 条，全部入队，后台慢慢发。
- 不同 client 各自计时；同一台机器多个远程客户端不会互相阻塞。
- 如果 Worker 返回 429（例如本机时钟异常/多实例），该行退避，后续行顺延。

### 6.4 失败行与重试

- `failed` 行保留，不自动重试；用户再次点同一消息时：
  - 若仍在去重窗口，返回 duplicate（不会重新入队）。
  - 若已过窗口，允许重新入队。
- 这避免“Worker schema 不兼容”时无限重试；也避免用户以为没发出去而反复点。
- 若希望失败可手动重试，后续可加 `reports.retry(id)`（非本期）。

### 6.5 RPC

在 `packages/shared/src/rpc/methods.ts` 新增：

| 方法 | 输入 | 输出 |
|---|---|---|
| `reports.submit` | `{ clientId, source, messageId, conversationId, surface?, snapshot? }` | `{ status: 'queued' \| 'duplicate' \| 'rejected', reason?: string }` |
| `messages.react` | `{ scope, conversationId, messageId, clientId, emoji: string \| null }` | `{ reactions: ReactionSummary[] }` |
| `messages.reactions` | `{ scope, conversationId, clientId }` | `{ reactions: Array<{ messageId, emoji, count, mine }> }` |

- `snapshot` 仅在 `source.kind === 'team'` 时必填；local 忽略。
- `reports.submit` 不做网络等待；`rejected` 只用于“不是可举报的 Bot 消息”，UI 静默。
- `messages.react` 校验 emoji 属于固定集合；`null` 表示取消。
- `messages.reactions` 一次取整个 conversation 的聚合，消息分页加载后不用逐条请求。
- 所有方法加入 `APP_RPC_METHODS`；新增 `packages/shared/test/unit/reports-contracts.test.ts` 校验注册与 schema。

### 6.6 reaction 服务

- 放在 `packages/core/src/domain/reactions.ts`（或并入 `MessagesService`；建议独立，避免消息领域膨胀）。
- `set(scope, conversationId, messageId, clientId, emoji | null)`：upsert / delete。
- `list(scope, conversationId, clientId)`：`GROUP BY message_id, emoji`，`count` + `mine`。
- 不校验消息是否存在（团队消息可能不在本机库）；只校验字符串长度、emoji 集合。
- 本机事件总线不发 reaction 事件；其他标签页/客户端刷新后才看到。文档明确“local-only”。

### 6.7 启动接线

- `packages/core/src/start.ts`：
  - `CoreDomainServices` 增加 `reports`、`reactions`。
  - 构造 `ReportService`（在 `messages`/`usage`/`bots`/`settings`/`secrets` 之后）。
  - `services.reports.start()`。
  - `close()` 里 `services.reports?.stop()`（在关闭 `mainDb` 之前）。
- RPC bindings 增加三个方法。
- 迁移目录、`CoreServices` 初始值、`create-core` 测试同步更新。

---

## 7. Worker 架构

### 7.1 资源

| 资源 | 名称 | 说明 |
|---|---|---|
| Worker | `kepcup-reports` | 独立脚本 |
| D1 | `kepcup-reports` | 举报正文 + 去重/限流表 |
| Custom domain | `reports.kepcup.com` | `wrangler.jsonc` 的 `routes: [{ pattern, custom_domain: true }]` 自动建 DNS/证书 |
| Secret | `REPORT_ADMIN_TOKEN` | admin API bearer；随机 32 字节 hex |
| Secret | `IP_HASH_SALT` | IP 哈希 HMAC 盐 |
| Cron | `23 4 * * *` | 每日清理过期 report/rate 行 |

### 7.2 目录

```
infra/cloudflare/reports/
  wrangler.jsonc
  schema.sql
  README.md
  verify.mjs
  tsconfig.json
  src/
    index.ts        // fetch + scheduled
    worker.ts       // 路由、公共/管理 handler、响应
    validate.ts     // 手写校验、长度/控制字符
    dedupe.ts       // canonical JSON + content/payload hash
    admin.ts        // admin 查询/更新/删除
    db.ts           // D1 语句
    types.ts        // D1Like / Env / payload 类型
    cf-types.d.ts   // 最小 Cloudflare 类型
  test/
    helpers.ts      // node:sqlite D1Like、请求构造、fixtures
    worker.test.ts
    dedupe.test.ts
    admin.test.ts
    contract.test.ts
    fixtures/report-v1.json
```

与 `registry` 一样：不引入 wrangler/miniflare 做单测；`D1Like` + `node:sqlite` 内存库，根 vitest 新增 `infra-reports` 项目。

### 7.3 D1 schema

```sql
CREATE TABLE reports (
  id              TEXT PRIMARY KEY,             -- rep_...
  client_id       TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  content_bucket  INTEGER NOT NULL,
  payload_hash    TEXT NOT NULL,
  payload_bucket  INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','triaged','actioned','dismissed')),
  bot_id          TEXT,
  bot_name        TEXT,
  model_provider  TEXT,
  model_id        TEXT,
  message_kind    TEXT NOT NULL,
  message_text    TEXT NOT NULL,
  app_version     TEXT,
  platform        TEXT,
  source_kind     TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  ip_hash         TEXT,
  payload_json    TEXT NOT NULL,
  note            TEXT,
  updated_at      INTEGER,
  UNIQUE (client_id, content_hash, content_bucket),
  UNIQUE (client_id, payload_hash, payload_bucket)
);
CREATE INDEX reports_received ON reports(received_at DESC);
CREATE INDEX reports_status   ON reports(status, received_at DESC);
CREATE INDEX reports_client   ON reports(client_id, received_at DESC);

CREATE TABLE report_rate (
  client_id  TEXT PRIMARY KEY,
  last_at    INTEGER NOT NULL
);
CREATE INDEX report_rate_age ON report_rate(last_at);

CREATE TABLE report_ip_rate (
  ip_hash       TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX report_ip_rate_age ON report_ip_rate(window_start);
```

- `reports` 的唯一索引是去重的最后一道并发兜底；窗口判断在插入前做（见 §7.4）。
- `message_text` 存清洗后的正文/卡片 JSON，便于 SQL 直接 triage；完整结构化数据在 `payload_json`。
- `note` / `status` / `updated_at` 由 admin 更新。
- 保留期默认 365 天；cron 删除 `received_at < now-365d` 的 reports，以及 1 天前的 rate 行。若选择永久去重，保留期需相应调整（或拆 `report_hashes` 表）。

### 7.4 请求处理管线

`POST /v1/reports`：

1. 方法/路径匹配；其他方法 405。
2. `Content-Type: application/json`，否则 415。
3. 读取 body，硬上限 128 KiB（流式计数，不能只信 `Content-Length`）；超限 413。
4. JSON parse；失败 400。
5. 手写校验（schemaVersion=1、必填字符串/数字/枚举/数组上限、控制字符、hash 格式）；失败 400，返回 issues 但不回显正文。
6. 重算 contentHash/payloadHash；与 `hashes` 不一致 → 400。
7. 幂等：`select 1 from reports where id=?` 命中 → `200 {status:'duplicate', reason:'report_id'}`。
8. 去重预检：用**服务端** `now` 计算 `content_bucket` / `payload_bucket`（不信任客户端时钟），按 `(client_id, content_hash, content_bucket)` / `(client_id, payload_hash, payload_bucket)` 查已有行 → 命中 `200 {status:'duplicate', reason:'content'|'payload'}`。
9. IP 粗限流（`CF-Connecting-IP` HMAC 后查 `report_ip_rate`，默认 100/小时）→ 超限 429。
10. 客户端限流（`report_rate` 原子 upsert，默认 60s）→ 429 + `Retry-After` + `retryAfterMs`。
11. `INSERT OR IGNORE` 插入 reports；`changes===0` → 200 duplicate（并发兜底），否则 201 `{status:'accepted', id}`。
12. 只记录 `id/status/httpStatus`，绝不记录正文、clientId、IP。

顺序说明：**去重先于限流**。这样重复点击不会占用“每分钟 1 次”的名额，也不会让用户因为手滑而一分钟内无法举报下一条。

### 7.5 限流细节

- 客户端：`report_rate(client_id, last_at)` 用条件 upsert：
  ```sql
  INSERT INTO report_rate (client_id, last_at) VALUES (?, ?)
  ON CONFLICT(client_id) DO UPDATE SET last_at = excluded.last_at
  WHERE excluded.last_at - report_rate.last_at >= 60000;
  ```
  `changes === 0` 即限流；读回 `last_at` 计算 `retryAfterMs`。
- IP：固定 1 小时窗口，默认 100 次；`ip_hash` 只存 HMAC，不存原始 IP。
- 免费 Cloudflare 只有 1 条 zone 级 rate limit 规则（已被 registry 占用），所以限流放在 Worker + D1，不依赖 WAF。
- 可选全局日上限：本期不做；IP 限量 + 128 KiB body + 1/min/client 已够用。

### 7.6 Admin API

所有 admin 路径要求 `Authorization: Bearer <REPORT_ADMIN_TOKEN>`；未配置 token 时返回 404（隐藏入口）。

| 方法/路径 | 用途 |
|---|---|
| `GET /healthz` | `{ok:true, version}`，无需鉴权 |
| `GET /v1/admin/reports?status=&limit=&before=&client=` | 列表（默认 new，limit 20，keyset 分页）；返回摘要，不返回完整 payload |
| `GET /v1/admin/reports/:id` | 详情：完整 `payload_json` + 处理状态 |
| `PATCH /v1/admin/reports/:id` | `{status:'triaged'|'actioned'|'dismissed', note?}`；记录 `updated_at` |
| `DELETE /v1/admin/clients/:clientId` | 删除该 client 的全部举报与限流行（隐私删除请求） |
| `GET /v1/admin/stats` | 按状态/最近 7 天计数（可选） |

- token 比较用常量时间（先各自 sha256 再逐字节比较）。
- admin 响应 `Cache-Control: no-store`。
- 不提供 Web UI；用 `scripts/report-triage.mjs`：
  ```bash
  node --env-file=.env scripts/report-triage.mjs list --status new
  node --env-file=.env scripts/report-triage.mjs show rep_...
  node --env-file=.env scripts/report-triage.mjs set rep_... actioned --note "已加入系统提示词拦截"
  node --env-file=.env scripts/report-triage.mjs delete-client client-...
  ```
- 脚本只依赖 Node 内置 fetch，不打印 token；`KEPCUP_REPORT_ENDPOINT` 可覆盖（默认 `https://reports.kepcup.com`）。

### 7.7 处置流程（Store 11.16「take appropriate actions」）

1. 每日（或至少每周）跑 `report-triage.mjs list --status new`。
2. 逐条看详情；涉及违法/严重有害内容的当天处理。
3. 标记 `triaged` → 评估；需要改提示词/模型/过滤的，进入发版；无需处理的 `dismissed`。
4. 处理完标 `actioned` 并写 `note`（记录动作，便于审计）。
5. 保留 365 天；用户要求删除时按 `clientId` 删除。
6. 若收到 Microsoft 的合规询问，可用 `stats` / D1 导出证明有机制、有处置记录。

---

## 8. 安全与隐私

| 项 | 设计 |
|---|---|
| 传输 | HTTPS；Worker 自定义域自动证书；固定官方域名，`redirect:'error'` |
| 本机存储 | `main.db` 已是加密库；payload 含正文，但用户本机已有原文 |
| 服务端存储 | D1 静态加密；只存清洗/截断后的文本；不存 API Key |
| 日志 | Worker 只记 `reportId/status/httpStatus`；core 只记 `reportId/status/错误码`；**禁止**打印 payload、正文、clientId、IP |
| IP | 不存原始 IP；用 `IP_HASH_SALT` HMAC-SHA256 后存 `ip_hash`，仅用于限流 |
| Admin | bearer token；常量时间比较；未配置时隐藏；token 只放 `.env` / Worker secret |
| CORS | 不返回 `Access-Control-Allow-Origin`；原生 core fetch 不需要 CORS；浏览器页面无法读响应 |
| 输入 | 128 KiB body；字段长度/枚举/控制字符校验；手写校验不执行任何内容 |
| 输出 | `Content-Type: application/json`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff` |
| 滥用 | 1/min/client + 100/h/IP + 去重；Cloudflare 边缘 DDoS |
| 数据删除 | admin `DELETE /v1/admin/clients/:clientId`；本机清 app data 即删除本地副本 |
| 隐私政策 | 新增「应用举报数据」段落：发送什么、为什么、接收方、保留 365 天、IP 哈希、联系方式、删除方式；产品协议同步写明 |
| 同意 | 不弹二次确认（已确认）；点击 👎 是显式动作，即视为同意发送该条举报；不点击不发送 |

**注意**：隐私政策/产品协议必须写清楚「举报会发送消息正文与上下文到 `reports.kepcup.com`」以及接收方、用途、保留期。应用里不弹二次确认，因此文档披露必须完整；只做按钮、协议不更新，Store 10.5 仍可能不通过。

---

## 9. 边界与异常

| 场景 | 行为 |
|---|---|
| 离线 / Worker 不可达 | 留在本机队列，指数退避；不提示；下次启动继续 |
| 发送中崩溃 | 启动把 `sending` 重置为 `pending`；重发时 Worker 按 `reportId` 幂等 |
| 用户连续点 5 条 | 全部入队；1 条/分钟发送；UI 立即显示 👎 |
| 同一条重复点 | UI no-op；即使触发 RPC，本地 hash 去重返回 duplicate，无提示 |
| 不同消息相同文字 | 内容 hash 命中（窗口内）→ duplicate；窗口外可再报 |
| Worker 429 | 本机按 `retryAfterMs` 退避；不提示 |
| Worker 400/413 | 标 failed，只写日志；不提示；等发版修 schema |
| Worker 5xx | 指数退避，最多 20 次 |
| 消息已撤回/删除 | UI 不显示举报入口；RPC 也拒绝 |
| Bot 已删除 | 仍可举报；`bot.name` 用快照/消息里的 senderBotId；profile 为空 |
| 团队来源消息 | 用渲染层快照；`source.kind='team'`；模型/usage 可能为空，不阻塞 |
| 本机与团队消息 id 相同 | reaction 用 `scope` 隔离；举报 payload 带 source |
| 多个窗口/客户端 | reaction 各 client 一条；报告队列按 client 计时；不实时同步 |
| 用户清空 localStorage | clientId 变化 → 新 client 的去重/限流；Worker 仍按新 client 处理 |
| 系统时钟异常 | Worker 用自己的时间做限流；本机只做排队，429 会兜底 |
| 超长消息 | 截断并记录 `truncated:true`；hash 基于截断后内容 |
| 卡片/附件消息 | 支持卡片 JSON；附件只带元数据 |
| 用户没有举报意愿 | 不点 👎 就不发送；点击 👎 即视为明确同意 |
| 窄屏/键盘 | hover 组不渲染，但右键菜单有“举报不当内容” |

---

## 10. 测试计划

### 10.1 core 单测（`packages/core/test/unit/`）

- `reports.test.ts`
  - payload 构建：Bot、profile、usage、tools、providers、context、replyTo、附件元数据。
  - local 重读：渲染层正文被篡改时以 DB 为准。
  - team 快照：无本地消息也能构建。
  - 拒绝：user / system / recalled / 非 text|card。
  - redaction：已知 secret 被替换。
  - 截断：超长文本/卡片/profile/context。
  - hash：与固定向量一致；content/payload 不一致时拒绝。
  - 去重：同消息、不同消息同文、不同 client 同文、窗口内/外、时间桶边界。
  - 排队：1/60s、不同 client 独立、429 退避、5xx 退避、4xx failed、启动恢复 sending。
- `reactions.test.ts`
  - set/toggle/aggregate/mine/scope 隔离；emoji 白名单；跨 conversation 查询。
- `ai-reporting-migration.test.ts`
  - 0083 旧库升级到 0084；表/索引/约束存在；重复插入返回 changes=0。
- `report-contract.test.ts`
  - 读取 `infra/cloudflare/reports/test/fixtures/report-v1.json`，core 构建结果与 fixture 的 hash 完全一致。
- `packages/shared/test/unit/reports-contracts.test.ts`
  - 三个 RPC 方法进入 `APP_RPC_METHODS`；输入输出 schema 往返。

### 10.2 Worker 单测（`infra/cloudflare/reports/test/`）

- 路由：`/healthz`、`POST /v1/reports`、405、404。
- 校验：body 上限、Content-Type、schemaVersion、必填、枚举、长度、hash 格式、控制字符。
- hash：与 core fixture 一致；篡改 hash → 400。
- 幂等：同 reportId → duplicate；同 content/payload 同桶 → duplicate；跨桶 → accepted；不同 client 同文 → accepted。
- 限流：61s 内第二条不同内容 → 429；61s 后 → 201；IP 超限 → 429。
- 顺序：重复点击不消耗 1/min 名额。
- admin：无 token → 404/401；list/detail/patch/delete-client/stats；分页。
- cron：清理过期 reports/rate/ip。
- 日志：spy console，确认不出现正文/clientId/IP。

### 10.3 桌面 UI 测试

- `MessageReactionBar.svelte.test.ts`：
  - Bot 消息第一个 hover 按钮是 `message-react`；用户消息没有。
  - 面板 5 个快捷 emoji；点 👍 调 `messages.react`；点 👎 调 `messages.react` + `reports.submit`（无弹窗）。
  - 同一条消息再次点 👎 不再发 RPC。
  - duplicate 不弹 toast；queued 不弹（或按最终决策）。
  - chip 聚合/高亮/取消。
- `ChatMessageRow` 测试：右键菜单有 `context-message-report`，仅 Bot 消息。
- i18n：中英文 key 齐全。

### 10.4 E2E / 冒烟

- `apps/desktop/test/e2e/direct-chat.spec.ts` 增加：
  - hover Bot 消息 → emoji 按钮 → 点 👎 → 出现 👎 chip。
  - 通过设置 `KEPCUP_REPORT_ENDPOINT=http://127.0.0.1:<fake-worker>` 启本地假 Worker，验证收到一次 POST；第二次点击不增加请求。
- Worker 部署冒烟（`verify.mjs`）：
  - `/healthz` 200。
  - 无效 POST 400；有效 POST 201；重复 200；紧接不同内容 429。
  - admin 无 token 拒绝；有 token 能 list / patch / delete-client。
- 类型检查：
  - `npx tsc -p infra/cloudflare/reports --noEmit`
  - 根 `pnpm typecheck`（涉及 shared/core/desktop）。

### 10.5 测试命令

```bash
# 定向
node scripts/run-tests.mjs run packages/core/test/unit/reports.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/reactions.test.ts
node scripts/run-tests.mjs run infra/cloudflare/reports
node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/chats
# 类型
npx tsc -p infra/cloudflare/reports --noEmit
pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck
# 收口
pnpm test
```

---

## 11. 部署与运维

### 11.1 一次性部署（实现阶段执行）

> 使用 `infra/cloudflare/with-env.sh` 注入 `.env` 的 Cloudflare 凭证；不要在命令行回显 token。

```bash
cd infra/cloudflare/reports

# 1) 建 D1（输出 database_id，填进 wrangler.jsonc）
../../../infra/cloudflare/with-env.sh \
  ../../../apps/website/node_modules/.bin/wrangler d1 create kepcup-reports

# 2) 建表
../../../infra/cloudflare/with-env.sh \
  ../../../apps/website/node_modules/.bin/wrangler d1 execute kepcup-reports --remote --file=schema.sql

# 3) 生成并写入 secret（token 只放 .env 和 Worker secret）
openssl rand -hex 32   # → REPORT_ADMIN_TOKEN，追加到 .env
openssl rand -hex 32   # → IP_HASH_SALT，只写 Worker secret，不进 .env
printf '%s' "$REPORT_ADMIN_TOKEN" | ... wrangler secret put REPORT_ADMIN_TOKEN
printf '%s' "$IP_HASH_SALT" | ... wrangler secret put IP_HASH_SALT

# 4) 部署（custom domain 自动建 reports.kepcup.com）
../../../infra/cloudflare/with-env.sh \
  ../../../apps/website/node_modules/.bin/wrangler deploy

# 5) 冒烟
node verify.mjs
```

- `.env` 新增 `KEPCUP_REPORT_ADMIN_TOKEN=`（仅本地 CLI 用；`.env` 已 gitignore）。
- 若 `cf` 在别的 Node 版本下可用，可用 `cf dns records list` 只读核对；部署仍建议 wrangler（custom domain 一步完成）。
- 记录到 `infra/cloudflare/README.md` §7 线上变更表。

### 11.2 wrangler.jsonc 草案

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "kepcup-reports",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "workers_dev": false,
  "preview_urls": false,
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "kepcup-reports", "database_id": "<待创建>" }
  ],
  "routes": [{ "pattern": "reports.kepcup.com", "custom_domain": true }],
  "triggers": { "crons": ["23 4 * * *"] },
  "vars": {
    "REPORT_RATE_LIMIT_MS": "60000",
    "REPORT_IP_LIMIT": "100",
    "REPORT_IP_WINDOW_MS": "3600000",
    "REPORT_CONTENT_DEDUPE_MS": "86400000",
    "REPORT_PAYLOAD_DEDUPE_MS": "7776000000",
    "REPORT_RETENTION_DAYS": "365",
    "BUILD_VERSION": "1.0.0"
  }
}
```

### 11.3 监控

- `GET /healthz` 可由现有 uptime workflow 定期检查（可选加一步）。
- 失败排查：Cloudflare dashboard / `wrangler tail kepcup-reports`；代码不打印 payload。
- D1 查询示例：
  ```sql
  select status, count(*) from reports group by status;
  select id, received_at, bot_name, model_provider, model_id, substr(message_text,1,80)
    from reports where status='new' order by received_at desc limit 20;
  ```
- 若发现滥用：调低 `REPORT_IP_LIMIT`、临时提高 rate limit，或加 WAF（需另一个 zone 规则名额/付费）。

---

## 12. 开发轮次与交付物

### 第 1 轮：契约 + 本地核心（可独立合入，功能暗置）

- `packages/shared`：`report` 常量/类型、三个 RPC schema、`APP_RPC_METHODS`、`rep` id 前缀。
- `packages/core`：0084 迁移、`ReportService`、`ReactionsService`、RPC bindings、start 接线、单测。
- `infra/cloudflare/reports`：Worker 骨架 + D1 schema + 单测（可先不部署）。
- 验收：core/worker 单测、类型检查、hash fixture 两边一致。

### 第 2 轮：Worker 部署 + admin

- 建 D1、写 schema、部署 Worker、custom domain、secrets。
- `scripts/report-triage.mjs`、`verify.mjs`、README、Cloudflare 变更记录。
- 冒烟：health/201/duplicate/429/admin。
- 验收：`reports.kepcup.com` 可用；D1 有测试记录；admin 能查/改/删。

### 第 3 轮：桌面 UI

- `MessageReactionBar` / `MessageReactionChips` / reaction store。
- `ChatMessageRow` 第一个按钮、右键菜单、i18n。
- UI 测试 + e2e（可选）。
- 验收：Bot 消息 emoji 面板；👎 点击即入队；重复点击静默；👍/❤️ 等本地 reaction 持久化。

### 第 4 轮：联调、隐私与收口

- 隐私政策页面更新（`apps/website`，中英）。
- `docs/dev/06-release.md` 的 Store 清单更新（11.16 披露、举报机制、隐私 URL）。
- `docs/design/64-ai-content-reporting.md`（定稿设计，可选；把本 todo 的稳定部分搬过去）。
- `docs/dev/PROGRESS.md`、`infra/cloudflare/README.md` 变更记录。
- 全量 `pnpm test`（阶段收口只跑一次）。
- 验收：手动点举报 → D1 出现完整 payload；管理员能检索/标记；无日志泄露。

预估：4 轮合计 4–7 个理想工作日（不含商店文案/审核等待）。

---

## 13. 待你确认的决策

以下默认值按推荐方案写；带「已确认」的项已按 2026-11-27 的答复定稿，其余如有不同意见请在开工前指出。

| # | 决策 | 推荐默认 | 备选 |
|---|---|---|---|
| 1 | 子域名 | `reports.kepcup.com` | `feedback.kepcup.com` |
| 2 | Worker/D1 名称 | `kepcup-reports` | 复用其他 Worker（不推荐） |
| 3 | 其他 emoji 的行为 | 本地持久化 reaction，1 条/消息/client，不跨设备同步 | 只做 👎，其他 emoji 仅动画 |
| 4 | 首次举报隐私确认 | **已确认：不弹窗**；点击 👎 即视为同意，协议/隐私政策写清 | 无 |
| 5 | 入队成功提示 | 不弹 toast，仅 👎 chip | 首次成功弹一次 toast |
| 6 | 内容 hash 去重窗口 | **已确认：24 小时（时间桶）** | 永久（bucket=0） |
| 7 | payload hash 去重窗口 | **已确认：90 天（时间桶）** | 永久 / 30 天 |
| 8 | 上下文深度 | 最近 4 条 + 被引用原文 | 0 条（只发当前消息） |
| 9 | Bot 画像 | 发送裁剪后的 profile（≤8KB） | 只发 id/name |
| 10 | 附件 | 只发文件名/MIME/大小 | 不发附件信息 |
| 11 | 团队来源消息 | 支持，用渲染层快照，模型信息可能为空 | 本期不支持 |
| 12 | 服务端保留期 | 365 天 | 180 天 / 永久 |
| 13 | Admin 入口 | bearer-token API + 本地 CLI | 只靠 D1 控制台 |
| 14 | 隐私政策 | 本期更新 `apps/website` 应用隐私段落 | 先上架再说（不推荐） |
| 15 | 去重失败行 | 保留，不自动重试；窗口外可重报 | 删除失败行，允许立即重报 |

### 特别提示：关于「永久去重」

严格按「内容重复就丢弃」实现（窗口 0、bucket 恒为 0），会让一句常见 Bot 回复（例如「我无法协助这个请求」）被同一用户举报一次后永久无法再次举报；不同 Bot/不同会话都受影响。推荐用时间桶窗口（24h / 90d）而不是永久。若你坚持永久，我会把两个窗口设为 0，但请知悉这个误伤。

---

## 14. 验收清单

### 功能

- [ ] Bot 消息 hover 组第一个按钮是 emoji；点击出现 👍 👎 ❤️ 😂 🎉 + 更多。
- [ ] 非 👎 emoji 可添加/取消，刷新后仍在（本机）。
- [ ] 👎 点击即入队，无二次弹窗；重复点击不重复入队。
- [ ] 同一条重复点 👎 不弹提示、不重复入队。
- [ ] 连续举报多条：1 条/分钟发送；UI 不阻塞。
- [ ] Worker 429/5xx 时本机退避；离线不丢。
- [ ] 团队来源 Bot 消息可举报（快照），不会因本地无消息而失败。
- [ ] 窄屏可通过右键菜单举报。

### 数据

- [ ] payload 含 Bot、模型供应商/模型、消息正文、context、tools、附件元数据、应用版本。
- [ ] 不含 API Key、完整系统提示词、工具输出、附件二进制。
- [ ] contentHash / payloadHash 与 Worker 重算一致。
- [ ] 本机与 Worker 都按 client 去重；不同 client 同文可分别举报。
- [ ] 本机与 Worker 都限流；重复点击不占名额。

### 安全/合规

- [ ] 全链路 HTTPS；Worker 不存原始 IP；不记录正文。
- [ ] Admin token 不进仓库；未配置时 admin 404。
- [ ] 隐私政策/产品协议写明举报数据、接收方、用途、保留期、删除方式。
- [ ] 商店描述/Partner Center 披露 live generative AI（人工提交项）。

### 交付

- [ ] 定向测试 + `npx tsc -p infra/cloudflare/reports --noEmit`。
- [ ] 收口前 `pnpm test` 一次全绿。
- [ ] `reports.kepcup.com` 上线；D1 有测试记录；`verify.mjs` 通过。
- [ ] `infra/cloudflare/README.md` / `PROGRESS.md` / release 文档更新。

---

## 15. 参考

- Microsoft Store Policies 7.20：<https://learn.microsoft.com/en-us/windows/apps/publish/store-policies>
- 现有 Worker 先例：`infra/cloudflare/registry/`（D1 + node:sqlite 测试 + custom domain + cron）
- 消息行：`apps/desktop/src/renderer/src/lib/features/chats/ChatMessageRow.svelte`
- RPC 契约：`packages/shared/src/rpc/methods.ts`
- 迁移：`packages/core/migrations/main/0083_d140_approvals_grants.sql`（新增从 0084 开始）
- 现有 Cloudflare 操作约定：`infra/cloudflare/README.md`
- Store 上架待办：`docs/dev/06-release.md` §「待补充」

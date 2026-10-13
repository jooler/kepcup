# 37 Bot 资产移交（Asset Handover）

用户在对话里说一句「把这件事交给 X 负责」，AI 就能把 A Bot 名下的资产（邮箱、连接应用、MCP、模型、定时任务、Skill、记忆、Wiki……）整理成一份移交清单，用户确认一次，宿主照单执行。用户不需要去设置页逐项操作。决策：**D88**。

**状态：已定稿；P0 已合入 main，P1、P2 已实施**（2026-10-12 定稿；P0 在 `t/handover` 实现、审查修复后合入 main（迁移 0036）；P1——普通 Bot 发起、网页监看、Skill、记忆按条复制、承诺随定时任务迁移——在 `t/handover-p1` 实现并经审查修复，无新迁移；P2——Wiki 与组件在后台 `handover_copy` 作业里复制、「退役」按钮——在 `t/handover-p2`（基于 P1）实现，无新迁移，待独立审查与合入；偏差见 [todo §6](../../todo/bot-handover.md#6-实施记录) DEV-001 起，P1 的为 DEV-012 起，P2 的为 DEV-021 起）。执行方案见 [todo/bot-handover.md](../../todo/bot-handover.md)。产品拍板（2026-10-12）：①记忆、Wiki 一律**复制**（源 Bot 保留，不提供「从 A 删除」）；②普通 Bot 交出自己资产的能力按开发节奏排期，但属于本功能的必做范围；③承诺随定时任务迁移（A 的承诺置 `void`）作为「一律复制」的唯一例外，确认采用（§3.1）。

相关：D70 / D71（管家与委派，[27](27-butler-and-delegation.md)）、D80（例行事项，[todo/schedule-nudges.md](../../todo/schedule-nudges.md)）、D73（连接应用，[29](29-connected-apps.md)）、D84（邮件通道，[35](35-mail-channel.md)）、D65（MCP，[23](23-mcp-and-subagent.md)）、[03-bot.md](03-bot.md)、[04-memory.md](04-memory.md)、[05-wiki-and-skills.md](05-wiki-and-skills.md)、D18（Bot 删除）。

## 决策

- **D88 Bot 资产移交**：
  1. **用户只下指令，AI 出方案，确认一次，宿主执行**。模型用 `inspect_bot_assets` 看清源 Bot 名下有什么，用 `propose_handover` 提交一张**移交卡**；用户在卡上逐项勾选后确认；core 按清单**确定性**执行（不经模型再编造），逐项记录结果，以 internal follow-up 通知发起方。与 D70「管家只能通过审批卡建 Bot」同一范式；无人值守**不自动批准**。
  2. **移交 ≠ 委派**。委派（`delegate_to_bot`）是「请 B 做一件事」，一次性、不改变归属；移交是「从此由 B 负责」，改变资产与职责的长期归属。提示词、工具说明里两者分开写；「负责 / 接管 / 交给它管」以及涉及邮箱、应用、定时任务的说法一律走移交。
  3. **新建并接手是一张卡**。`propose_handover` 的目标可以是已有 Bot，也可以是一个待新建的 Bot（字段同 `propose_bot`，另可指定模型）；确认后先建 Bot 再移交。不拆成「先建 Bot 卡、再移交卡」两步（同一对话同时只允许一张待定提议，两步会互相卡住，也让用户确认两次）。
  4. **每类资产各有固定语义**（§3）：配置类复制或共享，通道 / 职责类移交，知识类（记忆、Wiki、Skill）**一律复制**。授权与信任决定（路径授权、应用写授权、浏览器登录态）、对话历史**不移交**。
  5. **职责描述随资产一起改**。移交邮箱等职责时，卡上同时给出 B（追加）与 A（删去）的 `role.responsibilities` 改写，可单独勾掉；否则 A 的职责里仍写着「负责邮箱」，路由与群聊里的「归不归我」判断会出错。
  6. **两侧都留痕**。B 的私聊写入「交接说明」系统事件（接手了什么 + 发起方写的交接要点），A 的私聊写入「已移交」系统事件；二者进入各自的上下文，A 不会继续以为自己负责。
  7. **发起权**：管家可以以任何 Bot 为来源（含自己）；普通 Bot 只能交出**自己的**资产（P1）。新建目标只有管家能提议（建 Bot 本来就是管家专属）。
  8. **资产清单层**：每类资产实现一个适配器（盘点 / 校验 / 执行 / 描述），移交引擎、卡片、结果通知只认适配器接口；新增资产类型不改引擎。

## 1 现状（2026-10-12 读取，以代码为准）

**触发事件**：管家负责一个邮箱；用户让管家新建一个 Bot 负责邮件并把邮箱交过去。管家建 Bot 成功，邮箱负责人没变。

| 问题 | 位置 | 说明 |
|---|---|---|
| 建 Bot 提议只带人设 | `tools/butler-tools.ts` `proposedBotSchema`；`dispatch/butler.ts` `#createBots` | 只有 name / bio / expertise / responsibilities / reason / routines；创建时只写 identity、role 与例行事项 |
| 没有改邮箱绑定的 AI 工具 | `mail/service.ts` `setBots` / `setAccountsForBot` | 只有 UI RPC `mail.accounts.setBots`、`mail.bots.setAccounts`；`mail_*` 工具全是调用者自己的只读 / 发信 |
| 「转交」一词被委派占用 | `agent/context/system-prompt.ts` `BUTLER_RULES` | 「由你转交」指 `delegate_to_bot`。模型很可能把「把邮件转交给它」理解成委派一条消息：新 Bot 回「好的我会负责」，绑定不变 |
| 所有写工具只作用于自己 | `tools/*.ts` 均以 `identity.botId` 为准 | 管家对已有 Bot 只有「提议新建」与「委派」两种能力，无法改动任何已有 Bot 的资产 |
| 没有复制 / 迁移代码 | — | 全仓无 Bot 资产的 copy / move / export；`lifecycle.deletionPreview` 只做计数 |

各资产的归属方式（下文适配器据此设计）：

| 资产 | 存储 | 归属 | 现有可改入口 |
|---|---|---|---|
| 模型 | `profile.runtime.{model, light_model, agent}` | 每 Bot 一个配置值，空 = 设置默认（`llm-router.builtinModelRef`） | `bots.update`（UI） |
| 连接应用 | `profile.runtime.app_connection_ids`；连接行全局（`app_connections`）；常驻写授权 `app_tool_grants` | 多对多；**每 Bot 每 Connector 至多一个连接** | `bots.update`、`apps.connect`（grantBotId）、`apps.grants.revoke` |
| MCP | `profile.runtime.mcp_server_ids`；server 全局（`settings.mcpServers`） | 多对多 | `bots.update` |
| 邮箱 | `mail_account_bots(account_id, bot_id, alerts_paused, alert_times_json)` | 多对多 | `mail.accounts.setBots` / `mail.bots.setAccounts` |
| 定时任务 | `schedules(bot_id, conversation_id, …, commitment_id, title, origin)` | 独占（Bot × 对话）；建任务要求 Bot 是该对话成员 | 只有取消，无改派 |
| 网页监看 | `watches(bot_id, conversation_id, …)` | 独占（Bot × 对话） | 暂停 / 恢复 / 停止 |
| Skill | `bot_skills(bot_id, name, kind, library_id, status)`；导入的共享 `skill_library`；自写的在 `bots/{id}/skills/{name}/`（git） | 行每 Bot；导入版本按 `library_id` 共享；自写独占 | `skills.*` RPC；`install_skill` / `create_skill` 只作用于自己 |
| 记忆 | `bots/{id}/memory.db`，密钥由 bot id 派生 | 独占；**不能整库拷贝** | `remember` / `forget` 只作用于自己 |
| Wiki | `bots/{id}/wiki/`（git：`raw/`、`pages/`），检索索引 `wiki_fts` 在 memory.db | 独占（「Bot 之间的 Wiki 完全隔离」） | 只有维护 loop 写 |
| 组件 | `widgets(bot_id, scope)` 及版本 / 文档 / 查询表 | 独占 | `widget_*` 只作用于自己 |
| 职责描述 | `profile.role.{expertise, responsibilities}` | 独占 | `bots.update`；`propose_profile_change` 只改自己 |

## 2 交互

### 2.1 典型对话

```text
用户 → 管家：新建一个 Bot 专门管邮件，把你负责的邮箱交给它。
管家：inspect_bot_assets(管家) → 看到邮箱 work@x.com、2 条与邮件相关的定时任务……
管家：propose_handover({ from: 管家, to: { new_bot: { name: 邮件助理, … , model: 'inherit' } },
                        items: [mail:mal_1 移交, schedule:sch_3 移交, …],
                        responsibilities: { to: '负责 work@x.com 的收发与整理…' },
                        handover_note: '用户习惯每天 9 点看摘要；发票类邮件转给财务…' })
        → 本轮结束，对话里出现移交卡
用户：去掉一条定时任务，确认
宿主：建「邮件助理」→ 绑定邮箱 → 解绑管家 → 迁定时任务 → 写交接说明 → 通知管家
管家：已经建好「邮件助理」，work@x.com 和每日摘要都交给它了……
```

### 2.2 移交卡

- 头部：「{A} → {B}」或「{A} → 新建 {B}」；新建时折叠展示 B 的名字 / 简介 / 职责 / 模型（同 `propose_bot` 卡）。
- 主体按资产分组，每项一行：勾选框 · 名称 · 动作标签（**移交** / **共享** / **复制**）· 说明（冲突、风险、会发生什么）。不可执行的项（如目标已有同类连接）置灰并写明原因，不提交。
- 职责改写：以前后对照展示 B 追加、A 删去的文字，各自可勾掉。
- 交接要点：发起方写的说明，只读展示（会写进 B 的私聊）。
- 按钮：确认 / 拒绝。确认时 `approvals.decide` 带 `handoverSelection`（被勾选的条目 key）；一项都不留且无新建 = 等价于拒绝。
- 执行中卡片显示进度（逐项打勾）；结束后标完成 / 部分失败（列失败项与原因）。后台阶段（Wiki 复制等）完成前卡片保持「进行中」。

## 3 资产语义

动作：**移交（move）** = B 获得、A 失去；**共享（share）** = B 获得、A 保留（同一份资源，多对多）；**复制（copy）** = B 得到一份独立副本，A 不变。

| 资产 | 默认动作 | 可选动作 | 执行要点 | 分期 |
|---|---|---|---|---|
| 模型 | 复制（仅新建目标，或用户明确要求改 B 的模型） | — | 取值 `inherit`（同 A）/ `default`（跟随设置默认）/ 指定 ref；ref 必须在可用模型列表里（与 Bot 详情模型下拉同源） | P0 |
| 连接应用 | 共享 | 移交 | B 同 Connector 已有其他连接 → 置灰「{B} 已连接另一个 {应用} 账号」。**不带** `app_tool_grants`：B 首次写操作照常请求授权。移交时从 A 的 `app_connection_ids` 移除（中断 A 用到该连接的运行中任务，同 `bots.update`） | P0 |
| MCP | 共享 | 移交 | 只改两侧 `mcp_server_ids`；server 已被全局停用的置灰 | P0 |
| 邮箱 | 移交 | 共享 | **先绑 B，再解 A**（不留空窗）。B 的绑定唤醒状态从零开始。A 名下排队中的 `mail_alert` 作业（如免打扰停放的）按新键改投 B，否则这些信两边都收不到提醒（`runAlertJob` 遇到绑定不存在会静默丢弃） | P0 |
| 定时任务 | 移交 | — | A 私聊里的 → 在 B 私聊重建；群里的 → B 是该群成员则在群里改为 B，否则置灰「{B} 不在群里」。保留 title / note / kind / cron / run_at / timezone / origin；重建出新回执卡；A 侧取消，原回执卡快照标「已移交给 {B}」。承诺联动的见下 | P0 |
| 职责描述 | 改写 | — | B 追加、A 删去（模型给出改后全文，卡上对照显示）。A 是管家时不改 A（管家职责是固定模板） | P0 |
| 交接说明 | 写入 | — | B 私聊 `bot_handover` 系统事件；A 私聊「已移交」系统事件 | P0 |
| 网页监看 | 移交 | — | 规则同定时任务；保留 last_hash，不重新告警（实现：同一行改归属；两边浏览器资料不同时清空哈希、B 第一次检查只建基线；本机网址在两边本机访问规则不同时不可移交） | P1 |
| Skill | 复制 | — | 导入的：给 B 加一行指向同一 `library_id`（不重复克隆、不再走 `skill_import` 审批——移交卡确认即授权，卡上标「外部导入」）；自写的：复制目录到 B，git 初始提交「从 {A} 复制」；B 已有同名 → 置灰。停用状态照搬 | P1 |
| 记忆 | 复制（按条） | — | 见 §3.1 | P1 |
| Wiki | 复制（按页） | — | 见 §3.2；后台作业 | P2 |
| 组件（scope='bot'） | 复制 | — | 复制组件与全部版本、文档、查询模板；已确认的版本保持确认（同一用户、同一 HTML 摘要） | P2 |

**不移交**（卡片底部固定一行说明）：对话历史、路径授权（`grants`）、应用写授权（`app_tool_grants`）、审批记录、浏览器资料与登录态、workspace 目录、网络策略、进行中的委派与任务、污点状态。授权是针对 A 与具体上下文做的信任决定；对话属于用户与 A；B 需要的背景由交接说明与复制的记忆补上。

### 3.1 记忆

- **选择**：`inspect_bot_assets` 对记忆只给数量与按 kind 的分布；模型用 `memory_query`（关键词）取候选，返回条目 id 与内容预览。提议里列出条目 id，卡上逐条展示可勾选。单次 ≤ `HANDOVER_MEMORY_MAX_ITEMS`（200）。
- **永不提供**：`private_to_bot=1`（用户说过「只告诉你」）、`self_note`（A 关于自己的笔记）、非 `active` 状态。宿主在盘点与执行两处都过滤，提议里出现即拒绝。
- **敏感**：`sensitivity='sensitive'` 的条目默认不勾，标「敏感」。
- **写入 B**：新 id；kind / content / subject / source / confidence / sensitivity / due_at / valid_until 照搬；`evidence_json` 改为来源记录 `{handoverId, fromBotId, fromItemId}`（记忆 schema 增加这种证据形态）；`origin_conversation_id` 置空；写入后走 `embedItem` 入向量。B 的反思不会把它们当成用户原话（它们不是消息）。
- **承诺（commitment）是唯一的例外**：承诺是「答应用户要做的事」，属于待办责任而不是知识。它跟着关联的定时任务走——B 得到承诺副本并接到重建的定时任务上（`commitment_id` 指向 B 的新条目），A 的承诺置为 `void`、不再出现在 A 的 `<my_state>`，否则两个 Bot 会重复提醒用户。P0 先不迁移承诺联动的定时任务（置灰「随承诺，P1 支持」），P1 与记忆一起做。

### 3.2 Wiki

- **选择**：按页（或按主题目录）；盘点给页树与主题，提议里列页路径。
- **复制**：页文件 + 页引用到的 `raw/` 原件 + `wiki-store` 二进制资产（内容寻址，可硬链接 / 复制）+ `_assets` / `_derived` 清单，进 B 的 wiki；持 B 的维护锁写入，git 提交「从 {A} 复制 N 页」，之后 `reconcileFts` 重建 B 的 `wiki_fts`，并给 B 排一次 lint（让它把新页整合进自己的索引）。
- **冲突**：B 已有同路径的页 → 跳过并在结果里列出，不覆盖、不改名（改名会打断页间链接）。
- **耗时**：放进 `handover_copy` 后台作业，卡片在作业完成前显示「进行中」；失败可重试，按条目幂等。
- **实现（P2）**：key 为页 `wiki:pages/a.md` 或目录 `wiki:pages/`（整本）/ `wiki:pages/{目录}/`（执行时取目录下当下的全部页）。盘点默认给整本与各主题目录，`wiki_query` 列页（`*` / `pages/{目录}/` / 关键词）。复制分两段、从不同时持两把锁：来源的维护锁内快照到接手方旁的暂存目录，接手方的维护锁内 rename 落盘（同路径字节相同 = 已复制，可续跑；不同 = 跳过并列出）。D85 尚未实施，`_assets` / `_derived` / `wiki-store` 按 [36](36-wiki-multimodal-ingest.md) §3.1 的布局前向兼容处理（仓外文件硬链接）。单页条目在接手方已有同路径不同内容时卡上置灰；目录条目只提示会跳过哪些。见 todo §6 P2、DEV-021 起。

## 4 工具

两个工具都属于**对话轮**工具面（与 `propose_*` 同类：立即返回、宿主干活）；任务里不注册，管家任务规则里同步说明。

### 4.1 `inspect_bot_assets`（只读）

```text
inspect_bot_assets({ bot_id, memory_query?, wiki_query? })
```

- 返回按资产分组的清单：每项带 **key**（如 `mail:mal_xxx`、`schedule:sch_xxx`、`app:con_xxx`、`skill:{name}`、`memory:mem_xxx`、`wiki:pages/a.md`）、名称、可用动作、默认动作、不可执行原因；记忆与 Wiki 默认只给统计，给了 query 才列条目。另附**可用模型列表**（供新建目标或改模型时选择）。
- 权限：管家可查任何 Bot；普通 Bot 只能查自己（P1 起注册给普通 Bot）。
- 结果里来自外部的文本（邮件地址的显示名、Wiki 页标题、记忆内容）包 `<untrusted>`。

### 4.2 `propose_handover`

```text
propose_handover({
  from_bot_id,
  to: { bot_id } | { new_bot: { name, bio, expertise, responsibilities, reason, routines?, model? } },
  items: [{ key, action? }],          // key 来自 inspect_bot_assets；action 缺省用默认动作
  responsibilities?: { to?: string, from?: string },   // 改写后的全文
  handover_note: string,              // 交接要点，写进 B 的私聊
  note?: string                       // 给用户的一句话说明（卡上）
})
```

- 宿主校验：发起权（§决策 7）；`from ≠ to`；目标 active、不在访谈中；每个 key 必须在**当下**的盘点里存在、动作合法、未被过滤（编造的 key 直接退回并说明）；同一对话已有待定的移交卡或管家提议卡 → 拒绝叠加。
- 提交即本轮结束（`terminate`），与 `propose_*` 一致；卡片非阻塞，决定落在 core 回调里。
- `new_bot.model`：`inherit` / `default` / 可用模型列表里的 ref。`propose_bot` / `propose_team` 的每个 Bot 同步增加可选 `model`（P0），让「新建一个用 X 模型的 Bot」也能一步完成。

### 4.3 提示词

- `BUTLER_RULES` 增加：委派与移交的区分（§决策 2）；「新建 Bot 并接手 A 的东西」用一张 `propose_handover`（目标为新建），不要先 `propose_bot` 再移交；提议前先 `inspect_bot_assets` 看清资产，不要凭记忆写 key；在收到宿主结果通知前不要声称已移交。
- `delegate_to_bot` 说明增加一句：委派不会改变谁负责什么；要把邮箱、应用、定时任务等交给对方，用 `propose_handover`。
- 普通 Bot（P1）：平台规则增加一句——用户让你把自己负责的东西交给别的 Bot 时用 `propose_handover`。
- B 侧：交接说明系统事件在 B 的上下文里渲染为「[系统] 你从 {A} 接手了：…；{A} 的交接要点：<untrusted>…</untrusted>」。A 侧渲染为「[系统] 你已把 … 移交给 {B}」。

## 5 宿主执行

### 5.1 数据

一个迁移（取实施时 main 的下一个空号）：

- `bot_handovers(id, approval_id, proposer_bot_id, conversation_id, from_bot_id, to_bot_id NULL, new_bot_json NULL, status, plan_json, created_at, updated_at)`；`status ∈ proposed | applying | completed | partial | failed | denied | cancelled`；新建目标在建好后回填 `to_bot_id`。
- `bot_handover_items(handover_id, key, asset_type, action, status, error, result_json, updated_at)`，主键 `(handover_id, key)`；`status ∈ pending | done | skipped | failed`。
- `approvals.kind` 增 `bot_handover`（按 0027 / 0031 的方式重建表）。不复用 `butler_proposal`：普通 Bot 也会发起，且 payload 与选择方式不同。

### 5.2 审批

- `bot_handover` 走 `submitNonBlocking`；`cancelPendingForRun` 排除该 kind（同 `butler_proposal`）；`#autoDecideSync` 排除（无人值守下照常等用户）；重启时待定卡照旧 `cancelAllPending`，对应 handover 落 `cancelled`。
- `approvalDecisionSchema` 增 `handoverSelection: string[]`（被勾选的 key，含 `resp:to` / `resp:from` 两个职责改写键），core 对照 payload 校验，不得出现 payload 之外的 key。

### 5.3 执行顺序

确认后 `HandoverHost` 按阶段执行，每项独立记录结果：

1. 新建目标（同 `#createBots`：建 Bot、开私聊、例行事项、模型）——失败则整单失败，后续不执行。
2. 配置类：模型、连接应用（共享部分）、MCP（共享部分）。
3. 知识类：Skill、记忆（同步，条数有上限）；Wiki、组件进后台 `handover_copy` 作业。
4. 职责类：邮箱、定时任务、监看——一律**先给 B、再从 A 撤**。
5. 移交动作的 A 侧撤除：连接应用 / MCP 的移交部分。
6. 职责描述改写（`bots.update`，同 `profile_change` 的写入路径）。
7. 交接说明（B 私聊）、已移交（A 私聊）。
8. 卡片结算 + internal follow-up 通知发起方：逐项列出完成 / 跳过 / 失败；要求模型如实转述，失败项说明原因与补救（如「去 B 的详情页手动连接」）。

- **幂等**：每项以 `(handover_id, key)` 为键；执行前查 item 状态，`done` 跳过。各适配器的 `apply` 本身也要可重入（例如邮箱绑定已存在即视为成功）。
- **重新校验**：执行时对每项重新跑适配器校验（用户可能隔了几天才确认，资产可能已变）；不再成立的项标 `skipped` 并写原因。
- **恢复**：启动时 `applying` 的 handover 继续执行剩余 `pending` 项；后台作业按 jobs 既有机制恢复。
- **结算**：全部 `done` → `completed`；有 `failed` → `partial`；新建失败或全部失败 → `failed`。

### 5.4 适配器接口

```ts
interface HandoverAdapter {
  readonly type: HandoverAssetType;       // 'model' | 'app' | 'mcp' | 'mail' | 'schedule' | 'watch' | 'skill' | 'memory' | 'wiki' | 'widget'
  readonly stage: number;                 // §5.3 的阶段
  inventory(botId: string, query?: InventoryQuery): HandoverEntry[];
  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null;   // null = 可执行
  apply(ctx: HandoverContext, key: string, action: HandoverAction): Promise<HandoverItemResult>;
  describe(entry: HandoverEntry, action: HandoverAction): string;   // 卡片与结果通知里的一行
}
```

`lifecycle.deletionPreview` 的计数改为从同一组适配器的 `inventory` 汇总（P2，可选）——未采用，见 DEV-024。

P2 在接口上增加两项：`background`（后台条目：确认后的同步阶段不执行，宿主在阶段 2–6 之后登记一个 `handover_copy` 作业；作业结束前移交保持 `applying`，交接说明与结算在作业完成后才做）与可选的 `applyBatch(ctx, keys)`（后台批量执行，Wiki 用它一次提交 N 页；抛错 = 整批暂时失败，作业按 jobs 机制重试，末次仍失败时条目记 failed）。

## 6 分期

| 期 | 范围 |
|---|---|
| **P0** | 迁移（两表 + approvals kind）、适配器框架与 `HandoverHost`、`inspect_bot_assets` / `propose_handover`（仅管家；目标可新建）、`propose_bot` / `propose_team` 增 `model`；适配器：模型、连接应用、MCP、邮箱、定时任务（不含承诺联动）、职责改写、交接说明；移交卡（渲染端）；提示词；触发事件的端到端用例 |
| **P1** | 普通 Bot 发起（来源只能是自己）、网页监看、Skill、记忆（按条复制 + 承诺随定时任务迁移） |
| **P2** | Wiki（后台作业）、组件；「退役」流程：全部资产移交后结果卡给出「删除 {A}」按钮（走既有 D18 删除确认，不自动删）；`deletionPreview` 改用适配器汇总（未采用，DEV-024）——已实施（`t/handover-p2`） |

## 7 非目标

- 不移交对话历史，不合并两个 Bot 的私聊。
- 不提供「从 A 删除」记忆 / Wiki（拍板：一律复制；需要清理时用户照旧在 A 的详情页处理）。承诺随定时任务迁移是唯一的例外（§3.1）。
- 不移交授权、登录态与网络策略（§3「不移交」）。
- 不做跨用户 / 跨设备的 Bot 导出导入。
- 模型不直接写库：没有「无卡移交」的快捷路径，包括管家。

## 8 验收锚点

1. **触发事件**：管家绑定邮箱 M；用户说「新建一个 Bot 管邮件，把你的邮箱交给它」→ 出现一张「管家 → 新建 X」移交卡（含邮箱 M、职责改写）→ 确认后 X 存在、M 只绑 X、X 私聊有交接说明、管家私聊有「已移交」、管家的 `<mail_accounts>` 段消失，新信只唤醒 X。
2. 已有 B：「把 A 的 Notion 连接和日报定时交给 B」→ B 获得连接（A 保留）、日报定时在 B 私聊重建并出回执卡、A 的原回执卡标已移交。
3. 卡上勾掉某项 → 该项不执行；拒绝 → 什么都不变，发起方收到「未采纳」。
4. 无人值守模式下移交卡不被自动批准。
5. 执行中崩溃 → 重启后继续剩余项，已完成项不重复（邮箱不重复绑定、定时任务不重复建）。
6. 编造的 key、不属于来源 Bot 的资产、`private_to_bot` 记忆出现在提议里 → 工具直接拒绝。
7. 用户说「把这封邮件转给 B 处理」→ 仍走委派，不出移交卡（不误判）。
8. P1：普通 Bot A 收到「把你的邮箱交给 B」→ A 自己出移交卡；A 试图以别的 Bot 为来源 → 拒绝。

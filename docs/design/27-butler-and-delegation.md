# 27 管家 Bot 与跨 Bot 委派（Butler + A→B Delegation）

用户面对多个领域 Bot 时，需要一个**固定入口**来组队、分诊与代办；领域 Bot 之间也需要在**不离开当前对话**的前提下把任务交给另一个联系人执行。本文规定：**Butler（管家）** 与 **跨 Bot 委派（A→B）** 两套产品能力。二者均**尚未实现**；既有能力只覆盖同 Bot 内 SubAgent 与群内 `@` 连锁。

决策：D70（Butler）、D71（A→B 委派）。执行方案见 [todo/butler-and-delegation.md](../../todo/butler-and-delegation.md)。

相关：D4（群 `@` 连锁，[02-execution.md](02-execution.md)）、D48/D54（消息可见性）、D58（对话内设置 / 审批卡范式，[18-inline-setup.md](18-inline-setup.md)）、D59/D60（访谈与群创建，[19-work-path-and-group-setup.md](19-work-path-and-group-setup.md)）、D66（同 Bot `delegate_task`，[23-mcp-and-subagent.md](23-mcp-and-subagent.md)）、D67（durable journal，[24-durable-execution.md](24-durable-execution.md)）、[01-conversation.md](01-conversation.md)、[03-bot.md](03-bot.md)。

## 决策

- **D70 Butler（管家）**：每个用户空间有且仅有一个 `bots.role='butler'` 的管家 Bot——**唯一、侧栏置顶、不可删除**。入职路径：onboarding / 访谈 → `propose_team` 审批卡（建议 3–5 个领域 Bot）→ 用户确认 → 宿主**确定性** `bots.create` 批量落盘（不经模型再编造）。管家专属工具：`list_bots`、`propose_bot`、`propose_group`、`suggest_route`、`delegate_to_bot`。路由策略：未知意图 → 管家；单领域 → 直聊对应 Bot；多角色协作 → 建群；「结果留在本对话」→ 走 D71 委派。早期产品：先出路由卡；用户说「你安排」再委派执行。
- **D71 A→B 跨 Bot 委派**：主 Bot A 调用 `delegate_to_bot`（可 `cancel_delegation`）把任务交给联系人 B。落 `delegations` 表，状态机对齐常见 A2A 语义（如 `submitted` / `working` / `completed` / `failed` / `cancelled`）。A 侧：发出卡 + 结果卡；B 侧：收到**用户代发**消息，带 `origin=delegation` 标签「由 A 代你发出」；**UI 停留在 A 的对话**。B 的最终回复截断（约 2000 字符）贴回 A 为结果卡（原文 + 链到 B 对话），并标记 feedback；`notify_me` follow-up 注入告诉 A「不要复述」。防环：深度上限、禁止 A→B→A、普通 Bot 默认单跳。若 A 与 B **同在一个群**且场景适合群协作 → **降级为 D4 `@`**，不另开委派。

## 1 现状与边界（结论）

| 已有 | 覆盖 | 不覆盖 |
|---|---|---|
| D4 群 `@` 连锁 | 同群内 Bot→Bot 触发；`BOT_CHAIN_MAX_DEPTH` / `BOT_CHAIN_TOKEN_BUDGET` | 跨私聊、UI 不跳转的「代办」 |
| D66 `delegate_task` | **同一 Bot** 内嵌套 SubAgent；后台 follow-up 经 `deliverEventToBot` | 另一个联系人 Bot |
| follow-up 注入 | SubAgent / mailbox / 定时事件共用投递管道 | 跨 Bot 委派结果回贴（需新建，可复用管道） |
| 对话式 Bot / 群 setup | `ask_question`、访谈闸门、`groups.setup.*` | 管家组队审批卡 |
| Onboarding step「创建第一个 Bot」 | 模板 `coder` / `writer` / `researcher` → 单个 `bots.create` | 管家身份与批量组队 |

**明确复用、明确不做：**

- **复用**：D66 的 follow-up / `deliverEventToBot` 管道；D4 的深度与预算思路（常量可独立命名）；`ask_question` / 审批卡交互范式；确定性 `bots.create`（批量）。
- **不做**：把 SubAgent 当成 Bot↔Bot；把委派注册成群成员；A 与 B 同群时另开一套委派协议（降级 D4）。

## 2 Butler（D70）

### 2.1 身份与约束

| 项 | 规定 |
|---|---|
| 存储 | `bots` 表增系统角色列（建议名 `system_role`，取值 `null \| 'butler'`），**勿与** Profile 内 `role.{expertise,responsibilities}` 混淆 |
| 唯一 | 全局至多一行 `system_role='butler'` 且 `status='active'`；创建第二管家拒绝 |
| 置顶 | 通讯录 / 侧栏固定置顶（UI 标记 `pinned` 或由 `system_role` 推导） |
| 不可删 | `lifecycle.deleteBot` 对 butler 直接拒绝（可停用主动消息，不可删联系人）；D18 删除流程不适用于管家 |
| Profile | 仍走 Profile 模型；管家有固定人设模板（中文名建议「管家」或用户命名，bio 说明分诊与组队职责） |

### 2.2 入职与组队

```text
Onboarding / 首次进入
  → 确保 butler 存在（无则确定性创建）
  → 管家对话：访谈（复用 ask_question / setup 工具集的子集）
  → propose_team 审批卡：展示 3–5 个建议 Bot（名、职责、为何需要）
  → 用户确认 / 微调 / 拒绝单项
  → 宿主确定性 bots.create 批量（interview=false 或短访谈按产品定）
  → 可选：为多角色事务 propose_group
```

- **Butler 只通过审批卡创建其他 Bot / 群**（推荐默认，见开放决策 §5.4）：模型调用 `propose_bot` / `propose_group` / `propose_team` → 卡片 → 用户确认 → core 执行 `bots.create` / `groups.create`；禁止模型直接写库绕过卡片。
- Onboarding 原 step 5 单 Bot 模板可演进为「先落管家，再由管家组队」，或保留「快速单 Bot」旁路（实现期二选一，设计推荐：**管家优先**，快速单 Bot 仍可用侧栏「新建」）。

### 2.3 管家工具面

| 工具 | 作用 |
|---|---|
| `list_bots` | 列出用户 Bot 名片（id / name / bio / 职责摘要），只读 |
| `propose_bot` | 提议新建一个领域 Bot → 审批卡 |
| `propose_group` | 提议建群（名、事务、成员）→ 审批卡（可对齐 D60 字段） |
| `suggest_route` | 对用户当前意图给出路由建议（管家 / 直聊某 Bot / 群 / 委派）→ 路由卡 |
| `delegate_to_bot` | 同 D71；管家与普通 Bot 均可具备，管家提示词更强调路由 |

普通领域 Bot **默认不**暴露 `propose_bot` / `propose_group` / `propose_team`（避免人人建队）；`delegate_to_bot` 可按 Profile / 设置开关，首期建议：**管家默认开；普通 Bot 默认开但单跳**。

### 2.4 路由策略

| 意图 | 路由 |
|---|---|
| 未知 / 跨域 / 「帮我安排」 | → 管家对话 |
| 明确单领域且已有对应 Bot | → 直聊该 Bot（路由卡可一键跳转） |
| 需要多角色协作 | → 建群（或建议已有群） |
| 用户要停在当前对话看结果 | → D71 委派（结果贴回） |

**早期产品节奏**：先出**路由卡**（说明建议去哪、为何）；用户点跳转或说「你安排」后，管家再 `delegate_to_bot` / 建群。避免未经确认就在后台代办。

## 3 A→B 委派（D71）

### 3.1 契约

| 项 | 规定 |
|---|---|
| 触发 | A 的响应 loop 调用 `delegate_to_bot({ bot_id, task, … })` |
| 取消 | `cancel_delegation({ delegation_id })` 或用户在 A 侧结果卡上取消 |
| 持久化 | `delegations` 表（main DB）：id、from_bot_id、to_bot_id、from_conversation_id、to_conversation_id、task、status、result_message_id、depth、parent_delegation_id、created_at / updated_at … |
| 状态 | 建议对齐 A2A 风格：`submitted` → `working` → `completed` \| `failed` \| `cancelled` |
| UI | **停留在 A 的对话**；不自动切换到 B |

### 3.2 A 侧与 B 侧消息

| 侧 | 表现 |
|---|---|
| A | 「已委托给 B」发出卡（可含 task 摘要）；完成后「B 的回复」结果卡 |
| B | 在 B 与用户的**私聊**中插入一条 **user 消息**（用户代发），UI 标签 `origin=delegation`，文案「由 {A.name} 代你发出」；触发 B 的正常响应 loop |
| 回贴 | 将 B 的最终回复**截断约 2000 字符**贴入 A 为结果卡；附「查看原文」链到 B 对话中的消息；标记用户/A 可 feedback（有用 / 需重做等，字段首期可简单） |
| 注入 | 回贴同时用 follow-up（复用 `deliverEventToBot`，`internal`）通知 A：`notify_me`——**不要把 B 的原文再复述一遍**，只做必要转述或下一步 |

### 3.3 防环与降级

- **深度**：委派深度封顶（建议默认 1 对普通 Bot；管家可允许 2，常量如 `DELEGATION_MAX_DEPTH`）；与 D4 `BOT_CHAIN_MAX_DEPTH` 独立计数，但产品语义同类。
- **禁止 A→B→A**：B 的 run 内若 `to_bot_id == 原 from_bot_id` 直接拒绝。
- **默认单跳**：普通 Bot 发起的委派，B 侧工具面默认**不**再暴露 `delegate_to_bot`（或暴露但立即失败并说明）；管家发起的链路由常量放宽。
- **群降级**：若当前上下文是群，且 A、B 均为成员 → 工具返回指引，改走 `send_message` `@`（D4），不写 `delegations` 行。

### 3.4 与 D66 SubAgent 的对照

| | D66 SubAgent | D71 A→B |
|---|---|---|
| 执行者 | 同 Bot 减配子 run | 另一个联系人 Bot 的完整响应 loop |
| 消息 | 不写用户消息 | B 私聊出现代发用户消息 |
| 工具 | 只读研究集 | B 的正常工具面（受自身授权） |
| 回传 | 压缩结论进主 loop | 截断原文贴 A 为卡 + follow-up |
| 群 | 不充当群成员 | 同群则降级 D4 |

## 4 开放决策（推荐默认）

| # | 议题 | 状态 | 推荐默认 |
|---|---|---|---|
| 1 | B 侧消息形态 | **采纳推荐** | 用户代发 + A 标签「由 A 代你发出」 |
| 2 | 回贴内容 | **采纳推荐** | 截断原文（~2000）+ 链到 B 消息 |
| 3 | B 未绑定 workspace 时是否继承 A 对话的 project | **开放** | 首期建议：不自动继承；B 用自己私聊已绑 project，未绑则走 D59「暂不设置」语义；跨 project 读写仍走 D36 授权 |
| 4 | Butler 创建 Bot/群的方式 | **采纳推荐** | 仅审批卡确认后确定性创建 |
| 5 | B 执行中途的过程消息是否同步到 A | **采纳推荐** | 不同步；仅最终回复（+ 失败/取消） |
| 6 | 委派是否遵守 B 的 quiet hours | **开放** | 首期建议：遵守 `behavior.quiet_hours`；逾期则委派保持 `submitted`，到点再投递，并在 A 卡提示「将在免打扰结束后发送」 |
| 7 | 委派中崩溃恢复：ephemeral vs D67 durable | **开放** | 首期建议：委派行本身持久；B 的 run 仍按 D49/D67 分级。A 侧卡根据 `delegations.status` 重绘；不把整段委派默认升 durable |
| 8 | Butler 是否加入用户群 | **开放** | 首期建议：允许加入；在群内管家可 `suggest_route` / `@`，但 **A→B 委派仍降级 D4**（与 §3.3 一致） |

## 5 非目标（本设计明确不做）

- 用 D66 SubAgent 模拟另一个 Bot 联系人。
- 多跳自由图（A→B→C→…）作为默认能力。
- 把 B 的工具过程 / 中间 progress 镜像到 A 聊天流。
- 跨用户 / 多租户管家；云端托管委派总线。
- 替换 D4 群 `@` 协议。
- 管家可被用户删除或建多个。

## 6 实现分期（文档级 P1–P4）

与执行 todo 对齐，便于按阶段验收：

1. **P1 地基**：`system_role`、管家唯一/置顶/不可删、`delegations` 表与状态枚举、常量、边界测试（与 D4/D66 对照）。
2. **P2 管家入职与组队**：确保管家存在、访谈、`propose_team` / `propose_bot` / `propose_group` 审批卡、确定性批量创建、`list_bots`。
3. **P3 A→B 委派主路径**：`delegate_to_bot` / `cancel_delegation`、B 代发消息 + 标签、A 发出/结果卡、截断回贴、`notify_me` 注入、防环与单跳。
4. **P4 路由与收尾**：`suggest_route` + 路由卡、「你安排」再委派、同群降级 D4、开放决策默认值落地（quiet hours / workspace 继承等按上表）、回归与 e2e。

## 7 验收锚点（设计级）

1. 新装用户完成引导后通讯录有且仅有一个管家，置顶，删除入口不可用或明确拒绝。
2. 管家 `propose_team` → 用户确认 → 3–5 个 Bot 落库；未确认不落库。
3. A 委派 B：UI 留在 A；B 私聊出现带标签的用户代发消息；B 回复后 A 出现截断结果卡 + 链接；A 收到 internal follow-up 且不复述全文。
4. A→B→A 与超深委派被拒绝；同群 A/B 走 `@` 不写委派行。
5. `delegate_task`（D66）行为回归不变；群 D4 连锁回归不变。

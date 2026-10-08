# 27 管家 Bot 与跨 Bot 委派（Butler + A→B Delegation）

用户面对多个领域 Bot 时，需要一个**固定入口**来组队、分诊与代办；领域 Bot 之间也需要在**不离开当前对话**的前提下把任务交给另一个联系人执行。本文规定：**Butler（管家）** 与 **跨 Bot 委派（A→B）** 两套产品能力。二者均**尚未实现**；既有能力只覆盖同 Bot 内 SubAgent 与群内 `@` 连锁。

决策：D70（Butler）、D71（A→B 委派）。执行方案见 [todo/butler-and-delegation.md](../../todo/butler-and-delegation.md)。

相关：D4（群 `@` 连锁，[02-execution.md](02-execution.md)）、D48/D54（消息可见性）、D58（对话内设置 / 审批卡范式，[18-inline-setup.md](18-inline-setup.md)）、D59/D60（访谈与群创建，[19-work-path-and-group-setup.md](19-work-path-and-group-setup.md)）、D66（同 Bot `delegate_task`，[23-mcp-and-subagent.md](23-mcp-and-subagent.md)）、D67（durable journal，[24-durable-execution.md](24-durable-execution.md)）、[01-conversation.md](01-conversation.md)、[03-bot.md](03-bot.md)。

## 决策

- **D70 Butler（管家）**：每个用户空间有且仅有一个 `bots.system_role='butler'` 的管家 Bot——**唯一、侧栏置顶、不可删除**。入职路径：onboarding / 访谈 → `propose_team` 审批卡（建议 3–5 个领域 Bot）→ 用户确认 → 宿主**确定性** `bots.create` 批量落盘（不经模型再编造）。管家专属工具：`propose_bot`、`propose_group`、`propose_team`、`suggest_route`；只读 `list_bots` 与 `delegate_to_bot` 管家与普通 Bot 共用。路由策略：未知意图 → 管家；单领域 → 直聊对应 Bot；多角色协作 → 建群；「结果留在本对话」→ 走 D71 委派。早期产品：先出路由卡；用户说「你安排」再委派执行。
- **D71 A→B 跨 Bot 委派**：主 Bot A 调用 `delegate_to_bot`（可 `cancel_delegation`）把任务交给联系人 B（**异步**：工具立即返回，A 本轮照常收尾，B 的结果稍后以 follow-up 唤醒 A）。落 `delegations` 表，状态机对齐常见 A2A 语义（`submitted` / `working` / `completed` / `failed` / `cancelled`）。A 侧：发出卡 + 结果卡；B 侧：收到**用户代发**消息，带 `origin=delegation` 标签「由 A 代你发出」；**UI 停留在 A 的对话**。B 的最终回复截断（约 2000 字符）贴回 A 为结果卡（原文 + 链到 B 对话）；同时用 follow-up 注入告诉 A「不要复述」。结果卡的有用/需重做反馈（feedback）**首期不做**。防环：**首期一律单跳**（被委派 run 不能再委派）、禁止 A→B→A、禁止委派给管家。若 A 与 B **同在一个群**且场景适合群协作 → **降级为 D4 `@`**，不另开委派。

## 1 现状与边界（结论）

| 已有 | 覆盖 | 不覆盖 |
|---|---|---|
| D4 群 `@` 连锁 | 同群内 Bot→Bot 触发；`BOT_CHAIN_MAX_DEPTH` / `BOT_CHAIN_TOKEN_BUDGET` | 跨私聊、UI 不跳转的「代办」 |
| D66 `delegate_task` | **同一 Bot** 内嵌套 SubAgent；后台 follow-up 经 `deliverEventToBot` | 另一个联系人 Bot |
| follow-up 注入 | SubAgent / mailbox / 定时事件共用投递管道 | 跨 Bot 委派结果回贴（需新建，可复用管道） |
| 对话式 Bot / 群 setup | `ask_question`、访谈闸门、`groups.setup.*`（均绑定 `bots.setup_state='interviewing'`） | 管家组队审批卡 |
| 审批卡（`approvals`） | 阻塞 / 非阻塞（`submitNonBlocking`）两种提交；`decide(id, approve, duration)` | 带「用户微调」的决定（只有 `duration`）；`kind` 受表 CHECK 约束，新增需重建表 |
| Onboarding step「创建第一个 Bot」 | 模板 `coder` / `writer` / `researcher` → 单个 `bots.create` | 管家身份与批量组队 |

**明确复用、明确不做：**

- **复用**：D66 的 follow-up / `deliverEventToBot` 管道；D4 的深度与预算思路（常量可独立命名）；`ask_question` / 审批卡交互范式；确定性 `bots.create`（批量）；`event_delivery` 的 quiet-hours parking 模式。
- **不做**：把 SubAgent 当成 Bot↔Bot；把委派注册成群成员；A 与 B 同群时另开一套委派协议（降级 D4）。

## 2 Butler（D70）

### 2.1 身份与约束

| 项 | 规定 |
|---|---|
| 存储 | `bots` 表增系统角色列（建议名 `system_role`，取值 `null \| 'butler'`），**勿与** Profile 内 `role.{expertise,responsibilities}` 混淆 |
| 唯一 | 全局至多一行 `system_role='butler'` 且 `status='active'`（partial unique index）；创建第二管家拒绝 |
| 置顶 | 通讯录 / 侧栏固定置顶（由 `system_role` 推导，不另存 pinned） |
| 不可删 | `lifecycle.deleteBot` 对 butler 直接拒绝（须在 `abortRunsForBot` 之前判定；可停用主动消息，不可删联系人）；D18 删除流程不适用于管家 |
| Profile | 仍走 Profile 模型；管家有固定人设模板（中文名建议「管家」，bio 说明分诊与组队职责）；用户可像普通 Bot 一样改名 / 改头像 / 调 runtime（`system_role` 不在 Profile 内，改 Profile 不影响它） |
| 存量用户 | 升级前已完成 onboarding 的用户没有管家：core 启动时幂等 `ensureButler`（仅 `onboarding.completed` 为真时）。存量用户的管家**不跑访谈**，首次打开只发一条确定性问候（说明能做什么），组队由用户主动发起 |

### 2.2 入职与组队

```text
Onboarding / 首次进入（新用户，尚无领域 Bot）
  → 确保 butler 存在（无则确定性创建，setup_state='interviewing'）
  → 管家访谈：确定性问候 + 固定首问卡 → 管家用 ask_question 追问（≤ SETUP_MAX_QUESTIONS）
  → 管家调用 propose_team → 审批卡（展示 3–5 个建议 Bot：名、职责、为何需要）；本轮终止，访谈态清除
  → 用户勾选 / 去掉某项 / 全部拒绝
  → 宿主确定性 bots.create 批量（interview=false）
  → 可选：管家为多角色事务 propose_group
```

**访谈机制（实现必须按此落，不要临场发明）**：既有访谈整套机制都绑定 `bots.setup_state='interviewing'`（`ask_question` 与 `save_profile` / `finish_setup` 同一组注册、`bots.interview.*` RPC 与 `answerSetupQuestion` 校验该态、问题卡可点击性由 UI 读该态、目录闸门 D59 对该态扣下投递）。管家访谈复用同一状态位，但是一个**变体**：

- 工具面：`ask_question` + `propose_team`；**不注册** `save_profile` / `finish_setup`（管家 Profile 是固定模板，不被访谈改写）。
- **跳过目录闸门**（D59）：管家不绑定 project，首答后直接投递。
- 首问卡 / 候选项 / 访谈指引用管家版文案（领域与场景，而非「协助哪些事务」）；问题上限沿用 `SETUP_MAX_QUESTIONS`（含固定首问）。
- 退出：`propose_team` 提交即清 `setup_state`（访谈已完成其使命）；卡片被整体拒绝后管家回到普通对话，可再次提议。不允许管家停留在访谈态无出口。

**审批卡约束**：

- **Butler 只通过审批卡创建其他 Bot / 群**（开放决策 §4.4）：模型调用 `propose_team` / `propose_bot` / `propose_group` → 卡片 → 用户确认 → core 执行 `bots.create` / `groups.create`；禁止模型直接写库绕过卡片。
- **审批 kind**：用单一 `butler_proposal`（payload 以 `proposalType: 'team' | 'bot' | 'group'` 区分）而非三个 kind——`approvals.kind` 有表级 CHECK，每加一个 kind 都要重建表，且 `describe` / `renderContextLine` / UI 卡片 / 排除名单每处都要多一个分支。
- **非阻塞提交**（`submitNonBlocking` 范式，同 `environment`）：卡片与管家的 run 脱钩——工具提交后 `terminate`，用户几分钟甚至几天后才决定都不占 run；决定落在 core 回调里，而不是回到模型。因此 `cancelPendingForRun` 要像 `environment` 一样把该 kind 排除（否则管家 run 一结束卡片就被取消）；应用重启仍整体 `cancelAllPending`（决定回调只在内存里，不留悬挂卡）。
- **无人值守不自动批准**：`#autoDecideSync` 对 kind 一律放行，需新增按 kind 排除——`butler_proposal` 在无人值守下照常挂起等用户（防止无人值守刷出一堆联系人）。
- **「微调」需要新通道**：`approvals.decide` 目前只有 `approve` / `duration`，表达不了「去掉第 2 项」。给 `approvals.decide` 增可选 `selection`（被勾选的条目下标 / id），仅对 `butler_proposal` 有效，由 core 对照 payload 校验（不得出现 payload 之外的条目；一项都不留 = 等价于拒绝）。`BUTLER_TEAM_SIZE_MIN..MAX` 只约束模型的提议，不约束用户勾选——用户只想要其中两个就建两个。落库前以 `selection` 过滤后的条目为准；决定记入 `decision_json`。
- 批准后的回调**确定性**执行（循环 `bots.create`，不经模型）；部分失败时已建的保留、卡片标 `failed` 并列出失败项（对齐 BR-P08-004 的 `approvals.fail`）。成功 / 失败后用 internal follow-up 通知管家（它再对用户说下一步），不另造用户可见消息。
- `propose_group` 批准后调 `groups.create({ title, memberBotIds })`——**该入参没有 description**（description 只在 D60 的 `finalizeSetup` 路径写入），实现时给 `create` 补可选 `description`，或建后补写一次；成员 ≥ 2 的校验沿用。
- Onboarding 原 step 5 单 Bot 模板演进为「先落管家，再由管家组队」（设计推荐：**管家优先**）；快速单 Bot 仍可用侧栏「新建」。

### 2.3 管家工具面

> **D75 说明（非修订）**：`propose_bot` / `propose_team` / `propose_group` / `suggest_route` / `list_bots` / `delegate_to_bot` / `cancel_delegation` 全部属于**对话轮**的工具面——它们正是「立即返回、宿主干活」的那一类，与 D75 的 `start_task` 并列。D71 的异步契约、状态机与结果卡范式被 D75 的任务层直接照搬，§3.5 投递闸门中「B 邮箱空闲」的判定对象是 B 的**对话轮**。**实现期发现**（见 DEV-012）：贴回 A 的结果是 B 那一个**对话轮**的最终回复；需要动手的委派 B 只能派任务并先回复「我去做」，这句话就成了结果，真正的结果之后出现在 B 的私聊里、不回到 A。本期按「现状 + 提示词约束」（能用只读查询答复的在本轮给完整结果；需要动手的派任务并说明结果稍后在这里给出），「委派跟随任务结算」作为后续独立修订。见 [30 §1.2](30-supervisor-and-tasks.md#12-与-d66--d71-的定位关系)。

| 工具 | 作用 |
|---|---|
| `list_bots` | 列出用户 Bot 名片（id / name / bio / 职责摘要），只读；与 `delegate_to_bot` 同注册范围（所有 Bot） |
| `propose_bot` | 提议新建一个领域 Bot → 审批卡 |
| `propose_team` | 提议一组（3–5 个）领域 Bot → 批量审批卡 |
| `propose_group` | 提议建群（名、事务、成员）→ 审批卡（可对齐 D60 字段） |
| `suggest_route` | 对用户当前意图给出路由建议（管家 / 直聊某 Bot / 群 / 委派）→ 路由卡 |
| `delegate_to_bot` | 同 D71；管家与普通 Bot 均可具备，管家提示词更强调路由 |

普通领域 Bot **默认不**暴露 `propose_*` / `suggest_route`（避免人人建队）；`delegate_to_bot` 首期：**管家与普通 Bot 默认都开，且都是单跳**。委派目标从哪来：非群对话的提示词里目前没有任何其他 Bot 的名单（`members` 只在群聊注入），普通 Bot 不知道 B 的 `bot_id`——所以**只读的 `list_bots` 与 `delegate_to_bot` 一起注册**给所有 Bot（返回名片：id / name / bio / 职责摘要，不含 Profile 其它内容），不往每个 Bot 的系统提示里塞通讯录。

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
| 触发 | A 的响应 loop 调用 `delegate_to_bot({ bot_id, task, … })`；**异步**，工具返回「已委托」后 A 照常收尾，不在 loop 内等 B |
| 取消 | `cancel_delegation({ delegation_id })` 或用户在 A 侧委派卡（发出卡）上取消 |
| 持久化 | `delegations` 表（main DB）：id、from_bot_id、to_bot_id、from_conversation_id、to_conversation_id、task、status、to_message_id（B 侧代发消息，「查看原文」链）、run_id（B 侧响应 run，投递时回填——settle 钩子与取消都靠它）、result_message_id、depth、created_at / updated_at … |
| 状态 | `submitted`（行已写，**尚未向 B 投递**，等 §3.5 闸门）→ `working`（代发消息已落 B 私聊——与状态翻转同事务，`run_id` 投递后回填；`working` 且无 run 即「投递前崩溃」，重启复用既有消息重投）→ `completed` \| `failed` \| `cancelled`。B 的 run `failed` / `interrupted` → `failed`；B 的 run 被 `cancelled`（用户在 B 侧点停止 / B 被删等）→ `cancelled`。启动恢复把 `working` 且 run 已 `interrupted` 的委派落 `failed`（对齐 D49 ephemeral 语义，不自动续跑） |
| UI | **停留在 A 的对话**；不自动切换到 B |
| 生命周期 | 对话 / Bot 删除不改委派行的存在，只终态化：A 或 B 被删 / B 私聊被删 → 活跃委派落 `cancelled`（并 abort B 的活动 run）；卡片上的「查看原文」链在 B 对话不存在时降级为「对话已删除」 |

### 3.2 A 侧与 B 侧消息

| 侧 | 表现 |
|---|---|
| A | 「已委托给 B」发出卡（可含 task 摘要；`submitted` 时提示「B 正忙 / 免打扰，稍后发送」）；完成后「B 的回复」结果卡。发出卡随 `delegations.status` 重绘，需要 `delegation.updated` 事件推送 |
| B | 在 B 与用户的**私聊**中插入一条 **user 消息**（用户代发），消息持久化带 `origin=delegation`——`textContentSchema` 增可选 `origin` / `delegationId`（参照 `setupAnswer` 前例落 content_json，免加列；注意 `messages.append` 是手工拼 content_json 的，要同步加字段，不只是改 zod）。UI 标签「由 {A.name} 代你发出」；`TriggerBatch.extraAttributes`（`from_bot` / `delegation_id`）是运行时附带、不落库，仅用于把来源带进 B 的模型上下文。以 `triggerReason='delegation'` 触发 B 的正常响应 loop |
| 回贴 | 将 B 的最终回复**截断约 2000 字符**贴入 A 为结果卡；附「查看原文」链到 B 对话中的消息 |
| 注入 | 回贴同时用 follow-up（复用 `deliverEventToBot`，`internal`）通知 A：**不要把 B 的原文再复述一遍**，只做必要转述或下一步。（这是 follow-up 注入，不是工具） |
| 上下文渲染 | A 的消息流里有 `kind='card'` 的委派卡；`renderOptions.renderCard` 目前对「非 run_changes 的卡」一律按 `approvalId` 查审批——不扩展会把委派卡渲染成「（审批记录已清理）」。需要为委派卡补一行上下文渲染（状态 + 摘要，不含全文） |

**B 的模型怎么知道这是委派**：触发段带来源属性，且 B 的触发上下文需提示两点——这是 A 代用户转交的任务，请在**本轮内**给出完整结果（不要用后台 `delegate_task` 或「稍后告诉你」收尾，否则 B 这一轮的终回复会被当作结果提前回贴）；若信息不足需要追问，直接向用户提问（终回复即追问，结果卡照常贴出并让用户去 B 对话作答）。

**记忆证据**：代发消息的 `senderType` 是 `user`，而 P07 反思把用户消息当作「关于用户的事实」的证据。代发文本是 A 写的，不是用户的话——B 的反思 / 画像整理需把 `origin=delegation` 的消息排除出用户证据（或降级渲染为「A 转述」），否则 A 的措辞会被 B 记成用户偏好。

### 3.3 防环与降级

- **首期一律单跳**：被委派的 B 不能再 `delegate_to_bot`。早先稿子里「管家发起的链可放宽到 2 层」暂不启用——B 委派 C 后 B 这一轮就结束，B 的终回复（「已委托给 C」）会被当作 A 的结果提前回贴，需要「等下游再结算」的链式结算语义，超出首期。`DELEGATION_MAX_DEPTH` 常量保留（值 1，`delegations.depth` 列保留），日后放宽再设计结算。
- **禁止 A→B→A**：被委派 run 内 `to_bot_id` 若等于任何祖先委派的 `from_bot_id` 直接拒绝（单跳下已被「被委派 run 不能委派」覆盖，作为兜底保留）。
- **禁止委派给管家**：管家是路由入口，委派链指向它没有产品含义且容易成环；`to_bot_id` 为 butler 时拒绝。另拒绝：`to_bot_id == from_bot_id`、B 非 active、B 私聊只读、B 正在 `setup_state='interviewing'`（访谈期间 B 的私聊投递被目录闸门扣下，委派会悬挂）。
- **单跳怎么落（run 粒度，且要覆盖 steer 场景）**：工具注册是 bot 粒度，不能为单跳把 B 的 `delegate_to_bot` 全局摘掉——否则 B 在自己其他对话里也永远无法委派，与 §2.3 矛盾。主机制是**执行时校验**：`delegate_to_bot.execute` 按 `identity.runId` 反查 `delegations.run_id`，命中活动委派（`working`）即拒绝。注册期摘除（`triggerReason='delegation'` 的 run 构建 toolset 时不注册）只是让模型少看到一个无用工具的优化，不能作为唯一保障：run 一旦启动，toolset 不再变化，而后续 steer 进来的批次不会改变 run 的 `triggerReason`。`triggerReason` 枚举增 `'delegation'`（runs 表 `trigger_reason` 无 CHECK 约束，纯 shared 枚举改动；同时扩 `TriggerBatch.reason` 联合类型）。
- **群内发起**：当前上下文是群时——A、B 均为成员 → 工具返回指引，改走 `send_message` `@`（D4），不写 `delegations` 行；B 不是该群成员 → 同样拒绝并提示（首期委派只支持从 A 的私聊发起，避免 B 私聊内容回贴到多人可见的群；用户可先把 B 拉进群再 `@`，或由管家建群）。

### 3.4 与 D66 SubAgent 的对照

| | D66 SubAgent | D71 A→B |
|---|---|---|
| 执行者 | 同 Bot 减配子 run | 另一个联系人 Bot 的完整响应 loop |
| 消息 | 不写用户消息 | B 私聊出现代发用户消息 |
| 工具 | 只读研究集 | B 的正常工具面（受自身授权） |
| 回传 | 压缩结论进主 loop | 截断原文贴 A 为卡 + follow-up |
| 群 | 不充当群成员 | 同群则降级 D4 |

### 3.5 投递闸门（B 忙 / 免打扰时的排队）

委派行写入后**不一定立刻投递**。向 B 投递前必须同时满足：

1. **B 邮箱空闲**（B 与该私聊的 mailbox 当前没有在跑的 loop）；
2. **B 不在 `behavior.quiet_hours` 内**（开放决策 6）。

原因：mailbox 的语义是「在跑的 loop 被 steer，否则开新 run」。如果 B 正在回应用户时委派到达，代发消息会被 steer 进那个**已有**的 run——它的 `triggerReason` 不是 `delegation`、`deliver` 返回的 run_id 是别人的任务的 run、终回复是对用户那件事的回答，结果卡会贴错内容，单跳也摘不掉。排队保证每个委派对应**自己起的 run**：`triggerMessageIds = [to_message_id]`、`triggerReason='delegation'`、`run_id` 精确。

- 闸门不通过 → 委派保持 `submitted`，A 的发出卡提示「将在 B 空闲 / 免打扰结束后发送」；**代发消息此时不落 B 私聊**（避免 B 私聊里出现一条没人回应的用户消息），投递瞬间才落库并转 `working`。**崩溃一致性**：「落代发消息 + 转 `working`」在同一个 main.db 事务里提交，`to_message_id` 随事务写入、`run_id` 在投递成功后单独回填——窗口期崩溃重启后，`submitted`（无消息）重走闸门，`working` 且无 run（stalled，消息已在）**复用既有消息重投**，不重发。
- 补投时机：B 邮箱 release 时扫描以该 B 为目标的 `submitted` 与 stalled 委派（按创建序 FIFO，每次只投一条，下一条等这个 run 释放）；quiet hours 用新 job 类型（参照 `event_delivery` 的 parking，到点重检）。
- `submitted` 阶段可被 `cancel_delegation` 直接 `cancelled`（无 run 可 abort）。`delegations.cancel` 对未知 id 报 `NOT_FOUND`（UI toast），不静默。
- 一个 B 同时存在多条 `submitted` 时按创建顺序依次投递；A 侧每条各有一张发出卡。
- 即便闸门通过，B 的 run 起来之后用户仍可能在 B 私聊里 steer 它（结果混杂风险，见 §4 与 todo 风险节），首期接受。

## 4 开放决策（推荐默认）

| # | 议题 | 状态 | 推荐默认 |
|---|---|---|---|
| 1 | B 侧消息形态 | **采纳推荐** | 用户代发 + A 标签「由 A 代你发出」 |
| 2 | 回贴内容 | **采纳推荐** | 截断原文（~2000）+ 链到 B 消息；feedback 首期不做 |
| 3 | B 未绑定 workspace 时是否继承 A 对话的 project | **开放** | 首期建议：不自动继承；B 用自己私聊已绑 project，未绑则走 D59「暂不设置」语义；跨 project 读写仍走 D36 授权 |
| 4 | Butler 创建 Bot/群的方式 | **采纳推荐** | 仅审批卡确认后确定性创建 |
| 5 | B 执行中途的过程消息是否同步到 A | **采纳推荐** | 不同步；仅最终回复（+ 失败/取消） |
| 6 | 委派是否遵守 B 的 quiet hours | **开放** | 首期建议：遵守 `behavior.quiet_hours`，并入 §3.5 投递闸门（与「B 忙」同一排队机制）；A 卡提示「将在免打扰结束后发送」。注意 user 代发路径当前没有 quiet hours 闸门，需在委派投递点新建；`deliverEventToBot` 的 parking（`event_delivery` job + `deliverParkedEvent` 重检）是现成模板 |
| 7 | 委派中崩溃恢复：ephemeral vs D67 durable | **开放** | 首期建议：委派行本身持久；B 的 run 仍按 D49/D67 分级。A 侧卡根据 `delegations.status` 重绘；不把整段委派默认升 durable |
| 8 | Butler 是否加入用户群 | **开放** | 首期建议：允许加入；在群内管家可 `suggest_route` / `@`，但 **A→B 委派仍降级 D4**（与 §3.3 一致） |
| 9 | 管家是否裁剪通用工具（文件 / 命令 / 浏览器等） | **开放** | 首期不裁剪（管家也是联系人，用户可能直接让它干活），仅靠 `<butler_rules>` 约束路由职责；如需收紧，在 P4 以 Profile / 设置开关处理，不改本设计契约 |

## 5 非目标（本设计明确不做）

- 用 D66 SubAgent 模拟另一个 Bot 联系人。
- 多跳委派（A→B→C→…）——首期一律单跳，不论发起者是否管家。
- 把 B 的工具过程 / 中间 progress 镜像到 A 聊天流。
- 跨用户 / 多租户管家；云端托管委派总线。
- 替换 D4 群 `@` 协议。
- 管家可被用户删除或建多个。
- 结果卡 feedback（有用 / 需重做）。
- 从群发起的、B 不在群内的委派。

## 6 实现分期（文档级 P1–P4）

与执行 todo 对齐，便于按阶段验收：

1. **P1 地基**：`system_role`（含 partial unique index）、管家唯一/置顶/不可删、存量用户 `ensureButler`、`delegations` 表与状态枚举、approvals `kind` CHECK 重建（含 `butler_proposal`）、常量、边界测试（与 D4/D66 对照）。
2. **P2 管家入职与组队**：管家访谈变体、`butler_proposal` 审批卡（非阻塞、无人值守排除、`decide.selection`）、确定性批量创建、`list_bots`（全体 Bot 可用）/ `propose_*`（仅管家）。
3. **P3 A→B 委派主路径**：`delegate_to_bot` / `cancel_delegation`、投递闸门（B 忙 / quiet hours）、B 代发消息 + 标签、A 发出/结果卡（含上下文渲染）、截断回贴、follow-up 注入、防环与单跳（执行时校验）、同群降级 D4、记忆证据排除、生命周期级联。
4. **P4 路由与收尾**：`suggest_route` + 路由卡、「你安排」再委派、剩余开放决策默认值落地（workspace 不继承等按上表）、回归与 e2e。

## 7 验收锚点（设计级）

1. 新装用户完成引导后通讯录有且仅有一个管家，置顶，删除入口不可用或明确拒绝；存量用户升级后同样有管家。
2. 管家 `propose_team` → 用户确认 → 3–5 个 Bot 落库；用户去掉某项则只建剩余项；未确认不落库（含无人值守模式）。
3. A 委派 B：UI 留在 A；B 私聊出现带标签的用户代发消息；B 回复后 A 出现截断结果卡 + 链接；A 收到 internal follow-up 且不复述全文。
4. B 正忙时委派排队（`submitted`），B 空闲后才投递且结果对应委派任务而非 B 的其他对话；被委派 run 的 `delegate_to_bot` 调用被拒绝（含 steer 进来的情形）；A→B→A、委派给管家被拒绝；同群 A/B 走 `@` 不写委派行。
5. `delegate_task`（D66）行为回归不变；群 D4 连锁回归不变。

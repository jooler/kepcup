# 管家 Bot + 跨 Bot 委派（D70 / D71）

> 状态：**P1–P4 已实现（2026-10-06，见 docs/dev/PROGRESS.md；e2e 未在本机运行）**（决策 D70 / D71，设计见 `docs/design/27-butler-and-delegation.md`）。分四个阶段 P1→P4；P1 是后续前置。本文是给编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。
>
> **硬约束**：只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。
>
> **修订记录**：本文经一轮对照代码的审查修订（approvals 表 CHECK、访谈机制耦合、mailbox steer 与 run 绑定、卡片上下文渲染、记忆证据等），修订点均已并入各阶段清单；设计侧同步改了 27。

## 0. 先读什么（按顺序）

1. `docs/design/27-butler-and-delegation.md` — 产品契约、开放决策默认值、非目标
2. `docs/design/23-mcp-and-subagent.md` — D66：同 Bot `delegate_task` + follow-up 注入（**对照：不是跨 Bot**）
3. `docs/design/02-execution.md` — D4 群 `@` 连锁；文末「跨 Bot 委派」短节
4. `docs/design/18-inline-setup.md` / `19-work-path-and-group-setup.md` — 审批卡 / `ask_question` / 确定性 setup
5. `docs/design/03-bot.md` — Bot 生命周期（管家节）
6. 代码锚点（实现时打开）：
   - `packages/core/src/domain/bots.ts` — `BotsService.create` / `rowToBot` / `markDeleted`
   - `packages/core/src/domain/lifecycle.ts` — `deleteBot`（先 `abortRunsForBot`，管家判定要在它之前）
   - `packages/core/src/domain/conversations.ts` — `openDirect`（幂等开 / 建私聊）
   - `packages/core/src/domain/messages.ts` — `append`（**手工拼 content_json**，新增 content 字段必须改这里）
   - `packages/core/src/domain/groups.ts` — `create`（无 description 入参）/ `finalizeSetup`
   - `packages/core/src/dispatch/chains.ts` — D4 深度/预算（仅群内）
   - `packages/core/src/dispatch/orchestrator.ts` — `deliverEventToBot` / `deliverParkedEvent`（quiet-hours parking 模板）/ `#injectDelegateFollowUp` / `#settleRun` / `#executeResponseRun`（`finally` 里 `mailbox.release()` 与缓冲批重投）/ `#steerRunningRun` / `#deliverDirectThroughGate`（直聊投递唯一闸口）/ `#renderOptions.renderCard` / `recoverInterrupted`（走 `runs.markAllActiveInterrupted`，**不经 `#settleRun`**）/ `beginSetupInterview` / `answerSetupQuestion`
   - `packages/core/src/scheduler/mailbox.ts` — `deliver` 语义：有在跑的 loop 就 steer，否则开新 run；`TriggerBatch.reason` 联合类型
   - `packages/core/src/dispatch/jobs-runner.ts` — job 类型分发 / 优先级（`event_delivery` 分支）
   - `packages/core/src/agent/subagent.ts` + `packages/core/src/tools/delegate-tools.ts` — D66 工具（勿改语义冒充跨 Bot）
   - `packages/core/src/tools/setup-tools.ts` — `ask_question` / `save_profile` / `finish_setup`（同一 facade 同注册）
   - `packages/core/src/tools/index.ts` — `buildResponseTools`（每 run 构建 toolset；`setup` 门面按 `bot.setupState` 注入）
   - `packages/core/src/permissions/approvals.ts` — `request` / `submitNonBlocking` / `#autoDecideSync` / `cancelPendingForRun`（`excludeKinds: ['environment']`）/ `describe` / `renderContextLine` / `decide`
   - `packages/core/src/memory/reflection.ts` + `memory/service.ts` — 用户证据判定（`senderType==='user'`）
   - `packages/shared/src/constants.ts` — `BOT_CHAIN_*` / `SUBAGENT_FOLLOWUP_EVENT` / `SETUP_MAX_QUESTIONS` / `INTERNAL_SYSTEM_EVENTS`
   - `packages/shared/src/domain/types.ts` — `botSchema` / `messageSchema` / `triggerReasonSchema` / `jobTypeSchema` / `textContentSchema`（`setupAnswer` 前例）/ `approvalKindSchema` / `approvalDecisionSchema` / `cardContentSchema`
   - `packages/shared/src/rpc/methods.ts` + `packages/core/src/rpc/bindings.ts` — `approvals.decide`、`bots.interview.*`
   - `apps/desktop/.../onboarding/OnboardingWizard.svelte` — step `bot` 模板；`features/approvals/ApprovalCard.svelte`；`features/chats/SetupQuestionCard.svelte`（可点击性读 `bot.setupState`）
   - 迁移：`packages/core/migrations/main/` 下一号 **`0016_*.sql`**（现有到 0015）；runs 库现有到 0004，若需列则 `0005_*.sql`（`trigger_reason` 无 CHECK，枚举增值免迁移）。**迁移只有前进、没有 down**（失败靠启动前自动备份回滚，见 `migration-rollback.test.ts`）

## 1. 背景与目标

1. **D70 Butler**：唯一管家联系人（置顶、不可删）；新用户访谈后用审批卡提议 3–5 个领域 Bot，用户确认后**确定性**批量 `bots.create`；提供路由与组队工具。
2. **D71 A→B**：A 调用 `delegate_to_bot`（异步）→ B 私聊收到「用户代发 + 由 A 代你发出」→ UI 留在 A → B 终回复截断贴回 A + internal follow-up；防环（首期一律单跳）；同群降级 D4。

**复用**：D66 follow-up / `deliverEventToBot`；D4 深度预算思路；`ask_question` / 审批卡范式；`bots.create`；`event_delivery` parking。

**不做（整篇）**：

- 用 `delegate_task` / SubAgent 冒充另一个 Bot
- 多跳委派（首期一律单跳，管家也不例外）
- 同步 B 中途 chatter 到 A
- 多个管家 / 删除管家
- 改 D4 群 `@` 协议本身
- 结果卡 feedback（有用 / 需重做）
- 从群发起、B 不在群内的委派
- git commit / push / PR

## 2. 实施顺序

```
P1 地基（schema + 管家身份约束 + 存量用户 ensure）
 → P2 管家入职与组队（访谈变体 + 审批卡 + 批量创建 + list/propose 工具）
 → P3 A→B 委派主路径（delegations + 投递闸门 + 消息/卡片 + 防环）
 → P4 路由卡收尾 + 开放决策默认值 + 回归/e2e
```

---

## 3. P1 — 地基

### 3.1 改动清单

- [x] **shared**：`botSchema` 增 `systemRole: z.enum(['butler']).nullable().optional()`；Profile 内已有 `role` 对象，DB 列 / API 字段一律叫 `system_role` / `systemRole`，禁止混用
- [x] **shared constants**：`DELEGATION_MAX_DEPTH`（= 1，首期唯一取值；`delegations.depth` 列保留，日后放宽再设计「等下游结算」）、`DELEGATION_RESULT_MAX_CHARS`（2000）、`DELEGATION_FOLLOWUP_EVENT`（如 `delegation_result`——勿与 D66 的 `delegate_result` 混淆）、`BUTLER_TEAM_SIZE_MIN/MAX`（3/5）。**不要**加 `DELEGATION_MAX_DEPTH_BUTLER`（管家 2 层已搁置，见设计 §3.3）
- [x] **main 迁移** `0016_butler_and_delegation.sql`（号以目录实况为准），一个文件包含：
  - `bots.system_role TEXT NULL` + partial unique index：`create unique index ... on bots(system_role) where system_role = 'butler' and status = 'active'`
  - `delegations` 表：`id, from_bot_id, to_bot_id, from_conversation_id, to_conversation_id, task_text, status, depth, to_message_id, run_id, result_excerpt, result_message_id, error_text, created_at, updated_at`；`status` 用 CHECK（`submitted/working/completed/failed/cancelled`，新表加 CHECK 无代价）。**对话 id 不加 `ON DELETE CASCADE` 的外键**——对话删除时委派行要保留并终态化（见 3.1 lifecycle 项），`to_message_id` / `run_id` 同样只存 id（run 在 runs.db，跨库本来就只能存 id）。索引：`(to_bot_id, status)`、`(run_id)`、`(from_conversation_id)`
  - **重建 `approvals` 表**把 `butler_proposal` 加入 `kind` CHECK 列表（SQLite 不能改 CHECK，照 `0015_mcp_approvals.sql` 的标准流程：建 `approvals_new` → 拷数据 → drop → rename → 重建 `approvals_pending` 索引）。当前 CHECK 里已有 `'access','unsandboxed','command','git_remote','environment','skill_import','profile_change','skill_preset','mcp_tool'`，**以最新迁移为准全部带上，别漏**（0010 → 0015 就漏过 `skill_preset`）。这一步不做，后面 P2 的 `butler_proposal` 一落库就触发 CHECK 失败（单测 stub 摸不到，要有真库集成测试）
- [x] **shared**：`approvalKindSchema` 增 `'butler_proposal'`；`approvalDecisionSchema` 增可选 `selection`（见 P2）；`jobTypeSchema` 增 `delegation_delivery`（P3 用；jobs 表 `type` 无 CHECK，只改枚举 + jobs-runner 分发）
- [x] **core `BotsService`**：`rowToBot` 读 `system_role`；`getButler()` / `ensureButler()`（幂等；并发安全靠 unique index，冲突时回读）；`create(..., { systemRole: 'butler' })`；拒绝第二个 butler；`markDeleted` 不会碰到管家（上层已拒）但对管家直接抛错作双保险
- [x] **启动 ensure**：core 启动（迁移之后）若 `onboarding.completed` 为真则 `ensureButler()`——覆盖**存量用户**（升级前已完成引导、没有管家）。新用户走 onboarding 完成后创建（P2）。存量用户的管家**不开访谈**（`setup_state` 为空），首次打开发确定性问候（P2）
- [x] **lifecycle**：`deleteBot` 若目标为 butler → `AppError` 拒绝，**放在 `abortRunsForBot` 之前**（否则先把管家的 run 全中止了再报错）
- [x] **desktop**：侧栏置顶管家（由 `bot.systemRole` 推导，不另存 pinned）；删除菜单对管家隐藏或弹「不可删除」
- [x] **文档**：`docs/dev/03-data-model.md` 补 `bots.system_role`、`delegations` 表、`approvals.kind` 新值与删除级联行（见 P3）
- [x] **测试**：唯一约束（含并发 `ensureButler`）、删管家失败且未中止其 run、迁移在**含旧 approvals 数据**的库上可应用（approvals 行拷贝完整）、`butler_proposal` 能真写入 `approvals`（真库，不用 stub）、存量用户启动后恰有一个管家

### 3.2 验收

1. 空库调用 ensure → 恰好一个 butler；再 create butler 失败；存量库启动后同样恰一个。
2. UI/RPC 删除管家被拒且不中止其 run；普通 Bot 删除仍按 D18。
3. 迁移在带历史 approvals 数据的库上通过，历史审批行不丢。
4. `pnpm --filter @kepcup/core test` 相关单测绿；`pnpm typecheck` 过。

### 3.3 本阶段不做

- 组队卡、委派工具、路由卡、改 onboarding 文案以外的流程。

---

## 4. P2 — 管家入职与组队

### 4.1 行为

1. 新用户 onboarding 完成时：`ensureButler`（带 `interview` 变体态）+ 打开管家私聊（`conversations.openDirect`）。存量用户的管家：首次打开发确定性问候，不访谈。
2. **管家访谈 = 现有访谈机制的变体**（不要另起一套）：既有访谈整套绑定 `bots.setup_state='interviewing'`——`ask_question` 与 `save_profile` / `finish_setup` 同一 `setup` 门面注册、`answerSetupQuestion` / `bots.interview.*` 校验该态、问题卡可点击性读该态、D59 目录闸门对该态扣下投递。管家访谈**复用同一状态位**，差异：
   - 工具面：`ask_question` + `propose_team`；**不注册** `save_profile` / `finish_setup`（管家 Profile 固定）。落点：`buildSetupTools` 按 butler 变体只返回 `ask_question`；`bot.setupState==='interviewing' && bot.systemRole==='butler'` 时 `buildResponseTools` 额外加 `propose_team`
   - **跳过目录闸门**：`#setupPathGateClosed` 对 butler 恒返回 false（管家不绑 project）
   - 首问卡 / 候选项 / 访谈指引用管家版文案（常量与 `system-prompt.ts` 访谈段各一份变体）；问题上限仍 `SETUP_MAX_QUESTIONS`
   - `bots.interview.start` 对 butler 下发管家版问候 + 首问（`beginSetupInterview` 按 `systemRole` 取文案）
   - 退出：`propose_team` 提交即清 `setup_state`；卡片全部拒绝后管家回普通对话，可再次 `propose_team`
3. **审批卡**：单一 kind `butler_proposal`，payload 用 `proposalType: 'team' | 'bot' | 'group'` 区分；展示 3–5 个建议 Bot（名 / 职责 / 理由）；用户可勾掉某项或全盘确认。
4. **非阻塞提交**：走 `submitNonBlocking`（同 `environment`），工具 `terminate: true` 结束管家本轮；卡片与 run 脱钩。
5. 确认后 core 在 `onDecided` 回调里**确定性**循环 `bots.create`（`interview:false`，不经模型再发明名字），发 `bot.updated`；`group` 类型调 `groups.create`；部分失败：已建保留，`approvals.fail(id, reason)` 标 `failed` 并列出失败项。完成后用 internal follow-up 唤醒管家（`deliverEventToBot`）让它对用户说下一步。
6. 工具：`list_bots`（只读，**所有 Bot** 注册，与 `delegate_to_bot` 同范围——非群对话提示词里没有其他 Bot 名单，不给就没法选 B）、`propose_team` / `propose_bot` / `propose_group`（单卡）/ `suggest_route`（P4 先 stub）——后几者仅 butler 注册。

### 4.2 改动清单

- [x] **shared**：`butler_proposal` payload schema（`proposalType`、条目 `{ name, bio, expertise, responsibilities, reason }`、group 的 `{ title, description, memberBotIds }`）+ 校验（`team` 条目数 `BUTLER_TEAM_SIZE_MIN..MAX`）；`approvalDecisionSchema.selection`；`approvals.decide` RPC input 增可选 `selection`（`methods.ts` + `bindings.ts` + `approvals.decide(id, approve, duration, selection)`）
- [x] **approvals.ts**：
  - `decide`：`butler_proposal` + approve 时校验 `selection` ⊆ payload 条目（选 0 个 = 当作拒绝；数量下限只约束模型提议，不约束用户勾选）；落 `decision_json`
  - `#autoDecideSync` 按 kind 排除 `butler_proposal`：无人值守下**不自动批**、走 `#requestAndWait` / 非阻塞挂起路径（注意 `request()` 与 `submitNonBlocking()` 两处入口都先判 `unattended.enabled`，两处都要改）
  - `cancelPendingForRun` 的 `excludeKinds` 加 `butler_proposal`（否则管家 run 一结束卡片就被取消）；`cancelPendingForConversation` / `ForBot` / 启动 `cancelAllPending` 保持
  - `describe` / `renderContextLine`（模型上下文里的那一行）增 `butler_proposal` 分支
- [x] **core tools**：`packages/core/src/tools/butler-tools.ts`（新）；`tools/index.ts`：`list_bots` 对所有 bot 注册，`propose_*` / `suggest_route` 仅 `bot.systemRole==='butler'` 注册；`propose_team` 提交后清 `setup_state`
- [x] **orchestrator / gateway**：`onDecided` 回调里 `bots.create` 批量 / `groups.create`（`GroupsService.create` 没有 description 入参——补可选 `description`，或建后写一次；D60 `finalizeSetup` 是另一条路径，别误套）；`bot.updated` / `conversation.updated` 发布；批准后的 internal follow-up
- [x] **访谈变体**：见 4.1 第 2 条的各落点（`setup-tools` / `setupPathGateClosed` / `beginSetupInterview` / `system-prompt` 访谈段）
- [x] **system prompt**：管家专用 `<butler_rules>`（组队只经卡、先路由后执行、不替用户直接建 Bot 等）
- [x] **onboarding**：`OnboardingWizard` step `bot` 演进为「创建管家并进入访谈」（保留旧单 Bot 模板仅作为侧栏「新建」路径，不再放在引导里）；`persist({ completed: true })` 之后 ensure 管家
- [x] **desktop**：`ApprovalCard.svelte` 增 `butler_proposal` 分支（条目复选 + 确认 / 全部拒绝，确认时带 `selection`）；`ChatView` / `SetupQuestionCard` 对管家访谈态按现状工作（读 `bot.setupState`，无需特判，但要验证）
- [x] **i18n**：`zh-CN` 管家 / 组队卡文案（目前只有 `zh-CN` 一个 locale）
- [x] **测试**：
  - 单测：`decide.selection` 校验、无人值守不自动批 `butler_proposal`（且其它 kind 不受影响）、`cancelPendingForRun` 不取消 `butler_proposal`
  - 集成（**真库**）：propose_team 未确认零新 Bot；确认后 N 个 Bot；去掉一项后 N-1 个；全拒绝零 Bot 且管家可再提议；非管家 tools 列表无 `propose_*`、有 `list_bots`；管家访谈不写管家 profile、无目录闸门

### 4.3 验收

1. 新用户路径结束通讯录：1 管家 + 确认后的领域 Bot；存量用户升级后有管家且无访谈。
2. 未点确认（含无人值守模式），`bots` 表无新领域 Bot。
3. 普通 Bot 的 tools 列表无 `propose_team` / `propose_bot` / `propose_group`，有 `list_bots`。
4. 管家访谈中 `save_profile` / `finish_setup` 不可用，`propose_team` 提交后管家离开访谈态。

### 4.4 本阶段不做

- `delegate_to_bot` 主路径（P3）；路由卡完整产品（P4 可先 stub `suggest_route`）。

---

## 5. P3 — A→B 委派主路径

### 5.1 行为契约（实现必须对齐）

| 步骤 | 行为 |
|---|---|
| A 调 `delegate_to_bot`（**异步**） | 先校验（见下「拒绝清单」）；写 `delegations`=`submitted`；A 对话插「已委托」发出卡（`kind='card'`，`cardContentSchema` 带 `delegationId`）；**工具立即返回**，A 本轮照常收尾 |
| 投递闸门 | 向 B 投递前须：①B 与该私聊的 mailbox 空闲（`isMailboxIdle`）②B 不在 `quiet_hours`。不通过 → 保持 `submitted`，A 的发出卡提示「将在 B 空闲 / 免打扰结束后发送」，**代发消息此时不落 B 私聊**。补投：B mailbox release 时扫该 B 的 `submitted`（FIFO，一次一条）；quiet hours 用新 job `delegation_delivery`（参照 `event_delivery` / `deliverParkedEvent`：到点重检、仍在免打扰则再 defer）。**为什么必须排队**：mailbox 在有在跑 loop 时会把批次 steer 进该 run——run 的 `triggerReason` 不是 `delegation`、`deliver` 返回的是别人任务的 run id、终回复是对用户另一件事的回答；排队才能保证每个委派有自己的 run |
| 投递瞬间 | `conversations.openDirect(B)`（幂等）→ 在 B 私聊 append **user** 消息（`origin='delegation'`、`delegationId`；`senderType='user'`，不是 `bot:A`）→ publish `message.created` → `to_message_id` 落行 → 经 `#deliverDirectThroughGate`（其 `reason` 参数目前只收 `'direct' | 'event'`，需放宽到 `'delegation'`）以 `reason='delegation'`、`extraAttributes: { from_bot, delegation_id }` 投递 → `deliver` 返回的 run id 回填 `run_id`、`status='working'`、publish `delegation.updated`。（`deliver` 返回 null 只可能在 steer 缓冲窗口——闸门已保证空闲，若仍出现，回退为保持 `submitted` 并下一次 release 重试，别硬标 `working`） |
| B 执行 | 正常响应 loop；中途消息**不**同步到 A。B 触发上下文提示：这是 A 代用户转交的任务，**本轮内**给出完整结果，不要用后台 `delegate_task` 或「稍后告诉你」收尾；信息不足就直接追问用户 |
| B settle | 在 `#settleRun`（终态）按 `delegations.run_id` 反查（`working` 状态才处理；与 D66 per-run `onFollowUp` 回调挂法不同，委派是 settle 时匹配）。`completed`：取该 run 的最终 bot 文本消息（成功路径里终回复先 append 再 settle，按 `run_id` 查 B 私聊里该 run 的最后一条 bot 文本）→ 截断 `DELEGATION_RESULT_MAX_CHARS` → A 贴结果卡 + link（`conversationId` + `result_message_id`）→ `completed`；无任何文字回复（如 `skip_reply`）→ 仍 `completed`，结果卡写「B 没有文字回复」。`failed` / `interrupted` → `failed` + `error_text`（A 卡展示失败原因，不贴全文）。`cancelled` → `cancelled`。随后 `deliverEventToBot(A, from_conversation_id, DELEGATION_FOLLOWUP_EVENT, …, { internal: true })` 含「勿复述」指令（A 自己 `cancel_delegation` 触发的取消**不**再通知 A） |
| 取消 | `cancel_delegation` 或 A 卡取消：`submitted` → 直接 `cancelled`；`working` → abort B 活动 run（`cancelRun(run_id)`；若 run 未开始，`cancelRun` 已处理 queued 情形）→ `cancelled`。注意取消该 run 也会走 settle 钩子，要靠「状态已非 working」或来源标记避免重复处理 / 重复通知 |
| 防环（首期一律单跳） | **主机制 = 执行时校验**：`delegate_to_bot.execute` 按 `identity.runId` 反查 `delegations.run_id`，命中 `working` 即拒绝（覆盖被委派 run、以及后续 steer 进来的情形——run 启动后 toolset 不变，`triggerReason` 也不变）。注册期摘除（`triggerReason==='delegation'` 的 run 不注册 `delegate_to_bot`）仅作优化，**不得作为唯一保障**；且**不得按 bot 粒度摘**（B 在自己其他对话里仍要能委派）。另：A→B→A 拒绝（兜底）、`to_bot_id == from_bot_id` 拒绝 |
| 拒绝清单（工具即时报错，不写行） | `to_bot_id` 为 butler；B 非 active；B 私聊只读；B `setup_state==='interviewing'`（目录闸门会扣下投递，委派会悬挂）；当前对话是群：A、B 均为成员 → 返回指引改 `@`（D4），B 非成员 → 拒绝并提示（首期仅支持从 A 的私聊发起）；被委派 run 内再委派 |
| 记忆证据 | B 的反思 / 画像整理把 `origin='delegation'` 的 user 消息排除出「用户证据」（`reflection.ts` / `memory/service.ts` 里 `senderType==='user'` 的判定处，或渲染为「A 转述」）——代发文本是 A 写的，不是用户的话 |
| 生命周期 | `deleteBot`（A 或 B）/ `deleteConversation`（A 或 B 的私聊）：活跃委派落 `cancelled`（并 abort B 的活动 run）；行保留；卡片「查看原文」在对话不存在时降级。在 `lifecycle.ts` 已有的级联步骤里加，别靠 FK |

### 5.2 改动清单

- [x] **shared**：delegation 类型 / status 枚举；`triggerReasonSchema` 增 `'delegation'`（runs 表无 CHECK，免迁移）；`TriggerBatch.reason` 联合类型同步加 `'delegation'`；`textContentSchema` 增可选 `origin` / `delegationId`；`cardContentSchema` 增可选 `delegationId`；RPC `delegations.get` / `delegations.cancel`；事件 `delegation.updated`（A 的发出卡实时重绘）
- [x] **messages.append**：`AppendMessageInput` 增 `origin` / `delegationId`（text）与 `delegationId`（card），并改 `append` 里手工拼 content_json 的分支——只改 zod schema 会让字段在落库时被丢掉
- [x] **core**：`packages/core/src/domain/delegations.ts`（新；含状态流转的单一入口，所有 `status` 更新走它并发 `delegation.updated`）；`tools/delegation-tools.ts`（`delegate_to_bot` / `cancel_delegation`），`tools/index.ts` 对所有 bot 注册；`delegate_to_bot` 的 `execute` 里做执行时单跳校验与拒绝清单
- [x] **orchestrator**：投递闸门与补投（`#executeResponseRun` `finally` 的 `mailbox.release()` 之后扫 `submitted`）；`delegation_delivery` job 分支（`jobs-runner.ts`：加入「响应触发类」优先级分支，与 `event_delivery` 同）；`#startResponseRun` 优先级：`'delegation'` 按用户触发（0）还是后台（1）显式选定并写进注释；`#settleRun` 钩子；`#injectDelegationFollowUp`（仿 `#injectDelegateFollowUp`）；`recoverInterrupted` 要**单独**处理（它走 `runs.markAllActiveInterrupted`，不经 `#settleRun`）：`working` 且 run 已 `interrupted` → `failed`，`submitted` 保持（下次可投递时补投，注意 quiet hours job 是持久的、邮箱状态是内存的，重启后也要扫一遍 `submitted` 重新触发）
- [x] **renderCard**：`#renderOptions.renderCard` 现对所有非 `run_changes` 卡按 `approvalId` 查审批——对委派卡会渲染成「（审批记录已清理）」。补 `delegationId` 分支，输出一行状态 + 摘要（不含 B 全文）
- [x] **B 的上下文**：触发段 `from_bot` / `delegation_id` 属性；`renderMessageLine` 对 `origin='delegation'` 的 user 消息标注「由 {A} 代用户转交」；B 的「本轮内完成」提示（放触发上下文或 `<platform_rules>` 里按此触发才出现的一条）
- [x] **lifecycle**：见 5.1 生命周期行；`docs/dev/03-data-model.md` 删除级联表补 `delegations` 行
- [x] **memory**：反思 / 画像整理的用户证据判定排除 `origin='delegation'`
- [x] **desktop**：DelegationSentCard（随 `delegation.updated` 重绘，含 `submitted` 提示与取消按钮）/ DelegationResultCard；B 侧消息气泡标签「由 {A.name} 代你发出」；**不**自动 `openConversation(B)`；i18n
- [x] **prompt**：平台规则一条：何时委派 vs `@` vs `delegate_task`、委派是异步的（调用后收尾，结果稍后到）、不要对同一件事重复委派
- [x] **测试**：
  - 单测：截断、拒绝清单各项、**执行时单跳**（被委派 run 调 `delegate_to_bot` 被拒——按 `run_id` 反查命中，不依赖 toolset 里有没有这个工具）、同群降级、状态机非法流转、settle 钩子幂等（取消 + settle 不重复通知）
  - 集成（真库）：A→B 全链路（A 消息流有卡、B 有代发用户消息、A UI 会话未切换、follow-up internal、结果卡截断且链到 B 的消息、D66 回归）；**B 忙时排队**（B 正跑用户的任务，委派保持 `submitted`，B 空闲后才投递，结果对应委派而非原任务）；quiet hours 排队；B run 失败 → A 卡 `failed` + `error_text`；A 的 `cancel_delegation`（`submitted` / `working` 各一）；删 B / 删 B 私聊 → 委派 `cancelled`；重启恢复；`renderCard` 对委派卡输出；B 的反思不把代发文本当用户证据

### 5.3 验收

1. A 委派后当前会话仍是 A；B 私聊可见带标签代发消息（投递瞬间才出现）。
2. B 回复后 A 结果卡 ≤2000 字 + 可点链；A 模型侧收到 internal 事件，且上下文里的委派卡不是「审批记录已清理」。
3. B 正忙时委派排队；B 免打扰时委派排队；空闲 / 免打扰结束后投递，结果对应委派任务。
4. 被委派 run 调 `delegate_to_bot` 被拒；A→B→A、委派给管家、B 访谈中、同群、群内 B 非成员均按设计拒绝或降级。
5. B run 失败/中断 → A 卡转 `failed`；重启后 `working` 且 run 已中断的委派落 `failed`。
6. 删除 A / B / B 私聊后活跃委派终态化，无悬挂 run。
7. 现有 `delegate_task` 集成测试仍绿。

### 5.4 本阶段不做

- workspace 自动继承（默认不继承）
- durable 专升（委派行持久即可）
- 结果卡 feedback
- 多跳 / 管家 2 层

---

## 6. P4 — 路由与收尾

### 6.1 改动清单

- [x] `suggest_route` + **路由卡** UI（去管家 / 去某 Bot / 建群 / 委派）。路由卡不是审批（没有「批准后执行」语义），用 `kind='card'` + 自有 `cardType`，按钮走现有导航 / 触发管家后续对话的通道，不要塞进 `approvals`
- [x] 管家 prompt：未知→管家；早期**先卡后办**；用户「你安排」再 `delegate_to_bot`
- [x] 核对开放决策默认值已落地（见设计 §4）：quiet hours 提示（P3 已含，复核 UX）、不继承 project、组队必确认、中途不同步、崩溃按 status 重绘卡
- [x] Butler 入群策略按开放默认（允许加入；群内委派仍降级 D4）
- [x] 开放决策 9：管家工具面首期不裁剪（如要收紧，设置 / Profile 开关，不改契约）
- [x] e2e（`apps/desktop/test/e2e/`）：onboarding→管家→组队确认（含勾掉一项）；A 委派 B 主路径快照/断言
- [x] 文档：若实现偏离，回写 `27` 与 `docs/dev/PROGRESS.md`；工具目录补进 `docs/dev/04-agent-runtime.md`；`03-data-model.md` 复核（仍不 commit，除非用户要求）

### 6.2 验收

1. 路由卡可一键跳转；「你安排」后出现委派卡而非默默执行（产品早期）。
2. 迭代中跑相关测试文件与 `pnpm --filter @kepcup/core test`；交付前全量 `pnpm typecheck` + `pnpm test` 一次；相关 e2e 绿（见 [docs/dev/05-testing.md](../docs/dev/05-testing.md#开发中如何跑测试)）。
3. D4 / D66 / 访谈 / 群创建回归无回归。

---

## 7. 文件路径速查（预期会碰）

| 区域 | 路径 |
|---|---|
| 设计 | `docs/design/27-butler-and-delegation.md`、`docs/design/README.md`（已含 D70/D71） |
| 开发文档 | `docs/dev/03-data-model.md`、`04-agent-runtime.md`、`PROGRESS.md` |
| 迁移 | `packages/core/migrations/main/0016_*.sql`（确认号；含 approvals 表重建） |
| shared | `packages/shared/src/domain/types.ts`、`constants.ts`、`rpc/methods.ts`、errors |
| core domain | `domain/bots.ts`、`domain/lifecycle.ts`、`domain/messages.ts`、`domain/delegations.ts`（新）、`domain/groups.ts` |
| core dispatch | `dispatch/orchestrator.ts`、`dispatch/jobs-runner.ts`、`scheduler/mailbox.ts` |
| core permissions | `permissions/approvals.ts`（无人值守按 kind 排除、`excludeKinds`、`decide.selection`） |
| core tools | `tools/butler-tools.ts`、`tools/delegation-tools.ts`、`tools/index.ts`、`tools/setup-tools.ts` |
| core memory | `memory/reflection.ts`、`memory/service.ts`（证据排除） |
| prompt | `agent/context/system-prompt.ts`、`agent/context/conversation.ts`（触发段 / 消息渲染） |
| rpc | `rpc/bindings.ts` |
| desktop | `features/onboarding/OnboardingWizard.svelte`、sidebar、`features/approvals/ApprovalCard.svelte`、chat cards、i18n `locales/zh-CN.ts` |
| 测试 | `packages/core/test/unit/`、`test/integration/`；`apps/desktop/test/e2e/` |

## 8. 风险与注意

- **命名冲突**：DB/API 用 `system_role`；Profile JSON 里已有 `role` 对象——禁止混用。
- **approvals.kind 的 CHECK**：新 kind 必须重建表（0016 里做）；单测里的 approvals stub 摸不到这个坑，必须有真库测试。重建时把现有全部 kind 带上。
- **访谈机制耦合 `setup_state`**：管家访谈是该机制的变体，不是新机制；别把 `save_profile` 暴露给管家（会改写固定人设），也别让 D59 目录闸门扣住管家。
- **mailbox 的 steer 语义**：不排队就会把委派 steer 进 B 的已有 run，run_id / triggerReason / 终回复全错位。投递闸门（B 邮箱空闲）是正确性要求，不是优化。
- **消息 sender**：B 侧必须是 `user` 代发，不是 `bot:A`，否则群规则/权限语义错位；标签用独立 origin 字段（textContentSchema，落 content_json，且要改 `messages.append`）。
- **记忆污染**：代发消息是 `user` 发送者，会被 P07 当成「用户说过的话」。必须在证据判定处排除 `origin='delegation'`。
- **单跳摘除粒度与时机**：勿按 bot 粒度全局摘掉 B 的 `delegate_to_bot`；执行时校验（`run_id` 反查）才是主机制，注册期摘除只是优化。
- **B 提前收尾**：B 用后台 `delegate_task` 或「稍后告诉你」结束本轮，终回复会被当结果提前回贴——靠 B 触发上下文的「本轮内完成」提示缓解，不额外做结算。
- **结果混杂**：被委派 run 启动后，用户仍可能在 B 私聊里 steer 它，终回复可能混入对用户说的话——首期接受，靠截断 + 「查看原文」链接缓解，结果卡标注来源。
- **Follow-up**：必须 `internal: true`，进 A 上下文、不刷用户可见复述指令原文（对齐 D66 `#injectDelegateFollowUp`）；`deliverEventToBot` 要求 A 仍是 `from_conversation` 的成员且未只读，否则静默丢弃——结果卡仍要贴（卡片走 `messages.append`，不依赖 follow-up）。
- **卡片上下文渲染**：`renderCard` 对未知卡类型会输出「（审批记录已清理）」，委派卡 / 路由卡必须补分支。
- **重启语义**：审批回调在内存里（重启 `cancelAllPending`），委派行持久；`working` 且 run 已中断 → `failed`，`submitted` 要在启动后重新触发补投。
- **租约**：B 写 project 仍走 B 对话绑定与 D29 租约；不要静默共用 A 的 project（开放决策默认）。
- **无人值守**：组队/建 Bot 审批排除自动批准（`#autoDecideSync` 按 kind 排除，需新增该机制，`request` 与 `submitNonBlocking` 两处入口），避免管家刷出一堆联系人。
- **迁移无 down**：不存在「迁移可逆」；验证靠「可应用 + 带旧数据」与既有启动前备份回滚。

## 9. 完成定义（整包）

- [x] P1–P4 清单勾完，验收口径满足
- [x] 设计文档与实现无未记录的硬偏离（有则改 27）
- [x] `docs/dev/03-data-model.md` / `04-agent-runtime.md` / `PROGRESS.md` 已同步
- [ ] **未**执行 git commit / push / 创建 PR（用户本次明确要求提交，例外）

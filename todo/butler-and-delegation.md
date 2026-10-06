# 管家 Bot + 跨 Bot 委派（D70 / D71）

> 状态：**已拍板待实现**（决策 D70 / D71，设计见 `docs/design/27-butler-and-delegation.md`）。分四个阶段 P1→P4；P1 是后续前置。本文是给编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。
>
> **硬约束**：只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。

## 0. 先读什么（按顺序）

1. `docs/design/27-butler-and-delegation.md` — 产品契约、开放决策默认值、非目标
2. `docs/design/23-mcp-and-subagent.md` — D66：同 Bot `delegate_task` + follow-up 注入（**对照：不是跨 Bot**）
3. `docs/design/02-execution.md` — D4 群 `@` 连锁；文末「跨 Bot 委派」短节
4. `docs/design/18-inline-setup.md` / `19-work-path-and-group-setup.md` — 审批卡 / `ask_question` / 确定性 setup
5. `docs/design/03-bot.md` — Bot 生命周期（管家节）
6. 代码锚点（实现时打开）：
   - `packages/core/src/domain/bots.ts` — `BotsService.create` / delete 占位
   - `packages/core/src/domain/lifecycle.ts` — 删 Bot
   - `packages/core/src/dispatch/chains.ts` — D4 深度/预算
   - `packages/core/src/dispatch/orchestrator.ts` — `#injectDelegateFollowUp` / `deliverEventToBot` / `#settleRun`（settle 钩子挂点）
   - `packages/core/src/agent/subagent.ts` + `packages/core/src/tools/delegate-tools.ts` — D66 工具（勿改语义冒充跨 Bot）
   - `packages/core/src/tools/setup-tools.ts` — `ask_question`
   - `packages/core/src/permissions/approvals.ts` — 无人值守自动批准 `#autoDecideSync`（P2 需按 kind 排除 butler 卡）
   - `packages/shared/src/constants.ts` — `BOT_CHAIN_*` / `SUBAGENT_FOLLOWUP_EVENT` / `SETUP_MAX_QUESTIONS`
   - `packages/shared/src/domain/types.ts` — `botSchema` / `messageSchema` / `triggerReasonSchema` / `textContentSchema`（`setupAnswer` 前例）/ `approvalKindSchema` / `cardContentSchema`
   - `apps/desktop/.../onboarding/OnboardingWizard.svelte` — step `bot` 模板
   - `packages/core/migrations/main/` — 下一号约 `0016_*.sql`；runs 侧若需列则 `0005_*.sql`（`trigger_reason` 无 CHECK 约束，枚举增值免迁移）

## 1. 背景与目标

1. **D70 Butler**：唯一管家联系人（置顶、不可删）；访谈后用审批卡提议 3–5 个领域 Bot，用户确认后**确定性**批量 `bots.create`；提供路由与组队工具。
2. **D71 A→B**：A 调用 `delegate_to_bot` → B 私聊收到「用户代发 + 由 A 代你发出」→ UI 留在 A → B 终回复截断贴回 A + `notify_me` follow-up；防环；同群降级 D4。

**复用**：D66 follow-up / `deliverEventToBot`；D4 深度预算思路；`ask_question` / 审批卡范式；`bots.create`。

**不做（整篇）**：

- 用 `delegate_task` / SubAgent 冒充另一个 Bot
- 多跳自由委派图（默认单跳）
- 同步 B 中途 chatter 到 A
- 多个管家 / 删除管家
- 改 D4 群 `@` 协议本身
- git commit / push / PR

## 2. 实施顺序

```
P1 地基（schema + 管家身份约束）
 → P2 管家入职与组队（审批卡 + 批量创建 + list/propose 工具）
 → P3 A→B 委派主路径（delegations + 消息/卡片 + 防环）
 → P4 路由卡收尾 + 开放决策默认值 + 回归/e2e
```

---

## 3. P1 — 地基

### 3.1 改动清单

- [ ] **shared**：`botSchema` 增 `systemRole: z.enum(['butler']).nullable().optional()`（或等价）；与 Profile `role` 字段名错开文档已强调用 `system_role` 列
- [ ] **shared constants**：`DELEGATION_MAX_DEPTH`（普通 1）+ `DELEGATION_MAX_DEPTH_BUTLER`（管家放宽至 2，按发起者角色取用）、`DELEGATION_RESULT_MAX_CHARS`（2000）、`DELEGATION_FOLLOWUP_EVENT`（如 `delegation_result`——勿与 D66 的 `delegate_result` 混淆）、`BUTLER_TEAM_SIZE_MIN/MAX`（3/5）
- [ ] **main 迁移** `0016_butler_and_delegation.sql`（号以目录实况为准）：
  - `bots.system_role TEXT NULL` + partial unique index：至多一个 active butler
  - `delegations` 表：`id, from_bot_id, to_bot_id, from_conversation_id, to_conversation_id, task_text, status, depth, parent_delegation_id, to_message_id, run_id, result_excerpt, result_message_id, error_text, created_at, updated_at`（`to_message_id`=B 侧代发消息（「查看原文」链）、`run_id`=B 侧响应 run（settle 钩子与取消靠它）；列名可微调，状态枚举与设计一致）
- [ ] **core `BotsService`**：`createButlerIfMissing()` / `getButler()`；`create(..., { systemRole: 'butler' })`；拒绝第二个 butler
- [ ] **lifecycle**：`deleteBot` 若目标为 butler → `AppError` 拒绝
- [ ] **desktop**：侧栏置顶管家；删除菜单对管家隐藏或弹「不可删除」
- [ ] **测试**：唯一约束、删管家失败、迁移可逆/可应用

### 3.2 验收

1. 空库调用 ensure → 恰好一个 butler；再 create butler 失败。
2. UI/RPC 删除管家被拒；普通 Bot 删除仍按 D18。
3. `pnpm --filter @kepcup/core test` 相关单测绿；typecheck 过。

### 3.3 本阶段不做

- 组队卡、委派工具、路由卡、改 onboarding 文案以外的流程。

---

## 4. P2 — 管家入职与组队

### 4.1 行为

1. Onboarding 完成或首次需要时：`ensureButler` + 打开/创建管家私聊。
2. 管家访谈（可复用 setup 工具子集或专用 prompt）：收集用户领域 → 调用 `propose_team`。
3. **审批卡**展示 3–5 个建议 Bot（名/职责/理由）；用户可去掉某项或全盘确认。
4. 确认后 core **确定性**循环 `bots.create`（不经模型再发明名字）；可选短访谈 `interview:false` 先落地再让用户日后完善。
5. 工具：`list_bots`、`propose_bot`、`propose_group`（单卡）、`propose_team`（批量卡）——仅 butler 的工具面注册。

### 4.2 改动清单

- [ ] **审批 kind**：shared 增 `butler_propose_team` / `butler_propose_bot` / `butler_propose_group`（payload schema + describe + ApprovalCard 分支）；**无人值守不自动批**——当前 `permissions/approvals.ts` 的 `#autoDecideSync` 对所有 kind 一律自动批准（仅数据目录例外），需新增按 kind 排除：`butler_*` 卡照常挂起等用户确认（对齐设计 §4 决策 4「仅审批卡确认后确定性创建」，防止无人值守刷出一堆联系人）
- [ ] **core tools**：`packages/core/src/tools/butler-tools.ts`（新）+ `tools/index.ts` 仅当 `bot.systemRole==='butler'` 注册
- [ ] **orchestrator / gateway**：审批通过回调里调 `bots.create` / `groups.create`（或 `groups.setup` 字段对齐 D60）
- [ ] **system prompt**：管家专用 `<butler_rules>`（组队只经卡、先路由后执行等）
- [ ] **onboarding**：`OnboardingWizard` step `bot` 演进为「创建管家」或「创建管家并进入组队」；保留侧栏「新建 Bot」给快速单 Bot
- [ ] **i18n**：`zh-CN` 管家/组队卡文案
- [ ] **测试**：集成——propose_team 未确认零 Bot；确认后 N 个 Bot；非管家调用 propose_* 不可用

### 4.3 验收

1. 新用户路径结束通讯录：1 管家 + 确认后的领域 Bot。
2. 未点确认，`bots` 表无新领域 Bot。
3. 普通 Bot 的 tools 列表无 `propose_team`。

### 4.4 本阶段不做

- `delegate_to_bot` 主路径（P3）；路由卡完整产品（P4 可先 stub `suggest_route`）。

---

## 5. P3 — A→B 委派主路径

### 5.1 行为契约（实现必须对齐）

| 步骤 | 行为 |
|---|---|
| A 调 `delegate_to_bot` | 写 `delegations`=`submitted`；A 对话插「已委托」卡/消息；解析/创建 B 私聊；插入 **user** 消息，`origin=delegation`（textContentSchema 可选字段，参照 `setupAnswer` 前例落 content_json），UI 标签「由 {A} 代你发出」；`to_message_id` 落行；以 `triggerReason='delegation'` 投递触发 B，`run_id` 回填 |
| B 执行 | 正常响应 loop；中途消息**不**同步到 A |
| B settle | 在 settle 钩子按 `run_id` 匹配委派行：成功 → 取最终回复截断 `DELEGATION_RESULT_MAX_CHARS`，A 贴结果卡 + link（conversationId + `result_message_id`），status=`completed`；失败/中断 → status=`failed` + `error_text`（A 卡展示失败原因，不贴全文）；随后 `deliverEventToBot(A, DELEGATION_FOLLOWUP_EVENT, …)` 含「勿复述」指令 |
| 取消 | `cancel_delegation` 或 A 卡取消 → abort B 活动 run（若有，并清 B 邮箱中未消费的该批次）→ status=`cancelled` |
| 防环 | depth 超限拒绝；`to_bot_id == from_bot_id` 拒绝；**被委派 run**（triggerReason='delegation'）构建 toolset 时不注册 `delegate_to_bot`（run 粒度，勿按 bot 粒度全局摘除——否则 B 在自己其他对话里也无法委派），深度校验兜底 |
| 同群 | 若当前 conversation 为群且成员含 A、B → 工具错误/指引改 `@`，不写委派 |

### 5.2 改动清单

- [ ] **shared**：delegation 类型 / status 枚举；`triggerReasonSchema` 增 `'delegation'`（runs 表无 CHECK，免迁移）；`textContentSchema` 增可选 `origin` / `delegationId`（B 侧代发标记，参照 `setupAnswer` 前例）；`cardContentSchema` 增 `delegationId`（发出/结果卡用）；RPC 如需 `delegations.get/cancel`
- [ ] **core**：`packages/core/src/domain/delegations.ts`（新）；`tools/delegation-tools.ts`（`delegate_to_bot` / `cancel_delegation`）
- [ ] **orchestrator**：委派投递、完成钩子（`#settleRun` 按 `delegations.run_id` 反查——与 D66 per-run `onFollowUp` 回调挂法不同，委派是 settle 时匹配）、`#injectDelegationFollowUp`（可仿 `#injectDelegateFollowUp`）；启动恢复把 `working` 且 run 已 `interrupted` 的委派落 `failed`（对齐 D49 ephemeral、开放决策 7）
- [ ] **desktop**：DelegationSentCard / DelegationResultCard；B 侧消息气泡标签；**不**自动 `openConversation(B)`
- [ ] **constants / prompt**：平台规则说明何时委派 vs `@` vs `delegate_task`
- [ ] **测试**：
  - 单测：截断、防环、同群降级、单跳（被委派 run 的 toolset 无 `delegate_to_bot`）
  - 集成：A→B 全链路（A 消息流有卡、B 有代发用户消息、A UI 会话未切换、follow-up internal、D66 回归）；B run 失败 → A 卡 `failed` + `error_text`

### 5.3 验收

1. A 委派后当前会话仍是 A；B 私聊可见带标签代发消息。
2. B 回复后 A 结果卡 ≤2000 字 + 可点链；A 模型侧收到 internal 事件。
3. A→B→A、超深、同群路径符合设计。
4. B run 失败/中断 → A 卡转 `failed`；重启后 `working` 且 run 已中断的委派落 `failed`（启动恢复）。
5. 现有 `delegate_task` 集成测试仍绿。

### 5.4 本阶段不做

- quiet hours 精致调度（P3 不做；P4 按开放默认落地——参照 `deliverEventToBot` 的 parking / `event_delivery` job 模式，注意 user 代发路径当前没有 quiet hours 闸门，需新建）
- durable 专升（委派行持久即可）
- workspace 自动继承（默认不继承）

---

## 6. P4 — 路由与收尾

### 6.1 改动清单

- [ ] `suggest_route` + **路由卡** UI（去管家 / 去某 Bot / 建群 / 委派）
- [ ] 管家 prompt：未知→管家；早期**先卡后办**；用户「你安排」再 `delegate_to_bot`
- [ ] 落地开放决策默认值（见设计 §4）：quiet hours 提示、不继承 project、组队必确认、中途不同步、崩溃按 status 重绘卡
- [ ] Butler 入群策略按开放默认（允许加入；群内委派仍降级 D4）
- [ ] e2e：onboarding→管家→组队确认；A 委派 B 主路径快照/断言
- [ ] 文档：若实现偏离，回写 `27` 与 `docs/dev/PROGRESS.md`（仍不 commit，除非用户要求）

### 6.2 验收

1. 路由卡可一键跳转；「你安排」后出现委派卡而非默默执行（产品早期）。
2. 全量 `pnpm typecheck` + `pnpm test`；相关 e2e 绿。
3. D4 / D66 / 访谈 / 群创建回归无回归。

---

## 7. 文件路径速查（预期会碰）

| 区域 | 路径 |
|---|---|
| 设计 | `docs/design/27-butler-and-delegation.md`、`docs/design/README.md`（已含 D70/D71） |
| 迁移 | `packages/core/migrations/main/0016_*.sql`（确认号） |
| shared | `packages/shared/src/domain/types.ts`、`constants.ts`、`rpc/methods.ts`、errors |
| core domain | `domain/bots.ts`、`domain/lifecycle.ts`、`domain/delegations.ts`（新）、`domain/groups.ts` |
| core dispatch | `dispatch/orchestrator.ts`、`dispatch/chains.ts` |
| core permissions | `permissions/approvals.ts`（无人值守按 kind 排除 butler 卡） |
| core tools | `tools/butler-tools.ts`、`tools/delegation-tools.ts`、`tools/index.ts`、`tools/setup-tools.ts` |
| prompt | `agent/context/system-prompt.ts` |
| desktop | `features/onboarding/OnboardingWizard.svelte`、sidebar、chat cards、i18n `zh-CN.ts` |
| 测试 | `packages/core/test/unit/`、`test/integration/`；`apps/desktop/test/e2e/` |

## 8. 风险与注意

- **命名冲突**：DB/API 用 `system_role`；Profile JSON 里已有 `role` 对象——禁止混用。
- **消息 sender**：B 侧必须是 `user` 代发，不是 `bot:A`，否则群规则/权限语义错位；标签用独立 origin 字段（textContentSchema，落 content_json）。
- **单跳摘除粒度**：勿按 bot 粒度全局摘掉 B 的 `delegate_to_bot`（会连 B 在自己对话里的委派能力一起摘掉）；按 run 粒度（triggerReason='delegation'）+ 深度校验兜底。
- **结果混杂**：B 的被委派 run 可能被用户在 B 私聊的后续消息 steer，最终回复可能混入对用户说的话——首期接受，靠截断 + 「查看原文」链接缓解，结果卡标注来源。
- **Follow-up**：必须 `internal: true`，进 A 上下文、不刷用户可见复述指令原文（对齐 D66 `#injectDelegateFollowUp`）。
- **租约**：B 写 project 仍走 B 对话绑定与 D29 租约；不要静默共用 A 的 project（开放决策默认）。
- **无人值守**：组队/建 Bot 审批排除自动批准（`#autoDecideSync` 按 kind 排除，需新增该机制），避免管家刷出一堆联系人。

## 9. 完成定义（整包）

- [ ] P1–P4 清单勾完，验收口径满足
- [ ] 设计文档与实现无未记录的硬偏离（有则改 27）
- [ ] **未**执行 git commit / push / 创建 PR

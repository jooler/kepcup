# Bot 资产移交：实施方案

> 状态：**已定稿，待实施**（2026-10-12；用户拍板：①记忆、Wiki 一律复制；②普通 Bot 交出自己资产按开发节奏排期，但属本功能必做范围，P0–P2 全部要落地）。
> 设计：[docs/design/37-bot-asset-handover.md](../docs/design/37-bot-asset-handover.md)，决策 **D88**。
> 分支 / worktree：`t/handover` @ `/home/jyy/wt/kepcup-handover`（从 main 拉）。主工作树由多个会话共用，**不在主树里改代码**；D87 在 `/home/jyy/wt/kepcup-widget-craft` 并行进行，不碰它。
> 迁移号：写迁移时取 main 的下一个空号。当前 main 最大为 0034，D87 暂记 0035（未合入）——本方案先记 **0036（暂定）**，合入时以 main 实况重排，并同步 `create-core.test.ts` 的 `user_version` 与 public-skills-migration 测试里的版本号。
> **测试纪律**：迭代只跑定向测试，在 `kepcup-test:trixie` 容器里执行 `node scripts/run-tests.mjs run <文件>`；**容器里不要跑 `pnpm test` / `pnpm install`**。typecheck / lint 在宿主机跑（`export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH`）。每期收口时全量跑一次（改了 shared 契约与迁移）；全量基线 28–33 个环境失败（es-git / 沙箱自检 / wiki URL），只看新增失败。
> **合入 main / 推送都要先经用户确认。**

## 1. 目标

修复触发事件：管家把自己负责的邮箱交给新建的 Bot 时，负责人要正确转移。进而建立通用的移交能力：用户在对话里下指令，AI 盘点资产、出一张移交卡，用户确认一次，宿主执行。用户不需要去设置页逐项操作。

## 2. 现状要点（2026-10-12，以代码为准）

- `tools/butler-tools.ts`：`propose_bot` / `propose_team` 只有人设字段与 `routines`；`dispatch/butler.ts #createBots` 只写 identity / role / 例行事项。
- 邮箱绑定只能经 UI RPC 改（`rpc/mail-bindings.ts` `mail.accounts.setBots` / `mail.bots.setAccounts` → `MailService.setBots` / `setAccountsForBot`）。`runAlertJob`（`mail/service.ts` ~L485）遇到绑定已不存在的作业会静默丢弃。
- 所有写工具都以 `identity.botId` 为准，没有任何跨 Bot 写入口。
- 审批：`permissions/approvals.ts` 的 `NEVER_AUTO_DECIDED`（L131）、`SURVIVES_RUN`（L138）、`butler_proposal` 的 selection 校验（~L477/489/880/1011）是新 kind 要对照的地方；kind CHECK 最近一次在 `0031_mail.sql` 重建。
- 工具注册：`tools/index.ts` ~L1003（管家工具块）。提示词：`agent/context/system-prompt.ts` `BUTLER_RULES` / `BUTLER_TASK_RULES`。
- 渲染端：审批卡在 `features/approvals/ApprovalCard.svelte`；`stores/permissions.svelte.ts` 有 `butler_proposal` 分支。e2e 参照 `apps/desktop/test/e2e/butler-proposal.spec.ts`；集成测试参照 `packages/core/test/integration/butler*.test.ts`。
- 各资产存储与可改入口见设计 §1 表。

## 3. P0：管家发起；模型 / 连接应用 / MCP / 邮箱 / 定时任务 / 职责 / 交接说明

### 3.1 契约（packages/shared）

- [x] `approvalKindSchema` 增 `bot_handover`。
- [x] `botHandoverPayloadSchema`：`{ fromBotId, target: {kind:'existing', botId} | {kind:'new', bot: ButlerProposedBot & {model?}}, items: [{key, assetType, action, label, detail, warnings[]}], responsibilities?: {to?, from?, toBefore?, fromBefore?}, handoverNote, note, handoverId }`。卡片渲染所需的展示字段在提交时由 core 生成并快照进 payload（渲染端不再查询）。
- [x] `approvalDecisionSchema` 增 `handoverSelection?: string[]`（RPC `approvals.decide` 入参同步）；职责改写用保留 key `resp:to` / `resp:from`。
- [x] `butlerProposedBotSchema` 增可选 `model`（`'inherit'` 不适用于 propose_bot；取值 `'' | ref`）。
- [x] 事件 `handover.updated`（卡片进度）；系统事件常量 `BOT_HANDOVER_EVENT`（B 侧交接说明）/ `BOT_HANDED_OVER_EVENT`（A 侧已移交）及其 content 形态（参照 `ROUTE_SUGGESTION_EVENT`）。
- [x] 常量：`HANDOVER_ITEMS_MAX`（100）、`HANDOVER_NOTE_MAX_CHARS`（2000）、`HANDOVER_MEMORY_MAX_ITEMS`（200，P1 用）。

### 3.2 迁移（main 0036 暂定）

- [x] `bot_handovers`、`bot_handover_items`（字段见设计 §5.1）。
- [x] 重建 `approvals`，CHECK 增 `bot_handover`（照 0031 的写法）。
- [x] 同步 `create-core.test.ts` 的 `user_version` 等版本断言。

### 3.3 core：框架

- [x] `packages/core/src/handover/`：`types.ts`（`HandoverAdapter` 接口、`HandoverEntry`、`HandoverContext`、`HandoverItemResult`）、`registry.ts`（按 stage 排序）、`store.ts`（两表读写）。
- [x] `dispatch/handover.ts` `HandoverHost`：
  - `inspect(identity, botId, query)` → 汇总各适配器盘点 + 可用模型列表（与 Bot 详情模型下拉**同源**，不另写一份枚举）。
  - `propose(identity, input)`：发起权校验（P0：仅管家，来源任意）、目标校验（active、非访谈、`from≠to`；新建目标仅管家）、逐项 `validate`、同对话已有待定 `bot_handover` / `butler_proposal` 时拒绝；落 `bot_handovers`（`proposed`）→ `submitNonBlocking('bot_handover', …)`。
  - `#onDecided`：拒绝 → `denied` + follow-up；取消 → `cancelled`；批准 → 按 `handoverSelection` 过滤 → `applying` → §5.3 顺序执行 → 结算 → 卡片 `approvals.fail`（部分失败时）→ follow-up。
  - `recover()`：启动时继续 `applying` 的 handover（接在 jobs / approvals 恢复之后）。
- [x] 新建目标复用 `ButlerHost` 的建 Bot 逻辑：把 `#createBots` 里单个 Bot 的创建（头像、开私聊、例行事项、**模型**）抽成可复用函数，`ButlerHost` 与 `HandoverHost` 共用；`propose_bot` / `propose_team` 的 `model` 同时生效。
- [x] `approvals.ts`：`NEVER_AUTO_DECIDED`、`SURVIVES_RUN` 加 `bot_handover`；selection 校验与 `describe` / `renderContextLine` 分支；`cancelAllPending` 时 handover 落 `cancelled`。
- [x] `start.ts` / 服务装配：构造 `HandoverHost`，注入 bots / mail / schedule / conversations / messages / approvals / settings / logger / publish / deliverEvent。

### 3.4 core：P0 适配器

- [x] `model`：仅在新建目标或提议中显式出现 `model:` 项时执行；校验 ref 在可用列表里；`bots.update` 写 `runtime.model`（`inherit` = 取 A 当下的 `runtime.model` 原值，可能为空 = 跟随默认）。
- [x] `app`：盘点 A 的 `app_connection_ids`；share / move；同 Connector 冲突校验复用 `bots.ts` 的现有规则；move 时从 A 移除并照 `bindings.ts` ~L658 的方式中断 A 用到它的任务。不复制 `app_tool_grants`。
- [x] `mcp`：盘点 A 的 `mcp_server_ids`（过滤全局已不存在 / 停用的）；share / move。
- [x] `mail`：盘点 `accountsForBot(A)`；move（默认）/ share。在 `MailService` 增 `addBinding(accountId, botId)` / `removeBinding(accountId, botId)`（单条增删，保留其他绑定的唤醒状态；`publishAccount`），以及 `retargetPendingAlerts(accountId, fromBotId, toBotId)`：把 A 名下未执行的 `mail_alert` 作业按新去重键 `mail:{acc}:{uid}:{B}` 改投 B。顺序：add B → retarget → remove A。
- [x] `schedule`：盘点 A 所有 active 的定时任务；`commitment_id` 非空的置灰「随承诺，P1 支持」。A 私聊里的 → `createOnce` / `createCron` 到 B 私聊；群里的 → B 是成员则建到同群，否则置灰。保留 title / note / kind / cron / run_at / timezone / origin。新任务出回执卡；A 侧 `cancel`，回执卡快照增加 `handedOverTo: {botId, name}`，渲染端显示「已移交给 {B}」。
- [x] `responsibilities`：`resp:to` / `resp:from` 两项；A 为管家时不出 `resp:from`；写入走 `bots.update`（与 `profile_change` 同一写入路径）。
- [x] 交接说明：B 私聊写 `BOT_HANDOVER_EVENT` 系统事件（接手清单 + 交接要点），A 私聊写 `BOT_HANDED_OVER_EVENT`；两者 `renderContextLine`（交接要点包 `untrustedBlock`）；`message.created` + `conversation.updated` 推送。

### 3.5 core：工具与提示词

- [x] `tools/handover-tools.ts`：`inspect_bot_assets`、`propose_handover`（参数见设计 §4）；`propose_handover` 提交成功返回 `terminate: true`。对话轮注册：P0 仅管家（`tools/index.ts` 管家块）；任务不注册。
- [x] `propose_bot` / `propose_team` 的 `model` 参数（说明：先用 `inspect_bot_assets` 看可用模型；不填 = 跟随默认）。
- [x] `BUTLER_RULES`：委派与移交的区分；「新建并接手」用一张 `propose_handover`；先盘点再提议；未收到结果前不得声称已移交。`BUTLER_TASK_RULES`：任务里没有移交工具，把建议写进任务结果。
- [x] `delegate_to_bot` 说明加一句「委派不改变归属；交出邮箱 / 应用 / 定时任务用 `propose_handover`（管家）」。
- [x] `<mail_accounts>` 段不变（绑定改了自然就变）；确认 A 的上下文缓存不会滞留旧绑定。

### 3.6 渲染端

- [x] `features/handover/HandoverCard.svelte`：头部 A → B / 新建 B（折叠显示新 Bot 字段与模型）；按资产分组的可勾选条目（动作标签、说明、置灰原因）；职责改写前后对照；交接要点；确认 / 拒绝；执行中逐项进度（订阅 `handover.updated`）；结果态。`ApprovalCard.svelte` 按 kind 分流到它；`stores/permissions.svelte.ts` 增 `bot_handover` 分支与 `decide` 的 `handoverSelection`。
- [x] 系统事件渲染：B 侧交接说明卡、A 侧已移交提示；定时任务回执卡「已移交给 {B}」状态。
- [x] i18n（zh-CN 及其余 locale 的键）。

### 3.7 测试

- [x] shared 单测：payload / decision schema。
- [x] core 单测：每个适配器（盘点、校验、apply 幂等、重复 apply 不重复建）；`retargetPendingAlerts`。
- [x] core 集成 `test/integration/handover.test.ts`：
  - 触发事件：管家绑邮箱 M → `propose_handover` 新建目标 → 批准 → 新 Bot 存在、M 只绑新 Bot、两侧系统事件、管家收到 follow-up；新信只给新 Bot 入队 `mail_alert`。
  - 已有目标：连接应用 share（A 保留）、定时任务 move（B 私聊重建 + 回执卡、A 侧取消并标已移交）、群定时 B 非成员置灰。
  - 勾选过滤、拒绝、无人值守不自动批、编造 key 拒绝、非管家调用被拒、同对话叠加被拒。
  - 崩溃恢复：执行到一半中断 → `recover()` 继续，已完成项不重复。
- [x] 提示词快照 / 工具注册测试更新（管家有、普通 Bot 无、任务无）。
- [x] e2e `apps/desktop/test/e2e/handover.spec.ts`：移交卡渲染、勾掉一项、确认后进度与结果态（参照 `butler-proposal.spec.ts` 的桩法）。
- [ ] 收口：全量一次 + e2e 一次（已跑，见 §6）；独立 code-reviewer 审查（opus），修复后再合（待调度会话安排）。

### 3.8 文档

- [x] `docs/design/27-butler-and-delegation.md` §2.3 工具表补 `inspect_bot_assets` / `propose_handover`（指向 37）。
- [x] `docs/dev/03-data-model.md` 补两张表与 approvals kind；`docs/dev/04-agent-runtime.md` 补工具面。
- [x] 设计 37 状态行与本文件 §6 实施记录。

## 4. P1：普通 Bot 发起；监看 / Skill / 记忆

- [ ] 发起权：普通 Bot 注册 `inspect_bot_assets`（只能查自己）与 `propose_handover`（`from_bot_id` 必须是自己、目标必须是已有 Bot）；平台规则加一句。
- [ ] `watch` 适配器：规则同定时任务；保留 `last_hash` / `last_quiet_hash`，不重新告警。
- [ ] `skill` 适配器：导入的 → B 加 `bot_skills` 行指向同一 `library_id`（`installImported` 的复用路径，跳过 `skill_import` 审批，卡上标「外部导入」）；自写的 → 复制目录 + git 初始提交「从 {A} 复制」+ authored 行；同名置灰；停用状态照搬。
- [ ] `memory` 适配器：`inspect_bot_assets` 的 `memory_query`；过滤 `private_to_bot` / `self_note` / 非 active；敏感默认不勾；写入 B（新 id，`evidence_json` 改为 `{handoverId, fromBotId, fromItemId}`，memory schema 增此证据形态；`origin_conversation_id` 置空）→ `embedItem`。
- [ ] 承诺：commitment 定时任务解除置灰；B 得到承诺副本并接上重建的定时任务，A 的承诺置 `void`（不进 `<my_state>`）。
- [ ] 测试：普通 Bot 只能交自己的；`private_to_bot` 永不出现；记忆副本可被 B 检索到；承诺迁移后 A 不再提醒。

## 5. P2：Wiki / 组件 / 退役

- [ ] `wiki` 适配器 + `handover_copy` 作业：页 + 引用的 `raw/` + `wiki-store` 资产 + 清单；持 B 的维护锁；git 提交；`reconcileFts`；给 B 排一次 lint；同路径跳过。卡片在作业完成前保持「进行中」。
- [ ] `widget` 适配器：`scope='bot'` 组件连同版本 / 文档 / 查询模板复制；已确认版本保持确认。
- [ ] 退役：全部资产都已移交 / 复制完成的结果卡上给出「删除 {A}」按钮（走既有 D18 删除确认，A 为管家时不出现）。
- [ ] `lifecycle.deletionPreview` 改由适配器 `inventory` 汇总（可选，不改 RPC 契约）。
- [ ] 测试与 e2e 同前。

## 6. 实施记录

（执行中按期追加：完成项、偏差 DEV-xxx（需用户确认的写明推荐）、测试结果、迁移号变化。）

### P0（2026-10-12，`t/handover`，未合入 / 未推送）

**完成项**（§3 全部，独立审查待安排）：

- 契约（shared）：`approvalKindSchema` 增 `bot_handover`；新文件 `domain/handover.ts`（`botHandoverPayloadSchema`、资产类型 / 动作、`selectableHandoverKeys`、`HandoverView` / 状态枚举、保留 key `resp:to` / `resp:from`）；`approvalDecisionSchema` 与 `approvals.decide` 入参增 `handoverSelection`；`butlerProposedBotSchema.model`（`''` = 跟随默认）；事件 `handover.updated`；RPC `handovers.get`；系统事件 `bot_handover` / `bot_handed_over`（content `handover`）与 follow-up `bot_handover_result`；回执卡快照 `schedule.handedOverTo`；常量 `HANDOVER_ITEMS_MAX` / `HANDOVER_NOTE_MAX_CHARS` / `HANDOVER_MEMORY_MAX_ITEMS`；ID 前缀 `hnd_`；`chatModelOptions(providers)`（Bot 详情模型下拉改用它，与移交可用模型同源）；能力包 `collaboration.butlerTools` 增两工具。
- 迁移 `0035_bot_handover.sql`（见 DEV-001）：两表 + approvals 重建；`create-core.test` 的 `user_version` = 35，`public-skills-migration` 回放测试摘除两表。
- core 框架：`handover/{types,registry,store}.ts`、`handover/adapters/{model,app,mcp,mail,schedule,common}.ts`；`dispatch/handover.ts` `HandoverHost`（inspect / propose / 决定回调 / 按 stage 执行 / 结算 / follow-up / `recover()` / `view()`）；`dispatch/bot-creation.ts` 抽出单个 Bot 的创建（头像、开私聊、例行事项、模型），`ButlerHost` 与 `HandoverHost` 共用，`propose_bot` / `propose_team` 的 `model` 生效（`ButlerHost.validateModelRef`）。`start.ts` 装配（lazy facade 给 orchestrator；启动恢复接在 `orchestrator.recoverInterrupted()` 之后）。
- approvals：`NEVER_AUTO_DECIDED` / `SURVIVES_RUN` 加 `bot_handover`；`decide()` 校验 `handoverSelection`（只能是卡上可勾选的 key；一项不留且不新建 = 拒绝）；`describe` / `renderContextLine` 分支；`ButlerHost.propose` 与 `HandoverHost.propose` 互相拦叠加。
- 服务：`MailService.addBinding` / `removeBinding` / `retargetPendingAlerts`（`MailStore.addBinding` / `removeBinding`，`JobsService.pendingByDedupePrefix` / `cancelPending`）；`ScheduleService.transferTo`（一个事务：重建 + 取消 + 原卡标记）/ `transferredTo` / `listActiveForBot`。
- 工具与提示词：`tools/handover-tools.ts`（`inspect_bot_assets` / `propose_handover`，对话轮、仅管家）；`BUTLER_RULES` 增委派 ≠ 移交、「新建并接手」一张卡、先盘点、收到结果前不声称；`BUTLER_TASK_RULES` 同步；`delegate_to_bot` 说明加一句；effect 分类 `inspect_bot_assets: none` / `propose_handover: local`；上下文渲染交接记录（条目与交接要点包 `<untrusted>`）。
- 渲染端：`features/handover/HandoverCard.svelte`（`ApprovalCard` 按 kind 分流）、`HandoverNoteCard.svelte`、`stores/handovers.svelte.ts`、`permissions.decide` 带 `handoverSelection`、`ScheduleReceipt` 显示「已移交给 {B}」、zh-CN 文案（仓库只有这一个 locale）。
- 文档：设计 27 §2.3 工具表、设计 37 状态行、`docs/dev/03-data-model.md`（两表、approvals kind、删除级联、回执卡标记）、`04-agent-runtime.md` 工具目录、`01-conventions.md` ID 前缀。

**测试**：

- 新增：`packages/shared/test/unit/handover.test.ts`（8）、`packages/core/test/unit/handover-adapters.test.ts`（10）、`packages/core/test/integration/handover-services.test.ts`（3：单条绑定、`retargetPendingAlerts`、`transferTo`）、`packages/core/test/integration/handover.test.ts`（8：**验收锚点 1 触发事件**；锚点 2 已有目标的连接共享 + 定时任务重建 / 原卡标记 + 群任务置灰 + 职责改写；锚点 3 勾选 / 拒绝 / 一项不留；锚点 4 无人值守；锚点 5 崩溃恢复不重复；锚点 6 编造 key；叠加拦截；普通 Bot / 任务无工具与任务版提示词；重启取消；`propose_bot` 指定模型）、e2e `apps/desktop/test/e2e/handover.spec.ts`（1：dock 移交卡、勾掉一项、确认、进度卡完成 / 未勾选、两侧私聊结果）。
- 改动的既有测试：`create-core`（版本 35 + 两表）、`public-skills-migration`（回放摘表）、`tool-effects`（扫描文件表加 `handover-tools.ts`）、`model-selection-single-source`（允许名单加 `handover/adapters/model.ts`，见 DEV-008）。
- 定向回归（Docker `kepcup-test:trixie`）：上述新增 + butler-team / butler / butler-route / context-assembly / external-agent-p2 / external-agent-engine / tool-effects / create-core / mail / mail-service-fixes / schedule / approvals / app-approvals / turn-tools-review-fixes / shared agent-catalog / connected-apps / message-content / ids，全绿。
- 全量（Docker，2026-10-12）：4062 例，首轮 28 失败，其中 2 条是本分支引入（`public-skills-migration` 回放未摘新表、`model-selection-single-source` 新调用点）——已修复并单跑通过；其余 26 条全部在基线文件内（sandbox-isolation 10、skills-authoring 4、skills 3、workspace-tools 3、toolchain-sandbox 2、wiki-url 2、projects 1、environment 1；`environment`「checksum mismatch」在 main@064cbdd 的临时 worktree 上同样失败，已核实）。
- 全量复跑（修复后，提交 `5a71588`，容器 `kh-full2`）：4062 例，**26 失败，全部为上述基线文件**，无新增失败。
- e2e 全量（`kepcup-test:trixie-xvfb`，92 例）：首轮 7 失败；复跑（`kh-e2e-full2`）**86 通过 / 6 失败**，`handover.spec` 通过。失败：`wiki.spec`「wiki tab: browse …」（已知基线）、`debug-dev-pin.spec`、`external-agents.spec` 三条（settings catalog / agent_tool approval card / in-chat agent setup card）、`local-connectors.spec`——后五条不在文档记录的 3 条基线里，已在 main@064cbdd 的临时 worktree 上单跑这三个 spec，**同样 5 条失败**（环境原因：dev-mode pin 的 app-shell 不出现、对话框遮罩挡点击等），与本分支无关，建议更新 e2e 基线记录。首轮另有 `sandbox.spec`「run status line …」失败（已知基线，复跑通过）。

**偏差（需用户确认）**：

- **DEV-001 迁移号**：迁移运行器要求编号连续（`runMigrations` 遇到空号直接 `MIGRATION_FAILED`），不能跳过 D87 暂占的 0035 用 0036，所以本分支用 **0035**（`0035_bot_handover.sql`）。与 D87 的 0035 冲突：后合入的一方改号，并同步 `create-core.test` 的 `user_version`、`public-skills-migration` 的摘表注释与 `docs/dev/03-data-model.md` 迁移表。**推荐**：D87 先合则本分支改 0036；本分支先合则 D87 改 0036。
- **DEV-002 模型取值**（审查后修订）：设计 §1 把模型资产写作 `runtime.{model, light_model, agent}`。`inherit`（新建目标默认值，或已有目标的 `model:inherit` 条目）复制主模型、轻量模型与**驱动引擎**（外部智能体的 `id` / `model` / `effort`）；**权限档与能力包不复制**——沿用 B 自己的，B 原先是内置引擎或是新建的则取该 Agent 的目录默认权限档（预览档 ask）、能力包跟随默认。换成另一个外部智能体时与 `bots.update` 同一校验（实验开关、在目录中，`assertAgentSelectable`）：已有目标不满足则该条不可执行；新建目标在确认时退回内置引擎并在结果里说明，卡上的模型说明预先提示。`default`（设置里的默认主模型）与指定 ref 都把 B 切回内置引擎（外部智能体不认这些 ref），卡上提示「目前由 X 驱动，之后改由 Y 驱动」。已有目标改模型的条目 key 直接编码取值：`model:inherit` / `model:default` / `model:<ref>`（盘点只列 `model:inherit`，另两种经适配器 `resolve` 认）。新建目标的模型只能写在 `new_bot.model`，`model:*` 条目被退回；来源的模型与 Agent 都为空时新 Bot 不套用 onboarding 的默认外部 Agent（`bots.create` 新增 `skipDefaultAgent`），与来源一样跟随设置默认。**推荐**：照此。
- **DEV-003 结算口径**：设计只说「有 failed → partial」。实现把执行时重新校验不成立的 `skipped` 也算未完成：全部 done → `completed`；一项都没做成（新建目标也算一项）→ `failed`；其余 → `partial`。非 completed 时卡片 `approvals.fail` 并列出原因。**推荐**：照此（否则「全部跳过」会显示为已完成）。
- **DEV-004 置灰 vs 退回**：编造的 key、不合法动作、重复 key 直接退回（工具报错）；盘点时就不可执行（全局停用的 MCP、随承诺的定时任务）与对目标冲突（B 已连同一应用另一账号、B 不在群里）的进卡片置灰、不可勾选。已有目标且没有任何可执行条目（含职责改写）时工具退回、不出卡。**推荐**：照此。
- **DEV-005 职责改写的边界**：新建目标时 `responsibilities.to` 被退回（职责写在 `new_bot.responsibilities`）；来源或目标是管家时对应的改写忽略并在工具结果里说明；改写文本与原文相同时不出该项。**推荐**：照此。
- **DEV-006 宿主条目**（审查后修订）：新建目标、职责改写与交接说明作为宿主条目记在 `bot_handover_items`（key `bot:new` / `resp:to` / `resp:from` / `note:handover`，`asset_type` 为 `bot` / `responsibilities` / `note`），因此 `asset_type` 不设 CHECK；卡片进度与恢复都按它走。新 Bot 建行与回填 `to_bot_id` 在同一事务；之后的推送、例行事项与记账失败都不再算「新建失败」（`to_bot_id` 已有 = 建好了）；崩溃后恢复时补建缺的例行事项（按新 Bot 私聊里同标题的 `proposal` 任务判重，不重复建）。结果通知以 `bot_handovers.notified_at` 记账，崩溃在结算与通知之间时启动恢复补发（至少一次）。**推荐**：照此。
- **DEV-007 定时任务的恢复判据**（审查后修订）：`transferTo` 在一个事务里完成重建、取消、原卡标记、接手方的新回执卡与已排队触发作业（`schedule_fire:{旧 id}:*`）的改投；崩溃在事务提交与记账之间时，`transferredTo` 先看原回执卡的 `handedOverTo`，没有回执卡（D80 之前的老任务、offer 卡任务）时退而按字段比对 B 名下在原任务之后建的同字段任务。重建的任务**总是**出新回执卡（含 `origin='offer'`）。原任务没有回执卡时 A 侧只有交接记录，没有「已移交给 {B}」卡。已被 runner 认领（running）的那一次不改投（极窄窗口）。**推荐**：照此。
- **DEV-008 模型字段单一入口守卫**：`model-selection-single-source` 只允许少数文件读写 `runtime.model` / `light_model`。移交要复制 / 改写这些**配置值**（不做选取），读写集中在 `handover/adapters/model.ts`（`inheritedModelRuntime` / `botModelLabel`）并加入允许名单；`bot-creation.ts` 只透传。**推荐**：照此。
- **DEV-009 新增 RPC**：方案没列 `handovers.get`；卡片在重载 / 翻历史时需要读执行进度，所以加了（`handover.updated` 推实时更新）。**推荐**：保留。
- **DEV-010 交接记录的数据边界**：设计 §4.3 只把交接要点包 `<untrusted>`；实现把条目文字也包进去（含邮箱显示名、任务标题等外部 / 模型写的文本）。**推荐**：照此（更保守）。
- **DEV-011 预留参数**：`inspect_bot_assets` 已接受 `memory_query` / `wiki_query` 但 P0 忽略（说明里标「暂不支持」），P1 / P2 接上。

**评审时请重点看**：`dispatch/handover.ts` 的执行 / 恢复 / 结算顺序与幂等（`isApplied` → `validate` → `apply`，move 的 `release` 在阶段 5）；`MailService.retargetPendingAlerts`（只动 pending、按新去重键入队再取消旧作业）；`ScheduleService.transferTo` 事务与 `transferredTo` 的字段比对兜底；`approvals.decide` 的 `handoverSelection` 校验；`propose` 的 key 校验与置灰；渲染端 `HandoverCard` 的勾选 / 进度状态推导。已知未覆盖：移交时 A 正在运行的、用到该邮箱的任务不会被中断（与在设置页解绑一致，§7 风险已接受）；已在跑（claimed）的 `mail_alert` 作业不改投。

**迁移号**：0035（暂定，见 DEV-001）。

### P0 审查修复（2026-10-12，独立 opus 审查 064cbdd..312cc85，无 critical）

| # | 发现 | 修复 | 回归测试 |
|---|---|---|---|
| 1 | 职责改写在执行时不比对原文，会覆盖用户在提议后做的修改 | 执行时比对当前 `role.responsibilities` 与卡上的 `toBefore` / `fromBefore`，不同则该项 `skipped`「职责描述在提议后已被修改」（§5.3 重新校验） | `handover.test`「审查 #1」 |
| 2 | `model:inherit` 复制了 A 的 `agent.permission` / `capabilities`；换 Agent 不校验；引擎变化卡上不说 | 只复制 `agent.{id, model, effort}`，权限档 / 能力包沿用 B（B 原为内置或新建时取目录默认）；`validate` 走与 `bots.update` 相同的 `assertAgentSelectable`；卡片警告「目前由 X 驱动，之后改由 Y 驱动」；`model:default` 也切回内置引擎（「设置默认」指设置里的默认主模型），说明行写明「内置引擎」 | `handover-adapters`（3 例新增 / 改写） |
| 3 | 新建目标「与来源相同」而来源模型与 Agent 都空时，`bots.create` 套用 onboarding 默认外部 Agent，与卡上「跟随设置默认」不符 | `bots.create` 增选项 `skipDefaultAgent`，移交新建目标在继承到「空模型 + 内置」时使用 | `handover-services`「审查 #3」（访谈建的管家 + 默认外部 Agent 已开） |
| 4 | 给发起方的结果通知里条目文字 / 原因（邮箱名、连接账号、任务标题、群名）没有包 `<untrusted>` | 资产条目的名称与原因、例行事项行一律 `<untrusted>`（`neutralizeUntrusted`）；卡片失败原因同样处理（它会进上下文行）；通知末尾加一句数据边界说明 | `handover.test` 触发事件用例断言 |
| 5 | `propose_bot` / `propose_team` 的 `model` 在卡上不显示，确认时不复查 | 管家提议卡每个 Bot 显示「模型：{显示名}」（`chatModelOptions` 同源，不可用的标出）；确认时 ref 已不可用则退回 `''` 并在结果通知里说明 | `handover.test`「审查 #5」 |
| 6 | 新建目标在确认来源 / 已有目标是否还在之前就建了 | 阶段 1 之前先查来源（与已有目标）是否 active；不在则所有条目跳过、整单 `failed`，什么都不建 | `handover.test`「审查 #6」 |
| 7 | A 侧交接记录把共享 / 复制的条目也说成「此后由对方负责」 | 交接记录内容分 `items`（移交与职责改写）与 `kept`（共享 / 复制，A 仍保留；shared 契约新增字段，默认 `[]`）；上下文与渲染端分开写 | `handover.test` 已有目标用例断言 |
| 8 | 定时任务移交时已排队的 `schedule_fire` 作业会因原任务取消而丢掉这一次 | `transferTo` 事务内把 `schedule_fire:{旧 id}:*` 的待执行作业按同一 `fireAt` 改投新任务、取消旧作业；有排队作业时新行不另算下一次 | `handover-services`「审查 #8」 |
| 9a | 新 Bot 行提交后到例行事项之间崩溃，例行事项丢失 | 恢复时 `#finishTarget` 补建，按同标题 `proposal` 任务判重 | `handover.test`「审查 #9a / #9d」 |
| 9b | 建行之后的推送 / 记账抛错被当成「新建失败」 | 只有建行事务失败才算新建失败；之后的推送失败只记日志，结算时 `to_bot_id` 已有则 `bot:new` 记 done | 无专门用例（需注入故障，见下） |
| 9c | `transferTo` 提交后、补回执卡前崩溃，接手方缺回执卡 | 回执卡写入并入 `transferTo` 事务，提交后才推送事件 | `handover-services` transferTo 用例（回执卡断言） |
| 9d | 结算后、通知前崩溃，发起方收不到结果 | 迁移 0035 加 `bot_handovers.notified_at`；通知后记账，`recover()` 补发未记账的（completed / partial / failed / denied） | `handover.test`「审查 #9a / #9d」 |
| 9e | `#begin` 在 `decide()` 内抛错时卡已批准、移交却停在 `proposed` 直到重启 | 捕获后立即把移交置 `failed`、卡片 `approvals.fail`、通知发起方「没能开始执行」 | 无专门用例（需注入故障，见下） |

未加专门回归用例的：9b、9e 需要在 `announceCreatedBot` / 写库处注入异常，现有测试夹具没有对应注入点，为它们改生产代码的接缝不划算；两处改动都是把异常收进 try/catch 并按已有路径结算，已靠 review 与其余用例覆盖的路径验证。

修复后定向回归（Docker）：handover 三个文件 + butler-team / butler / schedule / context-assembly / approvals / model-selection-single-source / external-agent-p4b / bot-app-connections / public-skills-migration / create-core / shared handover / message-content，15 文件 127 例全绿；core / desktop typecheck、eslint 通过。全量与 e2e（审查修复后，提交 `ee86880`）：

- 全量（容器 `kh-full3`）：4070 例，4041 通过 / 27 失败。26 条为既有基线文件（同前）；另 1 条 `connected-apps-runtime`「listing failure at run start」是负载偶发，单跑 13/13 通过，修复前的全量里也是通过的。无新增失败。
- e2e（容器 `kh-e2e-full3`，92 例）：85 通过 / 6 失败 / 1 flaky，`handover.spec` 通过。失败与上一轮完全相同：`wiki.spec`（已知基线）与 `debug-dev-pin`、`external-agents` ×3、`local-connectors`（在 main@064cbdd 上同样失败，已核实）；`sandbox.spec`「run status line」重试后通过（已知基线 flaky）。

审查修复后复验（2026-10-12，协调会话执行，ee86880）：
- **全量**（Docker `kh-full3`）：4041 通过 / 27 失败 / 2 跳过。26 例为环境基线文件（sandbox-isolation 10、skills-authoring 4、skills 3、workspace-tools 3、toolchain-sandbox 2、wiki-url 2、projects 1、environment 1）；另 `web-tools.test.ts`「web_fetch：二进制内容拒绝…」1 例在全量负载下 5 秒超时，单跑 12/12 通过，为偶发。无新增失败。
- **e2e**（`kepcup-test:trixie-xvfb`，`kh-e2e3`）：85 通过 / 7 失败；`handover.spec`、`butler-proposal.spec` 通过。失败：`wiki.spec`、`sandbox.spec` 状态行（已知基线 / 偶发）+ `debug-dev-pin`、`external-agents` ×3、`local-connectors`（在 main@064cbdd 上同样失败，环境问题，e2e 基线记录待更新）。
- **迁移号**：D87 已先合入 main（4184d87）并占用 0035；本分支合入时须改为 **0036**（同步 `create-core.test` 的 `user_version`、public-skills-migration 注释、dev/03 迁移表）。

## 7. 风险

- **用户隔几天才确认**：资产已变化 → 执行前逐项重新校验，不成立的标 `skipped` 并写原因。
- **A 有运行中的任务正在用要移交的东西**：邮箱 / 连接应用撤除后 A 的工具调用失败。P0 接受（与用户在设置页解绑的效果一致），结果通知里提示。
- **记忆复制量大 / 向量模型未就绪**：`embedItem` 失败不阻塞写入，沿用既有的向量重建路径补齐。
- **与 D87 并行**：两边都动 `tools/index.ts`、`approvals.ts`、迁移号；合入第二个的一方负责重排迁移号与解决冲突。

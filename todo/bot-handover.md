# Bot 资产移交：实施方案

> 状态：**已定稿，待实施**（2026-10-12；用户拍板：①记忆、Wiki 一律复制；②普通 Bot 交出自己资产按开发节奏排期，但属本功能必做范围，P0–P2 全部要落地；③DEV-001～011 按建议确认、P0 合入 main；④承诺例外（承诺随定时任务迁移、A 的承诺置 void）确认，P1 实施）。
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

### 3.2 迁移（main 0036）

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

- [x] 发起权：普通 Bot 注册 `inspect_bot_assets`（只能查自己）与 `propose_handover`（`from_bot_id` 必须是自己、目标必须是已有 Bot）；平台规则加一句。
- [x] `watch` 适配器：规则同定时任务；保留 `last_hash` / `last_quiet_hash`，不重新告警。
- [x] `skill` 适配器：导入的 → B 加 `bot_skills` 行指向同一 `library_id`（`installImported` 的复用路径，跳过 `skill_import` 审批，卡上标「外部导入」）；自写的 → 复制目录 + git 初始提交「从 {A} 复制」+ authored 行；同名置灰；停用状态照搬。
- [x] `memory` 适配器：`inspect_bot_assets` 的 `memory_query`；过滤 `private_to_bot` / `self_note` / 非 active；敏感默认不勾；写入 B（新 id，`evidence_json` 改为 `{handoverId, fromBotId, fromItemId}`，memory schema 增此证据形态；`origin_conversation_id` 置空）→ `embedItem`。
- [x] 承诺：commitment 定时任务解除置灰；B 得到承诺副本并接上重建的定时任务，A 的承诺置 `void`（不进 `<my_state>`）。
- [x] 测试：普通 Bot 只能交自己的；`private_to_bot` 永不出现；记忆副本可被 B 检索到；承诺迁移后 A 不再提醒。

## 5. P2：Wiki / 组件 / 退役

- [x] `wiki` 适配器 + `handover_copy` 作业：页 + 引用的 `raw/` + `wiki-store` 资产 + 清单；持 B 的维护锁；git 提交；`reconcileFts`；给 B 排一次 lint；同路径跳过。卡片在作业完成前保持「进行中」。（D85 尚未实施，资产部分按设计 36 §3.1 布局前向兼容，DEV-021）
- [x] `widget` 适配器：`scope='bot'` 组件连同版本 / 文档 / 查询模板复制；已确认版本保持确认（DEV-026）。
- [x] 退役：全部资产都已移交 / 复制完成的结果卡上给出「删除 {A}」按钮（走既有 D18 删除确认，A 为管家时不出现）（DEV-025）。
- [ ] ~~`lifecycle.deletionPreview` 改由适配器 `inventory` 汇总~~（可选项，未采用：见 DEV-024）。
- [x] 测试与 e2e 同前。

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

**迁移号**：开发期 0035（见 DEV-001）；合入 main 时 D87 已占 0035，改为 **0036**（`0036_bot_handover.sql`，`user_version` = 36）。

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
- 另一轮全量复跑（`kh-full3`，协调会话）偶发项换成 `web-tools.test.ts`「web_fetch：二进制内容拒绝…」5 秒超时，单跑 12/12 通过；其余同上，无新增失败。
- **迁移号**：D87 已先合入 main（4184d87）并占用 0035；合入时已改为 **0036**（`create-core.test` 的 `user_version`、public-skills-migration 注释、dev/03 迁移表已同步）。

### P1（2026-10-13，t/handover-p1）

分支 `t/handover-p1` @ `/home/jyy/wt/kepcup-handover-p1`，从 main（67766ee，含 P0）拉出。实现分两次提交（`0fd0420` 功能、`8ccd7c2` 测试，由前一会话写成但未验证），本次复核、修补并跑完测试（`d87fd89` 修复与补测、`4d0c7e7` e2e）。**无新迁移**（记忆证据形态是 JSON 字段的可选键，监看就地改归属，技能复用既有表）。

**完成项**（§4 全部）：

- 发起权：`inspect_bot_assets` / `propose_handover` 对话轮人人注册（任务仍不注册）；能力包 `collaboration` 把两者从 `butlerTools` 移到 `tools`。普通 Bot 的参数面没有 `to.new_bot`、`bot_id` / `from_bot_id` 可省（= 自己）；**宿主** `HandoverHost.inspect` / `propose` 校验：普通 Bot 只能盘点 / 交出自己的、目标只能是已有 Bot（直接调宿主同样被拒，有测试）。`TURN_PLATFORM_RULES` 加一句（注明管家以 `<butler_rules>` 为准）。
- `watch` 适配器（stage 4，只能移交）：`WatchService.transferTo` 同一行就地改 `bot_id` / `conversation_id`（CAS），检查状态（`last_hash` / `last_quiet_hash` / `last_text` / `last_matched` / `alert_seq`）与暂停状态原样保留（两边浏览器资料不同时清空两个哈希，见审查修复 #2）；私聊的改到 B 私聊（同一事务补「已创建」卡），群里的要求 B 是成员；排队中的 `watch_alert` 作业改到 B；B 的监看上限校验；两边浏览器资料不同时卡上提示要重新登录。原对话里的旧卡显示「已移交给 {B}」（上下文行与渲染端）。
- `skill` 适配器（stage 3，只能复制）：导入的 → B 加一行指向同一 `library_id`（不克隆、不走 `skill_import` 审批，卡上标「外部导入」）；自写的 → 目录复制进 B 的仓库并提交「从 {A} 复制 {name}」+ authored 行；`status` / `status_reason` 照搬；B 有同名私有行 → 置灰；草稿 / 内置 / 公共技能不列；幂等（导入看同一 library，自写看目录哈希）。
- `memory` 适配器（stage 3，只能复制）：盘点默认只给统计（数量、按 kind 分布、敏感条数），`memory_query`（FTS；`*` = 最近）列候选（≤ `HANDOVER_MEMORY_QUERY_LIMIT` = 50）；`private_to_bot` / `self_note` / 承诺 / 非 active / 已过期在盘点、提议（出现即整张退回并说明原因）、执行（重新校验 → `skipped`）三处过滤；敏感条目标「敏感」、`defaultSelected: false`（卡片初始不勾；决定不带 `handoverSelection` 时 core 也按 `defaultHandoverKeys`，不带敏感项）；B 已有同样内容的置灰。写入 B：新 id，字段照搬，`private_to_bot` = 0，`origin_conversation_id` 置空，`evidence_json` = `[{messageId: null, conversationId: null, runId: null, handoverId, fromBotId, fromItemId}]`（`memoryEvidenceSchema` 增三个可选键），按 `handoverId` + `fromItemId` 幂等；写入后 best-effort `embedItem`（适配器再包一层 try/catch）。交接记录与结果通知里记忆只给条数，不把内容灌回上下文。
- 承诺随定时任务：承诺联动的定时任务解除置灰（卡上写「连同承诺」）；执行顺序「B 的承诺副本（按来源记录幂等）→ `ScheduleService.transferTo(…, commitmentId = 副本)`（事务）→ `MemoryService.voidCommitment(A)`（发 `memory.commitment_invalidated`）」，每步可重入（`isApplied` 要求 A 的承诺已失效；崩溃在移交与作废之间时 `validate` 放行、`apply` 只补作废）。A 的承诺 `void` 后不进 `<my_state>`、联动任务取消；B 的副本 active、接上重建的任务。
- 契约：`handoverMarkSchema`（`external_import` / `sensitive`）、卡片条目 `marks` / `defaultSelected`、`defaultHandoverKeys`、`HANDOVER_MEMORY_QUERY_LIMIT`；记忆条目另计上限（`HANDOVER_MEMORY_MAX_ITEMS` = 200，其余条目仍 ≤ 100）。
- 渲染端：`HandoverCard` 标记徽标、默认勾选按 `defaultHandoverKeys`、条目多时组内滚动、提示语；`WatchCard` 已移交状态（不再给操作）；zh-CN 文案。

**本次复核修补**（`d87fd89`）：

- 平台规则里「你只能交出自己的东西、交给已有 Bot」对管家同样注入（`TURN_PLATFORM_RULES` 人人都有），与 `BUTLER_RULES` 矛盾 → 注明「你是管家时以 `<butler_rules>` 为准」。
- 记忆 / 承诺副本的 `embed` 由适配器兜底（端口抛错时副本照写、照记账）；原「embed 失败不阻塞」用例其实没有制造失败，改为端口抛错。
- 补测试：监看移交后同一页面状态不再提醒（A、B 都不），之后的新变化只提醒 B、用 B 的浏览器资料（`TestClock` + 假后台页）；记忆副本没有消息证据、不能支撑画像提议（`checkProfileCandidate` 拒绝）；自写技能停用状态照搬；e2e 普通 Bot 自己盘点（私密记忆不在候选里）并移交记忆与定时任务。
- P1 新文件与 main 上原本 prettier 干净的文件按 prettier 格式化（main 上本就不干净的文件不动）。

**测试**：

- P1 用例：`core/test/integration/handover-p1.test.ts`（4：普通 Bot 全流程——盘点别人被拒、以别人为来源被拒、`private_to_bot` 出现整张退回、监看 / 技能 / 记忆 / 承诺一张卡完成、敏感默认不勾、B 能 `recall` 到副本、A 的承诺 void 且不在 `<my_state>`、A 无 active 任务；宿主侧直接调用也拒绝新建 / 别人来源 / 盘点别人；勾上敏感记忆 + 崩溃恢复只补剩下的；监看不重复提醒）、`unit/handover-adapters-p1.test.ts`（21）、`unit/handover-skill-copy.test.ts`（5，真实 es-git 仓库）、shared `handover.test.ts`（+2）、`handover.test.ts` / `handover-adapters.test.ts` 按 P1 改写的 2 例；e2e `handover.spec.ts` +1。
- 定向回归（Docker）：handover 全部 7 个文件 + memory（memory / consolidation / lifecycle / reflection / review-fixes / store / retrieval / validate / my-state / reflection-input / reflection-output）、watch / watches-migration、schedule（integration / service / tools / nudges / scheduler）、butler / butler-team / butler-route、approvals / app-approvals、context-assembly、app-prompt-capabilities、external-agent-engine / p2 / p6、mcp-tools-auth、llm-router、turn-tools-review-fixes、tool-effects（unit / integration）、skills-registry、skill-tools、shared agent-catalog、create-core、public-skills-migration、model-selection-single-source：全绿（39 文件 402 例 + handover 7 文件）。`skills.test` / `skills-authoring.test` 是 es-git 基线失败文件，单跑 3 + 4 条失败与基线一致；P1 的技能测试不在这两个文件里（`handover-skill-copy.test.ts` 用真实 es-git，在容器里通过）。
- typecheck（shared / core / desktop，svelte-check 0 错误 1 条既有 warning）、改动文件 eslint 通过。
- 全量（容器 `kh1-full`，提交 `d87fd89`）：4349 例，4300 通过 / 27 失败 / 22 跳过。26 条为既有基线文件（sandbox-isolation 10、skills-authoring 4、skills 3、workspace-tools 3、toolchain-sandbox 2、wiki-url 2、projects 1、environment 1）；另 1 条 `connected-apps-runtime`「listing failure at run start」是已知负载偶发，单跑 13/13 通过。**无新增失败。**
- e2e 全量（`kepcup-test:trixie-xvfb`，容器 `kh1-e2e-full`，提交 `4d0c7e7`，93 例）：86 通过 / 7 失败，`handover.spec` 两例（P0 + 新增 P1）都通过。失败均为既有基线：`wiki.spec`、`debug-dev-pin`、`external-agents` ×3、`local-connectors`（P0 时已在 main 上核实同样失败）与 `sandbox.spec`「run status line」（文档记录的容器环境基线；本轮单跑仍失败，P0 两轮里一次失败、一次重试通过）。

**偏差（需用户确认）**：

- **DEV-012 承诺不单独复制**：设计 §3.1 只说 `private_to_bot` / `self_note` / 非 active 永不提供；实现把**承诺（commitment）**也排除在记忆条目之外——承诺只随关联的定时任务一起移交（否则 A、B 各有一条、两边都提醒）。后果：**没有到期时间、因此没有联动定时任务的承诺无法移交**（盘点不列、提议退回并说明「跟着关联的定时任务一起移交」）。**推荐**：照此；若要支持，再加「承诺单独移交」（复制给 B + 作废 A，与随任务迁移同一语义），放 P2。
- **DEV-013 承诺副本的来源对话**：普通记忆副本 `origin_conversation_id` 置空（设计原文）；随定时任务移交的承诺副本改为**重建任务所在的对话**，以便删除对话 / 移出群时照常作废（P07 级联按它查）。**推荐**：照此。
- **DEV-014 承诺定时任务的置灰条件**：关联承诺已失效（非 active）或 `private_to_bot` 时，该定时任务置灰、不可移交（设计未写）。**推荐**：照此（私密承诺不该出现在 B 那里；已失效的承诺其任务本也会在触发时被取消）。
- **DEV-015 记忆盘点细节**：`memory_query="*"` 列最近的；候选上限 `HANDOVER_MEMORY_QUERY_LIMIT` = 50（新常量）；已过期（`valid_until` 已过）也永不提供；B 已有一字不差的 active 条目时置灰（「已经记着同样的内容」）；记忆条目与其他条目分开计上限（≤ 200 + ≤ 100）。**推荐**：照此。
- **DEV-016 监看就地移交**：定时任务是「B 侧重建 + A 侧取消」，监看则是同一行改归属（同一个 id），这样检查状态、提醒序号与排队的提醒作业天然延续；私聊的在 B 私聊补「已创建」卡，A 私聊的旧卡靠「行的对话已不同」显示已移交。群监看留在原群，群里的旧卡不加「已移交」标记（卡上显示的归属 Bot 会变成 B）。暂停状态照搬。移交瞬间正在进行的那次检查因 CAS 冲突作废，下一次用 B 的浏览器资料。**推荐**：照此。
- **DEV-017 决定不带勾选时的缺省**：P0 是「缺省 = 全部可勾选项」；P1 改为卡上的默认勾选（`defaultHandoverKeys`，敏感记忆不在其中），避免绕过卡片的决定把敏感记忆带过去。渲染端总会带 `handoverSelection`，此改动只影响非卡片路径。**推荐**：照此。
- **DEV-018 能力包与可省参数**：`collaboration` 包的 `tools` 加入两个移交工具（外部智能体驱动的普通 Bot 选中该包即注入，设计 28 表已同步）；管家的 `bot_id` / `from_bot_id` 也改为可省（= 自己）。**推荐**：照此。
- **DEV-019 记忆副本的可追溯性只在数据层**：来源记录在 `evidence_json`，但记忆面板（`MemoryTab`）只显示有消息 id 的证据，所以界面上看不出「从 A 复制」；之后 A 侧对原条目的修改 / 撤回不会同步到 B 的副本（独立副本，符合「一律复制」）。副本 `source`（explicit / inferred）照搬，B 的上下文里与普通记忆无异。**推荐**：P1 接受；记忆面板显示「从 {A} 移交复制」作为小的后续项（不阻塞合入）。

**评审时请重点看**：`ScheduleAdapter.apply` / `isApplied` / `validate` 的承诺三步与可重入（尤其 `validate` 在「已移交给 B」时直接放行）；`MemoryService.voidCommitment` 发出的失效事件会取消 A 名下**所有**联动同一承诺的任务（若同一承诺联动了多条任务而只移交其中一条，另一条会被一并取消——正常路径一条承诺只建一条任务，未专门处理）；`WatchService.transferTo` 的事务（行 CAS、`watch_alert` 作业改投、补卡）与渲染端「已移交」判据；`SkillsService.copyForHandover` 在接手方作者仓库锁内覆盖半拷贝目录；`HandoverHost.propose` 的 `refusal` → 整张退回 与 `resolve` 的边界（编造 key vs 永不移交）；`TURN_PLATFORM_RULES` 与 `BUTLER_RULES` 的措辞关系。已知未覆盖：自写技能在 B 侧 git 提交失败时（`authoredGitCommit` 抛错）该项记 `failed`，目录已复制进 B 的仓库但没有 `bot_skills` 行（B 看不到它；同名校验按行，重试会覆盖目录重做），没有专门用例；嵌入模型真实就绪时的向量写入只靠既有 `embedItem` 测试覆盖，P1 测试环境没有嵌入器。

**迁移号**：P1 无迁移（main 最大仍为 D88 的 0036）。

### P1 审查修复（2026-10-13，独立 opus 审查 67766ee..d3362a5，无 blocker）

提交 `d1d0cbd`。

| # | 发现 | 修复 | 回归测试 |
|---|---|---|---|
| 1 | 承诺联动的定时任务移交失败时，B 留下一条没接上任务的 active 承诺副本（第 2 步 `transferTo` 抛错：embed 等待期间用户取消了任务、B 退群、对话变只读；或崩溃在第 1、2 步之间后用户取消任务 / 作废 A 的承诺，恢复时校验跳过） | 适配器新增可选钩子 `abandon(ctx, key)`，宿主在执行时 `skipped` / `failed` 都调用（best-effort）。`ScheduleAdapter`：`transferTo` 外包 try/catch，失败即作废本次移交给 B 的、**没接上 B 任何 active 任务**的承诺副本（已接上的不动——同一承诺的另一条任务可能已移交成功）；`abandon` 同样处理。作废过的副本不复用，重试重新复制；`MemoryStore.findHandoverCopy` 改为 active 优先、其次最新 | `handover-adapters-p1`「审查 #1」两例（抛错 → 作废、A 不变、重试新副本；崩溃后用户取消 → 跳过 + abandon 作废；已接上的不作废）；原「崩溃在复制与移交之间」改为模拟进程崩溃（副本保留、重跑复用） |
| 2 | 监看移交给浏览器资料不同的 Bot：`changed` 监看用 B 的资料检查时页面不同 → 安静哈希不同 → 误报「页面变化」 | `WatchesStore.reassign` 增 `resetBaseline`：两边 `profileKeyFor` 不同时清空 `last_hash` / `last_quiet_hash`（`last_matched`、`alert_seq` 保留），B 第一次检查只建基线；卡片警告写明（并说明 B 登录前后页面不同时仍可能提醒一次）。本机访问（`allowLoopback`）随对话的项目绑定：私聊监看改到 B 私聊后规则可能不同——选更安全的做法：**字面本机网址**（localhost / 127.x / ::1 / 0.0.0.0 / *.localhost）在两边规则不同时**不可移交**（置灰说明）；其余网址照常移交，卡上提示「之后能否访问本机地址改按 B 私聊的项目绑定决定」 | `handover-p1`「监看移交后…」增 `changed` 监看（B 的资料看到的页面不同，不提醒、只建基线）与哈希清空断言；`handover-adapters-p1`「审查 #2」（本机网址置灰 / 规则相同放行 / 公网网址提示、`isLoopbackUrl`）；全流程用例改断言哈希清空 |
| 3 | 导入技能的卡片说明不含来源网址 / 描述 / 状态，而这张卡替代了 `skill_import` 审批 | `SkillAdapter.describe` 带上 `entry.detail`（外部导入 + 来源网址、状态、描述） | `handover-adapters-p1` skill 用例「审查 #3」 |
| 4 | 私密（`private_to_bot`）承诺的原文经联动定时任务的标题 / 说明与「连同承诺「…」」泄露到盘点结果与卡片 | 关联私密承诺的任务：label 用「一条私密承诺的提醒」、detail 只有时间与位置（该项本来就置灰）；执行结果、交接记录只列 done 项，置灰项不会进去 | 「审查 #4 / #6」（盘点条目序列化后不含原文、`describe` 不含） |
| 5 | `validate` 的崩溃恢复捷径依赖 `transferredTo` 的宽松字段比对兜底 | 捷径（`validate` / `apply` 的「只补作废」/ `isApplied` 的承诺分支）只在**本次移交**在 B 那里有承诺副本（`findCopy(B, handoverId, commitmentId)`）且任务已移交给 B 时走；无承诺的任务仍由 `isApplied` 判定 | 「审查 #5」（B 有字段相同的别的任务、原任务被用户取消 → 跳过、未应用）；P0 单测相应改回「已结束」 |
| 6 | 敏感承诺随任务默认勾选移交 | 关联承诺 `sensitivity='sensitive'` 的任务条目标「敏感」、`defaultSelected: false` | 「审查 #4 / #6」 |
| 7 | 跳过 / 失败的记忆在结果通知与卡片失败原因里逐条列出（最多 200 行、没有标签） | `#reasonLines`：记忆按原因汇总为「记忆 N 条：{原因}」（包 `<untrusted>`），其余条目照旧逐条 | `handover-p1`「审查 #7」（两条在提议后被标私密 → 通知里只有一行「记忆 2 条：」、不含内容；卡片 `failed` 原因同样汇总） |
| 8 | 群聊里 `memory_query` 会列出敏感候选（检索在群里会过滤掉它们） | `InventoryQuery.excludeSensitiveMemory`：发起对话是群聊时敏感记忆不作候选（同 `passesFilters`）；统计行仍只给条数 | 「审查 #8」 |
| 9 | 普通 Bot 提议 `model:*` 会改写 B 的模型 / 驱动引擎，这不是它自己的资产 | 见 DEV-020：普通 Bot 的盘点不列模型条目与可用模型、`propose` 退回 `model:*`、执行时再兜一次（提议方不是管家 → `skipped`）；工具说明同步。`BUTLER_RULES` 的移交说明补上网页监看、技能与记忆 | `handover-p1`「宿主侧校验…」增模型断言 |

未做 / 仍存在：`abandon` 在原定时任务行已被删除（对话删除级联）时拿不到 `commitmentId`，无法定位 B 的副本——此时副本所在对话通常也已删除，承诺按 P07 级联作废；执行时「提议方不是管家的模型条目」只能靠改库构造，没有专门用例（提议侧已有测试）。

修复后定向回归（Docker，21 文件 227 例，全绿）：handover 7 个文件 + watch / watches-migration / schedule / schedule-service / memory / memory-store / memory-lifecycle / my-state / skills-registry / skill-tools / context-assembly / butler / approvals / tool-effects；core / desktop typecheck（svelte-check 0 错误）、改动文件 eslint 通过。

- 全量（容器 `kh1-full2`，提交 `d1d0cbd`）：4356 例，4307 通过 / 27 失败，失败文件与条数与审查前完全相同——26 条基线文件 + `connected-apps-runtime`「listing failure at run start」负载偶发（单跑 13/13 通过）。**无新增失败。**
- e2e 全量（`kh1-e2e-full2`，93 例）：86 通过 / 7 失败，`handover.spec` 两例通过；失败与审查前同一组基线（wiki、debug-dev-pin、external-agents ×3、local-connectors、sandbox status line）。

- **DEV-020 模型条目只给管家**：设计 §决策 7 只说普通 Bot 只能交出**自己的**资产。`model:inherit` / `model:<ref>` 实际是改写**接手方** B 的模型与驱动引擎，不是 A 的资产，所以普通 Bot 发起时不提供（盘点不列、提议退回、执行时兜底），改 B 的模型仍可由管家提议或用户在 B 的详情页改。**推荐**：保持限制；用户若希望普通 Bot 也能设置接手方的模型再放开。

### P2（2026-10-13，t/handover-p2）

分支 `t/handover-p2` @ `/home/jyy/wt/kepcup-handover-p2`，从 `t/handover-p1`（6975ebd，含 P1 与审查修复）拉出。**无新迁移**（作业类型没有 CHECK；组件 / Wiki 复制只用既有表与目录）。提交：`38ac72e` 功能、`4739214` 测试与 e2e、`40e2f10` shared 契约测试、`2a5b821` 文档、`beb07da` 自审修复、本次文档更新。

**完成项**（§5，`deletionPreview` 一项未采用）：

- 框架：适配器接口增 `background`（后台条目）与可选 `applyBatch(ctx, keys)`（`handover/types.ts`）。`HandoverHost` 在阶段 2–6 之后给还有后台条目的移交登记一个 `handover_copy` 作业（`dedupe_key = handover_copy:{handoverId}`，`bot_id` / `conversation_id` 为空；`JobsService.activeByDedupeKey` 保证同一移交最多一个 pending / running 作业），**作业完成前移交保持 `applying`、不写交接说明、不结算**；作业（`HandoverHost.runCopyJob`，`JobsRunner` 的 `handover_copy` 分支）逐个适配器跑 `isApplied` → 重新校验（不成立 → skipped + `abandon`）→ `applyBatch` / 逐项 `apply`，然后经常规执行路径写交接说明、结算、通知。后台阶段任何异常 = 暂时失败：条目留 pending、作业抛 `JobRetryLaterError`（jobs runner 记一次失败并推迟 `run_after` 30 秒 × 已用次数，`JobsService.postpone`），末次（`JOB_MAX_ATTEMPTS`）仍失败才把剩余条目记 failed 并照常收尾；作业在三次认领里都崩溃（jobs 恢复把它置 `failed`）时，`recover()` 再进执行路径会把条目记「后台复制多次中断」并结算，不无限重登。`whenSettled` 等到终态。
- `wiki` 适配器（`handover/adapters/wiki.ts`，stage 3，后台，只能复制）：key 为页 `wiki:pages/a.md` 或目录 `wiki:pages/`（整本）/ `wiki:pages/{目录}/`（执行时取当下目录下的全部页）。盘点默认给整本与各主题目录（页数、大小，只 stat）和统计行；`wiki_query` 另列页（`*` = 全部、`pages/{目录}/` = 某目录、其他 = `wiki_fts` 检索；≤ `HANDOVER_WIKI_QUERY_LIMIT` = 100；只给标题与路径，标题包 `<untrusted>`）。`resolve`：来源里任何现存页 / 非空目录。校验：单页在 B 那里有同路径、内容不同的页 → 置灰（执行时 → 跳过）；目录只在卡上警告会跳过哪些。`applyBatch` 把所有 key 的页取并集一次复制，按 key 分配结果（`copiedCount`、`skippedPaths`、`missingPaths`、`bytes`、`rawConflicts`、`commit`）；一页都没复制成的 key 记 skipped 并列出路径；有复制时发 `wiki_changed`。
- `WikiService.copyForHandover`（`wiki/service.ts`、`wiki/copy.ts`）：两段式、从不同时持两把锁——①来源的维护锁内把页、页面链接到的 `raw/` 原件（行内链接 / 图片 / 引用式定义 / html src·href，按页所在目录解析，越界与外链忽略）、D85 资产（`raw/_assets/{id}.json`、清单里的 `rawRelPath` / `readable`、`raw/_derived/{id}/`、仓外 `bots/{A}/wiki-store/{id}/`，`staging/` 除外）快照到 `{cacheDir}/handover-staging/{handoverId}/`（与 `bots/` 同一文件系统；仓外不可变文件硬链接、跨设备复制；`state.json` 总是复制；`raw/` 文件复制，因为它们在 git 工作区里；仓外根 / 资产目录是符号链接时不跟随）；②B 的维护锁内（先确认 B 还在、必要时 `initWiki`）逐个 rename 落盘，原件与资产只放**复制成功的页**引用的：已有同路径且字节相同 = 已复制（续跑幂等），不同 = 保留 B 的、页面列入 `conflicts`、原件列入 `rawConflicts`；提交之前出错则删掉本次落盘的文件、恢复 log.md 再抛错；提交之后的 FTS / lint 失败只记日志；有页复制时 log.md 追加一行（含「移交 {handoverId}」标记，续跑不重复）、树有变化才提交「从 {A} 复制 N 页」（`commitWikiTreeIfChanged`，续跑不出空提交）、增量写这些页的 `wiki_fts` 并 `reconcileFtsFor(B)`（`reconcileFts` 抽出单 Bot 版本）、排一次 `wiki_lint`（`dedupe_key = wiki_lint:{B}:handover`，`payload.trigger = 'handover'`）。暂存目录最后删除。A 的 Wiki 只读。
- `widget` 适配器（`handover/adapters/widget.ts`，stage 3，后台，只能复制）与 `WidgetService` 的 `handoverCandidates` / `conversationScopedCount` / `findHandoverCopy` / `handoverCopyBlocker` / `copyForHandover`：只列 `scope='bot'` 组件（版本数、全部版本字节、查询模板数、存储数据条数、最新版自检状态、说明）；会话级只在统计行给条数、不移交。复制一个事务：新 id、仍为 Bot 级、不发卡；`widget_versions` 全部行原样（含 `queries_reviewed_at`、`check_status`、`check_summary_json`）、`widget_queries`、`widget_docs` 全部复制；B 已有同名组件 / 数量或字节配额超限 → 置灰（执行时跳过），阻断条件在事务内复查。幂等：B 名下同名、版本序列（版本号 + HTML 摘要 + 查询摘要）相同的 Bot 级组件 = 已复制。
- 退役（DEV-025）：执行视图增 `retire`（`HandoverHost` 计算：`completed`、所有条目 done、没有因同路径跳过的页、没有原件冲突（`rawConflicts`）、接手方已有、来源仍在且不是管家 → `{botId, botName}`）。结果卡（`RetireBotButton.svelte`）显示「删除 {A}」→ 与通讯录 / 右栏同一份删除确认（`bots.deletionPreview` 统计 + 确认）→ `bots.delete`；从不自动删；通讯录里已没有该 Bot 时不显示。结果通知里同步告诉发起方「卡上有删除按钮，不要催、不要声称已删」。
- 工具与提示词：`inspect_bot_assets` 的 `wiki_query` 生效、说明与分组（Wiki、组件（Bot 级））更新；`propose_handover` 说明列入 Wiki、组件并说明后台复制与同路径 / 同名不覆盖；`BUTLER_RULES` 与 `TURN_PLATFORM_RULES` 的移交说明补上 Wiki 与组件。普通 Bot 交出自己的 Wiki / 组件沿用 P1 规则（只能是自己、目标是已有 Bot）。
- 契约（shared）：`handoverItemViewSchema` 增 `copiedCount`（默认 null）/ `skippedPaths`（默认 []）；`handoverViewSchema` 增 `retire`（默认 null）；`jobTypeSchema` 增 `handover_copy`；常量 `HANDOVER_WIKI_QUERY_LIMIT`。均为向后兼容的新增字段（RPC 入参不变）。
- 渲染端：`HandoverCard` 对后台条目在执行中显示「后台复制中…」，完成后显示「已复制 N 页 / N 个版本」与「接手方已有同路径、内容不同的页，没有覆盖：…」；Wiki / 组件分组标签；退役按钮；zh-CN 文案。
- 文档：设计 37 状态行、§3.2 实现说明、§5.4 接口增项、§6 P2 行；设计 05（Wiki 隔离的唯一例外）、32（组件移交复制）、36 §6（移交复制与硬链接依赖的约定）指针；`docs/dev/03-data-model.md`（`handover_copy` 作业、移交条目的 result 约定与 `retire`、组件复制、Wiki 复制与暂存目录）、`04-agent-runtime.md`（工具目录）。

**测试**：

- 新增：`core/test/unit/handover-wiki-copy.test.ts`（5，真实 es-git：引用解析；页 + 原件 + D85 资产〔硬链接同 inode、`state.json` 另一个 inode、`staging/` 不复制〕、同路径页保留并列出、一次提交、A 的历史不变、FTS、排 lint、暂存目录清理；重跑不新增提交 / 日志行；已落盘未提交的半成品续跑后提交、残留暂存被替换；B 已有不同内容的原件保留并报告；接手方已删除时拒绝且清理暂存；越界 / 非 pages 路径不读）、`core/test/unit/handover-adapters-p2.test.ts`（7：Wiki 目录 / 页盘点与 `wiki_query` 三种形式、`resolve` 拒绝编造与越界 key、置灰与目录警告、批量结果按 key 归属与全冲突跳过；组件只列 Bot 级、阻断、复制一次、`isApplied`）、`core/test/integration/handover-p2.test.ts`（4：①Wiki + 组件全流程——作业停住时移交 `applying`、条目 pending、B 没有交接说明、`retire` 为 null；作业跑完后 `completed`，Wiki 复制 2 页、`skippedPaths = [pages/shared.md]`、组件 2 个版本；页 / 原件 / `_assets` / `_derived` / `wiki-store` 到了 B，B 的同路径页没被覆盖，B 只多一次「从 阿尔法 复制 2 页」提交，A 的历史不变，`wiki.search` 在 B 上命中，排了 `trigger=handover` 的 lint；组件版本摘要 / 预审时间 / 自检状态 / 查询模板 / 存储数据与原版一致，会话级没过去；结果通知列出没覆盖的页、不提删除；有跳过的页不给退役。②作业崩溃恢复——作业 running、页已落盘未提交、组件已复制未记账 → `resetRunningToPending` + `recover()` 不另登记作业 → 续跑 `completed`、只一次提交、FTS 命中、组件只一份；`retire` = 阿尔法（`handovers.get` 同样），通知提到「删除 阿尔法」；删除阿尔法后 `retire` 变 null。③作业多次中断而 failed → 条目记「后台复制多次中断」、移交 `failed`、不重登作业、不给退役。④来源是管家：同路径单页条目置灰；完成也不给退役）；shared `handover.test.ts` 补视图新字段默认值与 `handover_copy`。e2e `handover.spec.ts` +1（阿尔法的 Wiki 由测试写进数据目录并 git 提交 → 阿尔法自己 `inspect_bot_assets(wiki_query)` → `propose_handover` 整本 Wiki → 卡上 Wiki 组 → 确认 → 进度卡完成、「已复制 2 页」→ 贝塔的 `wiki.tree` 有两页 →「删除 阿尔法」→ 删除确认框 → 阿尔法被删除）。
- 定向回归（Docker `kepcup-test:trixie`）：P2 三个文件 16 例；handover P0 / P1 全部 6 个文件 + shared handover + wiki（unit / integration）+ wiki-maintenance-delete + widgets-service + widget-tools + jobs-retention + tool-effects（unit / integration）+ context-assembly + butler + create-core：18 文件 248 例，全绿。e2e `handover.spec.ts` 3 例（P0、P1、P2）全过（`kepcup-test:trixie-xvfb`）。
- typecheck（shared / core / desktop，svelte-check 0 错误 1 条既有 warning）、改动文件 eslint 通过；新文件 prettier 格式化（main 上本就不干净的 `widgets/service.ts`、`domain/jobs.ts`、`dispatch/jobs-runner.ts` 不整体重排）。
- 全量（容器 `kh2-full`，提交 `40e2f10`）：4372 例，4323 通过 / 27 失败 / 22 跳过。26 条为既有基线文件（sandbox-isolation 10、skills-authoring 4、skills 3、workspace-tools 3、toolchain-sandbox 2、wiki-url 2、projects 1、environment 1）；另 1 条 `connected-apps-runtime`（「does not abort the run: tools are withheld…」）是已知负载偶发，单跑 13/13 通过。自审修复后复跑（容器 `kh2-full2`，提交 `beb07da`）：4374 例，4326 通过 / **26 失败，全部为上述基线文件**，无新增失败。
- e2e 全量（`kepcup-test:trixie-xvfb`，容器 `kh2-e2e-full`，提交 `2a5b821`，94 例）：87 通过 / 7 失败，`handover.spec` 三例（P0、P1、P2）都通过；失败与 P1 记录的同一组基线完全相同（`wiki.spec`、`debug-dev-pin`、`external-agents` ×3、`local-connectors`、`sandbox.spec`「run status line」）。自审修复后重建并单跑 `handover.spec`（容器 `kh2-e2e-2`，提交 `beb07da`）：3/3 通过。

**自审修复**（提交 `beb07da`；实现完成后让一个只读审查子代理过了一遍 P2 diff，结论无 critical，以下 9 条全部修复，均有定向测试）：

| # | 发现 | 修复 | 回归测试 |
|---|---|---|---|
| 1 | 作业末次执行时，`applyBatch` 以外的异常（如两边 Bot 在组间被删导致 `getOrThrow` 抛错、写库失败）让作业落 `failed` 而条目停在 pending、移交停在 `applying`，直到下次重启 | `runCopyJob` 兜住整个后台阶段：非末次抛 `JobRetryLaterError`，末次把剩余后台条目记「后台复制失败」后照常收尾 | `handover-p2`「后台批量暂时失败…」 |
| 2 | 失败后下一次轮询（约 0.5 秒）就重试，暂时性错误（git 索引锁、EBUSY、ENOSPC）一两秒内耗尽三次 | `JobRetryLaterError` + `JobsService.postpone`：jobs runner 照常记失败再把 `run_after` 推后 30 秒 × 已用次数 | 同上（真实 runner：`attempts = 1`、`run_after` 推后、条目仍 pending） |
| 3 | 落盘后、提交前失败：文件留在 B 的工作区（未提交、未索引），之后会被 B 的下一次维护提交带走 | 提交前出错时删掉本次落盘的文件、恢复 log.md 再抛错；提交后的 FTS / lint 失败只记日志 | `handover-wiki-copy`「review fixes…」（损坏的 `.git`：页 / 原件不留、log.md 原样、暂存清理） |
| 4 | 被引用原件在 B 那里内容不同（`rawConflicts`）时仍给退役，且没告诉用户 | `#retireOffer` 排除；结果通知说明保留了 B 的原件 | 退役判定代码路径（`rawConflicts` 的产生有单测） |
| 5 | 被跳过（同路径冲突）的页引用的原件也会放进 B | 第一段按页记录引用，第二段只放复制成功的页的 | `handover-wiki-copy`「review fixes…」 |
| 6 | 仓外 `wiki-store` 根或资产目录若是符号链接会被跟随（可把任意本机文件链进 B） | `lstat` 要求两级都是真目录 | 同上（符号链接的资产目录不复制） |
| 7 | 暂存目录在 `bots/{B}/` 下、只持 A 的锁写入：与删除 B 并发时可能留下空的 `bots/{B}/` 骨架 | 暂存移到 `{cacheDir}/handover-staging/{handoverId}/`（同一文件系统） | 单测断言改为新路径 |
| 8 | 退役按钮的预览 / 删除失败没有任何提示 | `toast.error` | — |
| 9 | 重启竞态下作业可能在移交已结算后继续改条目状态 | 后台阶段每组执行前、写批量结果前复查移交仍是 `applying` | — |

**偏差（需用户确认）**：

- **DEV-021 D85 还没实施：资产部分前向兼容**：设计 §3.2 要复制「`wiki-store` 二进制资产 + `_assets` / `_derived` 清单」，但 D85（设计 36）仍是「已定稿，待实施」，代码里没有 `wiki-store`。实现按设计 36 §3.1 的布局处理：页面链接到 `raw/_assets/{id}.json` 或 `raw/_derived/{id}/…` 即认定引用了资产 `{id}`，复制清单（及清单里的 `rawRelPath` / `readable`）、整个 `_derived/{id}/` 与仓外 `bots/{A}/wiki-store/{id}/`（`staging/` 除外）；新增路径函数 `botWikiStoreRoot`。仓外不可变文件**硬链接**（跨设备 / 不允许时复制），`state.json`（D85 会就地更新的实时状态）**复制**；`raw/` 下的文件一律复制（它们在 git 工作区里，回滚 / checkout 可能改写）。测试用手工构造的 D85 布局。**推荐**：照此；D85 实施时守住「仓外文件只用原子 rename 写、不就地改写」（已写进设计 36 §6），否则硬链接会让两个 Bot 共享改动。
- **DEV-022 Wiki 的选择粒度与冲突口径**：除了按页，还有目录条目（`wiki:pages/` 整本、`wiki:pages/{目录}/`），执行时取目录下**当下**的页（提议后新增的页也会被复制，删掉的计 missing）；盘点不带查询只给目录条目与统计，`wiki_query` 才列页、只给标题与路径（不把正文片段灌进上下文——群聊同样适用）。页条目计入 `HANDOVER_ITEMS_MAX`（100），大量复制用目录条目。B 已有同路径**字节相同**的页算「已复制」（续跑幂等；B 事先就有一模一样的页也算完成）；**不同**才是冲突：单页条目卡上置灰、执行时跳过，目录条目照常执行、结果里列出跳过的路径（条目仍是 done，但会挡住退役，见 DEV-025）。被引用的原件在 B 那里有不同内容时保留 B 的（结果里有 `rawConflicts`，不单独提示用户）。log.md 由宿主追加一行（维护 loop 之外唯一的写入方），index.md 不动，交给排的那次 lint 整合。**推荐**：照此。
- **DEV-023 后台作业与重试的口径**：组件也进 `handover_copy` 作业（照设计 §5.3；它其实只是一个数据库事务）。「失败可重试」= 作业级自动重试：后台阶段出错时条目留 pending、作业推迟（30 秒 × 已用次数）后重试，至多 `JOB_MAX_ATTEMPTS` 次，末次仍失败记 failed；作业三次都在执行中崩溃（jobs 恢复置 `failed`）时条目记「后台复制多次中断」，不无限重登。没有给用户的「重试失败项」按钮：失败项在卡上 / 通知里列出，用户可以让 Bot 再提一张卡（已复制的页按「字节相同 = 已复制」幂等，等于只补剩下的）。作业 `bot_id` 为空：不受接手方每日后台预算推迟，也不随某个 Bot 被删而被 jobs 取消（作业自己检查两边 Bot 是否还在，不在则跳过）。交接说明在作业完成后才写，所以 B 收到的交接记录包含 Wiki / 组件。**推荐**：照此；若需要卡上「重试」按钮，作为后续小项。
- **DEV-024 `deletionPreview` 不改用适配器汇总**（§5 可选项，未做）：适配器的 `inventory` 统计的是「可移交」的子集（记忆排除私密 / 自我笔记 / 承诺 / 失效，技能排除草稿与内置，Wiki 盘点是目录条目），用它替换删除确认框里的数字会**少报**删除会毁掉的东西，与该对话框的用途相反；RPC 契约也只有那几个字段。保持 `lifecycle.deletionPreview` 原样。**推荐**：保持。
- **DEV-025 退役按钮的判定**：由 core 计算（视图 `retire`，契约新增字段），条件：这张卡**勾选执行的条目**全部 done（含交接说明）、没有因同路径跳过的 Wiki 页、接手方存在、来源仍在且不是管家；`partial` / `failed` 不出。只看这次移交，不检查 A 名下是否还有别的资产（例如只交了邮箱、A 还有定时任务时也会出现按钮——删除确认框里有统计，用户自己判断）。按钮只是 D18 删除的另一个入口，同一份确认、同一个 `bots.delete`；通讯录里已没有该 Bot（已删除）时不显示。**推荐**：照此；若希望「A 名下没有剩余可移交资产才出按钮」，可在判定里加一次盘点。
- **DEV-026 组件的确认状态与同名口径**：D81 的加载确认是渲染端 localStorage 按「HTML sha256 + 查询摘要」记的（不分组件 / Bot），副本内容不变，原版确认过的版本在 B 那里**自动**免确认、没确认过的仍要确认——无需复制任何确认记录；core 强制的 SQL 预审时间（`queries_reviewed_at`）原样复制（用户审过的是同一份 SQL）；D87 自检状态 / 摘要照搬。`widget_docs`（组件自己的存储数据）也复制——B 的副本从 A 当时的数据开始，之后各自独立。同名口径：B 名下任何作用域的同名组件都置灰；会话级组件不移交（只属于所在对话、卡片钉在那里、查询模板读那个对话的消息），盘点只给条数。复制不发卡（B 之后用 `widget_publish` 发到需要的对话）。**推荐**：照此。
- **DEV-027 契约与服务的新增面**：执行视图 `copiedCount` / `skippedPaths` / `retire`、作业类型 `handover_copy`、常量 `HANDOVER_WIKI_QUERY_LIMIT`（全部带默认值，旧客户端 / 旧推送兼容）；`WikiService` 增 `pageStats` / `pageConflict` / `copyForHandover` / `reconcileFtsFor`（`reconcileFts` 改为逐 Bot 调它）；`JobsService` 增 `activeByDedupeKey` / `latestByDedupeKey` / `postpone` 与 `JobRetryLaterError`（jobs runner 识别它推迟重试；非 pending 的按 `dedupe_key` 查走全表扫描——只在移交执行时调用，jobs 表有定期清理，未加索引以免迁移）；`git.ts` 增 `commitWikiTreeIfChanged`。**推荐**：照此。

**评审时请重点看**：作业恢复——`#execute` 在后台条目未完成时提前返回、`#ensureCopyJob` 的「已有 pending / running 不重登、`failed` 不重登而记失败」、`runCopyJob` 结束时等在途执行再 `#launch` 收尾（两条路径都可能先到，靠状态与 `#running` 判重）、`#launch` 崩溃兜底 `#settle` 会把后台 pending 记失败而作业之后见 `status !== 'applying'` 直接返回；Wiki 锁与原子性——两段式、从不同时持两把锁（相反方向的两张卡不会死锁），来源锁内只读，目标锁内逐文件 rename（同文件系统），崩溃可能留下「已落盘未提交」的页，靠「字节相同 = 已复制」+ `commitWikiTreeIfChanged` 续上（单测覆盖）；FTS 一致——增量 upsert 之后再 `reconcileFtsFor`，提交与 FTS 之间崩溃由启动对账兜底（同 BR-P09-009）；硬链接安全——只链 `wiki-store` 下的不可变文件，`state.json` 与 `raw/` 一律复制，依赖 D85 用原子 rename 写仓外文件（DEV-021）；确认状态复制——见 DEV-026，副本版本行逐列照搬；退役判定——`#retireOffer`（视图里 notes 条目也必须 done）。已知未覆盖：`applyBatch` 暂时失败后的作业级重试路径（抛错 → 立即重试）没有注入故障的专门用例（末次失败与多次中断都有用例）；Wiki 页里用绝对路径（以 `/` 开头）或 wiki 根相对（`raw/...` 不带 `../`）写的引用不会被识别为原件（SCHEMA 约定是相对路径），页照常复制、链接在 B 的 lint 里会被报告。

**迁移号**：P2 无迁移（main 最大仍为 D88 的 0036）。

## 7. 风险

- **用户隔几天才确认**：资产已变化 → 执行前逐项重新校验，不成立的标 `skipped` 并写原因。
- **A 有运行中的任务正在用要移交的东西**：邮箱 / 连接应用撤除后 A 的工具调用失败。P0 接受（与用户在设置页解绑的效果一致），结果通知里提示。
- **记忆复制量大 / 向量模型未就绪**：`embedItem` 失败不阻塞写入，沿用既有的向量重建路径补齐。
- **与 D87 并行**：两边都动 `tools/index.ts`、`approvals.ts`、迁移号；合入第二个的一方负责重排迁移号与解决冲突。

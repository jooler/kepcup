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

- [ ] `approvalKindSchema` 增 `bot_handover`。
- [ ] `botHandoverPayloadSchema`：`{ fromBotId, target: {kind:'existing', botId} | {kind:'new', bot: ButlerProposedBot & {model?}}, items: [{key, assetType, action, label, detail, warnings[]}], responsibilities?: {to?, from?, toBefore?, fromBefore?}, handoverNote, note, handoverId }`。卡片渲染所需的展示字段在提交时由 core 生成并快照进 payload（渲染端不再查询）。
- [ ] `approvalDecisionSchema` 增 `handoverSelection?: string[]`（RPC `approvals.decide` 入参同步）；职责改写用保留 key `resp:to` / `resp:from`。
- [ ] `butlerProposedBotSchema` 增可选 `model`（`'inherit'` 不适用于 propose_bot；取值 `'' | ref`）。
- [ ] 事件 `handover.updated`（卡片进度）；系统事件常量 `BOT_HANDOVER_EVENT`（B 侧交接说明）/ `BOT_HANDED_OVER_EVENT`（A 侧已移交）及其 content 形态（参照 `ROUTE_SUGGESTION_EVENT`）。
- [ ] 常量：`HANDOVER_ITEMS_MAX`（100）、`HANDOVER_NOTE_MAX_CHARS`（2000）、`HANDOVER_MEMORY_MAX_ITEMS`（200，P1 用）。

### 3.2 迁移（main 0036 暂定）

- [ ] `bot_handovers`、`bot_handover_items`（字段见设计 §5.1）。
- [ ] 重建 `approvals`，CHECK 增 `bot_handover`（照 0031 的写法）。
- [ ] 同步 `create-core.test.ts` 的 `user_version` 等版本断言。

### 3.3 core：框架

- [ ] `packages/core/src/handover/`：`types.ts`（`HandoverAdapter` 接口、`HandoverEntry`、`HandoverContext`、`HandoverItemResult`）、`registry.ts`（按 stage 排序）、`store.ts`（两表读写）。
- [ ] `dispatch/handover.ts` `HandoverHost`：
  - `inspect(identity, botId, query)` → 汇总各适配器盘点 + 可用模型列表（与 Bot 详情模型下拉**同源**，不另写一份枚举）。
  - `propose(identity, input)`：发起权校验（P0：仅管家，来源任意）、目标校验（active、非访谈、`from≠to`；新建目标仅管家）、逐项 `validate`、同对话已有待定 `bot_handover` / `butler_proposal` 时拒绝；落 `bot_handovers`（`proposed`）→ `submitNonBlocking('bot_handover', …)`。
  - `#onDecided`：拒绝 → `denied` + follow-up；取消 → `cancelled`；批准 → 按 `handoverSelection` 过滤 → `applying` → §5.3 顺序执行 → 结算 → 卡片 `approvals.fail`（部分失败时）→ follow-up。
  - `recover()`：启动时继续 `applying` 的 handover（接在 jobs / approvals 恢复之后）。
- [ ] 新建目标复用 `ButlerHost` 的建 Bot 逻辑：把 `#createBots` 里单个 Bot 的创建（头像、开私聊、例行事项、**模型**）抽成可复用函数，`ButlerHost` 与 `HandoverHost` 共用；`propose_bot` / `propose_team` 的 `model` 同时生效。
- [ ] `approvals.ts`：`NEVER_AUTO_DECIDED`、`SURVIVES_RUN` 加 `bot_handover`；selection 校验与 `describe` / `renderContextLine` 分支；`cancelAllPending` 时 handover 落 `cancelled`。
- [ ] `start.ts` / 服务装配：构造 `HandoverHost`，注入 bots / mail / schedule / conversations / messages / approvals / settings / logger / publish / deliverEvent。

### 3.4 core：P0 适配器

- [ ] `model`：仅在新建目标或提议中显式出现 `model:` 项时执行；校验 ref 在可用列表里；`bots.update` 写 `runtime.model`（`inherit` = 取 A 当下的 `runtime.model` 原值，可能为空 = 跟随默认）。
- [ ] `app`：盘点 A 的 `app_connection_ids`；share / move；同 Connector 冲突校验复用 `bots.ts` 的现有规则；move 时从 A 移除并照 `bindings.ts` ~L658 的方式中断 A 用到它的任务。不复制 `app_tool_grants`。
- [ ] `mcp`：盘点 A 的 `mcp_server_ids`（过滤全局已不存在 / 停用的）；share / move。
- [ ] `mail`：盘点 `accountsForBot(A)`；move（默认）/ share。在 `MailService` 增 `addBinding(accountId, botId)` / `removeBinding(accountId, botId)`（单条增删，保留其他绑定的唤醒状态；`publishAccount`），以及 `retargetPendingAlerts(accountId, fromBotId, toBotId)`：把 A 名下未执行的 `mail_alert` 作业按新去重键 `mail:{acc}:{uid}:{B}` 改投 B。顺序：add B → retarget → remove A。
- [ ] `schedule`：盘点 A 所有 active 的定时任务；`commitment_id` 非空的置灰「随承诺，P1 支持」。A 私聊里的 → `createOnce` / `createCron` 到 B 私聊；群里的 → B 是成员则建到同群，否则置灰。保留 title / note / kind / cron / run_at / timezone / origin。新任务出回执卡；A 侧 `cancel`，回执卡快照增加 `handedOverTo: {botId, name}`，渲染端显示「已移交给 {B}」。
- [ ] `responsibilities`：`resp:to` / `resp:from` 两项；A 为管家时不出 `resp:from`；写入走 `bots.update`（与 `profile_change` 同一写入路径）。
- [ ] 交接说明：B 私聊写 `BOT_HANDOVER_EVENT` 系统事件（接手清单 + 交接要点），A 私聊写 `BOT_HANDED_OVER_EVENT`；两者 `renderContextLine`（交接要点包 `untrustedBlock`）；`message.created` + `conversation.updated` 推送。

### 3.5 core：工具与提示词

- [ ] `tools/handover-tools.ts`：`inspect_bot_assets`、`propose_handover`（参数见设计 §4）；`propose_handover` 提交成功返回 `terminate: true`。对话轮注册：P0 仅管家（`tools/index.ts` 管家块）；任务不注册。
- [ ] `propose_bot` / `propose_team` 的 `model` 参数（说明：先用 `inspect_bot_assets` 看可用模型；不填 = 跟随默认）。
- [ ] `BUTLER_RULES`：委派与移交的区分；「新建并接手」用一张 `propose_handover`；先盘点再提议；未收到结果前不得声称已移交。`BUTLER_TASK_RULES`：任务里没有移交工具，把建议写进任务结果。
- [ ] `delegate_to_bot` 说明加一句「委派不改变归属；交出邮箱 / 应用 / 定时任务用 `propose_handover`（管家）」。
- [ ] `<mail_accounts>` 段不变（绑定改了自然就变）；确认 A 的上下文缓存不会滞留旧绑定。

### 3.6 渲染端

- [ ] `features/handover/HandoverCard.svelte`：头部 A → B / 新建 B（折叠显示新 Bot 字段与模型）；按资产分组的可勾选条目（动作标签、说明、置灰原因）；职责改写前后对照；交接要点；确认 / 拒绝；执行中逐项进度（订阅 `handover.updated`）；结果态。`ApprovalCard.svelte` 按 kind 分流到它；`stores/permissions.svelte.ts` 增 `bot_handover` 分支与 `decide` 的 `handoverSelection`。
- [ ] 系统事件渲染：B 侧交接说明卡、A 侧已移交提示；定时任务回执卡「已移交给 {B}」状态。
- [ ] i18n（zh-CN 及其余 locale 的键）。

### 3.7 测试

- [ ] shared 单测：payload / decision schema。
- [ ] core 单测：每个适配器（盘点、校验、apply 幂等、重复 apply 不重复建）；`retargetPendingAlerts`。
- [ ] core 集成 `test/integration/handover.test.ts`：
  - 触发事件：管家绑邮箱 M → `propose_handover` 新建目标 → 批准 → 新 Bot 存在、M 只绑新 Bot、两侧系统事件、管家收到 follow-up；新信只给新 Bot 入队 `mail_alert`。
  - 已有目标：连接应用 share（A 保留）、定时任务 move（B 私聊重建 + 回执卡、A 侧取消并标已移交）、群定时 B 非成员置灰。
  - 勾选过滤、拒绝、无人值守不自动批、编造 key 拒绝、非管家调用被拒、同对话叠加被拒。
  - 崩溃恢复：执行到一半中断 → `recover()` 继续，已完成项不重复。
- [ ] 提示词快照 / 工具注册测试更新（管家有、普通 Bot 无、任务无）。
- [ ] e2e `apps/desktop/test/e2e/handover.spec.ts`：移交卡渲染、勾掉一项、确认后进度与结果态（参照 `butler-proposal.spec.ts` 的桩法）。
- [ ] 收口：全量一次 + e2e 一次；独立 code-reviewer 审查（opus），修复后再合。

### 3.8 文档

- [ ] `docs/design/27-butler-and-delegation.md` §2.3 工具表补 `inspect_bot_assets` / `propose_handover`（指向 37）。
- [ ] `docs/dev/03-data-model.md` 补两张表与 approvals kind；`docs/dev/04-agent-runtime.md` 补工具面。
- [ ] 设计 37 状态行与本文件 §6 实施记录。

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

## 7. 风险

- **用户隔几天才确认**：资产已变化 → 执行前逐项重新校验，不成立的标 `skipped` 并写原因。
- **A 有运行中的任务正在用要移交的东西**：邮箱 / 连接应用撤除后 A 的工具调用失败。P0 接受（与用户在设置页解绑的效果一致），结果通知里提示。
- **记忆复制量大 / 向量模型未就绪**：`embedItem` 失败不阻塞写入，沿用既有的向量重建路径补齐。
- **与 D87 并行**：两边都动 `tools/index.ts`、`approvals.ts`、迁移号；合入第二个的一方负责重排迁移号与解决冲突。

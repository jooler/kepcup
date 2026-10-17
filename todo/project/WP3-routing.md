## 9. 实施记录

（执行智能体在此填写：分支、提交列表、测试结果、偏差编号。）

- 状态：已完成。
- 分支：`feat/project/migration`（延续 WP0–WP2 的集成分支；未另开 `feat/project/wp3-routing`，与 WP1 / WP2 先例一致）。
- 提交：
  - `dcdaeaa` `feat(shared,core,desktop)!: route un-targeted project messages through the lead gate (D92 T1a WP3)`（本 WP 全部代码与测试；因改名 / 契约 / 行为互相耦合，无法拆出「每个提交可独立构建」的多个提交，合成一个功能提交，见下「接续说明」）；
  - 实施记录与文档提交（`docs(todo,dev): record WP3 implementation and progress`；含 README §7、DEVIATIONS、01-conventions 常量表顺手同步）。
- **接续说明**：本 WP 由执行智能体接续前一位代理留下的未提交半成品完成（工作区约 33 个文件 + 同内容 stash 快照 `WP3 leftover snapshot before quota reset`）。核对结论：
  - **保留（质量合格，符合任务书与 §4 契约）**：`project-turn.ts`（协调器重写，含 guarded 兜底不变式与 BR-P05-001/002 处理）、`light-judgement.ts`（骨架参数化，行为与原 `triageOneBot` 一致）、`lead-gate.ts`（网关、`normalizeGateDecision` 宿主硬化、名册不含负责人）、`dispatcher.ts` 的 `judgeContinuation`（含 `reason` 字段与项目目标注入）、orchestrator 装配 / `#onProjectRoundEnded` / `downgradeLabel` / `mustReply` 摘除、mailbox 与 shared 契约、`MessagesService.lastVisibleBotMessage`、`projectWakeHint` 四行说明、desktop 最小修复（`project.turn` 订阅、`turn.routing` 文案）、四个新单测文件、project-chat / workbench* / dispatch / llm-router / supervisor-turn / settings-mode 测试改写。
  - **修正的偏差**：① `docs/design/41-project-team.md` 被半成品改坏（`[08](08-workdir.md)` 等四处链接被改成 `[08](-workdir.md)`，与 WP3 无关的损坏）→ 整文件还原（文档同步归 WP11）；② `MUST_REPLY_REASONS` 放在了 `domain/types.ts` → 移到 `constants.ts`（任务书步骤 1.2 / README §4.8 的字面位置，`import type` 不引入运行时环）；③ `lead-gate.ts` / `dispatcher.ts` 的未用 import（`lightModelRefForBot`、`builtinRoute`）、`project-turn.test.ts` 的未用 import / 变量（lint 报错）→ 清理；④ orchestrator 三处过时注释（「Group turns (P05): triage…」等）→ 改写；⑤ **workbench-update.test.ts 的 M1 用例（更新轮运行期间任务完成的交付语义）被整段删除且 describe 结构被破坏**——M1 与广播 triage 无关、不在 WP 允许删除范围 → 恢复 M1 原文与 `事项更新通知：审查修复` describe 结构，重写的 M2 归位其中；⑥ workbench.test.ts 被删除的「triage 全员 no_action」用例 → 按 WP §5 改写为「路由给成员但无可见回复 → 负责人兜底一次」的新断言（网关 `none` 已由相邻用例覆盖，两旧用例在新语义下分别落到这两个新路径）；⑦ coordinator 场景 b（forcedTarget 优先）缺测试、且半成品的 `onUserBatch` 无入口可测 → 增加可选 `options.forcedTarget` 入参并补测试（见 DEV-031）。
  - **补齐的缺口**：`test/integration/project-routing.test.ts`（任务书 §5.6 要求「必须有」的 9 场景端到端，半成品完全缺失）、`test/unit/response-tools-must-reply.test.ts`（必答轮工具面摘除 skip_reply）、project-turn 场景 b、`test/integration/task-timeline-visibility.test.ts` 的路由判断段改写（全量跑发现半成品漏改：该用例仍在等旧广播 triage 的双 Bot 判断请求——改为 P = X 的续接判断（X 视角含自己的私有条目）+ 负责人 Y 的网关（Y 视角无私有条目，泄露契约不变），并移到 @X 轮之后使 X 成为「上一位回话者」）。
- 偏差：**DEV-031**（WP3「`forcedTarget` 保留（工作台派发用）」的前提与代码现实不符：工作台派发自 WP1 起走结构化 @（`mentions: [leadBotId]`），`forcedTarget` 在删除 `groups.redistribute` 后已无生产调用方。按 WP 字面保留该分支并暴露可选入参以供场景 b 测试；`dispatchWorkbenchMessage` 维持结构化 @ 不变）。另两处不占编号的执行判断：① 旧「triage 全员 no_action」用例与「no_claim」用例在新语义下合并 / 改写为网关 `none` 与负责人兜底两条新断言（WP §5 明示「改为新断言」）；② `MUST_REPLY_REASONS` 落位 `constants.ts` 用 `import type { TriggerReason }`（types.ts → constants.ts 已有运行时 import，值级循环不可取）。
- 测试结果（定向全绿后收口跑一次全量）：typecheck 三包 + lint 通过；`project-turn` 15、`lead-gate` 8、`messages-last-replier` 5、`trigger-hints` 3、`response-tools-must-reply` 2、`llm-router` 15、`supervisor-turn`、`dispatch`、`runs-tasks`、`settings-mode`（shared 337）、`project-chat` 16、`project-routing` 9、`workbench` 25、`workbench-update` 39（M1–M5 / L4 / L5 完整）、`supervisor-turns` 集成、`task-timeline-visibility`、desktop 767 全部通过；全量 `pnpm test` **5413 通过 / 0 失败 / 23 skip**（第一次收口跑发现 `task-timeline-visibility` 仍在等旧广播 triage（半成品漏改，见上），改写后复核该文件通过并重跑一次全量确认，失败集合不超基线）。
- 验收清单核对（§7）：
  - `rg` 自检为空（`packages apps`，排除 dist / out / migrations）：✅（todo/ 历史任务书与本文档自身命中的为任务书文字与历史记录，非代码）；
  - 路由决策顺序与 §1 不变式：✅（project-turn 单测 a–o 15 场景 + 集成 ①–⑨）；
  - 静默路由无界面痕迹：✅（集成 ①④：消息列表只有用户消息与目标回复；无系统消息 / 卡片 / 负责人消息）；
  - 必答轮无 `skip_reply`、`continuation` / `routed_also` 有：✅（集成 ①②③⑤ + `response-tools-must-reply` 单测；合并批口径 `parts.some(∈ MUST_REPLY_REASONS)`）；
  - 网关与续接判断任何失败不丢消息：✅（`lead-gate` 无模型 / 非法输出降级 self、project-turn 场景 i、集成 ⑧、续接超时 / 节流沿用 `runLightJudgement` 的 fallback）；
  - 全量失败集合不超基线、实施记录已填：✅。
- WP1 / WP2 登记的归本 WP 遗留：project-chat 的 `it.skip // removed in WP3` 用例已删除（广播 triage / redistribute 语义不复存在）；`group_no_claim` 后端事件已删除（含渲染层残留检查，`rg` 为空）；01-conventions 常量表已顺手同步本 WP 四常量并移除已删除的 `BOT_CHAIN_MAX_DEPTH` 行（其余行的全面同步仍归 WP11）。

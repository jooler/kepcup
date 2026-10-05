# Loop 续接：跨 run 过程上下文回放

> 状态：**已实现并验收（2026-10-04）**。决策 D56；设计见 `docs/design/02-execution.md` "Loop 续接"，规范见 `docs/dev/04-agent-runtime.md` "续接段"。改动清单见第 5 节（全部勾销）。

## 1. 背景与目标

每个响应 loop 独立启动。对话层上下文（滚动摘要 + 最近消息）与 workspace 文件天然延续，但上一轮的**过程性上下文**（读过哪些文件、试过什么、为什么放弃）只在 `run_steps` 里，模型要自觉调用 `list_my_runs` / `get_run` 才能看到——不可靠，导致用户追着上一轮继续说话时，Bot 重新搜集、重复踩坑。

目标：

1. **默认续接**：上一 run 结束 30 分钟内的新触发，自动把该 run 的过程摘要回放进新 loop 上下文（确定性，零额外模型调用）。
2. **判断续接**：超出窗口但 24 小时内有候选 run 时，由轻量模型一次结构化判断决定是否续接、续接哪些 run。
3. **落盘边界**：旧 run 原样保留；新 run 记录 `continued_from_run_ids`；反思任务据此去重。

## 2. 现状追溯（链路结论）

- loop 已按"Bot + 对话"关联：`MailboxRegistry` key = `botId:conversationId`；`runs.conversation_id` 落库。执行中的新消息走 steer 注入（`mailbox.deliver` → `#steerRunningRun`），不新开 loop——续接只服务于"上一 loop 已结束"的场景。
- 新 loop 现有上下文 = `buildConversationContext`（summary + 最近 30 条 / 4000 token）+ 触发段；过程记录只在 `run_steps`。
- `run.summary` 由反思 job（优先级 2 后台）异步写入，新 loop 启动时通常尚未生成——回放摘要必须直接从 `run_steps` 构建（同步可用）。
- pi 的 `Agent` 由 `initialState.messages` 启动（当前只传一条 user 消息）；种子转录（原生 toolUse/toolResult 块）可行但受截断不变式与 pi 版本约束，本稿不做（见第 4 节非目标）。

## 3. 方案设计

两级解析（`core/src/agent/context/continuation.ts`）：

1. **L1 默认续接**：最新候选 run（`completed` / `failed` / `interrupted`，按 `endedAt` 倒序；`cancelled` 排除）的 `endedAt` 距今 ≤ `CONTINUATION_WINDOW_MS`（30 分钟）→ 直接回放。锚点是 run 结束时间，不是消息间隔。
2. **L2 判断续接**：不满足 L1 且 `CONTINUATION_ARBITER_MAX_AGE_MS`（24 小时）内有候选 → `completeStructured`（轻量模型，仿 triage）输出 `{ continueRunIds, reason }`；输出 id 不在候选集内丢弃；超时 / 失败 / 解析失败一律不续接（fail-open）。仲裁不建 run 行，用量记在本次响应 run 名下（`loopType: 'response'`，模型列记轻量模型）。

回放摘要：只读 `run_steps`（`seq` 正序，跳过 `request`）；`tool_call` → `[时间] 工具名(参数截断)`，`tool_result` 按 `toolCallId` 配对渲染，超过 `CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS` 的输出用"（已省略）"占位；`assistant` 按 `stopReason` 标注（说明）/（最终回复），截断 160 字符；`steer`/`progress` 照渲染。总量受 `CONTINUATION_REPLAY_TOKEN_BUDGET` 约束，超限从最早 run、run 内最早步骤丢弃并注明。段落位置：对话上下文段之后、触发段之前。

落盘：`runs.continued_from_run_ids_json`（迁移 `0003`）；`registerReflection` 携带续接来源，反思输入注明"旧 run 事实已提炼过，不要重复提取"。

## 4. 非目标

- **原生转录回放**（assistant/toolUse/toolResult 块级种子 + 跨 run prompt-cache 前缀复用）：需验证 pi 消息格式与截断不变式，作为后续优化。
- **UI 展示续接来源**（run 详情标注"续接自 run X"）：后续任务。
- **Warm session 保活**（loop 结束后保活 Agent 直接 continue）：与 D49（不自动恢复）、run 级预算/反思边界冲突，否决。
- **超过 24 小时的续接**：回落到现有对话层上下文 + `list_my_runs` 工具。

## 5. 改动清单（2026-10-04 实现完成）

- [x] `packages/shared/src/constants.ts`：`CONTINUATION_WINDOW_MS` / `CONTINUATION_ARBITER_MAX_AGE_MS` / `CONTINUATION_ARBITER_MAX_RUNS` / `CONTINUATION_ARBITER_TIMEOUT_MS` / `CONTINUATION_REPLAY_TOKEN_BUDGET` / `CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS` / `CONTINUATION_TEXT_MAX_CHARS`
- [x] `packages/shared/src/domain/types.ts`：`runSchema` 增 `continuedFromRunIds`
- [x] `packages/core/migrations/runs/0003_run_continuation.sql`：runs 表加列
- [x] `packages/core/src/domain/runs.ts`：行映射 + `update` 支持 `continuedFromRunIds`
- [x] `packages/core/src/agent/context/continuation.ts`：新模块（候选解析、摘要构建、仲裁输入与 schema）
- [x] `packages/core/src/dispatch/orchestrator.ts`：`#executeResponseRun` 接入续接解析；仲裁用量记账
- [x] `packages/core/src/memory/service.ts`：`registerReflection` 携带 `continuedFromRunIds`
- [x] `packages/core/src/memory/reflection.ts`：payload 解析 + 反思输入注记
- [x] `packages/core/test/unit/continuation.test.ts`：单测（L1 窗口、cancelled 排除、预算截断、仲裁 fail-open 与非法 id 过滤）
- [x] `packages/core/test/integration/response-loop.test.ts`：续接端到端用例
- [x] 顺带根治既有测试竞态：`environment.test.ts` 的「等 mailbox 空闲」等待是 `waitFor(() => ... ?? false)` 直通（false 被 waitFor 当作已满足），续接拉长 event run 后竞态稳定曝光——改为 `? true : null` 谓词（详见 `docs/dev/PROGRESS.md` 本节）；`wiki.test.ts` 并发入库的 body 级负向谓词改用附件 id 判别（回放合法内容撞线）；`skills.test.ts` 停用断言收窄到 system 消息；`create-core.test.ts` 迁移版本 2→3

## 6. 验收口径

1. run A 完成后数分钟内再发消息 → 新 run 的首条用户消息含 `<continuation>`，`continued_from_run_ids = [A]`。
2. 超 `CONTINUATION_WINDOW_MS` 后再发消息 → 无续接段；24h 内有候选时仲裁被调用（测试注入 mock），仲裁选中才回放。
3. 仲裁超时 / 抛错 / 输出非法 id → 不续接，响应 run 正常完成。
4. 上一个 run 为 `cancelled` 时不走 L1；仲裁可以选择它。
5. 回放超预算 → 从最早处截断并注明。
6. 反思 job payload 携带 `continuedFromRunIds`。
7. 既有测试全绿。

## 7. 风险

- 仲裁调用在响应 run 内联（不经 scheduler），上限 10s、fail-open；最坏情况首响延迟 10s——可接受（触发条件本身已排除 30 分钟内的常见路径）。
- 摘要与 `recent_messages` 中 Bot 消息文本重复：可接受（兜底消息滑出窗口的场景）。
- 反思去重依赖提示词注记，非硬保证：与现有"依据已有记忆去重"同级。

## 8. 待决策点（2026-10-04 已拍板）

- 回放格式用**文本摘要**而非原生转录：正确性与版本安全性优先，原生回放进非目标（第 4 节）。
- 仲裁不建独立 run 行：用量与归属挂在响应 run 上，避免 triage 式 run 行污染对话 run 列表。

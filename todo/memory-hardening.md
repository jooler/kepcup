# 记忆增强（对照《Agent 长期记忆》报告）：评估与实施方案

> 状态：**已实施**（2026-10-22，分支 `feat/memory-hardening`；任务 A/B/C/D 与 §6 回归均已完成，§7 按原计划不做）。来源：[docs/reports/2026-10-22-baibai-agent-long-term-memory.md](../docs/reports/2026-10-22-baibai-agent-long-term-memory.md)。
> 结论：报告对 KepCup 现状的判断**大体准确**，方向（点状增强，不推倒重做）也正确；但 **P0 的前提需修正**（硬事实并非只走 top-k，画像卡片本来就常驻），**P1「压缩前冲刷」不成立**（D93 压缩不删 `run_steps`，反思仍能读到完整过程）。本稿把增强收敛为 4 个任务：硬约束确定性注入、画像卡片一致性、纯对话反思去抖、注入可观测性与类型标签。
> 测试纪律（AGENTS.md）：迭代只跑定向测试；全量只在阶段收口或最终交付前跑一次。改动 shared 契约先 `pnpm --filter @kepcup/shared build`。
> 行号按 2026-10-22 的 `main` 记录，实施前以当前代码为准。

## 0. 结论速览

| 报告建议 | 评估 | 本稿动作 |
|---|---|---|
| 不要全量灌历史，按预算拼装 | 成立。画像卡片 400 token、top-k 600 token、状态 300 token 都已常驻/按轮注入 | 保持 |
| 硬事实结构化，零容错 | 方向成立。但「只出现在 top-k」不准确：画像卡片本来就每次注入。真实缺口是卡片由模型编译、可能被截断/过期，**不保证**边界与禁忌保留 | **任务 A**：从条目直接抽 `<hard_constraints>`，不依赖卡片和检索 |
| 纯对话轮按去抖窗口反思 | 成立。设计已写、实现未做（`04-memory.md:95` 自认缺口） | **任务 B** |
| 压缩 / 长任务前做记忆冲刷 | **不成立**。压缩只裁剪本次请求的 transcript，`run_steps` 完整保留；反思读的是 `run_steps`，且 system prompt 每轮重建 | 不立项，改为回归测试（§6） |
| 情景向量模糊召回、注入标签 | 部分成立。检索已有混合 top-k；但注入行不带 kind，模型分不清「画像事实」与「情景故事」 | **任务 D**：行内加 kind 标签 |
| 记忆组装可观测性 | 部分冗余。`run_steps` 的 `request` 已记录完整提示词，可复盘；缺的是聚合日志 | **任务 D**：debug 级结构化日志 |
| 冲突更新、遗忘退火 | 成立且已有 supersede / consolidation | 保持；补回归用例即可 |
| 按视频改成单 Agent 三层 | 不建议，会丢多 Bot 共享画像、承诺调度、Wiki/Skills 边界 | 不做 |

## 1. 报告逐条核对

### 1.1 报告说对的部分

- **分层与预算注入**：`04-memory.md:111-122` 的注入表与实现一致；`profileCardSection()`（`packages/core/src/memory/service.ts:858`）每次注入约 400 token 卡片，`relevantMemoriesSection()`（同文件 `:881`）按触发消息做 FTS + 向量 + RRF。
- **硬事实有结构化路径**：`MemoryItem` 的 `kind/source/confidence/sensitivity/valid_until` 与共享 `profile_items` 都在，不是全量向量化。
- **异步沉淀**：反思在 run 结算后登记（`packages/core/src/dispatch/orchestrator.ts:4728-4741`），不在 TTFT 主路径。
- **冲突与代谢**：`supersedes`、画像整理优先级、每日 consolidation 均已存在。
- **纯对话反思去抖是已知缺口**：`docs/design/04-memory.md:95` 与 `docs/design/30-supervisor-and-tasks.md:475-478` 都明确写了「按去抖窗口登记」，但代码是每个 completed run 登记一次（`service.ts:946-969`，去重键 `run:{runId}`）。
- **情景注入无类型标签**：`formatMemoryLine()`（`packages/core/src/memory/retrieve.ts:63-66`）只有 id 与 content，没有 kind。

### 1.2 报告需要修正的部分

1. **「过敏、禁忌若只出现在 top-k」不准确。**
   共享画像条目会被编译进 `<user_profile>` 并每次注入。真正的风险有三层：
   - 卡片是 LLM 自由文本，整理提示词只要求「400 token 摘要」（`profile-curation.ts:318`），**没有要求必须保留边界/禁忌**，截断时可能先丢；
   - 卡片可能为空或过期：用户直接在「Bot 大脑」编辑/撤回画像条目时，`updateProfile` / `retractProfile`（`service.ts:1087-1106`）只改条目，不触发重新编译；而整理 job 在没有 pending 提案时直接返回（`profile-curation.ts:59-62`），卡片会一直停留在旧内容；
   - 因此「硬约束」应当**直接读条目**，不能依赖卡片或检索分数。

2. **「可复用 sensitive-topics 与 kind/sensitivity」方向不对。**
   `mentionsSensitiveTopic()`（`packages/core/src/memory/sensitive-topics.ts:11-18`）是**隐私降级词表**（健康诊断、财务、感情），命中后条目只留 Bot 私有层，不解决「每次必须遵守」。它既漏「坚果过敏」（词表里没有过敏/忌口），又会把「月薪」误当硬约束。硬约束需要独立词表 + `profile_items.category = 'boundaries'`。

3. **「压缩前冲刷」的前提不成立。**
   D93 压缩器只影响本次模型请求看到的消息，agent transcript 与 `run_steps` 保持完整（`packages/core/src/agent/context/compaction.ts:17-29`；`pi-engine.ts:231-234`）。system prompt 在每次请求前重建（`pi-engine.ts:317-333`），记忆段也在其中。反思读取 `executionStepsSummary(runs, runId)`（`reflection.ts:114, 256-274`），数据源是 `run_steps`，不是被压缩的 transcript。因此不会因为压缩丢掉「尚未反思的事实」。

4. **「压缩前冲刷」之外，真正相邻的缺口是失败任务不反思。**
   只有 `completed` 的 run 才登记反思（`orchestrator.ts:4732`）。失败/中断的长任务里如果产生了 `lesson`，当前不会沉淀。这是产品取舍，不是报告说的压缩问题；本稿列为可选（§7），不与 P0/P1 混做。

### 1.3 报告明确不建议、本稿也同意的事

- 把用户硬事实只存向量库；
- 取消共享画像、改成单 Bot 封闭记忆；
- 主回复路径同步跑完整抽取 + embedding；
- 把 Wiki / 世界知识灌进记忆表；
- 为「对齐视频」新造一套三层记忆架构或新 D-number。

## 2. 总览

| # | 任务 | 优先级 | 规模 | 依赖 | 主要文件 |
|---|---|---|---|---|---|
| A | 硬约束确定性注入 `<hard_constraints>` | P0 | S–M | — | `memory/constraints.ts`（新）、`memory/service.ts`、`agent/context/system-prompt.ts`、`dispatch/orchestrator.ts` |
| B | 纯对话轮反思去抖 | P1 | M | — | `memory/service.ts`、`domain/jobs.ts`、`memory/reflection.ts`、`dispatch/orchestrator.ts` |
| C | 画像卡片一致性（直改后重编译） | P1 | S | — | `memory/profile-store.ts`、`memory/profile-curation.ts`、`memory/service.ts` |
| D | 注入可观测性 + 记忆类型标签 | P2 | S | A 完成后一起改 prompt | `memory/retrieve.ts`、`memory/service.ts`、`agent/context/system-prompt.ts` |

建议顺序：**A → C → B → D**。A 与 C 都改画像读取，先落 A 可以顺手验证卡片陈旧问题；B 单独提交；D 最后做。

## 3. 任务 A（P0）：硬约束确定性注入

### 3.1 现状

- 画像卡片每次注入（`service.ts:858-862`），但内容由整理 loop 生成，不保证包含 `boundaries`，也不保证未被截断。
- 用户直改画像后卡片不重编译（见任务 C），卡片可能落后于条目。
- 相关记忆 top-k 走 RRF + 可选重排（`retrieve.ts:97-160`），硬约束可能因本轮 query 与内容不相似而落选。
- 目前没有独立的硬约束段；`<user_profile>` 的提示词只说明「这是摘要，需要细节用工具查」（`system-prompt.ts:624`）。

### 3.2 做法

1. **新增纯函数模块** `packages/core/src/memory/constraints.ts`：
   - `collectHardConstraints({ profileItems, privateItems, isProject, now })` → `Array<{ id, content, source: 'profile' | 'private', privateToBot }>`；
   - 共享层：`category === 'boundaries'` 的 active 条目**全部**入选；其他 category 中命中硬约束词表的也入选；
   - 私有层：当前 Bot 的 active 条目中命中词表的入选；项目组对话中 `sensitivity === 'sensitive'` 的不入选（与 `passesFilters` 口径一致，`retrieve.ts:55-60`）；
   - 过滤 `validUntil !== null && validUntil <= now`；
   - 按 content 去重，保留共享层优先；最多 12 条，单条超过 120 字符截断；总预算由 `truncateToBudget` 控制。
2. **词表独立于敏感词表**，建议覆盖：`过敏|忌口|禁食|不能吃|不吃|禁止|不能|不要|必须|务必|避免|忌`。放在 `constraints.ts` 内并导出 `matchesHardConstraint(text)` 供单测。不要把 `mentionsSensitiveTopic` 拼进来。
3. **共享常量** `packages/shared/src/constants.ts`：
   - `HARD_CONSTRAINT_TOKEN_BUDGET = 200`
   - `HARD_CONSTRAINT_MAX_ITEMS = 12`
4. **`MemoryService.hardConstraintsSection(botId, conversationId)`**：
   - `profileStore.list('active')` + `storeFor(botId).activeItems()`（后者默认会返回全部状态，必须显式取 active；Bot 不存在时返回 `''`）；
   - 调 `collectHardConstraints`，用 `truncateToBudget`；
   - 正文格式：`- [id] content`；`privateToBot` 或 `origin === 'private'` 追加 `（来自私聊，不要在群聊中透露）`；
   - 段落头：`以下为用户明确的硬性约束；每次都必须遵守，不依赖本轮检索；与本轮请求冲突时先向用户确认。`
   - 段落标签由 prompt 组装层加，service 只返回正文（与 `relevantMemoriesSection` 一致）。
5. **系统提示词**：
   - `SystemPromptInput` / `AgentRunContextInput` 增加 `hardConstraints?: string`；
   - `buildSystemPrompt()` 在 `<user_profile>` 之后、`<my_state>` 之前插入 `section('hard_constraints', ...)`（`system-prompt.ts:624`）；
   - `buildAgentRunContext()` 同样插入（`system-prompt.ts:1054` 之后），保证外部 Agent 也拿到；
   - 平台规则补一句：硬约束段是必须执行的用户约束，不是「可能过时的记忆」，不要因为本轮话题无关而忽略。
6. **orchestrator 接线**：
   - `memorySections`（`orchestrator.ts:4103-4121`）增加 `hardConstraints: memoryFacade.hardConstraintsSection(...)`；
   - `#agentRunSetup` 的 `memorySections` 类型（`orchestrator.ts:2835-2843`）同步加字段；
   - MemoryFacade 接口（`orchestrator.ts:563-567`）同步加方法。
7. **画像整理提示词**：`CURATION_PROMPT`（`profile-curation.ts:312-319`）补一条「卡片必须保留用户边界与硬约束（过敏、忌口、明确禁止项）；空间不足时先删例子和故事」。这是第二道保险，主保险仍是第 1 步的确定性抽取。
8. **设计文档**：`docs/design/04-memory.md` 注入表加一行 `<hard_constraints>`（总是，~200 token），并写明「直接读条目，不依赖卡片/检索」。

### 3.3 测试

- 新增 `packages/core/test/unit/memory-constraints.test.ts`：
  - `boundaries` 条目无条件入选；普通 fact 不入选；
  - 「我对坚果过敏」命中；「月薪 3 万」不命中（隐私词表不参与）；
  - `validUntil` 过期过滤；项目组排除 sensitive；`privateToBot` 标注；
  - 去重、条数上限、token 截断。
- `packages/core/test/unit/context-assembly.test.ts`：
  - 传入 `hardConstraints` 时，段落位于 `<user_profile>` 与 `<my_state>` 之间；
  - 未传时整段省略，不留空标签。
- `packages/core/test/integration/memory.test.ts` 或新增集成用例：
  - 写入「我对坚果过敏」后，下一轮组装出的 system prompt 含 `<hard_constraints>` 与该内容；
  - 查询「推荐甜点」且检索结果为空时仍然包含（证明不依赖 top-k）；
  - 撤回条目后下一轮不再包含。
- 定向命令：
  - `node scripts/run-tests.mjs run packages/core/test/unit/memory-constraints.test.ts packages/core/test/unit/context-assembly.test.ts packages/core/test/integration/memory.test.ts`
  - `pnpm --filter @kepcup/core typecheck`

### 3.4 验收

- 用户说「记住，我对坚果过敏」后，任意后续轮次（包括与饮食无关的轮次）的 system prompt 都有该约束。
- 用户撤回/删除该条目后，下一轮不再注入；不依赖卡片是否已重编译。
- 项目组对话中，共享 `boundaries` 注入；Bot 私有的 sensitive 条目不注入。
- 新增段落总 token 不超过 200（按现有 `estimateTokens` 口径）。

## 4. 任务 B（P1）：纯对话轮反思去抖

### 4.1 现状

- `registerReflection` 对每个 completed run 入队一次，去重键 `run:{runId}`（`service.ts:946-969`）。
- `orchestrator.ts:4732-4741` 对「完成的对话轮」和「完成的任务」都调用；任务侧还要求 `runs.get(runId)?.status === 'completed'`。
- 设计明确要求纯对话轮按去抖窗口登记（`docs/design/30-supervisor-and-tasks.md:475-478`；`04-memory.md:95` 记录实现缺口）。
- `JobsService.enqueue` 的 dedupe 冲突是 `do nothing`（`domain/jobs.ts:61-85`），不能自动合并 payload；`hasten` 只能提前，不能追加（`:158-164`）。

### 4.2 做法

1. **区分 run 类型**：`registerReflection` 入参增加 `kind: 'turn' | 'task'`（orchestrator 传 `isTask ? 'task' : 'turn'`）。任务保持现有即时登记；只有纯对话轮走去抖。
2. **共享常量**（`packages/shared/src/constants.ts`）：
   - `REFLECTION_TURN_DEBOUNCE_MS = 10 * 60_000`（首轮后 10 分钟触发；开放问题见 §8）
   - `REFLECTION_TURN_DEBOUNCE_MAX_RUNS = 6`（窗口内攒够 6 轮立即触发，避免长会话一直不反思）
3. **JobsService 增加合并能力**：
   - `mergePendingPayload(dedupeKey, updater): boolean`：事务内查 `status='pending'` 行，`updater(payload)` 后写回；没有 pending 行返回 false；
   - 不改变现有 `enqueue` 语义，避免影响其他 job。
4. **`registerReflection` 的 turn 分支**：
   - dedupe key：`reflection_debounce:{botId}:{conversationId}`；
   - 首次：`enqueue({ type:'reflection', runAfter: now + window, payload:{ entries:[entry] } })`；
   - 后续：`mergePendingPayload` 追加 entry（按 runId 去重）；**不延长** `run_after`；entries 达到上限时 `hasten(key, now)`；
   - 若 pending 行已被 claim（running），`merge` 返回 false，则按同一 key 重新 `enqueue`（partial unique index 只约束 pending，允许 running 与新 pending 并存）。
5. **任务完成时冲刷**：任务反思入队后，`hasten('reflection_debounce:{botId}:{conversationId}', now)`，把窗口内尚未反思的对话轮立即跑掉，避免任务已覆盖的上下文被重复提炼或长期滞留。
6. **反思 job 支持多 run**：
   - payload 兼容旧格式（`runId` / `continuedFromRunIds`）与新格式（`entries[]`）；
   - 聚合：trigger message ids 取并集；bot messages 取各 run `outputMessageIds` 的并集；`executionStepsSummary` 逐 run 拼接后整体截断 4000 字符；
   - 反思输入加 `<debounced_runs>id1,id2</debounced_runs>`，提示模型「这些轮次合并反思，不要重复提取」；
   - `recall()` 的 query 用合并后的触发文本；
   - `wiki_suggestion` / `skill_suggestion` 的 dedupe key 改用 `primaryRunId`（第一条 entry）+ index，避免多 run 冲突；
   - runSummary 只写到 primary 轮（第一条 entry），其余轮 summary 留空是有意为之（`runs.summary` 是单值，逐轮覆写同一段摘要只会互相覆盖）。
7. **不变量**：
   - 显式 `remember` 不入此队列，仍然即时写入；
   - 任务反思仍是 `run:{runId}`，不受窗口影响；
   - 对话删除时，现有 `cancelByConversation` 会取消 pending job（`jobs.ts:187-193`），无需新逻辑。

### 4.3 测试

- 新增 `packages/core/test/unit/jobs-merge-payload.test.ts`：
  - 同 dedupe key 连续 merge，payload 累积且 `run_after` 不变；
  - running 状态下 merge 返回 false；
  - 达到上限时 `hasten` 生效。
- `packages/core/test/unit/memory-reflection-input.test.ts`：
  - 多 entry 输入渲染 `<debounced_runs>`；
  - 旧 payload 仍按原格式渲染。
- `packages/core/test/integration/memory-reflection.test.ts`：
  - 连续 2 个 completed 对话轮 → 只产生 1 个 reflection run，两个 run 的记忆都写入；
  - 任务完成 → 窗口内 pending 的对话轮反思被提前执行；
  - 同一 run 重复登记不产生重复条目。
- 定向命令：
  - `node scripts/run-tests.mjs run packages/core/test/unit/jobs-merge-payload.test.ts packages/core/test/unit/memory-reflection-input.test.ts packages/core/test/integration/memory-reflection.test.ts`
  - `pnpm --filter @kepcup/core typecheck`

### 4.4 验收

- 10 轮纯闲聊在窗口内只触发一次反思（或达到 6 轮上限时触发一次），后台 run 数明显下降。
- 任务结算后，之前窗口内的对话轮不会被遗漏。
- 反思产出的记忆与逐轮登记相比不丢关键事实；现有 reflection 集成用例不回归。

## 5. 任务 C（P1）：画像卡片一致性

> 这是报告未提、但与 P0 直接相关的真实缺口：用户改/删画像后，卡片仍是旧内容，可能导致「已经撤回的禁忌仍被注入」或「新禁忌不出现」。

### 5.1 现状

- `updateProfile` / `retractProfile` 只改 `profile_items`（`service.ts:1087-1106`），不调度整理。
- `runProfileCurationJob` 在 `pending.length === 0` 时直接完成，不重编译卡片（`profile-curation.ts:59-62`）。
- `profileCardSection()` 只读 `profile_card`（`service.ts:858-862`）。
- `profile_card` 有 `compiled_at`，`profile_items` 有 `updated_at`（`migrations/main/0008_p07_memory.sql`），可无迁移判断陈旧。

### 5.2 做法

1. `ProfileStore.cardIsStale(): boolean`：
   - `getCard().compiledAt === null` 且存在条目 → stale；
   - 否则比较 `compiledAt` 与 `max(updated_at)`（**全部条目，不限状态**——撤回/取代也会改 `updated_at`，同样要求重编译卡片），`max > compiledAt` → stale；
   - 用 `>` 而不是 `>=`，避免同一毫秒内的正常写入误判。
2. `runProfileCurationJob`：
   - 计算 `stale = store.cardIsStale()`；
   - `pending.length === 0 && !stale` 才早退；
   - stale 时即使没有提案也跑一次整理，输入 `<pending_proposals>（空）</pending_proposals>`，只重编译卡片；
   - `setCard()` 后自然不再 stale。
3. `updateProfile` / `retractProfile` 在内容、分类或状态实际变化后调用 `this.scheduleCuration(true)`（立即整理，复用现有 `hasten` 逻辑，`service.ts:644-662`）。
4. 如果同一毫秒边界在测试中不稳定，再加 `profile_card.dirty` 列（迁移号用 0048 起的下一个空位——0047 已被 share_intakes 占用）；先用时间戳方案，避免迁移。
5. 设计文档：`04-memory.md` 的画像整理段补一句「用户直改/撤回后立即重编译卡片」。

### 5.3 测试

- `packages/core/test/unit/memory-store.test.ts` 或新增 profile-store 用例：
  - 无卡片 + 有条目 → stale；
  - `setCard` 后不 stale；
  - `updateContent` / `retract` 后 stale。
- `packages/core/test/integration/memory.test.ts`：
  - 用户编辑边界条目 → curation job 运行后卡片包含新内容；
  - 撤回条目 → 卡片不再包含旧内容；
  - 无提案且无变化时不额外跑 curation。
- 定向命令：
  - `node scripts/run-tests.mjs run packages/core/test/unit/memory-store.test.ts packages/core/test/integration/memory.test.ts`
  - `pnpm --filter @kepcup/core typecheck`

### 5.4 验收

- Bot 大脑里编辑/删除画像后，下一次回复的 `<user_profile>` 反映最新内容（允许一个整理 job 的延迟，默认 60s；立即整理路径应更快）。
- 不产生重复整理 job；无变化时不增加后台调用。

## 6. 报告 P1「压缩前冲刷」：不立项，改为回归验证

### 6.1 结论

不需要在 compaction 前触发反思或记忆冲刷。证据：

- 压缩器注释明确「只影响本次模型请求看到的消息；agent transcript 与 `run_steps` 保持完整」（`packages/core/src/agent/context/compaction.ts:17-29`）。
- `prepareRequest` 每次请求前重建 system prompt（`pi-engine.ts:317-333`），记忆段、硬约束段都在 system prompt 里，不随 transcript 压缩丢失。
- 反思输入的执行步骤来自 `runs.stepsFor(runId)`（`reflection.ts:256-274`），与压缩后的 transcript 无关。
- 反思输入本来就不含工具参数与结果（BR-P07-009），所以「压缩丢工具输出导致反思丢事实」也不成立——这些内容本来就不进反思。

### 6.2 要做的事

- 新增 `packages/core/test/unit/context-compaction.test.ts` 用例（或扩展已有用例）：
  - 构造一个含用户约束与工具结果的任务 transcript，触发压缩；
  - 断言压缩后的本次请求消息里，system prompt 仍包含 `<hard_constraints>` 与 `<user_profile>`；
  - 断言 `run_steps` 未被修改（压缩前后步骤数一致）。
- 在 `docs/design/43-task-loop-harness.md` 的压缩节补一句「记忆不依赖 transcript，压缩前无需冲刷」，防止后续重复讨论。

## 7. 可选（需产品确认）：失败任务的经验沉淀

报告没提，但设计里「失败或成功带来的经验教训」属于应记内容（`04-memory.md:70-77`），而当前只有 completed run 登记反思（`orchestrator.ts:4732`）。如果要做：

- 只对 `failed` 的 **task** 登记一次轻量反思，prompt 限定只产出 `lesson` / `feedback`，不产出用户画像提案；
- 用独立 dedupe key `reflection_failed:{runId}`，避免与正常反思重复；
- 失败任务通常上下文已乱，收益不确定，先做数据观察（统计失败任务里是否出现可复用教训）再决定。

本稿不把它放进 P0/P1，避免扩大范围。

## 8. 任务 D（P2）：注入可观测性 + 记忆类型标签

### 8.1 类型标签

- `formatMemoryLine()`（`retrieve.ts:63-66`）改为 `- [id | kind] content`，例如 `- [mem_x | episode] 上次聊到创业压力很大`。
- `<relevant_memories>` 段落头补一句：`kind=episode / feedback 是过往经历或评价，不是当前事实或硬约束；硬约束见 <hard_constraints>。`
- 更新 `packages/core/test/unit/memory-retrieval.test.ts:80-84` 的格式断言；补一条 episode 行的断言。
- 不改变 `recall_memory` 工具的输出格式（工具侧仍按原格式），避免影响模型对工具的既有使用；如果后续要统一，再单独改。

### 8.2 可观测性

- `relevantMemoriesSection()` 成功检索后打 debug 日志：`{ botId, conversationId, ids, topK, truncated, isProject }`（不记录 content）。
- `hardConstraintsSection()` 打 debug 日志：`{ botId, conversationId, ids, truncated }`。
- 不新建面板：`run_steps` 的 `request` 已保存完整提示词，排查单轮问题用它；debug 日志用于统计「注入率 / 截断率 / 空注入」。
- 如需长期指标，再考虑在 `usage_ledger` 或 run 表加计数字段；本期不做。

### 8.3 测试

- `node scripts/run-tests.mjs run packages/core/test/unit/memory-retrieval.test.ts packages/core/test/unit/context-assembly.test.ts`
- `pnpm --filter @kepcup/core typecheck`

### 8.4 验收

- 注入行带 kind，模型能区分事实与故事；现有检索排序与预算不变。
- debug 日志能回答「本轮注入了哪些 id、是否被截断」，且不包含记忆正文。

## 9. 明确不做

- 不把硬事实只存向量库，或改成「标准三层 Demo」；
- 不取消共享画像 / 多 Bot 私有记忆的产品结构；
- 不在主回复路径同步跑抽取与 embedding；
- 不把 Wiki / 世界知识重新灌进记忆表；
- 不为硬约束新增 `MemoryKind` 或数据库迁移（用现有 `boundaries` + 词表）；
- 不重做 episode 切片与向量评测集；当前 episode 是里程碑粒度，先补类型标签，等产品明确「陪伴温度」需求再立项；
- 不做「压缩前冲刷」（理由见 §6）。

## 10. 开放问题

1. **去抖窗口取值**：默认 10 分钟 / 最多 6 轮是否合适？需要在真实会话里观察反思延迟与队列长度；常量放 shared，后续可调。
2. **硬约束是否跨 Bot 共享**：当前方案是共享 `boundaries` 全 Bot 可见，Bot 私有约束只在 owner 内生效；如果产品希望「过敏」这类健康约束跨 Bot 共享，需要产品明确是否突破「敏感信息默认不进共享层」的规则。
3. **项目组里的私有约束**：本稿按现有检索口径，项目组排除 sensitive、保留 private 并标注「来自私聊」；是否更保守地完全排除，需要隐私评审。
4. **失败任务反思**：见 §7，先观察再决定。
5. **卡片陈旧判定**：时间戳方案在同一毫秒写入的极端情况下可能误判；如果测试或现网出现，再升级为 `profile_card.dirty` 迁移。

## 11. 改动清单（实施时勾选）

- [x] A1 `packages/shared/src/constants.ts`：`HARD_CONSTRAINT_TOKEN_BUDGET` / `HARD_CONSTRAINT_MAX_ITEMS`
- [x] A2 `packages/core/src/memory/constraints.ts`：纯函数 + 词表 + 单测
- [x] A3 `packages/core/src/memory/service.ts`：`hardConstraintsSection()`
- [x] A4 `packages/core/src/agent/context/system-prompt.ts`：类型 + 两处 section + 规则
- [x] A5 `packages/core/src/dispatch/orchestrator.ts`：facade 类型 + `memorySections` + `#agentRunSetup` 类型
- [x] A6 `packages/core/src/memory/profile-curation.ts`：卡片保留边界规则
- [x] A7 `docs/design/04-memory.md`：注入表 + 说明
- [x] B1 `packages/shared/src/constants.ts`：去抖窗口 / 上限
- [x] B2 `packages/core/src/domain/jobs.ts`：`mergePendingPayload()`
- [x] B3 `packages/core/src/memory/service.ts`：turn 去抖 + task 冲刷
- [x] B4 `packages/core/src/memory/reflection.ts`：多 run 聚合
- [x] B5 `packages/core/src/dispatch/orchestrator.ts`：传 `kind`
- [x] B6 `docs/design/04-memory.md` / `30-supervisor-and-tasks.md`：去掉「去抖未实现」缺口标注
- [x] C1 `packages/core/src/memory/profile-store.ts`：`cardIsStale()`
- [x] C2 `packages/core/src/memory/profile-curation.ts`：stale 时重编译
- [x] C3 `packages/core/src/memory/service.ts`：直改/撤回后 `scheduleCuration(true)`
- [x] D1 `packages/core/src/memory/retrieve.ts`：kind 标签 + 段落头说明
- [x] D2 `packages/core/src/memory/service.ts`：debug 日志
- [x] D3 回归：压缩不丢记忆段（§6）

# 任务 Loop Harness 实施文档（D93）

> 写于 2026-10-21。状态：**已实施 P0–P4（2026-10-21）**。
>
> 关联文档：
> - 设计篇：[docs/design/43-task-loop-harness.md](../docs/design/43-task-loop-harness.md)（D93）
> - 任务模型：[docs/design/30-supervisor-and-tasks.md](../docs/design/30-supervisor-and-tasks.md)
> - 任务执行过程页：[docs/design/42-task-run-view.md](../docs/design/42-task-run-view.md)
> - 运行时规范：[docs/dev/04-agent-runtime.md](../docs/dev/04-agent-runtime.md)
> - 设置目录：[docs/design/38-conversational-settings.md](../docs/design/38-conversational-settings.md)

## 1 目标与范围

给**内置 pi 引擎跑的任务**补齐主流编程 Agent 的核心 harness：

1. 自动上下文压缩，长任务不因窗口溢出失败；
2. `update_plan` 结构化计划，并把 `<current_plan>` 注入每轮请求；
3. 任务软预算、空转检测、代码任务验收规则；
4. 在已有任务执行过程页里结构化渲染计划（不新建页面）。

外部智能体（Claude / Codex / OpenCode / Cursor / DSH 等）任务使用各自原生 harness，本实施不改变其工具面、会话与权限桥。

## 2 现状与前置事实

- 内置任务引擎：`packages/core/src/agent/pi-engine.ts`；`pi-agent-core` 已提供 `transformContext` 钩子，当前未使用。
- 任务工具面：`packages/core/src/tools/index.ts`，任务分支在 `identity.loopType === 'task'` 的 `finalize([...])`；当前没有 todo / plan 工具。
- 任务执行过程页：`apps/desktop/.../tasks/TaskRunView.svelte` + `task-run-view.ts` 已渲染 `assistant` / `tool` / `progress` / `steer` / `system`；入口是 `TaskCard.svelte`，已实现「点击任务卡 → 执行过程页」。**计划结构化展示未实现**。
- 设置目录：`packages/shared/src/settings-catalog/items.ts` 是唯一事实来源；通用组条目在 `// --- 通用` 段；适配器在 `packages/core/src/settings/adapters.ts`；设置卡字段编辑在 `settings-card/FieldEditorCard.svelte`。
- 设置页通用分区：`apps/desktop/.../features/settings/GeneralSection.svelte`，锚点由 `SettingsSectionView.svelte` 承载。
- shared 契约变更后必须先 `pnpm --filter @kepcup/shared build`；core 变更后 `pnpm --filter @kepcup/core build`。

## 3 阶段与依赖

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | 上下文压缩 | 无 |
| P1 | `update_plan` + `<current_plan>` 注入 | 无（与 P0 可并行，但建议先 P0） |
| P2 | 软预算、空转检测、设置目录与通用设置页 | P1（计划提示词可共用） |
| P3 | 任务执行过程页计划渲染、工具输出落盘、详细历史读取 | P1 / P2 |
| P4 | 反馈闭环：异常停止映射、用户取消唤醒、无活动看门狗、可配置最长运行时间 | P2 / P3 |

每个阶段独立可交付；P0 / P1 完成即可让长任务显著稳定。P2 / P3 不改变任务状态机。P4 是 D93 收口：把 4 小时墙钟从固定常量改为可配置兜底，并补齐所有异常结果的 Bot 反馈。

## 4 P0：上下文压缩

### 4.1 任务

- [ ] `packages/shared/src/constants.ts` 新增 `TASK_CONTEXT_COMPACT_RATIO`、`TASK_CONTEXT_KEEP_RECENT_RATIO`、`TASK_CONTEXT_MIN_MESSAGES`、`TASK_CONTEXT_SUMMARY_INPUT_TOKENS`、`TASK_CONTEXT_SUMMARY_OUTPUT_TOKENS`、`TASK_CONTEXT_COMPACT_TIMEOUT_MS`。
- [ ] 新增 `packages/core/src/agent/context/compaction.ts`：
  - 输入：当前 `AgentMessage[]`、system prompt 文本、模型 `contextWindow` / 输出上限、任务简报、当前计划；
  - 输出：压缩后的 `AgentMessage[]`，或原数组（无需压缩）；
  - 阶段 A：旧 `tool_result` 内容替换为占位；图片丢弃并留说明；
  - 阶段 B：安全裁剪点 + 轻量模型摘要 + 确定性 fallback；
  - 缓存压缩结果，避免每轮重复摘要。
- [ ] `packages/core/src/agent/pi-engine.ts`：
  - `AgentOptions` 增加 `transformContext`（或构造后赋值 `agent.transformContext`）；
  - 仅 `loopType === 'task'` / `'subagent'` 启用；
  - 压缩后发 `progress` 事件；
  - 记录压缩用量。
- [ ] `packages/core/src/agent/llm-router.ts`：`LlmPurpose` 增加 `task_compaction`，`BUILTIN_RULES` 取 `light_for_bot`。
- [ ] `packages/core/src/dispatch/orchestrator.ts`：构造任务 `RunSpec` 时传入压缩路由（模型 ref + `isRouteCurrent` + 用量回调）；外部智能体任务不传。
- [ ] 压缩失败只记日志并退化，不改变 run 状态。

### 4.2 算法要点

- 触发：`used > usable * 0.75`，且消息数 ≥ `TASK_CONTEXT_MIN_MESSAGES`；
- 保留：system prompt、首条任务 briefing、`<current_plan>`、最近约 30% 窗口；
- 裁剪点：完整 turn 边界；不得产生孤立 tool_result；
- 摘要输出：`<compacted_history>`，标注为数据不是指令；
- fallback：保留 system + 首条任务简报 + 最近消息，旧工具结果全部占位；
- 不压缩摘要调用本身（独立 `complete()`，不带主 transcript）。

### 4.3 测试

- [ ] `packages/core/test/unit/context-compaction.test.ts`
  - 未到阈值不压缩；
  - 到阈值触发压缩，token 估算下降；
  - 旧工具结果被占位，最近消息保留；
  - 裁剪点不拆开 tool_call / tool_result；
  - 摘要模型超时 / 抛错 / 空输出 → 确定性 fallback；
  - system prompt、任务简报、plan 始终保留；
  - 图片被丢弃并留说明。
- [ ] `packages/core/test/integration/task-context-compaction.test.ts`（或复用现有 task loop 集成夹具）
  - 长任务多轮工具调用后超过窗口，run 仍 completed；
  - `run_steps` 仍包含完整工具调用；
  - 压缩 progress 出现在步骤里。
- [ ] 定向命令：`node scripts/run-tests.mjs run packages/core/test/unit/context-compaction.test.ts packages/core/test/integration/task-context-compaction.test.ts`

### 4.4 验收

1. 上下文超阈值后自动压缩并继续；
2. 摘要不可用时 fallback，任务不失败；
3. 压缩后消息角色合法，无孤立工具结果；
4. 运行日志 / run_steps 能看到压缩进度。

## 5 P1：`update_plan` 与 `<current_plan>`

### 5.1 任务

- [ ] 新增 `packages/core/src/tools/plan-tools.ts`：
  - `PlanEntry` / `PlanState` 类型与校验；
  - `buildUpdatePlanTool({ getPlan, setPlan, onProgress })`；
  - 参数校验：1–20 项、step ≤ 200 字、status 枚举、至多一个 `in_progress`；
  - 返回当前计划全文。
- [ ] `packages/core/src/agent/pi-engine.ts`：
  - `startRun` 为 `loopType === 'task'` 创建 run 级计划状态；
  - 把 `update_plan` 追加到本次 `piTools`（仅内置引擎任务；外部智能体不注入）；
  - `prepareRequest` 在 system prompt 末尾追加 `<current_plan>` 与简短规则；
  - plan 更新时发 `progress`（`计划 x/y：当前步骤`）。
- [ ] `packages/core/src/agent/context/system-prompt.ts`：任务版 `<platform_rules>` 增加计划与验收规则（见设计 §4.5 / §7）。
- [ ] 确认 plan 不进入压缩摘要；`buildRunDigest` 的 progress 行足以跨 `continues_task_id` 回放。

### 5.2 工具契约

```ts
update_plan({
  explanation?: string,
  plan: Array<{ step: string, status: 'pending' | 'in_progress' | 'completed' }>
})
```

- 全量替换；
- 至多一个 `in_progress`；
- 空计划 / 超过 20 项 / step 超长 / 非法状态 → `INVALID_INPUT`，不修改旧计划。

### 5.3 测试

- [ ] `packages/core/test/unit/plan-tool.test.ts`
  - 合法计划写入并返回；
  - 2 个 in_progress / 空计划 / 超长 step / 非法 status 被拒；
  - progress 文本与计划一致。
- [ ] `packages/core/test/integration/task-plan.test.ts`
  - 任务调用 `update_plan` 后下一次模型请求的系统提示包含 `<current_plan>`；
  - 计划更新后旧计划被替换；
  - `run_steps` 包含 update_plan 调用与 progress；
  - `continues_task_id` 的 digest 能出现计划行。
- [ ] 定向命令：`node scripts/run-tests.mjs run packages/core/test/unit/plan-tool.test.ts packages/core/test/integration/task-plan.test.ts`

### 5.4 验收

1. 内置任务能调用 `update_plan`，外部智能体任务工具面不变；
2. 下一轮请求系统提示包含当前计划；
3. 任务卡最近进度显示计划摘要；
4. 任务续接能看到上一轮计划。

## 6 P2：软预算、空转检测与设置

### 6.1 设置契约

- [ ] `packages/shared/src/domain/types.ts`：`settingsSchema` 增加：

```ts
taskLoop: z.object({
  idleGuardEnabled: z.boolean().default(true),
  idleWarnAfter: z.number().int().min(2).max(10).default(3),
  idleStopAfter: z.number().int().min(3).max(20).default(6),
  idleWindowCalls: z.number().int().min(3).max(50).default(12),
  tokenSoftBudget: z.number().int().min(0).max(10_000_000).default(0),
  stallTimeoutMinutes: z.number().int().min(0).max(120).default(20),
  maxWallMinutes: z.number().int().min(0).max(1_440).default(240),
}).prefault({})
```

  说明：schema 只做粗边界；`idleStopAfter > idleWarnAfter`、`idleWindowCalls >= idleStopAfter` 由适配器 `normalize` 校验。

- [ ] `packages/shared/src/settings-catalog/types.ts`：`settingFieldSpecSchema` 增加可选 `min` / `max` / `step`（number 字段用），供设置页与卡片共享。
- [ ] `packages/shared/src/settings-catalog/items.ts`：`// --- 通用` 段新增 `general.task-loop`：
  - group `general`；scope `global`；owner `core`；
  - fields：`idleGuardEnabled`（toggle）、`idleWarnAfter`（number）、`idleStopAfter`（number）、`idleWindowCalls`（number）、`tokenSoftBudget`（number）、`stallTimeoutMinutes`（number）、`maxWallMinutes`（number）；
  - `write: write('confirm')`；`card: 'field-editor'`；
  - deepLink `{ surface:'settings', section:'general', anchor:'general-task-loop' }`；
  - `store: { kind:'settings', paths:['taskLoop'] }`；
  - keywords：空转、循环、重复、预算、任务 Loop。
- [ ] `packages/core/src/settings/adapters.ts`：
  - `'general.task-loop'` 适配器：read 返回当前值与人话摘要；write 合并 `settings.taskLoop`；
  - `normalize` 校验交叉约束，非法返回可读错误；
  - `valuesWiden` 返回 false；
  - 注册进 `buildItemAdapters`。
- [ ] `apps/desktop/.../settings-card/FieldEditorCard.svelte`：
  - 支持按 `field.type` 渲染 `number` / `toggle`（不再只按字段名硬编码）；
  - `general.task-loop` 的读值与提交分支；
  - 保留现有 `models.widget-review` / `models.concurrency` / `agents.default` / `general.launch-at-login` 行为。
- [ ] `apps/desktop/.../features/settings/GeneralSection.svelte`：
  - 新增「任务 Loop」块，`data-settings-anchor="general-task-loop"`；
  - 开关 + 六个数字输入 + 保存；
  - 校验错误就地提示；
  - 写 `settingsStore.update({ taskLoop })` 或 `settings.items.apply`（与设置卡共用适配器）。
- [ ] i18n：`settings.taskLoop.*`、`settingCard.taskLoop.*`。
- [ ] 设置测试：
  - `packages/shared/test/unit/settings-catalog.test.ts`（条目、字段、深链、卡片映射）；
  - `packages/core/test/unit/settings-item-writes.test.ts`（读写、交叉校验、越界拒绝）；
  - `apps/desktop/.../settings-card/card-components.test.ts`（field-editor 映射）；
  - 设置页锚点扫描测试（`settings-ui-scan.ts` / `anchor-scroll.test.ts`）。

### 6.2 空转检测

- [ ] 新增 `packages/core/src/agent/loop-guard.ts`（纯逻辑，可单测）：
  - `canonicalArgs(args)`：稳定键序 JSON；
  - `hashCall(toolName, args, result)`；
  - `record(...)` 返回 `ok` / `warn` / `block`；
  - 环形窗口：最近 `idleWindowCalls` 次；
  - 收到 steer / inject 时 `reset()`。
- [ ] `packages/core/src/agent/pi-engine.ts` 工具执行包装：
  - 工具执行前检查 `block`，命中则直接返回 `LOOP_DETECTED`，不执行；
  - 工具执行后记录 `toolName + args + result`；
  - `warn`：在结果尾部追加提示并发 progress；
  - `block` 后仍重复：abort run，错误码 `LOOP_DETECTED`；
  - 仅在 `loopType === 'task'` 且 `idleGuardEnabled` 时启用。
- [ ] 设置读取：orchestrator 在构建任务 run 时把 `settings.taskLoop` 传给 `RunSpec`（或 `PiEngine` 依赖），缺省用默认值。

### 6.3 软预算

- [ ] `packages/core/src/agent/pi-engine.ts` 的 `finishTurn`：
  - 读取 `tokenSoftBudget`；0 = 关闭；
  - 80% 时只注入一次 steer；
  - 100% 时注入收敛指令，下一轮结束前要求最终结果；
  - 不直接 abort；任务墙钟与现有 reaper 不变。
- [ ] 用量口径：`tokensSoFar()` 为 input+output 累计，沿用现有定义；文档写明这是「累计计费 token」而非上下文占用。

### 6.4 提示词验收规则

- [ ] `packages/core/src/agent/context/system-prompt.ts` 任务版规则增加：
  - 代码改动后运行相关测试 / lint / build；
  - 结果写明验证命令与结果；
  - 无法验证时说明原因与风险。

### 6.5 测试

- [ ] `packages/core/test/unit/loop-guard.test.ts`
  - 同工具同参数同结果第 3 次 warn、第 6 次 block；
  - 参数或结果变化不计数；
  - steer 后计数清零；
  - 窗口外旧调用不计数。
- [ ] `packages/core/test/integration/task-loop-guard.test.ts`
  - 重复读取同一文件触发 warn；
  - 达到阈值后工具不再执行；
  - 继续重复任务 failed，错误码 `LOOP_DETECTED`；
  - 设置关闭时不触发。
- [ ] `packages/core/test/integration/task-token-budget.test.ts`
  - 软预算 0 不注入；
  - 80% 注入一次收敛提示；
  - 100% 后任务仍能正常结算。
- [ ] 设置定向测试：
  - `node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts packages/core/test/unit/settings-item-writes.test.ts apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts`

### 6.6 验收

1. 设置页「通用 → 任务 Loop」可开关并修改六个参数（提醒 / 中止 / 窗口 / 软预算 / 无活动超时 / 最长运行），越界有可读错误；
2. 对话内设置卡也能改同一项；
3. 重复调用达到提醒阈值时模型收到提示，达到中止阈值后不再执行；
4. 软预算开启后能在接近上限时收敛；
5. 设置缺字段 / 解析失败时使用默认值，任务正常启动；
6. 外部智能体任务不出现 `update_plan`、不做宿主空转拦截。

## 7 P3：任务执行过程页计划渲染与可观测性

### 7.1 计划渲染

- [ ] `apps/desktop/.../tasks/task-run-view.ts` 增加 `latestPlan(steps)`：
  - 找最后一个 `tool_call.toolName === 'update_plan'`；
  - 从 `args.plan` 解析并校验；
  - 返回 `{ explanation, plan, updatedAt } | null`。
- [ ] 新增 `apps/desktop/.../tasks/TaskPlanPanel.svelte`：
  - 标题「执行计划」+ `已完成 / 总数`；
  - completed / in_progress / pending 状态图标；
  - 可折叠；无计划不渲染；
  - testid `task-run-plan`。
- [ ] `TaskRunView.svelte` 在顶部提示条下渲染计划区；复用现有 `runs.steps` 轮询，不新增 RPC。
- [ ] 任务卡卡面不新增字段：`update_plan` 的 progress 已让 `lastProgress` 显示「计划 x/y：…」。
- [ ] i18n：`task.run.plan.*`。
- [ ] 测试：
  - `task-run-view.test.ts`：计划解析、多个 update_plan 取最后一个、非法计划忽略、无计划返回 null；
  - 组件测试（若现有任务页有组件测试则补充，否则至少快照 / 纯函数测试）。

### 7.2 工具输出落盘

- [x] 新增 `TOOL_OUTPUT_SPILL_*` 常量与 `agent/tool-output-spill.ts`：
  - 超过 `TOOL_OUTPUT_MAX_CHARS` 时写 workspace `.tool-output/<runId>/<seq>.txt`；
  - 返回头 + 尾 + 文件路径 + 字符数；
  - 写失败退回现有截断；
  - 不把整段内容塞回上下文。
- [x] `agent/tool-execution.ts` / `tools/coding-tools.ts` 接入；保持 `<untrusted>` 包裹。
- [x] 清理策略：随 run 结算 / workspace 清理删除；读取路径经过现有路径检查。

### 7.3 详细历史读取

- [x] `packages/core/src/tools/index.ts` 新增 `get_run_steps({ run_id, from_seq?, limit? })`：
  - 只允许自己的 run / 当前对话；
  - 返回步骤类型、工具名、结果文本（仍按 `TOOL_OUTPUT_MAX_CHARS` 截断）；
  - 结果包 `<untrusted>`；
  - 任务 / 子代理可用；对话轮不注册（工具面不变）。
- [x] 用途：压缩后模型需要细节时按需取回，而不是重新扫仓库。

### 7.4 验收

1. 任务执行过程页显示结构化计划与完成计数，运行中自动更新；
2. 无计划任务页面行为不变；
3. 大工具输出落盘后可读回，不撑爆上下文；
4. `get_run_steps` 只能读自己的执行记录。

## 8 P4：反馈闭环与 4 小时墙钟替换

### 8.1 异常停止映射

- [x] `agent/pi-engine.ts`：`length` → `OUTPUT_TRUNCATED` failed；`aborted` / `deferred` / 其他非正常 `stopReason` → failed；不再以空 `completed` 静默消费。
- [x] `packages/shared/src/errors.ts` + i18n：新增 `OUTPUT_TRUNCATED`。
- [x] `packages/testkit/src/mock-llm.ts`：`replyFinish(finishReason, text?)` 支持 `length` 等停止原因。
- [x] `packages/core/test/integration/tasks.test.ts`：模型 `length` → failed + failure 条目 + 唤醒。

### 8.2 用户取消反馈

- [x] `dispatch/tasks.ts`：`cancelById`（用户任务卡取消）写 `errorReason='user_cancelled'`；`#shouldWake` 对用户取消返回 true；failure 条目带「不要自行重派」提示。
- [x] Bot 自己的 `cancel_task` 仍然不唤醒；删除对话 / Bot 的取消仍然不唤醒。
- [x] 更新 `task-cards` / `external-agent-p3` 用例。

### 8.3 无活动看门狗

- [x] `TaskHost` 为每个已 attach 任务维护 `lastActivityAt`，订阅引擎事件；detach / finish 时取消订阅。
- [x] `sweep` 对 `engine='builtin'`、`status='running'`、`questionSince=null` 的任务检查 `taskLoop.stallTimeoutMinutes`；超时 → failed（`errorReason='stalled'`）+ failure 条目 + 唤醒。
- [x] 等待审批 / 租约 / 用户回答不计入；外部智能体保留自身 1 小时时限。
- [x] 测试：`tasks.test.ts` 的 stall 用例；wall 用例显式关闭 stall。

### 8.4 4 小时墙钟配置化

- [x] `taskLoopSettings` 增加 `maxWallMinutes`（0 = 不限制）；`TaskHost` 每次 sweep 从 settings 读取，运行中修改也生效。
- [x] 墙钟超限 `errorReason='wall_timeout'`，仍先写 failure 条目再唤醒。
- [x] `TASK_MAX_WALL_MS` 保留为无 settings 时的兜底常量。
- [x] 设置目录 / 适配器 / 设置页字段同步；`settings-item-writes` 覆盖新字段与越界。

### 8.5 验收

1. `length` / `aborted` / `deferred` 不再静默完成；
2. 用户从任务卡取消会唤醒 Bot 并说明不要重派；
3. 内置任务无活动超时会 failed + 唤醒，设置 0 可关闭；审批 / 租约 / 用户回答等待不会被计入无活动超时；
4. `maxWallMinutes=0` 时不再按总时长杀任务；
5. 设置页 / 设置卡可改两个新参数，越界有可读错误；
6. 审批 / 租约 / 用户回答等待不会被看门狗误杀。

## 9 跨阶段测试与收口

迭代中只跑定向测试；阶段收口 / 最终交付前跑一次全量：

```bash
node scripts/run-tests.mjs run packages/core/test/unit/context-compaction.test.ts \
  packages/core/test/unit/plan-tool.test.ts \
  packages/core/test/unit/loop-guard.test.ts \
  packages/core/test/integration/task-context-compaction.test.ts \
  packages/core/test/integration/task-plan.test.ts \
  packages/core/test/integration/task-loop-guard.test.ts \
  packages/core/test/integration/task-token-budget.test.ts \
  packages/core/test/integration/tasks.test.ts \
  packages/core/test/integration/task-cards.test.ts \
  packages/core/test/integration/external-agent-p3.test.ts \
  packages/core/test/integration/approval-timeout.test.ts \
  packages/core/test/integration/settings-cards.test.ts \
  apps/desktop/src/renderer/src/lib/features/tasks/task-run-view.test.ts
```

设置相关定向：

```bash
node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts \
  packages/core/test/unit/settings-item-writes.test.ts \
  apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts \
  apps/desktop/src/renderer/src/lib/features/settings-card/field-editor-model.test.ts
```

收口：

```bash
pnpm --filter @kepcup/shared build
pnpm --filter @kepcup/core build
pnpm typecheck
pnpm lint
pnpm test
```

## 10 风险与回退

| 风险 | 处理 |
|---|---|
| 压缩误删关键上下文 | 保留首条任务简报、system prompt、plan、最近消息；摘要失败退化；先只对 task / subagent 开启 |
| 摘要模型不可用 | 确定性 fallback，不让任务失败 |
| 空转误判（轮询、外部编辑） | 必须 call+args+result 三者相同才计数；steer 后清零；默认阈值宽松；可关闭 |
| 无活动看门狗误杀长工具 | 默认 20 分钟，高于 bash / 媒体工具的现有上限；审批 / 租约 / 用户回答不计入；只对内置任务生效；可设为 0 |
| 用户取消唤醒打扰 | 只在用户从任务卡取消时唤醒，failure 条目明确「不要自行重派」；Bot 自己的取消不唤醒 |
| 移除 4 小时后永久挂起 | 无活动看门狗默认开启；maxWall 默认 240 分钟；两者都可配置，但不会同时默认关闭 |
| 设置卡渲染字段 | `FieldEditorCard` / `SettingsCatalogFields` 按类型通用渲染 number/toggle，保留旧条目专用分支并补测试 |
| 计划工具与外部智能体原生 todo 冲突 | 只在内置 pi 任务注册；外部智能体不注入 |
| 任务卡面信息过载 | 卡面只显示 progress 摘要；完整计划放在已有执行过程页 |
| 软预算破坏长任务 | 默认 0 = 关闭；只做收敛提示，不直接 abort；可设置 |

## 11 实施记录

按阶段完成后在此记录：

- P0 上下文压缩：已完成（2026-10-21）。
  - `shared/constants.ts` 新增 `TASK_CONTEXT_*`；新增 `core/agent/context/compaction.ts`（阶段 A 裁剪 / 阶段 B 摘要 / 确定性 fallback / 摘要缓存）。
  - `PiEngine` 注册 `transformContext`，仅内置 `task` / `subagent`；摘要走新 `LlmPurpose: 'task_compaction'`，用量记入本 run。
  - 压缩进度写 `run_steps`；`run_steps` 仍保留完整过程。
  - 测试：`packages/core/test/unit/context-compaction.test.ts`、`packages/core/test/integration/task-context-compaction.test.ts`。
- P1 `update_plan`：已完成（2026-10-21）。
  - 新增 `core/tools/plan-tools.ts`；仅内置 pi 任务注册；计划状态保存在 run 闭包，`prepareRequest` 每轮注入 `<current_plan>`。
  - 每次更新发 progress（`计划 x/y：…`）；任务提示词增加计划与代码任务验证规则。
  - 测试：`packages/core/test/unit/plan-tool.test.ts`、`packages/core/test/integration/task-plan.test.ts`。
- P2 预算 / 空转 / 设置：已完成（2026-10-21）。
  - 新增 `core/agent/loop-guard.ts` 与 PiEngine 工具执行前检查 / 执行后记录；warn → block → failed(`LOOP_DETECTED`)；steer 清零。
  - `finishTurn` 接入任务软预算（默认 0 = 关闭，80% / 100% 注入收敛提示，不 abort）。
  - 设置目录新增 `general.task-loop`；core 适配器做交叉校验；`FieldEditorCard` 支持通用 number / toggle；`GeneralSection` 新增「任务 Loop」块与 `general-task-loop` 锚点；i18n 同步。
  - 测试：`packages/core/test/unit/loop-guard.test.ts`、`packages/core/test/integration/task-loop-guard.test.ts`、`packages/core/test/integration/task-token-budget.test.ts`，以及设置目录 / 适配器 / 卡片映射定向测试。
- P3 计划渲染 / 输出落盘 / 历史读取：已完成（2026-10-21）。
  - `task-run-view.ts` 新增 `latestPlan(steps)`；新增 `TaskPlanPanel.svelte` 并在已有 `TaskRunView.svelte` 顶部提示条下方渲染（可折叠，无计划不渲染）。
  - 测试：`apps/desktop/src/renderer/src/lib/features/tasks/task-run-view.test.ts`。
  - 新增 `shared/constants.ts` 的 `TOOL_OUTPUT_SPILL_*` / `GET_RUN_STEPS_*`；新增 `core/agent/tool-output-spill.ts`（`<workspace>/.tool-output/<runId>/<seq>.txt`、头尾摘要、符号链接防护、写失败回退、结算清理）。
  - `coding-tools.ts` 在截断前落盘完整输出；`tool-execution.ts` 兜底其它内置工具结果；仅内置 pi 任务传入 spill，外部智能体 / 对话轮 / 子代理路径不变。
  - `tools/index.ts` 新增 `buildGetRunStepsTool`，任务与子代理注册，对话轮不注册；`buildSubagentResearchTools` 同步带该工具。
  - 测试：`packages/core/test/unit/tool-output-spill.test.ts`、`packages/core/test/unit/coding-tools-wrap.test.ts`、`packages/core/test/unit/get-run-steps.test.ts`。
- P4 反馈闭环 / 无活动看门狗 / 可配置墙钟：已完成（2026-10-21）。
  - `PiEngine` 将 `length` 映射为 `OUTPUT_TRUNCATED` failed、`aborted` / `deferred` 映射为 failed；正常 `stop` 的空结果维持既有语义（不唤醒）。
  - 只有 `runs.cancel`（用户任务卡取消）写 `errorReason='user_cancelled'` 并唤醒 Bot；Bot 自己的 `cancel_task`、委派取消、更新闸门取消、删除类取消仍不唤醒。cancel 条目持久化 `errorReason`，崩溃恢复后仍能补投用户取消。
  - `TaskHost` 订阅引擎事件维护 `lastActivityAt`；内置任务 `running` 且无用户提问等待时，超过 `taskLoop.stallTimeoutMinutes` → failed(`stalled`)。审批 / 租约 / 用户回答等待期间持续刷新锚点，恢复后不会被整段等待误杀。
  - 4 小时墙钟改为 `taskLoop.maxWallMinutes`（默认 240，0 = 不限制）；`TASK_MAX_WALL_MS` 仅作 settings 缺省兜底。
  - 设置目录 / 适配器 / 设置页新增 `stallTimeoutMinutes`、`maxWallMinutes`；`settings-item-writes` 覆盖范围与越界。
  - 不新增数据库迁移。

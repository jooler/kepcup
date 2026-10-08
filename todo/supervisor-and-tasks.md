# D75 对话轮与任务分治：执行方案

> 设计：[docs/design/30-supervisor-and-tasks.md](../docs/design/30-supervisor-and-tasks.md)（D75，以设计为准）。本文只规定**怎么做、谁做、怎么验收**。
> 状态：**进行中**（2026-10-08 开工）。集成分支 `d75`（worktree `/home/jyy/wt/kepcup-d75`），各工作流在自己的 worktree / 分支开发，由调度会话合并进 `d75`；合入 `main` 需用户确认。

## 0. 给执行代理的规则（必读）

1. **只在分配给你的 worktree 里工作**（路径见任务说明）。不要进入 `/home/jyy/www/kepcup`（主 checkout，多个会话共用），不要 `git checkout` / `reset` 你没写的文件，不要用裸 `git stash`。
2. 先读：`docs/dev/README.md`、`docs/dev/01-conventions.md`、`docs/dev/02-architecture.md`、设计 30 全文、本文你所在工作流的小节与 §2 契约。涉及数据读 `docs/dev/03-data-model.md`，涉及 loop / 提示词读 `docs/dev/04-agent-runtime.md`，测试读 `docs/dev/05-testing.md`。
3. **只做你工作流「范围」列出的内容**；其他工作流的文件（§3 归属表）不要改，确需改动时最小化并在交付说明里列出。
4. 环境：Node 24 与 pnpm 11 在 `~/.nvm/versions/node/v24.13.0/bin`（先 `export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH`；系统默认 node 是 v12，不能用）。依赖已装好；改了 `packages/shared` 后 `pnpm --filter @kepcup/shared run build`，core 同理。
5. **测试必须在容器里跑**：宿主 glibc 2.35 加载不了 es-git 预编译绑定（需 ≥ 2.38），大部分集成测试在宿主上直接失败。用：
   `/tmp/claude-1000/-home-jyy-www-kepcup/9137b434-97a0-4439-b938-4ec9b3375ec8/scratchpad/ctest.sh <你的 worktree 绝对路径> "node scripts/run-tests.mjs run <测试文件或目录>"`
   不要在容器里跑 `pnpm test` / `pnpm install`（会触发依赖检查并破坏 `node_modules`）。typecheck / lint 在宿主跑：`pnpm -r typecheck`、`pnpm lint`。
6. **基线失败**：容器里沙箱 / bwrap / socat 相关用例本来就失败（见 §6 基线清单）。你的交付标准是「不新增失败」，不是「全绿」。
7. 提交：Conventional Commits（`feat(core): …`），每个提交可构建；提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。只提交到你自己的分支，不要 push，不要合并别的分支。
8. 设计与现实冲突、契约不够用、验收无法达成 → 停下受影响部分，写进 `docs/dev/DEVIATIONS.md`（新编号 DEV-xxx），继续不受影响的部分，并在交付说明里点名。不要擅自改设计决策。
9. 交付说明（你的最终回复）必须包含：提交列表、改动文件、新增 / 修改的测试及容器内结果（通过数 / 失败数，失败是否都在基线内）、typecheck / lint 结果、偏差与遗留。

## 1. 波次与依赖

| 波次 | 工作流 | 内容（设计 30 章节） | 依赖 | 并行 |
|---|---|---|---|---|
| 0 | **W0 地基契约** | 迁移、shared 类型、领域服务写接口、常量（§2 契约全部落成代码） | — | 单独 |
| 1 | **W1-A 任务层** | TaskHost、任务执行、结算 / 修复 / 对账 / reaper、任务管理工具定义（§3、§4.1、§2.4.5–2.4.6） | W0 | 与 W1-B、W1-C 并行 |
| 1 | **W1-B 私有时间线读路径** | 按视角读法、渲染、摘要只摘共享行、泄露契约测试（§2.4.3–2.4.4） | W0 | 并行 |
| 1 | **W1-C 写互斥与只读** | workspace 租约、对话轮 / 只读任务硬拒写、D37 收紧（§5、§7.3） | W0 | 并行 |
| 2 | **W2 对话轮** | `response`→`turn`、对话轮提示词与工具面、`<tasks>` 段、任务触发与消费、mailbox 语义、续接关闭（§2.1、§3.3、§4、§7.1） | W1-A/B/C | 单独 |
| 3 | **W3 消息与界面** | 任务卡、`task.updated`、状态行、进度渲染、问题卡直注（§4.3、§6、§2.4.6 UI） | W2 | 与 W4 并行 |
| 3 | **W4 外部引擎** | 按任务分会话、外部 Agent 作任务引擎、并发与 steering 降级（§8） | W2 | 与 W3 并行 |
| 4 | **W5 收口** | 02 重写、docs/dev 同步、全量回归、审查修复（§10、§11 T6） | 全部 | 单独 |

每个工作流交付后由调度会话合并进 `d75`，跑一次容器全量回归，并安排独立审查（审查者不是作者）。

## 2. W0 契约（W0 必须原样落成代码，后续工作流按此编码）

### 2.1 迁移

- **迁移号连续**（`infra/migrate.ts` 对缺号报错）：D73 预留的 main `0018`–`0020` 尚未创建，**D75 取 main `0018`、runs `0006`**；D73 开工时按其方案「号以目录实况为准」顺延（调度会话负责告知）。
- `main/0018_task_events.sql`：
  - `messages` 重建（`kind` CHECK 增 `'task_event'`），新增 `owner_bot_id TEXT`、`task_id TEXT`；重建方式参照 `0015` / `0016` / `0017` 的既有重建写法，保留全部列、索引、外键（`attachments.message_id` 等）与 FTS 同步。
  - 唯一索引：每个任务至多一条终态条目——`CREATE UNIQUE INDEX messages_task_terminal ON messages(task_id) WHERE kind = 'task_event' AND json_extract(content_json, '$.phase') IN ('result', 'failure')`（若表达式索引在本库加密构建下不可用，改加 `task_terminal INTEGER` 列，记入 DEVIATIONS）。
  - 索引 `messages(conversation_id, owner_bot_id, seq)`、`messages(task_id)`。
  - **FTS 不改表结构**：按视角过滤在查询时 join `messages`（设计 30 §2.4.3 的「FTS 加列」以此等价实现，W1-B 负责查询侧）。
- `runs/0006_tasks.sql`：`runs` 增 `task_title TEXT`、`task_writes INTEGER`、`task_workdir TEXT`、`origin_run_id TEXT`、`result_consumed_at INTEGER`、`awaiting_input INTEGER NOT NULL DEFAULT 0`；索引 `runs(conversation_id, loop_type, status)`。`loop_type` 无 CHECK，无需重建。

### 2.2 shared 类型（`packages/shared/src/domain/types.ts`）

- `loopTypeSchema` 增 `'turn'`、`'task'`（**保留** `'response'`，由 W2 移除并改名）。
- `triggerReasonSchema` 增 `'task'`。
- `messageKindSchema` 增 `'task_event'`。
- 新增 `taskEventPhaseSchema = z.enum(['brief','inject','cancel','question','result','failure'])`；
  `taskEventContentSchema = z.object({ taskId, phase, text, sourceMessageIds?: string[], status?: RunStatus, error?: string, delivery?: 'delivered'|'queued', questionMessageId?: string, title?: string, writes?: boolean, continuesTaskId?: string })`，并入 `messageContentSchema`（放在能与其他分支区分的位置，加单测）。
- `textContentSchema.origin` 改为 `z.enum(['delegation','task']).optional()`，增 `taskId?: string`。
- `messageSchema` 增 `ownerBotId: string | null`、`taskId: string | null`。
- `runSchema` 增 `taskTitle: string | null`、`taskWrites: boolean | null`、`taskWorkdir: string | null`、`originRunId: string | null`、`resultConsumedAt: number | null`、`awaitingInput: boolean`。
- 常量（`packages/shared/src/constants.ts`，带注释说明来源）：`TURN_MAX_TURNS = 8`、`TASK_CONCURRENCY_PER_CONVERSATION = 3`、`TASK_CONCURRENCY_GLOBAL = 8`、`TASK_START_MAX_PER_TURN = 2`、`TASK_MAX_WALL_MS = 4h`、`TASK_TOKEN_BUDGET`（参照现有 run 预算常量取值）、`TASK_SETTLE_SWEEP_MS = 60_000`、`TASK_EVENT_CONTEXT_MAX_CHARS = 600`、`TASK_TRIGGER_RESULT_MAX_CHARS = 12_000`、`GRANT_ABSOLUTE_TTL_MS = 10 min`。

### 2.3 领域服务写接口

`packages/core/src/domain/messages.ts`：
- `append()` 接受 `kind: 'task_event'`、`ownerBotId`、`taskId`、`taskEvent` 载荷，以及文本消息的 `taskOrigin: { taskId }`（落 `origin:'task'`）。行映射补 `ownerBotId` / `taskId`。
- `appendTaskEvent(input: { conversationId; ownerBotId; taskId; phase; text; sourceMessageIds?; status?; error?; delivery?; questionMessageId?; title?; writes?; continuesTaskId? }): { message: Message; created: boolean }` —— `sender_type='system'`；终态 phase 撞唯一索引时**不抛错**，返回已存在的条目与 `created:false`；FTS 照常同步。
- `terminalTaskEvent(taskId): Message | null`、`taskEvents(taskId): Message[]`。
- `isVisibleToUser`：`task_event` 或 `ownerBotId !== null` → `false`；`listVisible` 的 SQL 同步排除。（**按 Bot 视角的读法由 W1-B 做**，W0 不动 `list` / `search` / `around` 的语义。）

`packages/core/src/domain/runs.ts`：
- `create()` 接受任务字段；`update()` 支持 `resultConsumedAt`、`awaitingInput`；行映射补全部新字段。
- `listTasks(filter: { conversationId?; botId?; statuses?: RunStatus[] }): Run[]`、`listNonTerminalTasks(): Run[]`、`listUnconsumedTerminalTasks(): Run[]`（终态且 `result_consumed_at IS NULL`）。
- 任务的 `submitted` 用现有 run 状态 `queued` 表示（不新增状态值）。

### 2.4 W0 不做

TaskHost、任何 orchestrator 行为变化、读路径过滤、UI、工具。W0 合并后行为与现状一致（全量回归不新增失败）。

## 3. 文件归属（并行期避免冲突）

| 工作流 | 主要文件 |
|---|---|
| W0 | `migrations/main/0018_*`、`migrations/runs/0006_*`、`shared/src/domain/types.ts`、`shared/src/constants.ts`、`domain/messages.ts`（写接口）、`domain/runs.ts` |
| W1-A | 新 `dispatch/tasks.ts`、新 `tools/task-tools.ts`、`agent/subagent.ts`（`SubagentHost` → `TaskHost` 的提升）、`dispatch/orchestrator.ts`（任务执行、生命周期接线）、`domain/lifecycle.ts`、`start.ts` 接线 |
| W1-B | `domain/messages.ts`（读路径）、`agent/context/conversation.ts`、`tools/index.ts`（`search_messages` / `get_messages_around`）、`agent/loops/conversation-summary.ts`、`dispatch/dispatcher.ts`（群聊判断输入）、`memory/reflection.ts`（输入）、`rpc/bindings.ts`（预览 / 未读）；orchestrator 只改 `messages.list(...)` 调用点 |
| W1-C | `project/service.ts`、`project/lease.ts`、`gateway/index.ts`、`sandbox/policy.ts`、`permissions/*`（grants） |
| W2 | `dispatch/orchestrator.ts`（对话轮）、`scheduler/mailbox.ts`、`agent/context/system-prompt.ts`、`agent/context/continuation.ts`、`tools/index.ts`（工具面组装）、全仓 `'response'` 改名 |
| W3 | `apps/desktop/**`、`shared/src/rpc/events.ts`（`task.updated`）、orchestrator 事件发布点 |
| W4 | `agent/external/**`、`domain/agent-sessions.ts`、`migrations/main/0019_*`（agent_sessions 加 task_id） |

`shared/src/domain/types.ts` 与 `constants.ts` 在 W1 期间如需追加，只在文件末尾或对应 schema 旁追加，便于合并。

## 4. 各工作流范围与验收

### W0 地基契约
- 范围：§2 全部。
- 验收：迁移在新库与 0017 库上都能前进（补 `migration` 相关测试，参照 `test/integration/migration-rollback.test.ts`、`create-core.test.ts` 的版本断言要同步 2→新版本号）；`appendTaskEvent` 终态幂等单测（同任务第二次写 result/failure 返回 `created:false`）；`isVisibleToUser` / `listVisible` 排除 `task_event` 单测；`runs` 新字段读写单测；`messageContentSchema` 解析三类内容不串型的单测；全量回归不新增失败；typecheck / lint 0 error。

### W1-A 任务层
- 范围：
  1. `dispatch/tasks.ts` `TaskHost`：`start` / `inject` / `cancel` / `list` / `settle` / `markConsumed` / `recover` / `sweep`，按设计 30 §3、§4.1。`start` 先写 runs 行（`queued` 或直接 `running`）再写 `brief` 条目，再返回；配额：对话级、全局、每个发起对话轮（`origin_run_id`）的起数。
  2. 任务执行：把 orchestrator 的响应 run 执行抽出可复用的执行骨架，任务以 `loop_type='task'` 运行：触发段 = 简报（`instruction` + `source_message_ids` 原文，附件 / 图片照现有触发批方式带入，§2.4.5）；对话层上下文只取共享行（W1-B 完成前用 `ownerBotId === null` 过滤）；中间说明照 D54 护栏发为可见消息并带 `origin:'task'`；**最终文本不发可见消息**，写 `result` 条目；`skip_reply` → 空结果；失败 / 取消 / 中断 → `failure` 条目（含 `buildRunDigest` 尾部摘要）。
  3. 结算次序严格按 §3.2：终态条目 → runs 终态 → 唤醒判定（§3.3）→ 投递。唤醒通过注入的 `wake(botId, conversationId, entry)` 钩子；本波默认实现 = 把条目作为 `TriggerBatch{reason:'task'}` 交给 mailbox（W2 会改 mailbox 语义，这里不改 mailbox）。
  4. `recover()` 接入启动恢复（§7.4 次序），`sweep()` 按 `TASK_SETTLE_SWEEP_MS` 定时；`abortForConversation` / `abortForBot` 接入生命周期删除路径。
  5. **（已移至 W2）** `SubagentHost` 的对话级后台锚点职责移交 `TaskHost`（D66 降级）：`delegate_task` 后台模式改为父任务内并行分支，不再注册对话级锚点；保持 `subagent.test.ts` 语义（调整断言需说明理由）。
  6. `tools/task-tools.ts`：`start_task` / `inject_task` / `cancel_task` / `list_tasks` / `forward_task_result` 的工具定义（参数校验、执行期 `loop_type` 校验：任务内调用 `start_task` 拒绝），**不注册**进任何工具面（W2 注册）。
- 验收（集成测试，用模拟模型服务）：起任务 → 任务执行 → `result` 条目落库且无可见最终消息 → 唤醒钩子收到条目；中间说明带 `origin:'task'`；配额超限返回 `submitted` 与排队原因、名额释放后自动启动；`cancel` 写 `failure(status=cancelled)` 且不唤醒；**崩溃修复**：构造「有终态条目、run 非终态」与「无条目、run 非终态」两种库状态，`recover()` 分别补成对应终态 / `interrupted` + `failure`；未消费终态任务被补投；reaper 超时强制 `failed`；任务内 `start_task` 被拒；删除对话 / Bot 中止任务。

### W1-B 私有时间线读路径
- 范围：设计 30 §2.4.3 表中全部读路径按视角过滤——`listForBot(conversationId, botId)`（替换 orchestrator 里构建上下文的 `messages.list` 调用点）、`listShared(conversationId)`（任务对话层 / 摘要用）、`search` 查询 join `messages` 按 owner 过滤、`around`、`unsummarized` 只摘共享行、`buildConversationDelta` 输入、群聊判断输入、反思输入、会话预览与未读（`rpc/bindings.ts` 及其数据源）；`renderMessageLine` 增 `task_event`（`你→任务 t_x（交代）` / `任务 t_x→你（结果）`）与 `origin:'task'`（`你（任务 t_x）`）分支；`TASK_EVENT_CONTEXT_MAX_CHARS` 截断（触发段不截断，`TASK_TRIGGER_RESULT_MAX_CHARS` 硬顶，超过给开头 + 提示用 `forward_task_result`）。
- 验收：**多 Bot 泄露契约测试**（新文件 `test/integration/task-timeline-visibility.test.ts`）：群里 X、Y 两个 Bot，写入 X 的各 phase 私有条目，断言 Y 的上下文构建、`search_messages`、`get_messages_around`、对话摘要输入、群聊判断输入、反思输入，以及用户的 `messages.list` RPC、会话预览、未读数里都看不到；X 的上下文里看得到且按 `seq` 与用户消息交错；渲染格式单测；全量回归不新增失败。

### W1-C 写互斥与只读
- 范围：租约键 `ws:{botId}:{conversationId}`（`#leaseTarget` 支持 workspace 路径，`waiting_lease` / `lease.waiting` 复用）；工具网关执行期硬拒写——`loopType==='turn'` 一律拒写，`loopType==='task' && taskWrites===false` 拒写（文件写、bash 写路径判定沿用现有网关逻辑；拒绝返回工具错误码而非抛出）；写任务整任务持有租约的 `pin` 接口（供 W1-A 在任务启动前调用：`projects.ensureWriteLease(identity, root, { pin: true })` 对 workspace 根同样可用）；D37 收紧：「仅这一次」授权在单次工具调用后失效 + `GRANT_ABSOLUTE_TTL_MS` 兜底（审批 / 授权现有测试按新语义调整并说明）。
- 验收：两个写任务（模拟两个 run identity）抢同一 workspace → 第二个 `waiting_lease`、第一个释放后获得；project 路径行为不变（`projects.test.ts` 基线外不新增失败）；`turn` 与只读任务的写工具调用被拒且返回可读错误；一次性授权第二次调用需重新审批；绝对时限过期单测。

### W2 对话轮
- 范围：设计 30 §2.1、§3.3（消费标记接线）、§4、§7.1；W1-A 移交的 D66 降级（`SubagentHost` 对话级后台锚点职责并入 `TaskHost`，`delegate_task` 后台模式退回父任务内并行分支，见 W1-A 第 5 项）；`loop_type='response'` 全仓改名 `'turn'`（含测试，`shared` 移除 `'response'`）；对话轮工具面（只读 + 任务管理 + 异步托管 + `forward_task_result`，`TURN_MAX_TURNS`）与提示词（`<platform_rules>` 对话轮版：何时直答、何时派活、何时注入 / 取消、结果转述与原文转发、路由必须告诉用户）；`<tasks>` 段；mailbox：对话轮运行中到达的批**缓冲到下一轮**（不再 steer 进对话轮），release 时合并；触发段渲染 `reason='task'` 的条目；对话轮终态时 `TaskHost.markConsumed`；自动续接对对话轮关闭；群轮次在对话轮终态推进。
- 验收：端到端（模拟模型）——用户消息 → 对话轮派任务并回复 → 对话轮结算后立即能处理新消息 → 任务结果唤醒新一轮 → 对话轮 `forward_task_result` + 衔接回复；两个任务同时结算合并为一轮；对话轮内写工具被拒；新消息在对话轮运行中到达 → 下一轮处理；`inject_task` / `cancel_task` 路径；群聊两 Bot 顺序响应推进不等任务；既有 `response-loop` / `group-chat` / `delegation` / `butler` / `environment` 测试按新语义迁移并说明。

### W3 消息与界面
- 范围：`task.updated` 事件与任务卡（标题 / 状态 / 进度 / 取消）、`inject_task` 追加行、取消卡改动摘要与回退入口（workspace 无回退如实说明）、状态行改为任务活动、可见任务进度的归属渲染、问题卡绑定 `task_id` 且点选直注任务；`renderCard` 补任务卡上下文渲染；i18n 文案进 `zh-CN.ts`。
- 验收：renderer 单测 + e2e（容器 `kepcup-test:trixie-xvfb` + `xvfb-run`，参照 D72 记录）覆盖派任务 → 卡片 → 结果转述 → 取消。

### W4 外部引擎
- 范围：设计 30 §8，含 §8.5 按任务分会话（main `0019`：`agent_sessions` 加 `task_id`、唯一索引改四元组）、`sessionKey` / 桥 token 按任务、`continues_task_id` 继承会话行、`agent:{id}` 并发与 `features.parallelSessions` 联动、steering 异步拒绝映射 `queued`、对话轮固定内置引擎、`runtime.agent` 语义改为任务引擎（设置文案同步）。
- 验收：fake ACP agent 下两个外部 Agent 任务并行各自独立会话；`parallelSessions=false` 的 provider 并发钳为 1；继承路径；契约测试不新增失败。

### W5 收口
- 范围：`docs/design/02-execution.md` 整篇重写；`docs/dev/02/03/04/05`、`PROGRESS.md`、`DEVIATIONS.md` 同步；全量回归、e2e、typecheck、lint；独立审查与修复。

## 5. 实施记录

（各工作流合并后由调度会话追加：提交、验证证据、偏差。）

### W0 地基契约（2026-10-08，合入 `d75` @ `9471818`）

- 提交 `bba0211`。迁移 main `0018_task_events.sql`：重建 `messages`（`kind` 增 `task_event`，增 `owner_bot_id` / `task_id`）；因迁移在 `foreign_keys=ON` 的事务内执行、`DROP TABLE messages` 会级联删光附件，`attachments` 一并重建（先建两张新表并复制，再删旧子表、旧父表，最后改名）；调度会话核对历史迁移：两表此前只有 `messages_conv_seq` 一个索引、无追加列、仅 `attachments` 引用 `messages`，重建完整。终态条目唯一索引用 `json_extract` 表达式部分索引（加密构建下可用，无偏差）。runs `0006_tasks.sql` 加任务列与索引。
- 领域接口、shared 类型与常量按 §2 落地；`TASK_TOKEN_BUDGET = 2_000_000`（响应 run 本无 token 上限、只有 `RUN_MAX_TURNS=60`，沿用子代理的 150k 会截断长任务；按约 60 轮 × 30k 上下文推得），调度会话采纳。另：`runs.create` 接受 `continuedFromRunIds`（`continues_task_id` 回放来源，复用既有列）；desktop `UsageSection.svelte` 与 `zh-CN.ts` 为满足 `Record<LoopType,…>` 补了 `turn` / `task` 文案（W3 知悉）。
- 验证：新增 4 个测试文件 23 例；容器全量 1582 例，失败 34 = 基线 33 + `web-tools.test.ts` 一条负载超时（单跑 3/3 通过，判为偶发）；调度会话合并后复跑新增测试 + `create-core` 32/32、三包 typecheck 通过。
- 合并后调度会话追加 `505f5f9`：上下文消息读取收敛到 orchestrator `#contextMessages(conversationId, viewerBotId, limit)`（W1-A 与 W1-B 的接缝：W1-B 只改其实现，W1-A 的任务对话层用 `viewerBotId = null`）。

### W1 三路（2026-10-08，合入 `d75`：W1-C `20b8689`、W1-B `1f6a38f`、W1-A `81ff891`，接缝修正 `65433d9`）

- **W1-C 写互斥与只读**（`c80506c`、`e3ba8a2`）：`ensureWriteLease` 支持 Bot 自己的 workspace（键 `ws:{botId}:{conversationId}`，无检查点）；`writeDenial(identity)`：`turn` 恒只读，`task` 仅 `taskWrites === true` 可写（行缺失或 null **fail closed**，严于方案）；网关文件写 / bash 沙箱策略（只读挂载）/ 沙箱外 / git / 租约全部硬拒，错误码 `RUN_READ_ONLY`；切换 / 移除 project 也被进行中的 `turn` / `task` 阻止。D37 收紧见 **DEV-009（待用户确认）**：「仅这一次」由用到它的那次工具调用消耗（`AsyncLocalStorage` 工具调用作用域），`request_access` 预授权给下一次用到它的调用，`GRANT_ABSOLUTE_TTL_MS` 兜底，外部智能体「仅这一次」不再生成授权。普通 run 写 workspace 不取租约（只有写任务显式取）。新增测试 `workspace-lease`（4）、`gateway-read-only`（12）及 `permissions` / `policy` / `approvals` 用例。
- **W1-B 私有时间线读路径**（`3b726cb`）：`listForBot` / `listShared`（SQL 过滤、整页）、`search`（`viewerBotId` 必填，FTS join `messages`）、`around`（语义改为「前后各 N 条可见行」）、`unsummarized` 只摘共享、`countVisibleAfter`（未读只数用户可见行，内部事务也不再计入）、预览排除私有行；私有行推进 `last_seq` 但不推进 `last_message_at`。`renderMessageLine` 增第三参数 `'context' | 'trigger' | 'full'`。任务视角下 `search_messages` / `get_messages_around` 只看共享行。泄露契约测试 `task-timeline-visibility`：真实 core，去掉过滤的变异检查会报 9 个泄露标记。
- **W1-A 任务层**（`5dea3a2`、`26b1249`、`e67a746`）：`dispatch/tasks.ts` `TaskHost`（`orchestrator.tasks`）、`tools/task-tools.ts` `buildTaskTools`（未注册，W2 注册）；`#executeResponseRun` 抽为 `#executeRun(runId, RunExecution)`（`kind: 'response' | 'task'`，W2 加 `turn`）；启动恢复 `tasks.recover()` 先于 `markAllActiveInterrupted({ exceptLoopTypes: ['task'] })`；reaper 由 `start.ts` 定时；调度器为对话回复保留一个 provider 名额。作者自行安排了一轮独立审查并修复 10 处。过渡行为：本波唤醒仍经旧 mailbox 起响应 run，看过任务条目的响应 run 结算后 `markConsumed`（W2 移到对话轮终态）；外部智能体 Bot 的任务暂时失败关闭（W4）；`inject` 也接受 `submitted` 任务（并入简报）。
- **接缝修正**（调度会话）：W1-C 合入后 workspace 已有租约目标，任务写租约失败不再把 `INVALID_INPUT` 当作「暂无租约」无锁继续；去掉 W1-B 的 `LoopType` 类型放宽。

**交接给后续工作流**

- **W2**：注册 `buildTaskTools`；`markConsumed` 从 `#releaseResponseMailbox` 移到对话轮终态；`RunExecution` 加 `turn`；对话轮工具面去掉 MCP / 媒体生成 / 浏览器（不在只读检查覆盖范围）；`get_attachment` 复制非文本附件到 workspace 在对话轮会被拒，决定对话轮是否保留该路径；任务唤醒的触发段用 `buildTriggerSegment`（`'trigger'` 模式，全文 + 硬顶）；D66 降级（原 W1-A 第 5 项）。
- **W3**：`RUN_READ_ONLY` 等错误码的 zh-CN 文案；渲染端 `#upsertConversation` 缺 `unreadCount` 时回退 `lastSeq - lastReadSeq` 会算入私有行；取消卡改动摘要（W1-A 的 `cancel_task` 只说明不回退）；W0 已在 `UsageSection` / `zh-CN.ts` 补 `turn` / `task`。
- **W4**：外部智能体只读任务必须强制 `read_only` 档位（Agent 在工作目录内的写入先被桥的档位逻辑放行，走不到网关）；外部智能体任务当前失败关闭，W4 接通。
- **W5**：设计 13 补一句预授权的消费方式；DEV-009 结论落字。

## 6. 基线

容器（`kepcup-test:trixie`）全量，`d75@7138daf`，2026-10-08，614 s：**1559 用例，1524 通过 / 33 失败 / 2 跳过**，1 个 unhandled error（`projects.test.ts` 的 `lease.waiting` 等待超时，基线既有）。33 条失败全部是容器环境原因（沙箱自检 / bwrap / socat / 外网），与 D72 记录的基线一致。判定标准：**失败集合不超出下表**。

| 文件 | 失败数 |
|---|---|
| `packages/core/test/sandbox/sandbox-isolation.test.ts` | 10 |
| `packages/core/test/integration/projects.test.ts` | 6 |
| `packages/core/test/integration/skills-authoring.test.ts` | 4 |
| `packages/core/test/integration/env-distro-toolchain.test.ts` | 3 |
| `packages/core/test/integration/skills.test.ts` | 3 |
| `packages/core/test/integration/workspace-tools.test.ts` | 3 |
| `packages/core/test/sandbox/toolchain-sandbox.test.ts` | 2 |
| `packages/core/test/integration/wiki-url.test.ts` | 2 |

<details><summary>逐条清单</summary>

- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) blocks reading ~/.ssh, ~/.aws and the data home database from inside the sandbox
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) denies reading arbitrary locations of the user home from inside the sandbox
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) blocks writing outside the workspace
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) keeps the two workspaces of the test suite isolated from each other
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) reports violations for denied file reads
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) kills the whole process tree on timeout and leaves no leftovers
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) aborts the running command when the abort signal fires
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) points package-manager caches into the app cache directory
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) network modes denies loopback, intranet and metadata addresses in every mode
- packages/core/test/sandbox/sandbox-isolation.test.ts :: sandbox escape cases (P02 安全用例集) network modes reaches the internet in open mode but not in none/allowlist modes without the domain
- packages/core/test/sandbox/toolchain-sandbox.test.ts :: toolchain sandbox cases (P06) executes an installed toolchain binary inside the sandbox via the PATH prefix
- packages/core/test/sandbox/toolchain-sandbox.test.ts :: toolchain sandbox cases (P06) keeps the toolchains directory read-only inside the sandbox
- packages/core/test/integration/env-distro-toolchain.test.ts :: P12 发行版内工具链安装（fake distroInstaller + platform win32 注入） node：linux 产物 → 校验 → 移入发行版 → 行 rel_path 为发行版 bin → 前缀注入
- packages/core/test/integration/env-distro-toolchain.test.ts :: P12 发行版内工具链安装（fake distroInstaller + platform win32 注入） 发行版未就绪：行 failed 且不产生任何提取/验证调用
- packages/core/test/integration/env-distro-toolchain.test.ts :: P12 发行版内工具链安装（fake distroInstaller + platform win32 注入） 发行版行的 remove 走 removeDir（发行版内删除）
- packages/core/test/integration/projects.test.ts :: projects (P04) serializes writes of two conversations on one project; the second waits with waiting_lease
- packages/core/test/integration/projects.test.ts :: projects (P04) blocks bash writes without the lease and allows them after acquire_project_write
- packages/core/test/integration/projects.test.ts :: projects (P04) summarizes command-made changes, diffs them and reverts the whole run (with conflict detection)
- packages/core/test/integration/projects.test.ts :: projects (P04) allows localhost ports in project conversations and blocks them otherwise
- packages/core/test/integration/projects.test.ts :: projects (P04) blocks switching projects while a bot is executing
- packages/core/test/integration/projects.test.ts :: projects (P04) force revoke closes the holder window: each run keeps its own changes (BR-P04-001)
- packages/core/test/integration/skills-authoring.test.ts :: P08 自建：skill_suggestion → 生成 loop → 验证 → 启用 + 通知 成功路径：验证通过 → active + 通知消息；草稿目录不在仓库历史中
- packages/core/test/integration/skills-authoring.test.ts :: P08 自建：skill_suggestion → 生成 loop → 验证 → 启用 + 通知 create_skill 工具：用户说「以后都这样做」→ 登记 → 生成 → 启用 + 通知
- packages/core/test/integration/skills-authoring.test.ts :: P08 自建：skill_suggestion → 生成 loop → 验证 → 启用 + 通知 改进已有自建技能：生成 loop 携 <existing_skill> 当前版本，全程产出新版本（BR-P08-009⑤）
- packages/core/test/integration/skills-authoring.test.ts :: P08 自建：skill_suggestion → 生成 loop → 验证 → 启用 + 通知 改进已有自建技能 → 新版本提交；skills.rollback 只动目标技能、失败回滚不脏工作区（BR-P08-002）
- packages/core/test/integration/skills.test.ts :: P08 Skills：git 导入 → 审批 → 安装 → 加载 → 沙箱执行 下一次执行：提示词出现技能描述；模型读 SKILL.md 并沙箱执行脚本
- packages/core/test/integration/skills.test.ts :: P08 Skills：git 导入 → 审批 → 安装 → 加载 → 沙箱执行 沙箱内写技能目录失败（只读）
- packages/core/test/integration/skills.test.ts :: P08 Skills：多技能仓库列出候选；ref 锁定 ref 指定分支/标签：锁定对应提交而非默认分支 tip；不存在的 ref 报错（BR-P08-001）
- packages/core/test/integration/wiki-url.test.ts :: P09 Wiki：URL 来源在沙箱中抓取（本地 http 夹具） HTML 页面抓取后转 markdown 入 raw/，维护 loop 写页面并提交
- packages/core/test/integration/wiki-url.test.ts :: P09 Wiki：URL 来源在沙箱中抓取（本地 http 夹具） allowlist 网络策略下非名单内主机直接拒绝（任务失败，无抓取）
- packages/core/test/integration/workspace-tools.test.ts :: workspace and coding tools writes a script, executes it in the sandbox and reads the output
- packages/core/test/integration/workspace-tools.test.ts :: workspace and coding tools records exec and fs_write entries in audit_log
- packages/core/test/integration/workspace-tools.test.ts :: workspace and coding tools surfaces sandbox violations inside the bash tool result step

</details>

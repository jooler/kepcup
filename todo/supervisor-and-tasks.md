# D75 对话轮与任务分治：执行方案

> 设计：[docs/design/30-supervisor-and-tasks.md](../docs/design/30-supervisor-and-tasks.md)（D75，以设计为准）。本文只规定**怎么做、谁做、怎么验收**。
> 状态：**W0–W4 与审查修复已合入 `d75`，W5 文档收口**（2026-10-08 开工）。集成分支 `d75`（worktree `/home/jyy/wt/kepcup-d75`），各工作流在自己的 worktree / 分支开发，由调度会话合并进 `d75`；合入 `main` 需用户确认。

## 0. 给执行代理的规则（必读）

1. **只在分配给你的 worktree 里工作**（路径见任务说明）。不要进入 `/home/jyy/www/kepcup`（主 checkout，多个会话共用），不要 `git checkout` / `reset` 你没写的文件，不要用裸 `git stash`。
2. 先读：`docs/dev/README.md`、`docs/dev/01-conventions.md`、`docs/dev/02-architecture.md`、设计 30 全文、本文你所在工作流的小节与 §2 契约。涉及数据读 `docs/dev/03-data-model.md`，涉及 loop / 提示词读 `docs/dev/04-agent-runtime.md`，测试读 `docs/dev/05-testing.md`。
3. **只做你工作流「范围」列出的内容**；其他工作流的文件（§3 归属表）不要改，确需改动时最小化并在交付说明里列出。
4. 环境：Node 24 与 pnpm 11 在 `~/.nvm/versions/node/v24.13.0/bin`（先 `export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH`；系统默认 node 是 v12，不能用）。依赖已装好；改了 `packages/shared` 后 `pnpm --filter @kepcup/shared run build`，core 同理。
5. **测试必须在容器里跑**：宿主 glibc 2.35 加载不了 es-git 预编译绑定（需 ≥ 2.38），大部分集成测试在宿主上直接失败。用：
   `/tmp/claude-1000/-home-jyy-www-kepcup/9137b434-97a0-4439-b938-4ec9b3375ec8/scratchpad/ctest.sh <你的 worktree 绝对路径> "node scripts/run-tests.mjs run <测试文件或目录>"`
   不要在容器里跑 `pnpm test` / `pnpm install`（会触发依赖检查并破坏 `node_modules`）。typecheck / lint 在宿主跑：`pnpm -r typecheck`、`pnpm lint`。
   `packages/core/test/integration/projects.test.ts` 在容器里约 10 分钟（6 条基线失败各等 60–180 s 超时），看起来像卡住；定向测试不要带它，全量回归照常包含。宿主 `timeout` 只杀 docker 客户端、杀不掉容器，需要硬超时用同目录的 `crun.sh <容器名> <worktree> <秒> "<命令>"`。vitest `--outputFile` 必须写到 worktree 内（容器里的 `/tmp` 不挂载到宿主）。
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
| 2 | **W2 对话轮**（实际拆为 W2 core + W2-D66） | `response`→`turn`、对话轮提示词与工具面、`<tasks>` 段、任务触发与消费、mailbox 语义、续接关闭（§2.1、§3.3、§4、§7.1）；W2-D66：`delegate_task` 降级（原 W1-A 第 5 项） | W1-A/B/C | 实际与 W4 并行 |
| 2 | **W4 外部引擎** | 按任务分会话、外部 Agent 作任务引擎、并发与 steering 降级（§8） | W1（计划 W2） | 实际与 W2 并行、先于 W2 合入 |
| 3 | **W3 消息与界面** | 任务卡、`task.updated`、状态行、进度渲染、问题卡直注（§4.3、§6、§2.4.6 UI） | W2 | 实际在 W2 与修复批 D 之后 |
| 4 | **W5 收口** | 02 重写、docs/dev 同步、全量回归、审查修复（§10、§11 T6） | 全部 | 单独 |

每个工作流交付后由调度会话合并进 `d75`，跑一次容器全量回归，并安排独立审查（审查者不是作者）。

**实际执行顺序**（`git log --first-parent d75`）：W0 → W1 三路（C、B、A）→ W1 审查批 A / B 与复核 → **W4 与 W2 并行**（W2 拆为 W2 core 与 W2-D66 两个分支）：W4 `ad5a749` → W2-D66 `6fdb4a9` → W2 `4ae4076` → 修复批 C（W4 / D66 审查）`267dc12` → 合并修正 `9661b5d` → 外部智能体测试迁移 xa1 `1d8ed8b`、xa2 `f9fb528` → 修复批 D（W2 审查）`a1bfcd8` → **W3** `da97adc` → 合并修正 `26e15f2` → W5（文档）。W4 先于 W2 合入时 `start_task` 尚未注册到任何工具面，`agent:*` 不留回复名额的前提由 W2 在同一变更里补齐（§5 W4 审查 M1）。

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
- **W5**：设计 13 补一句预授权的消费方式；DEV-009 结论落字。（W5 已落字：design/13「仅这一次」、design/30 §7.3，标「待确认」。）

**审查与修复（2026-10-08）**：独立审查 W1（基 `40cde29`）判 REQUEST CHANGES：H1 只读任务经 `delegate_task` 子代理 bash 可写；H2 写租约先于调度名额 → 持有并等待死锁（provider 上限 1 / 2、D72 固定 run），排队中被取消的任务不放租约；M1 终态条目写失败仍写终态并标消费（结果丢失）；M2 detach 后的注入报「已送达」实则丢弃；M3 上限 1 时任务饿死回复；M4 媒体生成 / 浏览器下载 / 装技能 / 申请环境绕过只读，`get_attachment` 在只读 run 失效；M5「仅这一次」在同 run 并行工具调用间串用；LOW 8 条（LOW-3 写任务顺手写 workspace 不取 ws 租约，**记为已知缺口不修**，同对话「每 workdir 一个写任务」兜底）。
- 批 A（`7c36bf1`，任务层 / 调度）：`SlotYieldingLeaseService` + `Scheduler.yieldSlotWhile`（等租约期间让出名额，取得后优先拿回）、`cancelQueued`；M3 回复在全部名额被任务占用时可借 1 个；M1 `#unsettled` 由 sweep 重试；M2 `closing` 与注入降级 `queued`；LOW-1/2/4/5/7/8。批 B（`1403248`，只读 / 授权）：子代理沿 `parentRunId` 继承根 run 的只读规则（fail closed）；`readOnlyRefusal` 收口媒体 / 技能 / 环境，浏览器只读下载改到应用缓存，`checkHostCopyPath` 让只读 run 的附件复制限定在 `.attachments/`；once 授权按工具调用作用域归属，预授权由第一个用到的调用认领；`onAutoRevoke` 发布 `grant.changed`；DEV-009 补记。合并 `7456dfa`。
- 复核（同一审查者）REQUEST CHANGES 7 条 → 批 A 第二轮 `3850639`：每 job 让出深度计数；同 run 同键 `ensureWriteLease` 并入进行中的申请（根因：并行写调用互相取消）；`#pump` 跳过未结算任务（M1 修复引入的「已取消任务被重新拉起」）；`finished` 防迟到等待泄漏名额；持租约写任务 priority 0；写任务子代理仅在任务持租约期间可写；同步抛出不泄漏名额；`#recoverySettle` 条目先行。#9（外部 Agent MCP 桥中途让出名额）核实不可达。
- 二次复核 APPROVE，附 MEDIUM：持租约写任务可占满 provider 全部名额 → 调度会话 `3530aea`：持租约写任务需 `active < limit` 且任务占用 `< limit - 1`；并入的租约申请响应调用方自身的 abort。
- 验证：两批及第二轮各自容器全量 difffail 新增失败仅偶发项（`agents-service` 登录状态、`web-tools` 负载超时，单跑通过）；`3530aea` 定向 `scheduler` / `tasks-review-fixes` / `tasks` / `workspace-lease` / `response-loop` 全过，`projects` 与基线一致；typecheck / lint 0 error。
- 待定：M3 借用规则（配置上限 N 在全为任务占用时实际可到 N+1）由 W5 写进设计 30 §5 / 调度说明，不另记偏差。（W5 已写入设计 30 §5.3、design/02「调度器与名额」、docs/dev/02「调度」。）

**已知缺口（审查复核 #5，留给 W2 / W3）**：浏览器下载目录与页面共享冲突。页面按（Bot, 对话）共用一个（desktop `browser-host.ts`），`ensurePage` 每次把该页面的 `downloadsDir` 改成本次执行的目录，`will-download`（`browser-host.ts` ~497）在下载**开始时**才读 `page.downloadsDir`。同一对话里只读执行（对话轮 / 只读任务，目录 = 应用缓存 `readOnlyDownloadsDir`）与写任务（目录 = workspace `downloads/`，core `tools/browser.ts` ~96 / `tools/index.ts` ~789 在构建工具时固定）并发使用浏览器时：只读执行 ensure → 写任务 ensure（改回 workspace）→ 只读执行 click 触发的下载落进 workspace。core 侧加锁只能覆盖 ensure + click，覆盖不了点击返回后才开始的下载，因此 core 内无法闭合。修法需要 desktop / shared RPC 改动二选一：① 下载目录随触发动作（click / open）下发并绑定到该次导航，`will-download` 用动作时刻的目录；② 只读执行与写执行不共用页面（页面键加上执行的写入能力）。W2 注册对话轮工具面时若去掉浏览器（见上 W2 项）可先消除对话轮这一侧，只读任务仍有此缺口。

**硬次序约束（W4 审查 M1，W2 必须遵守）**：调度器对外部 Agent（`agent:*`）的任务不留回复名额、回复也不能借名额（`scheduler.ts` `#runnable`），前提是对话轮固定内置引擎（§8.1）。W2 落地前外部 Agent Bot 的响应 run 仍走 `agent:*`——上限 1 的 Agent 上一个任务会让该 Agent 的回复饿死数小时。目前不可达（`start_task` 尚未注册进任何工具面），因此 **`start_task` 注册与「对话轮 = 内置引擎」必须在 W2 的同一变更里落地**；以后若有对话轮再跑在 Agent 上（设计 30 §8.4 经 `complete()` 的降级），须恢复 Agent provider 的回复保留名额。

### W4 外部引擎 + W2-D66（2026-10-08，与 W2 对话轮并行；合入 `d75`：W4 `ad5a749`、W2-D66 `6fdb4a9`）

- **W4**（`0b1ab3e`、`8775170`、`ac61075`）：去掉外部智能体 Bot 任务的失败关闭路径，`runtime.agent` 即任务引擎，门禁 / 引擎缺失 / 项目配置拒绝 / Agent setup 失败经 `TaskHost` 结算。main `0019_agent_sessions_per_task.sql`：`agent_sessions` 重建，唯一键 `(bot, 对话, Agent, task_id)`，`task_id = ''` = 非任务 run，D72 期旧行清空。每个任务独占会话行、桥 / 引擎键与 token——**键随会话行**（`bot:conv:agent:task:{行 id}`，DEV-010，待确认）；`continues_task_id` 在旧任务执行结束后单条 `UPDATE` 继承其行，指纹不符新建；任务的增量只取共享行。只读任务强制 `read_only` 档；任务 cwd = `task_workdir`，写任务租约由 `#startTask` 持有。steering 异步拒绝经 `TaskRunControl.steerRefused` 把 inject 条目降为 `queued`。结算后的任务会话保留 `CONTINUATION_WINDOW_MS`，reaper `session/close` 并删行。调度器：`agent:*` 上的任务用满上限、不为回复预留、回复也不借用（M3 借用不适用于 `agent:*`）。测试 `external-agent-tasks`、`agent-sessions-per-task`，迁移版本断言补 19。
- **W2-D66**（`8dc395f`，原 W1-A 第 5 项）：删除 `SubagentHost`、`SubagentFollowUp`、orchestrator `#injectDelegateFollowUp` 与 `SUBAGENT_FOLLOWUP_EVENT`；`delegate_task` 后台模式改为父 run 内并行分支，结论经新工具 `collect_delegate_results` 取回（等待、按委派顺序、每条一次），从不进对话、不唤醒新一轮；父 run abort 级联、结束时 `facade.close()` 中止并等分支 settle（先于释放租约与任务结算）；`SUBAGENT_BACKGROUND_CONCURRENCY` 按父 run 计；对话轮与子代理调用 `delegate_task` 执行期拒绝。设计 23 补后台分支实现说明。
- **验证**：两者合入后容器全量（`d75`）1688 例：调度会话判定**无真实新增失败**——另有 `browser`（删 Bot 竞态）、`memory`（两个 Bot 同时产生画像提案）各 1 条偶发，以及 `sandbox-isolation.test.ts` 整文件加载失败（批 B 的 `onAutoRevoke` 订阅缺桩，见下文合并修正 `9661b5d`）。

### W2 对话轮（2026-10-08，合入 `d75` @ `4ae4076`）

- 提交：`dea5385`（`loop_type` `'response'` → `'turn'` 全仓改名，shared 去掉 `'response'`、不留别名；宿主伪身份改用仅 core 的 `'host'`；runs `0007_turn_loop_type.sql` 改写旧行）、`6f96faa`（对话轮主体）、`65ede29`、`6efd5b7`、`655bf94`、`16d04aa`、`f96f216`、`085fb24`、`1a10520`、`e32a3c5`、`36c2e72`、`7ccd4f6`、`4ef2477`、`b3c3c41`、`c584a26`（DEV-011 / DEV-012），中途合并 `d75`（`75ae82c`，吸收 W4 与 W2-D66）。
- 内容：mailbox 不再 steer 进对话轮——运行中到达的批缓冲、release 时合并为一批（每个来源批保留 reason / 属性，一个 `<trigger>` 一段）；被看过的消息编辑以 `message_edited` 事件进下一轮；`#pendingSteers` / `#steerRunningRun` 与响应 run 的外部 Agent steer 日志删除。对话轮固定内置引擎 + Bot 内置主模型、`TURN_MAX_TURNS`（用完按 failed 结算并提示派任务）、对话轮版 `<platform_rules>`、`<tasks>` 段；对话轮工具面 = 对话核心、只读查询（read / ls / find / grep，无 bash）、任务工具（含 `forward_task_result`）、异步托管动作；无 MCP / 浏览器 / 媒体 / 安装 / 访问申请 / `delegate_task`。任务工具面 = 完整工具面去掉任务管理、委派、管家提议；任务版与 ACP 版 `<platform_rules>`。§3.2 消费接到对话轮终态；D56 自动续接移除，任务保留 `continues_task_id` 回放；群轮次只在对话轮终态推进，轮次中途新批不再抄送正在响应的 Bot。§8.4 第 2 级降级（无内置模型的 Bot 确定性路由，DEV-011）；`queued` 注入渲染为「未送达」。testkit：`inTurn()` / `inTask()` lane、惰性工具参数、`viaTask()`。新增 `supervisor-turns`（集成）与 mailbox / `<tasks>` / 提示词单测；`response-loop` / `group-chat` / `approvals` / `environment` / browser / MCP / wiki / workspace / sandbox / skills / projects 测试按「工作在任务里做」迁移。
- **顺序约束**（W4 审查 M1）：`start_task` 的注册与「对话轮 = 内置引擎」在本波同一变更落地，满足 `agent:*` 不留回复名额的前提。
- **验证**：W2 合入后外部智能体 P1–P6 测试仍按回复 run 语义编写，由下文 xa1 / xa2 迁移；迁移后的全量见下。

### 修复批 C：W4 / D66 审查（`t/d75-fixc`，2026-10-08，合入 `d75` @ `267dc12`）

- `82a289e`（审查 M2）：workspace workdir 的写任务在绑定 project 的对话里，经卡片批准的沙箱外命令可能无租约、无检查点地改写 project——权限桥改为询问 `unleasedProject(identity)`：沙箱外命令的 cwd 在其中、参数指向其中或之上、或无法静态分析的，一律拒绝不弹卡（与无人值守同一套 fail-closed 分析，以 project 为禁区根）。
- `0f07ff3`（M3、L4、L5、L6、L8、L10）：外部智能体任务只在 `agent:{id}` 有余量时启动（`launchSlot`，超出的停在 submitted「等智能体并发额度」，不占名额、不持租约）；steer 以引擎的 `steer` 事件确认（`steerConfirmed`），拒绝 / 确认按文本 FIFO 取最早一条；被 reaper 驱逐、尚未真正结束的执行仍算「执行中」，`continues_task_id` 不继承可能在忙的会话；没有记录 workdir 的任务在 workspace（`#startTask` 取租约的根）跑 Agent；引擎 run 启动后抛错先 abort 再释放租约与结算；workspace workdir 的 Agent 任务不注入 `<project>`。
- `f1b0570`（D66 L1、L2、L3、L7）：`runs.cancel` 子 run 不走「排队未开始」分支；排在别的前台分支后的前台分支由门面当场结算 `cancelled`；`collect_delegate_results` 先认领分支再等待（并发 collect 不重复交付，被取消的释放认领）；`close()` 最多等 `SUBAGENT_CLOSE_GRACE_MS`；`collect_delegate_results` 列入 `NEVER_INJECTED_TOOLS`。
- `cdcbdb9`（M1）：调度器注释与本文 §5 写明「`start_task` 注册与对话轮固定内置引擎须同一变更落地；对话轮再跑在 Agent 上时须恢复回复预留」。

### 合并修正（调度会话）

- `9661b5d`：`sandbox-isolation.test.ts` 的网关补 `grants` 桩——批 B 的 `onAutoRevoke` 订阅让整个文件加载失败（W4 + D66 合入后的全量里这 10 条基线用例显示为跳过而非失败，逐条比对新增失败时不会显出来）。
- `26e15f2`：`approvals.test.ts` 只数审批卡——W3 的任务卡同为 `kind='card'`，「once 授权只覆盖单次工具调用」一例的卡片计数被它抬高。

### 外部智能体测试迁移（2026-10-08，合入 `d75`：xa1 `1d8ed8b`、xa2 `f9fb528`）

- **xa1**（`a9bddaf`）：P1 / P2 / P3 测试改为任务引擎语义——每批用户消息的对话轮跑内置（脚本）模型、派任务并确认，任务跑在假 ACP Agent 上，结果 / 失败唤醒对话轮转述。旧性质在任务层断言：任务引擎 / 伪 ref / 步骤 / `origin:'task'` 中间说明 / 私有结果条目；Agent 与内置任务步骤对齐；Agent 门禁失败把 setup 记在任务上；任务准备期间到达的 `inject_task` 并入首个 prompt；桥工具、能力包与审计归属任务；`SETUP_REQUIRED` 在任务上；`skip_reply` = 空结果不唤醒。P3：权限档、卡片与授权、无人值守底线、`cancel_task` 应答挂起的权限请求、模式回改、项目配置确认、写任务钉住的租约、内置写任务等租约（submitted）。
- **xa2**（`e30ec63`、`ac54b84`）：p4b / p5 / p6 迁移——setup / 登录门禁让任务以结构化 setup 失败、失败唤醒对话轮、`runs.retry` 派出接续任务；会话复用 / 增量改经 `continues_task_id`（按任务的行）；注入被拒 → `queued` 条目 → 唤醒的对话轮接续；重启、崩溃 + resume、移出群竞态、steer 期间删 Bot；反思由完成的任务登记。**修了一个真实缺陷**（`ac54b84`）：接续任务复用来源任务的 Agent 会话时，来源任务被 steer 进去的注入的原消息又出现在增量对话段里——已见记录只跟踪 D72 回复 run 的 steer，而 W2 删除了那条路径。`TaskRunControl.steerConfirmed` 改为返回被确认注入的原消息 id，任务的 Agent run 把它们记为会话已见（P5 审查 #3 契约，`external-agent-p5`「shown neither by the task context nor its inject」覆盖）。
- **验证**：迁移后容器全量（`d75`）**1714 例**，新增失败只有偶发的 `web-tools`（`web_fetch` 二进制 / 私网 / 重定向复检，负载超时）；`projects`「blocks switching projects while a bot is executing」由失败转为通过。

### 修复批 D：W2 审查（`t/d75-fixd`，2026-10-08，合入 `d75` @ `a1bfcd8`）

- `3e96e23`（H1）：main `0020_usage_turn_loop_type.sql`——`usage_ledger` 的 `'response'` 行改为 `'turn'`（否则 `usage.summary` 输出校验失败、每日后台预算把它们算成后台用量）。
- `6151252`（M4、L1、L2、L4、`send_message` HIGH）：`send_message` 只上传网关此刻允许读取的附件（可授权路径不再未经审批就读取上传）；对话轮永不等用户——`propose_profile_change` 非阻塞提交（决定经 `profile_change_result` 事件唤醒下一轮，卡片比对话轮活得久），越界的 read / ls / find / grep 当场失败并提示派任务；任务不再 @ 群成员（无 `mention_bot_ids`、无连锁钩子）；`get_run` 只看自己的执行；`<tasks>` 里模型给的标题与任务进度包 `<untrusted>`。
- `ca382a4`（M1、M2、M3、L3、L6）：对话轮开始执行时（隔一个 tick）吸收已缓冲的批并重读消息（取最新编辑、去掉撤回的）；mailbox 合并保留每条消息的最新快照；任务结果只由「处理了触发且以 completed / failed 结束」的对话轮消费，启动前取消、停用 / 只读、用户 / 更新闸门取消留给对账（`reopenConsumption` 删除）；runs `0008_turn_trigger.sql`：`trigger_parts_json`（重试保留各段 reason 与属性）、`retry_of_run_id`（重试的对话轮不重复派出被重试那一轮已派出的任务）。
- `e3ccf6d`（M5）：§8.4 降级路由的注入若最终没被任务收下（异步拒绝、缓冲后未被收下），另起一个任务（`TaskHost.inject` 的 `onNotDelivered`）；每个触发段按来源标注（用户消息、编辑、系统事件、定时、委派、连锁）。
- `b9f7d23`（M6、L7）：群聊判断超时从提交起算，到时按「仅 @ / 回复」放行，仍在排队的作业撤出；`group-chat` 的访问审批用例改在任务里读。
- `184b0b6`：外部智能体 Bot 的任务在创建时就记 engine / provider（门禁失败的任务不再显示 `builtin`）。`b150fbf`：`forward_task_result` 原文转发的消息记为来源任务各 Agent 会话已见。
- `98c4cce`：DEV-013（`create_skill` 留在对话轮）、DEV-014（消费规则、对话轮不等用户、群聊判断超时）；本节原有的迁移号说明如下。
- **迁移号**：D73 原预留的 main `0018`–`0020` 现已全部被 D75 占用（0018 task_events、0019 agent_sessions 按任务、0020 usage_ledger），runs 用到 `0008`；**D73 开工时 main 从 `0021` 起、runs 从 `0009` 起**（按其方案「号以目录实况为准」）。

### W3 消息与界面（2026-10-08，合入 `d75` @ `da97adc`）

- core（`758f21a`、`a88f26e`）：`task.updated` RPC 事件与 `TaskView`（标题、状态、排队原因、等待输入、注入行含后来的 delivered→queued 降级、取消原因、改动摘要、setup、接续链路），在任务的每次 `run.status`（start.ts 订阅覆盖任务宿主、执行体与租约等待）与非状态变化（注入、注入降级、`control.waiting`、泵送后排队原因变化、问题回答）时推送；`start_task` / `runs.retry` 写可见任务卡（`cardType 'task'`，`runId` + `task_id` = 任务），`renderCard` 渲染为一行状态；取消卡数据：project 写任务给检查点计数（经 `projects.revert` 整次回退），workspace 写任务列文件工具写过的文件（无检查点、无回退）；project 任务的改动摘要在任务结算后才落定时重绘卡片。`ask_user`（只在任务）：绑定任务的问题卡（`system_event task_question`）+ 私有 `question` 条目 + `awaiting_input`，用户点选（`tasks.answer`）或对话轮 `inject_task` 回答，记为 inject 条目，卡片显示答案。RPC `tasks.get` / `tasks.active` / `tasks.answer`。集成测试 `task-cards`。
- desktop（`f0676c2`、`449649c`）：tasks store；`TaskCard`（排队原因、等待输入、最近进度、注入行含「未送达」、取消；取消卡改动摘要；失败任务可重试，缺 setup 的交给对话内设置卡）；`TaskQuestionCard`；状态行 = 对话轮自己的一行 + 进行中任务合并的一行（一个：标题 + 活动；多个：条数 + 最近、可展开），租约层等待保留「强制收回」；`origin:'task'` 消息标为任务进度 / 转发的结果；未设 setup 的失败任务不再弹失败横幅；未读数不再回退 `lastSeq - lastReadSeq`（会算入私有行）；zh-CN：`RUN_READ_ONLY` / `TASK_LIMIT_REACHED` / `RUN_ALREADY_FINISHED` / `RUN_NOT_FOUND` / `NOT_SUPPORTED` 与任务文案，`runtime.agent` 文案改为「任务引擎」（含 onboarding、Agent 设置卡）。单测 task-view、unread、setup-continue。
- e2e（`756662c`）：新增 `tasks.spec.ts`（派任务 → 任务卡 → 进度归属 → 注入行 → 结果转述 → 在第二个任务的卡片上取消〔workspace「无回退」说明、不唤醒〕；project 写任务取消 → 改动计数 + 整次回退；问题卡选项直注任务）；`browser` / `projects` / `environment` / `sandbox` spec 的工作改在任务里做（`viaTask`）；`projects.spec` 租约用例改为「排在另一对话的写任务之后、卡片与状态行显示「等写入租约」、在其卡片上取消后执行」（强制收回不适用任务层排队，DEV-015）；用量页的回复行改为「对话轮」。
- **验证**：合入后容器全量 **1755 例、33 失败**：除 `approvals`「a once-grant covers a single tool call (D75)」一条（任务卡也是 card，计数被抬高；`26e15f2` 已修正）外均在基线集合内，`projects` 少一条（见上）。e2e（`kepcup-test:trixie-xvfb`）**70 例、3 例失败**（`browser.spec`「删除 Bot 后其浏览器分区数据不存在」、`sandbox.spec`「run status line shows the command description while a command executes」、`wiki.spec`「wiki tab: browse the page tree …」），与 main 上的失败一致。DEV-015 记于本波。

### W5 文档收口（2026-10-08，`t/d75-w5`）

- `docs/design/02-execution.md` 整篇重写；设计 30 折入实现期细化（DEV-009–DEV-015 一律标「待确认」，调度名额规则写进 §5.3）；01 / 04 / 08 / 12 / 13 / 23 / 24 / 27 / 28 与 design README 的 D75 修订注按实现更新；`docs/dev/02` / `03` / `04` / `05`、`PROGRESS.md`、`DEVIATIONS.md`（各条「已更新的文档」）同步。

**偏差汇总**（全部待用户确认）：DEV-009、DEV-010、DEV-011、DEV-012、DEV-013（调度会话已决定）、DEV-014、DEV-015。

**已知缺口**

- 只读任务的浏览器下载目录竞态（上文 W1 已知缺口：页面按（Bot, 对话）共用，`will-download` 在下载开始时才读目录；对话轮已无浏览器工具，只读任务仍有此缺口，需 desktop / shared RPC 改动）。
- workspace workdir 的写任务写 project 而不取 project 的租约（W1 LOW-3 同类：写任务只持自己 workdir 的租约；`82a289e` 只堵住了外部智能体的沙箱外命令这一路）。
- 外部智能体任务没有 `ask_user`（不在任何宿主能力包内）。
- 设计 30 §6.3 的「Bot 详情栏 / 对话头部的进行中任务数」与「执行记录页任务与对话轮分列」未做。
- `projects.test.ts` 里仍假设「回复 run 持有写租约」的用例（基线失败的几条）需要按任务语义重新设计。
- 纯对话轮的反思去抖（设计 30 §7.2）未做：每个 `completed` 对话轮都登记反思。

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

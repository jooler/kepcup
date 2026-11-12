# D123 并行写任务与任务间协调：执行方案

> 设计：[docs/design/59-parallel-tasks-and-coordination.md](../docs/design/59-parallel-tasks-and-coordination.md)（D123，以设计为准），关联修订：[30 §5 / §9.3 / §2.2 / §2.4.5](../docs/design/30-supervisor-and-tasks.md)、[08 租约节](../docs/design/08-workdir.md)、[02 执行模型](../docs/design/02-execution.md)。本文只规定**怎么做、怎么验收**。
> 状态：**W1–W6 已实现（2026-11-11）**，W7 收口中。分期 T1–T7（设计 §9），每期独立可交付、可单独合入；T2 之前现有行为零变化。

## 0. 给执行代理的规则（必读）

1. 先读：`AGENTS.md`（测试策略：迭代中只跑定向测试）、`docs/dev/01-conventions.md`、`docs/design/59` 全文、本文你所在工作流的小节与 §2 契约；涉及调度读 `docs/dev/02-architecture.md`，涉及数据读 `docs/dev/03-data-model.md`。
2. **测试只跑定向**：`node scripts/run-tests.mjs run <测试文件或目录>`（可加 `-t "用例名"`）；改了 shared 契约先 `pnpm --filter @kepcup/shared build`，改 core 后 `pnpm --filter @kepcup/core build`（vitest 直测 src 不需 build，但跨包消费需要）。全量 `pnpm test` 只在 T7 收口跑**一次**。
3. typecheck 按包跑：`pnpm --filter @kepcup/<包> typecheck`；lint 只跑改动涉及处。
4. 设计与现实冲突、契约不够用 → 停下受影响部分，写进 `docs/dev/DEVIATIONS.md`（新编号接现有最大 DEV 号顺延），继续不受影响的部分。不擅自改设计决策。
5. 提交：Conventional Commits（`feat(core): …` / `test(core): …`），每个提交可构建、定向测试通过。
6. 代码、标识符、注释用英文；新界面文案进 `renderer/src/lib/i18n/locales/`（zh-CN / en-US 同时补）。
7. **行为不变红线**：T1–T3 全部落地后，不声明写域的写任务（`writes: true`）与只读任务的行为必须与改动前逐字节一致（排队原因文案除外——见 §2.6，文案变化要同步更新既有测试断言）。每个工作流的验收都含「既有测试不新增失败」。

## 1. 波次与依赖

| 波次 | 内容（设计章节） | 依赖 | 可并行 |
|---|---|---|---|
| **W1 写域地基** | glob 相交纯函数、迁移 0015、shared 类型与常量、`start_task` schema 与校验（§2） | — | 单独先行 |
| **W2 调度与租约** | `#blockedBy` 域判定、租约键结构化 + 可注入冲突谓词、排队原因（§3.3–3.5） | W1 | — |
| **W3 执行期强制** | 网关 / 文件工具域判定、沙箱策略摸底与收紧、外部引擎降级（§3.6–3.7） | W2 | W4 可并行（文件不相交） |
| **W4 任务间协调** | `<peer_tasks>` 段、`send_to_task` / `wait_for_task`、`peer_message`、等待注册表（§4） | W1 | 与 W3 并行 |
| **W5 认领** | claim / release + 写路径拦截 + TaskView（§5） | W3（拦截面）、W4（同工具面） | — |
| **W6 提示词与界面** | 两版提示词、`<tasks>` 段写域、任务详情页、i18n（§6） | W2–W5 | — |
| **W7 收口** | dev 文档同步、全量回归一次、`DEVIATIONS.md` 复核 | 全部 | 单独 |

单人推进时按 W1 → W2 → W3 → W4 → W5 → W6 → W7 顺序即可；两人时 W3 与 W4 可并行（W3 动 gateway/coding-tools/sandbox，W4 动 tasks.ts 的新增段与 tools/task-tools.ts，冲突面在 `TaskHost` 构造注入——W4 先行的把 claim 注册表的**占位**留好）。

## 2. 契约（必须原样落成代码；与代码现实冲突时记 DEV 并停下受影响部分）

### 2.1 迁移（runs.db，下一个空号 = `0015`，开工前以目录实况为准）

```sql
-- packages/core/migrations/runs/0015_task_write_domains.sql
ALTER TABLE runs ADD COLUMN task_write_domains TEXT;  -- JSON string[] | NULL
```

无表重建、无数据回填（`NULL` = 未声明，读路径按 `task_writes` 解释）。`docs/dev/03-data-model.md` 的 runs 表与迁移版本断言在 W7 同步（参照 `unit/task-cwd-migration.test.ts` 的做法补一条列断言进 `unit/runs-tasks.test.ts`）。

### 2.2 shared 类型与常量

- `packages/shared/src/domain/types.ts`：
  - `runSchema` 增 `taskWriteDomains: z.array(z.string()).nullable().default(null)`（放 `taskCwd` 之后）。
  - `taskEventPhaseSchema` 增 `'peer_message'`；`taskEventContentSchema` 增可选 `fromTaskId?: string`、`fromTitle?: string`（`peer_message` 专用）。
- `packages/shared/src/errors.ts` 增错误码：`WRITE_OUT_OF_DOMAIN`、`WRITE_CLAIMED`、`TASK_PEER_NOT_FOUND`、`TASK_PEER_FINISHED`、`TASK_WAIT_CYCLE`。
- `packages/shared/src/constants.ts` 增（带来源注释）：

| 常量 | 初始值 | 含义 |
|---|---|---|
| `TASK_WRITE_DOMAINS_MAX` | 8 | `writes` 数组去重后的模式数上限 |
| `TASK_WRITE_DOMAIN_PATTERN_MAX` | 200 | 单条模式字符上限 |
| `TASK_PEER_MESSAGE_MAX_CHARS` | 4000 | `send_to_task` 文本上限（对齐 `DELEGATION_TASK_MAX_CHARS`） |
| `TASK_PEER_SEND_MAX_PER_RUN` | 10 | 单个 run 发送条数上限 |
| `TASK_PEER_WAIT_TTL_MS` | 30 分钟 | `wait_for_task` 缺省超时 |
| `TASK_PEER_WAIT_TTL_MAX_MS` | 120 分钟 | `timeout_minutes` 上限 |
| `TASK_PEER_WAIT_RESULT_MAX_CHARS` | 4000 | 等待返回的结果摘要截断 |
| `TASK_CLAIM_PATHS_MAX` | 16 | 单次 `claim` 模式数上限 |

### 2.3 写域纯函数（新文件 `packages/core/src/workdir/domains.ts`）

```ts
export function normalizeDeclaredDomains(patterns: string[]): string[] | null; // 校验：非空、无绝对路径、无 '..'、去重、截断前先抛 INVALID_INPUT 语义（返回 null 表非法，调用方生成错误）
export function absolutePatterns(cwd: string, patterns: string[]): string[];
export function globsIntersect(a: string, b: string): boolean;      // 保守：判不了即 true
export function domainsConflict(a: AbsDomain, b: AbsDomain): boolean; // 两集合两两 globsIntersect
```

- 匹配器复用保护规则（`denyRead`）现用的 glob 依赖——**W1 第一步**：在 core 中定位现有 glob 匹配的依赖与调用点（`protectRules` / 沙箱策略），直接复用，不新增依赖；若现有依赖没有「两模式语言相交」能力，按段比较自实现 `globsIntersect`（匹配器只用于「具体路径 vs 模式」的测试断言）。
- **保守语义（设计 §3.2）**：逐段比较；`**` 与一切后续内容相交；段数不齐、含转义 / 不认识的字面 → `true`；两模式完全相同 → `true`。**假阴性禁止，假阳性可接受**。
- 单测表（新 `packages/core/test/unit/workdir-domains.test.ts`）至少覆盖：`['**']` vs 任意 → true；`src/**` vs `src/a.ts` → true；`src/**` vs `lib/**` → false；`a/*` vs `a/b/c.ts` → true（`*` 不跨段但保守）；`a/**` vs `b/**` → false；`a/**/c` vs `a/b/c` → true；大小写 / 分隔符归一（Windows `\` → `/`，比较前统一）；相同模式 → true；空串 / `..` / 绝对路径被 `normalizeDeclaredDomains` 拒绝。

### 2.4 `start_task` schema（`packages/core/src/tools/task-tools.ts`）

- 参数 `writes` 类型改为 `Type.Union([Type.Boolean(), Type.Array(Type.String({ description: '相对 cwd 的 glob，如 apps/renderer/**' }))])`（L352-395 处）；`StartTaskInput.writes` 改 `boolean | string[]`（L31-47）；宿主侧归一化：`true → ['**']`、数组走 `normalizeDeclaredDomains` 校验（超限 / 非法 → `INVALID_INPUT` 并列出违规项，**不落 runs 行**）、`false/省略 → null`。
- `TaskHost.start`（`dispatch/tasks.ts` L638 起）解析 `cwd` 为绝对路径后，把归一化 patterns 与绝对路径一并传入 `runs.create` 落库；`continues_task_id` 接续时缺省继承来源任务声明、显式传参覆盖（同今日 capabilities 并集的做法改为覆盖——以 §2.2 落库值为准）；`runs.retry` 沿用行上声明。

### 2.5 `#blockedBy` 与租约

- `dispatch/tasks.ts` `#blockedBy`（L2138-2164）：第三个检查从「`launched.cwd === task.taskCwd`」改为「`domainsConflict(launched.domain, taskDomain)`」——`LaunchedTask` 增 `domain: { root, patterns } | null`（`writes: true` = `{root, patterns: ['**']}`，只读任务 `null`）；判定跨对话、跨 Bot（遍历全部 `#launched`，与今日同口径）。排队原因：`等写域（任务 {taskId} 持有 {patterns.join(', ')}）`；`['**']` 显示「整目录」。
- `workdir/lease.ts`：`LeaseService` 构造函数增可选 `conflict?: (a: string, b: string) => boolean`，缺省为现 `leaseKeysConflict`（L27-31 原样保留为缺省实现）。内部三处调用点（L63 新建等待者、L161 查冲突持有者、L204 `#promoteConflicting` 唤醒）**全部**改走注入谓词；`leaseKeysConflict` 仍导出（现有 `unit/workdir-lease.test.ts` 直接 import 测它，不改该文件的既有断言）。`SlotYieldingLeaseService`（`scheduler/slot-yielding-lease.ts:14`）构造函数须透传 `conflict` 给 `super()`——漏了会让调度器实例静默退回前缀规则。
- 写任务的租约键（`workdir/service.ts` `#leaseTarget` L675-701 与 `ensureWriteLease` L269-313）：任务写任务（`pin` 路径）的键编码为 `dir:{root}|domains:{patterns 按 ASCII 排序后 join ','}`（新增编码器 + 解析器；解析不出 domains 的键视为 `['**']`）；传入域感知冲突谓词 = 「解析双方 domains 后 `domainsConflict`」。`ws:` 键同样带 domains 后缀。`waiting_lease` / FIFO / `SlotYieldingLeaseService` / `forceRevoke` 语义零改动。
- **`ensureWriteLease` 四个调用点只有一处改**：`orchestrator.ts:3729`（`#startTask` 任务钉住，读 runs 行的 `task_write_domains` + `task_cwd` 传域键）；其余三处保持整根键（视为 `['**']`，行为不变）——`orchestrator.ts:3630`（宿主伪身份）、`gateway/index.ts:605` 与 `tools/index.ts:847`（自动申请，`needs_lease` 路径）。改动面按此收敛，不要顺手改另外三处。

### 2.6 行为不变验收口径

`writes: true` 的写任务：域 = `['**']`，与任何写任务相交 → 排队与今日一致；与宿主伪身份 / 对话轮的整根租约相交 → 与今日一致。**允许的可见差异**：①排队原因文案从「等写入租约（任务 … 持有）」变为「等写域（任务 … 持有 整目录）」；②`<tasks>` / `<peer_tasks>` 行的写任务标签从「写」变为「写（全域）」（design 59 §6 规定；只读仍为「只读」）。既有测试断言（`integration/tasks.test.ts`、`integration/external-agent-tasks.test.ts` 的排队用例、`e2e tasks.spec.ts`）按新文案更新并在交付说明里列出。

### 2.7 执行期强制（W3）

- `gateway/index.ts` `checkPath`（L371、L394-400）：`mode === 'write'` 且只读判定通过后，若 run 声明了域（`task_write_domains` 非 null 且非 `['**']`）→ realpath 后的绝对路径不匹配任何绝对模式 → `{ kind: 'forbidden', outOfDomain: true }`，工具错误 `WRITE_OUT_OF_DOMAIN`，消息含本任务域列表与越域路径、提示「需要越域请 ask_user 由对话轮改派」。
- `coding-tools.ts` `assertMayWrite`（L90-93）同步纳入（前置拒绝路径）；生成产物写入（`tools/index.ts` L1137-1147 `recordGenerated` 所在路径）走同一判定。
- fail-closed：runs 行缺失、域解析失败、realpath 失败 → 拒绝。
- 沙箱策略（`sandbox/policy.ts`）：声明域的任务生成策略时，把 workdir / workspace 的可写规则收紧到声明子路径（按现策略系统的规则粒度能表达多少做多少）；**不能表达的按现状放行**，并在任务简报尾注一行「命令写入不受写域强制，冲突由检查点兜底」。覆盖度结论写进 `DEVIATIONS.md`（DEV-xxx：沙箱域收紧覆盖度），不静默。
- 外部引擎（`agent/external/`）：调度与租约已由 W2 覆盖（零改动）；执行期降级 = ①任务触发段（`buildTaskInjection` / 简报构建处）域非 `['**']` 时追加一行「本任务只应写入：…」；②`permission-bridge.ts` `classifyPermissionRequest`（L244）对 'ask' 档且提取到路径的写请求，域外路径在卡片说明里附提示（不自动拒绝）。

### 2.8 任务间协调（W4）

- **`<peer_tasks>` 段**：`agent/context/tasks-segment.ts` 新增 `buildPeerTasksSegment(tasks: TaskSummary[], selfTaskId: string): string`（字段：`[taskId]` + `<untrusted>title</untrusted>` + state + 写域或「只读」+ 排队原因 + 等待输入；不含自己、不含进度文本）；`orchestrator.ts` L4040-4046 拼装处：`isTask ? buildPeerTasksSegment(...) : buildTasksSegment(...)`。数据源复用 `this.#taskHost.list(identity)`（同（Bot, 对话）过滤已有）。
- **`send_to_task(task_id, text, source_message_ids?)`**（`tools/task-tools.ts` 新增；只注册进任务工具面）：校验目标是同（Bot, 对话）非本任务、非终态（终态 → `TASK_PEER_FINISHED`；找不到 / 跨对话 → `TASK_PEER_NOT_FOUND`）；per-run 计数 ≤ `TASK_PEER_SEND_MAX_PER_RUN`（超限 `TASK_LIMIT_REACHED` 语义）。投递复用 `TaskHost.inject`（L777-854）的分支 2/3：`running` → steer（同步拒绝一次后按 `queued` 语义返回说明，不阻塞发送方）；已 attach 前 → 并入 `buffered`。**等 `ask_user` 的目标不当作回答**（走普通注入排队，与 §4.2 设计一致）。落盘：接收方 `appendTaskEvent` phase `peer_message`（`messages.ts` L756-807 既有函数，带 `fromTaskId` / `fromTitle`），owner 归属 = 接收方任务的 Bot（既有 owner 过滤照常）。
- **`wait_for_task(task_id, timeout_minutes?)`**（只注册进任务工具面）：TaskHost 新增等待注册表 `#peerWaits: Map<targetTaskId, { waiterRunId, resolve, timer, abortCleanup }>`；注册前做环检测（沿 `#peerWaits` 的 target→waiter→其注册的 target 链 DFS，成环 → `TASK_WAIT_CYCLE` 并列环）；等待执行 = `Scheduler.yieldSlotWhile`（同 `ask_user`，`tasks.ts` L1720-1723 模式）+ 墙钟豁免（复用 `questionSince` 机制加 `waitSince` 字段，reaper 计时处一并豁免）；**写租约保留**（同问题卡）；目标 settle（`settle` L1338-1436 终态落库后）解析等待项，返回 `{ status, resultDigest? }`（结果按 `TASK_PEER_WAIT_RESULT_MAX_CHARS` 截断）；超时返回 `{ status: 'still_running', queueReason? }`；目标先取消 / 失败 → 对应终态 + 错误摘要；本任务 abort / settle 时清理注册表。等已终态任务 → 立即返回其终态（查 `terminalTaskEvent`）。
- 工具面注册：四个新工具（含 W5 的 claim/release）都只进任务面（`tools/index.ts` 任务面组装处，参照 `ask_user` 的注册方式）；对话轮面不注册；`start_task` / `inject_task` / `cancel_task` 在任务内的拒绝逻辑（L398-401）不动。

### 2.9 认领（W5）

- TaskHost 新增 `#claims: Map<taskId, { patterns: string[]; reason: string; since: number }>`（纯内存）；`claim({ paths, reason })`：paths 相对 cwd glob ≤ `TASK_CLAIM_PATHS_MAX`、必须全部落在本任务域内（`domainsConflict` 单向包含校验：`absolutePatterns` 每条必须匹配本任务某条域模式 → 否则 `INVALID_INPUT`）；`release({ paths? })` 缺省释放全部。settle / cancel / interrupt 自动清除（`#unsettled` / 终态路径统一挂）。
- 拦截点：W3 的网关域判定之后追加认领判定——目标路径匹配**其他任务**在重叠 root 上的 claim → `WRITE_CLAIMED`（消息含持有方 id / 标题 / reason）；同任务重复 claim 幂等。`coding-tools.ts` 的 `assertMayWrite` 与 `writeOps` 两条路径都要覆盖。
- `TaskView`（`tasks.ts` L1198-1280）增 `writeDomains: string[] | null` 与 `claims: { paths, reason, since }[]`，`task.updated` 照常推送；渲染端本期只在任务详情页展示（W6）。

### 2.10 提示词（W6）

- 对话轮版 `<platform_rules>`（`agent/context/system-prompt.ts`）：派写任务尽量声明互不重叠的写域（按包 / 目录举例）；边界不清晰就 `writes: true` 排队；`<tasks>` 段排队原因可能是「等写域」。
- 任务版：先看 `<peer_tasks>`；域外写会被拒，需要越域用 `ask_user`；动共享区前 `claim`、完成 / 改道 `release`；`send_to_task` / `wait_for_task` 的典型用法与「等待让出名额、不计墙钟」。
- 外部引擎触发段：域声明行（§2.7）。

## 3. 文件归属（避免冲突）

| 波次 | 主要文件 |
|---|---|
| W1 | `packages/core/migrations/runs/0015_*`、`shared/src/domain/types.ts`、`shared/src/errors.ts`、`shared/src/constants.ts`、`core/src/domain/runs.ts`（create / 行映射）、新 `core/src/workdir/domains.ts`、`core/src/tools/task-tools.ts`（schema + 校验） |
| W2 | `core/src/dispatch/tasks.ts`（`#blockedBy` / `LaunchedTask` / start 落库）、`core/src/workdir/lease.ts`（可注入谓词）、`core/src/scheduler/slot-yielding-lease.ts`（构造透传 `conflict`）、`core/src/workdir/service.ts`（域键 + `ensureWriteLease`）、`core/src/dispatch/orchestrator.ts`（仅 `#startTask` 取租约一处） |
| W3 | `core/src/gateway/index.ts`、`core/src/tools/coding-tools.ts`、`core/src/tools/index.ts`（生成产物路径）、`core/src/sandbox/policy.ts`、`core/src/agent/external/permission-bridge.ts`、`core/src/agent/context/*`（触发段域行，与 W4 同文件先协商） |
| W4 | `core/src/dispatch/tasks.ts`（peer 注入 / 等待注册表 / settle 解析 / 墙钟豁免字段）、`core/src/tools/task-tools.ts`（两个新工具）、`core/src/agent/context/tasks-segment.ts`、`core/src/dispatch/orchestrator.ts`（拼装处）、`core/src/domain/messages.ts`（phase 扩展在 W1 已含类型，此处只接 appendTaskEvent 调用） |
| W5 | `core/src/dispatch/tasks.ts`（claims 表 + TaskView）、`core/src/gateway/index.ts`、`core/src/tools/coding-tools.ts`、`core/src/tools/task-tools.ts` |
| W6 | `core/src/agent/context/system-prompt.ts`、`apps/desktop/src/renderer/**`（任务详情页 + i18n）、`shared/src/rpc/events.ts`（如 TaskView 投影需要） |
| W7 | `docs/dev/02/03/04`、`PROGRESS.md`、`DEVIATIONS.md` |

`shared` 三个文件只在 W1 动（W4 的 phase 扩展一并放 W1）；W2–W5 对 `tasks.ts` 的改动按「新增方法 + 独立区块」做，减少顺序合入的冲突。

## 4. 各波次范围与验收

### W1 写域地基
- 范围：§2.1–2.4 全部（phase 扩展提前到本波）。
- 验收：`node scripts/run-tests.mjs run packages/core/test/unit/workdir-domains.test.ts packages/core/test/unit/runs-tasks.test.ts packages/core/test/unit/task-tools-capabilities.test.ts`；迁移在新库与现有库上都前进（跑 `packages/core/test/unit/task-cwd-migration.test.ts` 同款断言补 `task_write_domains`）；`writes` 数组校验（超限 / `..` / 绝对路径 → `INVALID_INPUT` 不落行）单测；typecheck（shared + core）0 error。全量不跑。

### W2 调度与租约
- 范围：§2.5–2.6。
- 验收（新集成测试并入 `packages/core/test/integration/tasks.test.ts` 或新文件 `tasks-write-domains.test.ts`，用模拟模型服务）：三个写任务域两两不相交 → 全部 running（provider 名额内）；两任务域相交 → 后者 submitted 且排队原因含「等写域」与对方模式；`writes: true` 与域任务相交 → 排队；域任务 vs 宿主伪身份自动租约 → 排队（行为不变）；跨对话两任务同 workdir 域相交 → 排队、域不相交 → 并行；持有方 settle 后排队方自动启动；`writes: true` 用例的排队文案按 §2.6 更新断言。定向：`node scripts/run-tests.mjs run packages/core/test/integration/tasks.test.ts packages/core/test/unit/workdir-lease.test.ts packages/core/test/integration/workspace-lease.test.ts packages/core/test/integration/workdir-lease-windows.test.ts`。

### W3 执行期强制
- 范围：§2.7。
- 验收：域任务写域外文件 → `WRITE_OUT_OF_DOMAIN`（write / edit / 生成产物三条路径各一例）；域内写放行；只读与 `writes: true` 行为不变（`unit/gateway-read-only.test.ts` 全过）；沙箱策略收紧按摸底结论（能收紧的平台域外命令写入被沙箱拒绝一例；不能收紧的记录 DEV）；外部引擎触发段含域声明行（`integration/external-agent-tasks.test.ts` 补断言）。定向：`node scripts/run-tests.mjs run packages/core/test/unit/gateway-read-only.test.ts packages/core/test/integration/tasks-write-domains.test.ts packages/core/test/integration/external-agent-tasks.test.ts packages/core/test/integration/task-subagent-read-only.test.ts`。子代理路径：写任务的子代理沿父任务域判定（沿 `writeDenial` 的 parent 上溯逻辑扩展，`task-subagent-read-only.test.ts` 补用例）。

### W4 任务间协调
- 范围：§2.8。
- 验收：`<peer_tasks>` 段含兄弟任务 id / 标题 / 写域 / 状态、不含自己与进度文本（单测）；`send_to_task` 到 running 目标 → steer 送达且接收方时间线有 `peer_message` 条目（含 `fromTaskId`）；到 submitted 目标 → 并入待注入；到终态 → `TASK_PEER_FINISHED`；到等 `ask_user` 的目标 → 排队而非回答；per-run 限流；**泄露契约**：`peer_message` 条目只进接收方 owner Bot 的上下文（在 `integration/task-timeline-visibility.test.ts` 补断言）；`wait_for_task` 等到 completed / failed / cancelled 三种终态的返回、超时返回 `still_running`、环检测抛 `TASK_WAIT_CYCLE`、等待期间让出名额（并发名额计数断言）与墙钟豁免、等待中本任务被取消则清理。定向：`node scripts/run-tests.mjs run packages/core/test/unit/supervisor-turn.test.ts packages/core/test/integration/tasks-peer-coordination.test.ts packages/core/test/integration/task-timeline-visibility.test.ts`。

### W5 认领
- 范围：§2.9。
- 验收：claim 域外路径 → `INVALID_INPUT`；B 任务写 A 认领的路径 → `WRITE_CLAIMED`（含持有方信息）；A settle 后 B 同路径写放行；同任务重复 claim 幂等；release 缺省释放全部；TaskView 投影含 `writeDomains` / `claims`。定向：`node scripts/run-tests.mjs run packages/core/test/integration/tasks-write-domains.test.ts packages/core/test/unit/task-view.test.ts`（TaskView 单测文件以实况为准）。

### W6 提示词与界面
- 范围：§2.10 + 任务详情页（写域 / 认领 / `peer_message` 行渲染，复用注入行的样式）+ i18n 新错误码与文案两语言。
- 验收：任务详情页新块的 renderer 单测（写域 / 认领 / `peer_message` 行各一例，文件按该页现有单测同目录新建）；`pnpm --filter @kepcup/desktop typecheck`；提示词单测更新（`unit/supervisor-turn.test.ts` 的 `<tasks>` 写域列与任务版提示词新增段落）；i18n 两语言 key 齐全（跑渲染端 i18n 校验测试，若无则 `pnpm --filter @kepcup/desktop typecheck` 兜底）。定向：`node scripts/run-tests.mjs run packages/core/test/unit/supervisor-turn.test.ts` + 新增的 renderer 单测文件。

### W7 收口
- 范围：`docs/dev/02-architecture.md`（TaskHost 等待注册表 / 认领表）、`03-data-model.md`（runs 列）、`04-agent-runtime.md`（工具目录加四个新工具、`<peer_tasks>` 段）、`PROGRESS.md`、`DEVIATIONS.md` 复核；**全量 `pnpm test` 一次**（偶发失败只单跑复核，不连续多轮）；e2e `tasks.spec.ts` 补一条「分域并行两写任务」用例（可选，视 e2e 基线稳定性）。
- 验收：全量失败集合与既有基线一致（不新增失败）；typecheck / lint 0 error；本文档「实施记录」补齐提交与验证证据。

## 5. 已知限制（如实呈现，不静默）

1. **沙箱命令的域强制不完整**：命令写入只有策略系统能表达的部分被收紧；其余靠影子仓库 interleaved 冲突检测兜底。覆盖度记 DEV。
2. **外部智能体无执行期 per-path 强制**（ACP 只有整 run 档位）：调度与租约层面强保证，执行期靠提示 + 事后冲突检测。
3. **claim 纯内存不持久化**：崩溃后随任务中断消失，重启后由任务重新认领。
4. **provider 名额是真上限**（默认 4）：并行写任务超过名额会在调度器排队，不是任务层排队（排队原因不同，用户可见）。
5. **v1 协调范围限同（Bot, 对话）**：跨 Bot 任务协调是设计 §8 开放决策 1。
6. **`wait_for_task` 死锁靠环检测 + TTL**：跨任务非环等待（A 等 B、B 等 C、C 完成才能解 A）不存在死锁；环立即报错，非环最坏等 TTL。

## 6. 实施记录

分支 `feat/d123-parallel-write-domains`（基于 `v0.5.10`）。提交：

| 波次 | 提交 | 内容 |
|---|---|---|
| 设计 | `2738ed7e` | `docs(design): 新增 D123 并行写任务与任务间协调设计` |
| W1 | `3546859f` | `workdir/domains.ts`（校验 / 绝对化 / 保守相交 / 域冲突）、迁移 0015、shared 类型与常量、`start_task.writes` 联合类型与宿主校验落库、接续继承 / retry 沿用 |
| W2 | `19a17b03` | `#blockedBy` 域判定与「等写域」文案、可注入租约冲突谓词（三处调用 + SlotYielding 透传）、结构化租约键（仅任务钉住一处传域） |
| W3 | `4a1f0e19` | 网关 / write / edit / 生成产物域强制（`WRITE_OUT_OF_DOMAIN`）、子代理沿父任务域、沙箱可写挂载收紧（DEV-091）、简报域声明与外部引擎提示 |
| W4 | `94717f50` | `<peer_tasks>` 段、`send_to_task` / `wait_for_task`、`peer_message` 私有条目、等待注册表 / 环检测 / 让名额 / 墙钟豁免 |
| W5 | `7ca4e2a9` | `TaskClaimRegistry` + 网关 `WRITE_CLAIMED`、`claim` / `release` 工具、TaskView 投影、settle 清理 |
| W6 | `6683c266` | 两版提示词、`<tasks>` 写域列、任务详情页写域 / 认领 / peer 行、新错误码 i18n 两语言 |
| 审查 | `6cc89e8d` | 独立子代理四线复核后的修正（数据边界、协调生命周期、写域强制、租约、claim 包含、文档） |

验证（逐波定向，W7 全量一次）：

- W1：`workdir-domains` / `runs-tasks` / `task-tools-capabilities` / `task-tools-write-domains` 36 passed；shared + core typecheck 0 error；迁移 0015 在新库与 0014 旧库上升级通过（`runs-tasks.test.ts`）。
- W2：`tasks` / `tasks-write-domains` / `workdir-lease` / `workspace-lease` / `workdir-lease-windows` / `workdirs` / `external-agent-p3` 70 passed；既有排队文案断言按 §2.6 更新（`tasks.test.ts`、`workdirs.test.ts`、`external-agent-p3.test.ts`）；租约层「等写入租约」文案未动。
- W3：`gateway-read-only` / `tasks-write-domains` / `external-agent-tasks` / `task-subagent-read-only` / `external-agent-p3` 54 passed；新增 `task-brief-write-domains`；域外 write / edit / 生成产物各一例，域内放行，只读与 `writes:true` 不变。
- W4：`supervisor-turn` / `tasks-peer-coordination` / `task-timeline-visibility` / `tasks-peer-segment` 36 passed；发送、终态拒绝、ask_user 不当作回答、限流、等待三终态 / 超时 / 环 / 取消清理、泄露契约均覆盖。另加「任务内调用 `wait_for_task`」用例：工具调用在引擎里真实阻塞、目标结束后恢复（覆盖 `yieldSlotWhile` 的在途路径）。
- W5：`tasks-claims` / `gateway-read-only` / `tasks-write-domains` / `tasks` / `task-cards` 覆盖；域外 / 绝对路径 / 只读任务认领拒绝、幂等、release 全部、TaskView 投影、settle 清除。
- W6：`supervisor-turn`（含写域列）、`task-run-view` / `task-view` / `bot-tasks` / `tasks` / `chat-session` 渲染端用例、`i18n/locales` 两语言 key 校验通过；desktop typecheck（tsc + svelte-check）0 error。
- 偏差：DEV-091（沙箱命令按写域收紧的覆盖度；声明域简报始终注明「命令写入不受写域强制」）、DEV-092（claim 在现行调度下是第二道防线）。
- **审查修正（`6cc89e8d`）**：四条独立审查线（写域/租约、执行期强制、协调生命周期、提示词/界面/文档）共 30 余条发现，逐条核实后修正：
  - 数据边界：`peer_message` 正文与来源标题 `neutralizeUntrusted`、截断补齐闭合标签、写域 glob 注入前转义；`<peer_tasks>` 不再向内外部引擎承诺其拿不到的工具。
  - 协调：`send_to_task` 对未简报任务返回 `queued` 并在 `#brief` 折入（不再丢消息）；并发等待用 `waitDepth` 共享墙钟窗口（不再误判 stalled）；等自己写域排队任务直接 `INVALID_INPUT`；`claim` 合并 + 超过 16 条报错；发送配额后置；宿主 `dispose()` 清理等待定时器；渲染端只把**以** peer 标签开头的 steer 认作 peer 行，畸形包裹降级为纯文本。
  - 强制：沙箱双向收紧（域根在 workdir 时 workspace 只读，反之亦然）；workdir 域写入补外部硬链接检查；生成产物先过网关再 `mkdir`；宿主复制与工具输出落盘受域/认领约束；损坏的 `task_write_domains` 标 `taskWriteDomainsCorrupt` 并按拒绝处理；字面量域覆盖子树；大小写折叠只保留 Windows。
  - 租约与 claim：`conflictingHolder` 让强制收回 / revert 命中域键；`acquire_workdir_write` 对域任务不再 `PATH_OUT_OF_SCOPE`；键加 `dir:` 前缀、根路径重叠、保守包含校验（域外 claim 拒绝）。
  - 新增/更新定向测试：`workdir-domains`（26）、`workdir-lease`（13）、`policy`（19）、`gateway-read-only`（含域/认领/宿主复制）、`tool-output-spill`、`runs-tasks`（损坏列）、`tasks-write-domains`（简报折入 + cwd 限制）、`tasks-peer-coordination`（超时参数）、`tasks-claims`（合并）、`task-run-view`（元信息与解析降级）。
  - 全量复跑：`pnpm test` 8179 passed / 44 skipped（768 文件通过、3 跳过，0 failed）；typecheck / eslint 0 error。
- W7 收口修正：新工具补进副作用分类表（`send_to_task` local；`wait_for_task` / `claim` / `release` none）与信任分类（`send_to_task` / `claim` / `release` trusted；`wait_for_task` untrusted，结果摘要按任务输出看待）；网关与权限桥对测试替身做可选调用（`writeDomain` / `writeOutOfDomain` / `owningTask` / `writeDomainDenial`），生产装配不变；任务版平台规则新增三条后，`context-assembly` 的编号断言同步。

未做 / 遗留：

- e2e `tasks.spec.ts` 的「分域并行两写任务」用例未加（§4 W7 标注可选，视 e2e 基线稳定性）。
- 认领的端到端并发命中在现有调度下很难自然出现（相交写域本就排队），W5 拦截以网关单测 + TaskHost 集成覆盖，不作为独立 e2e。

格式参照 [todo/supervisor-and-tasks.md](supervisor-and-tasks.md) §5。

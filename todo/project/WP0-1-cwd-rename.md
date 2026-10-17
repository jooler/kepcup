# WP0-1 · D75「任务执行根目录」`workdir → cwd`（纯改名）

> 依赖：无。后续：WP0-2。分支：`feat/project/wp0-1-cwd`。
> **这是行为中性的纯改名：提交里不得夹带任何行为改动。** 目的是把 `workdir` 这个词腾出来，WP0-2 要把「共享目录」改叫 `workdir`。
> 先读 [README.md](README.md) §1、§4.1（T0-1 表）。

## 1. 背景

D75 里「任务（task）或外部智能体会话的执行根目录」叫 `workdir`：要么是绑定的共享目录（取值 `'project'`），要么是 Bot 私有的 workspace（取值 `'workspace'`）。它出现在 `runs.task_workdir`、`start_task` 工具的 `workdir` 参数、`<task_brief workdir="…">` 提示词属性、外部智能体 `session/new.cwd` 的来源等处。WP0-2 之后 `workdir` 将专指「共享目录」，两个含义必须先分开。

## 2. 范围

做：把上述 D75 含义的 `workdir`（及各种大小写 / 驼峰 / 下划线形式）改名为 `cwd`；新增一个 runs 库迁移改列名；同步测试与文档。
不做：任何行为改动；不改 `start_task.cwd` 的取值（仍是 `'workspace' | 'project'`，WP0-2 再改）；不改下面「不要改」里列的非 D75 含义。

## 3. 开工前核对（必须先做）

1. `git status` 干净；从当前集成点拉分支。
2. 确认最新迁移编号：`ls packages/core/migrations/runs | tail -3` 应看到 `0012_task_capabilities.sql`；本 WP 新增 `0013_task_cwd.sql`。若编号不同，按实况顺延并在「实施记录」登记。
3. 统计基线（用于验收对比）：

```bash
rg -c -i "workdir" packages apps scripts -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' | awk -F: '{n+=$2; f++} END{print n" hits in "f" files"}'
```

调研时（2026-10-17）：`packages/core/src` 103 处 / 12 文件、`packages/core/test` 81 处 / 29 文件、`packages/shared/src` 2 处、`apps/desktop/src` 2 处，合计约 190 处（文档另计）。

## 4. 改名规则

### 4.1 要改的形式（逐一搜索：`rg -n "<形式>" packages apps scripts -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'`）

| 旧 | 新 | 出现位置（调研时） |
|---|---|---|
| `task_workdir`（SQL 列名、SQL 字符串） | `task_cwd` | `core/src/domain/runs.ts`、`core/src/dispatch/orchestrator.ts`、测试（`task-events-migration.test.ts`、`tasks-agent-review-fixes.test.ts`） |
| `taskWorkdir`（TS 属性：`Run` 行映射、`RunsService.create` 入参、`runSchema`、`TaskView`） | `taskCwd` | `shared/src/domain/types.ts`、`core/src/domain/runs.ts`、`core/src/dispatch/tasks.ts`、`orchestrator.ts`，及 12 个测试文件 |
| `workdirKind`（`TaskView` 字段） | `cwdKind` | `shared/src/domain/types.ts`、`dispatch/tasks.ts`、`task-cards.test.ts`、`task-view.test.ts` |
| `resolveWorkdir`（`TaskHost` 依赖） | `resolveCwd` | `dispatch/tasks.ts`、`orchestrator.ts` |
| `describeWorkdir`、`#describeTaskWorkdir` | `describeCwd`、`#describeTaskCwd` | `dispatch/tasks.ts`、`orchestrator.ts` |
| `agentWorkdir` | `agentCwd` | `orchestrator.ts` |
| `StartTaskInput.workdir`、`start_task` 工具参数 `workdir` | `cwd` | `core/src/tools/task-tools.ts`、`dispatch/tasks.ts`（接口 `StartTaskInput`，约 l.35-38） |
| `<task_brief … workdir="…">` 属性（`buildTaskBriefSegment` 的参数与模板字符串） | `cwd="…"` | `dispatch/tasks.ts`（约 l.458-461）、`orchestrator.ts` |
| `RunSpec.workdir`（`agent/types.ts` 约 l.126） | `RunSpec.cwd` | `agent/types.ts`、`agent/external/engine.ts`（`spec.workdir` 多处）、`orchestrator.ts` |
| `LaunchedTask.workdir`（`dispatch/tasks.ts` 约 l.345） | `cwd` | `dispatch/tasks.ts` |
| `Roots.workdirs`（`permission-bridge.ts` 的接口字段与 `#roots` 的局部变量）：它是「会话 cwd + workspace」两个根 | `cwdRoots` | `agent/external/permission-bridge.ts` |
| `isolationFor(identity, workdir)`、`ctx.workdir` 等**参数名 / 属性名** | `cwd` | `permission-bridge.ts`、`agent/external/engine.ts`、`agent-provider.contract.ts`、各 external-agent 测试 |

判断规则：**标识符表示「一个任务 / 外部智能体会话的执行根目录」就改**。拿不准时看它的值从哪来：来自 `resolveWorkdir` / `task.taskWorkdir` / `spec.workdir` / `session/new.cwd` 的就是；来自 es-git / Lima / agent 探测目录的不是。

### 4.2 不要改（别的含义的 `workdir` / `workDir`）

| 位置 | 含义 |
|---|---|
| `core/src/project/service.ts`、`core/src/project/checkpoints.ts` 里的 `repo.workdir()` | es-git API（git 工作树路径） |
| `core/src/sandbox/backend-container.ts` 里 `limactl exec --workdir`；`container-backend.test.ts` 注释 | Lima / Podman CLI 参数 |
| `core/src/domain/agents.ts`、`core/src/start.ts`、`core/test/**/agents-lifecycle.test.ts` 里的 `workDir`（驼峰大写 D） | Agent 安装 / 探测缓存目录 |
| `packages/core/scripts/agent-spike/**` 的 `workDir` / `--work-dir` | spike 脚本 |
| `docs/dev/DEVIATIONS.md`、`docs/dev/PROGRESS.md` | 其中的 `workdir` 指 git 工作树，且是历史记录 |
| `todo/*.md`（除本目录）、`docs/design/41-project-team.md`、`todo/project/**` | 历史记录 / 本项目的改名说明 |

### 4.3 命名冲突的处理（重要）

把参数 `workdir` 改成 `cwd` 时，同一作用域里可能已经有一个叫 `cwd` 的局部变量。已知位置（`permission-bridge.ts`）：

- `isolationFor(...)` 里 `const cwd = canonicalPath(workdir);`（约 l.405）；
- 约 l.668 `const cwd = this.#norm(roots.workdirs[0] ?? canonicalPath(ctx.workdir));`；
- 约 l.692 `const cwd = this.#resolve(classified.commandCwd ?? ctx.workdir, ctx.workdir);`。

处理办法：把**旧的局部变量**改成更具体的名字（`sessionCwd` / `normalizedCwd` / `commandCwd`），参数 / 属性才叫 `cwd`。**协议层字段名保持 `cwd`**（ACP `session/new` 的 `cwd`、`{ cwd: card.cwd ?? ctx.cwd }` 里的 `cwd` 属性本来就是 cwd），不要因此出现 `cwd: cwd` 以外的怪名字。每处冲突在实施记录写一行。

## 5. 步骤

1. **迁移**：新增 `packages/core/migrations/runs/0013_task_cwd.sql`，内容恰好为：

```sql
-- D92 T0-1: D75 "workdir" (a task's execution root directory) is renamed "cwd".
ALTER TABLE runs RENAME COLUMN task_workdir TO task_cwd;
```

（SQLite 3.53.4 支持 `RENAME COLUMN`，仓库此前只用过 `RENAME TO`，这是第一次用，注意迁移测试要覆盖。）

2. **shared**：`runSchema.taskWorkdir → taskCwd`、`TaskView.workdirKind → cwdKind`（`packages/shared/src/domain/types.ts`，`rg -n "taskWorkdir|workdirKind" packages/shared`）。
3. **core 源码**：按 §4.1 逐项改，顺序建议 `domain/runs.ts`（SQL 列名与行映射）→ `dispatch/tasks.ts` → `tools/task-tools.ts` → `agent/types.ts` → `agent/external/*` → `dispatch/orchestrator.ts`。
4. **LLM 可见文本**：`start_task` 工具的参数 schema（TypeBox `cwd`）、参数描述、校验错误文案 `'workdir 只能是 workspace 或 project'` → `'cwd 只能是 workspace 或 project'`；`<task_brief … cwd="…">`。再跑 `rg -n "workdir" packages/core/src/agent packages/core/src/tools` 确认提示词 / 规则文本里没有遗漏（遗漏会让模型看到旧参数名）。
5. **renderer**：`apps/desktop/src/renderer` 里的 2 处（`rg -n -i workdir apps/desktop/src`），改为 `taskCwd` / `cwdKind`。
6. **测试**：改 §4.1 涉及的全部测试文件；脚本化 `start_task` 调用的测试（`rg -n "workdir" packages/core/test`）把参数名改为 `cwd`。
7. **新增迁移测试** `packages/core/test/unit/task-cwd-migration.test.ts`：参照 `task-events-migration.test.ts` 的写法（用 `test/support/migration-versions.ts` 的 `runsVersionsAfter`），建到 runs 版本 12 → 插入一行带 `task_workdir` 值的 run → 应用 0013 → 断言列名为 `task_cwd`、值保留、旧列名不存在。
8. **更新写死的版本号断言**：`packages/core/test/integration/create-core.test.ts` 里 runs 的 `toBe(12)` → `toBe(13)`（约 l.138）。其余测试用 `runsVersionsAfter`，会自动适配。
9. **文档**（只改 D75 含义的 `workdir`）：`docs/design/{02-execution,30-supervisor-and-tasks,28-external-agents-acp}.md`、`docs/dev/{02-architecture,03-data-model,04-agent-runtime,README}.md` 里的 `task_workdir`、`taskWorkdir`、`workdirKind`、`resolveWorkdir`、`start_task` 的 `workdir` 参数、`<task_brief … workdir>` 示例，以及叙述里指「任务执行根目录」的 `workdir`，改为 `cwd`。**注意**：这些文档里同时存在指「共享目录」的 `project` 字样，**本步不改**（WP0-2 处理）。

## 6. 测试与验证

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck
node scripts/run-tests.mjs run packages/core/test/unit/task-cwd-migration.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/create-core.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/task-events-migration.test.ts
# 任务 / 外部智能体相关（名称按 rg 结果核对）
node scripts/run-tests.mjs run packages/core/test/integration/tasks.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/permission-bridge.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/external-agent-engine.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/external-agent-p5.test.ts
```

收口：因为改了 shared 契约与迁移，**跑一次全量** `pnpm test`，失败集合不得超出基线。

## 7. 验收清单

- [ ] 残留自检：下列命令的输出**只能**是 §4.2 允许的位置，且不含 `task_workdir` / `taskWorkdir` / `workdirKind` / `resolveWorkdir`：

```bash
rg -n -i "workdir" packages apps scripts -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
rg -n "task_workdir" packages -g '!**/dist/**'     # 只允许出现在历史迁移 runs/0006_tasks.sql 与 0013 的注释 / 语句里
```

- [ ] `start_task` 工具参数名为 `cwd`；`<task_brief>` 属性为 `cwd`。
- [ ] 新迁移与测试存在并通过；`create-core.test.ts` runs 版本断言为 13。
- [ ] `typecheck` 三个包通过，定向测试通过，全量失败集合不超出基线。
- [ ] 没有任何行为改动（`git diff --stat` 里没有新增 / 删除逻辑，只有改名与迁移 + 测试）。
- [ ] 实施记录已填。

## 8. 陷阱

- **不要对 `workdir` 做盲目全局替换**：es-git 的 `repo.workdir()`、Lima 的 `--workdir`、`workDir` 会被误伤。
- 不要修改历史迁移文件 `runs/0006_tasks.sql`。
- 迁移文件名必须匹配 `^\d{4}_[a-z0-9_]+\.sql$` 且编号连续。
- 改 LLM 可见的工具参数名后，凡是用 mock LLM 脚本化调用 `start_task` 的测试（含 `packages/testkit`）都要同步，否则测试里模型调用的是旧参数。

## 9. 实施记录

### 分支与提交

- 分支：`feat/project/migration`（按用户指示直接在该集成分支实施，未另拉任务书头部的 `feat/project/wp0-1-cwd`；不 push）。
- 提交（3 个，均为纯改名 / 记录，无行为改动）：
  1. `refactor(core,shared): rename D75 task execution root workdir to cwd (D92 T0-1)`——迁移 `runs/0013_task_cwd.sql`、shared 契约、core 源码、renderer 测试、全部相关测试与新增迁移测试；
  2. `docs(design,dev): follow workdir to cwd rename in task docs (D92 T0-1)`——设计 02 / 30 / 28 与 dev 02 / 03 / 04；
  3. `docs(todo): record WP0-1 implementation and progress`——本记录与 README §7。

### 开工核对（§3）

- `git status` 干净；runs 最新迁移 `0012_task_capabilities.sql`，编号符合预期，新增 `0013_task_cwd.sql`（内容与任务书 §5.1 逐字一致）。
- 基线统计：`191 hits in 46 files`（任务书调研值约 190，吻合）。

### §4.3 命名冲突处理（permission-bridge.ts，逐处）

| 位置 | 处理 |
|---|---|
| `isolationFor(identity, workdir)` | 参数改 `cwd`；原局部 `const cwd = canonicalPath(workdir)` 改名 `normalizedCwd`（规范化后的会话根） |
| `#isAgentConfig` | 原局部 `cwd`（agent 配置文件判定的基准根）改名 `sessionCwd`，取 `roots.cwdRoots[0] ?? canonicalPath(ctx.cwd)` |
| `#decideExec` | 原局部 `cwd`（命令工作目录）改名 `commandCwd`；`#ask` 卡片与 reject/审计 extra 的**协议键名保持 `cwd`**，值为 `commandCwd`（`{ command, cwd: commandCwd }`） |
| `#pathVerdict` | 匹配到的工作根局部 `workdir` 改名 `cwdRoot` |
| 协议层 | ACP `session/new` 的 `cwd`、审批卡 payload 的 `cwd`、会话指纹里的 `cwd` 键本来就叫 `cwd`，未动 |

### 按「标识符表示任务执行根目录就改」判断规则处理、任务书未逐项列出的改名（登记）

- `TaskSummary.workdir` → `TaskSummary.cwd`（`core/src/tools/task-tools.ts`；`TaskHost.#summary` 填充）——与 `LaunchedTask.workdir → cwd` 同一规则。
- `#agentRunSetup` 入参 `workdir: string` → `cwd`（orchestrator 内部私有方法；会话指纹取值随之，键名 `cwd` 不变）。
- 测试内局部变量 / harness 字段 `workdir` → `cwd`：`test/contract/agent-provider.contract.ts`（harness 字段与 `runSpec` 参数）、`external-agent-p2/p5/p6`、`agent-providers-p5`、`agent-parallel-sessions`、`agent-review-p5-1`、`permission-bridge.test.ts` 的 `decide(..., workdir = project)` 默认参数、`supervisor-turn.test.ts` / `task-tools-capabilities.test.ts` 的 `TaskSummary` 夹具字段。
- 测试内 LLM 可见字符串：`tasks-agent-review-fixes.test.ts` 的任务说明 `'NULL-WORKDIR 改一下'` → `'NULL-CWD 改一下'`（及对应用例名 `null-cwd`），`start_task` mock 调用参数 `workdir:` → `cwd:`（`tasks-review-fixes`、`tasks-agent-review-fixes`）；testkit 无 `workdir` 引用，无需改。
- 与改名配套的测试断言调整（非放宽）：`tool-effects-migration.test.ts` 的 0008→最新升级对比按 0013 的列名映射快照键（`task_workdir` → `task_cwd`，值原样），断言意图（既有行保留）不变。

### 迁移与版本断言

- 新增 `packages/core/test/unit/task-cwd-migration.test.ts`：runs 建到版本 12 → 插入带 `task_workdir` 值的 run 行 → 应用全量迁移 → 断言 `applied` = `runsVersionsAfter(12)`、`task_cwd` 值保留（含 null 行）、`pragma table_info` 无 `task_workdir`、旧列名写入报 `no such column`。
- `create-core.test.ts` runs 版本断言 `toBe(12)` → `toBe(13)`；`task-events-migration.test.ts` 全量迁移后的列断言 `task_workdir: null` → `task_cwd: null`。

### 测试结果

- typecheck：`shared build+typecheck`、`core build+typecheck`、`desktop typecheck`（含 svelte-check）全部通过。
- 定向（全绿）：`task-cwd-migration`（1）、`task-events-migration`（3）、`create-core`（9）、`tasks`（10）、`permission-bridge`（29）、`external-agent-engine` + `external-agent-p5`（93）、`runs-tasks` / `task-tools-capabilities` / `supervisor-turn` / `llm-router` / `permission-bridge-taint`（58）、`external-agent-p2` / `external-agent-p6` / `agent-parallel-sessions` / `agent-providers-p5` / `agent-review-p5-1`（72）、`agent-providers`（contract，170）、`tasks-review-fixes{,-e,-f}` + `tasks-agent-review-fixes` + `workspace-lease` + `task-cards`（47）、`group-chat` + `external-agent-p3` + `external-agent-tasks` + `supervisor-review-fixes`（54）、shared `message-content`（8）、desktop `task-view`（17）、`tool-effects-migration`（2，修正后）。
- 全量（收口一次，`node scripts/run-tests.mjs run`）：**5303 通过 / 2 失败 / 23 跳过**。两例失败：`tool-effects-migration`（上述断言调整后复跑通过，已含在修正提交里）；`skills-authoring`「改进已有自建技能 → rollback」单跑复跑通过（基线记录的环境 / 负载偶发项，属 05-testing.md 基线集合）。失败集合不超出基线。

### 验收清单自检（§7 逐条）

- `rg -n -i "workdir" packages apps scripts -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'`：输出仅剩 §4.2 允许项——`agents.ts` / `start.ts` / `agents-lifecycle.test.ts` 的 `workDir`（Agent 探测缓存目录）、`backend-container.ts` / `container-backend.test.ts` 的 Lima `--workdir`、`project/service.ts` / `checkpoints.ts` 的 `repo.workdir()`（es-git）、`agent-spike` 脚本，以及新迁移测试 `task-cwd-migration.test.ts` 内按任务书 §5.7 要求写入 / 断言的旧列名字符串（该测试必须以旧列名建 0013 之前的行）。
- `rg -n "task_workdir" packages -g '!**/dist/**'`：仅 `runs/0006_tasks.sql`（历史迁移，未动）与 `0013_task_cwd.sql`（改名语句本身）+ 新迁移测试（见上）。
- `taskWorkdir` / `workdirKind` / `resolveWorkdir` / `describeWorkdir`：仓库内 0 处。
- `start_task` 参数名为 `cwd`（TypeBox schema、描述与校验文案 `'cwd 只能是 workspace 或 project'`）；`<task_brief … cwd="…">`（构造点唯一，`dispatch/tasks.ts`）。
- 新迁移与 `task-cwd-migration.test.ts` 存在并通过；`create-core.test.ts` runs 版本断言为 13。
- `git diff --stat` 核对：源码改动全部为标识符 / 注释 / SQL 列名改名，无逻辑增删；新增文件仅迁移、迁移测试与记录。

### 阶段审查补漏（2026-10-17，Phase A 审查提交）

- 审查发现 `docs/design/40-capability-mounting.md` §1 现状表里 `start_task` 参数仍写 `workdir`（D75 含义；该文件不在任务书 §5 步骤 9 的文档清单内，WP11 的核对正则也不覆盖裸 `workdir`）→ 已改为 `cwd`。其余逐项核对（§4.1 对照、「不改」清单、迁移 SQL、纯度、残留自检）全部通过。

### 偏差

- 无新增 DEVIATIONS（编号仍至 DEV-030）：改名未迫使任何行为改动。
- 分支名与任务书头部不同（`feat/project/migration` vs `feat/project/wp0-1-cwd`）：用户在派工时明确指示直接用前者，属编排决定，不记 DEVIATIONS。

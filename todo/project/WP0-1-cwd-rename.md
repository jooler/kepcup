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

（执行智能体在此填写：分支、提交列表、§4.3 冲突处理记录、测试结果、偏差编号。）

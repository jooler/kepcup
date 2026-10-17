# WP0-2 · 共享目录 `project → workdir`（纯改名）

> 依赖：WP0-1 已合入（`workdir` 一词已腾空）。后续：WP1。分支：`feat/project/wp0-2-workdir`。
> **行为中性的纯改名**：提交里不得夹带任何行为改动。目的是把 `project` 一词腾出来，WP1 起它专指「项目组」。
> 先读 [README.md](README.md) §1、§4.1（T0-2 表）、§4.14。

## 1. 背景

D28 的 `Project` 指「用户选择的本地目录，绑定到对话，对话中所有 Bot 可读写」。从现在起这个概念在代码里叫 **`workdir`**（界面一直是「工作目录」）。`project` 一词随后给新的「项目组」使用，所以改名必须**彻底**：本 WP 结束后，代码标识符里不得再有「目录含义」的 `project`。

规模（2026-10-17 `rg -w -i project` 调研）：1413 处 / 186 文件（含文档、todo）。代码侧约占一半。**不能靠肉眼逐处改**，按 §5 的流程分阶段做。

## 2. 范围

做：数据库（新迁移）、ID 前缀、shared 契约、core、renderer、测试与 e2e、`data-testid`、i18n key 与用户可见中文、设计 / 开发文档里「当前规格」类的术语。
不做：任何行为改动；不改 §4.2 列的「别的含义的 project」；不碰历史迁移 SQL；不碰历史记录类文档。

## 3. 开工前核对

1. `git status` 干净；确认 WP0-1 已合入：`rg -n -i "workdir" packages apps -g '*.ts' -g '*.svelte' -g '!**/dist/**'` 只剩 WP0-1 §4.2 的允许项（es-git `repo.workdir()`、Lima `--workdir`、`workDir`）。
2. 迁移编号：`ls packages/core/migrations/main | tail -2` 应是 `0037_workbench.sql`；本 WP 新增 `0038_workdirs_rename.sql`。
3. 记录基线计数：

```bash
rg -c -w -i "project|projects" packages apps scripts -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' -g '!*.md' | awk -F: '{n+=$2; f++} END{print n" hits in "f" files"}'
```

## 4. 命名规则

### 4.1 通则（大小写保持）

| 旧 | 新 |
|---|---|
| `project` | `workdir` |
| `projects` | `workdirs` |
| `Project` / `Projects` | `Workdir` / `Workdirs` |
| `PROJECT` / `PROJECTS` | `WORKDIR` / `WORKDIRS` |
| `project_id` / `projectId` / `projectPath` … 复合标识符 | 在标识符内部做同样的子串替换（`workdir_id` / `workdirId` / `workdirPath`） |

具体的已知映射见 README §4.1「T0-2」表，那张表是**权威**：与通则不一致处以表为准（例如 ID 前缀 `prj → wkd`，不是 `wdr`；`projectCheckpointsPath` 的磁盘路径从 `projects/{id}/checkpoints.git` 变为 `workdirs/{id}/checkpoints.git`）。

### 4.2 不要改（别的含义的 `project`）——**逐条记住，替换后要核对**

| 位置 | 含义 | 处理 |
|---|---|---|
| `vitest.config.ts` 的 `projects: [...]`；各 `package.json` 与 `scripts/run-tests.mjs` 里的 `--project` | Vitest workspace project | **整个文件排除** |
| `apps/desktop/resources/connectors/catalog.json` 里 `"category": "project"`；`packages/**/test/fixtures/connectors/*.tools.json`（Linear / Notion / Sentry 的 `projectId` 等第三方工具 schema） | SaaS 连接器分类与第三方工具 | **整个文件排除** |
| i18n key `apps.catalog.category.project` 及渲染层按 `category === 'project'` 取该 key 的代码 | 连接器分类「项目」 | **不改**；若全局替换误改，必须恢复 |
| `packages/core/src/agent/external/providers/opencode.ts` 与相关测试里的环境变量 `OPENCODE_DISABLE_PROJECT_CONFIG` | 第三方环境变量 | **不改** |
| `pnpm-lock.yaml` 里的 `@typescript-eslint/project-service` | 依赖包名 | **整个文件排除** |
| 任何历史迁移 SQL（`packages/core/migrations/**/00NN_*.sql`） | 历史 | **不改**（`0038` 是新增的） |
| `docs/dev/phases/**`、`docs/dev/PROGRESS.md`、`docs/dev/DEVIATIONS.md`、`docs/releases/**`、`todo/*.md`（除 `todo/project/**`） | 历史记录 | **不改**（只在重命名文件时修链接，见 §5 步骤 9） |
| `docs/design/41-project-team.md`、`todo/project/**` | 描述新概念「项目组」 | **不改** |
| 描述一般意义上「软件项目」的英文（如「Node project」「TypeScript project references」） | 泛指 | 不改；但**发给 LLM 的提示词里**不要留 `project` 一词的歧义，按语义改成 `workdir` 或别的措辞 |

## 5. 步骤（按顺序；每步结束 `git add -A` 保存，可做 WIP 提交，收口时 squash）

### 步骤 1：建立标识符清单

```bash
rg -o -h "[A-Za-z0-9_]*[Pp][Rr][Oo][Jj][Ee][Cc][Tt][A-Za-z0-9_]*" packages apps scripts \
  -g '*.ts' -g '*.svelte' -g '*.mjs' -g '*.cjs' -g '*.json' -g '*.sql' \
  -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' \
  -g '!vitest.config.ts' -g '!**/connectors/**' -g '!pnpm-lock.yaml' -g '!**/package.json' \
  | sort | uniq -c | sort -rn > /tmp/project-tokens.txt
```

通读清单：每行一个标识符。划掉 §4.2 里的（`OPENCODE_DISABLE_PROJECT_CONFIG`、`apps.catalog.category.project` 等），剩下的就是要改的。**把批准的清单整理到 `/tmp/tokens-approved.txt`（每行一个标识符）**。调研时已知的主要标识符（节选，非穷尽）：`Project`、`projectSchema`、`projectProtectRulesSchema`、`projectStatusSchema`、`ProjectsService`、`ProjectRuntime`、`boundProject`、`setProject`、`unleasedProject`、`projectPath`、`projectId`、`projectCheckpointsPath`、`buildProjectSection`、`PROJECT_SECTION_BUDGET`、`PROJECT_CONTEXT_TOKEN_BUDGET`、`PROJECT_CONTEXT_MAX_ENTRIES`、`PROJECT_DEFAULT_PROTECT_RULES`、`PROJECTS_RECENT_LIMIT`、`PROJECT_MISSING`、`PROJECT_SWITCH_BLOCKED`、`acquire_project_write`、`projectsListOutputSchema` 等 `projects*Schema`、`ProjectSelector`、`ProjectSettingsDialog`、`conversationsBound`（不含 project，不改）。

### 步骤 2：数据库、ID 前缀、磁盘路径

1. 新增 `packages/core/migrations/main/0038_workdirs_rename.sql`，内容恰好为：

```sql
-- D92 T0-2: the D28 "Project" (a user-chosen directory bound to a conversation) is renamed "workdir".
ALTER TABLE projects RENAME TO workdirs;
ALTER TABLE conversations RENAME COLUMN project_id TO workdir_id;
ALTER TABLE run_changes RENAME COLUMN project_id TO workdir_id;
```

   - `run_changes.project_id REFERENCES projects(id)`：`RENAME TO` 会自动改写 FK（SQLite ≥ 3.26，且库开着 `foreign_keys=ON`）。
   - 迁移后用 `PRAGMA foreign_key_list(run_changes)` 在测试里断言它指向 `workdirs`。
2. `packages/shared/src/ids.ts`：键 `prj: 'prj_'` → `wkd: 'wkd_'`；`packages/core/src/domain/projects.ts`（将改名为 `workdirs.ts`）里的 `newId('prj')` → `newId('wkd')`。调研确认 `isId('prj', …)` 没有任何调用，旧库里已有的 `prj_…` id 继续有效（只是新建的用 `wkd_`）。
3. `packages/core/src/infra/paths.ts`：`projectCheckpointsPath` → `workdirCheckpointsPath`，路径 `projects/{id}/checkpoints.git` → `workdirs/{id}/checkpoints.git`。**旧开发库里已有的检查点目录会成为孤儿，不做迁移**（实施记录里写一句即可）。同文件搜 `'projects'` 确认没有别的路径助手用到这个目录名：`rg -n "'projects'" packages/core/src`。

### 步骤 3：文件与目录改名（`git mv`，先改名后改内容，保留历史）

```bash
git mv packages/core/src/project packages/core/src/workdir
git mv packages/core/src/domain/projects.ts packages/core/src/domain/workdirs.ts
git mv apps/desktop/src/renderer/src/lib/features/projects apps/desktop/src/renderer/src/lib/features/workdirs
git mv apps/desktop/src/renderer/src/lib/stores/projects.svelte.ts apps/desktop/src/renderer/src/lib/stores/workdirs.svelte.ts
git mv apps/desktop/src/renderer/src/lib/features/workdirs/ProjectSelector.svelte apps/desktop/src/renderer/src/lib/features/workdirs/WorkdirSelector.svelte
git mv apps/desktop/src/renderer/src/lib/features/workdirs/ProjectSettingsDialog.svelte apps/desktop/src/renderer/src/lib/features/workdirs/WorkdirSettingsDialog.svelte
# 测试
git mv packages/core/test/integration/projects.test.ts packages/core/test/integration/workdirs.test.ts
git mv packages/core/test/integration/project-lease-windows.test.ts packages/core/test/integration/workdir-lease-windows.test.ts
git mv packages/core/test/unit/project-lease.test.ts packages/core/test/unit/workdir-lease.test.ts
git mv packages/core/test/unit/project-rules.test.ts packages/core/test/unit/workdir-rules.test.ts
git mv apps/desktop/test/e2e/projects.spec.ts apps/desktop/test/e2e/workdirs.spec.ts
# 文档
git mv docs/design/08-project.md docs/design/08-workdir.md
```

> `features/workdirs/` 里 `RunChangesCard.svelte`、`DiffDialog.svelte`、`run-changes.ts`（及 `run-changes.test.ts`）名字**不改**，只随目录移动。
> 之后 `rg -n "08-project" -g '*.md' .` 找出所有链接并改为 `08-workdir`（包括历史文档里的**链接**，只改链接目标，不改正文）；`docs/dev/phases/P04-project.md` **不改名**（历史文档）。

### 步骤 4：标识符替换（代码）

对 `/tmp/tokens-approved.txt` 的每个标识符，按「通则」子串替换生成新名，整词替换：

```bash
# macOS 用 perl（GNU / BSD 通用），不要用 sed -i 的平台差异写法
while read -r tok; do
  [ -z "$tok" ] && continue
  new=$(printf '%s' "$tok" | sed -e 's/projects/workdirs/g; s/Projects/Workdirs/g; s/PROJECTS/WORKDIRS/g; s/project/workdir/g; s/Project/Workdir/g; s/PROJECT/WORKDIR/g')
  files=$(rg -l -F -w -- "$tok" packages apps scripts \
    -g '*.ts' -g '*.svelte' -g '*.mjs' -g '*.cjs' \
    -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' \
    -g '!vitest.config.ts' -g '!**/connectors/**')
  [ -n "$files" ] && printf '%s\n' "$files" | xargs perl -pi -e "s/\b\Q$tok\E\b/$new/g"
done < /tmp/tokens-approved.txt
```

注意：
- **先处理长的复合标识符，再处理独立的 `project` / `projects`**（对清单按长度倒序：`awk '{print length, $0}' | sort -rn | cut -d' ' -f2-`），否则短词会先被改、复合词匹配不到。整词边界 `\b` 保证不会误伤 `projection`。
- 独立词 `project` / `projects` 会同时替换**注释、字符串、中文句子里的英文单词**，这正是想要的；但会误伤 §4.2 的 `catalog.category.project` 等字符串字面量——**替换完后必须执行 §6 的核对命令**。
- 若新名在同一作用域已被占用（例如已有变量叫 `workdirs`），手动改名并在实施记录登记。

### 步骤 5：字符串字面量 `'project'`（逐处判断，**不要批量替换**）

```bash
rg -n "'project'|\"project\"|\`project\`" packages apps scripts -g '*.ts' -g '*.svelte' -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' -g '!vitest.config.ts' -g '!**/connectors/**'
```

调研时已知的目录含义的字面量（都要改成 `'workdir'`）：

| 位置 | 说明 |
|---|---|
| `start_task` 的 `cwd` 取值 `'workspace' \| 'project'`（`tools/task-tools.ts`、`dispatch/tasks.ts` 的 `StartTaskInput`、`orchestrator.ts` 里 `resolveCwd` 的 `requested === 'project'`） | 改 `'workdir'`；校验文案 `cwd 只能是 workspace 或 workdir` |
| `TaskView.cwdKind` 与 `#describeTaskCwd` 的 `kind: 'project' \| 'workspace'`（`shared/types.ts`、`orchestrator.ts`、渲染层任务卡 / `task-view.test.ts` / `task-cards.test.ts`） | 改 `'workdir'` |
| 设置目录条目 `scope: 'project'`（`workdir.protect-rules` / `workdir.ports`）、`surface: 'project-dialog'`、`DIALOG_SURFACE_SECTIONS` 的 `'project-settings'` | 改 `'workdir'` / `'workdir-dialog'` / `'workdir-settings'`（`settings-catalog/{items,types,coverage}.ts`、`settings/host.ts`） |
| 内联设置的 `kind: z.literal('project')`（选目录那种，`shared/types.ts` 约 l.2796）及其渲染 / 触发处 | 改 `'workdir'` |
| `groups.setup.answer` 的 `step: z.literal('project')`（`rpc/methods.ts` 约 l.904）与 `GROUP_SETUP_STEPS` | 改 `'workdir'`（WP1 会整体删除这套 D60 后端，这里只为保持一致） |

**不改**：`apps.catalog.category.project` 相关的 `'project'`（连接器分类）、别的非目录含义。每处判断依据写进实施记录的一行表里。

### 步骤 6：用户可见中文与提示词

1. **目录在用户界面与对话里统一叫「工作目录」**（不叫「项目」，也不夹英文 `project`）：
   - `project/service.ts`（现 `workdir/service.ts`）里 `#systemMessage` 的三条：`项目已确认为 ${label}`、`项目已绑定为 ${label}`、`项目已从 … 切换为 ${label}` → `工作目录已确认为 …` / `工作目录已绑定为 …` / `工作目录已从 … 切换为 …`；同文件里其余发给用户的中文提示（授权说明「该对话中的所有 Bot 都可以读写此目录」等）按「目录」措辞核对。
   - `zh-CN.ts`：原 `projects.*`（20 个）的**值**里出现的「项目」「project」按目录含义改为「工作目录」（key 已在步骤 4 前缀改为 `workdirs.*`）；`projects.removeBody` 里的「project 目录」→「工作目录」；`chats.errorCode.PROJECT_*` 的文案（key 已改 `WORKDIR_*`）；`settingCard.project.*` → `settingCard.workdir.*`。
   - 搜：`rg -n "项目" apps/desktop/src packages/core/src packages/shared/src`，逐处判断是否指目录；指目录的改「工作目录」。**不要动**「项目组」（尚不存在，别提前写）和「项目」泛指软件项目的措辞（如技能文档里）。
2. **发给 LLM 的文本**：`<project>` → `<workdir>`（`workdir/context.ts` 的 `buildWorkdirSection`、`WorkdirRuntime.promptSection`、`agent/context/system-prompt.ts`、`orchestrator.ts`）；系统提示规则里「工作目录是 project（见 `<project>`）」→「工作目录是 workdir（见 `<workdir>`）」；工具 `acquire_project_write` 的名称与描述 → `acquire_workdir_write`；`settings/adapters.ts` 的脱敏占位 `<project>/…` → `<workdir>/…`；各外部智能体 Provider 注释里的 `<project>`。
   - `rg -n "project" packages/core/src/agent packages/core/src/tools packages/core/src/settings` 复核无遗漏。

### 步骤 7：renderer 与 `data-testid`、i18n key

- 组件 / store / import 路径随步骤 3、4 已改；`rg -n "lib/features/projects|stores/projects|ProjectSelector|ProjectSettings" apps/desktop` 应为空。
- **`data-testid`**：README §4.1 列了 21 个 `project-*`，一律改前缀为 `workdir-`（`rg -n 'data-testid="project' apps/desktop/src apps/desktop/test` 应为空）。3 个 e2e spec 使用它们：`workdirs.spec.ts`（原 `projects.spec.ts`）、`tasks.spec.ts`、`browser.spec.ts`（共 19 处引用）。
- **i18n key**：`projects.*` → `workdirs.*`（20 个），`chats.errorCode.PROJECT_*` → `chats.errorCode.WORKDIR_*`，`settingCard.project.*` → `settingCard.workdir.*`（共 25 个中的 24 个；`apps.catalog.category.project` **不改**）。因为 `MessageKey = keyof typeof zhCN`，改漏了 `svelte-check` 会直接报错。

### 步骤 8：RPC、事件、错误码（shared）

`projects.*`（9 个）→ `workdirs.*`；zod schema 导出名同步；事件 `project.updated` / `project.removed` → `workdir.updated` / `workdir.removed`；错误码 `PROJECT_MISSING` / `PROJECT_SWITCH_BLOCKED` → `WORKDIR_*`；`Conversation.projectId` → `workdirId`。这些大多已被步骤 4 的标识符替换覆盖，但 RPC 方法名与事件名是**字符串字面量**（`'projects.select'`、`'project.updated'`），要单独检查：

```bash
rg -n "'projects\.|\"projects\.|'project\.|\"project\." packages apps -g '*.ts' -g '*.svelte' -g '!node_modules' -g '!**/dist/**'
```

### 步骤 9：文档（只改「当前规格」类，不改历史）

1. 步骤 3 已把 `08-project.md` 改名为 `08-workdir.md`；修全仓链接：`rg -n "08-project" -g '*.md' .`。
2. 在这些**当前规格**文档里，目录含义的 `project` / `Project` / 「project 选择器」等改为 `workdir` / 「工作目录」：`docs/design/{02-execution,08-workdir,10-sandbox,12-ui-layout,13-permissions,19-work-path-and-group-setup,28-external-agents-acp,30-supervisor-and-tasks,README}.md`、`docs/dev/{01-conventions,02-architecture,03-data-model,04-agent-runtime}.md`。用 `rg -n -w -i project <file>` 逐文件判断。
3. `docs/dev/01-conventions.md` ID 表：`Project | prj_` → `工作目录 | wkd_`；仓库结构里 `project/` → `workdir/`。
4. 其余文档（`docs/dev/phases/**`、PROGRESS、DEVIATIONS、releases、历史 todo）**不改正文**。

## 6. 测试与验证

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck && pnpm lint
```

**新增测试**（`packages/core/test/unit/workdirs-rename-migration.test.ts`，参照 `workbench-migration.test.ts` 的写法）：建到 main 版本 37 → 插入一条 `projects` 行、一条引用它的 `run_changes` 行、一条 `conversations.project_id` 非空的行 → 应用 0038 → 断言：表名为 `workdirs` 且行保留；`conversations.workdir_id` / `run_changes.workdir_id` 值保留；`PRAGMA foreign_key_list(run_changes)` 的 `table` 为 `workdirs`；`PRAGMA foreign_key_check` 为空。

**更新写死的版本号断言**：`packages/core/test/integration/create-core.test.ts` main 版本 `toBe(37)` → `toBe(38)`（约 l.120）；`packages/core/test/unit/workbench-migration.test.ts` 约 l.178 的 `toEqual([37])` → `toEqual([37, 38])`（该测试从 36 升级，会多一步）。

定向测试（名称按 `rg` 结果核对）：

```bash
node scripts/run-tests.mjs run packages/core/test/unit/workdirs-rename-migration.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/workdirs.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/workdir-lease-windows.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/workdir-lease.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/workdir-rules.test.ts
node scripts/run-tests.mjs run packages/shared
node scripts/run-tests.mjs run --project desktop
pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/workdirs.spec.ts
pnpm --filter @kepcup/desktop test:e2e test/e2e/tasks.spec.ts
pnpm --filter @kepcup/desktop test:e2e test/e2e/browser.spec.ts
```

收口：**跑一次全量** `pnpm test`，失败集合不得超出基线。

### 残留自检（必须全部通过）

```bash
# 1. 代码里不得再有目录含义的 project：输出只能是 §4.2 的允许项
rg -n -w -i "project|projects" packages apps scripts \
  -g '*.ts' -g '*.svelte' -g '*.mjs' -g '*.cjs' -g '*.json' \
  -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' -g '!pnpm-lock.yaml'
# 2. 复合标识符
rg -n "[A-Za-z_]*[Pp]roject[A-Za-z_]*" packages apps scripts -g '*.ts' -g '*.svelte' -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
# 3. 误伤核对：连接器分类必须仍是 project
rg -n "category" apps/desktop/resources/connectors/catalog.json | rg -c "project"      # 应 >0
rg -n "apps.catalog.category.project" apps/desktop/src                                  # 应 >0
rg -n "OPENCODE_DISABLE_PROJECT_CONFIG" packages                                         # 应 >0
rg -n "projects:" vitest.config.ts                                                       # 应 >0
# 4. 文档链接：指向 08-project 的链接目标必须已全部修好
rg -n "\]\([^)]*08-project" -g '*.md' .                                               # 应为空
# 5. 代码注释里对历史文档 P04-project.md 的引用不得被误改（该文档不改名）
rg -n "P04-workdir" .                                                                    # 应为空；若有，改回 P04-project
```

## 7. 验收清单

- [ ] 迁移 `0038` 与迁移测试存在并通过；`create-core` / `workbench-migration` 的版本断言已更新。
- [ ] `ids.ts` 键为 `wkd`；`workdirCheckpointsPath` 路径为 `workdirs/{id}/checkpoints.git`。
- [ ] 残留自检 1–4 全部满足；`start_task.cwd` 取值为 `'workspace' | 'workdir'`。
- [ ] 用户可见的目录字样全部是「工作目录」；系统消息为「工作目录已绑定为 …」等。
- [ ] 21 个 `data-testid` 与 24 个 i18n key 已改名；3 个 e2e spec 通过。
- [ ] `08-workdir.md` 与全仓链接正确；当前规格类文档已更新术语；历史文档未改正文。
- [ ] `typecheck` / `lint` 通过，全量失败集合不超出基线，**无行为改动**。
- [ ] 实施记录已填（含步骤 5 的判断表、冲突处理）。

## 8. 陷阱

- **替换顺序**：先复合词后独立词；独立词替换后必须跑残留自检 3（连接器分类、Vitest、OpenCode 环境变量最容易被误伤）。
- **字符串字面量**里的 RPC 名、事件名、`kind` / `scope` / `surface` 取值不会被标识符替换覆盖，必须按步骤 5、8 单独查。
- **不要改历史迁移 SQL**；`0038` 之外不要新增迁移。
- 渲染层 i18n 的 `MessageKey` 是类型检查的，改 key 一定要连同所有 `t('…')` 调用一起改。
- `workdir` 在 `project/service.ts`、`project/checkpoints.ts` 里已有 `repo.workdir()`（es-git API）：改名后同一文件里会出现两种 `workdir`，**不要合并或改动 es-git 的调用**。
- 磁盘上旧的 `projects/{id}/checkpoints.git` 不迁移，这是预期的（早期阶段、无兼容负担）。
- **独立词替换会改到代码注释里的文档引用**：`docs/design/08-project.md` → `08-workdir.md` 是对的（我们改名了它），但 `docs/dev/phases/P04-project.md`（历史文档，**不改名**）会被误改成 `P04-workdir.md`。替换后必须跑残留自检 5 并改回。

## 9. 实施记录

（执行智能体在此填写：分支、提交列表、步骤 5 的判断表、命名冲突、测试结果、偏差编号。）

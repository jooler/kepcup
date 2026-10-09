# P04 Project

## 目标

用户可以为对话选择本地目录作为 project；对话中所有 Bot 在其中拥有完整的代码编辑能力。写入受租约保护，每次执行的改动可查看、可整次回退；git 远程操作在沙箱外经确认代为执行；绑定 project 的对话可以使用本机端口测试开发服务器。

## 依赖

P03。

## 设计依据

- [design/08-project.md](../../design/08-project.md)（全文）
- [design/10-sandbox.md](../../design/10-sandbox.md#网络)（本机端口）、[design/10-sandbox.md](../../design/10-sandbox.md#git)（git）
- [design/12-ui-layout.md](../../design/12-ui-layout.md)（project 选择器、改动摘要卡片）
- [03-data-model.md](../03-data-model.md)（projects、run_changes）

## 范围

包含：

- projects 表；选择器（输入框下方）：当前 project 名称、最近使用列表、选择新目录（系统对话框，经主进程）、取消绑定、从最近列表移除。
- 绑定 / 切换 / 取消：系统消息；有 Bot 正在执行时禁用。
- 首次绑定时的授权范围说明（系统消息）。
- 目录状态检测：启动时与使用前检查，缺失时标记 `missing` 并提示。
- 可访问范围：project 读写（写入需租约），未持有租约时沙箱内 project 只读。
- 写入租约：自动申请（write / edit）、`acquire_project_write`、等待状态、强制收回、跨对话、释放时机。
- 过期检测：文件工具读取时记录哈希，写入前比对。
- 保护规则：默认 `denyRead`：`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`id_rsa*`；可在 project 设置中修改；`.git/config`、`.git/hooks/**` 沙箱内不可写（srt 内置）。
- 检查点：影子仓库、快照时机、改动摘要卡片、diff 查看、整次回退、冲突检查、保留策略。
- project 上下文注入（`<project>` 段）：路径、顶层结构（两层、最多 200 项）、git 状态、`AGENTS.md` / `CLAUDE.md`（按预算截断）；平台规则 7。
- 文件工具与 bash 的默认工作目录为 project。
- `git_remote` 工具与审批卡片。
- 本机端口：绑定 project 时沙箱允许监听与访问本机端口；project 可设置允许的端口范围。
- 从最近列表移除 project 的级联。

不包含：

- Windows 上 project 在 WSL2 中的挂载（P12）；本阶段 Windows 上 project 通过文件工具与逐条确认模式使用。
- 浏览器访问本机端口（P11）。

## 任务

1. **Project 领域**（`project/projects.ts`）
   - 选择目录后 `realpath`；同一路径复用已有记录；更新 `last_used_at`。
   - 绑定：更新 `conversations.project_id`，插入系统消息；有执行在进行时返回 `PROJECT_SWITCH_BLOCKED`。
2. **写入租约**（`project/lease.ts`，内存实现）
   - 租约键：project 根路径，或授权目录路径；两个键相同或互为祖先时视为冲突。
   - `acquire(identity, path)`：无冲突则持有；有冲突则排队（先进先出），执行状态改为 `waiting_lease`，推送 `lease.waiting`（含持有者 Bot 与对话）；取得后恢复 `running`。
   - 同一执行重复申请同一租约直接返回；每个执行同一时刻最多持有一个租约，申请第二个不同的租约时先释放前一个（先完成检查点快照）。
   - 释放：执行结束、取消、失败、中断；用户强制收回（持有者的下一次写入会重新申请）。
3. **沙箱策略**：未持有租约时 project 加入 `readOnly`，持有时加入 `readWrite`；保护规则中的 `denyRead` 路径加入 `denyRead`。
4. **过期检测**（`tools/fs-state.ts`）：每个执行维护“已读文件 → 内容哈希”表；write / edit 前比对磁盘当前哈希，不一致返回 `STALE_FILE`（提示重新读取）；新建文件（读取时不存在）不检查。
5. **检查点**（`project/checkpoints.ts`）
   - 影子仓库：`~/.kepcup/projects/{projectId}/checkpoints.git`，工作区指向 project 目录（git dir 与 work tree 分离），**不触碰 project 自身的 `.git`**；排除规则 = project 的 `.gitignore` + 固定排除 `.git/`。
   - 取得租约时提交一次快照（`before`），释放时再提交一次（`after`）；两者之差写入 `run_changes`。
   - 改动摘要卡片：执行结束后若有改动，在 Bot 的最后一条消息之后插入卡片：文件列表（新增 / 修改 / 删除）、“查看 diff”（@pierre/diffs）、“整次回退”。
   - 回退：把 `before` 快照中这些文件的内容恢复到工作区（新增的文件删除）；回退前检查这些文件当前内容是否等于 `after` 快照，不等则列出冲突文件并要求确认；回退本身也记录为一次改动。
   - 保留：超过 `CHECKPOINT_RETENTION_DAYS` 的快照由后台任务清理（重写影子仓库历史或定期新建仓库，**需验证**成本更低的方式）。
6. **project 上下文**（`project/context.ts`）：顶层结构用文件工具列出（遵守 `.gitignore`）；git 状态通过 es-git 读取（不依赖 git 命令行）；`AGENTS.md` 优先，其次 `CLAUDE.md`。
7. **`git_remote` 工具**：审批卡片显示操作、参数、目标远程、原因；批准后核心服务在沙箱外调用**系统 git 命令行**执行（使用用户已有的凭据配置），系统未安装 git 时返回 `GIT_CLI_MISSING`（P06 起可申请安装）；输出截断返回。
8. **本机端口**：绑定 project 的对话中，沙箱网络策略 `allowLocalhost = true`，并应用 `allowed_ports`；允许进程监听端口（srt 相关配置，**需验证**）。
9. **界面**：project 选择器（design/12-ui-layout.md 焦点一中的要求）；project 设置对话框（名称、保护规则、端口范围、移除）；租约等待的状态文案与强制收回按钮；改动摘要卡片与 diff 视图。
10. **生命周期**：删除对话删除其 `run_changes`；从最近列表移除 project 的级联。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| es-git 能否使用分离的 git dir 与 work tree，并遵守 work tree 中的 `.gitignore` | 在含 `node_modules` 的仓库上快照，确认未被纳入；project 的 `.git` 目录哈希不变 |
| 大仓库首次快照耗时 | 在 5 万文件级别的仓库上测量；超过 10 秒时记录到 DEVIATIONS.md 并提出方案（例如只快照已跟踪文件 + 本次改动文件） |
| srt 允许监听本机端口、访问本机端口的配置 | 沙箱内 `python3 -m http.server 8765 &` 后 `curl localhost:8765` 成功；未绑定 project 的对话中失败 |
| 检查点历史清理方式 | 比较两种方式的耗时与复杂度 |

## 测试要求

- 单元：租约冲突判定（相同、祖先、兄弟）；过期检测；保护规则匹配。
- 集成：
  - 两个 Bot（两个对话，同一 project）同时写入 → 串行，第二个进入 `waiting_lease`，第一个结束后继续；无交错写入。
  - 未持有租约时 bash 写 project 失败；`acquire_project_write` 后成功。
  - 读取后外部修改文件 → edit 返回 `STALE_FILE`。
  - `.env` 默认不可读；修改保护规则后可读。
  - 执行中 bash 修改的文件出现在改动摘要中；回退后文件恢复；回退冲突提示。
  - project 自身 `.git` 在整个过程中未被改动（Bot 自己执行 git commit 的情况除外）。
  - `git_remote` 审批通过后执行、拒绝后不执行。
  - 本机端口在绑定 project 的对话中可用，未绑定的对话中不可用。
  - 移动 project 目录 → 标记 `missing`，界面提示。
- 端到端：选择目录、切换、执行中禁用切换；改动摘要卡片、查看 diff、回退；租约等待显示。

## 验收标准

- [x] 在输入框下方选择目录后，对话中的 Bot 能在其中读写代码，默认工作目录是 project。
- [x] 有 Bot 执行时无法切换 project，界面说明原因。
- [x] 同一 project 的写入在多个执行之间串行；等待方的状态行显示“等待 X 完成对项目的修改”；可以强制收回。
- [x] 用户在外部编辑器中修改过的文件，Bot 不会覆盖（收到过期错误后重新读取）。
- [x] 每次有改动的执行结束后出现改动摘要卡片，diff 正确（包括命令造成的改动），整次回退有效，冲突时提示。
- [x] project 自身的 `.git` 不被检查点机制修改。
- [x] `.env` 等文件默认不可读。
- [x] git 远程操作每次都需确认，使用用户本机的 git 凭据完成。
- [x] 绑定 project 的对话中，Bot 可以启动开发服务器并用命令访问它。
- [x] 系统提示词中包含 project 信息与 `AGENTS.md` 内容（预算内）。
- [x] 本阶段测试全部通过（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)）。

> 勾选依据见 [PROGRESS.md](../PROGRESS.md) 的 P04 验收记录（2026-09-30，全部为本机自动化证据）。

## 注意事项

- 检查点快照在取得租约的那一刻进行，必须在第一次写入之前完成。
- 回退操作本身需要取得租约。
- 不要在 project 目录中创建任何应用自己的文件（包括临时文件、锁文件）。

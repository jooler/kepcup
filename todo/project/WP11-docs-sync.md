# WP11 · 文档同步（收尾）

> 依赖：WP8（T1a 收口）与 WP10（T1b 收口）都已合入。分支：`feat/project/wp11-docs`。
> 目标：让 `docs/` 与代码一致，**删除各文档顶部的「D92 修订」提示并把正文改写成现状**；记录进度与偏差。**只改文档**，不改代码。
> 先读 [README.md](README.md) 末尾的进度表与各 WP 的「实施记录」（那里有实施中偏离设计的地方——**文档以代码与实施记录为准**，不是以本文件为准）。

## 1. 通则

- 文档用中文；术语与代码一致（`项目组 / 项目负责人 / 项目成员 / 沟通 / 工作目录 / 协作回合`；代码标识符用英文原名）。
- 每个设计文档里，凡「D92 修订」提示列出的内容，都要把**正文**改成新状态，然后**删掉提示**。不要留「已改名自…」「原为…」的历史说明，除非该文档本来就有「历史 / 变更」小节（沿用其风格）。
- 不修改与本项目无关的段落；不做格式整理。
- 历史记录类文档（`docs/dev/phases/**`、`docs/dev/PROGRESS.md` 既有内容、`docs/dev/DEVIATIONS.md` 既有条目、`docs/releases/**`、`todo/*.md` 除 `todo/project/**`）**不改正文**。

## 2. 开工前核对

```bash
rg -n "D92 修订" docs                                   # 应列出 18 个文件（顶部提示）；做完后应为 0
rg -n "group_no_claim|GroupTurnCoordinator|propose_team|propose_group|chain_id|BOT_CHAIN|task_workdir|taskWorkdir|assignee_group_id|GroupInfo|GroupSettingsDialog" docs -g '!docs/dev/phases/**' -g '!docs/dev/PROGRESS.md' -g '!docs/dev/DEVIATIONS.md' -g '!docs/releases/**'
git log --oneline -40                                   # 看实施期提交，核对各 WP 的实际落地
```

## 3. 逐文档改写清单

### 设计文档（`docs/design/`）

| 文档 | 要改成什么 |
|---|---|
| `01-conversation.md` | 「群聊」一节整节改写为「项目组」：创建（双轮选择：先负责人后成员，成员 ≥ 1，管家不进候选）、成员变动（移出负责人被拒「请先更换」；删除负责人 Bot 被阻止；新成员加入时若绑定了工作目录会落系统消息「获得读写权限」）、负责人更换（系统消息「负责人已更换为 X」）；`conversations.type` 取值、`goal`、无 `setup_state`；「新增 Bot / 移除 Bot」等规则沿用；单聊一节不变；「消息模型」里群聊发送者标识改项目组；`group_no_claim` 相关描述删除 |
| `02-execution.md` | 「群聊响应」整节重写为「项目组沟通的响应」：决策顺序（工作台派发 → 显式 `@` / 回复 → 续接判断 → 负责人网关 → 静默路由 → 兜底不变式）、触发原因表；「Bot 之间的触发」改为「协作回合与熔断」（回合继承规则、阈值、暂停卡）；触发原因清单（删 `broadcast` / `chain`，加 `continuation` / `routing_gate` / `routed` / `routed_also` / `lead_fallback` / `bot_mention`）；术语 `workdir` → `cwd`；D5 说明 |
| `05-wiki-and-skills.md` | 「读写规则」里 D9 的表述改为：Bot 个人 wiki 完全隔离，**项目 wiki** 是唯一被许可的项目内共享通道；新增「项目 wiki」小节（所有者、来源台账与创建者、单写入队列、执行者付费、成员只删自己的来源、可信度包裹、`scope` 参数、索引位置）；移交（D88）不含项目 wiki |
| `08-workdir.md`（WP0-2 已改名） | 术语已在 WP0-2 改；补：目录是项目组 / 单聊对话的绑定，授权随成员关系自动成立；新成员加入时的系统消息；入口在项目详情页「概览」；`workdir`（目录）与 `cwd`（执行根）的区别一句话 |
| `10-sandbox.md`、`13-permissions.md`、`28-external-agents-acp.md` | 术语：`project` → `workdir`、任务执行根 `workdir` → `cwd`、群聊 → 项目组；其余不动 |
| `12-ui-layout.md` | 「布局 / 右栏」：项目组无右栏，右栏只服务单聊；新增「项目组外壳」小节（两行顶栏、模块 tab 与徽标、重叠头像堆叠弹层、设置按钮与详情页（内容区页面）、窄屏）；「新建群聊」改「新建项目组」（双轮选择）；「群头像堆叠」改「项目头像堆叠」（侧栏用）；卡片表增「协作暂停卡」；删 `GroupInfo` 描述 |
| `19-work-path-and-group-setup.md` | 删除 D60 全部内容（四问、`setup_state`、`GroupSetupCard`）；保留「一个对话对应一个工作路径」的绑定模型并改成项目组 / 工作目录措辞；创建流程指向 41 / 01；文件名可保留（避免断链），在开头一句话说明它现在只讲工作路径与 Bot 访谈里的目录问题 |
| `27-butler-and-delegation.md` | 工具名（`propose_bots`、`propose_project`、`suggest_route('project')`）、载荷、卡上可改负责人（`approvals.decide.leadBotId`）、管家不进项目组（D70 #8 收口）、`PROPOSE_BOTS_*`；§3.3「同群降级为 D4 `@`」改项目组措辞 |
| `30-supervisor-and-tasks.md` | `workdir` → `cwd`、`chain` → `episode`；§6.2「群聊」改写为项目组：群轮次推进不变，路由改为续接 + 网关；「任务结算唤醒继承回合」写进 §3.2 / §6 |
| `36-wiki-multimodal-ingest.md` | 在 §3.2 / §6 标注：台账文本子集与 `removeSource` 已由项目 wiki 落地（`createdBy`、`sources[].type` 含 `text`、`storage:'git'`），二进制 / 派生仍未实施；owner 泛化 |
| `38-conversational-settings.md` | 目录条目表：`project.title` / `.members` / `.goal` / `.lead`、`workdir.protect-rules` / `.ports`；深链 `project-detail`（`PROJECT_DETAIL_SECTIONS`）；卡片键 |
| `39-workbench.md` | §2.2「群没有负责人角色」改写（项目组有负责人，派给项目组默认 `@` 负责人，可覆盖）；`TodoAssignee` / `assignee_project_id`；文案「项目里无人回应」；§6.4（看板）保持预研并指向 41 §10.3 |
| `41-project-team.md` | 状态改「已实施（日期）」；§18 的默认项按实施结果校正；**把实施中偏离设计的地方（来自各 WP 实施记录）写进相应章节**；§10.3、§9.2 保留作为下期输入 |
| `README.md`（design） | 索引行与 D92 行核对；给 D4、D5、D9、D28、D60、D70、D75、D90 的决策行末尾各补一句「（D92 修订：…）」（沿用 D75 / D89 修订其它决策时的写法）；索引里 `08-project.md` → `08-workdir.md`、各文档描述里的旧名；`19` 的描述改成现状 |

### 开发文档（`docs/dev/`）

| 文档 | 要改成什么 |
|---|---|
| `01-conventions.md` | 仓库结构（`project/` → `workdir/`；新增 `dispatch/project-turn.ts`、`episodes.ts`、`lead-gate.ts`、`light-judgement.ts`、`wiki/index-store.ts` 等一句话）；ID 表（`prj_` → `wkd_`、`chn_` → `epi_`；`ast_`+hash 的资产 id 说明）；常量表：删 `BOT_CHAIN_MAX_DEPTH`，加 README §4.8 的全部新常量与 `PROJECT_TITLE_MAX` 等改名常量，`BUTLER_TEAM_SIZE_*` → `PROPOSE_BOTS_*` |
| `02-architecture.md` | 模块划分里的目录名与新模块；`group` → `project`；`workdir` 术语 |
| `03-data-model.md` | `conversations`（新 DDL）、`workdirs`、`run_changes.workdir_id`、`episodes`、`runs.task_cwd` / `episode_id` / `episode_hop`、`todos.assignee_project_id`、`memory_items.origin`、`jobs` 新类型 `wiki_remove_source` 与 payload 的 `owner`、项目 wiki 的磁盘布局与 `wiki.db`、台账 JSON 结构；**删除级联表**（见下）；「迁移」一节的版本号（main 0042 / runs 0014 / memory 0003）；`chains` 删除 |
| `04-agent-runtime.md` | 提示词段落顺序（`conversation_info` → 项目规则段 → `<workdir>` → `wiki_topics` → `project_wiki_topics`）、各段文字；触发段与新原因的宿主说明；「群聊判断」改「续接判断 + 负责人网关」（输入、输出 schema、超时、失败降级）；`skip_reply` 的摘除条件；`scope` 工具参数 |
| `05-testing.md` | 测试缝 `KEPCUP_TEST_EPISODE_LIMITS`；e2e 清单里 `project-*` / `episode-breaker` / `project-wiki` 等 spec；既有基线引用保持 |

**删除级联表**（`03-data-model.md` 的「删除级联」）必须更新：
- 删除对话（项目组）：增 `episodes`（FK 级联）、项目数据目录 `projects/{id}/`（wiki、wiki-store、`wiki.db`）与该会话的 wiki job（取消）；
- 删除 Bot：增「Bot 是某项目组负责人 → **拒绝**（先更换）」「该 Bot 在项目 wiki 里的来源**保留**（台账 `createdBy` 仍是其 id）、其排队中的 wiki job 取消」；
- 从项目移出成员：增「负责人 → **拒绝**」「其排队中的项目 wiki 入库 job 取消、已入库来源保留」。

### 进度与偏差

1. **`docs/dev/PROGRESS.md`**：在末尾按既有格式新增一节「## 项目组（D92，日期，todo/project WP0-1 ～ WP11）」：每个 WP 一两行（做了什么、关键测试名、全量与 e2e 结果摘要）；T1a / T1b 收口结果；与基线的差异。
2. **`docs/dev/DEVIATIONS.md`**：
   - **DEV-030** 状态改「已落实」：决定 = 采纳「详情页编辑项目目标」（`projects.update`，项目详情页「概览」）；已更新的文档列出 41、01、19、08-workdir、12；
   - 把各 WP 实施期新增的偏差条目（DEV-031 起，若有）状态与已更新文档核对一遍，**未决的保持「待决定」**，不要替人拍板。
3. **`todo/project/README.md`** §7 进度表：逐行填 WP、状态、分支 / 提交、测试结果、偏差；顶部状态改「已实施」。
4. 关闭未删的临时提示：`rg -n "WP[0-9]+ replaces|Transitional shell|removed in WP3|stored value stays" packages apps` 应为空（它们都该在对应 WP 里删掉；若仍有，说明那个 WP 没做完，**回头报告而不是在这里改代码**）。

## 4. 验证

```bash
rg -n "D92 修订" docs                                    # 0 个
rg -n "group_no_claim|GroupTurnCoordinator|GroupRoundEnd|groups\.(create|rename|redistribute|setup)|propose_team|propose_group|BUTLER_TEAM_SIZE|chain_id|chain_depth|ChainsService|BOT_CHAIN|task_workdir|taskWorkdir|assignee_group_id|GroupInfo|GroupSettingsDialog|GroupAvatarStack|createGroupViaUi" docs -g '!docs/dev/phases/**' -g '!docs/dev/PROGRESS.md' -g '!docs/dev/DEVIATIONS.md' -g '!docs/releases/**'
rg -n "\]\([^)]*08-project" -g '*.md' docs todo | rg -v "docs/dev/phases|PROGRESS|DEVIATIONS"           # 链接目标不得再指向 08-project
pnpm fmt:check                                           # 仓库的 prettier 检查；只对你改过的 md 修格式
```

第二条命令应为空；允许的例外（需在实施记录里逐条说明）：文档里作为**历史名称**出现在「修订说明」类句子中的旧名。

## 5. 验收清单

- [ ] 18 个文档顶部的「D92 修订」提示全部删除，正文已改成新状态；`41-project-team.md` 状态为「已实施」并写入实施偏差。
- [ ] 设计 README：D92 行与索引行核对；D4 / D5 / D9 / D28 / D60 / D70 / D75 / D90 行末尾有「（D92 修订：…）」。
- [ ] `01-conventions.md` 的 ID 表与常量表、`03-data-model.md` 的表结构与删除级联表与代码一致。
- [ ] `PROGRESS.md` 新增一节；DEV-030 已落实；`todo/project/README.md` 进度表填完。
- [ ] §4 的三条自检命令与 `fmt:check` 通过。

## 6. 陷阱

- 这是**事实性**文档：每一处新写的行为都要回到代码或 WP 实施记录里核对，不要照抄设计文档里「应该是」的写法——实施中可能有偏差。
- 不要改历史文档的正文；不要新建文档；不要把「D92 修订」提示留在任何文件里。
- 链接改名（`08-project` → `08-workdir`）已在 WP0-2 做过，这里只做核对。

## 7. 实施记录

**2026-10-18 · 直接在集成分支 `feat/project/migration` 上开发（调度方指定，本 WP 无并行项），未 push。** 只改文档，未改任何代码、未跑测试；HEAD 基点 `a1f8e1f9`。

### 提交列表

| 提交 | 内容 |
|---|---|
| `docs(design)` | 设计文档同步：01 / 02 / 05 / 08 / 10 / 12 / 13 / 19 / 27 / 28 / 30 / 36 / 37 / 38 / 39 按现状改写并删除 18 个「D92 修订」横幅；41 状态改「已实施（2026-10-18）」、§18 按实施结果校正、DEV-031–DEV-036 与 WP9 / WP10 实施取舍写进相应章节（§6.2 / §6.3 / §6.5 / §7.3 / §8.4–§8.7 / §12.1 / §17.5）；设计 README：索引行更新、D4 / D5 / D9 / D28 / D60 / D70 / D75 / D90 决策行末尾补「（D92 修订：…）」、D92 行补实施状态 |
| `docs(dev)` | 开发文档同步：01-conventions（仓库结构注释 / ID 表 `ast_` 行 / 常量表——删 `BUTLER_TEAM_SIZE_*` 旧行，加 `PROJECT_TITLE_MAX`、`PROJECT_MEMBER_PREVIEW_MAX`、`PROJECT_GOAL_MAX_CHARS`、`EPISODE_HOP_BREAKER`、`EPISODE_PINGPONG_BREAKER`、`WIKI_TEXT_SOURCE_MAX_CHARS`，`PROPOSE_BOTS_*` 改名）、02-architecture（RunIdentity / TriggerBatch 形状、mailbox 合并与吸收规则、调度优先级行）、03-data-model（迁移表补 0038–0042 / 0013 / 0014 / memory 0003；`conversations` / `episodes` 新 DDL、`runs` / `todos` / `memory_items` 列、jobs 两类 wiki job、项目 wiki 磁盘布局与台账 JSON；**删除级联表三条更新**——删项目组增 `episodes` FK 级联与 `projects/{id}/` 目录 + wiki job 取消，删 Bot 增负责人拒绝与来源保留 / job 取消，移出成员增负责人拒绝与入库 job 取消）、04-agent-runtime（提示词段落表 7.5 项目规则段 / 11.5 `<project_wiki_topics>`、触发原因表新六行、`skip_reply` 摘除条件、「续接判断 + 负责人网关」小节按 `runLightJudgement` / `normalizeGateDecision` 重写、wiki 工具 `scope` 与 `wiki_remove_source` 行）、05-testing（熔断测试缝、项目组 e2e spec 清单）、DEVIATIONS（**DEV-030 状态改「已落实」，决定 = 采纳「详情页编辑项目目标」（`projects.update`，项目详情页「概览」）**）、PROGRESS（新增「## 项目组（D92，2026-10-17 ～ 10-18…）」一节） |
| `docs(todo)`（收口提交） | 本文件 §7、todo/project/README §7 WP11 行与顶部状态「已实施」 |

### 自检命令输出（§4）

1. `rg -n "D92 修订" docs` → **10 处，均为例外**（不是顶部横幅；18 个横幅已全部删除）：
   - `docs/design/README.md` 9 处：D4 / D5 / D9 / D28 / D60 / D70 / D75 / D90 决策行末尾的「（D92 修订：…）」与 39 索引行标注——§3 明文要求补的**修订标注格式本身**（「沿用 D75 / D89 修订其它决策时的写法」）；要字面满足「0 个」就必须改掉任务书指定的标注文字，按 §3 优先。
   - `docs/dev/PROGRESS.md` 1 处：新增节的 WP11 行写明「删除 18 个『D92 修订』横幅」——历史记录类文档（§1 明令不改既有内容，本句即记录）。
2. `rg -n "group_no_claim|GroupTurnCoordinator|…|createGroupViaUi" docs（排除 phases / PROGRESS / DEVIATIONS / releases）` → **34 处，5 个文件，逐类说明**：
   - `docs/design/41-project-team.md`（26）：41 是**变更规格本身**——§2 术语与改名、§3 实施前现状快照、§4.2 结构变更表、§7.2 移除清单（必须点名被删的 `BOT_CHAIN_*` / `ChainsService`）、§7.4 迁移注释、§11.3–§11.4 / §12.2 / §12.5「旧 → 新」对照、§13 改名与迁移方案、§16 影响表。这些句子的语义就是「旧名 → 新名」，不属可改写为现状的正文。
   - `docs/design/README.md`（5）：D70 / D75 / D88 / D90 / D92 决策行——决策记录保存**当时的决定原文**，修订经行末「（D92 修订：…）」表达（D75 / D89 既有写法）。
   - `docs/design/02-execution.md`（1）：「`BOT_CHAIN_MAX_DEPTH` / `BOT_CHAIN_TOKEN_BUDGET` 已删除」——说明删除了什么必须点名。
   - `docs/design/19-work-path-and-group-setup.md`（1）：开头说明「D60 的…（含 `conversations.setup_state`、`groups.setup.*`、`GroupSetupCard`）已整体删除」——同上。
   - `docs/design/37-bot-asset-handover.md`（1）：P0 分期表「`propose_bot` / `propose_bots`（原 `propose_team`）增 `model`」——历史分期计划 + 修订注；37 不在本 WP 改写清单，仅把现行行为描述里的旧工具名改为 `propose_bots`（原句已是不换名就失真的现状描述）。
3. `rg -n "\]\([^)]*08-project" -g '*.md' docs todo | rg -v "docs/dev/phases|PROGRESS|DEVIATIONS"` → **空**（WP0-2 已改，核对通过）。
4. `pnpm fmt:check`（仓库全量 prettier）：本 WP 改动的全部文件（25 个 md + 本文件 + HANDOFF）`npx prettier --check` **全部通过**；仓库全量检查报 533 个 `[warn]`，逐一对照 `git status` **无一在本 WP 改动集内**（均为既有 .ts / .mjs 文件的存量告警，与 WP7「与基线 diff 为零」同口径），按要求只对改过的 md 修格式——实际无需修。
5. §3 进度与偏差第 4 条：`rg -n "WP[0-9]+ replaces|Transitional shell|removed in WP3|stored value stays" packages apps` → **空**（无未删的临时提示，无需回头报告）。

### 例外说明

- **WP8 审查顺延的 `groupMentionOnly` 旧名文档残留**：`docs/dev/03-data-model.md`（settings 行）、`docs/dev/04-agent-runtime.md`（settings 行）、`docs/design/28-external-agents-acp.md`（P6 后台路由节）已按本 WP 正常改写为 `projectMentionOnly`（不在历史豁免清单）；**`todo/acp-external-agents.md`（4 处）不改**——属 §1 通则「`todo/*.md` 除 `todo/project/**` 不改正文」的豁免范围，该残留在此登记备案，留待该 todo 被正式执行或归档时处理。
- `todo/project/HANDOFF.md` 按调度方要求未动。
- 设计 37（资产移交）与 30 §2.2 的两处现状描述旧工具名（`propose_team` / `propose_group`）不在 §3 清单内，但属「文档与代码一致」的事实性错误，已做最小改名（见提交 `docs(design)`）；未做无关格式整理。

### 遗留

- 无阻塞性遗留。可选后续：37 / 40 等未列入 §3 的设计文档如需全面「项目组」措辞清扫（非旧名残留，仅中文措辞），可另行小任务处理。

### 审查修订（2026-10-18，阶段审查）

三处事实性 / 格式修复 + DEV-037 补记，纯文档：

1. `docs/design/02-execution.md`：§「上一轮」路由判断与反思两个表行在改写时被并成一行（`| 0 ||`），反思行被吞——拆回两行。
2. `docs/dev/04-agent-runtime.md`：触发原因表 `routed` / `routed_also` 行照抄了设计的 `routed_by` 属性，实现（`dispatch/project-turn.ts`）没有该属性——改 `—`，并补 `bot_mention` 实际带的 `hop`；提示词段表 7.5 行「项目规则段（无标签）」按实现修正为 `<project_lead_rules>` / `<project_member_rules>`（成员段是函数 `projectMemberRules(leadName)`，原写的常量 `PROJECT_MEMBER_RULES` 不存在）。分歧与取舍记 **DEV-037**。
3. `docs/design/41-project-team.md` §6.3：留痕句同步去掉 `routed_by`（见 DEV-037）。

复核：§4 三条自检命令与 `pnpm fmt:check`（改动 md）复跑通过，命中集合与上方记录一致。

# 41 项目组（Project）：从群聊到协作空间

**状态：已实施（2026-10-18，T1a 项目组核心与 T1b 项目 wiki 均已收口；实施编排与各 WP 实施记录见 [todo/project/README.md](../../todo/project/README.md)，实施中偏离设计处已随 DEV-031–DEV-036 与各 WP 记录写进正文相应小节）。决策编号 D92（2026-10-17 用户逐项确认 K1–K18）。§18 的默认项已按实施结果校正。

早期阶段的工程原则（用户 2026-10-17 确认，本文所有取舍据此）：**不保证旧数据可用、不做向后兼容；允许大规模替换变量、方法、文件夹、文档名；以语义准确、框架坚实为唯一目标。**

相关：D4 / D5（群 `@` 连锁与响应，[02](02-execution.md#群聊响应)）、D9（Wiki 隔离，[05](05-wiki-and-skills.md)）、D28（Project 目录，[08](08-workdir.md)）、D60（群创建，[19](19-work-path-and-group-setup.md)）、D70 / D71（管家与委派，[27](27-butler-and-delegation.md)）、D75（对话轮与任务，[30](30-supervisor-and-tasks.md)）、D85（Wiki 多模态，[36](36-wiki-multimodal-ingest.md)）、D89（对话内设置，[38](38-conversational-settings.md)）、D90（工作台，[39](39-workbench.md)）、DEV-030（群定位无编辑入口 → 已落实为「详情页编辑项目目标」，[DEVIATIONS](../dev/DEVIATIONS.md)）。

## 0 摘要

- **本质**：群聊升级为**项目组**——用户「拉群」是为了协作，不是让 Bot 聊天。项目组 = 一个目标 + 一位**负责人** + 若干**成员** + 一组**协作模块**（沟通、看板、Wiki、OKR、日历），外加一个共享的**工作目录**。
- **数据模型（O1）**：项目组就是一种会话——`conversations.type` 取值 `direct | project`，项目行必有负责人（数据库 `CHECK` 保证）。「沟通」是它的第一个模块；其他模块的数据以 `project_id`（= 根会话 id）为键。不新增独立聚合，不保留「纯群聊」形态。
- **沟通路由重做**：没有 `@` 的用户消息 → 上一位回话者先做续接判断 → 不认领则由负责人的**网关**决定「自己答 / 静默转给成员 / 无需回应」。静默转给成员时界面没有任何痕迹，体感是成员自己认为与己有关并作答。取消全员广播判断。
- **连锁重构为协作回合 + 熔断**：移除 token 预算与硬性深度；修复「任务结算唤醒的对话轮不继承连锁」这个防环缺口；改为 Bot 间自动往返超过阈值时暂停并让用户点「继续」。
- **文档模块取消，改为项目 wiki**：复用 Bot wiki 引擎，泛化「所有者」为 Bot 或项目；共享单写入维护 loop；**来源条目有创建者**，Bot 只能删自己的来源，用户与负责人管理全部；本期做。
- **界面**：创建改双轮；顶栏左侧两行（项目名 / 模块 tab），右侧重叠头像堆叠 + 设置按钮；项目详情是内容区里的页面，不用弹框；群聊不再有右栏。
- **全套改名**：共享目录 `project → workdir`；D75 的任务执行根目录 `workdir → cwd`；`group → project`；连锁 `chain → episode`。**先做一个行为中性的纯改名提交**，再做功能。
- **本期范围**：T0 纯改名 → T1a 项目组核心 → T1b 项目 wiki。看板（复用 `todos`）、日历、OKR 下期。

## 1 想法与已定决策

### 1.1 原始想法

群聊源自人类社交场景；用户拉群是为了达成目标或维护状态。需要升级为类项目协作软件的「项目组」：原群聊保留并更名为「沟通」，增加看板 / wiki / OKR / 日历等模块做信息对齐，指定或创建一个 Bot 为项目负责人（类似管家、权限限于项目内、可与用户直接对话、调度成员、管理模块），权限按模块区分，项目设置本地目录并授权所有成员，界面上顶部 tab、右上角功能区、新建双轮选择、不再有右栏。

### 1.2 已定决策

| #   | 决策                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | **不做最小改动**：允许全量改名与重构，不迁移旧数据，旧群聊数据可丢弃；语义必须与功能一致                                                                                                                                                                         |
| K2  | **项目组 = 群聊的升级形态**，不保留「纯群聊」；代码实体名 `project`，会话类型 `project`，界面叫「项目组」；沟通是其第一个模块（O1）                                                                                                                                       |
| K3  | **必有负责人**：新建必须选或建；无负责人不是合法状态（数据库 `CHECK`）；删除 Bot 前须先更换其领导的项目；全员广播判断整体删除                                                                                                                                                |
| K4  | **默认路由**：没有 `@` 的消息 → 上一位回话者续接判断 → 负责人网关（`self` / `route` / `none`）→ 静默路由；纯致谢 / 寒暄允许 `none`；宿主保证「每条用户消息必有结局」                                                                                                           |
| K5  | **负责人权力**：项目内的 `@` 成员、写模块不套 D90「仅用户本人触发」闸门；项目外一概无权；调度成员本期靠沟通里的可见 `@`（静默路由只选「谁来答」）                                                                                                                                      |
| K6  | **连锁 → 协作回合**：去掉 token 预算与硬性深度；任务结算唤醒的轮次继承原回合；改为熔断（Bot 间自动往返超阈值暂停，用户点「继续」）                                                                                                                                             |
| K7  | **文档模块取消**，改为**项目 wiki**（复用 Bot wiki 引擎）；模型 C：共享单写入维护 loop，来源条目有创建者；Bot 个人 wiki 仍完全隔离；**本期做**                                                                                                                          |
| K8  | **看板 =** `todos`（下期）；日历 / OKR 下期；tab 叫「看板」                                                                                                                                                                             |
| K9  | **管家不进项目**（既不当负责人也不当成员）                                                                                                                                                                                                |
| K10 | 不提供广播模式；加成员维持「系统消息」、不做加入前确认；工作目录可选                                                                                                                                                                                     |
| K11 | **顶栏**：左两行（项目名 / tab），右侧重叠头像堆叠（点开成员下拉 + 添加）+ 设置按钮；设置按钮把项目详情显示在内容区，tab 行不新增项，再点任一 tab 返回；详情页不用弹框                                                                                                                        |
| K12 | **命名**：共享目录 `workdir`、任务执行根目录 `cwd`、`project` 一词给项目组；纯改名先行                                                                                                                                                             |
| K13 | **worktree 本期不需要**（§9.2 给出评估）；下期评估路径作用域写租约                                                                                                                                                                             |
| K14 | 新建项目组的成员候选**排除管家**；创建下限为负责人 + ≥ 1 位成员                                                                                                                                                                                  |
| K15 | **全局上下文预算单独评估，不并入本期**：本文只移除连锁的 token 预算与深度，新增的项目上下文段不设预算；`PERSONA_TOKEN_BUDGET`、`RECENT_MESSAGES_TOKEN_BUDGET`、`TOOL_OUTPUT_MAX_CHARS` 等全局预算要等「按模型窗口压缩」机制就绪后再议（超窗口不压缩会直接报错；`TOOL_OUTPUT_MAX_CHARS` 防的是单次工具输出撑爆窗口，性质不同） |
| K16 | 批量提议建 Bot 的工具叫 `propose_bots`（保持与 `propose_bot` / `propose_project` 的 `propose_` 前缀一致，它是审批卡而非直接创建）                                                                                                                     |
| K17 | **路由先后而非并行**：P 先做续接判断，不认领才进负责人网关（网关要用 P 的结论；代价是多一次秒级轻量调用）                                                                                                                                                              |
| K18 | **保留旧群的纯 SQL 转换**（§4.3）：比清理旧群省事，也让现有开发库可用；不承诺升级路径                                                                                                                                                                      |

## 2 术语与改名

| 概念 | 界面 | 代码 | 备注 |
|---|---|---|---|
| 项目组 | 项目组 | `project`（`conversations.type='project'`、`projects.*` RPC） | 原 `group` |
| 项目负责人 | 项目负责人 | `lead`（`lead_bot_id`） | |
| 项目成员 | 项目成员 | `member`（`conversation_members`） | |
| 沟通 | 沟通 | 模块 `chat` | 原群聊 |
| 项目目标 | 项目目标 | `goal`（原 `description`） | 非空才注入提示词 |
| 共享目录 | **工作目录** | `workdir`（表 `workdirs`、`conversations.workdir_id`、`WorkdirRuntime`、`workdirs.`* RPC） | 原 D28 `Project`，单聊也可绑定 |
| 任务执行根目录 | —（不外露） | `cwd`（`runs.task_cwd`、`resolveCwd`） | 原 D75 `workdir` |
| 协作回合 | —（卡片文案「协作」） | `episode` | 原 `chain` |
| 项目 wiki / Bot wiki | Wiki | `WikiOwner = bot \| project` | |
| 批量提议建 Bot | — | `propose_bots` | 原 `propose_team` |
| 提议建项目组 | — | `propose_project`（载荷带 `lead_bot_id`） | 原 `propose_group` |

**不要全局替换** `group`：以下是别的含义，必须逐处判断——UI 库的 `*-group` 组件（`dropdown-menu-group`、`sidebar-group`、`resizable-pane-group`、`avatar-group` 等）、侧栏的「对话分组」（`sidebar-sections`）、设置目录条目的 `group` 分类字段（`'models'` / `'search'` …）、`tier-grouping`、`connections-group`。

## 3 现状（代码对照）

| 方面   | 现状                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 会话类型 | `conversations.type ∈ {direct, group}`（CHECK）；群 = 会话行 + `conversation_members`；有 `description`、`project_id`（目录）、`setup_state`（D60 残留）                                                                                                |
| 群路由  | 显式目标（`@` / 回复 / `forcedTarget`）→ 否则**全员**各做一次轻量判断（`GroupTurnCoordinator.#startTriage`，N 成员 N 次调用）→ 按置信度依次响应；无人认领出 `group_no_claim`（`dispatch/group-turn.ts`、`dispatcher.ts`）                                                         |
| 连锁   | Bot 间 `@`：深度 ≤ 3、链 token 预算 200k（`dispatch/chains.ts`）。**缺口（已核实）**：任务结算经 `wake` 以 `reason:'task'` 唤醒的轮次不带 `chain`，`#startTurn` 只在 `batch.chain` 存在时绑定，任务 run 也不绑 → 隔一个任务就新开连锁、深度与预算重置                                                |
| 目录   | `projects` 表 + `conversations.project_id`；群内所有 Bot 读写；写入租约同一 workdir 同时一个写任务（D75 / [30 §5](30-supervisor-and-tasks.md#5-并发与写互斥)）。`workdir` **在 D75 里已指「任务执行根目录」**（`runs.task_workdir`、`resolveWorkdir`，189 处 / 44 文件）                |
| Wiki | 生产里只有 P09 文本入库；**D85 的** `_assets` **台账、**`wiki.deleteAsset`**、**`wiki_derive` **只在设计里**。实现全按 Bot 键控：`botWikiRoot` 路径、`wiki_fts` 在每个 Bot 的 `memory.db`、jobs 带 `bot_id`、`KeyedMutex` 以 `botId` 为键、维护 loop 身份与用量归 Bot、RPC 入参 `{botId}` |
| 右栏   | 群聊右栏 = `GroupInfo`：改名、成员、目录、**访问授权撤销**、定时任务、网页监看、成员浏览器「显示」按钮                                                                                                                                                                         |
| 顶栏   | 浮动居中药丸（绝对定位、渐隐），点击开合右栏                                                                                                                                                                                                               |
| 管家   | `bots.system_role='butler'`，Bot 级、全局唯一；工具 `propose_team / propose_bot / propose_group / suggest_route`                                                                                                                               |
| 工作台  | 事项可派给「群 + 可选负责 Bot」，派发是带 `@` 的可见消息（D90）                                                                                                                                                                                              |
| 设置目录 | `group.title`、`group.members` 两项，深链到 `GroupSettingsDialog`（`embedded` 模式供设置卡内嵌）                                                                                                                                                      |

## 4 数据模型

### 4.1 O1：会话即项目根

main 迁移（按 0018 / 0037 的重建写法，`conversations` 是被大量表引用的枢纽表，需 `foreign_keys=OFF` 重建）：

```sql
CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('direct', 'project')),
  title        TEXT,
  goal         TEXT,                                  -- 项目目标（原 description）；direct 恒 NULL
  direct_bot_id TEXT,
  lead_bot_id  TEXT REFERENCES bots(id),              -- 项目负责人
  workdir_id   TEXT,                                  -- 工作目录（原 project_id；与原列一致，无 FK）
  -- …其余列不变（summary、cursor、read_only、created_at…）；删除 setup_state（D60 残留）
  CHECK ((type = 'project') = (lead_bot_id IS NOT NULL))   -- 项目恒有负责人，单聊恒无
);
```

- **负责人必须是成员、active、非管家**：`CHECK` 管不了成员关系，由 `ProjectsService` 在创建、更换、移出时校验。
- **模块表的键**：以后各模块建表一律 `project_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE`，语义是「项目 id（= 其根会话 id）」。
- **为什么不是独立聚合（O2）**：当前一个项目只有一个沟通频道，独立 `projects` 实体会让成员要在两处维护（或由频道派生），而收益为零。将来真要多频道或「独立于聊天的项目生命周期」，把现有会话 id 当项目 id 拆出一张 `projects` 表即可平滑过渡。

### 4.2 一并落地的结构变更

| 变更 | 说明 |
|---|---|
| `projects` → `workdirs`；`conversations.project_id` → `workdir_id` | 纯改名（T0，迁移 0038）；`run_changes` 等引用目录的列同步改名 |
| `runs.task_workdir` → `task_cwd` | runs 库迁移，纯改名（T0） |
| `chains` → `episodes`；`runs.chain_id / chain_depth` → `episode_id / episode_hop` | 语义见 §7，T1a |
| 删除 `conversations.setup_state`、D60 四问后端（`groups.setup.*`、orchestrator `beginGroupSetup` 等、`GroupSetupCard`） | 创建必须选负责人，四问流程无法满足这一点；T1a |
| `todos.assignee_group_id` → `assignee_project_id`；`TodoAssignee.group` → `.project` | 见 §12.3 |
| `wiki` 所有者泛化、`raw/_assets` 台账、项目级 FTS 库 | 见 §8，T1b |

### 4.3 旧数据

不承诺升级路径，开发库删库重来即可。但迁移本身要产出**合法库**——最省事的做法不是清理旧群，而是**直接转换**（纯 SQL，无需清 `runs.db` 与磁盘）：旧群 → `project`，负责人取入群最早的非管家成员；没有合格成员的（含 D60 创建中的残留）直接删除。这是尽力而为的转换，不是受支持的升级。

## 5 角色与权限

| | 用户 | 负责人 | 成员 |
|---|---|---|---|
| 发言 / 响应 | ✓ | ✓；网关兜底必答（§6） | 被 `@`、被路由、续接时响应 |
| 项目信息（名称、目标、工作目录、成员、负责人） | ✓ | ✗ | ✗ |
| 工作目录读写 | ✓ | ✓ | ✓（保护规则全员一致；写入租约同 [08](08-workdir.md)） |
| Wiki 读 | ✓ | ✓ | ✓ 全部 |
| Wiki 添加来源 | ✓ | ✓ | ✓ |
| Wiki 删除来源 | 全部 | 全部 | 仅自己创建的 |
| Wiki 体检 / 回滚 | ✓ | ✓ | ✗ |
| 看板、OKR、日历（下期）写 | ✓ | ✓ | ✗（读） |

- **权力半径 = 项目组**：负责人没有建 Bot、跨项目委派、改别的 Bot 设置等能力；沙箱外执行、git 远程、敏感写入的用户审批照常出卡，不因身份豁免。
- **管家不是项目参与者**：候选列表、`addMembers`、`propose_project` 都拒绝管家。
- **与 D90「仅用户本人触发」闸门的关系**：管家被限制，是因为它权力全局、半夜替用户派活是越权。负责人的职责就是在项目内自动调度（成员汇报唤醒它，那一轮不是用户本人触发），套同一闸门等于废掉这个角色。所以项目内不设此闸门，项目外一概无权。代价是项目内多了一条「成员读到恶意内容 → 汇报污染负责人 → 诱导交办」的传播链，缓解见 §6.3、§8.5、§17。

## 6 沟通：路由

### 6.1 不变式

1. **每条用户消息必有结局**：一条可见回复、一个明确的静默（网关 `none`）、或失败态（界面内联显示并可重试）。不会无声消失。
2. **负责人是兜底**：与所有成员都无关的消息，一定与负责人有关。
3. **静默路由只选「谁来答」**：投递给目标的是用户原话，**不携带负责人写的任何内容**——不增加提示注入面；需要写指令的交办走可见 `@`，可审计。
4. **没有全员广播**。

### 6.2 决策顺序

```text
工作台派发（结构化 @ 生效负责人；`forcedTarget` 为可选快路径，DEV-031） → 该 Bot
显式目标（@ / 回复某个 Bot 的消息）          → 这些 Bot，按出现顺序
否则 → 路由阶段：
  ① P = 最近一条可见 Bot 回复的作者
        （须是在场成员、非负责人、在连续窗口内；P 即负责人或不存在则跳过 ②）
  ② P 续接判断（轻量调用；P 视角输入，含它自己的私有任务时间线）
        认领（respond 且置信度 ≥ 阈值）→ P 的对话轮，结束；负责人不被唤醒
  ③ 否则（无 P / P 说与己无关 / P 超时或失败）→ 负责人网关
        self  → 负责人完整对话轮，必须回应
        route → 目标成员的对话轮，静默，目标必须回应
        none  → 静默结束（仅限纯致谢 / 寒暄 / 无需任何人回应）
  ④ 兜底：一轮结束没有任何可见回复且网关结论不是 none → 负责人兜底一次；
        网关超时 / 失败 / 输出非法，一律按 self
```

### 6.3 各环节

**P 与续接判断。**

- P 取自消息表（最近一条 `senderType='bot'` 的可见消息，不含卡片、系统事件、`task_event`），无需新增状态。静默路由答出的 Bot 也是 P——用户端的体感与实际一致。
- 续接判断复用 `triageOneBot`：只有 P 一个 Bot 做判断，输入按 P 的视角过滤，所以 P 知道自己手头有没有没做完的事——这是让 P 先判断的根本理由（负责人看不到 P 的私有时间线，D75）。
- 连续窗口 `ROUTING_CONTINUATION_WINDOW_MS`（初值 30 分钟）；认领阈值 `ROUTING_CONTINUATION_MIN_CONFIDENCE`（初值待实测）；超时沿用 `TRIAGE_TIMEOUT_MS`。

**负责人网关。**

- 轻量结构化调用，用负责人的轻量模型（`lightModelRefForBot`）；输入：触发批、最近消息、项目目标、成员名片（含职责）、**P 的结论与理由**（让负责人知道「上一位说与己无关」）；输出 `{ decision: 'self' | 'route' | 'none', targets?: string[], reason: string }`，`targets` 只能取在场的非负责人成员。
- 网关提示词的硬规则：**「与所有成员都无关 = 与你有关」**，只有三种出口，拿不准一律 `self`；`none` 只给纯致谢、寒暄、无需任何人回应的消息。
- `route` 可多个目标，按顺序响应（沿用现有「轮次」机制，后者能看到前者的回复）。**第一个目标必须回应，其后目标可** `skip_reply`（已被前者覆盖时）。

**必答回合。**

- `trigger_reason` 新增 `continuation`（P 续接）、`routed`（被路由的**首个**目标，必答）、`routed_also`（同一次路由的其余目标，可 `skip_reply`）、`lead_fallback`（网关 `self` 与路由产生的整轮无回复兜底共用，负责人完整对话轮，必答）；另有 `routing_gate`，**只**写在网关那次轻量调用的 run 行上，不是投递原因。四个投递原因的触发段都带宿主说明（原文见 todo WP3 步骤 8）：`routed` →「负责人判断这条消息与你有关，请直接回应用户，不要提及被转交」；`lead_fallback` →「没有成员认领，这条消息由你处理」。`chain` 改名 `bot_mention`、`broadcast` 删除。
- 必答 = 该轮工具面**摘掉** `skip_reply`（原因属于 `MUST_REPLY_REASONS = ['routed', 'lead_fallback']`；合并批只要有一个必答部分就必答），而不是只靠提示词。被路由的成员**不能再转手**（静默路由只有网关能做，它没有这个工具）。
- 轮次结算时若整轮没有可见回复且网关结论非 `none` → 宿主触发 `lead_fallback`（每轮至多一次）。负责人兜底轮自己失败 → 走现有失败态与重试。

**界面反馈。**

- 路由阶段（P 判断、网关判断）显示「正在确认由谁回复」状态行（`project.turn` 的 `routing` 阶段）；`route` 之后只显示目标成员的状态行，**全程不出现负责人**。实施修正（DEV-036）：状态行组件最初把路由阶段（`currentBotId=null`、`queue=[]`）挡成永不显示，随 e2e 断言修复为「routing 阶段恒显示」。
- 不出现任何「负责人转交」的消息或卡片。路由留痕在**执行记录**里：触发原因 `routed` / `routed_also`、段末的宿主说明（`projectWakeHint`）与网关的 `reason`——对用户不可见，可审计、可据此调参（负责人身份可从 run 的网关调用记录与成员名片推得，不单独落 `routed_by` 属性）。
- `group_no_claim` 卡与「点选成员重新分发」（`groups.redistribute`）一并删除。

**可见交办仍在。** 负责人在自己的完整对话轮里仍可 `send_message(mention_bot_ids)` 做可见 `@` 交办（写清交付物，计入协作回合与熔断）。两者分工：

| | 静默路由 | 可见 `@` 交办 |
|---|---|---|
| 作用 | 把用户的消息交给合适的成员 | 负责人向成员布置具体工作 |
| 谁发起 | 宿主按网关结论 | 负责人的对话轮 |
| 内容 | 用户原话 | 负责人写的指令 |
| 界面 | 无痕迹 | 一条可见消息 |
| 计入熔断 | 否 | 是 |

### 6.4 成本与延迟

| | 现状 | 新 |
|---|---|---|
| 每条未 `@` 消息的轻量调用 | N（全员判断） | 0–2（P 续接 + 网关；P 认领时只有 1） |
| 「无人认领」 | 可能，需用户点选 | 不存在 |
| 延迟 | 并行判断，≈ 1 次 | P 与网关先后，≤ 2 次（秒级）。想要更低延迟可改为并行 + 宿主合并，结论一致，但网关拿不到 P 的结论，不推荐 |

### 6.5 其他入口

- **工作台派发**：`dispatchWorkbenchMessage` 走结构化 @ 生效负责人（执行者覆盖项优先，缺省项目负责人；`PendingBatch.forcedTarget` 分支按 WP 字面保留为等价快路径，生产代码无调用方——DEV-031）。
- **用户编辑消息**：沿用现有重触发路径，走同一决策顺序。
- **新批次在路由阶段到达**：沿用现有 `#pending` 排队，等本轮结束再分派。

## 7 协作回合与熔断

### 7.1 取代连锁

**协作回合（episode）** = 一条用户消息批（或工作台派发 / 定时触发）引出的全部 run 的因果树，节点包括对话轮、任务、子代理。每个 run 带 `episode_id`，继承规则**全部由宿主在创建 run 时确定**：

| run 的来源 | `episode_id` |
|---|---|
| 用户批直接触发（显式目标、续接、网关结论、兜底） | 该批的回合 |
| Bot 可见 `@` 触发的对话轮 | 发起 `@` 的 run 的回合，`episode_hop + 1` |
| 任务 | **不绑定回合**（没有 token 预算要统计，任务 run 自身不带回合） |
| **任务结算唤醒的对话轮** | **在唤醒时**按任务的起源对话轮（`origin_run_id`）解析其回合并继承（修复缺口）。必须在唤醒时而不是任务启动时解析：发起任务的那一轮可能在任务启动**之后**才第一次 `@`、才建立回合；若起源轮此时仍没有回合，被唤醒的轮也不绑定，其首次 `@` 才新建回合 |
| 子代理 | 不绑定（它是父 run 内部的嵌套，不触发 `@`） |
| 新的用户消息 | 回合在该轮**首次 Bot 发起 `@` 时**才懒创建（与旧连锁一致：发起 run 记为根、`hop 0`）；没有 `@` 就没有回合行 |

`hop` 只数**Bot 发起的触发**（可见 `@`）；网关路由是宿主按用户消息做的，任务结算唤醒是同一 Bot 继续自己的工作，都不算。

### 7.2 移除什么、保留什么

- **移除**：`BOT_CHAIN_TOKEN_BUDGET`（200k）、`BOT_CHAIN_MAX_DEPTH`（3）、`tokensInFlightFor`、`usage.sumForRuns(chain)`、`chains.tokens_used`，以及 `ChainsService.mention` 里的丢弃逻辑。
- **保留（不是连锁上限，是单次运行的成本保险）**：无。（`TASK_TOKEN_BUDGET`、`SUBAGENT_TOKEN_BUDGET`、`WIDGET_CRAFT_TOKEN_BUDGET` 与后台每日预算 `BACKGROUND_DAILY_BUDGET_DEFAULT` 后续已按用户要求全部移除；单次运行只剩时限。）
- **不在本文范围**：Bot 提示词各段的预算（`PERSONA_TOKEN_BUDGET`、`RECENT_MESSAGES_TOKEN_BUDGET`、`TOOL_OUTPUT_MAX_CHARS` 等）。移除它们要先有「按模型窗口压缩」的机制，是对整个上下文装配的改造，单独评估（K15）。本文新增的项目上下文段（项目目标、成员名片、负责人标记、项目 wiki 主题）**不设人为预算**。

### 7.3 熔断

- 触发条件（精确语义）：同一回合内 Bot 发起的触发**最多放行 `EPISODE_HOP_BREAKER`（12）次，第 13 次被暂停**；同一无序 Bot 对之间**最多放行 `EPISODE_PINGPONG_BREAKER`（8）次触发（约 4 个来回），第 9 次被暂停**；两个条件任一先到即暂停。目标是正常协作永远碰不到，病态循环不会静默烧钱；集成测试经 `KEPCUP_EPISODE_HOP_BREAKER` / `KEPCUP_EPISODE_PAIR_BREAKER` 环境变量压低阈值，e2e 用测试钩子专用的 `KEPCUP_TEST_EPISODE_LIMITS`。
- 触发后：**停止投递**后续 Bot 发起的触发，不丢弃——未投递的 `@` 记在回合行的 `pending_json` 上；发起 `@` 的 Bot 的工具返回「协作已暂停，等待用户确认是否继续」；对话里出现一张**协作暂停卡**：「协作已自动往返 N 次，是否继续？」`[继续]` `[停止]`。
- `继续`：投递 pending，hop 计数清零（再往返 N 次才会再触发）；`停止`：丢弃 pending，向相关 Bot 发一条内部事件「用户停止了本次协作」。
- 暂停卡**不进** `approvals`（避免重建 `kind` CHECK），是系统卡 + `episodes.resume / stop` RPC；**无人值守模式不自动继续**（它是保险丝，不是审批）；应用重启后 pending 随回合行保留。

### 7.4 数据

```sql
-- main.db
CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,                   -- epi_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_batch_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  hops            INTEGER NOT NULL DEFAULT 0,         -- Bot 发起的触发总数
  pair_hops_json  TEXT NOT NULL DEFAULT '{}',         -- { "botA|botB": n }，键为字典序排序后的无序对
  pending_json    TEXT NOT NULL DEFAULT '[]',         -- 熔断时未投递的 @ 触发：[{ toBotId, fromBotId, messageId, hop }]
  paused_at       INTEGER,                            -- 熔断时间；NULL = 正常
  created_at      INTEGER NOT NULL
);
-- runs.db：runs.chain_id/chain_depth → episode_id/episode_hop
```

## 8 项目 wiki

### 8.1 定位与 D9

- 项目 wiki 是**项目所有**的共享知识库，复用 Bot wiki 的引擎（git + `SCHEMA.md` / `index.md` / `log.md` / `raw/` / `pages/` + FTS + 维护 loop）。
- **D9 修订**：Bot 个人 wiki 仍完全隔离（不向项目成员开放）；项目 wiki 是项目内**唯一被许可**的跨 Bot 共享知识通道。
- 项目 wiki 随项目删除而删除；成员（含负责人）变动不影响它。

### 8.2 模型 C

- **来源（raw）条目有创建者**（`user` 或 `bot:{id}`）；**页面**由维护 loop 综合并带出处。「Bot 管自己创建的内容」= 删自己添加的来源；用户与负责人管理全部来源。
- **单写入者**：每个项目 wiki 一个串行维护队列，互斥键 `project:{id}`。多个成员同时 `wiki_enqueue` 只是入队，不会并发写同一个 git 库。
- 页面由 loop 综合，不允许任何一方直接改页面（用户可删页面，沿用现有 `deletePage`）；这避免了「他人的页面我能不能改」的所有权纠纷。

### 8.3 存储与索引

| 项 | 方案 |
|---|---|
| 路径 | `projects/{id}/wiki/`（git，布局同 Bot wiki）与 `projects/{id}/wiki-store/`；路径助手泛化为 `wikiRoot(owner)` |
| FTS | **项目级** `projects/{id}/wiki.db`（`wiki_fts`）。不能放进成员的 `memory.db`（那是 Bot 私有的）；`WikiFtsFacade.storeFor(owner)` |
| 来源台账 | `raw/_assets/{assetId}.json`，**对齐 D85 的结构**（`id`、`sha256`、`fileName`、`bytes`、`sources[]`、`createdAt`…）并增 `createdBy: { kind: 'user' \| 'bot', id }`。本期只落文本类来源子集；D85 的二进制 / 派生后续填充同一结构，不返工。Bot wiki 暂不启用台账 |
| 页面出处 | 维护 loop 写页面时在引用段列出来源 asset id（`SCHEMA.md` 既有的引用格式），体检检查悬空引用 |

### 8.4 维护身份与成本

- **执行者付费**：成员 `wiki_enqueue` 的入库，维护 loop 以**该成员**的身份运行（模型 `main_for_bot`、用量与后台每日预算记在该成员名下）；用户添加的来源与定期体检以**负责人**身份运行。
- job 行：`bot_id` = 执行者，`conversation_id` = 项目 id，payload 带 `owner: { kind: 'project', id }`；去重键 `wiki_ingest:project:{id}:{sourceType}:{ref…}`。
- 互斥队列保证串行。**实施取舍（WP9）**：没有做按 owner 的单独排队——后台全局并发 `BACKGROUND_LOOP_CONCURRENCY = 2`，同项目多成员同时入库时，被认领等锁的 job 至多占满 2 个后台槽位（其余仍 pending 不占槽），期间同项目维护串行推进、其它后台 loop 被推迟。本期接受，未做调度。

### 8.5 工具、读写与可信度

- **复用既有三件套，加** `scope`：`wiki_search { scope: 'mine' | 'project' | 'all' }`（默认 `all`，结果标注来源）、`wiki_read`（按检索返回的引用读取）、`wiki_enqueue { scope }`（**默认** `mine`——发布到共享空间必须是有意为之）。仅在项目对话里出现 `project` / `all`。
- **新增** `wiki_remove_source`（异步托管动作，同 `wiki_enqueue` 的非阻塞范式）：Bot 只能删自己创建的来源，负责人删任意；入队时与执行时各校验一次 ACL；执行 = 移除原件 + 台账，提交，并登记一次体检清理悬空引用（即 D85 §6 的 `wiki.deleteAsset` 的文本子集，本期首次实现）。**走 job（`wiki_remove_source`，不调用模型、不受预算延后）而不是同步执行**：删除要拿项目 wiki 的互斥锁，而锁可能正被一次几分钟的维护持有，工具与 RPC 都不能阻塞等它；界面靠 `wiki_changed` 刷新。
- 用户从界面添加来源：网址或**粘贴文本**（`text` 来源类型**只给用户**：`wiki_enqueue` 工具的 `source_type` 枚举不含它，`enqueueIngest` 对 `text` 要求 `createdBy.kind==='user'`；台账 `sources[].type` 联合含 `text`，`ref` 只存正文前 80 字预览，长度上限 `WIKI_TEXT_SOURCE_MAX_CHARS` = 200 000）；本期不做界面上传文件——用户要入库文件，对 Bot 说「存到项目 wiki」，由 Bot 用 `wiki_enqueue` 的 file / attachment 类型入库。
- **可信度**：用户创建的来源可信；Bot 创建的来源，以及由它参与综合的页面，其他 Bot 读取时包进 `<untrusted source="project_wiki">` 并标注创建者；页面按出处判定——全部出处为用户才算可信。
- **提示词**：项目对话注入项目 wiki 的主题段（取自项目 `index.md`），不设人为预算；Bot 的个人主题段不变。

### 8.6 所有者规则

- Bot 被删：其添加的来源保留，创建者显示为占位 id（同「发送者显示为 id」）；仍由用户 / 负责人管理。
- 项目被删：wiki 目录、`wiki.db`、`wiki-store` 一并删除；删除确认框列出来源数与页面数。
- 移交（D88）：项目 wiki 不在移交范围；Bot wiki 的移交不变。

### 8.7 界面

项目组的 Wiki tab = `features/wiki/WikiBrowser.svelte`（原单聊右栏 `WikiTab` 纯改名泛化 `owner`，单聊右栏仍用同一组件）+ `ProjectWikiView`；左侧页面树 + 搜索，右侧阅读；「来源」面板（`WikiSourcesPanel`）列出所有来源与创建者徽标（用户显示「你」、Bot 显示名字、已删除 Bot 显示 id），用户可添加网址 / 粘贴文本、按权限删除（删除中状态机：30 秒超时还原）；历史 / 回滚沿用。`wiki.*` RPC 入参 `{botId}` → `{ owner: { kind: 'bot', botId } \| { kind: 'project', projectId } }`；已落地 `wiki.addSource`、`wiki.sources`、`wiki.deleteSource`；事件 `wiki_changed` 带 owner。删除项目组确认框列出 wiki 来源数 / 页面数。

### 8.8 工作量与风险（来自代码盘点）

- **泛化清单**：`WikiOwner` 贯穿 service / 路径 / 互斥 / 事件；项目 wiki 存储布局与初始化；项目级 FTS 库与启动对账；job 载荷与去重键、体检调度扩到项目；维护 loop 身份与用量；`wiki_enqueue` 在项目对话的目标；台账与 `wiki.deleteAsset`；工具 / RPC / UI 的 `scope` 与 `owner`；项目对话的主题注入；项目删除级联；测试。
- **最险三处**：①FTS 与存储布局（Bot wiki 与交接复制不能被破坏）；②执行者付费在「单写入者队列」下的归因与预算（排队的 job 以谁的预算判定、被谁的预算推迟）；③来源级 ACL 与删除在多成员并发入队下的正确性。
- 这是本期**最大的一块**，所以拆为独立里程碑 T1b（§14）。

## 9 工作目录与并发

### 9.1 工作目录

- 机制不变：目录绑在对话上（`conversations.workdir_id`），项目内所有成员读写，保护规则（`.env*` 等）全员一致，写入租约同 [08](08-workdir.md)。**授权随成员关系自动成立**，无需逐个授权。
- 目录**可选**；在项目详情页设置与更换；有 Bot 正在执行时不能切换（沿用）。
- **新成员加入已绑目录的项目组** → 沟通里落一条系统消息「{Bot} 已加入，获得工作目录 {名称} 的读写权限」（沿用「项目已切换」的先例）。无需加入前确认（K10）。

### 9.2 worktree 评估（你要求本期评估）

**结论：本期不需要，也不建议做。**

- D75 否决 worktree 的四个理由都仍成立：写用户 `.git`（worktree 元数据落在 `.git/worktrees`）违反 D31 与影子仓库底线；路径网关锚在单一目录，会让 `denyRead` 失效；检查点「两次快照之差」对不上；新 worktree 缺依赖与未提交改动。
- **非 git 目录根本用不了 worktree**；而项目组不限于代码类。
- **本期并发压力低**：只有沟通与 wiki。路由让多数消息一次只落给一位成员；wiki 写入走单写入者队列，不碰工作目录。
- **压力出现在下期**：看板并行派任务时，同一目录同时只能一个写任务，成员写目录会串行排队（任务卡显示「等写入租约」）。
- **更值得评估的替代是「路径作用域写租约」**：任务启动时声明写入范围（目录 / glob），只有范围重叠才互斥。保持单工作树，影子仓库与检查点按路径归属仍成立，沙箱按范围挂可写。作为 T2 的前置设计，本期不动。

## 10 模块框架

### 10.1 注册表（`packages/shared`，纯数据，写法同 `HOST_CAPABILITIES` / 设置目录）

```ts
export const PROJECT_MODULES = [
  { id: 'chat',     status: 'available', write: 'members' }, // 沟通
  { id: 'wiki',     status: 'available', write: 'owner'   }, // 项目 wiki：条目级所有权（§8）
  { id: 'board',    status: 'planned',   write: 'lead'    }, // 看板
  { id: 'okr',      status: 'planned',   write: 'lead'    }, // OKR
  { id: 'calendar', status: 'planned',   write: 'lead'    }, // 日历
] as const;
// write：'members' 全员可写 | 'lead' 仅负责人（用户恒可写）| 'owner' 条目级：创建者，或负责人 / 用户
// 读权限恒为项目组全员；标题等文案走渲染层 i18n（`project.module.{id}`）
```

- 渲染层 tab 顺序与灰显读此表；`planned` 灰显并提示「即将推出」。
- 纯函数 `canWriteModule(moduleId, actor)` 与 `canManageEntry(moduleId, actor, createdBy)`（shared）+ 表驱动单测。`wiki` **立即启用** `canManageEntry`，`canWriteModule` 要到看板才有调用方。
- **不预建宿主侧插件接口**（`contextSection` / 工具注册 / 服务生命周期）：wiki 与看板接入后，从真实共性里提炼，而不是先猜形状。

### 10.2 宿主强制与渐进披露（模块约定）

- 写权限在**工具执行处**校验：调用者身份、`identity.conversationId` 属于该项目、调 `canWriteModule` / `canManageEntry`，失败返回结构化错误，不靠提示词劝阻。负责人写工具只在对话轮工具面注册（D75：对话轮是「立即返回、宿主干活」的托管动作），任务面不注册。
- **可见 ≠ 全量注入**：每个模块提供摘要段（计数 + 要紧条目）进项目提示词，细节经只读工具按需取（对照 `<workbench>`）。
- **按写入者标注可信度**：用户写入可信；Bot 写入的，其他 Bot 读取时包 `<untrusted source="project:{moduleId}">`。

### 10.3 下期模块（预研，不在本期）

| 模块 | 现有机制 | 方向 |
|---|---|---|
| 看板 | D90 `todos`（`draft → scheduled → in_progress → delivered → done` 与看板列天然对应）、D75 任务、`dispatchWorkbenchMessage`、交付追踪 | `todos` 增 `project_id` 范围，看板 = 该项目事项的列视图；工作台自然汇总所有项目；指派卡片 = 沟通里一条派发消息。D90「普通 Bot 不能操作事项」放宽为「负责人可操作本项目事项」；成员改自己卡片状态由交付追踪推进，成员本身只读。**前置**：路径作用域写租约设计（§9.2） |
| 日历 | `schedules`（D80）、事项排期；`SchedulesPanel` 已按会话列出成员的定时任务 | 先做**聚合视图**（成员定时任务 + 事项排期 + 里程碑），写入仍走既有入口 |
| OKR | 无 | 新表：目标 / 关键结果 / 负责成员 / 进度，负责人写；KR 可关联看板卡片；进度手填还是由卡片完成度推导待议 |

建议顺序 **看板 → 日历 → OKR**。**项目目标**（`goal`）本期仅用户可编辑；将来「负责人代为维护」属高敏感写（目标注入全员提示词），须套 D89 式闸门，不在本期。

## 11 界面

### 11.1 创建：双轮选择

主区域组群视图沿用现有「To:」成员条（`GroupComposeBar` → `ProjectComposeBar`，`group-compose.ts` → `project-compose.ts`），状态机增 `phase: 'lead' | 'members'`：

```text
第一轮 · 负责人（单选）
┌ To: 负责人 ▸ [ 输入名字筛选…                                  ] ┐
│  ① 研究员   ② 写作助手   ③ 产品经理   …                         │  点选 / Enter = 选定并进入第二轮
└ 输入新名字回车 = 新建一个 Bot 并作为负责人（空画像也能当）          ┘  候选排除管家

第二轮 · 成员（多选）
┌ [👑 研究员 ✕]  成员 ▸ [写作助手 ✕] [ 输入名字筛选…            ] ┐
│  候选（不含负责人、管家）…                                        │  Ctrl/⌘+1~9 选前 9 个
└ 空回车：已选 ≥ 1 位成员即创建；Backspace（输入空、无成员时）退回第一轮；Esc 取消
```

- 负责人芯片固定最前并带标记，点其 ✕ 退回第一轮；成员芯片行为同现状。
- 创建：`projects.create({ leadBotId, memberBotIds: [负责人, …成员] })`；默认名称为「负责人、成员…」拼接（排首位的是负责人），在详情页改。创建时不收集项目目标与目录（保持点选即建），详情页补充。
- **负责人行为由项目上下文注入，不依赖 Profile**，所以新建的空画像 Bot 也能当负责人。

### 11.2 顶栏、tab、成员与设置

项目组会话的顶栏改为**实心块**（不再是浮动渐隐药丸），高度两行；单聊保持原样。macOS 下整块是拖拽区，控件 `no-drag`。

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 项目名称                                                    (👑)(👤)(👤)+2   ⚙ │
│ [沟通 ●]  看板  Wiki  OKR  日历                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **左两行**：第一行项目名；第二行模块 tab，读 `PROJECT_MODULES`；`planned` 灰显、悬停提示「即将推出」、不可点。
- **沟通 tab 徽标** = 未读数 + 待确认标记：用户在 Wiki 等其他 tab 时不会漏掉审批卡（12 的「焦点以外」原则）。
- **右侧**：成员头像**重叠堆叠**（Jira 式，后一个压在前一个上，负责人排第一并带小标记，超过 5 个显示 `+N`）；点击下拉：成员列表（负责人置顶带标）+「添加成员」；右侧的 ⚙ 设置按钮打开项目详情。
- **项目详情**是内容区里的页面：点 ⚙ 把详情显示在内容区，tab 行不新增项、⚙ 呈选中态；再点任一 tab 返回。状态 `shell.projectView: ModuleId | 'settings'`（内存，不持久化），在 `chat.select()` 时重置为 `chat`——与 D90 `mainView` 同一条「收口不变式」，通知 / 搜索 / 卡片跳转自然落到沟通。
- 沟通 tab 的内容 = 现有 `ChatView` 主体（消息列表 + `Composer` + 状态行）；其他 tab 内容区独立滚动、没有输入坞。
- **窄屏**：第一行「返回 + 项目名 + ⚙」，第二行 tab 横向滚动；头像堆叠紧凑保留。

### 11.3 项目详情页：右栏内容迁移

| 原 `GroupInfo` 内容 | 新位置（详情页分区） |
|---|---|
| 头像堆叠 + 改名 | **概览**：名称 |
| （无，DEV-030） | **概览**：项目目标（`projects.update`） |
| `ProjectSelector`（工作目录） | **概览**：工作目录 |
| 成员列表（移除 / 添加 / 点开详情） | **成员**：负责人置顶带标 +「更换负责人」；移出负责人置灰并提示先更换 |
| 成员浏览器「显示」按钮 | **成员**：行内按钮，显隐规则不变 |
| 访问授权列表与「撤销」 | **授权**：保持一步可达，这是安全控制，不能因撤右栏而变深 |
| `SchedulesPanel` / `WatchesPanel` | **定时与监看** |
| 解散群（`GroupSettingsDialog`） | **危险区**：删除项目组，确认框列出 wiki 来源 / 页面数、消息数 |

- `GroupSettingsDialog` 的 `embedded` 模式供设置卡内嵌：把成员编辑拆成独立组件 `ProjectMembersEditor`，详情页与设置卡共用；弹框形态删除。
- 设置目录：`group.title` / `group.members` → `project.title` / `project.members`，深链 `surface: 'group-dialog'` → `'project-detail'`（带分区锚点）；新增 `project.goal`、`project.lead`，`maxMode` 建议 `confirm`（更换负责人改变路由与权力，不宜 `direct`）。

### 11.4 右栏与其他

- `ChatsArea`：项目组会话**不渲染** `RightPanel`；`RightPanel` 只服务单聊，群聊分支与 `GroupInfo.svelte` 删除。`shell.rightPanelCollapsed` 对项目组无意义。
- 窄屏：项目组药丸不再打开 Bot 详情覆盖层；`BotDetailOverlay` 只服务单聊。
- 侧栏：行样式不变（头像堆叠，`GroupAvatarStack` → `ProjectAvatarStack`）；「新建群聊」→「新建项目组」；右键「群设置」→「项目详情」；全局搜索的「群聊」标签同步改文案。

## 12 其他后端变更

### 12.1 提示词与上下文

`<conversation_info>` 项目分支：

```text
对话类型：项目组「{名称}」
项目目标：{goal}                         ← 非空才出现
项目负责人：{名字}（你）｜{名字}
成员名片：
- {名字}（{id}）：{简介}；职责：{…}  [负责人]
项目 wiki：{主题段}                       ← 有内容才出现，不设预算
```

另按调用者身份追加规则：**负责人**（`PROJECT_LEAD_RULES`，写法参照 `BUTLER_RULES`）——未 `@` 的消息由你兜底接收；先理解目标再决定自己答还是 `@` 合适的成员并写清交付物；成员能独立完成的不要自己做；收到成员汇报后向用户汇总；需要用户拍板时直接问；你的权力限于本项目组。**成员**（`PROJECT_MEMBER_RULES`）——负责人是谁；被用户 / 负责人 `@`、被续接、被路由时响应；完成后 `@` 负责人汇报结论与产出位置；归属不清时问负责人；团队需要共享的结论用 `wiki_enqueue scope=project`。提示词按 (Bot, 对话) 在 run 构建时拼装，**不写进 Bot Profile**，也不用 `system_role`。项目 wiki 主题段（`<project_wiki_topics>`，位于 `<wiki_topics>` 之后，**不设预算**）除对话轮外也注入任务与外部智能体会话——任务要读得到团队知识目录。

### 12.2 管家

- `propose_group` → `propose_project`：载荷增 `lead_bot_id`（工具层必填），审批卡显示负责人并允许用户改；候选与成员排除管家。
- `propose_team` → `propose_bots`（批量提议建 Bot，语义不变，保留 `propose_` 前缀因为它是审批卡而非直接创建）。
- D70 开放决策 #8「管家是否加入用户群」收口为：不加入。

### 12.3 工作台

`todos.assignee_group_id` → `assignee_project_id`；`TodoAssignee.group` → `.project`；`leadBotId` 缺省取项目负责人（仍是带 `@` 的显式目标，走 §6.2 第一行）。39 §2.2「群没有负责人角色」改写为「项目的负责人是默认响应者」。

### 12.4 生命周期

| 事件 | 处理 |
|---|---|
| 创建 | `projects.create`：负责人 ∈ `memberBotIds`、active、非管家；成员 ≥ 2（负责人计入） |
| 更换负责人 | `projects.setLead`：新负责人须是成员；沟通里落系统消息「负责人已更换为 X」（Bot 可见）；进行中的轮次不打断 |
| 移出成员 | 负责人**拒绝**：「请先更换负责人」（`projects.removeMember` 与设置卡 `project.members` 同一道校验） |
| 删除 Bot | **拒绝**，若它领导着项目：提示列出项目并给「去更换」入口（同管家不可删的做法）；其余级联不变 |
| 解散项目组 | 随会话级联；另删项目 wiki 目录 / `wiki.db` / `wiki-store`；`episodes` 随会话 FK 级联 |

### 12.5 RPC 变更

`groups.*` → `projects.*`：`create`（入参 `leadBotId`、`goal?`）、`setLead`、`update { title?, goal? }`（补 DEV-030）、`addMembers`、`removeMember`；删除 `groups.setup.*`、`groups.redistribute`、`groups.rename`（并入 `update`）。原目录 RPC `projects.*` → `workdirs.*`。新增 `episodes.resume / stop`、`wiki.addSource / sources / deleteSource`。事件：`conversation.updated` 复用，`group.turn` → `project.turn`（阶段 `triaging` → `routing`），`wiki_changed` 带 owner。

## 13 改名与迁移方案

### 13.1 顺序（T0，行为中性，单独提交并跑一次全量）

改名有依赖，顺序固定：

1. **D75** `workdir` **→** `cwd`（189 处 / 44 文件：`runs.task_workdir`、`resolveWorkdir`、`taskWorkdir`、30 / 08 文档中的措辞）——先腾出 `workdir`。
2. `project`**（目录）→** `workdir`（约 857 处 / 104 文件，含文件名：`core/src/project/`、`domain/projects.ts`、`features/projects/`；RPC `projects.`* → `workdirs.*`；工具 `acquire_project_write` → `acquire_workdir_write`；提示词 `<project>` → `<workdir>`；i18n；`08-project.md` → `08-workdir.md`）——腾出 `project`。
3. `group` **→** `project` **/** `chain` **→** `episode` 属于 T1a 的功能改动，不在纯改名里，因为它们伴随语义变化（`CHECK`、必有负责人、路由重做）。

### 13.2 迁移

- 追加新迁移，不改写历史迁移（编号以开工时目录实况顺延）：runs `0013`（`task_workdir` → `task_cwd`，T0）；main `0038`（`projects` → `workdirs`、`project_id` → `workdir_id`，纯改名，T0）；main `0039`（在 FK 开启下删除无法转换的旧群）；main `0040`（**重建 `conversations`**：`project` 类型、`lead_bot_id`、`goal`、删 `setup_state`、旧群转换；`conversations` 是 12 张子表的父表，须在 **FK 关闭**下重建，所以迁移运行器新增「首行 `-- kepcup:foreign-keys=off` 指令」支持）；main `0041`（`chains` → `episodes`）；runs `0014`（`chain_id / chain_depth` → `episode_id / episode_hop`）；main `0042`（`todos.assignee_group_id` → `assignee_project_id`）；memory `0003`（`memory_items.origin` 的 `'group'` → `'project'`）。逐个迁移的 SQL 与测试见 todo 的对应 WP。
- LLM 可见的文本（工具名、提示词标签、参数名）随改名变化，没有外部兼容负担；mock-LLM 测试与 e2e 夹具同步更新。
- 并行分支会和纯改名冲突：T0 要短周期合并，合并前通知在途分支先 rebase。

## 14 分期与任务拆分

### T0 纯改名（行为中性）

§13.1 的 1、2 两步；`pnpm typecheck` + 定向测试逐步验证，收口跑一次全量。

### T1a 项目组核心

按工作包（WP）实施，每个 WP 是一份可独立交付的任务书（[todo/project/](../../todo/project/README.md)）：

| WP | 内容 |
|---|---|
| WP1 | shared 契约、迁移（含运行器 FK 关闭模式）、`ProjectsService`、生命周期（删 Bot 被负责人身份阻止、移出负责人被拒）、RPC、删除 D60 四问后端；renderer / 测试的编译修复 |
| WP2 | `chain → episode`；任务结算唤醒继承回合；熔断与暂停卡（后端）；`chain → bot_mention` |
| WP3 | `ProjectTurnCoordinator`：续接判断、负责人网关、静默路由、必答回合（摘 `skip_reply`）、兜底不变式；删全员 triage |
| WP4 | 提示词（`<conversation_info>`、负责人 / 成员规则）、管家 `propose_project` / `propose_bots`、工作台 `assignee_project_id`、设置目录 `project.*`、记忆库 origin 迁移、`group` 残留清扫 |
| WP5 | 双轮创建 |
| WP6 | 两行顶栏、模块 tab、重叠头像堆叠、撤右栏、侧栏 |
| WP7 | 项目详情页、成员编辑、设置卡内嵌、深链、删 Bot 阻止 UI |
| WP8 | 文案收尾、协作暂停卡、审批卡、e2e（T1a 收口） |

依赖：WP1 → WP2 → WP3 → WP4；WP5、WP6 → WP7 只依赖 WP1，可与 WP2–WP4 并行；WP8 最后。

### T1b 项目 wiki

WP9（后端：owner 泛化、项目级索引、台账、ACL、维护身份）→ WP10（工具、RPC、提示词、Wiki tab）。独立里程碑，不阻塞 T1a 发布。

### 文档

WP11：设计与开发文档同步（删除各文档顶部的 D92 横幅并把正文改写成现状；已完成）。

### 下期

看板（含路径作用域写租约设计）→ 日历 → OKR。每期固定产出：数据表 + 删除级联、宿主服务与写权限校验、摘要段与读取工具、负责人写工具、视图。

### 非目标

多沟通频道 / 子话题；项目归档、状态与里程碑；跨项目视图（工作台已承担）；负责人建 Bot、跨项目委派、改别的 Bot 设置；worktree / CoW 隔离；多用户 / 云同步；页面的直接手工编辑；Bot 提示词各段预算的全局移除（K15）。

## 15 测试方案

先定向后全量（[AGENTS.md](../../AGENTS.md)）。T0、T1a 都改了 shared 契约与迁移，各自收口跑**一次**全量。

| 层 | 用例 |
|---|---|
| shared | `canWriteModule` / `canManageEntry` 全表；`PROJECT_MODULES` 不变式；`conversationSchema` |
| 迁移 | `conversations` 重建后 `CHECK` 生效（项目无负责人、单聊有负责人均被拒）；旧群转换（取最早非管家成员；无合格成员的删除；D60 残留删除）；`episodes` |
| core 领域 | create / setLead / removeMember / 删 Bot 的各项校验与系统消息；管家被拒 |
| 路由 | 无 `@` 且 P 认领 → 只有 P；P 不认领 → 网关；网关 `self` / `route`（单个、多个、首个必答）/ `none`；网关与续接超时、失败、非法输出 → `self`；兜底不变式（整轮无可见回复 → `lead_fallback` 一次）；`skip_reply` 在必答轮不可用；被路由者不能转手；`forcedTarget` 与显式目标优先；P 窗口、P 即负责人、P 被移出 |
| 协作回合 | 任务结算唤醒的轮次在唤醒时继承回合；熔断触发 / 暂停卡 / 继续 / 停止；pending 重启后保留；无人值守不自动继续 |
| wiki（T1b） | 多成员并发入队串行；执行者付费归因；来源 ACL（自己 / 他人 / 负责人 / 用户）；`wiki_remove_source` + 悬空引用体检；项目 FTS 重建；Bot wiki 与移交不受影响；删除级联 |
| 提示词 | `<conversation_info>` 项目分支；负责人 / 成员规则；`routed` / `lead_fallback` 触发段 |
| 渲染单测 | `project-compose` 状态机；tab 灰显映射；`shell.projectView` 重置 |
| e2e | ①双轮创建（含「输入新名字建负责人」）；②两行顶栏、灰显 tab 不可点、无右栏；③头像堆叠下拉与添加；④⚙ 打开详情页、再点 tab 返回；⑤详情页各分区，**授权撤销一步可达**；⑥无 `@` 消息：只有一位成员回复、界面无负责人痕迹（mock LLM 断言广播 triage 调用数为 0）；⑦P 续接；⑧负责人兜底；⑨熔断卡；⑩wiki 添加 / 删除来源与权限；⑪窄屏 |
| 回归 | 既有 `group-chat` / `group-compose` / `workbench` / `setting-card` / `memory` / `browser` / `handover` 的群相关用例；D90 派发；单聊不受影响 |

## 16 对现有文档与代码的影响（定稿时同步）

| 文档 | 改动 |
|---|---|
| [01](01-conversation.md) | 「群聊」整节改为项目组 / 沟通；成员变动补负责人规则 |
| [02](02-execution.md#群聊响应) | 「群聊响应」整节重写（路由）；「Bot 之间的触发」改为协作回合与熔断；D5 修订 |
| [05](05-wiki-and-skills.md) | D9 修订；项目 wiki 小节 |
| [08](08-workdir.md) → `08-workdir.md` | 改名与措辞；新成员加入提示；目录入口改到项目详情 |
| [12](12-ui-layout.md) | 布局：项目组无右栏、两行顶栏 / tab、双轮创建、详情页；删 `GroupInfo` 描述 |
| [13](13-permissions.md)、[30](30-supervisor-and-tasks.md) | `project` → `workdir`、`workdir` → `cwd` 措辞；30 的连锁与群轮次小节 |
| [19](19-work-path-and-group-setup.md) | D60 残留删除；创建说明改写（可能并入 41 后删除） |
| [27](27-butler-and-delegation.md) | `propose_*` 改名与载荷；开放决策 #8；§3.3 同群降级 D4 的措辞 |
| [36](36-wiki-multimodal-ingest.md) | 台账结构对齐；`wiki.deleteAsset` 首次实现；owner 泛化 |
| [38](38-conversational-settings.md) | 目录 `project.*` 与深链 |
| [39](39-workbench.md) | §2.2 与 `assignee_project_id`；看板关系 |
| README | 索引行；定稿后加 D92 |
| dev/03-data-model | `conversations`、`workdirs`、`episodes`、wiki 台账；删除级联表 |
| dev/DEVIATIONS | DEV-030 记决定 |
| todo/ | 定稿后新建 `project.md` 作执行编排 |

## 17 风险与取舍

1. **改名规模与并行分支冲突**：约 1000 处跨百余文件。对策：T0 行为中性、顺序固定、短周期合并；`group` 的语义改名不混进 T0。
2. `conversations` **是枢纽表**：重建要小心 FK 与索引；按 0018 / 0037 的写法并加迁移测试。
3. **路由质量依赖轻量模型**：误路由、续接判断过于自信。对策：P 认领要过置信度阈值；任何失败按 `self`；兜底不变式；用户随时可 `@` 纠正；执行记录里留 `reason` 便于调参。
4. **负责人单点**：未 `@` 且 P 不认领的消息都进网关，网关是轻量调用，完整轮只在 `self` 时发生；成本与上下文由所用模型自己的窗口决定，不另设上限。
5. **熔断阈值**：12 / 8（成对约 4 个来回），目标是正常协作碰不到；e2e 与集成用测试缝压低验证，实测调参仍待线上数据。
6. **项目内自动化的提示注入**：成员读恶意内容 → 汇报污染负责人 / 写入 wiki 来源污染其他成员。缓解：静默路由不携带 Bot 写的内容；Bot 写入的 wiki 来源与页面读取时标 `<untrusted>`；权力半径限定项目内、审批 / 沙箱闸门不豁免；熔断拦失控往返。这是缓解不是消除。
7. **静默路由对用户不透明**：用户看不到谁把消息转给了成员。对策：执行记录里可审计；若将来需要，可加一个默认关闭的「显示由负责人转交」设置。
8. **项目 wiki 的三处险点**（§8.8）：FTS 与存储布局、执行者付费与单写入者队列的归因 / 预算、来源 ACL 与删除的并发正确性；另有排队 job 不应占满全局槽位。
9. **写入租约串行**：本期低压力，下期看板会放大；已规划路径作用域写租约（§9.2）。
10. **新成员静默获得目录读写**：靠 §9.1 的系统消息补；加入前确认暂不做（K10）。
11. **全局上下文预算未纳入**：Bot 提示词各段预算的移除需要「按模型窗口压缩」，是整个上下文装配的改造，单独评估（K15）。

## 18 可调的默认项

关键决策已全部确认（§1.2 的 K1–K18）。以下是按推荐默认推进、实施中可改口的项：

以上默认项均已按原样实施（2026-10-18），校正与落地口径：

| # | 默认 → 实施结果 |
|---|---|
| 1 | 窗口 30 分钟、轻量模型照实施；阈值落为 `ROUTING_CONTINUATION_MIN_CONFIDENCE` 0.6、熔断 12 / 8（§17.5 勘误） |
| 2 | `wiki_enqueue` 默认 `scope=mine`、`wiki_search` 项目组里默认 `all`（结果带 `[project]` / `[mine]` 前缀） |
| 3 | 「执行者付费」照实施；`enqueueIngest` 保留 `botId` 为执行者字段（WP9） |
| 4 | 照实施（`PROJECT_MODULES.status='planned'` 灰显 + `ModulePlaceholder`） |
| 5 | 照实施（`shell.projectView` 内存态，`chat.select()` 重置） |
| 6 | 照实施；**DEV-030 已落实**：项目目标在详情页「概览」编辑（`projects.update`） |
| 7 | 注册表 `write:'lead'` 照录（模块下期） |
| 8 | 照实施（系统卡 + `episodes.resume/stop`，无人值守不自动继续） |

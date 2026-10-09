# 定时任务的自然引导：实施方案

> 状态：**已定稿，实施中**（2026-10-09；用户拍板：①入门时的例行事项默认挂到对应领域 Bot，只在跨领域或用户明确要求时才提议专门的例行 Bot；②做定时提议卡）。
> 决策编号暂记 **D80**（D77–D79 已被 borrowings 方案占用；合入前以 `docs/design/README.md` 实况为准）。
> 分支 / worktree：`t/schedule-nudges` @ `/home/jyy/wt/kepcup-sched`（主工作树有其他会话的未提交改动，不在主树里做）。
> **测试纪律**：开发中只跑定向测试（`node scripts/run-tests.mjs run <文件>`，在 `kepcup-test:trixie` 容器里跑）；改了 `packages/shared` 契约与迁移，收尾时全量跑一次。

## 1. 目标

用户在沟通中自然地知道、并用上定时任务，**不做功能教育**：

- 管家入门访谈问到"平时常做的事"时顺带问出周期性的事项；组队提议里把它们作为对应 Bot 的「例行事项」，用户确认即建好。
- 普通 Bot 的初始化访谈里，用户描述的职责有周期性时问一次要不要按点主动做。
- 日常对话中，用户说要延后、同类请求反复出现、事情有截止时间时，Bot 用一张**定时提议卡**给出具体时间，一键设置或拒绝。
- 建好的定时任务在聊天里**看得见**（回执卡、触发消息上的来源标签），能就地取消。

原则：只在用户的话里有信号时提；给具体动作不讲功能；一件事只问一次；拒绝后宿主确定性地收敛（7 天内同一对话拒绝 2 次即不再允许提议）。

## 2. 现状（2026-10-09 读取，以代码为准）

| 位置 | 现状 | 问题 |
|---|---|---|
| `tools/schedule-tools.ts` | `schedule` / `list_schedules` / `cancel_schedule`，只能建到当前对话；对话轮与任务都注入（`tools/index.ts`） | 返回只有 ISO 时间与 cron 原文；没有给用户看的名字 |
| `agent/context/system-prompt.ts` | `TURN_PLATFORM_RULES` 未提定时；`HOST_POLICY_LINES` 只有"用什么工具" | 没有"什么时候该提议" |
| 管家访谈 `BUTLER_INTERVIEW_GUIDANCE`、`propose_team` / `propose_bot` | 无周期事项维度与字段 | 管家只能给自己所在的对话建任务，访谈问出的周期事项落不到新 Bot 上 |
| `dispatch/butler.ts #createBots` | 建 Bot + 开私聊 | 无例行事项落库 |
| `schedule/service.ts` | 承诺（带截止时间）经事件总线静默建一次性任务 | 用户不知道 |
| `orchestrator.deliverScheduleToBot` | 触发消息 internal，回复消息无来源 | 用户分不清哪条来自定时任务 |
| 右栏 / 设置页 `SchedulesPanel.svelte` | cron 原文显示；无实时事件 | 看不懂、不刷新 |
| `<my_state>` | 只含承诺 | Bot 不知道本对话已有哪些定时任务，会重复问 |

## 3. 设计

### 3.1 数据（迁移 `0022_schedule_title_origin.sql`）

`schedules` 加两列：

- `title TEXT NOT NULL DEFAULT ''`：给用户看的短名（"工作日早报"）；`note` 仍是到点时给 Bot 的指令。空 title 的展示回退到 note 截断。
- `origin TEXT NOT NULL DEFAULT 'tool' CHECK (origin IN ('tool','offer','proposal','commitment'))`：`tool` = Bot 直接调 `schedule`；`offer` = 用户在提议卡上点了设置；`proposal` = 管家组队 / 建 Bot 提议里的例行事项；`commitment` = 承诺联动。存量带 `commitment_id` 的行回填 `commitment`。

> 2026-10-09 D73 负责会话 kepcup-92 确认：D73 不再预留迁移号（写迁移时取下一个空号），本方案占 main `0022`。

### 3.2 时间的人话描述（`packages/shared/src/schedule-describe.ts`）

`describeScheduleWhen({kind, cron, runAt, timezone}, now?)`：常见 5 段 cron → "每天 09:00" / "每个工作日 09:00" / "每周一、三 18:30" / "周末 10:00" / "每月 1 日 09:00" / "每 2 小时" / "每 15 分钟"；不认识的回退 `cron「…」`。一次性 → "10月10日（周六）09:00"，跨年带年份。时区与用户本地时区不同时追加时区名。core（工具返回、上下文、管家通知）与 renderer（卡片、面板）共用。

### 3.3 可见性

- **回执卡**（system_event `schedule_created`，对话共享、用户可见）：`createOnce` / `createCron` 成功后由 `ScheduleService` 统一写入（`origin='offer'` 除外——提议卡自身转为已设置态，不重复出卡）。内容快照 `schedule: {id, title, note, kind, runAt, cron, timezone, origin, status}`；卡片显示 ⏰ 标题 · 人话时间 · 下次触发，按钮【取消】（两步确认）/【全部定时任务】（打开右栏定时任务标签）。任务取消 / 一次性任务完成时 `json_set` 回写 `status` 并推 `message.updated`。卡片 `text` 同步为一句人话（Bot 上下文据此看到状态）。
- **触发消息来源标签**：`trigger_reason='scheduled'` 的对话轮发出的文本消息带 `scheduleId` / `scheduleTitle`（快照），气泡下方显示"⏰ 工作日早报"，点击打开右栏定时任务标签。
- **面板**：标题 + 人话时间；新增 RPC 事件 `schedules.changed {conversationId}`，创建 / 取消 / 完成时推送，面板实时刷新。
- **承诺联动**：照旧建任务（`origin='commitment'`，title 取承诺内容截断），因此同样出回执卡（"记下了：10月12日提醒你……"）。

### 3.4 上下文 `<schedules>`

对话轮与任务的 system prompt 新增 `<schedules>` 段：本 Bot 在本对话的有效定时任务，最多 8 行（`- [sch_x] 工作日早报：每个工作日 09:00`），note 来自模型 / 用户，整体包 `untrustedBlock`。另附一行"本对话 7 天内用户拒绝过的定时提议 N 次"（N>0 时）。

### 3.5 工具

- `schedule`：新增可选 `title`（建议必填，描述里说明它展示给用户）；`when` 解析下沉为 `ScheduleService.createFromWhen`（工具、提议卡、管家共用）。返回附人话时间与**护栏提示**：该 Bot 关闭了主动消息 / 首次触发落在免打扰时段（会推迟到免打扰结束）。
- `offer_schedule`（**仅对话轮**，D75：面向用户的卡片属于对话轮）：参数 `when` / `timezone?` / `title` / `note` / `question`（卡片上的一句话，如"要我明早 9 点提醒你整理周报吗？"）。宿主校验：时间可解析且在未来；本对话 7 天内该 Bot 的提议被拒绝 ≥ `SCHEDULE_OFFER_DECLINE_MAX`（2）次 → 拒绝并告诉模型"除非用户主动要求，不要再提议"；同 title 的有效任务已存在 → 拒绝；本 Bot 在本对话的旧待定提议标为 `superseded`。写 system_event `schedule_offer`（`offer: {title, note, when, timezone, question, status:'pending'|'accepted'|'declined'|'superseded'|'expired', scheduleId?}`）。返回"提议卡已展示，不要再用文字重复问；用户点了之后卡片会显示结果"。
- 卡片动作 RPC：`schedules.acceptOffer {messageId}` → 宿主确定性创建（`origin='offer'`），卡片转"已设置"；时间已过 → 卡片 `expired` 并报错。`schedules.declineOffer {messageId}` → `declined`。两者都**不唤醒** Bot（避免多花一轮），卡片 `text` 回写结果，Bot 下一轮从时间线看到。用户想换时间就直接回复，Bot 再出一张（旧卡 superseded）或直接 `schedule`。

### 3.6 提示词

- `TURN_PLATFORM_RULES` 新增一条（措辞见代码）：三类信号（延后 / 同类第二次或"每天每周" / 有截止时间）→ 用 `offer_schedule` 给具体时间；用户明确要求提醒时直接 `schedule`；一件事只提一次、拒绝或没接话不再提、`<schedules>` 已有的不重复、一轮最多一件、不介绍功能本身、群聊只在用户直接找你时提。
- `PLATFORM_RULES`（任务）：任务中发现截止时间或需要跟进的事，写进结果，由对话轮决定是否提议。
- 普通 Bot 初始化访谈：问题规划加"职责里有没有固定周期的事"；用户提到周期时用 `ask_question` 问一次（就这个时间 / 换个时间 / 先不用），同意则在 `finish_setup` 前用 `schedule` 建好并在总结里提一句；没提周期就不问。
- 管家访谈：问"最常做的几类任务"时候选答案里带有周期的选项；用户提到周期事项时可追问时间；`propose_team` 里把它们放进对应 Bot 的 `routines`。只有在例行事项跨领域或用户明确要一个地方收所有定时推送时，才提议专门的例行 Bot。
- `BUTLER_RULES`：`propose_bot` 同样可带 `routines`。

### 3.7 管家提议的例行事项

- `butlerProposedBotSchema` 加 `routines: [{title, when, timezone?, note}]`（每 Bot ≤ 3 条，默认 `[]`）；工具参数同构，提交时用 `ScheduleService.validateWhen` 预校验（不合法直接退回给模型）。
- 审批决定加 `routineSelection?: string[]`（`"{botIndex}:{routineIndex}"`，缺省 = 被选中 Bot 的全部例行事项）。`approvals.decide` 输入同步。
- 卡片：每个 Bot 下列出"例行：每个工作日 09:00 · 工作日早报"，带勾选框；取消勾选 Bot 时其例行事项一并灰掉。
- `#createBots`：建 Bot、开私聊后按选择 `createFromWhen({origin:'proposal'})` 建到**新 Bot 的私聊**，回执卡出现在新 Bot 私聊里；失败只记日志并在通知里列出，不影响建 Bot。给管家的结果通知带"已为 X 设置例行事项：…"。

## 4. 实施顺序与清单

### P0 提示词与上下文
- [x] `system-prompt.ts`：turn 规则、任务规则、两种访谈指引、管家规则、`<schedules>` 段（输入 `schedules?: string`）
- [x] orchestrator 组装 `<schedules>`（`ScheduleToolFacade` 加 `contextSection(botId, conversationId)`）
- [x] `schedule` 工具：`title`、人话时间、护栏提示

### P1 可见性与数据
- [x] 迁移 + `scheduleSchema` 加 `title` / `origin` + store
- [x] `packages/shared/src/schedule-describe.ts` + 单测
- [x] 回执卡写入 / 状态回写；`schedules.changed` 事件
- [x] 触发轮消息 `scheduleId` / `scheduleTitle`
- [x] renderer：`features/schedules/ScheduleCard.svelte` + `ScheduleReceipt.svelte`（回执卡与提议卡共用一个分派组件）、气泡来源标签、`SchedulesPanel` 人话化与实时刷新、i18n
- [x] 管家 `routines`：schema、工具参数、`routineSelection`、`#createBots` 落库、`ApprovalCard` 展示与勾选

### P2 提议卡
- [x] `offer_schedule` 工具（仅对话轮）+ 宿主校验 + 拒绝计数
- [x] RPC `schedules.acceptOffer` / `schedules.declineOffer`
- [x] renderer：提议卡（同上 `ScheduleCard.svelte`）

### 收尾
- [x] 文档回写：`docs/design/02-execution.md` 主动消息节、`docs/design/27-butler-and-delegation.md`（例行事项）、`docs/dev/03-data-model.md`（schedules 两列）、`docs/dev/04-agent-runtime.md` 工具目录（`offer_schedule`）、`docs/design/README.md` 决策表 D80
- [x] 独立审查一轮 + 修复
- [x] 全量测试一次（基线 28 个容器环境失败）

## 5. 测试

- shared：`schedule-describe.test.ts`（常见 cron、回退、一次性跨年、异地时区）
- core 单元：`schedule-tools.test.ts`（title、护栏提示、`offer_schedule` 校验 / 拒绝上限 / supersede）、`schedule-service.test.ts`（origin、回执卡、取消回写、accept / decline / expired）、迁移测试（回填 commitment）、`system-prompt` 段落、管家 `#createBots` 带例行事项与 `routineSelection`
- 手工对话脚本（P0 上线后观察）：延后、重复请求、截止时间、明确拒绝后再提、群聊、闲聊不触发
- 度量（日志即可，不建表）：按 `origin` 统计创建数；7 天内取消比例；提议卡接受 / 拒绝比例

## 6. 本期不做

- 提议卡上的"换个时间"表单（用户直接回复即可）
- 等待外部变化类需求（"发货了告诉我"）——归 borrowings 的 watch；在它上线前 Bot 可提议"每天查一次"
- 用户全局的"不要再向我提议定时任务"开关（先看拒绝上限够不够）

## 7. 实施记录

### 2026-10-09（kepcup-29 续会话，分支 `t/schedule-nudges`）

- P0–P2 与文档回写完成。实现细化：
  - `when` 的 ISO / cron 判别从工具下沉到 `ScheduleService.validateWhen` / `createFromWhen`（`schedule/when.ts`），工具、提议卡、管家例行事项共用；BR-P10-001 用例随之移到 `schedule-nudges.test.ts`。
  - 状态变化统一走 `#setStatus` / `#syncCards`：取消（RPC / 工具 / 承诺作废 / 移出群）、一次性任务完成、目标消失都会回写回执卡与已接受提议卡上的 `schedule.status`，并推 `message.updated` 与 `schedules.changed`；store 的批量取消改为 `returning *`。删除 Bot / 对话时卡片随消息删除或保留旧态（Bot 删除后卡上的取消按钮报不存在，可接受）。
  - 「⏰ 标题」来源标签打在定时触发对话轮的终回复上，以及 `task` 轮里转述「由定时触发轮派出的任务」结果的终回复上（经任务 run 的 `origin_run_id` → 该轮 `trigger_parts`）；`forward_task_result` 原文转发与任务中间进度不打标签。
  - 提议卡与回执卡都是 system_event（content JSON 带 `offer` / `schedule`），不新增审批 kind、不重建 approvals 表；拒绝退避按消息 JSON 计数。
  - 迁移号：kepcup-92 确认 D73 不再预留，本方案占 main `0022`。
- 同一会话曾有两个实例同时写本 worktree（额度中断后恢复的副本与原实例）；原实例已撤回与本实例冲突的两处改动并退出，只留两处注释（迁移号说明）。
- 独立审查（opus，只读）7 条发现全部修复：同名提议去重（直接 `schedule` 同名任务取代待定提议，旧卡被点指向已有任务）、Bot 移出 / 删除及任何创建失败时提议转 expired（界面上过时的一次性提议直接显示过期）、回执 / 提议卡文字进上下文包 `<untrusted>`（标题来自模型输出与承诺内容）、定时轮的 `send_message` 也打来源标签且批次含用户消息时不打、`routineSelection` 键规范化、新卡片推 `conversation.updated`、`offer_schedule` 副作用记 `local`。
- 验证：全量 2078 例，失败 = 28 个容器环境基线（沙箱自检 / 工具链 / 技能 git / wiki-url / workspace-tools）+ 6 个写死迁移版本列表的旧迁移测试（已补 22 并复跑通过）；e2e `schedules.spec.ts` 3/3（含新增提议卡用例与「⏰ 标题」断言）；core / desktop typecheck 与改动文件 eslint 干净。


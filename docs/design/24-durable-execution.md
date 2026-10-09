# 24 长任务可恢复执行（Host Durable Journal）

长任务（调研、改代码、批处理）可能跨进程生命周期。崩溃或退出后若只能「标中断、不续跑」，用户会丢进度，并可能把已经发生的副作用再做一遍。本文规定：**在宿主 harness 内自建 Durable Journal**，按工具重放策略安全恢复；**不**把实验包 Pi Durable 定为全体 Bot Runtime。

Journal 与 resume 落在 KepCup 自有 `runs` / `run_steps` 与工具网关之上，由 Orchestrator 执行；`PiEngine` 仍只跑 LLM loop。语义参考 Pi Durable 的 effect sandwich、`replay`、`requestId` 与 memo，不整包替换引擎。

相关：D2（soft steer，[02-execution.md](02-execution.md)）、D21（pi 封装在 `AgentEngine` 之后，[09-tech-stack.md](09-tech-stack.md)）、D30（Project 检查点，[08-project.md](08-project.md)）、D48（消息可见性）、D54（中间过程投送）、D56（Loop 续接）、D65/D66（MCP / SubAgent）。

## 决策

> **D75 修订**：durable / ephemeral 的分级对象由「响应 run」改为「**任务**」——对话轮一律 ephemeral（秒级，崩溃即中断、不恢复），需要 journal 与工具 replay 的本来就是长任务。D67 尚未实现：目前任务也一律 ephemeral，崩溃后按 D75 的启动修复补成 `interrupted` 并写失败条目，唤醒对话轮告诉用户（[02 崩溃与恢复](02-execution.md#崩溃与恢复)）。下文「续跑中的新消息仍走 D2 soft steer（`<new_messages>`）」随 D2 修订而变：新消息进入下一个对话轮，由 Bot 用 `inject_task` 转给任务（注入格式为 `<task_inject>`）。见 [30 §7.4](30-supervisor-and-tasks.md#74-崩溃与恢复d49d67)。
>
> **D78（D67 第一步，已实现）**：外部副作用台账 `tool_effects`——只记账、不续跑，回答「中断时哪些外部动作可能已经发生」，并支撑中断任务的「检查后重试」。见 §10。journal、工具 `replay` 声明与 durable resume 仍未实现。

- **D67 长任务崩溃恢复**：Host Durable Journal。run 分两级——**ephemeral**（默认；崩溃仍走 `orchestrator.recoverInterrupted`，标 `interrupted`、对话提示、取消未决审批，**不**自动继续，即 D49，适用范围收窄到这一级）与 **durable**（长任务；启动扫描后按 journal + 工具 `replay` 策略 resume）。不把 `@earendil-works/pi-durable` 定为全体 Bot Runtime。续跑中的新消息仍走 D2 soft steer（`<new_messages>`）。群聊不因崩溃重跑整轮 triage，只恢复已升为 durable 的成员 run。

## 1 与 D49 的关系

| | D49（保留，仅 ephemeral） | D67（新增） |
|---|---|---|
| 适用 run | **Ephemeral**（默认） | **Durable** |
| 崩溃后 | `orchestrator.recoverInterrupted` 标 `interrupted`，对话提示，**不**自动继续 | 启动扫描后按 Journal **resume**（或用户点「继续」） |
| 目标 | 短聊、无副作用或极短 turn | 长任务、已有工具副作用、未结案 SubAgent |

D49 不再解读为「一切 run 永不恢复」，而改为「默认 ephemeral 不恢复；durable 按本文恢复」。

## 2 非目标

- 不采用 `@earendil-works/pi-durable` 作为全体 Bot Runtime。群聊、chat 与 transcript 分离、加密 SQLite（D24/D25，[11-storage.md](11-storage.md)）、沙箱审批仍由宿主负责。
- 不改为 Grok 式 hard supersede。续跑中的新消息仍走 D2 soft steer。
- 不保证「每个副作用只执行一次」的魔法 exactly-once。只保证 **有记录、能续、副作用策略显式**（at-least-once，加上 idempotency，或 unsafe 中断后交给模型）。
- 群聊不因崩溃自动重跑整轮 triage。仅恢复已判定为 durable 的成员 run。
- 不为对齐 Pi Durable 示例而做：transcript fork、热替换扩展、多端 late-join、Child Task Graph、专用任务归属树面板（与 [23-mcp-and-subagent.md](23-mcp-and-subagent.md)「非目标」一致）。

## 3 Run 分级

### Ephemeral（默认）

- 普通闲聊、纯问答、无工具或极少工具的短 turn。
- 崩溃行为同现行 D49：`orchestrator.recoverInterrupted` 把活动 run 标 `interrupted`，在对话插入系统提示，并取消未决审批。

### Durable

满足任一条件即可（实现常量可调）：

1. 用户或 Bot 显式将本任务标为长任务 / `durable`；或
2. 已产生工具调用且超过阈值（如工具次数、已运行时长）；或
3. 存在未 settle 的非 `safe` 工具，或未完成的 `delegate_task` 子 run（含后台与 fan-out 各路）。

群聊默认 ephemeral。仅被唤醒且已升为 durable 的该成员 run 可续。

### 用户控制

- 系统消息说明「已从断点继续」，或「写操作曾中断，Bot 正在确认」。
- 提供 **继续** / **放弃**。放弃则 run 进入 `cancelled`，释放 project 写租约（D29/D30），不再 resume。
- 可选产品策略：durable 首次恢复需用户点「继续」（更稳），或启动时静默 resume（更顺）。首期建议：**自动 resume，对话内可放弃**。

## 4 Journal 模型（在现有 runs 上收紧）

沿用 `runs` + `run_steps`（及必要的 `effects` 表），不另起一套执行记录。今日 `run_steps.type` 仍是 `request | assistant | tool_call | tool_result | steer | progress | system`；journal 在其上收紧 generation / tool / subagent 的生命周期，语义对齐 effect sandwich：

```text
run (ephemeral | durable)
  └─ steps[]  seq 单调、append-only
       generation : opened → streaming(checkpoint) → settled
       tool       : opened(intent, args, effect_id, replay) → running → settled(result | interrupted | error)
       subagent   : child_run_id + ownership（与 D66 对齐）
```

规则：

1. **先提交再展示**。可展示状态（聊天消息、run 面板、流式可见文本）只来自已提交 journal。流式文本可按短间隔（如 ~100ms）刷 checkpoint，崩溃最多丢未提交尾巴。
2. **原子性**。step 状态变更与关联的可展示内容尽量同事务写入加密 SQLite（D24/D25）。
3. **重启算法**（仅 durable；ephemeral 仍整批走 `recoverInterrupted`）：
   - 找到仍处于活动态的 durable run。活动态即今日会被标中断的那些：`queued` / `running` / `waiting_approval` / `waiting_lease`。
   - 未完成且 `replay=safe` 的工具 → 重新执行并 settle。
   - `replay=idempotent` → 查 `effects`：有 receipt 则直接返回旧结果，无则执行并 upsert。
   - `replay=unsafe`（或未声明）→ **不**重跑；写入 interrupted 工具结果（附已提交 partial），再 continue 一轮模型，由模型决定是否确认或改换做法。
   - 卡在 generation 半截流式 → 已提交文本标 aborted，再 continue，或请用户确认。
   - 未决审批：取消原卡片（与今日 `recoverInterrupted` 把 pending 审批改为 `cancelled` 一致），run 进入 `awaiting_user`「是否继续」，保留 journal，不整段丢弃上下文。`awaiting_user` 是 durable 恢复引入的等待态，不同于工具审批挂起的 `waiting_approval`。
4. **requestId**。用户 flush、mailbox deliver、handoff 使用稳定 requestId。相同 id 重试不双开 run。

## 5 工具重放契约（网关必填）

每个宿主工具（含 MCP 包装工具，D65）声明 `replay`：

| `replay` | 含义 | 示例 |
|---|---|---|
| `safe` | 崩溃后可自动重跑 | `read` / `grep` / `web_fetch` / 只读搜索 |
| `idempotent` | 必须提供 `effect_id`；先查 receipt | `send_message`、部分 MCP 写、可幂等 upsert |
| `unsafe` | 不自动重跑；interrupted + partial 交模型 | `bash` 写操作、一次性外部 API、未声明工具 |

`effects` 表：`(effect_id PRIMARY KEY, run_id, tool_name, result_json, created_at)`。

Project 写入继续配合 D30 影子 git。tool settle 记录 before/after oid，恢复时模型可见「磁盘可能已改」。

## 6 与现有子系统的边界

| 子系统 | 关系 |
|---|---|
| `PiEngine` / pi-agent-core | 仍跑 LLM loop。journal 与 resume 在宿主 Orchestrator 与工具网关，不替换 `AgentEngine` |
| Pi Durable 包 | **不**作默认 Runtime。允许日后单 Bot 超长编码车道做对比 spike，藏在 `AgentEngine` 之后 |
| Soft steer（D2） | resume 后的 run 仍接受 `<new_messages>` |
| 群聊 | 不重跑 triage。只 resume 已有 durable 成员 run |
| SubAgent（D66） | 前台 / 后台 / fan-out 子 run 共用同一 journal。前台：父 abort 级联；后台：结束主 turn 不级联，显式取消或对话关闭才 abort。父 resume 先收束或恢复未完成子 run（含并行多路） |
| Loop 续接（D56） | 针对**新触发**回放旧 run 的过程。本文针对**同一 run** 崩溃后续跑。二者正交 |
| 聊天可见性（D48/D54） | 恢复逻辑不往聊天刷 journal。只发系统提示，以及 Bot 对用户的发言 |

## 7 UI

- 对话：短系统提示；可选「继续 / 放弃」。
- Run 详情：展示 journal 步骤、interrupted 工具、effect receipt（调试用）。
- 前端不实现恢复算法，只订阅已提交状态（对齐 Durable 的「UI 零恢复逻辑」）。

## 8 验收（杀进程）

1. kill 在只读工具中途 → 重启后该工具重跑完成；聊天无双份最终回复。
2. kill 在写文件或命令中途 → 不静默重做；模型看到 interrupted 与 partial。
3. 同一 requestId 重试 deliver → 不第二次开 run。
4. 续跑中用户再发消息 → soft steer 仍生效。
5. 用户放弃 → 写租约释放，启动不再 resume 该 run。
6. 未完成的 `delegate_task`（含后台与 fan-out 多路）→ 父 resume 后，各子 run 按同一策略恢复，或中止并回报；后台子 run 完成后仍可 follow-up 注入。

## 9 实现分期（文档级）

1. 常量与 schema：`durable` 标记、`effects` 表、工具 `replay` 元数据。（`effects` 表的一部分已由 §10 的 `tool_effects` 台账（D78）落地：只记外部副作用、不支撑续跑。）
2. 拆分启动恢复：`finalizeEphemeral`（今日 `orchestrator.recoverInterrupted` 的 ephemeral 路径）与 `resumeDurable`。
3. 网关三类 replay，以及 `send_message` 的 idempotent。
4. 杀进程集成测试，再接 SubAgent 级联（含后台与 fan-out）。
5. Pi Durable 单车道对比 spike：**不做**（与 D67「不定为 Runtime」一致；需要时另开评估，不写入本分期）。

## 10 第一步：外部副作用台账（D78，已实现）

D67 的 tool 生命周期 `opened → running → settled` 先落一个最小子集：只给**有外部副作用**的工具调用记「执行前写、结束后结」的一行，不续跑。D67 落地时并入 journal / receipt。

### 10.1 副作用类别

`agent/effects/classify.ts` `effectClassOf`，与 §5 的 replay 类对齐：

| 类别 | 含义 | 例 | 台账 |
|---|---|---|---|
| `none` | 只读、重做安全（≈ `safe`） | read / grep、`web_*`、`browser_snapshot` / `screenshot` / `open` / `scroll` / `back`、只读 MCP | 不记 |
| `local` | 只改本机或应用内状态，可撤销 / 可重做 | write / edit、记忆、定时、普通 `send_message`、任务管理、**沙箱内的 `bash`**、媒体生成、`delegate_task` | 不记 |
| `external` | 离开本机或不可撤销（≈ `unsafe`） | `browser_click` / `type` / `press`、写入 / 破坏性 MCP（按调用时风险档，取更严一档）、`git_remote`、`request_unsandboxed` 与确认模式下批准后在沙箱外执行的命令、`delegate_to_bot`、带 `mention_bot_ids` 的 `send_message` | 记 |

- 全部内置工具名逐个登记（单测扫描工具源码断言无遗漏），**未登记的工具名一律按 `external`**（只多记一行）。外部智能体宿主桥上的工具同样经此记录。
- 沙箱内执行的命令（含联网命令）按 `local`、不进台账——逐条记录会让几乎每个编程任务都要求「检查后重试」。检查面板与 `<effects_before_interrupt>` 都写明「沙箱内执行的命令不在此清单中」。

### 10.2 表与状态

runs.db `0009_tool_effects.sql`（字段见 [dev/03-data-model.md](../dev/03-data-model.md#tool_effectsd78runs-0009)）：一次调用一行，`run_id` 外键随 run 清理；`summary` 是脱敏后（参数脱敏表 + `secrets.redact`，`browser_type.text` 一律不入）≤200 字的「做了什么」；`effect_key = runId:tool:sha256(规范化脱敏参数)[:16]:occurrence`；`approval_id` 关联本次调用最近一次审批（跨库，无外键）。

| 状态 | 何时 |
|---|---|
| `executing` | 执行前写入（确认模式下批准的 `bash` 命令只在网关决定沙箱外执行时经 `escalate` 才写；`request_unsandboxed` 本身归 `external`，审批前就写，被拒则结为 `denied`） |
| `completed` | 工具返回 `ok:true` |
| `failed` | 其它失败，含 `not_started`；但 run 已被中止时的失败记 `uncertain` |
| `uncertain` | 工具报告结果不确定（浏览器 `BROWSER_OUTCOME_UNKNOWN`、MCP 调用传输失败）、工具抛异常、中断时仍在执行 |
| `denied` | 审批被拒，或中断时其审批被取消 |
| `intended` | 预留（D78 未使用） |

- `settle` 只改 `executing` / `uncertain` 行：恢复改成 `uncertain` 之后真实结果仍可落定。记录器出错只记日志，不影响工具结果。
- 台账结为 `uncertain` 而工具没给出结局时，宿主给工具结果补 `outcome:'uncertain'` 写入执行记录，续接摘要不依赖台账也能标注。

### 10.3 恢复、读取与使用

- **启动恢复第 0 步**：`orchestrator.recoverInterrupted` 在修复任务之前执行一条 `UPDATE … SET status='uncertain' WHERE status='executing'`（幂等）——启动时没有活着的 run，同时覆盖任务、对话轮、子代理与外部智能体的 run，且先于任务失败摘要的生成。撤销授权中断任务时对该任务及其子 run 做同样的事（先把被取消审批的行结为 `denied`）。
- **读取**：`effects.list({ taskId })` 沿 `continued_from_run_ids` 向前收集整条重试 / 接续链及各 run 的子代理子 run，按时间排序（给任务卡的检查面板用）。
- **使用**：续接摘要与任务失败摘要把未返回结果或结果不确定的外部调用标「[结果未知]」；`interrupted` 任务的重试闸门与接续任务的 `<effects_before_interrupt>` 段见 [30 §7.4](30-supervisor-and-tasks.md#74-崩溃与恢复d49d67)。

### 10.4 未实现

- 审批幂等（同一外部动作已完成 / 已拒绝时不再弹卡）与审批卡上的执行回执——原计划同属 D78，暂缓；`ToolResult.effect.receipt` 已留口，但目前没有工具填写，`receipt_json` 恒为空。
- 本节之外的 D67 全部内容：journal、工具 `replay` 声明、durable 分级与 resume。

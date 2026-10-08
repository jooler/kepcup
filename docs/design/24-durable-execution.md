# 24 长任务可恢复执行（Host Durable Journal）

长任务（调研、改代码、批处理）可能跨进程生命周期。崩溃或退出后若只能「标中断、不续跑」，用户会丢进度，并可能把已经发生的副作用再做一遍。本文规定：**在宿主 harness 内自建 Durable Journal**，按工具重放策略安全恢复；**不**把实验包 Pi Durable 定为全体 Bot Runtime。

Journal 与 resume 落在 KepCup 自有 `runs` / `run_steps` 与工具网关之上，由 Orchestrator 执行；`PiEngine` 仍只跑 LLM loop。语义参考 Pi Durable 的 effect sandwich、`replay`、`requestId` 与 memo，不整包替换引擎。

相关：D2（soft steer，[02-execution.md](02-execution.md)）、D21（pi 封装在 `AgentEngine` 之后，[09-tech-stack.md](09-tech-stack.md)）、D30（Project 检查点，[08-project.md](08-project.md)）、D48（消息可见性）、D54（中间过程投送）、D56（Loop 续接）、D65/D66（MCP / SubAgent）。

## 决策

> **D75 修订**：durable / ephemeral 的分级对象由「响应 run」改为「**任务**」——对话轮一律 ephemeral（秒级，崩溃即中断、不恢复），需要 journal 与工具 replay 的本来就是长任务。见 [30 §7.4](30-supervisor-and-tasks.md#74-崩溃与恢复d49d67)。

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

1. 常量与 schema：`durable` 标记、`effects` 表、工具 `replay` 元数据。
2. 拆分启动恢复：`finalizeEphemeral`（今日 `orchestrator.recoverInterrupted` 的 ephemeral 路径）与 `resumeDurable`。
3. 网关三类 replay，以及 `send_message` 的 idempotent。
4. 杀进程集成测试，再接 SubAgent 级联（含后台与 fan-out）。
5. Pi Durable 单车道对比 spike：**不做**（与 D67「不定为 Runtime」一致；需要时另开评估，不写入本分期）。

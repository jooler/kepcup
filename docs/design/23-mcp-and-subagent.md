# 23 MCP 与 SubAgent

Bot 执行 loop 的两项能力扩展：接入用户配置的 MCP 工具服务器；在 loop 内把「只要结论、材料很长」的子任务委派给宿主自有 SubAgent。两者都不改变群聊与消息规则（D2 / D4 / D5），不引入「群里的新联系人」。跨联系人 Bot 的代办与管家分诊见 [27-butler-and-delegation.md](27-butler-and-delegation.md)（D70/D71）——**不是**本篇 SubAgent。

决策：D64（Pi 1.x）、D65（MCP）、D66（SubAgent）。执行方案见 [todo/pi-1x-upgrade-mcp-subagent.md](../../todo/pi-1x-upgrade-mcp-subagent.md)。

## MCP（D65）

### 定位

- 用户在设置页配置 MCP server（stdio 命令或 streamable HTTP 端点），其工具按「应用启用 ∩ Bot 勾选」暴露给响应 loop。
- MCP 是工具来源的扩展，不是独立执行通道：工具调用与内置工具同管道（审批、审计、截断、`<untrusted>`）。
- 默认不启用任何 server；`autoApprove` 默认关闭，每次调用需用户批准。（修订：按工具风险分级，只读工具默认免审、可逐工具设置策略，已由 borrowings W5 落地；连接应用复用，见 [29-connected-apps.md](29-connected-apps.md) §8.1。）

### 配置与存储

| 层 | 位置 | 内容 |
|---|---|---|
| 应用级 | `settings.mcpServers`（单行 JSON，无需迁移） | server 列表：id、名称、transport（stdio / http=Streamable / sse=旧版 HTTP+SSE）、command/args 或 url、`enabled`、`autoApprove`、`toolPolicies?`（逐工具策略，W5） |
| Bot 级 | `botRuntimeSchema.mcp_server_ids` | 该 Bot 启用的 server 子集，默认空 |
| 密钥 | `secrets` 表 | stdio env / http headers 中的敏感值，键 `mcp:{serverId}:env|header:{name}`，字段级加密（D25），LLM 与日志不可见 |

不兼容 pi CLI 的 `mcp.json` 与 `/mcp` TUI；桌面端用自有设置页。

### 工具映射

- 命名：`mcp_{serverId}_{toolName}`，sanitize 为 `[A-Za-z0-9_-]`、≤64 字符；与内置工具重名时拒绝注册并告警。
- 参数：MCP 的 JSON Schema 经 TypeBox `Type.Unsafe` 承接。
- 结果：`toLlmContent` 转文本/图片块；文本包 `<untrusted>`、按 `TOOL_OUTPUT_MAX_CHARS` 截断、经 `secrets.redact`；图片块走 `ToolResult.images`（与浏览器截图同判定）。
- 工具面控制：Bot 级启用子集 + 每服务器工具数上限；上游 deferred tool loading 后续再评估。

### 审批与安全

- 调用统一经工具网关（`mcpToolCall`）：需要确认时为阻塞审批卡片（server、工具、参数摘要、风险徽标），复用 D37 授权与 D41 无人值守语义；是否需要确认按下节「风险分级与逐工具策略」。
- 每次调用写审计。MCP 不用于绕过沙箱；登录态社交操作仍优先浏览器 CDP（D44）。
- 连接生命周期：首次使用懒连接（对话轮解析工具面也会触发）；同一 server 的并发连接请求共用一次连接，不起第二个进程；stdio 进程崩溃后下次调用自动重连，失败计入 `MCP_RECONNECT_MAX`，超限标记 failed 并发 `mcp.server_status` 事件，之后任何路径都不再连它。只有任务与工具调用消耗这份重连预算——对话轮解析工具面与设置页 / Bot 详情查询工具风险不计数；core 关停时先等进行中的连接落定再统一关闭。

### 风险分级与逐工具策略（D65 修订，borrowings W5）

- **分级**（`core/mcp/risk.ts` `classifyRisk`，D73 连接应用复用）：`read` / `write` / `destructive` 三档。server 自报的注解不可信，只能把工具**放宽到只读**，且受名字一票否决：
  - `readOnlyHint:true` 且名字不像写操作 → `read`（来源：注解）；
  - 没有 `readOnlyHint`、名字以明确的只读动词开头（get / list / search / read / fetch / query …）且不像写操作 → `read`（来源：按名字推断）；
  - `destructiveHint:false` → `write`（只降一档，不免审批）；
  - 其余（含缺省注解、`readOnlyHint:false`）→ `destructive`。
  - 「像写操作」= 名字（先把 camelCase / kebab-case / 点号归一为下划线小写）任意位置含写动词（create / update / delete / send / post / write / pay / exec / run / invoke / edit / clear / revoke …）或复合动作（`_and_` / `_or_` / `_then_`）；也常作名词的 commit / push / deploy / install / sync / start / stop / order / book 等只在名字开头才算（`get_order` 仍是读）。正则误判只会把工具判得更严。
- **策略**（`settings.mcpServers[].toolPolicies[toolName] = { approval?: 'auto' | 'ask', enabled?: boolean }`，按工具名存，工具列表刷新后保留，已消失的工具在设置页标灰）。有人值守时的决定顺序：逐工具 `approval` > server `autoApprove`（等价于该 server 全部工具 `auto`，可被逐工具 `ask` 收回）> 风险档默认（`read` → 免审，`write` / `destructive` → 每次确认）。`enabled:false` 的工具不注册，调用时也拒绝（`MCP_TOOL_NOT_FOUND`）。
- **调用时重新解析**：网关每次调用都重读设置并重新判定风险（连接在线时先刷新注解，最多等 5 秒；离线时用已知注解，没见过的工具按 `destructive`，不为判定风险去连接）；server 已在应用级停用、或 Bot 已不再勾选它，进行中的任务也不能再调。
- **无人值守**：`mcp_tool` 审批在无人值守下**所有风险档**都自动批准（D41 / D53：开关是用户的选择；不拒绝、不排队、不设逐工具无人值守白名单；数据目录底线只作用于命令 / 路径类审批，不涉及 MCP）。审批行 `auto_approved=1`、payload 带 `risk`；审计 `mcp_tool_call` 记 `risk` / `riskSource` / 批准方式（auto / user / unattended）及来源，无人值守时另记「无人值守自动批准（写入 / 破坏性）」。Bot 详情的 MCP 区只要勾选了 server 就常驻提示「无人值守模式下，MCP 工具调用会自动批准执行（包括写入、删除类操作）」；无人值守生效且勾选的 server 含写入 / 破坏性工具（或风险查询失败）时提示改为警示样式并给出数量。
- **只读 MCP 工具进对话轮与只读子代理**：风险为 `read` 且有效审批为免审的工具也进对话轮（D75）与只读子代理（D66）的工具面，至多 `TURN_MCP_READ_TOOLS_MAX`（20）个（按 server 顺序）；对话轮解析工具面最多等 `TURN_MCP_RESOLVE_TIMEOUT_MS`（3 秒），超时本轮不带 MCP 工具、连接在后台继续。调用时网关再校验一次：此刻已不是「只读 + 免审」→ `RUN_READ_ONLY`（对话轮提示改用 `start_task`）。对话轮系统提示的 `<mcp_tools>` 段（Bot 有既在应用级启用、又被 Bot 勾选的 MCP server——「应用启用 ∩ Bot 勾选」非空——就有）说明本轮可直接调用的个数，以及写入 / 需确认的工具只在任务中可用。只读**任务**（`writes:false`）的工具面不变，仍拿到全部 MCP 工具（写工具照常弹卡）。
- **界面**：设置页每个 server 有「工具与审批」展开（风险徽标、判定来源、审批 默认 / 免审批 / 每次确认、启用开关，`mcp.toolRisks`）；`mcp_tool` 审批卡显示服务器 · 工具、参数与风险徽标，破坏性加警示条。
- 运行中把授权收紧（停用 server、移出 Bot、关闭 `autoApprove`、逐工具停用或由免审改为确认）会立即中断受影响的进行中任务，见 [13-permissions.md](13-permissions.md) 与 [30 §7.4](30-supervisor-and-tasks.md#74-崩溃与恢复d49d67)。

### 非目标（首期）

OAuth（`pi-mcp/oauth`，已单排为 D73，见 [29-connected-apps.md](29-connected-apps.md)）、Codemode（`pi-codemode`）、deferred tool loading、与 pi CLI 配置互通。

## SubAgent（D66）

> **D75 修订**：`delegate_task` 降级为「**任务内部**的嵌套子代理」。三种模式（前台 / 后台 / fan-out）在任务内照旧可用，但「后台委派 + 对话级锚点 + follow-up 结算」这一组职责**移交 D75 的任务层**（否则有两套对话级并发计数与两套结算路径）：`SubagentHost`（对话级锚点、`runningCount`、`abortFor*`）、`SubagentFollowUp`、orchestrator 的 follow-up 注入与 `SUBAGENT_FOLLOWUP_EVENT` **已删除**，对话级的注册、并发与结算由 `dispatch/tasks.ts` `TaskHost` 承担；后台模式退回「父任务内的并行分支」。对话轮派活用 `start_task`，不用 `delegate_task`（对话轮的工具面里没有它，执行期也拒绝）。MCP 工具同样只在**任务**的工具面（对话轮不提供）——borrowings W5 修订：风险为只读且免审批的 MCP 工具也进对话轮与只读子代理，见上文「风险分级与逐工具策略」。见 [30 §1.2](30-supervisor-and-tasks.md#12-与-d66--d71-的定位关系)。
>
> **后台分支的实现（D75 W2）**：`mode:"background"` 立即返回 `child_run_id`，分支在父 run（任务）内并行推进；父 loop 需要结论时调用 `collect_delegate_results({ child_run_ids? })`——等待所列分支（缺省为全部未取回的）结束，按委派顺序返回各分支的压缩结论或失败原因，每条只交付一次（两次并发的 collect 不会拿到同一条：调用先认领分支再等待，被取消的 collect 释放认领）。结论**只回到父 run**：不写对话消息、不投递 mailbox、不唤醒新一轮（下文 B / C 节的「follow-up 注入」「对话级锚点」「对话级并发封顶」均已废止）。生命周期全部挂父 run：父 run abort（含任务取消、对话删除、删 Bot）级联中止分支；父 run 结束时宿主中止仍在跑的分支并等它们 settle（最长 `SUBAGENT_CLOSE_GRACE_MS`，10 秒；先于释放写租约与任务结算，超时后父 run 照常结算，迟到分支的写入已被拒），未取回的结论作废——结论没有别的去处，等下去只会白占父任务的名额与租约。单条子 run 仍可经 `runs.cancel` 中止（`collect` 中该槽位报取消）。并发封顶 `SUBAGENT_BACKGROUND_CONCURRENCY` 改为按父 run 计。对话轮（`loop_type='turn'`）与子代理调用 `delegate_task` 在执行期被拒（`NOT_SUPPORTED`）。

### 动机

主 loop 上下文会累积对话与工具结果。扫仓库、读多文件、长日志分析、并行多路检索这类「只要结论」的任务若在主 loop 执行，会污染上下文、抬高费用与注意力噪声。宿主提供 `delegate_task`：嵌套减配子 run，结果压缩后回传。

产品要对齐的交互（参考 Pi Durable 度假规划 demo）：主 Bot 把调研交给 SubAgent 后**可以继续与用户对话、追问约束**；子任务结束后再把结论注回主 loop。这要求在既有「前台同步委派」之外，增加**后台委派**与**并行 fan-out**。

### 契约（共用）

| 项 | 规定 |
|---|---|
| 触发 | 主 loop 调用 `delegate_task`；参数见下节模式 |
| 子 run | `PiEngine.startRun` 嵌套启动，`loopType='subagent'`，落 `runs` 行（可审计、用量独立），**不**产生面向用户的对话消息 |
| 归属 | 同 Bot、同对话：workspace / project / 网关授权边界原样继承，不扩大沙箱 |
| 工具集 | 只读研究集：`read` / `grep` / `find` / `ls` / `bash`（沙箱）/ `web_search` / `web_fetch`，以及只读且免审批的 MCP 工具（W5）；无 `write` / `edit`、无 `send_message` / `skip_reply`、无再委派、无 memory / schedule / browser |
| 结果压缩 | 轻量模型把子 run 过程摘要压缩为 ≤ 4000 字符的结论；子 transcript 全文只落 `run_steps` |
| 预算 | 每个子 run 独立封顶：轮数、超时、token；超限中止并把已有内容压缩返回 |
| 可见性 | 对话流不出现子 transcript；`get_run` / run 详情与其他执行记录同级可查 |

pi 1.x 无产品级 SubAgent API，宿主以「工具 + 嵌套 Agent」实现；上游日后提供一等 API 时再评估减薄封装，工具名与契约保持稳定。

### 三种模式

#### A. 前台同步（已有，默认）

`delegate_task({ task })` 或显式 `mode: "foreground"`。

- 主 loop **阻塞等待**该子 run 结束，工具结果里直接拿到压缩结论，再继续主 turn。
- 一次主 run 内前台委派次数封顶（常量，如 `SUBAGENT_MAX_PER_RUN`）；前台调用之间**串行**。
- 主 run abort / `skip_reply` / 用户取消 → **级联 abort** 该子 run。
- 主 run 被 soft steer **不**中断子 run（子 run 继续跑完或被父 abort）。

适用于：短研究、结论马上要用在同一轮推理里。

#### B. 后台委派（新增，应对「边调研边继续聊」）

`delegate_task({ task, mode: "background" })`。

- 工具调用**立即返回** `{ child_run_id, status: "running" }`，**不**等待子 run 结束。
- 主 turn 可继续：向用户追问约束、发消息、结束本轮；子 run 在后台独立推进。
- 子 run **完成 / 失败 / 超限**后，宿主以**系统 follow-up**（或等价的确定性注入）把压缩结论送入**同一对话**的下一轮响应 loop（标记来源 `child_run_id` / `delegate_task`），由主 Bot 决定是否转述、追问或开新任务。注入不冒充用户消息；可见性仍遵守 D48/D54（子过程不刷聊天，只有主 Bot 对用户的发言进聊天）。
- **归属与中止**：后台子 run 挂在对话级后台锚点上（语义对齐 Durable 的 background 任务归属）——**普通 Esc / 结束当前主 turn 不级联 abort**；用户明确「取消该委派 / 取消全部后台任务」、对话关闭、或 Bot 删除时才 abort。父 durable resume（D67）须先收束或恢复未完成的后台子 run。
- 同一对话并发后台子 run 数量封顶（常量）；超额时工具返回错误，由模型改串行或合并任务。

适用于：长调研、多源搜集，同时主 Bot 还要向用户澄清预算 / 时间 / 偏好。

#### C. 并行 fan-out（新增，现即支持）

`delegate_task({ tasks: [{ task, mode? }, ...] })`，或连续多次 `mode: "background"` 委派（实现二选一，对外语义一致）。

- 一次调用可启动 **N 路**独立子 run（N 有硬顶，建议默认 ≤4，与进程/模型预算挂钩），各路**并行**执行，互不共享 transcript。
- 每路仍是只读研究子 run；禁止子路之间互相通信或再委派。
- **前台 fan-out**：主 loop 等待**全部**子 run settle 后，返回按 `task` 顺序排列的压缩结论数组（某路失败则该槽位带 `error`，其余成功结论仍返回）。
- **后台 fan-out**：立即返回各 `child_run_id`；每路完成时各自触发一次 follow-up 注入（逐路注入；主 prompt 说明「多路结论可能分批到达」）。
- 与 B 共用并发封顶：前台 fan-out 的 N + 已在跑的后台子 run 总数不得超过上限。

适用于：同时搜天气 / 场馆 / 交通等多独立查询（度假规划类场景）。

### 与 soft steer、主动消息的边界

| 机制 | 方向 | 与 SubAgent |
|---|---|---|
| D2 soft steer | 用户在主 run 进行中发新消息 → 注入主 loop | 不替代后台委派；前台等待期间用户消息仍可 steer **主** loop，不打断子 run |
| 后台 follow-up 注入 | 子 run 结束 → 启动/排队主 Bot 新一轮 | 宿主确定性事件，不是用户消息；可与 mailbox / 定时触发共用投递管道 |
| `send_message` | 主 Bot 对用户或 @ 其他 Bot | 子 run **禁止**；后台结论由主 Bot 决定是否发言 |

### 非目标（明确不做）

下列能力**不做**（含原「低优 / 可选」，本轮一并关闭，避免与 Pi Durable 示例表逐项对齐）：

- 子代理间通信、子代理再委派、用户级 SubAgent 角色配置、把 SubAgent 注册为群成员、用 SubAgent 模拟另一个 Bot 联系人（跨 Bot 走 D71）
- Transcript **fork** / 会话树分叉（KepCup 是 IM 联系人模型，用另一 Bot 联系人表达「旁路角色」，不用 fork）
- 运行中热替换扩展代码、Cloudflare Durable Objects / 多端 late-join 多人操控同一 run
- Durable 式 Child Task Graph（付款 failFast 等基础设施任务图）
- 专用 Plan mode / Reviewer 会话类型（需要时用独立 Bot 联系人）
- 独立「任务归属树」面板产品（run 详情够用即可；不为对齐 Durable task graph 加面板）
- 整仓采用 `@earendil-works/pi-durable` 作 Bot Runtime（见 D67 / [24-durable-execution.md](24-durable-execution.md)）

### 应做清单（相对本文与 D67）

1. **前台同步** `delegate_task`（已有）
2. **后台委派** + 完成后 follow-up 注入（新增）
3. **并行 fan-out**（新增，现即支持）
4. 与 **D67** 对齐：未完成的前台/后台子 run 进 journal；父 resume 先收束或恢复子 run；后台子 run 可单独 durable

执行方案见 [todo/pi-1x-upgrade-mcp-subagent.md](../../todo/pi-1x-upgrade-mcp-subagent.md)（实现阶段补后台与 fan-out 条目）。

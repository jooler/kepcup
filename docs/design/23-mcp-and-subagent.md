# 23 MCP 与 SubAgent

Bot 执行 loop 的两项能力扩展：接入用户配置的 MCP 工具服务器；在 loop 内把「只要结论、材料很长」的子任务委派给宿主自有 SubAgent。两者都不改变群聊与消息规则（D2 / D4 / D5），不引入「群里的新联系人」。跨联系人 Bot 的代办与管家分诊见 [27-butler-and-delegation.md](27-butler-and-delegation.md)（D70/D71）——**不是**本篇 SubAgent。

决策：D64（Pi 1.x）、D65（MCP）、D66（SubAgent）。执行方案见 [todo/pi-1x-upgrade-mcp-subagent.md](../../todo/pi-1x-upgrade-mcp-subagent.md)。

## MCP（D65）

### 定位

- 用户在设置页配置 MCP server（stdio 命令或 streamable HTTP 端点），其工具按「应用启用 ∩ Bot 勾选」暴露给响应 loop。
- MCP 是工具来源的扩展，不是独立执行通道：工具调用与内置工具同管道（审批、审计、截断、`<untrusted>`）。
- 默认不启用任何 server；`autoApprove` 默认关闭，每次调用需用户批准。

### 配置与存储

| 层 | 位置 | 内容 |
|---|---|---|
| 应用级 | `settings.mcpServers`（单行 JSON，无需迁移） | server 列表：id、名称、transport（stdio / http=Streamable / sse=旧版 HTTP+SSE）、command/args 或 url、`enabled`、`autoApprove` |
| Bot 级 | `botRuntimeSchema.mcp_server_ids` | 该 Bot 启用的 server 子集，默认空 |
| 密钥 | `secrets` 表 | stdio env / http headers 中的敏感值，键 `mcp:{serverId}:env|header:{name}`，字段级加密（D25），LLM 与日志不可见 |

不兼容 pi CLI 的 `mcp.json` 与 `/mcp` TUI；桌面端用自有设置页。

### 工具映射

- 命名：`mcp_{serverId}_{toolName}`，sanitize 为 `[A-Za-z0-9_-]`、≤64 字符；与内置工具重名时拒绝注册并告警。
- 参数：MCP 的 JSON Schema 经 TypeBox `Type.Unsafe` 承接。
- 结果：`toLlmContent` 转文本/图片块；文本包 `<untrusted>`、按 `TOOL_OUTPUT_MAX_CHARS` 截断、经 `secrets.redact`；图片块走 `ToolResult.images`（与浏览器截图同判定）。
- 工具面控制：Bot 级启用子集 + 每服务器工具数上限；上游 deferred tool loading 后续再评估。

### 审批与安全

- 调用统一经工具网关（`mcpToolCall`）：默认阻塞审批卡片（server、工具、参数摘要），复用 D37 授权与 D41 无人值守语义；`autoApprove` 的 server 免卡。
- 每次调用写审计。MCP 不用于绕过沙箱；登录态社交操作仍优先浏览器 CDP（D44）。
- 连接生命周期：首次使用懒连接；stdio 进程崩溃后下次调用自动重连（重试超限标记 failed 并发 `mcp.server_status` 事件）；core 关停统一关闭。

### 非目标（首期）

OAuth（`pi-mcp/oauth`，后续单排）、Codemode（`pi-codemode`）、deferred tool loading、与 pi CLI 配置互通。

## SubAgent（D66）

### 动机

主 loop 上下文会累积对话与工具结果。扫仓库、读多文件、长日志分析、并行多路检索这类「只要结论」的任务若在主 loop 执行，会污染上下文、抬高费用与注意力噪声。宿主提供 `delegate_task`：嵌套减配子 run，结果压缩后回传。

产品要对齐的交互（参考 Pi Durable 度假规划 demo）：主 Bot 把调研交给 SubAgent 后**可以继续与用户对话、追问约束**；子任务结束后再把结论注回主 loop。这要求在既有「前台同步委派」之外，增加**后台委派**与**并行 fan-out**。

### 契约（共用）

| 项 | 规定 |
|---|---|
| 触发 | 主 loop 调用 `delegate_task`；参数见下节模式 |
| 子 run | `PiEngine.startRun` 嵌套启动，`loopType='subagent'`，落 `runs` 行（可审计、用量独立），**不**产生面向用户的对话消息 |
| 归属 | 同 Bot、同对话：workspace / project / 网关授权边界原样继承，不扩大沙箱 |
| 工具集 | 只读研究集：`read` / `grep` / `find` / `ls` / `bash`（沙箱）/ `web_search` / `web_fetch`；无 `write` / `edit`、无 `send_message` / `skip_reply`、无再委派、无 memory / schedule / browser |
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

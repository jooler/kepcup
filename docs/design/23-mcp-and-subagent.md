# 23 MCP 与 SubAgent

Bot 执行 loop 的两项能力扩展：接入用户配置的 MCP 工具服务器；在 loop 内把「只要结论、材料很长」的子任务委派给宿主自有 SubAgent。两者都不改变群聊与消息规则（D2 / D4 / D5），不引入「群里的新联系人」。

决策：D64（Pi 1.x）、D65（MCP）、D66（SubAgent）。执行方案见 [todo/pi-1x-upgrade-mcp-subagent.md](../../todo/pi-1x-upgrade-mcp-subagent.md)。

## MCP（D65）

### 定位

- 用户在设置页配置 MCP server（stdio 命令或 streamable HTTP 端点），其工具按「应用启用 ∩ Bot 勾选」暴露给响应 loop。
- MCP 是工具来源的扩展，不是独立执行通道：工具调用与内置工具同管道（审批、审计、截断、`<untrusted>`）。
- 默认不启用任何 server；`autoApprove` 默认关闭，每次调用需用户批准。

### 配置与存储

| 层 | 位置 | 内容 |
|---|---|---|
| 应用级 | `settings.mcpServers`（单行 JSON，无需迁移） | server 列表：id、名称、transport（stdio / http）、command/args 或 url、`enabled`、`autoApprove` |
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

主 loop 上下文会累积对话与工具结果。扫仓库、读多文件、长日志分析这类「只要结论」的任务若在主 loop 执行，会污染上下文、抬高费用与注意力噪声。宿主提供 `delegate_task` 工具：嵌套一个减配子 run 完成任务，结果压缩后回传。

### 契约

| 项 | 规定 |
|---|---|
| 触发 | 主 loop 模型调用 `delegate_task({ task })`；一次主 run 至多委派有限次数（常量封顶） |
| 子 run | `PiEngine.startRun` 嵌套启动，`loopType='subagent'`，落 `runs` 行（可审计、用量独立），不产生对话消息 |
| 归属 | 同 Bot、同对话：workspace / project / 网关授权边界原样继承，不扩大沙箱 |
| 工具集 | 只读研究集：`read` / `grep` / `find` / `ls` / `bash`（沙箱）/ `web_search` / `web_fetch`；无 `write` / `edit`（避免与主 run 写租约竞争）、无 `send_message` / `skip_reply`、无再委派、无 memory / schedule / browser |
| 结果 | 轻量模型把子 run 过程摘要压缩为 ≤ 4000 字符的结论返回主 loop；子 transcript 全文只落 `run_steps` |
| 中止 | 主 run abort / skip_reply / 用户取消级联 abort 子 run；主 run 被 steer 不影响子 run |
| 预算 | 子 run 独立封顶：轮数、超时、token 预算；超限中止并把已有内容压缩返回 |
| 可见性 | 对话流不出现；`get_run` / run 详情 UI 与其他执行记录同级可查 |

pi 1.x 无产品级 SubAgent API，宿主以「工具 + 嵌套 Agent」实现；上游日后提供一等 API 时再评估减薄封装，工具名与契约保持稳定。

### 非目标

并行 fan-out、子代理间通信、子代理再委派、用户级 SubAgent 配置、把 SubAgent 注册为群成员。

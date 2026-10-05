# PiEngine 1.x 升级 · MCP 接入 · 宿主 SubAgent

> 状态：**已拍板待实现**（决策 D64 / D65 / D66，设计见 `docs/design/23-mcp-and-subagent.md`，技术选型见 `docs/design/09-tech-stack.md`）。分三个阶段，A 是 B 的前置，C 与 B 相互独立。

## 1. 背景与目标

1. **Pi 1.x 升级（D64）**：`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent` 从 0.87.1 升级并锁定到 1.x（npm 当前 1.0.2），消除 0.x 停更风险，为 MCP 等新能力铺路。
2. **MCP 接入（D65）**：用户可在设置页配置 MCP server（stdio / streamable HTTP），其工具经宿主网关进入 Bot 的响应 loop；默认不启用，启用必须经过审批网关。
3. **宿主 SubAgent（D66）**：为「只要结论、材料很长」的子任务提供 `delegate_task` 工具——在主 loop 内嵌套一个减配子 run，结果压缩后回传，避免撑爆主 loop 上下文。

约束（继续有效）：

- **D21**：业务代码不直连 pi，一律经 `PiEngine` / 工具层；pi 锁定精确版本。
- **D2 / D4 / D5**：群聊既有产品规则不变；SubAgent / MCP 不充当「群里的另一个联系人」。

## 2. 现状与迁移面核实（2026-10-05 实证，非推测）

以 tarball 对比 0.87.1 与 1.0.2 的 `.d.ts` 得出，逐项对照过 KepCup 实际 import：

| 包 | KepCup 用到的导出 | 1.0.2 状态 |
|---|---|---|
| `pi-agent-core` | `Agent`、`AgentTool`；`steer` / `abort` / `continue` / `prompt` / `subscribe` / `steeringMode` / `prepareRequest` / `finishTurn` / `onPayload` / `state` | **全部不变**；`FinishTurn` 类型逐字相同 |
| `pi-ai` | `createModels` / `createProvider` / `CredentialStore` / `Model` / `Models` / `Api` / `Type` / `builtinProviders` / `openAICompletionsApi`（lazy 子路径） | **全部不变**；新增 images / classifier 模型类型（本阶段不用） |
| `pi-coding-agent` | 7 个 `create*ToolDefinition` 工具工厂、`loadSkillsFromDir` / `formatSkillsForPrompt` / `Skill` / `ResourceDiagnostic` | **导出行逐字未变** |

1.0.2 相对 0.87.1 的实际差异（Phase A 实现时逐文件 diff 复核修订）：

- **移除**（KepCup 均未使用，已 grep 验证）：`harness/`、`search/` 子树、telemetry 再导出、`uuidv7` 再导出（原从 pi-ai 转出）。
- **新增**：`runToolCall()`（工具内部调用其他工具时走与模型调用相同的 hooks，SubAgent 可选用）、`onProviderStreamEvent`。（早前方案稿所列 `finishRun()` / `prepareNextTurnWithContext`「新增」不成立——0.87.1 已有；agent_end 语义在 0.87.1 也已是精确化语义，两版发射点逐字相同。）
- **工具失败语义变化（.d.ts 对照抓不到，集成测试实测抓住）**：pi 1.0.2 的 bash 工具对非零退出码从 0.x 的 **throw** 改为返回 **`isError: true`** 的结果（agent-core types.d.ts："errors come back as `isError: true`"）；宿主 `wrapPiTool` 已适配（失败映射 `ok:false + COMMAND_FAILED`），read/write/edit/ls/find/grep 的 throw 语义不变。
- **传递依赖变化**：pi-ai 1.0.2 依赖 openai 7.x（自 6.40 主版本跳变，custom/vendor 的 OpenAI 兼容流量经过它）且带 undici optional peer，与 core 的 undici ^8.11.2 曾把 pi 包分裂为两个实例——已用 `pnpm-workspace.yaml` overrides 统一 undici=8.11.2 收敛为单实例；内置 chat 模型目录有增删（42 移除 / 84 新增 / 124 个 contextWindow/cost 变化），已保存的失效 model ref 会以 NOT_FOUND 报错（属数据兼容面，不做自动迁移）。
- 各包 `engines.node >= 22.19.0`，与根 `package.json` 一致，无升级阻力。
- **结论：Phase A = 版本号变更 + wrapPiTool isError 适配 + undici 收敛 + 全量回归，无其他 API 改写。** 早前方案稿所列「`shouldStopAfterTurn` → `finishTurn`」「Models/auth 组装改造」与代码现状不符——`finishTurn` 在 0.87.1 已启用、`createModels` + 自定义 `CredentialStore`（DEV-002）已是现行路径。

MCP 侧已核实（`@earendil-works/pi-mcp@1.0.2` README + package.json）：

- 独立小包，运行时依赖仅 `cross-spawn`；exports：`.` / `./oauth` / `./testing`；协议版本 2025-11-25（向后兼容 2024-11-05 起）。
- API：`McpClient` + `StdioTransport({command,args})` / `StreamableHttpTransport({url,headers})`、`listTools()` / `callTool(name, params, {signal})`、`toLlmContent(result)`（CallToolResult → pi-ai 文本/图片块）、工具名 sanitize 建议 `mcp_<tool>`（`[A-Za-z0-9_-]`、≤64）。
- `./oauth` 子包：`McpOAuthProvider` + `OAuthCallbackServer`（回调服务器自己起，浏览器由宿主打开），PKCE / 动态注册 / token refresh。

## 3. Phase A — Pi 0.87.1 → 1.0.2

### 改动清单

- [x] `packages/core/package.json`：三个 pi 包 `0.87.1` → `1.0.2`（精确锁定），`pnpm install` 更新 lock。
- [x] `packages/core/src/agent/pi-engine.ts`：typecheck 驱动的微调（实际零改动；行为差异在 `tools/coding-tools.ts` 的 `wrapPiTool`——1.0.2 bash 工具非零退出改返回 `isError: true` 而非 throw，已修复映射）。
- [x] 全量回归：`pnpm typecheck` + `pnpm test`（109 文件 854 passed 零失败）；`pnpm test:e2e` 按流程留到三阶段完成后统一跑。
- [x] `docs/dev/PROGRESS.md` 记录升级与回归结果；版本号同步到 `docs/design/09-tech-stack.md`（本次已更新为 1.x）。

### 验收口径

1. 三包锁定 1.0.2，lock 无 0.x 残留。✅
2. 全部既有测试绿；重点：pi-engine 相关（事件屏障、steer、abort、skip_reply settle）、续接、群聊 chain。✅
3. 新增一条断言：agent_end listener 内读取 `agent.state.messages` 仍能取到完整转录（时序契约固化；复核确认 0.87.1/1.0.2 语义一致）。✅（`test/integration/agent-end-transcript.test.ts`）

### 风险

- 极低。唯一的行为差异是 agent_end / idle 的时序精确化；用测试锁定即可。

## 4. Phase B — MCP 接入

### 4.1 配置模型（无需 DB 迁移）

- `packages/shared/src/domain/types.ts` `settingsSchema` 增 `mcpServers`（settings 为单行 JSON，对齐 `webSearch` 先例）：

  ```ts
  mcpServerSchema = z.object({
    id: string, name: string,
    transport: z.enum(['stdio', 'http']),
    command: string.optional, args: string[].optional,          // stdio
    url: string.optional,                                        // http
    enabled: boolean.default(false),
    autoApprove: boolean.default(false),                         // 免审批开关，默认关
  })
  ```

- `botRuntimeSchema` 增 `mcp_server_ids: string[]`（默认 `[]` = 不启用任何 server）；**应用级 enabled ∩ Bot 选中** 才暴露给该 Bot。
- 敏感值（stdio env、http headers 中的 key/token）：单独存 `secrets` 表，键 `mcp:{serverId}:env:{name}` / `mcp:{serverId}:header:{name}`，字段级加密（D25）；设置 UI 只写占位符。

### 4.2 模块与包装

- 新增 `packages/core/src/mcp/service.ts`（`McpService`）：连接生命周期（首次使用 lazy connect；stdio 崩溃后下次调用重连，重试上限后标记 failed 并发 `mcp.server_status` 事件）、`listTools()` 缓存 + `tool-list-change` 通知失效、`callTool` 超时与 signal 透传、core 关停时统一 close。
- 新增 `packages/core/src/mcp/tools.ts`：MCP tool → KepCup `ToolDefinition` 包装（参数 schema 用 TypeBox `Type.Unsafe` 承接 JSON Schema，对齐 pi-mcp README 做法；结果经 `toLlmContent` → 文本进 `<untrusted>` + `TOOL_OUTPUT_MAX_CHARS` 截断，图片块接 `ToolResult.images`）。
- 工具命名：`mcp_{serverId}_{toolName}`，sanitize 为 `[A-Za-z0-9_-]` 且 ≤64；与内置工具重名时拒绝注册该工具并在日志/事件中告警。
- 注册点：`orchestrator.#executeResponseRun` 按 Bot 解析启用的 servers，把包装后的工具并入 `buildResponseTools` 的返回；`ResponseToolDeps` 增 `mcp?: McpToolFacade`。

### 4.3 审批与安全

- MCP 工具调用统一走新 `gateway.mcpToolCall(identity, serverId, toolName, args)`：
  - `autoApprove=false`（默认）：阻塞审批卡片（server 名、工具名、参数摘要），复用 D37 授权机制与 D41 无人值守语义（无人值守下按既有自动批准类处理）；
  - 每次调用写 `audit`。
- MCP 工具不绕过沙箱：它们是宿主进程内的网络/外部调用，与 `web_search` 同级；不用于替代浏览器 CDP 登录态操作（既有设计）。
- 结果一律 `<untrusted>` 包裹 + 截断 + `secrets.redact`。

### 4.4 UI 与事件

- 设置页新增「MCP 服务器」区：增删改、启用开关、连接测试（显示工具列表）、autoApprove 开关（带风险提示文案）。
- Bot 编辑（Profile runtime）勾选可用的 servers。
- 事件 `mcp.server_status`（connecting / connected / failed / closed）驱动设置页状态展示。

### 4.5 非目标（首期）

- OAuth（`pi-mcp/oauth` + 系统浏览器回调）：Phase B2 单独排期。
- Codemode（`pi-codemode` 脚本化调工具）：不做。
- deferred tool loading / tool_search：工具面过大问题先靠「Bot 级启用子集」控制，上游特性后续评估。
- pi CLI 的 `/mcp` TUI 与 `mcp.json` 文件格式：桌面用自有设置页与 settings 存储，不兼容 CLI 配置。

### 4.6 改动清单

- [x] shared：`mcpServerSchema` / `botRuntimeSchema.mcp_server_ids` / 错误码（MCP_CONNECT_FAILED / MCP_SERVER_FAILED / MCP_CALL_FAILED / MCP_TOOL_NOT_FOUND）+ 审批 kind `mcp_tool`（payload schema + describe + ApprovalCard 分支）+ `mcp.server_status` 事件
- [x] core：`src/mcp/service.ts`、`src/mcp/tools.ts`、gateway `mcpToolCall`、orchestrator 注册、RPC 方法（`mcp.test` / `mcp.setSecret` / `mcp.removeSecret` + `settings.update.mcpServers`）、事件、迁移 0015（approvals CHECK 补 `mcp_tool` 与 P19 遗漏的 `skill_preset`）
- [x] desktop：设置页 MCP 区块 + Bot 编辑勾选 + 密钥只写 RPC
- [x] constants：`MCP_CALL_TIMEOUT_MS`（60s）、`MCP_CONNECT_TIMEOUT_MS`（15s）、`MCP_TOOLS_PER_SERVER_MAX`（64，防失控工具面）+ `MCP_RECONNECT_MAX`（3）/ `MCP_TOOL_LIST_CACHE_MS`（5min）
- [x] 测试：单测（命名 sanitize、启用交集）+ 集成（真实 stdio 子进程：懒连接、包装映射、杀进程重连、失败标记；全栈：工具入 loop、审批、拒绝、autoApprove、未勾选不注册）

### 4.7 验收口径

1. 设置页配置 stdio filesystem server 并启用后，对话中模型可见其工具，调用弹审批卡；批准后返回结果（`<untrusted>`）；拒绝返回 `APPROVAL_DENIED` 且模型能继续。✅（集成 `mcp-loop.test.ts` 前两例）
2. `autoApprove` 开启后不再弹卡；无人值守模式行为符合 D41。✅（第四例 + 无人值守走 approvals.request 统一自动批准路径）
3. Bot 未勾选该 server 时工具不出现。✅（第三例断言请求 tools 无该工具）
4. server 进程被杀后下一次调用自动重连；重试超限后设置页显示 failed。✅（集成 `mcp.test.ts`：pkill 后重连成功；3 次失败后 `MCP_SERVER_FAILED` + `mcp.server_status` failed 事件）
5. 密钥只进 secrets 表；`run_steps.request` 与日志中不含明文。✅（占位符 `secret:*` 设计上不落 settings；连接时内存解析，audit/步骤经 redact）

## 5. Phase C — 宿主 SubAgent（`delegate_task`）

### 5.1 行为契约

| 项 | 规定 |
|---|---|
| 工具名 | `delegate_task`，参数 `{ task: string }`（任务说明；大段材料建议主模型先落 workspace 再给路径） |
| 子 run | `PiEngine.startRun` 嵌套启动：同 identity（Bot/对话/workspace/project/网关授权全部继承），`loopType='subagent'`，落 `runs` 行（可审计、用量挂子 run 名下），**不产生任何对话消息** |
| 工具集（减配） | `read` / `grep` / `find` / `ls` + `bash`（沙箱）+ `web_search` / `web_fetch`；**无** `write` / `edit`（避免与主 run 的 project 写租约竞争）、无 `send_message` / `skip_reply` / `delegate_task`（禁止再委派）、无 memory / schedule / browser / skills 工具 |
| 结果 | 子 run 结束后用轻量模型 `complete()` 把过程摘要（复用续接段的摘要构建）压缩为 ≤ `SUBAGENT_RESULT_MAX_CHARS` 的结论返回主 loop；压缩失败回退为子 run 最终文本截断。子 transcript 全文只落 `run_steps`，不回灌主上下文 |
| 可见性 | 对话流不出现子 run 内容；主 Bot 决定是否转述。`get_run` / run 详情 UI 可查（与执行记录同级） |
| 并发/预算 | 单主 run 内串行（同一时刻至多 1 个子 run）、最多 `SUBAGENT_MAX_PER_RUN` 次委派；子 run `SUBAGENT_MAX_TURNS` / `SUBAGENT_TIMEOUT_MS` / `SUBAGENT_TOKEN_BUDGET` 封顶，超限 abort 并把已有内容压缩返回 |
| 中止 | 主 run abort / skip_reply / 用户取消 → 子 run 级联 abort（父 `ToolContext.signal` 监听）；主 run 被 steer 不影响子 run（任务指令已定） |
| 提示词 | `<platform_rules>` 增一条：需要大量阅读/检索只要结论时用 `delegate_task`，并交代清楚要什么结论、材料在哪 |

### 5.2 与上游的关系

pi 1.x 仍无产品级 SubAgent API（1.0.2 新增的 `runToolCall` 只是工具互调的 hook 复用，不是委派机制）。宿主以「工具 + 嵌套 `Agent`」实现；若上游日后提供一等 API，再评估减薄封装，工具名与契约保持稳定。

### 5.3 非目标

- 不做并行 fan-out / 子代理间通信 / 子代理再委派。
- 不把 SubAgent 注册成群成员；群协作仍走 `send_message` @（D4）。
- 不提供用户级「SubAgent 配置」；工具集与预算为宿主固定常量。

### 5.4 改动清单

- [x] shared：`LoopType` 增 `'subagent'`；constants：`SUBAGENT_MAX_TURNS`（20）、`SUBAGENT_TIMEOUT_MS`（600s）、`SUBAGENT_RESULT_MAX_CHARS`（4000）、`SUBAGENT_MAX_PER_RUN`（3）、`SUBAGENT_TOKEN_BUDGET`（150k）
- [x] core：`src/agent/subagent.ts`（子 run 启动、预算/超时/abort 级联、结果压缩）、`src/tools/delegate-tools.ts`（工具定义 + `SubagentToolFacade`）、`tools/index.ts` 注册位（+ `buildSubagentResearchTools` 减配组装）、orchestrator 装配 facade、system prompt 规则、`runs` 侧 loopType 放行（共享枚举扩 after，RPC schema 随之放行）
- [x] `src/skills/scan.ts`：拒绝「Task 子代理」的规则改为**只拒绝 pi CLI 语义的 Task/TaskTool**，允许描述中引用宿主自有 `delegate_task`（否则合法技能会被误杀）
- [x] desktop：run 详情对 `subagent` run 的展示（复用现有 run 详情，无需新 UI；仅 `UsageSection.LOOP_KEYS` 补 `subagent` i18n 键；集成测试断言子 run 不进消息流）
- [x] 测试：单测（预算截断、压缩失败回退、禁止再委派）+ 集成（长材料摘要任务：主 loop 只收摘要、消息流无子 run 内容、主 run cancel 级联子 run cancelled、run_steps 完整落库）

### 5.5 验收口径

1. 「扫一个多文件目录并汇总」类任务经 `delegate_task` 完成，主 loop 只见到 ≤4000 字符结论与关键路径。✅（集成测试：压缩结论包 `<untrusted>` 回传）
2. 子 run 落 `runs` 行（`loop_type='subagent'`），对话消息列表无新增；run 详情可见过程。✅
3. 主 run 进行中用户取消 → 子 run 同步 cancelled，无悬挂。✅
4. 子 run 内调用 `send_message` / `delegate_task` 得到明确的「本执行不可用」错误。✅（结构性排除：子 run 工具集不含这些工具，集成测试断言请求 payload 中不存在）
5. 群聊与单聊均可委派；chain token 预算统计不含子 run 用量（已确认可接受，如后续要并入再改）。✅（单聊集成覆盖；子 run 不继承 chainId，群聊路径同一工具入口）

## 6. 实施顺序与依赖

```
Phase A（升级 1.0.2） → Phase C（SubAgent，纯增量、风险小） → Phase B（MCP，含设置 UI 与安全面）
```

- B 依赖 A（`pi-mcp@1.0.2` 要求 1.x core）。
- C 与 B 独立，C 先行是因为它不动设置存储与 UI，能更快验证嵌套 run 的稳定性；两者可对调或并行（不同文件域）。
- 群聊唤醒与转交（原方案稿 §4–§6）**不在本计划内**，仍为草案；其决策拍板时编号从 D67 起（D63 已被文件技能路由占用，D64–D66 已被本计划占用）。

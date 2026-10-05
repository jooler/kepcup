# 09 技术选型

## 总览

| 层 | 选择 |
|---|---|
| Agent loop | pi（作为库使用）：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`，以及 `@earendil-works/pi-coding-agent` 中的工具与 Skills 加载器；MCP 客户端用 `@earendil-works/pi-mcp` |
| 桌面壳 | Electron + electron-builder + electron-updater |
| 前端框架 | Svelte 5 + Vite（单页应用） |
| 组件库 | shadcn-svelte + bits-ui + Tailwind v4，补充 shadcn-svelte-extras |
| 沙箱 | 见 [10-sandbox.md](10-sandbox.md) |
| 存储 | 见 [11-storage.md](11-storage.md) |

## Agent loop：pi

### 选择理由

- 唯一一个同时满足以下条件的框架：原生支持在下一步注入新消息、可以嵌入我们自己的进程、自带 Claude Code 风格的编码工具、原生支持 Agent Skills。
- TypeScript，MIT 协议，维护活跃。
- 多模型：Anthropic、OpenAI、Google、DeepSeek 等内置支持；OpenAI 兼容接口与 Ollama 等本地模型通过 `baseUrl` 接入。

### 需求与 pi 机制的对应

| 我们的需求 | pi 机制 |
|---|---|
| 执行中注入新消息 | `agent.steer()`，`steeringMode` |
| 本轮结束后追加 | `agent.followUp()` |
| 取消执行 | `agent.abort()`，`AbortSignal` 传递到每个工具 |
| 工具权限网关 | `beforeToolCall`（可拦截）/ `afterToolCall`（可改写结果） |
| 上下文注入 | `transformContext` / `prepareRequest`，每次请求前重建上下文 |
| 结束判断 | `finishTurn` |
| 持久化执行步骤 | 订阅事件：`message_end`、`tool_execution_end`、`turn_end` 等 |
| 工具在沙箱中执行 | 替换文件与命令的执行接口（`FileOperations` / `BashOperations`） |
| Skills | `loadSkills` / `formatSkillsForPrompt` |
| MCP 工具接入 | `@earendil-works/pi-mcp` 的 `McpClient` + stdio / streamable HTTP 传输；工具包装为宿主 `ToolDefinition` 后进 loop（见 [23-mcp-and-subagent.md](23-mcp-and-subagent.md)） |
| token 统计 | 每条助手消息携带用量与费用 |

### 需要自行实现

- **调度器**：优先级队列（响应 loop > 群聊判断 > 后台 loop），并按模型厂商限制并发；每次执行一个 `Agent` 实例。
- **用量账本**：按执行累计 token 与费用，用于用量展示与预算控制。
- **沙箱版执行接口**：让 pi 的工具经由工具网关在沙箱中执行。
- **群聊判断**：单次模型调用（通过 `pi-ai`），不启动完整 loop。

### 约束

- 锁定精确版本（当前 1.0.2，D64；0.87.1 → 1.0.2 核心嵌入 API 逐字兼容）。
- 封装在我们自己的接口之后，业务代码不直接依赖 pi，便于升级或替换。
- 不使用 pi 的会话 SDK 层（`createAgentSession`），它自带设置、文件发现与会话存储，与我们的设计冲突。
- 不使用 pi CLI 的配置面（`mcp.json`、`/mcp` TUI、skills 目录约定）：设置存数据库，桌面用自有设置页。

### 参考

deepseek-harness 的设计（持久化收件箱、“模型看到的一切都在日志里”的事件日志）值得借鉴；它要求自己作为宿主进程，暂不采用，1.0 之后再评估。

## 桌面壳：Electron

### 进程结构

| 进程 | 职责 |
|---|---|
| 主进程 | 托盘 / 菜单栏、窗口管理、启动并看护核心服务 |
| 界面进程 | Svelte 界面，只通过 IPC 与主进程和核心服务通信 |
| 核心服务 | 独立的 Node 进程，运行调度器、各类 loop、工具网关、环境管理器、数据库 |

- 界面关闭或崩溃不影响核心服务；Bot 在窗口关闭后继续工作。
- 界面与壳之间只通过 IPC 交互，保留日后更换桌面壳的可能。

### 选择理由

- 核心服务是 Node，Electron 直接运行，不需要额外打包 Node 运行时。
- 三个平台都是同一个 Chromium，渲染一致；Tauri 在 Linux 上依赖的 WebKitGTK 渲染性能问题明显。
- 托盘、开机自启、自动更新、签名都有成熟方案。

### 代价

- 安装包约 100～150MB，内存占用较高。
- macOS 上开机自启与自动更新依赖签名和公证；Windows 需要代码签名证书。
- 需要跟进 Chromium 安全更新。

## 前端

| 需求 | 选择 |
|---|---|
| 基础组件 | shadcn-svelte（Sidebar、Resizable、Dialog、Dropdown Menu、Command、Scroll Area、Tabs 等），toast 用 svelte-sonner |
| 扩展组件 | shadcn-svelte-extras（Tree View、Code、Copy Button、File Drop Zone 等） |
| 聊天组件 | Svelte AI Elements（消息、会话、输入框、操作按钮） |
| 流式 markdown | streamdown-svelte（Shiki 代码高亮） |
| 消息列表虚拟滚动 | @humanspeak/svelte-virtual-list |
| 代码编辑 | CodeMirror 6（svelte-codemirror-editor），可编辑 diff 用 `@codemirror/merge` |
| diff 展示 | @pierre/diffs |

约束：

- 优先使用现成组件，不手写大量组件。
- Svelte AI Elements 等以复制代码的方式引入项目，上游修复需手动合并。
- shadcn-svelte-extras 的 Tree View 没有虚拟化，大目录树需要单独处理。

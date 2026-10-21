# InkCop 同机应用协作（KepCup 侧）

契约对齐 InkCop `docs/PLANs/InkCop-KepCup 同机 Connection 桥接契约.md`（**v0.4**）。

## 版本

| endpoint.version | 能力 |
| --- | --- |
| 1 | health / connections / messages SSE（v0.1） |
| ≥ 2 | 另含 `GET /v1/agents`（v0.2） |
| ≥ 3 | 用户 API 密钥 + 可选局域网；`token` = 设置页密钥（v0.3） |
| ≥ 4 | agents 项含 `description`（主智能体 = 主对话角色定义）（v0.4） |

## 产品面（KepCup）

1. **扩展中心 →「本机应用协作」**：InkCop 卡片 = 启停勾选（标题后桥状态 chip）+ 说明「启用之后，Bot 详情中可以设置连接 InkCop 智能体」+ **API 密钥** + 可选 **服务地址**。不预置系统 Bot。
2. **协作开启时**：任意 Bot 详情可多选「关联 InkCop 智能体」= `GET /v1/agents`（展示 name / kind / description）。勾选只写入 `runtime.inkcop_agent_keys`，**不**切换 `message_transport`，**不**整轮直连。
3. **运行时**：Bot 仍走原 LLM。关联智能体注册工具 `call_inkcop_agent`（`agent_key` 枚举为已勾选 keys；说明注入 description）。用户点名或 Bot 判断需要时调用 → `connections` + `messages` SSE → 工具结果回传 → Bot 整理后回复。
4. **协作关闭时**：Bot 详情隐藏关联设置；不发现、不注册工具、不调桥。
5. ACP `agent:inkcop` 仍为调试旁路。知识库仍直连 LoomVec。

## 设置

`settings.inkcopLocalCollab = { enabled, apiKey, baseUrl }`。

- `apiKey`：Bearer 密钥（必填才能稳定通讯）；空时同机探测可从 `endpoint.json` 的 `token` 预填。
- `baseUrl`：可选覆盖（局域网/跨机）；空则用 endpoint / `http://127.0.0.1:<port>`。
- `systemBotId` 已从设置类型移除；`settings.update` 的 patch 仍接受并忽略旧客户端的该字段。
- 设置目录登记：`agents.inkcop-local-collab`（扩展中心「本机应用协作」页签）与 `bot.inkcop-agents`（Bot 详情「关联 InkCop 智能体」锚点）均为跳转卡；密钥仍只在界面填写。

## 运行时

- 解析：`baseUrl = settings.baseUrl || endpoint.baseUrl`；`apiKey = settings.apiKey || endpoint.token`。无密钥不发请求。
- 所有 `/v1/*` 带 `Authorization: Bearer <apiKey>`；**401** → 提示「密钥无效或未配置」。
- **整轮 divert 已移除**：`shouldUseInkcopBridge` 恒为 false（兼容旧调用点）。
- **工具门控**：`inkcopAgentToolsEnabled(bot, settings)` = 协作已启用 **且** `inkcop_agent_keys` 非空。
- Legacy `runtime.message_transport === 'inkcop-local'` 不再改变发信路径；读出/写入 Bot 时清空该字段。
- `call_inkcop_agent`：**默认禁止调用**（工具描述 + 系统规则）；仅用户明确点名 / 要求移交时由模型调用。进度文案「正在调用 InkCop 智能体…」只在工具 `execute` 时出现，禁止在回合开始时出现。

## API（客户端）

- `GET /v1/health` / `agents`（含 optional `description`）/ `POST /v1/connections` / `messages`（SSE）
- 移交：`handoffToInkcopAgent`（工具内部）
- RPC：`inkcop.health`（含 `discoveredApiKey` / `discoveredBaseUrl` / `authError`）、`inkcop.listAgents`

# InkCop 同机应用协作（KepCup 侧）

契约对齐 InkCop `docs/PLANs/InkCop-KepCup 同机 Connection 桥接契约.md`（**v0.3**）。

## 版本

| endpoint.version | 能力 |
| --- | --- |
| 1 | health / connections / messages SSE（v0.1） |
| ≥ 2 | 另含 `GET /v1/agents`（v0.2） |
| ≥ 3 | 用户 API 密钥 + 可选局域网；`token` = 设置页密钥（v0.3） |

## 产品面（KepCup）

1. **扩展中心 →「本机应用协作」**：InkCop 卡片 = 启停勾选（标题后桥状态 chip）+ 说明「启用之后，Bot 详情中可以设置连接 InkCop 智能体」+ **API 密钥** + 可选 **服务地址**。不预置系统 Bot。
2. **协作开启时**：任意 Bot 详情可多选「关联 InkCop 智能体」= `GET /v1/agents`。勾选后该 Bot 对话轮经桥直连对应 `agentKey`。
3. **协作关闭时**：Bot 详情隐藏关联设置；不发现、不驱动桥。
4. ACP `agent:inkcop` 仍为调试旁路。知识库仍直连 LoomVec。

## 设置

`settings.inkcopLocalCollab = { enabled, apiKey, baseUrl, systemBotId? }`。

- `apiKey`：Bearer 密钥（必填才能稳定通讯）；空时同机探测可从 `endpoint.json` 的 `token` 预填。
- `baseUrl`：可选覆盖（局域网/跨机）；空则用 endpoint / `http://127.0.0.1:<port>`。
- `systemBotId` 仅兼容旧配置，读写忽略。

## 运行时

- 解析：`baseUrl = settings.baseUrl || endpoint.baseUrl`；`apiKey = settings.apiKey || endpoint.token`。无密钥不发请求。
- 所有 `/v1/*` 带 `Authorization: Bearer <apiKey>`；**401** → 提示「密钥无效或未配置」。
- Orchestrator：`shouldUseInkcopBridge(bot, settings)` = 协作已启用 **且** Bot 已关联智能体（或 legacy `message_transport`）。
- `runtime.inkcop_agent_keys[0]`（缺省 `main_agent`）作为 `agentKey`。

## API（客户端）

- `GET /v1/health` / `agents` / `POST /v1/connections` / `messages`（SSE）
- RPC：`inkcop.health`（含 `discoveredApiKey` / `discoveredBaseUrl` / `authError`）、`inkcop.listAgents`

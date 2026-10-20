# InkCop 同机应用协作（KepCup 侧）

契约对齐 InkCop `docs/PLANs/InkCop-KepCup 同机 Connection 桥接契约.md`（v0.2.1）。

## 版本

| endpoint.version | 能力 |
| --- | --- |
| 1 | health / connections / messages SSE（v0.1） |
| ≥ 2 | 另含 `GET /v1/agents`（v0.2） |

## 产品面（KepCup）

1. **扩展中心 →「本机应用协作」**：InkCop 卡片仅启停协作、展示桥状态、重新探测。不预置系统 Bot，无「打开 InkCop Bot」。
2. **协作开启时**：任意 Bot 详情可多选「关联 InkCop 智能体」= `GET /v1/agents`（`main_agent` 居首 + Connect 可见智能体）。勾选后该 Bot 对话轮经本机桥直连对应 `agentKey`。
3. **协作关闭时**：Bot 详情隐藏关联设置；即使 profile 仍留有 `inkcop_agent_keys`，也不发现、不驱动桥。
4. **不**在「+」菜单提供「打开 InkCop / 新建写作助理」入口。ACP `agent:inkcop` 仍为调试旁路。知识库仍直连 LoomVec。

## 设置

`settings.inkcopLocalCollab = { enabled, systemBotId? }`。`systemBotId` 仅兼容旧配置，读写忽略。

## 运行时

- Bot 勾选智能体时同步 `runtime.message_transport = 'inkcop-local'`，清空则还原 `''`。
- Orchestrator：`shouldUseInkcopBridge(bot, settings)` = 协作已启用 **且**（`message_transport === 'inkcop-local'` 或 `inkcop_agent_keys` 非空）。
- `runtime.inkcop_agent_keys[0]`（缺省 `main_agent`）作为 `agentKey`；`externalId = kepcup-bot-{id}`（非 `main_agent` 时加 `--{agentKey}`）。

## API（客户端）

- `GET /v1/agents` → `{ ok, agents: [{ key, name, kind: 'main'|'app' }] }`
- `POST /v1/connections` / `messages` 语义同 v0.1。

RPC：`inkcop.health`、`inkcop.listAgents`（version < 2 时 listAgents 回落为仅主智能体）。

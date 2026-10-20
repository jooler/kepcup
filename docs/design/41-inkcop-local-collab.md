# InkCop 同机应用协作（KepCup 侧）

契约对齐 InkCop `docs/PLANs/InkCop-KepCup 同机 Connection 桥接契约.md`。

## 版本

| endpoint.version | 能力 |
| --- | --- |
| 1 | health / connections / messages SSE（v0.1） |
| ≥ 2 | 另含 `GET /v1/agents`（v0.2） |

## 产品面（KepCup）

1. **扩展中心 →「本机应用协作」**：InkCop 卡片启停。开 = 探测桥 + 确保系统 Bot「InkCop」出现在侧栏；关 = 隐藏该 Bot/私聊，不删历史。
2. **任意 Bot 详情**：多选「关联 InkCop 智能体」= `GET /v1/agents` 列表（`main_agent` 居首 + Connect 可见智能体）。
3. **运行时**：`message_transport: inkcop-local` 的 Bot 发信走本机桥；`runtime.inkcop_agent_keys[0]`（缺省 `main_agent`）作为 `agentKey` 建连。P0 不做静默自动路由；ACP 仍为调试旁路。

## 设置

`settings.inkcopLocalCollab = { enabled, systemBotId }`。

## API（客户端）

- `GET /v1/agents` → `{ ok, agents: [{ key, name, kind: 'main'|'app' }] }`
- `POST /v1/connections` / `messages` 语义同 v0.1；同一 Bot 多 agent 时 `externalId = kepcup-bot-{id}--{agentKey}`（`main_agent` 不加后缀）。

RPC：`inkcop.health`、`inkcop.listAgents`（version < 2 时 listAgents 回落为仅主智能体）。

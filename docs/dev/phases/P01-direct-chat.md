# P01 单聊最小闭环

## 目标

用户可以配置模型、创建 Bot、在单聊中通过待发送队列发消息；Bot 在独立的响应 loop 中处理并回复；执行中可以注入新消息、可以取消；执行过程完整记录；删除对话、删除 Bot 的语义正确。本阶段 Bot 没有文件与命令能力。

## 依赖

P00。

## 设计依据

- [design/01-conversation.md](../../design/01-conversation.md)（通讯录、单聊、待发送队列、消息模型、删除）
- [design/02-execution.md](../../design/02-execution.md)（串行队列、注入、执行记录、上下文注入、撤回与编辑）
- [design/03-bot.md](../../design/03-bot.md)（Profile、生命周期）
- [design/14-models-and-browser.md](../../design/14-models-and-browser.md#模型配置)（模型配置）
- [design/12-ui-layout.md](../../design/12-ui-layout.md)（输入区与消息流的交互反馈）
- [03-data-model.md](../03-data-model.md)、[04-agent-runtime.md](../04-agent-runtime.md)

## 范围

包含：

- 设置页：模型厂商与 API key、自定义接口（OpenAI 兼容 / Ollama 的 `baseUrl`）、默认主模型、默认轻量模型、厂商并发上限。
- API key 存入 secrets 表（字段级加密）；界面只显示掩码；“测试连接”按钮。
- Bot：新建、编辑 Profile（identity、persona、role、boundaries、runtime.model / light_model）、删除；通讯录页。
- 单聊：从通讯录点击 Bot 打开（不存在则创建）单聊；对话列表（最近消息、时间、未读数、正在执行标记）。
- 消息：列表（虚拟滚动、markdown 渲染、代码高亮）、附件（拖入或选择文件；图片预览；其他显示文件卡片）。
- 待发送队列：完整语义（design/01-conversation.md#输入与待发送队列）、持久化、编辑、排序、删除、`Cmd/Ctrl+Enter`。
- 撤回与编辑已发出的用户消息。
- AgentEngine（pi 封装）、Mailbox、调度器（优先级 0 与 2、厂商并发上限）、执行记录与步骤、用量账本。
- 上下文组装：`<platform_rules>`（本阶段适用的规则 1、2、5）、`<identity>`、`<persona>`、`<conversation_info>`、对话上下文段、触发段、注入格式。
- 工具：`send_message`（不含附件参数）、`skip_reply`、`search_messages`、`get_messages_around`、`get_attachment`（仅文本类）、`list_my_runs`、`get_run`。
- 执行状态与步骤说明的界面展示；取消执行；失败后重试。
- 对话滚动摘要（后台任务 `conversation_summary`，轻量模型）。
- 启动时处理中断的执行。
- 删除对话、删除 Bot（本阶段范围内的级联，见 [03-data-model.md](../03-data-model.md#删除级联)）。
- 端到端测试接入 CI。

不包含：

- 文件、命令、workspace（P02）；群聊（P05）；记忆（P07）；右栏除“配置”外的标签页（记忆、Skills、Wiki 显示“即将推出”占位）。

## 任务

1. **设置与密钥**
   - `domain/settings.ts`、`domain/secrets.ts`：secrets 的增删改查，值只在 `getApiKey` 回调中解密。
   - 厂商列表来自 pi-ai 的模型注册表；自定义接口可以填写 `baseUrl`、模型 id、上下文长度。
   - “测试连接”：用最小请求验证 key 可用，返回成功或错误码（`PROVIDER_AUTH_FAILED`、`PROVIDER_UNREACHABLE`）。
2. **Bot 与通讯录**
   - `domain/bots.ts`：创建时校验 Profile（zod）；`bots.list` 只返回 `active`。
   - 界面：通讯录页（卡片列表、新建按钮）；新建 Bot 对话框；右栏“配置”标签页编辑 Profile（表单 + 保存）。
3. **对话与消息**
   - `domain/conversations.ts`、`domain/messages.ts`：`seq` 在对话内单调递增（事务内 `last_seq + 1`）；写入消息时同步 `messages_fts`（经 `text-segment`）。
   - 单聊打开：`conversations.openDirect(botId)`，存在则返回，否则创建（含成员行）。
   - 未读：界面在对话可见且滚动到底部时调用 `conversations.markRead(seq)`。
4. **待发送队列**
   - `domain/drafts.ts`：`drafts.add`、`drafts.update`、`drafts.reorder`、`drafts.remove`、`drafts.flush`。
   - `flush`：在一个事务中把全部草稿按 `position` 转为消息（共享 `batch_id`，附件从草稿转到消息），删除草稿，然后把批次交给 Mailbox。
   - 界面按键：输入框有内容时 Enter → `drafts.add`；输入框为空且队列非空时 Enter → `drafts.flush`；`Cmd/Ctrl+Enter` → 有内容则先 add 再 flush；`Shift+Enter` 换行。输入法组合输入期间（`isComposing`）Enter 不触发。
5. **执行**
   - `agent/pi-engine.ts`：按 [04-agent-runtime.md](../04-agent-runtime.md#pi-的封装) 实现。
   - `scheduler/`：优先级队列、厂商并发上限、Mailbox（key 为 `botId:conversationId`）。
   - `agent/context/`：各段组装与预算截断；`agent/tokens.ts`。
   - `domain/runs.ts`：执行状态机（[02-architecture.md](../02-architecture.md#执行run状态机)）；步骤写入 runs.db（`request` 步骤记录完整上下文，已脱敏）。
   - 最终文本写为 Bot 消息；`send_message` 即时写入并推送事件。
   - 取消：`runs.cancel(runId)` → `abort` → 状态 `cancelled`，已发出的消息保留。
   - 失败：对话中显示失败提示（错误码映射为中文，例如 key 无效时提示去设置页）与“重试”按钮；重试用同一批触发消息创建新执行。
6. **撤回与编辑**
   - `messages.recall(id)`、`messages.edit(id, text)`：仅限用户消息。
   - 处理规则按 [design/02-execution.md](../../design/02-execution.md#撤回与编辑)：正在运行的执行已读过 → 注入通知；执行已结束 → 编辑作为 `event` 触发交给 Mailbox（撤回不触发新执行）。
7. **对话摘要**：未被摘要覆盖的消息数超过 `SUMMARY_TRIGGER_UNSUMMARIZED` 时登记 `conversation_summary` 任务（`dedupe_key` 为对话 id）；完成后更新 `summary` 与 `summary_upto_seq`。
8. **生命周期**（`domain/lifecycle.ts`）
   - 删除对话：确认对话框 → 取消执行 → 按级联表删除 → 推送事件。
   - 删除 Bot：弹框（本阶段统计：对话数、消息数）→ 取消该 Bot 全部执行 → Bot 行改为占位 → 单聊改为只读并清空待发送队列 → 删除该 Bot 执行记录 → 删除 `bots/{id}/` 目录。
   - 只读对话：输入区替换为“该 Bot 已被删除，对话为只读”提示；仍可删除对话。
9. **启动恢复**：按 [02-architecture.md](../02-architecture.md#执行run状态机) 处理中断的执行。
10. **界面**
    - 左栏对话列表：头像、名称、最近消息预览、时间、未读数、正在执行的小圆点。
    - 中栏：消息列表（虚拟滚动；用户在底部时自动滚动，否则显示“有新消息”）、Bot 状态行（头像 + “正在思考” / 步骤说明 + 取消按钮，可展开查看步骤）、待发送队列、输入框（队列非空且输入框为空时显示“再按 Enter 发送 N 条消息”）。
    - 交互反馈按 [design/12-ui-layout.md](../../design/12-ui-layout.md#交互反馈) 中“焦点一”“焦点二”实现（本阶段不含 @ 与 project 选择器）。
    - 所有界面文案放入 `i18n/zh-CN.ts`。

## 接口与数据

新增表（main.db）：`secrets`、`bots`、`conversations`、`conversation_members`、`messages`、`messages_fts`、`attachments`、`drafts`、`jobs`、`usage_ledger`；runs.db：`runs`、`run_steps`。

RPC 方法（不限于）：

| 方法 | 说明 |
|---|---|
| `settings.get` / `settings.update` | |
| `providers.list` / `providers.setKey` / `providers.removeKey` / `providers.test` | `setKey` 只接收，永不返回 key |
| `bots.list` / `bots.get` / `bots.create` / `bots.update` / `bots.delete` / `bots.deletionPreview` | |
| `conversations.list` / `conversations.openDirect` / `conversations.delete` / `conversations.markRead` | |
| `messages.list`（分页，按 seq）/ `messages.recall` / `messages.edit` | |
| `drafts.list` / `drafts.add` / `drafts.update` / `drafts.reorder` / `drafts.remove` / `drafts.flush` | |
| `attachments.upload`（文件路径或字节）/ `attachments.get` | |
| `runs.cancel` / `runs.retry` / `runs.steps` | |

事件：`message.created`、`message.updated`、`conversation.updated`、`conversation.deleted`、`draft.changed`、`run.status`、`run.progress`、`bot.updated`、`bot.deleted`。

## 测试要求

- 单元：待发送队列按键逻辑（含输入法组合输入）；上下文组装（各段顺序、预算截断、自己消息标注“（你）”、撤回消息不出现）；token 估算；状态机转换。
- 集成（模拟模型服务）：
  - 一批 3 条消息 → 3 条独立消息、1 次执行、`trigger_message_ids` 含 3 个 id。
  - 执行中 flush 新批次 → 模拟服务在下一次请求中收到 `<new_messages>`，且不创建第二个执行。
  - 执行中取消 → 状态 `cancelled`，已通过 `send_message` 发出的消息保留。
  - `send_message` 两次 + 最终文本 → 3 条 Bot 消息；`skip_reply` → 无最终消息。
  - 模拟 401 → 执行 `failed`，错误码 `PROVIDER_AUTH_FAILED`；重试成功。
  - 同一厂商并发上限为 1 时，两个对话的执行排队依次进行。
  - 撤回已被读过的消息 → 注入通知；执行结束后编辑 → 触发新执行；撤回后的消息不出现在后续上下文中。
  - 摘要任务在阈值后登记，完成后上下文中出现 `<summary>`。
  - 启动时存在 `running` 执行 → 变为 `interrupted` 并插入系统消息。
  - 删除对话 → 相关表与附件文件全部清除；再次打开单聊得到新的对话 id。
  - 删除 Bot → 单聊只读、名称显示为 id、执行被取消、`bots/{id}/` 不存在；新建 Bot 的 id 不同。
- 安全用例：API key 明文不出现在日志、runs.db、RPC 返回与事件、发给模型的请求中（用模拟服务的请求记录与全文检索验证）。
- 端到端：待发送队列全流程（加入、编辑、排序、删除、Enter 发出、`Cmd/Ctrl+Enter`、重启后队列仍在）；发送后出现 Bot 状态行；收到回复；取消；删除对话；删除 Bot 后对话只读。

## 验收标准

- [ ] 在设置页配置 API key 后，重启应用仍可用；界面任何位置都看不到 key 明文。
- [ ] “测试连接”对有效 key 显示成功，对无效 key 显示明确的中文错误。
- [ ] 新建 Bot 后出现在通讯录；点击进入单聊；再次点击进入同一对话。
- [ ] 待发送队列行为与 design/01-conversation.md 完全一致，含 `Cmd/Ctrl+Enter`、输入法兼容、重启后保留。
- [ ] 一批消息显示为多个独立气泡，只触发一次执行。
- [ ] Bot 执行期间，消息流末尾显示 Bot 状态与步骤说明；可以取消。
- [ ] 执行期间追加发送的消息，在下一步送达 Bot（Bot 的后续回复体现了新消息内容）。
- [ ] Bot 可以在一次执行中发送多条消息。
- [ ] 失败时对话中出现可理解的原因与重试按钮，重试有效。
- [ ] 撤回与编辑行为符合设计文档中的表格。
- [ ] 应用在执行中退出，重启后该执行显示为中断，对话中有系统提示。
- [ ] 删除对话、删除 Bot 的级联符合 03-data-model.md 中本阶段的条目。
- [ ] runs.db 中可以看到每次请求的完整上下文（已脱敏）与每个步骤。
- [ ] usage_ledger 中记录了每次调用的用量。
- [ ] 本阶段的集成测试、安全用例、端到端测试全部通过（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)），端到端测试已加入 CI。
- [ ] 手工冒烟：用真实厂商完成 [05-testing.md](../05-testing.md#手工冒烟清单真实模型) 中的通用步骤 1～4。

## 注意事项

- 草稿转消息与交给 Mailbox 的顺序：先提交事务，再投递；投递失败不回滚消息（消息已发出，执行可以重试）。
- `send_message` 在执行被取消后调用应被拒绝（执行身份已失效）。
- 消息列表分页加载，打开长对话时只加载最近一屏。
- 群聊相关的字段（mentions、batch 的多目标分发）本阶段只需正确存储，不需要处理。

# Loop 中间过程投送与执行状态展示（规划稿，待审查）

> 状态：**已实现并验收（2026-10-04）**。决策见第 8 节，改动清单见第 5 节（全部勾销）；实现与测试证据记录在 `docs/dev/PROGRESS.md` 同名小节。

## 1. 背景与目标

当前 Bot 处理长任务时，对话里只有用户消息和（loop 结束后才出现的）最终回复，中间是长达数十秒到几分钟的静默，用户只能看到一行粗粒度状态（「正在思考…」/工具自报文本），产生等待焦虑。

目标：

1. **中间文本投送**——loop 过程中，模型写在「带工具调用的 assistant 消息」里的说明文字（如「收到，我来处理…」「让我再检索一些 XXX…」）作为真实 bot 消息投送进对话，用户能看到执行叙事。
2. **提示词约束**——要求模型：收到消息后第一次调用工具前必须先说明打算怎么做；中途在关键节点输出必要文字；其余工具调用尽量不附带文字；最终回复仍是完整结果。
3. **执行状态展示**——处理过程中，消息流末尾以状态行展示当前阶段（请稍等… / 正在调用工具 AAA / …），工具名称随调用同步更新；新消息到达时状态行让位，如此交替直到最终回答出现。

预期对话列表效果（参考截图）：

```
用户消息
[状态行] 请稍等…
→ 状态行被顶替，第一条 bot 消息：收到，我来处理…
[状态行] 正在调用工具 bash…（持续调用时仅工具名更新）
→ 状态行让位，中间消息：让我再检索一些 XXX…
[状态行] 正在调用检索工具…
→ … 循环 …
最终回复消息（状态行消失）
```

## 2. 现状追溯（链路结论）

端到端时序（全部已核实，行号为当前工作区）：

1. **发送**：Composer Enter → `chat.flush()` → RPC `drafts.flush` → `Orchestrator.flushDrafts`（`packages/core/src/dispatch/orchestrator.ts:302`）：用户消息落库（kind='text'）→ 逐条 publish `message.created` → UI 立即显示用户气泡。
2. **触发**：单聊经 `Mailbox.deliver`（`packages/core/src/scheduler/mailbox.ts:60`）→ `#startResponseRun`（orchestrator.ts:974）创建 run（status='queued'）并 publish `run.status` → scheduler 按「Bot+对话」串行执行 `#executeResponseRun`（orchestrator.ts:1019）。运行中收到新消息走 steer 注入，不开新 run。
3. **Loop 执行**：`PiEngine.startRun`（`packages/core/src/agent/pi-engine.ts:49`）驱动 pi agentic loop（≤ `RUN_MAX_TURNS=60`，`packages/shared/src/constants.ts:41`）。引擎事件 `request / assistant / tool_call / tool_result / progress / steer` 全部**只**落 `run_steps` 表（`#persistSteps`，orchestrator.ts:1423）；仅工具自报的 `progress` 额外 publish `run.progress` 事件（orchestrator.ts:1453-1460）。
4. **关键缺口**：模型带工具调用的 assistant 消息，其文本在 `assistant` 引擎事件里已经存在（`pi-engine.ts:243-250`，负载 `{text, stopReason, errorMessage}`），但目前只进 `run_steps`，**用户完全看不到**。中途唯一的对话通道是 `send_message` 工具（`packages/core/src/tools/index.ts:148-219` → `onBotMessage`，orchestrator.ts:1126-1136），靠模型自觉调用。
5. **结束**：`outcome.finalText` = 最后一条 `stopReason === 'stop'` 的 assistant 文本（`pi-engine.ts:396-404`；`toolUse` 为中间消息、skip_reply 终止时为空）→ 非空则 `messages.append` + publish `message.created`（orchestrator.ts:1327-1344）。**整条一次性推送，无流式 delta**。
6. **UI 现状**：`RunStatusLine.svelte` 挂在**输入坞**（`ChatView.svelte:190-196`，消息列表之外、底部固定），显示「排队中…/正在思考…/run.progress 文本」，可展开 run_steps、取消；群聊另有 `GroupTurnStatusLine`；侧栏有运行中绿点。事件订阅在 `chat.svelte.ts:81-147`（`#applyRun` 维护 `activeRuns` 与每 run 的 progress 文本）。

相关类型事实：

- pi `StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`（pi-ai types.d.ts:292）——**中间消息的判定标记就是 `stopReason === 'toolUse'`**。
- 消息 kind 仅 `'text' | 'system_event' | 'card'`（`packages/shared/src/domain/types.ts:294`），无状态类消息——状态行是临时 UI 元素，不是消息，本规划维持这一点。
- `buildSystemPrompt`（含 `PLATFORM_RULES`，`packages/core/src/agent/context/system-prompt.ts:56-67`）**仅被响应 loop 使用**；wiki 维护 / 技能生成 loop 用各自的 prompt（`maintenance.ts:109`、`authoring.ts:122`），改规则不影响后台 loop。

## 3. 与设计文档的对照

| 设计约定 | 关系 |
|---|---|
| 01-conversation「像真人的交互表现」：执行期间显示「正在处理」状态；一次 loop 可发多条消息（先确认收到、中途同步进展、最后交付）；整条发送不做逐字流式 | **完全一致**。本规划把这些约定从「靠 send_message 自觉」变成「中间文本自动投送 + 状态行」的机制化落地，仍不做逐字流式 |
| 02-execution「对话里只保存最终消息，中间过程不进对话」 | **需要修订**：进对话的边界从「只有最终消息」放宽为「模型写给用户看的中间说明文字 + 最终消息」；工具调用、工具输出等过程数据仍只进 run_steps，不进对话 |
| 12-ui-layout「焦点二：消息流末尾」：Bot 状态 = 头像 + 状态文字，每步更新，可展开执行步骤 | **现状未对齐**（状态行在输入坞、无头像）。本规划将状态行移入消息流末尾，与设计及参考截图一致 |
| 15-interactive-execution「执行步骤面板即 Bot 状态行展开」 | 保持：状态行展开后仍是 run_steps 步骤列表，交互命令的实时输出跟随该面板（不改动） |

需同步修订的设计文档（推进时完成，见改动清单阶段 4）：`02-execution.md`（Bot 如何发消息）、`01-conversation.md`（交互表现）、`12-ui-layout.md`（焦点二细化）、`docs/design/README.md`（决策记录，新增 D54 起）。

## 4. 方案设计

### 4.1 core：中间文本投送（核心改动）

在 `#executeResponseRun` 中订阅引擎事件（与 `#persistSteps` 同一事件流上再加一个监听，或并入同一 switch）：当

- `event.type === 'assistant'`，且
- `event.payload.stopReason === 'toolUse'`（即该消息还带着工具调用、loop 将继续；`stop` 是最终回复走既有落库，`error/aborted` 不投），且
- `event.payload.text.trim()` 非空

则把 text 作为真实 bot 消息落库并推送：`messages.append({ conversationId, senderType: 'bot', senderBotId, kind: 'text', text, runId })` → 追加 `run.outputMessageIds` → publish `message.created` → `#publishConversation`。落库路径与 `onBotMessage`（orchestrator.ts:1126-1136）完全同构，抽一个 `#appendBotMessage(runId, batch, text)` 私有方法供两处复用。

细节与护栏：

- **不与最终消息重复**：最终消息只来自 `stopReason === 'stop'` 的最后一条（pi-engine.ts:396-404），与中间消息天然不相交。
- **防刷屏护栏**：每 run 中间投送上限 `INTERIM_TEXT_MAX_PER_RUN = 8` 条，超限后只记 `run_steps`、不投送（模型失控时的兜底）；单条 `INTERIM_TEXT_MAX_CHARS = 2000` 字符，超长截断加「…」。两个常量放 `packages/shared/src/constants.ts`。
- **异常终态不回滚**：run 后续失败/取消/skip_reply 时，已投送的中间消息保留——它们是已发生的沟通，且让失败上下文可读（配合既有失败横幅）。
- **上下文影响**：中间消息进入 messages 表后，会出现在后续 turn 的 `<conversation_context>` 最近 120 条窗口与 rolling summary 里，模型能看到自己说过什么——这是期望行为；长任务的窗口挤占由既有 rolling summary 机制缓解。
- **群聊**：同一链路自动生效（bot 在群里同步进展同样自然）；如担心多 Bot 叠加刷屏，群聊可复用同一护栏（决策点 4）。
- **无 DB 迁移**：复用 kind='text'；无新表、无新列。

### 4.2 core：工具调用状态推送

现状 `run.progress` 只有工具自报文本（很多工具调用没有），UI 无法显示「正在调用工具 X」。最小改动：

- `packages/shared/src/rpc/events.ts:40-45`：`run.progress` 负载增加可选字段 `toolName?: string`（向后兼容）。
- orchestrator `#persistSteps` 的 `case 'tool_call'`（orchestrator.ts:1436-1442）：追加 publish `run.progress` `{ runId, conversationId, toolName }`。
- 工具自报 `progress`（有更精确文案，如「正在执行命令 …」）维持现状推 `text`；两者共用一个事件，renderer 按优先级取用。

### 4.3 提示词约束

修改 `PLATFORM_RULES`（system-prompt.ts:56-67）规则 2 并新增一条过程沟通规则（草案，推进时润色）：

> - 你的最终回复会自动作为一条聊天消息发出；回复保持聊天风格，不要写成报告，除非用户要求。
> - 在对话中执行任务时：收到任务后，第一次调用工具前，先用一两句话说明你打算怎么做（写在工具调用的同一条回复文本里，会展示给用户）；任务中途在关键节点（更换思路、拿到重要中间结果、遇到阻碍）再用一两句话同步进展；其余工具调用不要附带文字。最终交付仍以最终回复为准，不要把完整结果提前倾倒进中间说明。
> - 中间进展直接写在回复文本里，不要用 send_message 发进度；send_message 只用于 @ 其他成员、发附件或主动分多条消息。

要点：明确「中间说明会展示给用户」（给模型一个为何要写的理由）、「其余时候不带文字」（防噪声）、「send_message 不用于进度」（避免与自动投送双通道重复）。已确认这些规则只影响响应 loop。

### 4.4 渲染层：消息流末尾状态行 + 文案状态机

**落位（实现后经评审修订样式）**：`RunStatusLine` 从输入坞（ChatView.svelte:194-196）移入 `MessageList` 列表末尾渲染——消息流内、跟随滚动；样式为极简的**绿点 + 状态文字**（无边框、无背景，**不提供取消按钮与执行步骤展开**——初版的头像卡片样式已废弃，最终样式以 `12-ui-layout.md`「焦点二」为准）。群聊 `GroupTurnStatusLine` 一并移入消息流末尾（决策点 2）。

**文案状态机**（`chat.svelte.ts` 的 run entry 扩展 `{ progress?, toolName?, phase }`，由 `run.status` / `run.progress` / `message.created` 三个事件驱动）：

| 条件 | 状态行显示 |
|---|---|
| run queued | 排队中…（现状文案） |
| running 且该 run 尚无任何已投送输出 | 请稍等…（新 i18n key `runStatus.pleaseWait`，替代现状首屏「正在思考…」） |
| 最近事件为 tool_call | 正在调用「工具名」…（`runStatus.callingTool`；工具名 → 本地化动词短语映射表：bash→正在执行命令、read→正在读取文件、browser_*→正在操作浏览器…未识别回退「正在调用 {toolName}」） |
| 最近事件为 progress（工具自报） | 工具自报文本（现状行为） |
| 该 run 名下有新 bot 消息落库（message.created 且 message.runId 匹配） | 状态行让位：隐藏文字，直到下一个 tool_call / progress 事件 |
| run 终态 | 状态行整行移除（现状行为） |

优先级（实现口径）：租约等待 > 排队 > 最近事件优先（progress 自报文本覆盖 toolName 标签，下一个 tool_call 重置为标签）> 请稍等（running 无任何输出）。muted（本 run 刚有消息落库）时整行隐藏，下一个活动事件重现——贴合「状态提示消失」的节奏。

**i18n**（`apps/desktop/src/renderer/src/lib/i18n/locales/zh-CN.ts`，现有 runStatus 键在 51-55 行）：新增 `runStatus.pleaseWait`、`runStatus.callingTool`，及工具名映射表（可先放 renderer 常量，条目以 `packages/core/src/tools/` 的工具清单为准）。

## 5. 改动清单（2026-10-04 实现完成）

阶段 1 —— core 投送与事件（先行，UI 可独立验收）：

- [x] shared：`run.progress` 事件负载加 `toolName?`（`packages/shared/src/rpc/events.ts`）
- [x] shared：护栏常量 `INTERIM_TEXT_MAX_PER_RUN` / `INTERIM_TEXT_MAX_PER_RUN_GROUP` / `INTERIM_TEXT_MAX_CHARS`（`packages/shared/src/constants.ts`）
- [x] core：`#recordBotMessage` 抽取 + 中间文本投送 `#deliverInterimTexts`（`orchestrator.ts` `#executeResponseRun` 事件流，条件 `stopReason === 'toolUse'` + 非空文本 + 护栏；send_message、最终消息与中间消息共用落库路径）
- [x] core：`case 'tool_call'` publish `run.progress` 带 toolName
- [x] core 集成测试（`packages/core/test/integration/response-loop.test.ts` 增补 5 例）：①带文本的 toolUse assistant 消息按序投送且 runId/outputMessageIds 完整；②无文本工具调用不投送；③护栏上限生效（第 9 条不投、run_steps 仍完整）；④run.progress 带 toolName；⑤群聊护栏 4 条。testkit 新增 `replyTextAndToolCall`（流式与非流式均支持文本+工具调用混合回复）

阶段 2 —— 提示词：

- [x] `PLATFORM_RULES` 修改（`system-prompt.ts`：规则 2 拆为 2/3/4 三条，规则 3 约束过程沟通、规则 4 禁止 send_message 发进度）；`docs/dev/04-agent-runtime.md` platform_rules 清单同步（补齐此前遗漏的 propose_profile_change 规则）

阶段 3 —— 渲染层：

- [x] `chat.svelte.ts`：`ActiveRunView` 扩展 toolName/muted；message.created 时让位；`run.progress` 新字段消费（tool_call 置 toolName、progress 置文本）
- [x] `RunStatusLine.svelte`：接收 entry、极简样式（绿点 + 状态文字，无头像/取消/展开——评审修订）、文案状态机（排队/请稍等/正在调用工具/自报文本）、muted 整行隐藏
- [x] `MessageList.svelte`：状态行渲染在消息流末尾（下一条消息出现的位置）+ 贴底跟随；`ChatView.svelte` 输入坞移除两行状态组件；`GroupTurnStatusLine` 一并移入消息流末尾（决策点 2）
- [x] i18n：`runStatus.pleaseWait` / `runStatus.callingVerb` / `runStatus.callingTool`（zh-CN.ts，移除不再使用的 `runStatus.thinking`）；`tool-labels.ts` 工具动词映射（含 browser_* 归并）
- [x] e2e（新增 `apps/desktop/test/e2e/loop-progress.spec.ts`，mock 驱动 + 分步 hold 释放）：请稍等 → 工具动词标签 → 中间消息让位后标签重现 → 第二条中间消息 → 最终回复 → 状态行消失；并断言状态行在消息列表内、不在输入坞

阶段 4 —— 设计文档同步（与实现同批完成）：

- [x] `docs/design/02-execution.md`：「Bot 如何发消息」补中间说明文字自动投送及其边界
- [x] `docs/design/01-conversation.md`：「像真人的交互表现」补状态行节奏描述
- [x] `docs/design/12-ui-layout.md`：「焦点二」细化状态行落位（消息流末尾、头像、让位节奏）
- [x] `docs/design/README.md`：决策记录 D54（中间过程投送）、D55（执行状态行）
- [x] `docs/dev/04-agent-runtime.md`：`<platform_rules>` 清单与新规则同步

## 6. 验收口径

1. 长任务（多工具调用）中，用户在对话里依次看到：状态行「请稍等…」→ 首条中间消息（说明打算怎么做）→ 「正在调用工具 X…」（工具名随调用更新）→ 关键节点中间消息 → … → 最终回复，全程无长静默。
2. 模型被提示词约束后，非关键工具调用不带文字，对话不被无意义中间文本刷屏（护栏兜底）。
3. 中间过程数据（工具调用/结果）仍只在执行记录（run_steps）中，展开状态行可查，对话流中不出现。
4. 群聊与直聊行为一致；失败/取消时已有中间消息保留 + 失败横幅可重试（现状行为不回归）。
5. 既有测试全绿：core `pnpm test`、desktop e2e（含 `direct-chat.spec.ts` 等既有用例无回归）。

## 7. 风险

- **上下文窗口挤占**：中间消息计入最近 120 条窗口，长任务可能挤掉更早历史——由 rolling summary 缓解；若实测不佳，可把中间消息在上下文渲染时压缩为摘要（后续迭代，不在本期）。
- **模型不遵守提示词**（中间文字过多/过少）：提示词约束 + 数值护栏双保险；护栏超限静默降级只记 run_steps，不影响 loop。
- **UI 跳动**：状态行「让位/重现」节奏若处理生硬会有视觉跳动；实现时以淡入淡出过渡，必要时保留占位高度。
- **用量与计费无变化**：不新增模型请求，仅消息投送与事件推送。

## 8. 待决策点（2026-10-04 已拍板）

1. **状态行落位**：✅ 消息流末尾内联 + 头像。补充要求（用户明确）：提示必须位于**最后一条 Bot 消息的下方**，其位置就是**下一条消息将会出现的位置**——即状态行作为消息流的一部分参与排版，不是悬浮在输入组件上方的固定条。
2. **群聊状态行**：✅ `GroupTurnStatusLine` 一并移入消息流末尾。
3. **护栏参数**：✅ 每 run 中间消息上限 8 条、单条截断 2000 字符。
4. **群聊护栏**：✅ 群聊用更低护栏：每 run 上限 4 条（单条截断长度不变）。
5. **中间消息的会话副作用**：✅ 计入侧栏预览/未读数（像真人多条发言）。
6. **提示词**：✅ 明令禁止用 send_message 发进度，中间说明直接写在回复文本里。

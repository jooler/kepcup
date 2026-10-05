# 对话内设置引导（Inline Setup）：缺配置时在消息流里完成设置

> 状态：**已实现并验收（2026-10-04）**。设计见 `docs/design/18-inline-setup.md`（决策 D58），阶段文档见 `docs/dev/phases/P15-inline-setup.md`。改动清单见第 5 节（全部勾销）。

## 1. 背景与目标

许多功能依赖提前设置（默认主模型、图像生成等能力模型）才能执行。逐一教育用户"先去设置页配置"成本太高、容易吓退用户。目标：**在用户调用某个未正确设置的功能的那一刻，在对话消息列表中就地呈现对应的设置组件**，用户完成设置后对话自动继续。

两个锚定场景：

1. 用户创建第一个 Bot、发出第一条消息时，检查 Bot 是否有可用模型（Bot 未指定且全局无默认主模型）；没有则在消息列表呈现模型设置卡片（选供应商 → 填表单 → 设默认模型 → 可选指定 Bot 模型），确认后对话继续。
2. 用户让 Bot 生成图片但未配置图像生成模型时，消息列表出现图像模型设置卡片；完成后刚才的任务自动继续执行。

原则：**设置组件与设置页同一份事实**（同一批保存 RPC），拆分设置页组件以便在对话内复用；引导发生在"用到的时刻"，而不是启动时的集中教育。

## 2. 现状追溯（链路结论）

- 模型解析：`orchestrator.#executeResponseRun` 开头 `bot.runtime.model || settings.defaultMainModel`，为空 → run 直接 `failed`（纯文本错误，走 ChatView 顶部失败横幅，无结构化信息、不可引导）。
- 能力模型：`MediaService.#resolve` 在 `capabilityModels[capability] === null` 时抛 `INVALID_INPUT`；但**目前没有任何 Bot 工具消费图像生成**——`media.generateImage` 仅为 RPC 预留，"用户要求生成图片"路径不存在，需要补 `generate_image` 工具。
- 消息内交互已有成熟范式：`SetupQuestionCard`（system_event 消息 + 专用卡片组件 + 专用 RPC）；run 失败 → `run.status` 事件 → `chat.failedRun` → 失败横幅；`runs.retry` 已存在（仅 failed 可重试）。
- 引擎行为约束（`pi-engine.ts`）：工具抛错不会中断 run（转为工具结果继续循环）；`terminate` 产出 completed；`abort` 产出 cancelled——工具侧的"需要设置"必须由 orchestrator 监听 `tool_result` 事件后主动 abort，并在 settle 时改判。
- 设置组件：`CapabilityModelSection` 已 props 化可直接复用；供应商新增/设 Key 表单（三分支：国内厂商/自定义/内置）内嵌在 `ModelsSection` 的弹框里，需拆分；主/轻量模型下拉逻辑简单可抽取。
- e2e：`KEPCUP_MOCK_LLM_URL` 会自动 seed mock 供应商并设置默认模型（`start.ts seedMockLlm`）——"无模型"场景的 e2e 不能带该环境变量，需在卡片表单里手动添加指向 mock 的自定义供应商。

## 3. 方案设计

### 3.1 结构化"设置前置需求"（SetupRequirement）

- shared 新类型：`{ kind: 'main-model' } | { kind: 'capability-model', capability }`。
- `runSchema` 增 `setup` 字段（nullable）；runs 表 `error_json` 扩为 `{ message, setup? }`（无迁移）。run 失败可携带机器可读的"缺什么设置"。
- 触发点 1（主模型）：`#executeResponseRun` 模型检查失败时，settle `failed` + `setup={kind:'main-model'}`。
- 触发点 2（能力模型）：新 `generate_image` 工具在图像能力未配置 / 厂商缺 Key 时返回 `errorCode: 'SETUP_REQUIRED'`；orchestrator 的 media facade 捕获对应 AppError 记下 requirement，监听 tool_result 事件 `abort` 该 run，settle 时改判 `failed` + `setup={kind:'capability-model', capability:'image'}`（retry 需要 failed 状态）。`MediaService` 未配置错误改用新错误码 `CAPABILITY_NOT_CONFIGURED`，避免误伤其他 INVALID_INPUT。

### 3.2 对话内设置卡片（渲染层，两条来源汇合）

卡片 = 消息列表末尾的常驻交互区（`SetupRequiredCard.svelte`），来源优先级：

1. **发送门禁**（chat store）：`flush()/flushOne()` 前检查单聊 Bot 是否有可用模型；缺失则不发送（草稿留在队列、无失败 run），置 `pendingSetup` 显示卡片；完成后自动冲队列。
2. **结构化失败**（core）：`failedRun.setup` 非空时卡片替代失败横幅（ChatView 抑制横幅）；完成后 `dismissFailedRun + runs.retry` 自动续跑（覆盖访谈回答、群聊、图像工具等所有 core 侧路径）。

卡片内容按 requirement 分发：

- `main-model`：无已配置供应商时先内嵌 `ProviderSetupForm`（从 ModelsSection 弹框拆出，同一份保存逻辑）；之后选默认主模型 + 可选"该 Bot 的模型"（bots.update），确认后继续。
- `capability-model`：内嵌 `CapabilityModelSection`（新增 `embedded` / `onSaved` props），保存即继续。

### 3.3 设置组件拆分（复用，不改行为）

- `ProviderSetupForm.svelte`：ModelsSection 新增/设 Key/编辑弹框的表单体 + 保存/测试按钮整体拆出（`mode`/`target`/`testidPrefix` props，`onSaved` 回调）；ModelsSection 弹框壳保留。
- `ModelSelectField.svelte`：主/轻量模型下拉（选项 = `settingsStore.availableModelOptions`）。
- `CapabilityModelSection.svelte`：增 `embedded`（紧凑形态）与 `onSaved` props。

## 4. 非目标

- 轻量模型 / 向量 / 重排等其他能力缺失的引导卡片（机制已就绪，加 requirement 触发点即可，按需追加）。
- 供应商 Key 缺失导致对话模型 401 的引导（沿用失败横幅）。
- 卡片消息持久化（卡片是常驻交互区，随状态出现/消失，不落 messages 表——历史干净、无去重问题）。
- 设置页与卡片的双向锚点跳转（卡片就地完成，不需要跳设置页）。

## 5. 改动清单（2026-10-04 实现完成）

- [x] `packages/shared/src/domain/types.ts`：`setupRequirementSchema` / `runSchema.setup`
- [x] `packages/shared/src/errors.ts`：AppError 新码 `CAPABILITY_NOT_CONFIGURED`
- [x] `packages/core/src/domain/runs.ts`：error_json `{message, setup?}`（`nextErrorJson` 整体重写逻辑）；update 补丁与行映射
- [x] `packages/core/src/media/service.ts`：`#resolve` 改用新码；新增 `capabilityConfigured()`
- [x] `packages/core/src/tools/image-tools.ts`：`generate_image` 工具（写 workspace、SETUP_REQUIRED 信号）；`tools/index.ts` 挂 `media` facade
- [x] `packages/core/src/dispatch/orchestrator.ts`：主模型检查带 setup；media facade + tool_result 监听（延后一拍 abort）+ settle 改判
- [x] `packages/core/src/start.ts`：orchestrator 注入 media
- [x] `packages/core/test/integration/response-loop.test.ts`：无模型失败带 setup + 重试续跑；图像工具中断改判 + 配置后重试
- [x] `packages/core/test/unit/media-service.test.ts`：新码断言 + capabilityConfigured
- [x] `apps/desktop/.../settings/ProviderSetupForm.svelte`（拆出）+ `ModelSelectField.svelte`（新增）+ `ModelsSection.svelte`（改用，弹框壳保留）
- [x] `apps/desktop/.../settings/CapabilityModelSection.svelte`：embedded / onSaved
- [x] `apps/desktop/.../stores/chat.svelte.ts`：pendingSetup + 发送门禁 + continueAfterSetup/dismissSetupCard/setupRequirement
- [x] `apps/desktop/.../chats/SetupRequiredCard.svelte`（新）+ **ChatView 输入坞接入**（见第 8 节备注）
- [x] `apps/desktop/.../i18n/locales/zh-CN.ts`：setupCard.* 文案
- [x] `apps/desktop/test/e2e/setup-card.spec.ts`：访谈回答触发（失败→卡片→配置→重试续跑）、发送门禁触发（草稿保留→卡片→配置→自动发送）
- [x] 文档：`docs/design/18-inline-setup.md` + design README（索引 + D58）+ 02/12/16 增量；`docs/dev/03-data-model.md`、`docs/dev/04-agent-runtime.md`、`docs/dev/phases/P15-inline-setup.md`、`docs/dev/PROGRESS.md`

## 6. 验收口径（2026-10-04 全部通过）

1. ✅ 全新环境（无任何供应商/模型）：创建 Bot → 回答首问 → run 失败且 `run.setup={kind:'main-model'}`，出现设置卡片（顶部不出现失败横幅）；卡片内添加供应商、选默认模型、确认 → 原 run 自动重试、访谈继续。
2. ✅ 正常对话中（Bot 与默认模型均未配置）：输入消息回车发送 → 消息不进入失败 run，留在待发送队列；卡片出现；完成设置后草稿自动发送、Bot 回复。
3. ✅ Bot 调 `generate_image` 且图像能力未配置 → run 失败带 `setup={kind:'capability-model',capability:'image'}`，配置后原 run 重试、对话继续（集成测试）。
4. ✅ 设置页「模型」分组行为与此前完全一致（onboarding / bot-setup / direct-chat / loop-progress e2e 全绿）。
5. ✅ `pnpm test` 全绿；desktop build + svelte-check 与基线一致。

## 7. 风险

- 工具执行中 `handle.abort()` 与引擎 unwind 的竞态：实测需**延后一拍**（`setTimeout 0`）——同步 abort 处在引擎工具执行的 await 链内不被消化；settle 以 outcome + setupHit 判定，幂等。
- 卡片与失败横幅、NoModelBanner 并存的信息重复：横幅在 setup 失败时被抑制；NoModelBanner 保留（全局提示与就地卡片语义不同）。
- 首条消息门禁依赖 renderer 的 settings 快照：若快照未加载则放行，由 core 结构化失败兜底（卡片仍会出现）。

## 8. 实现偏离记录

- **卡片渲染位置从「消息列表流内」改为「输入坞上方」（ChatView，ApprovalDock 同层）**：发送门禁场景下没有任何消息，`MessageList` 因 `hasMessages` 为 false 整个不渲染，卡片无处安放；输入坞是「无消息（门禁）」与「有消息（失败改判）」两种场景共同的注意力位置（e2e 快照实证后调整）。
- **工具侧不做 `capabilityConfigured` 预检**：预检短路会让 orchestrator 的 media facade 无从感知缺配置（setupHit 记不上）；改为直接调用 `media.generateImage`，由 `CAPABILITY_NOT_CONFIGURED` / `PROVIDER_AUTH_FAILED` 抛错路径统一驱动。

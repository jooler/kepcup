# P15 对话内设置引导（Inline Setup）

## 目标

功能依赖的配置缺失时，不再让用户自己去设置页找答案：在「用到的时刻」把对应设置组件就地呈现到对话里（输入坞上方的设置引导卡），完成设置后原对话自动继续（重试原 run / 冲掉保留的草稿）。守住原则：**卡片与设置页是同一份事实**（同一批保存 RPC），引导不产生第二套配置数据。

## 依赖

P01（响应 loop 与失败路径）、P13（设置页模型分组、providers RPC）。

## 设计依据

- [design/18-inline-setup.md](../../design/18-inline-setup.md)（全文）
- [design/16-capability-models.md](../../design/16-capability-models.md)（能力模型配置、媒体网关）
- [design/12-ui-layout.md](../../design/12-ui-layout.md)（卡片表、输入坞）
- [03-data-model.md](../03-data-model.md)（runs.error_json）
- [04-agent-runtime.md](../04-agent-runtime.md)（工具目录）
- todo/inline-setup.md（规划与验收口径）

## 背景（现状，实现前必读）

- 模型解析：`orchestrator.#executeResponseRun` 开头 `bot.runtime.model || settings.defaultMainModel`，为空 → run 纯文本失败（走顶部失败横幅，无结构化信息）。
- 媒体网关（`media/service.ts`）此前无 Bot 工具消费——`media.generateImage` 仅为 RPC 预留；「能力未配置」抛 `INVALID_INPUT`。
- 引擎约束（`pi-engine.ts`）：工具抛错不断 loop（转工具结果继续）；`terminate` 产出 completed、`abort` 产出 cancelled——工具侧「缺设置」须由 orchestrator 监听 `tool_result` 后 abort，settle 时改判 failed（retry 只接受 failed）。
- e2e 的 `KEPCUP_MOCK_LLM_URL` 会 seed mock 供应商并设默认模型（`start.ts seedMockLlm`）——「无模型」场景须置空该变量。

## 任务（全部完成）

- [x] shared：`setupRequirementSchema`（main-model / capability-model）、`runSchema.setup`；错误码 `CAPABILITY_NOT_CONFIGURED`
- [x] core/runs：`error_json` 扩展为 `{message, setup?}`（无迁移）；`update` 支持 `setup` 补丁
- [x] core/media：`#resolve` 改抛新码；`capabilityConfigured()`
- [x] core/tools：`image-tools.ts` 的 `generate_image`（落盘 workspace `.generated/`；缺配置转 `SETUP_REQUIRED`）；`buildResponseTools` 挂 `media` facade
- [x] core/orchestrator：主模型检查带 setup settle；media facade 捕获缺配置错误码记录 requirement；`tool_result` 监听延后一拍 abort；settle 改判 failed + setup；start.ts 注入 `media`
- [x] desktop/settings：拆分 `ProviderSetupForm`（ModelsSection 弹框表单整体迁出，testid 前缀参数化）、`ModelSelectField`；`CapabilityModelSection` 增 `embedded` / `onSaved`
- [x] desktop/chat：发送门禁（单聊无可用模型 → 不发送、置起 `pendingSetup`）、`setupRequirement` 合并视图、`dismissSetupCard` / `continueAfterSetup`
- [x] desktop/chats：`SetupRequiredCard`（两段式 main-model / embedded capability）挂 ChatView 输入坞；失败横幅对 setup 失败抑制；i18n `setupCard.*`
- [x] e2e：`setup-card.spec.ts`（不带 MOCK_LLM_URL）——访谈回答触发 + 发送门禁触发两条路径

## 验收（2026-10-04 全部通过）

1. 全新环境创建 Bot、回答首问 → run 失败且 `run.setup={kind:'main-model'}`，卡片出现（无失败横幅）；卡片内添加厂商、选默认模型、确认 → 原 run 自动重试、访谈继续。
2. 正常 Bot 无模型时发送消息 → 不产生失败 run、草稿保留、卡片出现；完成设置确认 → 草稿自动发出并得到回复。
3. `generate_image` 未配置能力 → run 失败带 `setup={kind:'capability-model',capability:'image'}`；配置后重试继续。
4. 设置页「模型」分组行为不变（onboarding / bot-setup / direct-chat / loop-progress e2e 全绿）。
5. `pnpm test` 全绿；desktop build / svelte-check 与基线一致。

## 备注

- 卡片渲染位置是输入坞上方（`ChatView`，ApprovalDock 同层）而非消息列表流内：发送门禁场景没有任何消息，消息列表（`hasMessages` 条件渲染）不存在——输入坞是两种场景共同的注意力位置。
- 工具结果事件的 abort 需延后一拍（`setTimeout 0`）：同步 abort 处在引擎工具执行的 await 链内不被消化。

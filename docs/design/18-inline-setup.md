# 18 对话内设置引导（Inline Setup）

许多功能依赖提前设置才能执行：默认主模型（Bot 能否思考）、图像生成等能力模型（Bot 能否干活）。逐一教育用户「先去设置页配置某项」成本太高——用户在第一个功能上撞墙时就被吓退了。本篇定义**就地引导**：在用户调用某个未正确设置的功能的那一刻，把对应的设置组件呈现到对话里；完成设置后，刚才被打断的事自动继续。

设计原则：

> 设置发生在「用到的时刻」，而不是启动时的集中教育；对话里呈现的组件与设置页是**同一份事实**（同一批保存 RPC），不是平行的简化版表单。

## 两个锚定场景

1. **第一个 Bot 的第一条消息**：用户创建 Bot、发出第一条消息时，若 Bot 未指定模型且全局没有默认主模型（全新环境），对话出现「模型设置卡片」——先添加厂商（填 Key），再选默认模型（可顺带指定这个 Bot 的模型），确认后对话自动继续。
2. **未配置的能力被用到**：用户让 Bot 生成图片但图像生成模型未配置时，Bot 的 `generate_image` 工具以「缺设置」信号中断执行，对话出现图像模型设置卡片；完成配置后原任务自动重试。

## 核心机制：结构化的「设置前置需求」

失败只有携带了机器可读的「缺什么」，界面才能给出对应的表单。`runSchema` 新增可选 `setup` 字段（shared）：

```ts
setupRequirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main-model') }),
  z.object({ kind: z.literal('capability-model'),
             capability: z.enum(['embedding','rerank','multimodal','asr','tts','image','video']) }),
]);
runSchema.setup  // SetupRequirement | null，仅因缺设置而失败时非空
```

另有 `web-search`（联网检索供应商，21-web-search）与 `agent`（D72 外部智能体：`{kind:'agent', agentId, reason}`，未开实验 / 未启用 / 未安装 / 未登录 / 版本不兼容 / 暂不可用 / 沙箱不可用（`sandbox_unavailable`，如 Linux 缺 bubblewrap / socat）时由 run 门禁或引擎失败给出，卡片内嵌设置页同一张 Agent 卡片，完成后自动重试原 run，见 28-external-agents-acp §9.1）。

落盘：`runs.error_json` 由 `{message}` 扩展为 `{message, setup?}`（无 DB 迁移）。`run.error` 仍是用户可读文案，`run.setup` 供界面路由到对应表单。

两个触发点（core）：

| 触发点 | 时机 | 结果 |
|---|---|---|
| 主模型检查 | 响应 run 执行开头，`bot.runtime.model \|\| settings.defaultMainModel` 为空 | run `failed` + `setup={kind:'main-model'}` |
| 能力缺失 | Bot 工具（`generate_image`）调用媒体网关，能力未配置 / 厂商缺 Key | 工具返回 `errorCode='SETUP_REQUIRED'`，orchestrator 中断 run（外部 abort，引擎产出 cancelled），settle 改判 `failed` + `setup={kind:'capability-model', capability}` |

- 媒体网关的「能力未配置」错误从 `INVALID_INPUT` 改为专用码 **`CAPABILITY_NOT_CONFIGURED`**——调用方据此区分「缺用户配置」（可引导）与「参数/网络问题」（普通失败）。
- `SETUP_REQUIRED` 对模型只是普通的工具失败文本；中断由 orchestrator 监听 `tool_result` 事件完成（工具执行中不中断引擎的 await 链，abort 延后一拍）。改判为 `failed` 而非保留 `cancelled`，是因为重试入口 `runs.retry` 只接受 failed。
- 改判只发生在 run 非正常完成时：若模型在缺设置的工具结果后自行完成了别的回答（completed），不强行改判——已经发生的沟通不回滚。

## 界面：消息列表内的设置卡片

卡片（`SetupRequiredCard`）出现在**输入坞上方**（审批卡 dock 同层）——这是对话的注意力位置；无消息（发送门禁）与有消息（失败改判）两种场景都可见。数据源（chat store 的 `setupRequirement`）按优先级合并：

1. **发送门禁**：单聊 Bot 无可用模型时，`flush/flushOne` 不发送——草稿原地留在待发送队列、不产生失败 run，置起 `pendingSetup` 显示卡片。settings 快照未加载时放行，由 core 的结构化失败兜底（卡片仍会出现）。
2. **结构化失败**：最近失败 run 携带 `setup` 时，卡片替代失败横幅（横幅对 setup 失败不渲染）；完成后 `dismiss + runs.retry` 自动续跑——这一条覆盖访谈回答、群聊、图像工具等所有 core 侧路径，无需逐场景处理。

卡片内容按 requirement 分发：

| requirement | 卡片内容 |
|---|---|
| `main-model` | 两段式：尚无已配置厂商时内嵌**供应商表单**（`ProviderSetupForm`）；之后选默认主模型 + 可选「这个 Bot 的模型」（`bots.update`），确认后继续。**切段只由「保存」进入**：「测试连接」为完成探测会先落盘 key（`providers.test` 只读已存 key），`availableModelOptions` 随之翻转，不能用它派生切段——测试无论成败都不自动跳段；引导卡场景下任一测试失败后「保存」禁用（`blockSaveAfterFailedTest`），直到某次测试通过（切换厂商重置表单即重置），设置页用法不设此限 |
| `capability-model` | 内嵌对应能力的**能力模型配置**（`CapabilityModelSection embedded`），保存即继续 |

确认 / 保存后 `continueAfterSetup()`：失败路径收起横幅并自动 `runs.retry`（原触发消息照常续跑）；门禁路径自动冲掉保留的草稿队列。卡片右上角可「暂不设置」——门禁撤销、失败横幅收起，草稿保留，下次发送会再次拦下。

## 设置组件拆分（复用，不改行为）

设置页「模型」分组与对话内卡片复用同一批组件，保存逻辑只有一份（`settings.update` + `providers.setKey`）：

| 组件 | 拆出内容 | 消费方 |
|---|---|---|
| `ProviderSetupForm` | 供应商新增 / 设 Key / 编辑厂商模型的表单体 + 保存 / 测试（原 ModelsSection 弹框内联逻辑） | 设置弹框（壳不变）、main-model 卡片第一段 |
| `ModelSelectField` | 默认模型下拉（选项 = 已配置 key 的厂商对话模型） | 设置页默认模型、main-model 卡片第二段 |
| `CapabilityModelSection` | 增 `embedded`（隐藏标题）/ `onSaved` props | 设置页能力模型、capability 卡片 |

## 测试锚点

- 集成（response-loop）：无模型失败带 `setup={kind:'main-model'}` 且配置后 `runs.retry` 续跑成功；`generate_image` 未配置能力 → failed + `capability-model`，配置后重试不再命中。
- e2e（setup-card.spec，环境不带 `KEPCUP_MOCK_LLM_URL` 模拟全新环境）：访谈回答 → 卡片（无失败横幅）→ 卡片内加厂商 → 确认 → 访谈继续；高级新建 Bot 的消息 → 门禁拦截（草稿保留、无失败 run）→ 卡片完成设置 → 草稿自动发出并得到回复；「测试连接」指向死端口 → 卡片停在第一段且保存禁用 → 修正重测通过 → 保存解锁（成功也不自动跳段）→ 保存进第二段 → 确认续跑。

## 非目标与后续

- 轻量模型 / 向量 / 重排等其他能力的引导卡片：机制已就绪（`capability-model` 枚举已含全部能力），按需追加触发点。
- 厂商 Key 失效（401）等运行期错误的引导：沿用失败横幅，不在此机制内。
- 卡片不做消息持久化：它是随状态出现/消失的常驻交互区，不落 messages 表（无去重与历史噪音问题）。

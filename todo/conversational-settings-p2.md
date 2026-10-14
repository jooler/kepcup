# 对话内应用设置 P2 交接

> 写于 2026-10-14。给另开的对话用：一次只做下面的一条，做完就停，单独提交。不要做 P3，不要重做 P1。
>
> 方案原文在 [conversational-app-setup.md](conversational-app-setup.md) §8.3。设计篇是 [docs/design/38-conversational-settings.md](../docs/design/38-conversational-settings.md)（D89）。P0 偏差在 [docs/dev/DEVIATIONS.md](../docs/dev/DEVIATIONS.md) 的 DEV-026。P1 实施记录在 [docs/dev/PROGRESS.md](../docs/dev/PROGRESS.md) 的「对话内应用设置 P1」。
>
> 写这份文档时没有跑测试。另有 Agent 正在审查并修正 P1，工作区可能继续变。开工前先看当前 `main` 和相关文件，不要假设下面的行号还在。

## 现在停在哪

P1 的升级清单已经全部勾完：58 个目录条目里 46 个有内嵌卡。最后一项是 `environment.allowlist`（`e3c662c`）。审查修正可能叠在这之后。

仍是 `card: null`、而且**不要在 P2 里做成内嵌卡**的 12 条：

- 永久跳转或只读：`profile.user-facts`、`developer.mode`、`developer.custom-mcp`、`developer.oauth-clients`、`developer.mcpb`、`diagnostics.status`、`diagnostics.usage`
- 走专门工具，`settings_change` 只重定向：`bot.identity`、`bot.file-access`、`skills.install`、`schedules.schedule`、`schedules.watch`

`connections.connect` 和 `mail.account` 也走专门工具，但 P0 已经有内嵌卡（`connect-app`、`mail-account`）。不要拆掉这两张卡。

§8.0 / §8.2 的标题还写着「P1 进行中」，是因为清单做完后没有改阶段状态，也没有做阶段收口的全量测试。审查还在进行，先不要把 P1 改成已完成。

## 开工约定

- 一次一个任务，做完单独提交。任务之间不要互相捎带。
- 不改沙箱、工具链、命令白名单，除非任务正文点名了它们。
- 不改 D58 已经验收的发送门禁、失败续跑、放弃通知的**行为**。P2 要收拢的是渲染和契约，不是改这条链的结果。
- 测试按 [docs/dev/05-testing.md](../docs/dev/05-testing.md)：迭代只跑定向测试。改了 `setupRequirementSchema` 这种 shared 契约时，先 `pnpm --filter @kepcup/shared build`，再跑用到 dist 的 core 测试。全量只在这一条任务收口、或用户明确要求时跑一次。
- 审查 Agent 还在改 P1 时，不要为了「查清主干 e2e」去跑全量，也不要和他们抢同一批文件。任务 7 等审查收口后再做。
- 结论要进设计篇 38 的，写进新小节，不要改写 P0/P1 已落地的段落来迁就新结论。

## 建议的拆分

可以并行，但不要两个人改同一个文件。

| 任务 | 性质 | 主要会碰到的文件 |
| ---- | ---- | ---- |
| 1–3 | 实现：旧 kind 收拢 | `SetupRequiredCard.svelte`、`setupRequirementSchema`、各 `*SetupBody` |
| 4 | 只评估，不删规则 | `system-prompt.ts`、`apps/prompt.ts`、`mail/prompt.ts`、`settings/prompt.ts` |
| 5 | 只评估，不改设置页 | 设计篇 38 |
| 6、8、9 | 决定修或明确放弃 | `settings.update` / `bots.update`、`SettingCard.svelte`、设计篇 38 |
| 7 | 等审查收口再查 | `external-agents.spec.ts` |

## 任务 1：先收拢能一对一的旧 kind

**做什么。** 让 `capability-model`、`web-search`、`mail-account` 的失败续跑卡改由 `SettingCardEmbed` 渲染。`setupRequirementSchema` 里这三个 kind 保留为兼容别名，读到之后转成已经存在的 `kind:'setting'` 再渲染。不要先删别名：库里和测试里还有旧值。

| 旧 kind | 目录条目 | 现在的渲染 |
| ---- | ---- | ---- |
| `capability-model` | `CAPABILITY_SETTING_IDS`（`capability.embedding` 等 7 个） | `SetupRequiredCard` 后半段直接嵌 `CapabilityModelSection` |
| `web-search` | `search.provider` | 同文件直接嵌 `WebSearchSection` |
| `mail-account` | `mail.account`（`via: mail_request_setup`） | `MailAccountSetupBody` |

锚点：

- 契约：`packages/shared/src/domain/types.ts` 的 `setupRequirementSchema`（约 1206 行起）。通用 `kind:'setting'` 已经在，字段是 `itemId`、可选 `prefill`、`reason`。
- 输入坞卡片：`apps/desktop/src/renderer/src/lib/features/chats/SetupRequiredCard.svelte`。`kind === 'setting'` 已经走 `SettingSetupBody`。
- 通用分发：`apps/desktop/src/renderer/src/lib/features/settings-card/SettingSetupBody.svelte`。它用 `SettingCardEmbed`，完成后 `chat.continueAfterSetup()` → `runs.retry`。这是失败续跑卡，不是消息流里的 `setting_card`。
- 产生旧 kind 的 core 路径先别改语义。渲染层把旧 kind 映到目录条目即可。`mail-account` 的 `provider` 映到 `prefill.provider`；`reason` 照原样给用户看。

**完成标准。** 发送门禁、失败后续跑、放弃（`runs.setupDismissed`）的结果与现在一致。`apps/desktop/test/e2e/setup-card.spec.ts` 仍通过。密钥仍只在组件里填。

**不要做。** 不要在这一条里动 `main-model`、`agent`、`connect-app`、`confirm-local-connector`。不要把失败续跑卡改成消息流里的 `setting_card`。不要让 `settings_change` 去代调 `mail_request_setup`。

## 任务 2：`agent` 与 `connect-app`

这两条有目录条目，但旧 kind 带的字段比 `kind:'setting'` 多。先保留别名，把多出来的字段映进 `SettingSetupBody` / `SettingCardEmbed` 现有的预填，映不进去的留在别名上，不要塞进目录字段。

| 旧 kind | 目录条目 | 旧载荷里多出来的 |
| ---- | ---- | ---- |
| `agent` | `agents.external` | `agentId`、`reason`（`agentSetupReasonSchema`）、可选 `detail` |
| `connect-app` | `connections.connect`（`via: app_request_connection`） | `target`、可选 `connectionId`、可选 `scopes`、`reason` |

现在的组件：`AgentSetupBody.svelte`、`ConnectAppSetupBody.svelte`。内嵌卡已经是 `AgentCard` 和 `ConnectAppPanel`。收拢是让失败续跑卡走同一分发，不是再做一张表单。

`connect-app` 完成后仍要接上原来的续跑。`confirm-local-connector` 添加成功之后会再进入 connect-app，这条链不要断。

**完成标准。** 与任务 1 相同，外加 `external-agents.spec.ts` 里「对话内智能体设置卡」那一条的行为不变。那条 e2e 在 P0 基线上本来就失败过（见任务 7），本任务只要求不引入新的失败方式；审查还没收口时，不要为了它跑全量。

**不要做。** 不要把 `agent` 的 `reason` / `detail` 写进设置目录字段。不要让 `settings_change` 代调 `app_request_connection`。

## 任务 3：`main-model` 与 `confirm-local-connector` 单独处理

不要和任务 1、2 并在一次提交里。

**`main-model` 不是单条目。** `SetupRequiredCard` 里是两段式：没有已配置厂商时先嵌 `ProviderSetupForm`（对应 `models.provider`），保存后才选默认主模型（`models.default-main`），还可以顺带 `bots.update` 写当前 Bot 的模型。切段只认「保存」，不认「测试连接」——测试会先落盘 Key，不能因此跳到第二段（组件顶上的注释写了原因）。

发送门禁走 `chat.svelte.ts` 的 `pendingSetup`，不是失败 run。放弃通知在 `orchestrator.notifySetupDismissed`：`kind === 'main-model'` 时**不唤醒** Bot，否则对话轮跑不起来，会再弹出同一张卡。

收拢时这两段行为都要留下。可以保留 `main-model` 别名，内部分成两段目录卡片；不要做成一个扁平的 `kind:'setting'` 把两段和「顺带改 Bot 模型」压没。

**`confirm-local-connector` 不是设置目录条目。** 载荷是 `proposalId` + core 探测生成的 `card`（`localConnectorCardSchema`）。用户点的是 `apps.localConnectors.confirm` / `reject`，不是 `settings.items.apply`。建议**保持独立 kind 和 `ConfirmLocalConnectorBody`**，在设计篇 38 写明它不并入 `SettingCard`。如果仍要「由设置卡分发」，只能是外壳套原组件，不能改成 `kind:'setting'`。

**完成标准。** `setup-card.spec.ts` 通过。门禁拦截时草稿还在、没有失败 run；卡片完成后草稿发出。放弃 `main-model` 不发出 `task_setup_dismissed`。本机连接的确认 / 取消 RPC 不变。

## 任务 4：提示词合并，只写评估

**不要删、不要并。** 这一条的完成是一段写进设计篇 38 的结论。方案要求拿合并前后的模型行为对比，不能只比字数。P3 还没做，所以结论只能是「现在不并」或「拟定合并稿，等 P3 再决定」，不能是「已经并进去了」。

现在三条是分开注入的：

- `SETTINGS_RULE`：`packages/core/src/settings/prompt.ts`。`hasSettingsTools === true` 时加进 `TURN_PLATFORM_RULES` / `PLATFORM_RULES`（`system-prompt.ts`）。ACP 侧在 `AGENT_PLATFORM_RULES`：有 `settings_change` 用这一条，只有只读工具时用 `SETTINGS_READ_ONLY_RULE`（`unlessTools: ['settings_change']`）。
- `APP_REQUEST_CONNECTION_RULE`：`packages/core/src/apps/prompt.ts`。对话轮在已有 `<connected_apps>` 或 `<available_apps>` 时才出现。ACP 按工具 `app_request_connection` 门控。
- `mailRequestSetupRule`：`packages/core/src/mail/prompt.ts`。普通 Bot 和管家措辞不同（移交只能由持有者或管家发起）。`hasMail === true` 才出现。ACP 用的是不含管家分支的 `MAIL_REQUEST_SETUP_RULE`。

并进去会丢掉的差异：邮件规则要求「还没有绑定邮箱时立刻调用，不要先口头确认」；应用规则只在有应用段落时出现；管家和普通 Bot 的移交句不同；ACP 只读设置用的是另一条。评估要逐条写这些差异还在不在。

定向测试若改了措辞才需要跑：`packages/core/test/unit/settings-prompt-acp.test.ts` 以及断言这三句原文的提示词测试。只写文档就不用跑。

## 任务 5：设置页是否改由目录卡片组成，只写评估

**不要改设置页组件。** 问题是：各设置分区能否直接渲染目录里的那张卡，让卡片成为唯一渲染单元。

写结论时要带上这些已经存在的分叉，不能假设「把 `SettingCardEmbed` 嵌进设置页」就行：

- 同一张卡的设置页形态和嵌入形态不一样。嵌入会藏掉卸载、恢复默认、断开连接、删除等破坏性操作。
- 有的条目是组件自存，有的走 `settings.items.apply`。设置页今天仍是整表保存。
- 渲染层条目（主题、语言、麦克风、摄像头）core 读不到。
- 永久跳转的开发者项、诊断、用户画像没有内嵌组件。
- 一个设置分区里有多条目录条目（环境页是工具链、沙箱、白名单三张卡）。

结论写进设计篇 38 的新小节：建议做或不做，以及要做的话第一刀切在哪个分区。是否实施另开决定，不在本任务里写代码。

## 任务 6：设置页整表保存覆盖 Bot 的直接修改

**问题。** `settings.update` 和 `bots.update` 保存的是整份快照。设置页一份过期的表单提交，会把 Bot 刚用 direct 改过的字段盖回去。现在只有回执卡「撤销」会报冲突。DEV-026 第 14 条把这件事留在了 P0 之外。

**方向（二选一，选定后写进设计篇）。**

- 设置页保存也走条目级 CAS（`settings.items.apply` 那条路径）；或
- 给 `settings.update` / `bots.update` 加期望值，对不上就拒绝，不覆盖。

相关代码：`packages/core/src/rpc/settings-bindings.ts`（按前后差异发 `settings.changed`）、`packages/core/src/settings/host.ts` 的 `#writeItem`、`packages/core/src/settings/write-lock.ts`。写锁只罩同步的读-合并-写，`settings.update` 的网络副作用在锁外，等锁上限 10 秒。修的时候不要把网络等待放进锁里。

**完成标准。** 选定并实现一种。补一条定向测试：Bot 改了字段 A 之后，一份仍带旧 A 的设置页保存不能把 A 盖掉；没被这份保存碰到的字段也不丢。若决定放弃，在设计篇 38 和 DEV-026 写明放弃原因，并把本任务勾成「明确不做」。

## 任务 7：查 P0 基线上的 e2e 失败（等审查收口）

P0 收口时与未改动的主干对照，e2e 有 9 例同样失败（§8.5）：`debug-dev-pin`、`external-agents` ×3、`local-connectors`、`projects`「项目选择」、`sandbox`「运行状态行」、`tasks`「启动任务」、`wiki`「页面树浏览」。其中和设置卡相关的是 `apps/desktop/test/e2e/external-agents.spec.ts` 这三条：

- `settings catalog: enable the agent…`
- `agent_tool approval card…`
- `in-chat agent setup card…`

P0 只证明它们在主干上同样失败，没有查根因。要确认的是 `AgentCard` 加上 `embedded` / `prefill` / `onSaved` 之后没有把这三条带偏。审查 Agent 可能正在改这些文件或重跑 e2e，**等他们收口再查**。查完把根因写进 PROGRESS 或设计篇；修得掉的修，修不掉的写明是环境问题还是产品缺陷。

单元 / 集成基线里还有 33 例环境类失败，外加 `response-loop` 的「interim delivery is capped at eight per run」和 `external-agent-p3` 的「agent write task holds the project lease」。那些不是本任务的范围，除非查 e2e 时证明是同一次改动带出来的。

## 任务 8：跳转卡重新打开对话时再核对一次

**问题。** `SettingCard.svelte` 里 link 卡自动完成靠挂载之后的 `settingsStore.changeSeq`：只认这张卡挂上之后的 `settings.changed`。用户在设置页改完、回到这个对话时，卡还在 pending。

处理方向：重新打开对话、消息里还有 pending 的 link 卡时，用读适配器核对一次（和 `settings.cards.complete` 同一套规则）。核对通过就标 applied 并唤醒一次；核对不了（渲染层、只读、`unknown`）不要在打开对话时擅自标完成。

不要把 confirm / user-only / form 卡放进这个自动完成。那些要用户在卡上操作。

## 任务 9：没配 Key 的自定义厂商变成待填卡，确认是不是预期

**现状。** `modelNeedsKey`（`packages/core/src/settings/adapters.ts`）在厂商不存在或 `hasKey === false` 时让 `needsSensitiveInput` 为真，`effectiveMode` 收到 form。所以「换成某个还没填 Key 的自定义厂商」不是 direct。DEV-026 第 7 条已记录，e2e 是先给 mock 厂商补 Key 再测 direct。

这和「direct 只能在已配置 Key 的厂商里选」一致。本任务默认**不改代码**。在设计篇 38 写明：这是预期；要换到没 Key 的厂商，出待填卡让用户填 Key。只有产品决定要改这条规则时才动 `needsSensitiveInput`。

## 不要重新打开的取舍

- 不可信读取按可信工具白名单，没登记的工具默认不可信。新工具必须归类，单测会强制。
- 主题、语言、麦克风、摄像头 core 读不到也写不了，`settings_read` 报「状态未知」。
- 设置卡不是审批，不新建 `setting_changes` 表。
- 外部智能体的 run 一律按不可信，最多出确认卡。
- `environment.allowlist` / `environment.sandbox` / `environment.toolchains` 是 user-only 空白卡：不预填、不由宿主写、快照 `values` 为 null。

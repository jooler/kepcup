# 对话中指挥一切：应用配置按需读取，并在对话里单次填写

> 状态：**待办（未开工，方案 A 已由用户拍板，2026-10-13）**。本文只记录需求与方案，未改任何代码。
>
> 需求来源：[jooler/kepcup#3](https://github.com/jooler/kepcup/issues/3)「在对话中指挥一切」（提出人 jooler，2026-10-13）。上游：D58 对话内设置（[docs/design/18-inline-setup.md](../docs/design/18-inline-setup.md)）、连接应用 [docs/design/29-connected-apps.md](../docs/design/29-connected-apps.md) §16、工具目录 [docs/dev/04-agent-runtime.md](../docs/dev/04-agent-runtime.md)。已实现的对话内设置见 [inline-setup.md](inline-setup.md)；扩展中心逐家适配（X5）见 [extension-center.md](extension-center.md)。

## 一、背景与目标

设置页与连接中心操作多，用户学习成本高。目标是降低入坑成本：用户在对话里提出具体需求时，Bot 先检查应用能力，再决定执行哪些操作，并把所需操作以卡片呈现在对话中，用户单次填写即完成。

应用的配置要以工具形式暴露给模型，让 Bot 在合适时机按需读取，而不是把所有能力说明塞进提示词。

## 二、现状（代码锚点）

结论先写在这里：**不需要新机制**。缺配置 → 结构化需求 → 中断 run → 对话内卡片 → 同一批保存 RPC → 续跑，这条链路已经是 D58。本需求是给它加一种应用设置需求，并补一个按需读取的工具面。

| 部分 | 位置 | 现状 |
| ---- | ---- | ---- |
| 设置需求契约 | `packages/shared/src/domain/types.ts` 的 `setupRequirementSchema`；`runSchema.setup` 落在 `runs.error_json` | 现有 kind：`main-model` / `capability-model` / `web-search` / `agent` / `connect-app` / `confirm-local-connector` / `mail-account`。没有 `app-setup`，也没有单独的 `task` kind |
| 缺配置错误码 | `packages/shared/src/errors.ts` 的 `CAPABILITY_NOT_CONFIGURED`；工具结果码 `SETUP_REQUIRED`（`packages/core/src/tools/image-tools.ts` 的 `TOOL_SETUP_REQUIRED`） | 能力未配置走 AppError；工具侧「需要设置」走 `errorCode: 'SETUP_REQUIRED'`，由 orchestrator 改判 |
| 中断与改判 | `packages/core/src/dispatch/orchestrator.ts` | 各门面把需求写入 `setupHit`；`tool_result` 监听看到 `SETUP_REQUIRED` 后 abort；settle 时若 `setupHit.requirement` 非空且 run 未正常完成，改判 `failed` 并带上 `run.setup`（retry 只接受 failed） |
| 工具注册 | `packages/core/src/tools/index.ts` | 按 deps 是否就绪、`loopType`（turn / task）分区注册。`appTools` 仅当 `deps.apps` 存在时注册 |
| 应用工具门面 | `orchestrator.#appToolFacade`（design 29 §7）；`packages/core/src/tools/app-tools.ts` | Bot 没有任何可请求目标（无自定义 OAuth、无已勾选连接、无可用目录条目、无本机连接）时不提供门面。已勾选连接的 MCP 工具经 mcp 通道注入；工具数超阈值时改为 `app_search_tools` / `app_call_tool`，不把全部工具内联进提示词 |
| 连接请求先例 | `app_request_connection` | 缺连接 / 需重连 → `SETUP_REQUIRED` + `{kind:'connect-app'}` → 对话内连接卡 → `runs.retry`。这是「先检查再出卡」的已有先例，但只覆盖连接本身，不覆盖应用内各项配置 |
| 按需读取先例 | `app_search_tools`、`widget_read_state`、`inspect_bot_assets` | 运行时按需读取，细节不常驻提示词 |
| 对话内卡片 | `apps/desktop/src/renderer/src/lib/features/chats/SetupRequiredCard.svelte`；`stores/chat.svelte.ts` 的 `pendingSetup` / `setupRequirement` / `dismissSetupCard` / `continueAfterSetup` | 卡片按 kind 分发，现有分支：`main-model`、`capability-model`、`web-search`、`agent`、`connect-app`、`confirm-local-connector`、`mail-account`。失败路径：收起失败横幅后 `runs.retry` 续跑。发送门禁路径：消息留在输入框，设置完成后用户再按一次发送（D86 已撤掉自动冲队列） |
| 目录与发行门禁 | `apps/desktop/resources/connectors/catalog.json`；`apps/desktop/connector-release-gates.json`；RPC `apps.catalog.list`（`packages/core/src/apps/connections.ts`） | `approved` 现为 `notion`、`linear`。配置项分散在目录条目的 `auth.scopes` / `toolPolicy`、连接 OAuth 状态、账号、工具锁定，没有一份「这个应用要填什么」的单一声明 |

## 三、方案决策

**已定：方案 A「读时工具」。** 注册一个按需读取工具（如 `app_setup` / `app_read_setup`）。模型在需要时读取某个应用「能做哪些操作 / 需要什么配置 / 当前状态」，细节不进常驻提示词。与 `app_search_tools`、`widget_read_state`、`inspect_bot_assets` 同构：改动小，上下文不随应用数膨胀。

**已否决：方案 B「每应用一个工具」。** 否决理由：

- 工具面随应用数与配置项线性膨胀。
- 与已有的按需工具发现（`app_search_tools` / `app_call_tool`，超阈值不内联）相反。
- 要处理与 `app_{slug}_{tool}` 的命名冲突与去重（`dropBuiltinNameConflicts` 已在防这类碰撞）。

**判断：这是 D58 的一次扩展，不是新机制。** 依据：

- `setupRequirementSchema` + `runs.error_json.setup` 已经能携带机器可读的「缺什么」。
- orchestrator 的 `tool_result` → `setupHit` → abort → settle `failed` + `run.setup` 已经接住 `SETUP_REQUIRED`。
- `SetupRequiredCard` 按 kind 分发，新 kind 加一个分支即可；保存仍走设置页同一批 RPC，续跑仍走 `continueAfterSetup` / `runs.retry`。
- `app_request_connection` 已经证明「模型发现缺连接 → 出卡 → 用户填一次 → 原 run 续跑」走得通。缺的是应用配置的按需清单，以及清单缺口如何归一成新的 setup 需求。

宿主门面拦截即可，不改引擎。

## 四、改动清单（未开工）

- [ ] shared：`setupRequirementSchema` 增加 `kind: 'app-setup'`（应用 / 目标 / 缺什么 / 可选字段）
- [ ] core：新增应用能力清单模块（纯数据，挂在目录条目上，不另做第二份事实）
- [ ] core/tools：暴露只读 `app_setup`（或 `app_read_setup`）工具面；可连接但未连接的应用也能读到静态清单，不把配置细节写入提示词
- [ ] orchestrator：把新的缺配置信号归一为 `app-setup` 需求（写入既有 `setupHit`，无需引擎改造）
- [ ] desktop：`SetupRequiredCard` 增加 `app-setup` 分支，内嵌连接卡或应用配置表单，复用同一批保存 RPC 与 `continueAfterSetup`
- [ ] 文档：回写 design/18 引导清单、design/29 §16、`docs/dev/04-agent-runtime.md` 工具目录

## 五、拆分步骤

- **S1 决策（A 已定）**：首个试点应用选 Notion 或 Linear（二者已在 `connector-release-gates.json` 放行）。未选定前不改代码。
- **S2**：shared 契约 + core 清单服务 + `app_setup` 只读工具面。可先不触发卡片。
- **S3**：orchestrator 归一 + `SetupRequiredCard` 的 `app-setup` 分支 + `continueAfterSetup` 续跑。
- **S4**：i18n、e2e（新环境缺配置 → 对话内单次填写 → 原 run 续跑）、文档回写。

## 六、非目标

- 不把「先检查再执行」做成硬门禁。它现在是提示词纪律（design/29 能力段）；联网检索在工具入口做配置检查，可作为以后若要确定性门禁时的背书，本期不做。
- 不改扩展中心 X5 的逐家适配。
- 不新增第二份应用配置权威清单。清单挂在既有目录条目上。

## 七、风险

- 上下文膨胀与工具面膨胀。方案 A 避免了 B 的线性膨胀，但清单字段若写进常驻提示词仍会膨胀；工具只在调用时返回。
- 「有哪些配置项」目前没有单一权威清单。目录条目的 `auth.scopes` / `toolPolicy`、OAuth 状态、账号、工具锁定分散在 `apps.catalog.list` 与连接详情 RPC。S2 要先收敛成一份声明，再暴露工具。
- 与扩展中心 X5 的冲突面：逐家适配仍在推进。清单必须挂在目录条目上，避免适配一家就要改两处事实。

## 八、待确认

- 首个试点应用：Notion 还是 Linear（二者均已放行）。
- 「先检查再执行」是否要做成确定性门禁（本期默认保持提示词纪律）。

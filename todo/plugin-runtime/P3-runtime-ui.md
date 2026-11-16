# P3 · 可观测 UI：状态、活动、进度反馈

> 状态：**待实施** · 依赖：本方案 P2 · 分支：`feat/plugin-runtime/p3-runtime-ui`
> 必读：[CURRENT-STATE](CURRENT-STATE.md) §3 → [61 号设计 §6](../../docs/design/61-plugin-runtime-platform.md) → 扩展中心插件卡组件、D55 状态行 / D93 任务详情页的 progress 渲染链

## 1 目标

愿景支柱 5 的 UI 呈现：插件运行状态徽标 + 活动抽屉（扩展中心）、`host.progress` → 对话内状态行 / 任务详情页的实时反馈打通、错误人话。零新事件通道——全部复用 `plugin.runtime` 事件与既有 progress 渲染。

## 2 范围

| 包含 | 不包含 |
|---|---|
| 扩展中心插件卡：运行状态徽标（ready/busy/error + 最近错误） | Bot 详情条目勾选（capability-model-plugins P3 范围） |
| 「查看活动」抽屉：最近 50 次调用表（`plugins.runtime.list`） | 插件控制台/日志实时流（远期） |
| `host.progress` → run 进度链打通（状态行阶段文案 / 任务详情页） | 新 RPC 事件类型（P2 已定义 `plugin.runtime`） |
| 错误人话映射（复用 media 错误文案 + 插件错误码补集） | 同意卡能力披露 UI（P4） |
| 插件卡手动「重启运行时」入口（`plugins.runtime.restart`） | — |

## 3 开工前核对

```bash
git log --oneline -3
rg "plugin.runtime" packages/core/src --files-with-matches   # P2 事件已在
rg "DEV-" DEVIATIONS.md | tail -5
```

## 4 步骤

### 步骤 1：插件卡状态与活动抽屉

1. 扩展中心插件卡（含 installed 插件列表与详情页头部）：订阅 `plugin.runtime` 事件 + 初始拉取 `plugins.runtime.list`，右上状态徽标（`stopped` 灰 / `starting` 黄脉冲 / `ready` 绿 / `busy` 绿 +「运行中」/ `error` 红 + 最近错误 tooltip）。
2. 执行型插件卡「查看活动」：抽屉表格 = 历史条目（时间 / 契约.方法 / 时长 / 结果徽标 / 错误人话）；错误列文案走统一映射（§步骤 3）；空态说明「尚未被调用」。
3. error 状态时插件卡出现「重启运行时」按钮 → `plugins.runtime.restart`，成功后徽标回 ready。

### 步骤 2：进度反馈链

1. P2 已把 `host.progress` 转发进 run 进度回调——本步在渲染侧确认两个呈现点：对话内执行状态行（D55，工具活动文案切换为插件给的 `phase/message`，如「排队中 → 生成中 42% → 下载中」）与任务详情页执行记录（progress 步骤行，D93 既有渲染）。
2. 若 P2 的转发只到 core 日志层，补齐 invoke 上下文 → 工具 `ctx.progress` 的桥（媒体工具的 progress 上报点在 `speech-tools.ts` 轮询处——插件路径改为透传 `event:'progress'` 帧，避免双份进度）。
3. 取消链 UI 自检：任务卡取消 / 工具超时 → 状态行出现「已取消」，插件活动抽屉该调用标记 cancelled。

### 步骤 3：错误人话映射

1. 新错误码补进既有错误文案表（media 错误映射同文件或相邻）：`PLUGIN_CRASHED`「插件已崩溃，正在自动重启」、`PLUGIN_TIMEOUT`「插件响应超时」、`PLUGIN_CONTRACT_VIOLATION`「插件返回了无效数据」、`PLUGIN_NETWORK_DENIED`「插件尝试访问未授权的网络地址」。
2. 插件 `error.message` 默认透传为次级说明（截断 200 字）；`PROVIDER_QUOTA` / `PROVIDER_AUTH_FAILED` 沿用厂商错误现有文案。

### 步骤 4：测试与手动清单

```bash
node scripts/run-tests.mjs run apps/desktop/src   # renderer 定向（按仓库实际位置调整）
```

手动清单（记实施记录）：reference-media 生成图片 → 状态行出现插件阶段文案 → 产物落附件；假视频任务 → 抽屉可见多次 invoke；杀死插件进程（外部 kill）→ 徽标 error + 人话 toast → 重启按钮恢复；取消任务 → 活动条目标 cancelled。

## 5 验收

- [ ] 插件卡状态徽标随真实进程状态迁移（含 error→restart→ready 闭环）。证据：store / 徽标映射有单测（`plugin-runtime.svelte.test.ts`、`plugin-runtime-view.svelte.test.ts`）；进程状态迁移与 restart 闭环由 P2 `plugin-host.test.ts`（真实子进程）覆盖，P3 补「error → restart → ready」用例。徽标真机迁移（杀进程 → error → 重启 → ready）待真机验证。
- [ ] 活动抽屉完整呈现最近调用（含错误人话与 cancelled 标记）。证据：`activityRows` 单测（成功 / 失败 / CANCELLED 三态、四个 PLUGIN_* 人话、200 字截断）；取消历史标记由 `plugin-host.test.ts` 的「取消链（DEV-118）」用例覆盖。抽屉视觉待真机验证。
- [ ] 对话内可见插件进度阶段文案，取消链 UI 闭环。证据：`media-tools.test.ts`（progress → ctx.progress 文案、视频让位）、`plugin-host.test.ts`（host.progress → resolve.onProgress；resolve.signal → cancel 帧 → 历史 CANCELLED）。对话内状态行 / 任务详情页真机呈现待真机验证。
- [ ] 非执行型插件卡片无状态徽标与活动入口（零变化）。证据：`plugin-runtime-view.svelte.test.ts` 的 `runtimeBadge(null) === null`；`plugin-runtime.svelte.test.ts` 的「非执行型插件 stateOf = null」；`ExtensionInstalled.svelte` 用 `isExecuting` 守卫，非执行型插件连 `PluginRuntimeStatus` 组件都不挂载（无徽标 / 活动入口可见节点，零可见变化）；`plugin-host.test.ts` 同装数据型插件后 `plugins.runtime.list` 只返回执行型行。

## 6 实施记录

- 分支 / 提交：`feat/plugin-platform`（D125 P2 收口 6e2ca714 之上；本阶段未提交，按任务约束不执行 git add/commit）
- 状态徽标 / 抽屉组件落点：
  - `apps/desktop/src/renderer/src/lib/features/plugins/plugin-runtime.svelte.ts`（store：`plugins.runtime.list` 初始快照 + `plugin.runtime` 事件 + restart）
  - `apps/desktop/src/renderer/src/lib/features/plugins/plugin-runtime-view.ts`（徽标 / 活动行 / 错误人话 / 截断纯逻辑）
  - `apps/desktop/src/renderer/src/lib/features/plugins/PluginRuntimeStatus.svelte`（徽标 + 重启运行时 + 查看活动）
  - `apps/desktop/src/renderer/src/lib/features/plugins/PluginRuntimeActivitySheet.svelte`（活动抽屉）
  - 落点：`extension-center/ExtensionInstalled.svelte`（已安装插件卡右上）+ `extension-center/ExtensionCapabilityModels.svelte`（插件详情页头部，仅执行型）
- progress / 取消接线：`media/types.ts`（`MediaCallControls` / `VendorCallContext.signal|onProgress`）、`media/service.ts`（`MediaResolveOptions.signal|onProgress`、`videoStatus` 可选 controls、`#hostedProvider` 注入）、`media/plugin-progress.ts`（进度文案）、`tools/image-tools.ts` / `speech-tools.ts`（facade 第 4 参 + 视频让位）、`dispatch/orchestrator.ts`（`#mediaFacade` 注入点）、`plugins/runtime/hosted-adapter.ts`（透传）、`plugins/runtime/host.ts`（CANCELLED 历史标记）
- 错误人话：`apps/desktop/src/renderer/src/lib/i18n/locales/{zh-CN,en-US}.ts` 新增四个 `chats.errorCode.PLUGIN_*` + 运行时 UI 文案
- DEV 偏差：DEV-119（取消链接线方式）、DEV-120（CANCELLED 表示法）、DEV-121（视频文案让位策略）、DEV-122（非执行型判定来源）
- 独立审查修正：非执行型卡片改为父级 `isExecuting` 守卫（连组件都不挂载，零 DOM）；store 并发 force 拉取按序号只采纳最新响应、`reset()` 使在途响应失效、事件/快照合并时 `lastError` 取更新来源；`PluginHost` 的 CANCELLED 记录不再写 `lastError`（取消不是插件错误）；补真实子进程用例「同装数据型插件 → `plugins.runtime.list` 只含执行型」与「error → restart → ready」。
- 测试：`node scripts/run-tests.mjs run apps/desktop/src`（198 文件 / 1924 用例全绿，含新增 renderer 18 用例）；core 定向 `plugin-host.test.ts`（36 用例）、`media-tools.test.ts`、`media-entry-resolution.test.ts`、`media-service.test.ts`、`media-adapters.test.ts`、`media-delivery.test.ts`、`media-service-usage.test.ts`（共 159 用例）全绿；`pnpm --filter @kepcup/core typecheck` 与 `pnpm --filter @kepcup/desktop typecheck` 全绿
- 手动清单（待真机验证）：reference-media 生成图片 → 状态行出现插件阶段文案 → 产物落附件；假视频任务 → 抽屉可见多次 invoke；外部 kill 插件进程 → 徽标 error + 人话 → 重启按钮恢复；取消任务 → 活动条目标「已取消」

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

- [ ] 插件卡状态徽标随真实进程状态迁移（含 error→restart→ready 闭环）。证据：
- [ ] 活动抽屉完整呈现最近调用（含错误人话与 cancelled 标记）。证据：
- [ ] 对话内可见插件进度阶段文案，取消链 UI 闭环。证据：
- [ ] 非执行型插件卡片无状态徽标与活动入口（零变化）。证据：

## 6 实施记录

- 分支 / 提交：
- 状态徽标 / 抽屉组件落点：
- DEV 偏差：

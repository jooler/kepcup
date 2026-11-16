# CURRENT-STATE · 插件运行时开工前现状快照

> 写于 2026-11-15（D125 设计调研期，代码勘察口径）。执行智能体开工前必读；行号会漂移，以符号名为准。媒体/插件条目侧现状见 [todo/capability-model-plugins/CURRENT-STATE.md](../capability-model-plugins/CURRENT-STATE.md)（其 P1/P2 为本方案前置）。

## 1. core 进程结构与组装根

- core 是独立 Node 进程：Electron main 经 `utilityProcess.fork` 拉起（`apps/desktop` 侧 `core-host.ts:174`，带重启退避 :291）；core 自身**不 import Electron**（`packages/core/src/process-entry.ts:14` 注释），宿主能力（browser/shell/widget/computer）以四个 host RPC 客户端身份注入（start.ts:992-995），platform-port 连上才 bind（process-entry.ts:160-166）。
- 组装根：`packages/core/src/start.ts:773` `createCoreServices`（~3300 行，`CoreServices` 接口 :588 约 86 字段）；三个宿主复用同一根——desktop（process-entry.ts:63）、测试（create-core.ts:60）、headless（apps/server/src/server.ts）。
- 初始化靠位置顺序 + 前向闭包 + 约 65 处 `services.X = ...` late-wiring；无模块级单例，DB/keystore 全走参数传递。**本方案新增服务沿用「组装根构造 + 窄接口注入」模式，不做容器化改造。**

## 2. 插件系统接缝（D104/D105 落地现状）

- `PluginRegistry`（`packages/core/src/plugins/registry.ts`）：deps 含 store/packager/projectors/builtin/marketplace/secrets 门面/instanceStore/events/audit；`registry.start()`（:239-281）= sweepStaging、崩溃恢复、孤目录清扫、逐 projector `activate`、撤销名单——已是插件级启动生命周期。
- 投影协议 `PluginProjector`（`plugins/projectors/index.ts:50-99`）：inspect/project/unproject/setEnabled/activate/update/beginUpdate/rollbackUpdate，**账本先行**（`plugin_items` 先记、失败回滚）。
- `CAPABILITY_KINDS`（`plugins/kinds.ts:91-142`）5 个 kind；materializer 运行期注册：`PluginInstanceService.registerMaterializer(kind, impl)`（`plugins/instances.ts:316,323`），mcp/mail/im 已落地（start.ts:2668/3041/3085）。
- 组装根中插件栈顺序：PluginStore(2480) → createPluginProjectors(2488) → MarketplaceService(2575) → PluginRegistry(2606) → PluginInstanceService(2648)。**PluginHost 应插在 PluginInstanceService 之后、Orchestrator(2703) 之前**；`MediaEntrySource` 实现注入 MediaService（其构造在 1329，早于插件栈——需要 late-wire 或把 source 实现为可换内核的稳定引用，注意与既有 attachXxx 回填模式一致）。
- 安装管线（registry + packager）：包防护 → 清单校验 → 贡献校验 → 同意卡 → 原子落盘 → 账本登记与投影。执行型校验（runtime 段层级限制、entry 存在、hostApi 解析）插在「清单校验」后。
- 市场：Ed25519 官方索引（`plugin-index.ts:94-101`）、R2 包、撤销名单 warn/disable、逐条目 tier。同意卡渲染点在安装流程（找 consent 相关组件），能力披露在其 payload 增量。

## 3. 媒体侧挂接点（D124 落地后）

- `MediaService.#resolve` / `#resolveEntry`：条目来源接口 `MediaEntrySource`（D124 P2 引入，构造注入）。`HostedAdapter` 的接入点：`entriesFor` 返回的 `ResolvedEntry` 增 `source: 'engine' | 'plugin'`，`#resolveEntry` 按 source 选 `MEDIA_ENGINES[engine].adapter` 或 `pluginHost.adapterFor(pluginId)`。
- `media/types.ts` `VendorAdapter` 七可选方法 + `VideoTaskPhase`——**media 契约的方法面与 schema 以此为准**；`VendorCallContext.entryParams`（D124 P2 预留）是条目 params 到适配器的通道。
- 错误归一 `media/http.ts`：`PROVIDER_AUTH_FAILED / PROVIDER_QUOTA / PROVIDER_RATE_LIMITED / PROVIDER_UNAVAILABLE / PROVIDER_UNREACHABLE`——插件错误映射遵守：崩溃/超时/契约违规→`PROVIDER_UNAVAILABLE` 族；插件可显式声明 auth/quota 映射。
- 进度链：`ctx.progress`（工具执行上下文）→ 状态行（D55）与任务详情页；`host.progress` 的转发点在工具调用与 PluginHost invoke 之间（invoke 需携带 run 上下文引用）。
- `testCapabilityEntry`（D124 P2 RPC）：托管适配器的探测走同一 invoke 路径（image 最小生成 / video 提交即取消 / tts「你好」/ asr 静音 WAV 探针复用）。

## 4. 基础设施可复用件

- 事件总线：`packages/core/src/infra/events.ts:9` `createEventBus<M>`（同步、吞 listener 异常、`on` 返回退订函数）；类型表 `start-types.ts:10` `CoreEventsMap`。**出核桥接已有三处先例**（process-entry:78-90 / create-core:72-76 / RemoteHub:147-157）——`plugin.runtime` 事件加入 `RPC_EVENT_NAMES` 即自动三端广播。
- 子进程先例：ACP ExternalAgentEngine 的 AgentHost（`agent/external/`）已做「进程懒启动 + IPC + 健康监测」——**握手/崩溃/重启语义参照它，不重造**；Electron 侧 core-host 的退避重启逻辑也是参照。
- RPC 模式：`rpc/bindings.ts` 各组绑定函数 + `plugins.*` 组已存在（setBotPlugins/enableForBots/…），新 `plugins.runtime.*` 就近加。
- SSRF 守卫：`web_fetch` 实现（21 号 D62）里的私网/重定向防护——`host.net.fetch` 复用同一守卫函数，不复制逻辑。
- 包打包：插件包为静态目录（D104，无安装期编译）；执行型插件的单文件 JS 打包约定（esbuild、禁 native）写进 P1 SDK 文档与 validate 钩子（`kepcup-app validate` 若有对应物则扩展）。

## 5. 基线速查

- **迁移 head**：capability-model-plugins P1 将用 0075（D124 规划）——本方案 0076，**以开工时 `ls packages/core/migrations/main | tail -3` 为准顺延**。
- **DEV 编号**：`rg "DEV-" DEVIATIONS.md | tail -5` 取最后顺延。
- **测试基线**：`packages/core/test/unit/media-*`（行为零变化护栏）、plugins 目录测试、`packages/shared/test/unit/plugin-manifest-*`（D124 P1 新增）。
- **相关文档**：61（设计）、60（条目模型）、51（安装管线与信任分级）、54（mail/im materializer 参照）。

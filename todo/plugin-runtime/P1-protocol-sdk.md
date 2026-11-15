# P1 · 协议、SDK 与参考插件

> 状态：**已实施（2026-11-15）** · 依赖：capability-model-plugins P1（manifest 条目模型已落地）· 分支：`feat/plugin-platform`（单集成分支，提交由主代理负责）
> 必读：[README](README.md)（固定契约）→ [CURRENT-STATE](CURRENT-STATE.md) → [61 号设计 §2 / §3.2 / §5](../../docs/design/61-plugin-runtime-platform.md)

## 1 目标

定义宿主与插件之间的**全部交接面**并使其可测试：IPC 帧 schema（shared 单一事实来源）、`@kepcup/plugin-sdk`（插件侧类型与 helper）、参考插件骨架（builtin，验证打包与加载约定）、manifest `runtime` 段 schema。本阶段不写运行时——协议先行，P2 只消费。

## 2 范围

| 包含 | 不包含 |
|---|---|
| `packages/shared/src/plugin-runtime/protocol.ts`（帧判别联合 + 全部 payload schema） | PluginHost 进程管理（P2） |
| `packages/plugin-sdk`：`definePlugin()`、`host` API 类型、契约类型（media） | 能力桥实现（P2，SDK 只有类型与客户端编码） |
| manifest `runtime` 段 schema + 校验规则（层级限制在 P2 安装管线接线，本阶段只出 schema 与单测） | 同意卡 UI（P4） |
| `plugins/reference-media/` 参考插件（骨架 + 假实现，builtin） | 真实厂商适配 |
| 协议单测（帧往返、校验拒绝矩阵） | 迁移 |

## 3 开工前核对

```bash
git status && git log --oneline -3
ls packages/core/migrations/main | tail -3      # 确认 capability-model-plugins P1/P2 已合入（MediaEntrySource 存在）
rg "MediaEntrySource" packages/core/src --files-with-matches   # 前置自检
rg "DEV-" DEVIATIONS.md | tail -5
pnpm --filter @kepcup/shared build
```

## 4 步骤

### 步骤 1：协议 schema（shared）

`packages/shared/src/plugin-runtime/protocol.ts`（strictObject 全覆盖，判别联合 `PluginRuntimeFrame`）：

1. 宿主→插件：`init {hostApiVersion, manifestDigest, instances:[{instanceId, fields: Record<string,string>}]}`、`invoke {callId, contract:'media', method, params: unknown, context:{entryId, model, locale, credentials: Record<string,string>, params: Record<string,unknown>}}`、`cancel {callId}`、`shutdown {}`。
2. 插件→宿主：`ready {hostApiVersion, contracts: string[]}`、`result {callId, output: unknown}`、`error {callId, code, message, details?}`、`event {callId, kind:'progress'|'log', payload}`（progress payload：`{phase?, percent?, message?}`；log payload：`{level, message, data?}`）、`state {status, detail?}`。
3. 导出类型守卫与 `parseFrame`（安全解析入口，宿主/插件两侧共用）。
4. `runtime` manifest 段加进 `plugin-manifest.ts`（61 §2 的 schema 原样），superRefine：`runtime.entry` 必须是包内相对路径（禁 `..` 与绝对路径）；community 层级限制的执行校验留 P2（schema 层只做形状）。

### 步骤 2：SDK 包

`packages/plugin-sdk`（workspace 新包，build 产物发布名 `@kepcup/plugin-sdk`）：

1. `definePlugin(spec)`：`{ contracts: { media?: MediaContractImpl }, ready?(ctx) }`——`MediaContractImpl` 方法面 = `VendorAdapter` 七方法的插件侧签名（`generateImage / synthesizeSpeech / transcribeSpeech / understandImage / submitVideo / videoStatus / cancelVideo`，类型从 shared media 类型 re-derive，**不复刻第二份**）。
2. `host` 命名空间类型（运行时注入实现）：`host.net.fetch(url, init?)`、`host.secrets.get(key)`、`host.storage.{get,set,delete,list}`、`host.log.{info,warn,error}`、`host.progress(p)`、`host.signal`（AbortSignal）。
3. 运行时客户端（几百行）：从 stdio/IPC 读帧 → dispatch 到 `definePlugin` 实现 → 写回帧；内置：调用并发=1、`host.signal` 与 `cancel` 帧的联动、`progress` 限速（1 次/秒）。
4. README：esbuild 单文件打包约定（`--bundle --platform=node --format=esm`、禁 native/`__dirname`）、目录布局、`engines.kepcup` 语义。

### 步骤 3：参考插件

`plugins/reference-media/`（builtin，developer 试用）：

- manifest：`id:'io.kepcup/reference-media'`、`runtime:{entry:'dist/main.js', hostApi:'^1', network:{allow:['example.invalid']}}`、`instances:['capability-model']`、`contributions.capabilityModels` 一条 image 条目（不填 `engine`）。
- `main.ts`：实现 media 契约 `generateImage`（返回一张内嵌 1×1 PNG 的 data URL，带 2 个 progress 事件）与 `submitVideo/videoStatus`（3 秒后 succeeded 的假任务）——用于 P2 端到端与演示，不模拟网络。
- 打包脚本产出 `dist/main.js` 入包。

### 步骤 4：测试

`packages/shared/test/unit/plugin-runtime-protocol.test.ts`：帧往返（每帧类型编解码一致）、未知帧拒绝、`invoke.context.credentials` 含非 string 拒绝、manifest `runtime` 形状（合法/`..` 路径拒/hostApi 缺失拒）；`packages/plugin-sdk/test/`：客户端对假 duplex 流的 invoke→result / cancel→AbortSignal / progress 限速。

```bash
pnpm --filter @kepcup/shared build && pnpm --filter @kepcup/plugin-sdk build
node scripts/run-tests.mjs run packages/shared/test/unit/plugin-runtime-protocol.test.ts packages/plugin-sdk
```

## 5 验收

- [x] 协议 schema 与 `parseFrame` 落地，两侧共用同一包（无第二份类型）。证据：`packages/shared/src/plugin-runtime/protocol.ts`（`pluginRuntimeFrameSchema` / `parseFrame` / `safeParseFrame` / 类型守卫）；SDK 客户端 import 同包 schema（`packages/plugin-sdk/src/client.ts`）。
- [x] `@kepcup/plugin-sdk` 可用 `definePlugin` 写出 media 契约实现并通过假流测试。证据：`packages/plugin-sdk/test/client.test.ts` 19 用例全绿（invoke→result / cancel→AbortSignal / progress 限速 / 握手 / fail-safe）；另有真 fork IPC 冒烟（`plugins/reference-media/dist/main.js` 作子进程，init→ready→2 progress→result→shutdown 全链路，exit 0）。
- [x] manifest `runtime` 段 schema + superRefine 生效。证据：`packages/shared/src/domain/plugin-manifest.ts`（`pluginRuntimeSectionSchema`，entry 禁 `..` / 绝对路径 / 首尾空白）；`plugin-runtime-protocol.test.ts` runtime 段 6 用例（含「不填 engine 的条目必须配对 runtime 段」拒绝路径——独立审查补齐）。
- [x] `plugins/reference-media` 打包产物通过包防护检查（无 native/路径逃逸）。证据：`node packages/app-validator/dist/cli.js validate plugins/reference-media` PASS（0 error，1 条 homepage 可选警告）；bundle 扫描无 `.node` / `.wasm` / 静态 import（自包含 ESM）、目录无符号链接。
- [x] 定向测试全绿。证据：`node scripts/run-tests.mjs run packages/shared/test/unit/plugin-runtime-protocol.test.ts packages/plugin-sdk` → 31 passed（12 + 19，含审查补齐的 engine↔runtime 配对拒绝用例）；`plugin-manifest-capability-models.test.ts` 12 passed 不回归；shared 全目录 634 passed 不回归。

## 6 实施记录

- 分支 / 提交：`feat/plugin-platform`（单集成分支；提交由主代理负责，本阶段未 commit）
- SDK 侧与 shared 类型的 re-derive 方式：类型事实源 = shared `media/types.ts`（接口，源自 core `VendorAdapter` 方法面逐字段 re-derive）；wire 校验 = shared `media/schema.ts`（strictObject zod schema + `MEDIA_CONTRACT_METHOD_WIRE` 注册表，61 决策 6「两侧共用同一 schema 包」），文件底部对每对 schema↔接口做**双向赋值断言**（漂移即 shared typecheck 失败）；SDK（`packages/plugin-sdk`）只消费 shared 的类型与 schema——`MediaContractImpl` 方法面 = 七方法签名（`SecondArg` 从 impl 方法类型反推 params，不复刻参数类型），dispatch 表引用同一批 schema；`videoStatus` / `cancelVideo` 的 wire params 为 `{ taskId }` 对象（协议 invoke.params 恒对象）、`cancelVideo` wire output 恒 `null`，是 wire 形状不是语义分叉。core 未动（P2 re-point）。
- 客户端行为要点：并发=1 防御拒绝（排队归宿主，61 §3.1）；cancel 帧命中在途调用即 abort `host.signal`；progress 限速 1 次/秒（窗口内合并最新一条尾随发送，调用结束丢弃）；invoke 输入 / result 输出按 shared media schema 双向校验（输出不合契约 → `PLUGIN_CONTRACT_VIOLATION`，绝不部分投递）；`runPluginRuntime(plugin)` 进程入口模式在 shutdown / 通道断开后自动 `exit(0)`，传入显式通道（测试 / 嵌入）则生命周期归调用方。`host.net / secrets / storage` 类型就绪、实现由 P2 能力桥经 `wireHostApi()` 注入，未注入时抛 `HostApiNotConnectedError`。
- 参考插件：`plugins/reference-media/`（`build.mjs` 用 `createRequire` 复用 apps/desktop 的 esbuild 0.28.2，`@kepcup/plugin-sdk` / `@kepcup/shared` alias 到 workspace 源码打进单文件，零新依赖）；plugin 目录自带 `package.json`（仅 `"type": "module"`）让 fork 按 ESM 加载 `dist/main.js`（`dist/` 在 .gitignore 内，产物由脚本构建）。
- DEV 偏差：已落账 DEVIATIONS.md **DEV-104..DEV-110**（wire schema 落 shared `media/schema.ts`（DEV-104）；vitest 项目登记（DEV-105）；客户端行为语义三则（DEV-106）；esbuild 复用与 type:module package.json（DEV-107）；dist 产物不入库无构建钩子——风险项移交 D125-P2（DEV-108）；错误码帧级选择与 engines.kepcup 对齐（DEV-109）；engine 可选化的 core 过渡适配——数据型行为零变化、engine-less 条目过渡期不可消费（DEV-110））。另：`runPluginRuntime` 签名与「几百行客户端」描述为意图对齐（实际 ~300 行 + host/plugin/index 三模块）。

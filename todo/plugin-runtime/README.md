# 插件运行时平台（D125）

一句话目标：把插件系统从「声明式贡献包」升级为「舞台 + 演员」——应用提供稳定运行基建与能力注入（Host API），插件可以携带代码在**宿主外子进程**中实现能力适配（首批：媒体生成），运行状态 / 过程反馈 / 最终产物在 UI 全程可见。设计依据：[docs/design/61-plugin-runtime-platform.md](../../docs/design/61-plugin-runtime-platform.md)（D125）。

**前置依赖**：[todo/capability-model-plugins](../capability-model-plugins/README.md) 的 P1/P2 必须先行（条目模型、`MediaEntrySource`、实例 materializer——本方案的托管适配器要挂进它的解析链）。

## 给执行智能体的规则

- **阅读顺序**：本 README → [CURRENT-STATE.md](CURRENT-STATE.md) → [61 号设计](../../docs/design/61-plugin-runtime-platform.md) → 对应阶段任务书 → 阶段「必读」点名的文件。
- **不得自行决定的事**：61 号「决策」11 条与「§10 待确认决策」的取向不得改动；固定契约（见下）名字不得改动；**进程内执行第三方代码仍然禁止**（哪怕"更简单"）；插件不得获得 fs / 子进程 / 环境变量能力（§10 Q5 未决前）；community 层级执行型仍拒绝（Q4 未决前）；产物下载与落附件必须在 core 侧。
- **自由度**：进程管理内部实现（fork 参数、重试退避、队列结构）、SDK 包内部组织、测试拆分可自定；协议帧字段在满足固定契约的前提下可增补（只能增不能改语义）。
- **测试规则**：迭代中只跑定向（`node scripts/run-tests.mjs run <文件>`）；shared / SDK 改动先 `pnpm --filter @kepcup/shared build` / 对应包 build；每阶段收口跑验收列出的定向测试一次；全量 `pnpm test` 只在 P4 收口跑一次。
- **提交分支**：每阶段一分支 `feat/plugin-runtime/p<N>-<slug>`。
- **偏差**：记 `DEVIATIONS.md`（DEV 顺延，开工前 `rg "DEV-" DEVIATIONS.md | tail -5`）。
- **全局不要做**：不动 D104/D105 既有安装管线语义（只在同意卡与校验处增量）；不动 `media/http.ts` 错误归一；不动 orchestrator / RPC 绑定层的结构（只加注入点）；不实现 Q1–Q5 未决项。
- **代码规范**：与既有代码一致；协议与 SDK 的 zod 一律 `strictObject`；子进程代码不得 import core 内部模块（用 lint 边界保证）。

## 范围

| 包含 | 不包含 |
|---|---|
| 协议 schema（shared）+ `@kepcup/plugin-sdk` + 参考插件骨架 | Cordis 或任何插件元框架（D125-a：不采用） |
| PluginHost：每插件一进程 / 握手 / 看门狗 / 空闲回收 / 调用队列 | 进程内执行第三方代码（永久禁止） |
| Host API v1：net(白名单+SSRF+审计) / credentials 注入 / secrets 读 / storage / log / progress / signal | `host.secrets.set`（Q1）、fs（Q5）、持久型插件（Q3） |
| `HostedAdapter`（media 契约）+ 条目解析分支（`runtime` 插件优先于 `engine`） | 新能力契约实现（search/wiki/sensor 只留注册表形状） |
| 可观测：`plugin.runtime` 事件、状态徽标、活动抽屉、progress 打通 | community 执行型（Q4） |
| 同意卡能力披露 + 市场 CI 静态扫描钩子；`plugins/dashscope-t2i/` 执行型试点（百炼文生图，协议与内置引擎同源作 A/B dogfood） | 试点插件正式上架运营（P4 完成试点与真机验收，上架走既有 release 流程） |
| 迁移 0076 `plugin_storage` | marketplace 索引服务端改动（沿用 D104 机制） |

## 阶段依赖图

```text
capability-model-plugins P1/P2（前置）
        │
        ▼
P1 协议与 SDK ──▶ P2 PluginHost 运行时 ──▶ P3 可观测 UI ──▶ P4 治理与试点
 (protocol/sdk/      (进程/看门狗/能力桥/       (状态徽标/活动/      (同意卡披露/扫描/
  参考插件)            HostedAdapter 接线)        错误人话)            百炼试点)
```

P1 与 capability-model-plugins P3/P4 可并行；P2 依赖其 P2（`MediaEntrySource` 落点）；P3 依赖 P2 的状态事件；P4 依赖 P1–P3。

## 固定契约（名字不得改动）

**shared**
- 协议模块：`packages/shared/src/plugin-runtime/protocol.ts`；帧判别联合：`PluginRuntimeFrame`（`init / ready / invoke / cancel / shutdown / result / error / event / state`），事件 kind：`'progress' | 'log'`
- manifest 增量段：`runtime`（`entry / hostApi / network.allow? / maxConcurrent`）
- 错误码：`PLUGIN_CRASHED` / `PLUGIN_TIMEOUT` / `PLUGIN_CONTRACT_VIOLATION` / `PLUGIN_NETWORK_DENIED`（版本不匹配复用既有 `PLUGIN_UPGRADE_REQUIRED`）

**core**
- 运行时模块：`packages/core/src/plugins/runtime/`——`PluginHost`（进程与生命周期）、`CapabilityBridge`（Host API 实现）、`HostedAdapter`（media 契约代理）、`contracts.ts`（`CAPABILITY_CONTRACTS`，v1 仅 `'media'`）
- 状态机值：`'stopped' | 'starting' | 'ready' | 'busy' | 'error'`
- RPC：`plugins.runtime.list`（状态 + 最近调用历史）/ `plugins.runtime.restart`
- 事件：`plugin.runtime`（状态迁移广播）
- 调用历史：每插件内存环形缓冲 50 条（`{at, contract, method, durationMs, ok, errorCode?, message?}`）

**存储**
- 迁移 0076（main）：`plugin_storage (plugin_id, key, value_json, updated_at, PK(plugin_id,key))`——编号以开工前核对为准
- secrets：沿用 `plugin:{pluginId}:instance:{instanceId}:{key}`（只读消费，无新键型）

**SDK**
- 包：`packages/plugin-sdk`（发布名 `@kepcup/plugin-sdk`）；入口 helper：`definePlugin()`；宿主 API 命名空间：`host.net / host.secrets / host.storage / host.log / host.progress / host.signal`；参考插件：`plugins/reference-media/`（builtin，developer 调试用）

## 术语

- **托管适配器（HostedAdapter）**：core 侧实现 `VendorAdapter` 的代理对象，把方法调用转发给插件进程并回翻译结果/错误。
- **能力桥（CapabilityBridge）**：插件进程 → 宿主基础能力（net/secrets/storage/log/progress）的唯一通道，白名单与配额在此强制。
- **能力契约（contract）**：一类可插拔能力的窄接口（方法面 + zod schema + 超时），v1 = `media`。
- **执行型插件**：manifest 含 `runtime` 段、包内带代码、以本运行时执行的插件。

## 完成定义

- 61 号「验收锚点」七条全过（证据 = 测试 / 提交号，记 P4 实施记录）。
- 全程未安装执行型插件的环境行为与今日逐字节一致（P2 定向回归证据）。
- 全量 `pnpm test` 收口一次全绿（P4）。
- 61 号补「现状」节（仿 51 §15）、51 号 §15 加运行时平台回写、DEV 偏差无未决项。

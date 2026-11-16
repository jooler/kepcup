# 61 插件运行时平台（Plugin Runtime Platform）

> 状态：**已实施（2026-11-16，D125 P1–P4 开发收口；真机验收待用户执行，现状见 §12）** · 决策：D125 · 上游：[51 插件系统](51-plugin-system.md)（D104/D105）、[60 能力模型插件化](60-capability-model-plugins.md)（D124，本文修订其决策 1 并退休其 Q1）· 执行方案：[todo/plugin-runtime](../../todo/plugin-runtime/README.md)

愿景（用户原话的架构化）：**应用提供舞台，保证核心能力稳定运行，为插件提供基础能力和运行规范，插件在规范内享有最大范围的构建、运行自由**。拆成五个可验收的支柱：

1. **稳定基建**——对话 loop、存储、RPC、审批、密钥、事件总线是宿主内核，契约冻结、永不插件化；
2. **能力扩展**——插件以能力贡献进宿主（当前：技能 / 连接 / MCP / 邮件 / IM / 能力模型条目），新能力类型经注册表加入；
3. **插件自由**——插件可以携带**代码**，在规范内自行实现任意逻辑（组参、签名、轮询、令牌管理），不被声明式清单锁死；
4. **数据交换**——宿主与插件之间有明确、可校验、可演进的交换协议：输入进、事件流、产物出；
5. **可观测**——插件的运行状态、过程反馈、最终产物在 UI 中可见：状态徽标、活动记录、对话内进度、产物落附件。

外部对照（2026-11 调研，细节见 60 号 §0 与本轮调研）：VS Code 验证了「内置功能也是插件 + 扩展宿主进程隔离」；Koishi/Cordis 验证了「可逆副作用 + 服务注入」在 4800+ 插件规模可行但**不提供隔离与权限**；DeepSeek Harness（基于 Cordis）验证了「连 loop 都可插件」但官方选择 vendoring + 28 处补丁且明告 breaking；Obsidian 证明了「给全量 Node 能力」的长期代价是审核带宽与安全事件。**决策 D125-a：不引入 Cordis 等插件元框架**——它解决的问题（生命周期/DI/热重载）在本设计中由自研运行时以更小面承接，它不解决的问题（进程隔离、能力注入、分发治理）无论引不引都要自建；其「可逆副作用、响应式依赖、窄契约」三个思想被吸收进设计（见 §1）。

相关：D21（pi 封装）、D58/D89（setup 链与设置目录）、D72（AgentEngine 第二实现）、D74/D104（信任分级与市场）、D75（对话轮/任务分治）、D106（进度反馈链）。

## 决策

- **D125 插件运行时平台**：
  1. **双形态插件模型**（修订 [D124 决策 1](60-capability-model-plugins.md)）：插件仍是清单驱动的声明式贡献包（形态 A，现状延续）；在此之上新增**执行型插件**（形态 B）——清单携带 `runtime` 段（入口、Host API 版本、能力声明），包内带打包后的 JS 代码，在**宿主外子进程**中运行，经能力桥调用宿主基础能力，经能力契约向宿主返回结构化结果。**进程内执行第三方代码仍然禁止**（D104 精神保留并强化：自由靠进程边界 + 能力注入实现，不靠信任）。
  2. **宿主内核与插件边界冻结为三层**：内核（loop/存储/RPC/审批/密钥/事件，永不插件化）→ 运行时（PluginHost：进程/协议/能力桥/治理，第一方随应用发版）→ 插件（双形态）。插件永不直接 import 内核模块、不共享内存、不拿裸 Node 能力。
  3. **能力契约注册表**：执行型插件实现的不是泛化 API，而是**逐能力类型的窄契约**（v1 仅 `media`：方法面 = `VendorAdapter` 现有七方法，zod schema 双向校验）。运行时是通用的，契约是注册的——新能力类型（检索供应商、wiki 派生、传感器）= 注册新契约，不改运行时。这是对「Theia 开放内核失去生态规模」教训的直接回应。
  4. **进程模型**：每插件一个 `child_process.fork` 子进程（打包单文件 JS，禁 native 模块），懒启动、空闲回收（默认 5 分钟）、调用级看门狗（心跳 + 超时击杀）、崩溃自动隔离——单插件故障的爆炸半径 = 该插件返回错误（归一进 `PROVIDER_UNAVAILABLE` 族），内核与其它插件不受影响。
  5. **Host API v1（能力注入面）**：`net.fetch`（清单域名白名单，core 侧强制 + SSRF 防护 + 审计）、`credentials`（调用时注入清单声明的敏感字段）+ `secrets.get`（仅本插件实例键的读）、`storage`（插件 KV，配额 10MB）、`log`、`progress`、`signal`（取消）。**不给**：文件系统、子进程、环境变量、其它插件数据、宿主审批/沙箱语义。
  6. **边界即契约**：调用输入、事件、输出全部 zod 校验（schema 定义在 shared，两侧共用）；插件输出不符合契约 = `PLUGIN_CONTRACT_VIOLATION`（fail-safe，绝不部分投递）。产物仍按引用返回 URL/编码数据，**下载与落附件永远在 core 侧**（产物策略不变）。
  7. **可观测闭环**：插件进程状态机（stopped/starting/ready/busy/error）经 `plugin.runtime` RPC 事件广播；每次调用入内存环形历史（方法/时长/状态/错误）；UI 三层呈现——扩展中心插件卡状态徽标 + 活动抽屉、对话内经既有 progress 通道（D106/D55）实时反馈、产物走既有确定性投递。错误一律映射成人话（复用 `media/http.ts` 错误族）。
  8. **信任矩阵（形态 × 层级）**：执行型开放给 builtin（第一方）、verified（签名 + 逐版本自动扫描 + 人工审查）、developer（本机）；**community v1 仅声明式**（远期评估「用户显式全局开关」）。安装同意卡披露能力清单（联网域名 / 凭据字段 / 存储配额）——Chrome 扩展式声明权限 UX。
  9. **SDK 与协议单一事实来源**：`packages/shared/src/plugin-runtime/protocol.ts`（帧 schema）+ `packages/plugin-sdk`（`definePlugin()` + 类型 + 开发器），插件以 esbuild 单文件打包，`engines.kepcup` 锁 Host API 版本，不匹配 → 既有 `PLUGIN_UPGRADE_REQUIRED`。
  10. **治理自动化**（Obsidian 2026 教训前置）：市场 CI 对执行型包逐版本跑静态扫描（native 模块 / eval / 远程动态 require / 白名单与代码一致性），签名沿用 Ed25519 索引；撤销名单与插件级停用（kill switch）沿用 D104。
  11. **[D124 Q1 退休](60-capability-model-plugins.md)**：通用 HTTP 模板引擎不再规划——执行型插件覆盖其全部动机且表达力更强。D124 的条目/绑定/解析/记账/setup 各层不变；条目解析只扩一条：插件含 `runtime` 时该插件条目解析到**托管适配器**（PluginHost 代理），否则仍按 `engine` 走内置引擎。

## 1 分层总览

```text
┌─ 舞台（宿主内核，永不插件化，契约冻结）────────────────────────┐
│  对话轮/任务 loop(pi) · 存储(main/runs.db) · RPC hub · 审批/密钥 │
│  事件总线 · 媒体网关 · 工具网关 · 附件投递                       │
├─ 运行时（PluginHost，第一方，随应用发版）──────────────────────┤
│  进程管理(懒启/回收/看门狗) · IPC 协议(zod 双向校验)             │
│  能力桥(net/secrets/storage/log/progress) · 状态机与活动记录     │
├─ 能力契约注册表（v1: media = VendorAdapter 方法面）─── 未来: search/wiki/… ──┤
├─ 插件（舞台上的演员）─────────────────────────────────────────┤
│  形态 A 数据型：技能/连接/MCP/邮件/IM/能力条目(绑定内置引擎)      │
│  形态 B 执行型：自带代码 + 能力声明 → 子进程运行                  │
│    （即梦视频、可灵 JWT、任何内置引擎覆盖不了的厂商协议）          │
└───────────────────────────────────────────────────────────────┘
```

设计原则（吸收自调研）：**窄契约**（契约面越小越守得住——Koishi Session 契约四年冻结撑起 4800 插件）；**可逆副作用**（Cordis 的核心思想，运行时以「调用级超时 + 击杀 + 逆序清理」承接）；**能力注入而非能力授予**（比 Obsidian 的全量 Node 少养审核带宽）；**fail-safe 边界**（坏输出安全失败，绝不半投递）。

## 2 双形态插件模型

- **形态 A（数据型，现状）**：`contributions.*` 声明条目，执行侧在宿主（技能文件、MCPB/远程 MCP、连接器、邮件/IM 通道、绑定 `MEDIA_ENGINES` 的能力条目）。51/D105 各机制不变。
- **形态 B（执行型，新增）**：清单增可选段（仍是 `format_version: 1`，增量字段，旧应用读到即 `PLUGIN_UPGRADE_REQUIRED`）：

```ts
runtime: strictObject({
  entry: string,                    // 包内相对路径，打包单文件 JS（ESM）
  hostApi: string,                  // 期望的 Host API semver，如 '^1'
  network: strictObject({ allow: z.array(z.string()).max(32) }).optional(),
                                    // 域名白名单：精确 host 或 '*.domain'
  instanceFields: z.array(pluginFieldSchema).max(16).optional(),
                                    // D125 P4（DEV-114）：实例字段声明面（敏感值走实例
                                    // secrets，调用时经 invoke.context.credentials 注入）
  timeouts: z.record(z.string(), z.number().int().min(1000).max(900000)).optional(),
                                    // D125 P4（DEV-130）：方法级调用超时声明，key =
                                    // '<contract>.<method>'（如 media.generateImage）。
                                    // 插件按自己的厂商协议给合理时长，宿主只钳制上限
                                    // （15 分钟）；未声明走契约默认。安装期校验方法已注册。
  maxConcurrent: z.number().int().min(1).max(4).default(1),
}).optional()
```

- 条目仍走 `contributions.capabilityModels[]`（`capability/model/params/displayName` 不变，**不填 `engine`**）；该插件条目在解析链上落到托管适配器。声明校验：有 `runtime` ⇒ 至少一条执行型可消费的贡献；`runtime` 仅 builtin/verified/developer 层级允许（community 提交含 `runtime` → 拒）。
- 安装管线增量：包防护（禁 `.node`/`.wasm` 二进制、禁符号链接逃逸）→ 静态扫描（P4 前人工审查顶替）→ 能力披露渲染进同意卡 → 原子落盘 + 账本。`plugin_items` 账本照记。

## 3 插件运行时（PluginHost）

### 3.1 进程与生命周期

- **一插件一进程**：`child_process.fork(entry, { serialization: 'advanced', execArgv: [] })`，工作目录指向插件安装目录。desktop（core 为 utilityProcess）与 headless server 同构。
- **状态机**：`stopped → starting → ready ⇄ busy → error`。懒启动（首次调用拉起）；`idle` 5 分钟无调用 → 优雅停（`shutdown` 请求 + 2s 强杀）；崩溃/看门狗击杀 → `error`（带原因）→ 下次调用自动重启。
- **握手**：`init {hostApiVersion, manifestDigest, instances}` → 插件回 `ready {hostApiVersion, contracts: string[]}`；版本不匹配回错误并拒绝调用（`PLUGIN_UPGRADE_REQUIRED`）。
- **看门狗**：每 15s ping，2 次无响应击杀；每次调用带能力级超时——**取值优先插件清单声明**
  （`runtime.timeouts['<contract>.<method>']`，如 `media.generateImage: 300000`），未声明走
  契约默认（media：图片 120s、TTS 120s、ASR 300s、视频 15 分钟），宿主只钳制 15 分钟上限。
  超时即 `cancel` + 击杀 + `PLUGIN_TIMEOUT`。**理由（DEV-130）**：同步出图 / 异步排队 /
  视频生成的合理时长差异很大，应用用一个固定值会误杀正常厂商请求；插件最了解自己的协议，
  超时该由它声明，应用的职责只是「有上限 + 到点必杀」。
- **并发**：每插件进程内调用串行排队（v1，`maxConcurrent` 预留）；插件自身轮询占用的是等待时间而非 CPU，串行不影响吞吐主场景。

### 3.2 调用协议（`packages/shared/src/plugin-runtime/protocol.ts`）

```text
host → plugin   init / invoke{callId, contract, method, params, context} / cancel{callId} / shutdown
plugin → host   ready{hostApiVersion, contracts, features?}
                / result{callId, output} / error{callId, code, message, details?}
                event{callId, kind:'progress'|'log', payload} / state{status, detail?}
```

- `context` = `{ entryId, model, params(条目 params 合并), locale, credentials, instanceId? }`——`credentials` 为该实例 `sensitive:true` 字段的键值（调用时注入，进程内存存活，**永不落盘、永不入日志**）；`instanceId` 仅在插件于 `ready.features` 声明 `invoke.context.instanceId` 时发送（旧 SDK 不带 features → 不发送，其 strict 帧校验不会被未知字段打断）。
- 两侧 zod 校验同一 schema 包；宿主侧输出校验失败 = `PLUGIN_CONTRACT_VIOLATION`（不重试、不部分投递）；输入校验失败 = 插件侧拒绝并回 error。
- 传输即 fork 内置 IPC（JSON 序列化）；大产物一律按引用（厂商 URL 或 `host.net` 拉取后的 base64，上限 20MB），**媒体产物下载与落附件永远 core 侧**（60 §1 产物策略不变）。

### 3.3 资源治理

| 维度 | 规范 | 越界处置 |
|---|---|---|
| 调用时长 | 插件声明（`runtime.timeouts`）> 契约默认；宿主钳制 15 分钟（§3.1） | `PLUGIN_TIMEOUT` + 击杀 |
| 单次网络请求 | 插件声明（`net.fetch` 的 `init.timeoutMs`）；宿主钳制 15 分钟，不设隐含固定值 | 超时归 `PROVIDER_UNREACHABLE`；进程退出时在途请求被取消 |
| 网络 | 清单白名单，core 侧强制 + SSRF 防护（复用 `web_fetch` 守卫）+ 审计计数 | 拒绝 + `PLUGIN_NETWORK_DENIED`，插件卡可见 |
| 存储 | `host.storage` 配额 10MB/插件 | 写入拒绝 |
| 日志 | `host.log` 限速（100 条/调用） | 截断 + warn |
| 内存 | v1 不强制（观测项）；RSS > 512MB 记 warn | 记录，远期加压 |

## 4 Host API v1

| API | 语义 | 边界强制 |
|---|---|---|
| `host.net.fetch(url, init?)` | HTTP 客户端（fetch 语义，JSON/文本/二进制→base64）；`init.timeoutMs` 由插件声明单次超时 | 域名白名单（§3.3）、SSRF 守卫、UA 固定、审计计数、单次 20MB、超时钳制 15 分钟（§3.3） |
| `context.credentials` | 实例敏感字段注入（只读） | 仅清单声明的键；进程内存活；不落盘不入日志 |
| `host.secrets.get(key)` | 本插件实例键的读取（长生命周期插件重建凭据用） | 键必须匹配 `plugin:{pluginId}:instance:{instanceId}:*`；只读（`set` 不开放，见 §11 Q1） |
| `host.storage.get/set/delete/list(prefix?)` | 插件 KV（sqlite `plugin_storage`，随插件卸载清除） | 配额 10MB；存非敏感数据（敏感走 secrets） |
| `host.log(level, msg, data?)` | 结构化日志（core logger 加插件前缀） | 限速；进诊断包 |
| `host.progress({phase?, percent?, message?})` | 进度上报 → run 进度通道（对话内状态行 / 任务详情页） | 限速（≤1 次/秒） |
| `signal` | 取消传播（用户取消任务/工具超时） | abort 后插件应尽快返回；宿主到点强杀 |

## 5 能力契约注册表

- core 侧 `CAPABILITY_CONTRACTS`（`plugins/runtime/contracts.ts`）：`{ id, methods: Record<name, {params, output, timeoutMs}>, errorNamespace }`。运行时对契约零知识——只做进程/协议/治理；类型化校验全部由契约 schema 提供。
- **v1 唯一契约 `media`**：方法面 = `VendorAdapter` 现有可选方法（`generateImage / synthesizeSpeech / transcribeSpeech / understandImage / submitVideo / videoStatus / cancelVideo`），params/output schema 从 `media/types.ts` 现有形态派生；`embed` 不开放（60 §10 Q4 维持）。
- core 侧托管适配器 `HostedAdapter`：实现 `VendorAdapter`，方法调用转发 PluginHost（排队/超时/取消/事件转发），错误归一进 `media/http.ts` 错误族（`PLUGIN_CRASHED` / `PLUGIN_TIMEOUT` / `PLUGIN_CONTRACT_VIOLATION` → `PROVIDER_UNAVAILABLE` 语义承接，`PROVIDER_AUTH_FAILED` / `PROVIDER_QUOTA` 允许插件显式声明映射——配额/认证分家语义不变，c0bf9168）。
- `MediaEntrySource` 扩一个分支：条目所属插件含 `runtime` → `HostedAdapter(pluginId)`；否则 `MEDIA_ENGINES[entry.engine]`。解析顺序、Bot 绑定、usage 扩列、`testCapabilityEntry`（探测经同一托管适配器）全部不动。
- 未来契约路标（注册即用，不改运行时）：`search-provider`（检索供应商）、`wiki-derive`（多模态入库派生，D85）、`sensor`（D76 transport）。本期只做注册表形状，不实现。

## 6 可观测：状态、反馈、产物（愿景支柱 5）

- **状态**：状态机每次迁移广播 `plugin.runtime` RPC 事件 `{pluginId, status, detail?}`；扩展中心插件卡右上状态徽标（ready/busy/error + 最近错误摘要），「查看活动」抽屉 = 内存环形历史（每插件最近 50 次调用：时间 / 契约.方法 / 时长 / 结果 / 错误人话）。
- **反馈**：`host.progress` → core 转发进调用所属 run 的进度通道（`ctx.progress`）→ 对话内状态行（D55）与任务详情页（D93 计划区）复用既有渲染，**零新 UI 通道**；视频生成的阶段文案（排队/生成中/下载中）由插件给出，宿主限速透传。
- **产物**：不变——图片/音频/视频经 `media-delivery` 确定性投递为消息附件；插件只返回引用，不接触投递语义。
- **失败**：插件崩溃 / 超时 / 契约违规在 UI 呈现为人话（「即梦插件无响应，已重试 / 请查看插件活动」），与厂商 API 故障同层呈现，不暴露进程细节。

## 7 信任与治理

| 层级 | 形态 A | 形态 B（执行型） | 门槛 |
|---|---|---|---|
| builtin | ✓ | ✓ | 第一方，随发版 |
| verified | ✓ | ✓ | Ed25519 签名 + 人工审查 + **逐版本 CI 静态扫描** |
| community | ✓ | ✗（v1） | 远期评估「用户显式全局开关」 |
| developer | ✓ | ✓ | 本机目录，安装即恒 developer（D104） |

- 同意卡披露：联网域名清单、凭据字段名（不含值）、存储配额；更新时能力清单扩大 → 重新同意（D104 既有机制延伸）。
- 逐版本扫描（市场 CI）：native/二进制检测、`eval`/`Function`/`require`/`createRequire` 等动态代码执行面检测、静态与动态 import 的受限内置模块（fs / net / http / child_process / vm / worker_threads / module …）与远程 / 包外 specifier 检测、`network.allow` 与包内字符串域一致性比对；告警即人工复审，违者走撤销名单（warn/disable 既有语义）。`runtime.entry` 限定 `.js/.mjs`（`.js` 需 `package.json` 的 `"type":"module"`，禁嵌套
package.json）；签名扫描归档本身，不应用 `.kepcup-ignore`。
- 运行期治理：插件级停用（kill switch）即时生效（kill 进程 + 拒绝后续调用）；撤销名单命中 → disable（既有）。

## 8 与存量决策的关系

- **D104 修订**：「不含宿主进程内执行的代码」精化为「**进程内**执行仍然禁止；**进程外**执行型插件经能力契约开放，v1 限 media 契约与 verified/builtin/developer 层级」。技能/连接/MCP/邮件/IM 的形态与机制全部不变。
- **D124 修订**：决策 1「插件 = 纯数据声明包」→ 双形态；决策 4 引擎注册表不变（执行型是与引擎并列的适配器来源）；Q1（HTTP 模板引擎）退休；迁移 0075 与 todo/capability-model-plugins 的 P1–P4 全部维持，plugin-runtime 的分期依赖其 P1/P2（条目模型与 `MediaEntrySource` 先落地）。
- **51 号 §15**：收口后回写「运行时平台现状」节（仿其先例）。
- **设置目录零新增**：运行时不设全局开关（状态可见性走插件卡）；community 执行开关若未来开放，届时按 AGENTS.md 登记为 `user-only` 条目。

## 9 分期

依赖 [todo/capability-model-plugins](../../todo/capability-model-plugins/README.md) P1/P2（条目模型 + `MediaEntrySource`）先行。详见 [todo/plugin-runtime](../../todo/plugin-runtime/README.md)：

**P1 协议与 SDK**（shared 协议 schema + `packages/plugin-sdk` + 参考插件骨架）→ **P2 PluginHost 运行时**（进程管理/握手/看门狗/能力桥 + `HostedAdapter` + 条目解析分支 + 迁移 0076 `plugin_storage`）→ **P3 可观测 UI**（状态徽标 / 活动抽屉 / progress 打通）→ **P4 治理与试点**（同意卡披露、扫描钩子、首个执行型官方插件：**阿里云百炼文生图执行型试点**——协议与内置引擎同源，作 A/B dogfood）。

## 10 待确认决策

- **Q1 `host.secrets.set`**：插件自轮换令牌（cookie 过期自动续）需要写 secrets；v1 只读（用户在 UI 更新）。若试点证明必须，加「插件写入需在同意卡声明 + UI 提示变更」的受控写。
- **Q2 并发池化**：串行排队在高频短调用（批量图片）下可能成瓶颈；出现实测瓶颈再按 `maxConcurrent` 进程池化。
- **Q3 持久型插件**：监看类（自行订阅外部事件）需要常驻进程 + 健康检查；与 D79 宿主监看的关系先想清楚再开放，本期不做。
- **Q4 community 执行型**：等扫描管线运行一段时间、verified 试点稳定后再评估。
- **Q5 fs 能力**：需要本地文件的插件（如缓存大文件）远期以 `host.files.scopedTmp()` 形态评估，v1 不给。

## 验收锚点

- 安装一个执行型插件（百炼 Qwen-Image 试点或参考插件）→ 同意卡显示能力披露 → 添加实例填 Key → Bot 勾选条目 → 任务里 `generate_image` 走插件：对话内可见进度阶段（同步试点只报「提交」，参考插件报排队/生成中）→ 产物落附件 → 插件卡显示 busy→ready、活动抽屉有调用记录。
- 拔网线/断网：插件 `net.fetch` 出白名单域被拒，插件卡活动可见 `PLUGIN_NETWORK_DENIED`。
- 插件代码死循环：看门狗超时击杀，工具收 `PROVIDER_UNAVAILABLE` 人话错误，内核与其它插件无感，插件卡标 error、下次调用自动重启。
- 插件返回不合 schema 的输出：`PLUGIN_CONTRACT_VIOLATION`，无部分投递。
- 卸载插件：进程终止、`plugin_storage` 清除、secrets 清除、条目残留按 60 §决策 5 静默跳过。
- 全程未安装执行型插件的环境：行为与今日逐字节一致（定向测试证据）。

## 12 现状（D125 收口后）

> 2026-11-16，P1–P4 开发收口。仿 [51 §15](51-plugin-system.md#15-现状d105-插件平台迭代2026-10-29-收口)：
> 实际落地、与决策的差异、迁移号、DEV 索引、试点 A/B 结论与未决项。真机项标注「待用户验证」。

### 12.1 实际落地（与本文决策的对应）

| 决策 | 落地 |
|---|---|
| 1 双形态 / 进程外执行 | `runtime` 段 + `plugins/*` 单文件 ESM；`child_process.fork`（execArgv 空、最小 env、cwd=安装目录）；进程内执行仍禁止 |
| 2 三层边界 | 内核未动；`plugins/runtime/` 为第一方运行时；插件经 SDK 只见 `host` 命名空间 |
| 3 能力契约注册表 | `plugins/runtime/contracts.ts` 的 `CAPABILITY_CONTRACTS`，v1 仅 `media`（七方法 zod 双向） |
| 4 进程模型 | 每插件一进程；懒启动 / 空闲 5 分钟优雅停 / 15s ping ×2 击杀 / 调用级超时；串行队列（`maxConcurrent` 预留） |
| 5 Host API v1 | `net.fetch`（白名单 + SSRF + 审计 + 20MB）/ `credentials` / `secrets.get` / `storage`（10MB）/ `log` / `progress` / `signal`；未给 fs / 子进程 / env；`secrets.set` 未开放（Q1） |
| 6 边界即契约 | shared `plugin-runtime/protocol.ts` 单一事实源；输出不过契约 = `PLUGIN_CONTRACT_VIOLATION`，不部分投递；产物 URL 由 core 下载落附件 |
| 7 可观测 | `plugin.runtime` 事件 + 状态徽标 + 活动抽屉（50 条环形） + progress 走既有状态行；错误经 `HostedAdapter` 归一 |
| 8 信任矩阵 | 安装管线拒 community 执行型；builtin / verified / developer 放行；同意卡披露 + 扩权 diff 重新同意 |
| 9 SDK / 协议 | `@kepcup/plugin-sdk`：`definePlugin` / `runPluginRuntime` / `host`；esbuild 单文件；`hostApi` 不匹配复用 `PLUGIN_UPGRADE_REQUIRED` |
| 10 治理自动化 | 市场签名脚本逐版本静态扫描（文件面 / 代码面 / 白名单一致性），fail 不出包，pass/warn 写索引 `runtimeScan`；kill switch 沿用 D104 |
| 11 D124 Q1 退休 | 条目解析新增 `source: 'plugin'` 分支（含 runtime 的插件条目 → `HostedAdapter`），数据型条目行为不变 |

固定契约名全部未改；本阶段只**增量**了 `runtime.instanceFields`（DEV-114 方案 1）、
`invoke.context.instanceId`（可选）与 `ready.features`（可选能力声明，宿主据此决定是否
发送 `instanceId`），已在 §2 / §3.2 与 todo README 同步。

### 12.2 迁移与数据

- 迁移实际号 **0076**（main）：`plugin_storage (plugin_id, key, value_json, updated_at, PK(plugin_id,key))`，
  与规划一致；无其它迁移。
- secrets 无新键型：执行型实例凭据沿用 `plugin:{pluginId}:instance:{instanceId}:{key}`
  （`instanceFields.sensitive` 写入、`credentialsFor` 前缀扫描读取）。
- 卸载清理：进程终止、`plugin_storage` 清空、实例行与 secrets 级联清除、条目残留静默跳过
  （`packages/core/test/unit/plugin-host.test.ts` 的卸载用例覆盖）。

### 12.3 DEV 偏差索引

- P1–P3：DEV-104–DEV-122（协议落点、Host API 信封、心跳与 SDK 重建、取消链、活动历史口径、
  视频阶段文案、执行型判定来源等），详见 [DEVIATIONS.md](../dev/DEVIATIONS.md)。
- P4：**DEV-123** `runtime.instanceFields` + `invoke.context.instanceId`（落实 DEV-114；
  兼容面用 `ready.features` 握手，旧 SDK 不收到新字段）；
  **DEV-124** 试点模型：首版 `wan2.7-t2v`（视频模型）被真机以 `url error` 拒绝 →
  改为用户指定的 `qwen-image-3.0` + 同步协议（`params.model` 可覆盖）；
  **DEV-125** RSS 观测用插件心跳自报；**DEV-126** 静态扫描掩码与域名豁免；
  **DEV-127** 产物下载 SSRF 加固对所有来源生效（http(s) 使用与 Agent 同版本的 undici fetch）；
  **DEV-128** native 扩展名补 `.dll/.so/.exe/.dylib`；
  **DEV-129** 静态扫描审查加固（标识符级规则 / 静态 import 与包外路径 / `runtime.entry`
  的 ESM 策略（`.js/.mjs` + `type: module`）/ `.kepcup-ignore` 目录口径；已知假阴性面见该条）。
- 真机反馈修正（2026-11-16，DEV-124 / DEV-130）：**DEV-124** 试点模型改
  `qwen-image-3.0`（首版 `wan2.7-t2v` 是视频模型，被文生图端点以 `url error` 拒绝）；
  **DEV-130** 超时治理交给插件——`runtime.timeouts`（方法级调用超时声明）+ `net.fetch`
  的 `init.timeoutMs`，宿主只钳制 15 分钟上限并取消进程退出时的在途请求（原 60s 固定
  上限会误杀长任务）；试点随之改回 qwen-image **异步**任务 + 轮询（单次请求秒级）。
  无未决阻塞项。

### 12.4 试点 A/B 结论（百炼 Qwen-Image，`plugins/dashscope-t2i/`）

**事实修正（三轮）**：① 任务书假设「插件协议与内置引擎同源」——内置 `generateImage` 是
qwen-image 同步 `multimodal-generation`，异步「提交 → 轮询」的代码形状属于
`submitVideo / videoStatus`。② 首版按 16 号 wan 视频预置取 `model: wan2.7-t2v`，真机被
百炼以 `url error` 拒绝（视频模型不能用于文生图端点）。③ 改用 `qwen-image-3.0` 同步协议
后，真机调用又在 **60s 网络超时**失败——该 60s 是应用侧 `host.net.fetch` 的固定上限，
比插件声明的调用看门狗（120s）还短，等于应用替插件决定了「单次请求最多多久」。
**现状**：试点改为 qwen-image **异步**任务接口（提交 + 轮询，单次请求都是秒级）+ 清单声明
`runtime.timeouts['media.generateImage'] = 300000`；`host.net.fetch` 的单次超时改由插件
声明（`init.timeoutMs`），宿主只钳制 15 分钟上限并取消进程退出时的在途请求（DEV-130）。

集成层对照（同一 prompt / size / model，无 API Key，测试
`plugin-host.test.ts` 的「A/B 对照（集成层）」）：

| 维度 | 执行型插件（异步任务） | 内置引擎（同步） |
|---|---|---|
| 端点 | `image-generation/generation` + `X-DashScope-Async` → `GET /api/v1/tasks/{id}` | `multimodal-generation/generation` 单请求 |
| 单次网络请求 | 秒级（提交 / 每次轮询） | 连接保持到出图完成（`prompt_extend` 常 60s+） |
| 长任务鲁棒性 | 轮询失败可重试；不受单次连接时长限制 | 任一网络抖动 / 代理超时即整次失败 |
| 超时 | 插件声明 5 分钟（宿主钳制 15 分钟） | 适配器内置 120s |
| 进度 | `submitting → queued → generating → downloading` 进状态行 | 无阶段进度 |
| 取消 | `signal` → 轮询间隙尽快返回（不删服务端任务） | 引擎路径无工具 signal（DEV-118/119） |
| 活动记录 | 插件卡 busy→ready + 调用历史（时长 / 结果 / 错误 / CANCELLED） | 无插件活动 |
| 错误文案 | 插件映射：`百炼鉴权失败 / 额度不足 / 请求过于频繁 / 图片生成失败`（`url error` 附 model 指引） | `media/http.ts` 的厂商错误归一 |
| 产物 | URL → core 下载（SSRF 守卫）→ 既有附件投递 | 同左（同一投递链） |

**结论**：图片 / 视频这类长任务，**异步任务 + 轮询是更合适的协议形态**（官方亦推荐该
模式；同步接口把生成时长压在一条 HTTP 连接上，失败面大且不可观测）。执行型运行时的价值
在此被直接证实：插件自带状态机就能采用异步协议，内置引擎的同步实现则要改代码发版。
超时治理随之定案：**超时由插件声明，应用只钳制上限**（DEV-130）；内置引擎的 120s
仍是其自身实现的选择，不构成对插件的约束。

**真机状态**：`qwen-image-3.0` + 异步轮询已落地；真机出图待用户复验（`testCapabilityEntry`
先测连接，再在 Bot 任务里出图）。

### 12.5 Q1–Q5（被试点证实 / 仍未决）

- **Q1 `host.secrets.set`**：试点未需要——API Key 由用户在实例表单填写、调用时注入，
  插件无自轮换令牌场景。维持只读。
- **Q2 并发池化**：未出现实测瓶颈（试点串行排队；轮询是等待不是 CPU）。维持串行。
- **Q3 持久型插件**：未涉及。仍未决。
- **Q4 community 执行型**：静态扫描管线已落地（P4），但只有两个第一方包跑过；维持 v1
  拒绝，待 verified 试点积累后再评估。
- **Q5 fs 能力**：试点未需要（产物按 URL 引用）。仍未决。

### 12.6 验收锚点核对

| 锚点 | 证据 |
|---|---|
| 执行型插件安装 → 披露 → 实例 Key → Bot 勾选 → 进度 → 产物 → 徽标 / 活动 | `plugin-host.test.ts` 试点用例（真实子进程 + 假 fetch）；**真机待用户验证** |
| 白名单外域名 → `PLUGIN_NETWORK_DENIED`、插件卡可见 | `plugin-host.test.ts` / `plugin-bridge.test.ts` |
| 死循环 → 看门狗击杀 → `PROVIDER_UNAVAILABLE` 人话、下次自动重启 | `plugin-host.test.ts`（心跳看门狗用例） |
| 坏输出 → `PLUGIN_CONTRACT_VIOLATION` 无部分投递 | `plugin-host.test.ts`（合同违规用例） |
| 卸载 → 进程终止 / storage / secrets 清除 / 条目残留静默跳过 | `plugin-host.test.ts`（卸载用例） |
| 未安装执行型插件的环境行为不变 | `plugin-host.test.ts`（数据型插件不出现在运行时列表、无徽标）+ media 全目录回归 |

## 修订记录

| 日期 | 修订 |
|---|---|
| 2026-11-15 | 初稿（D125）：双形态插件模型、PluginHost 运行时、Host API v1、media 能力契约、可观测闭环、信任矩阵；修订 D104（执行域）、D124（决策 1 与 Q1）；决策不引入 Cordis（评估结论内嵌 §0） |
| 2026-11-16 | P1–P4 收口：补 §12 现状（实际落地 / 迁移 0076 / DEV-104–128 / 试点 A/B / Q1–Q5 / 验收锚点）；§2 增 `runtime.instanceFields`（DEV-114 方案 1）；invoke 上下文增可选 `instanceId` |
| 2026-11-16 | P4 独立审查修正：`ready.features` 能力协商（旧 SDK 不收 `instanceId`）、静态扫描绕过加固（DEV-129）、`safeFetch` 改用与 Agent 同版本的 undici fetch、混合插件字段重名拒绝与域名去重；§7 / §12.1 / §12.3 同步 |

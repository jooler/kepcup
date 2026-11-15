# 60 能力模型插件化（Capability Model Plugins）

> 状态：**草案（待评审）** · 决策：D124 · 上游：[51 插件系统](51-plugin-system.md)（D104/D105 贡献-实例-注入模型）、[16 能力模型](16-capability-models.md)（VendorAdapter 契约）、[40 能力挂载](40-capability-mounting.md)（D91，本文修订其 §8）、[38 对话内设置](38-conversational-settings.md)（D89 setup 链复用）· 执行方案：[todo/capability-model-plugins](../../todo/capability-model-plugins/README.md)

能力模型（非对话模型）目前是设置页 7 个全局槽位（`settings.capabilityModels.{embedding|rerank|multimodal|asr|tts|image|video}`，每槽单值 `{provider 实例, model}`），协议适配硬绑两个内置厂商（`VENDOR_DESCRIPTORS` 只有 dashscope / volcengine，适配器注册表 `ADAPTERS` 写死在 core）。厂商只有随应用发版才能新增，新模型（如百炼上新一张图模型）也常常要等版本。

目标形态（用户视角）：

1. 用户**安装并配置插件**（如官方「阿里云百炼」插件，填 API Key）；
2. 插件内**一个模型一条**（如「Qwen-Image 图片生成」「万相 2.6 文生图」……条目由插件声明，用户可见可选）；
3. **指定插件给 Bot**，在 Bot 内勾选启用哪些条目；
4. Bot 运行时**感知条目并执行**——`generate_image` 等媒体工具按该 Bot 的条目解析模型，缺凭据走既有 SETUP_REQUIRED → 对话内设置卡。

外部调研（2026-11，结论只作取向）：**各家图像/视频/音频生成 API 无统一数据结构是客观问题**——百炼平台内部就并存两套图片协议（wan 系列异步 `X-DashScope-Async` + `input.prompt`，qwen-image 系列同步 `input.messages[0].content[0].text`）；Google 同域并存 `:predict` / `generateContent` / `:predictLongRunning` 三种范式；生命周期有六种（同步直返 / 异步头+task / task_id+查询端点 / LRO / fal 队列 / webhook），状态命名互不相通（`succeed` / `SUCCEEDED` / `COMPLETED` / `done:true` / `dreaming`）；产物有效期 1 小时到 7 天不等。**业内没有公认标准**，只有两个事实骨架（图像的 OpenAI `/v1/images/generations` 同步骨架、视频的 Sora `/v1/videos` job 骨架），且都只统一外壳不统一参数——参数层不存在公共超集，所有聚合方案（LiteLLM、OpenRouter、fal、Replicate）殊途同归到「公共核心参数 + per-model 参数声明 + 透传通道」。**「统一契约 + 每厂商一个适配单元」的插件化是业内主流答案**：Dify 1.0 把全部内置模型供应商插件化（YAML 声明凭据表单与参数规则 + 代码实现调用）、LangChain/LlamaIndex 拆 core + 每厂商独立包、ComfyUI custom nodes、n8n 的 verified/unverified 两级信任。音频（tts/asr）同样碎片化：TTS 输出四态并存（OpenAI 原始字节、百炼 24h 签名 URL、Google base64 JSON、MiniMax 默认 **hex 编码**字符串）；ASR 同步 multipart（OpenAI）与异步 task_id 轮询（百炼录音文件识别 Fun-ASR / Paraformer）并存——本文契约按能力泛型设计，tts / asr 是一等公民而非图像的附属。

相关：D58（setup 链）、D61/D68（媒体工具）、D83（KepCup 供应商，全局槽位的 `kepcup` 路径不变）、D89（设置目录边界）、D91（能力挂载，本文修订其 §8）、D104/D105（插件系统与 CAPABILITY_KINDS 注册表）。

## 决策

- **D124 能力模型插件化**：
  1. **插件 = 声明式数据包，不含代码**（延续 D104「不新增执行模型」）：新增贡献类型 `capabilityModels`（≤32 条目），每条目 = 一个可调用模型 `{id, capability, model, engine, params?}`。协议适配逻辑住在**内置引擎**（core 内代码模块，随应用发版），插件以 `engine` 字段绑定。第三方新模型（既有平台上的）= 纯数据条目，装插件即用；全新厂商协议 = 宿主新增引擎（第一方代码，走应用发版）。可执行插件（沙箱 JS 适配器）方向性否决，通用「HTTP 模板引擎」（声明式请求模板 + 轮询）作为远期路标单独评估（§10 Q1）。
  2. **条目粒度 = 模型，插件粒度 = 平台协议族**：官方「阿里云百炼」插件一条引擎绑定（`engine:'dashscope'`）+ N 个模型条目；用户也可以做只含一条的「Qwen-Image 图片生成」插件——两种形态同构。同一引擎的多条目共享凭据与测试逻辑，与 `VENDOR_DESCRIPTORS` + `presets` 的既有结构对齐。
  3. **实例 = 厂商账号**：`PLUGIN_INSTANCE_KINDS` 增 `'capability-model'`（与 mail / mcp / im 同配方：贡献 = 供给规范、实例由用户添加、materializer 落地、凭据入 secrets `plugin:{pluginId}:instance:{instanceId}:{key}`）。凭据字段由引擎声明（`credentialFields`），安装管线据此渲染实例表单。条目默认用插件唯一实例；多实例时条目可 `instance` 显式指定，未指定且多实例 → 运行时 `INSTANCE_AMBIGUOUS`。
  4. **引擎注册表**：core 新增 `MEDIA_ENGINES`（id → `{displayName, capabilities, adapter, credentialFields}`），首批引擎 = 现有三适配器原样改造（`dashscope` / `volcengine-ark` / `openai-compatible`，行为逐字节不变，现有全局槽位路径继续走原 `ADAPTERS` 不动）。`VendorAdapter` 契约冻结不动；`VendorCallContext` 增可选 `entryParams`（条目级参数覆盖）。安装期校验 `engine` 必须已注册，未知引擎拒绝安装（`PLUGIN_ENGINE_UNKNOWN`）。
  5. **Bot 绑定**：`botRuntimeSchema` 增 `capability_entries: [{plugin, entry}]`（≤16，软引用）。Bot 详情「插件」区块按插件分组勾选条目；有效集 = 插件已安装启用 ∩ `effectivePluginIds` ∩ 本字段。卸载插件后残留引用解析时静默跳过、UI 标「已卸载」（与 `plugin_ids` 现状一致）。
  6. **运行时解析顺序**（capability → 模型）：① Bot 绑定条目中匹配该能力的（工具显式 `model` 参数可指定，命中已启用条目才生效）→ ② 全局 `settings.capabilityModels[capability]` 槽位（现状，作为全局默认）→ ③ `CAPABILITY_NOT_CONFIGURED`。条目消费面 = 经 media 网关的五个工具能力（image / video / tts / asr / multimodal）；**embedding / rerank 不开放**（记忆管线绑定全局槽位，本期条目 schema 允许声明但运行时不消费，见 §10 Q4）。
  7. **工具面不变**：`generate_image` / `generate_speech` / `generate_video` / `understand_image` / `transcribe_audio` 仍固定挂载（仅任务面，条件 `deps.media !== undefined` 不变）；条目只影响模型解析，不做工具级挂载。三个生成工具增**可选** `model` 参数（匹配条目 model / displayName，未命中回默认条目）；工具描述构建时注入该 Bot 可用条目清单（≤6 行）。
  8. **SETUP_REQUIRED 复用**：条目缺凭据 → 既有 setup 需求结构扩展 `{kind:'capability-model', pluginId?, instanceId?, entryId?}`，对话内设置卡渲染插件实例凭据表单（PluginField 表单复用），保存后自动续跑（D58 链不动）。
  9. **用量记账扩列**：`usage_ledger` 增 `capability`、`model_entry_id`（nullable，旧行 NULL），成功调用记录维度；`provider` 列对条目调用记插件 id。聚合并入既有 `modelTotals`（model 维度天然区分）。
  10. **设置目录零新增**：插件模型条目是插件资源（与 MCP 服务器同级），**不进 settings-catalog**（D89 目录只收全局设置；无静默兜底问题——不存在读 `unknown` 的条目）。设置页能力卡加「插件提供」只读区块与入口（deepLink 插件详情）；`capability.*` 七个既有条目语义不变（管理全局默认）。
  11. **D91 §8 修订**：「媒体生成等内置能力的按需挂载」中，工具级按需挂载继续不做（工具固定五件）；**模型条目**进入 Bot 级可选——粒度从「工具」细化为「工具内的模型」，对话轮仍无媒体工具、任务面工具清单形状不变。
  12. **内置官方插件**：`plugins/` 内置目录新增「阿里云百炼」「火山方舟」两个数据型第一方插件（引擎绑定现有适配器实现、presets 迁入清单、图标随包），作为机制 dogfood 与后续新模型的发布载体（上新模型 = 发插件版本，不等应用发版）。既有内置厂商实例（`settings.modelProviders` 的 vendor 实例）原样保留，两条配置路径并存不迁移。

## 1 插件形态与引擎

```text
插件包（纯数据）                     core（随应用发版）
┌─────────────────────────┐        ┌──────────────────────────────────┐
│ manifest.contributions  │        │ MEDIA_ENGINES 注册表              │
│   .capabilityModels[]   │        │  dashscope → VendorAdapter(现有)  │
│    {id, capability,   ──┼──engine──▶  volcengine-ark → VendorAdapter  │
│     model, engine,      │        │  openai-compatible → …(仅 embed)  │
│     params?, instance?} │        │ 每引擎 credentialFields（表单声明）│
│ instances:['capability- │        ├──────────────────────────────────┤
│  model']（凭据表单=     │        │ CAPABILITY_KINDS + materializer  │
│  引擎字段并集）          │        │ （实例落地、secrets）             │
└─────────────────────────┘        └──────────────────────────────────┘
```

- 引擎即现有 `VendorAdapter` 的具名化：注册表把「适配器 + 展示名 + 支持能力 + 凭据字段」打包。新增引擎 = core 内新模块 + 注册（第一方，随发版）；插件永远只是数据。
- 异步任务契约沿用现有 `submitVideo → videoStatus → cancelVideo` 三态机（`VideoTaskPhase = queued|running|succeeded|failed`），不改名不重构；同步能力在引擎内部消化（如 wan 异步文生图在引擎 `generateImage` 内完成 submit+poll，工具层无感）。任务持久化 / webhook 仍是既有非目标。
- 产物策略不变：引擎返回 `url | b64`，工具层立即取字节落附件（规避厂商 URL 过期），`media-delivery` 确定性投递照旧。

## 2 manifest 契约（`plugin-manifest.ts` 扩展）

```ts
// contributions.capabilityModels[]，≤32，与 skills/connectors/mcp/mail/im 平级
const capabilityModelEntrySchema = strictObject({
  id: /* 贡献 id 规则复用 */,            // 插件内唯一，如 'qwen-image'
  capability: z.enum(['image','video','tts','asr','embedding','rerank','multimodal']),
  model: z.string().min(1).max(200),    // 厂商模型 id，如 'qwen-image-2.0'
  engine: z.string().min(1).max(64),    // MEDIA_ENGINES 键，安装期校验
  displayName: z.string().max(100).optional(),   // 缺省用 model
  description: z.string().max(500).optional(),   // 呈现给用户与模型的能力说明
  params: z.record(z.string(), z.unknown()).optional(), // 引擎参数默认/覆盖（如 size 档位）
  instance: z.string().optional(),      // 多实例时显式指定，缺省用唯一实例
});
```

- `superRefine` 增两条：声明 `capabilityModels` ⇒ `instances` 必含 `'capability-model'`；条目 `id` 插件内查重。
- 安装管线在清单校验后追加一步：`engine` ∉ `MEDIA_ENGINES` → 拒绝（`PLUGIN_ENGINE_UNKNOWN`，错误信息列出可用引擎）。贡献照常记入 `plugin_items` 账本（kind `'capability-model'`，ref = 条目 id），卸载可回滚。
- 实例 `instanceFields()` = 该插件条目引用的引擎 `credentialFields` 并集（去重）。凭据仍走 `PluginField.sensitive` → secrets，永不出现在设置快照与 `settings_change.values`（D89 敏感字段规则沿用）。

## 3 数据模型与存储

- `plugin-manifest.ts`：上述 schema + `PLUGIN_INSTANCE_KINDS` 加 `'capability-model'`（manifest `instances` 联合扩展）。
- `botRuntimeSchema`（`domain/types.ts`）：`capability_entries: z.array(strictObject({ plugin: z.string(), entry: z.string() })).max(16).default([])`——随 `bots.profile_json` 存储，无表迁移。
- 迁移 **0075**（main）：`plugin_items` / `plugin_instances` 的 kind CHECK 按 0066 同款重建扩 `'capability-model'`；`usage_ledger` 增列 `capability TEXT`、`model_entry_id TEXT`（均 nullable）。
- RPC（`plugins.*` 组）：`plugins.listCapabilityEntries`（已装插件的条目全集：插件名 / 能力 / displayName / model / 实例配置状态）、`plugins.setBotCapabilityEntries {botId, entries}`（整集替换，校验插件已装且条目存在）、`plugins.testCapabilityEntry {pluginId, entryId, instanceId?, keyOverride?}`（逐能力最小真实探测，复用 `testCapability` 探针：image 最小生成、video 提交即取消、tts「你好」、asr 静音 WAV…）。

## 4 运行时解析链

```text
generate_image(model?) ──▶ MediaToolFacade（orchestrator #mediaFacade）
                              │ 注入 botId + 用量上下文（既有）
                              ▼
                     MediaService.#resolve(capability, {botId, model?})
                              │
        ┌─────────────────────┼──────────────────────────────┐
        ▼ ① Bot 绑定条目       ▼ ② 全局槽位（现状）             ▼ ③
  capability_entries 过滤   settings.capabilityModels[cap]  CAPABILITY_
  （插件启用 ∩ effectivePluginIds）  → ADAPTERS + vendor 实例     NOT_CONFIGURED
        │ 命中条目
        ▼
  MEDIA_ENGINES[entry.engine].adapter  +  实例凭据（secrets）
  （多实例未指定 → INSTANCE_AMBIGUOUS；缺凭据 → SETUP_REQUIRED + 实例描述）
```

- ① 内排序：显式 `model` 参数命中 > 条目声明顺序。条目路径与全局槽位路径**互不改写**：`#resolveProvider` 现有逻辑原样保留为 ②，新增 `#resolveEntry` 为 ①。
- `#mediaFacade` 的 setup 守卫捕获集不变（`CAPABILITY_NOT_CONFIGURED` / `PROVIDER_AUTH_FAILED`），条目路径的缺凭据归一为 `CAPABILITY_NOT_CONFIGURED` 并携带插件实例定位，渲染层据此出插件凭据卡（P3）。
- 渲染层直连 RPC（语音播报 `media.synthesizeSpeech`，D106）本期仍走全局槽位（无 bot 上下文，保持现状），条目化后续单议（§10 Q3）。

## 5 Bot 绑定与 UI

- Bot 详情「插件」区块（D105 P4 已收拢）升级：插件卡片下按能力分组列出该插件的模型条目，复选启用；条目行显示 displayName / model / 配置状态徽标（未配凭据置灰 + 「去配置」）。整集替换走 `plugins.setBotCapabilityEntries`。
- 插件详情页（扩展中心）：能力模型插件新增「模型条目」区（只读列表 + 每条目「测试连接」按钮 → `plugins.testCapabilityEntry`）与「账号实例」区（添加 / 删除实例、填凭据，与 mail / im 实例管理同形）。
- 设置页：`CapabilityModelSection`（全局默认七卡）不动，卡内加一行「插件提供 · N 个模型 →」deepLink。

## 6 设置与目录边界

- 零新增 settings-catalog 条目（决策 10）。理由：条目不是应用级设置而是插件资源，进目录会引入「动态条目 + 静态唯一事实来源」的结构矛盾；MCP 服务器、连接应用同为先例（都不进目录）。对话内设置（D89）对 `capability.*` 七条目照旧——它们管理的是全局默认槽位；插件条目的凭据缺失不经 `settings_change`，走工具 SETUP_REQUIRED 的插件凭据卡（凭据永不经模型）。
- AGENTS.md 设置清单核对：本设计不新增用户配置项到设置目录，故无目录登记义务；`settings-adapters-coverage` 等四个定向测试在 P2/P3 收口跑一遍作回归护栏。

## 7 安全与信任

- 插件不含代码：条目与参数是数据，执行面全部在第一方引擎内——社区插件的风险上限 = 「诱导调用某个已注册引擎 + 参数注入」。`params` 值在引擎侧按白名单消费（引擎逐键读取，不整包透传给厂商 HTTP 层），未知键忽略并 warn。
- 市场分级沿用 D104：官方市场 verified 首发（两个内置第一方插件）；community 插件可声明条目，但只能绑定已注册引擎，凭据自持。`plugin_search` / `plugin_request_install` 天然覆盖能力模型插件，无需新工具。
- 用量与审批：媒体调用不经审批（现状），记账扩列后条目维度可审计；`INSTANCE_AMBIGUOUS` / 引擎错误沿用 `media/http.ts` 归一（配额 / 限流 / 认证分家，c0bf9168 语义不变）。

## 8 存量兼容与 D91 修订

- 全局七槽位、`VENDOR_DESCRIPTORS`、`ADAPTERS`、`providers.test` 探测路由、`memory` 向量路径全部不动；不启用任何插件插件的 Bot 行为与今日逐字节一致。
- [40 §8](40-capability-mounting.md) 非目标第 4 条按决策 11 修订（工具固定、模型条目可挂）；16 号文档收口时补「插件条目」一节指向本文。
- D83 供应商路径（`provider='kepcup'`）只在全局槽位出现，条目引擎不涉及，无交集。

## 9 分期

P1 shared 契约与迁移（manifest + botRuntime + usage 列）→ P2 core 引擎注册表与运行时（registry / kind / materializer / MediaService / RPC / facade）→ P3 renderer（Bot 条目勾选、插件详情、凭据卡、工具描述注入）→ P4 内置官方插件与收口（百炼 / 方舟插件、市场、定向测试收口、16/51 号文档回写）。详见 [todo/capability-model-plugins](../../todo/capability-model-plugins/README.md)。

## 10 待确认决策

- **Q1 通用 HTTP 模板引擎**：为「引擎没覆盖的长尾厂商」做声明式请求模板 + 轮询状态机（Airbyte 低代码 CDK 先例，但其成熟面在读型 API，媒体生成状态机无现成声明原语）。本期不做；若社区生态起来再立项。
- **Q2 条目与全局槽位的优先级 UI**：本期固定「条目 > 槽位」且不做全局开关；若用户反馈「想临时回退全局」，再加 Bot 级覆盖开关。
- **Q3 渲染层语音播报的条目化**：`media.synthesizeSpeech`（D106）本期维持全局槽位；条目化需要 RPC 带 botId 语义，随语音对话迭代顺延。
- **Q4 embedding / rerank 条目化**：记忆管线绑定全局槽位（`memory/service.ts` 直读），条目开放会引入「按 Bot 换向量模型」的一致性问题（同库向量维度混用），本期不消费；schema 允许声明以便后续单独立项。

## 验收锚点

- 安装官方「阿里云百炼」插件 → 添加实例填 Key → Bot 详情勾选「Qwen-Image 图片生成」→ 该 Bot 任务里 `generate_image` 走条目模型出图、落附件；未启用条目的 Bot 走全局槽位不变。
- 卸载插件后：引用残留不报错、UI 标已卸载、该 Bot 图像生成回退全局槽位（若配置）。
- 多实例未指定 `instance` 的条目调用返回 `INSTANCE_AMBIGUOUS`；缺凭据出对话内插件凭据卡，保存后自动续跑。
- `usage_ledger` 条目调用行带 `capability` / `model_entry_id`；用量页 model 维度可见。
- 未装任何能力模型插件的环境：`media-adapters` / `media-service` / `settings-adapters-coverage` 等定向测试全绿（行为零变化）。

## 修订记录

| 日期 | 修订 |
|---|---|
| 2026-11-15 | 初稿（D124），基于 2026-11 业界调研与代码现状（见 todo/capability-model-plugins/CURRENT-STATE.md） |
| 2026-11-15 | D125 修订（见 [61 号](61-plugin-runtime-platform.md)）：决策 1「插件 = 纯数据声明包」扩为**双形态**——插件可携带 `runtime` 段以自带代码（宿主外子进程 + 能力注入）实现适配器，与内置引擎并列成为条目的第二种解析来源；§10 Q1「通用 HTTP 模板引擎」**退休**（执行型插件覆盖其全部动机）；§1 的「插件永远只是数据」表述按 61 号 §2 理解。条目模型、Bot 绑定、解析顺序、usage 扩列、setup 链等其余决策不变 |

# CURRENT-STATE · 能力模型插件化开工前现状快照

> 写于 2026-11-15（D124 设计调研期，代码勘察口径）。执行智能体开工前必读；行号会漂移，以符号名为准。

## 1. 能力模型现状（改造主体）

- **全局配置**：`settings.capabilityModels.{embedding|rerank|multimodal|asr|tts|image|video}`，每槽单值 `{provider 实例 id, model}` 或 `null`——schema 在 `packages/shared/src/domain/types.ts`（`capabilityModelSchema` / `capabilityModelsSchema`，约 :551-570）。**一个能力只配一条，无多模型概念。**
- **网关**：`packages/core/src/media/service.ts`——`MediaService`；`ADAPTERS = { dashscope, volcengine }`（:47-50 附近）；`#resolve`（:415-442）读全局槽位抛 `CAPABILITY_NOT_CONFIGURED`；`#resolveProvider`（:448-470）解析实例、key、baseUrl 组装 `VendorCallContext`；`#requireAdapterCapability`（:473-486）；`testCapability`（:275-357）逐能力最小探测（image 最小生成、video **提交即取消**零计费、tts「你好」、asr 静音 WAV；模型 id 含 `edit` 自动走编辑路径）；`#recordUsage`（:383-407）一次成功调用一行、token 恒 0、`provider` 记实例 id、无 run 用 `media_` 前缀合成 runId。
- **适配器契约**：`packages/core/src/media/types.ts`——`VendorAdapter`（:119-157）：`embed` 必选 + `rerank/understandImage/generateImage/synthesizeSpeech/transcribeSpeech/submitVideo/videoStatus/cancelVideo` 可选；`VideoTaskPhase = queued|running|succeeded|failed`（:89）。**本期冻结此签名。**
- **适配器实现**：`media/adapters/dashscope.ts`（~416 行，`generateImage` 走 `multimodal-generation` 同步接口、TTS 返回 24h 签名直链时立即 `fetchBinaryBase64`、视频 `X-DashScope-Async` + `GET /api/v1/tasks/{id}`）、`media/adapters/volcengine.ts`（~192 行，图像 `/api/v3/images/generations` 同步、视频 `POST /api/v3/contents/generations/tasks`）、`media/adapters/openai-compatible.ts`（~43 行，仅 embed）。
- **错误归一**：`packages/core/src/media/http.ts`——`errorCodeForStatus`（401→`PROVIDER_AUTH_FAILED`、402→`PROVIDER_QUOTA`、403 按 body 配额词分家、429→`PROVIDER_RATE_LIMITED`、其余→`PROVIDER_UNAVAILABLE`、网络→`PROVIDER_UNREACHABLE`）。**不改语义。**
- **Bot 工具**：`tools/image-tools.ts`（`generate_image` / `understand_image`，`MediaToolFacade` 接口 :36-82）、`tools/speech-tools.ts`（`generate_speech` / `generate_video`〔工具内轮询 5s×10min〕/ `transcribe_audio`）、`tools/media-delivery.ts`（确定性投递）。媒体工具**只在任务面**注册，条件 `deps.media !== undefined`（`tools/index.ts` :1186-1210 附近）；facade 由 orchestrator `#mediaFacade`（`dispatch/orchestrator.ts` :5781-5818）包装：注入用量上下文 + 捕获 `CAPABILITY_NOT_CONFIGURED` / `PROVIDER_AUTH_FAILED` 转 `SETUP_REQUIRED`。能力枚举 `'image'|'tts'|'video'|'multimodal'|'asr'` 在 setupGuard 处写死（:5789 附近）。

## 2. 厂商与实例

- `packages/shared/src/domain/vendors.ts`：`VendorId = 'dashscope' | 'volcengine'`（:28）；`VendorDescriptor { id, name, baseUrl, apiRoot, capabilities, presets, consoleUrl }`（:31-49）；`VENDOR_DESCRIPTORS`（:51）；`PROVIDER_TEMPLATES` 46 张卡（:157-181，`vendor?` 字段指向媒体厂商）。
- `providerInstanceSchema`（`domain/types.ts` :394-410）：`id`（厂商实例用厂商 id、重复加 `-2/-3`、自定义 `custom:` 前缀）/ `vendor`（nullable）/ `name` / `baseUrl?` / `enabled` / `api` / `models[]` 等；存 `settings.modelProviders`（settings 是 main.db 单行 JSON 表 key='app'）。
- API key 存 SecretsService：`provider:{实例id}`（`agent/models.ts` :46 附近），多槽位 `provider:{id}:key:{n}`；**对话模型与能力模型按实例共享同一 key**。

## 3. 插件系统现状（复用主体，D104/D105 已落地）

- **manifest**：`packages/shared/src/domain/plugin-manifest.ts`（~936 行，全 strictObject）：`format_version:1` / 贡献 `skills≤50 / connectors≤20 / mcp≤10 / mail≤10 / im≤10` / `config.fields≤32` / `instances:('mail'|'mcp'|'im')[]≤4`；`PluginField { key, type:'string'|'number'|'boolean'|'directory'|'file', title, description, required, sensitive, multiple, default?, min?, max? }`（:143-155，三方共用）；`PLUGIN_INSTANCE_KINDS`（:45 附近）。superRefine 管贡献/instances 配对。
- **kind 注册表**：`packages/core/src/plugins/kinds.ts:91-142`——`CAPABILITY_KINDS: readonly CapabilityKindAdapter[]`，现 5 个：`skill → mcp → connector → mail → im`（投影顺序，卸载反序）；适配器接口 `{ kind, contributionSchema, consentKey, hasInstances, instanceFields(), hasContribution(), consentItems(), createProjector() }`（:57-81）；实例字段函数 `mailInstanceFields:153` / `imInstanceFields:253` / `mcpInstanceFields:281`。
- **实例落地**：`PluginInstanceService.registerMaterializer(kind, impl)`——mail / mcp / im 已有 materializer；secrets 名 `plugin:{pluginId}:instance:{instanceId}:{key}`。
- **存储**（main 0053/0056/0066）：`plugins` 表（`origin/tier/state/enabled/package_sha256/marketplace/dir`）；`plugin_items` 账本 `(plugin_id, kind, ref)`；`plugin_instances (id:'pli_…', plugin_id, kind, title, config_json)`。**kind 有 CHECK，扩 kind 需按 0066 重建模式出迁移。**
- **Bot 注入**：`bots.profile_json → profile.runtime.plugin_ids`（`domain/types.ts` :104）；有效集 `effectivePluginIds`（`packages/core/src/plugins/effective.ts:17-22`）= `plugin_ids ∪ project_plugins`；RPC `plugins.setBotPlugins`（整集替换）/ `plugins.enableForBots`；orchestrator `#effectivePlugins`（`dispatch/orchestrator.ts` :2772-2780）。Bot 详情「插件」区块在 D105 P4 收拢（InkCop 除外）。
- **市场**：`MarketplaceService`（`plugins/marketplace-service.ts`）+ Ed25519 官方索引（keyId `kepcup-plugins-2026-1`，`plugin-index.ts:94-101`）；内置第一方插件只读、不入 `plugins` 表；Bot 侧 `plugin_search` / `plugin_request_install`（仅 verified）。

## 4. 用量记账

- `usage_ledger`（main 0002 :113-127）：`run_id / bot_id / conversation_id / loop_type / provider / model / *_tokens / cost_usd / created_at`。**无 capability / 条目维度**——本期迁移 0075 扩列。聚合在 `domain/usage.ts`（`modelTotals` :316 按 provider+model）。
- 记账入口：`MediaService.#recordUsage`（唯一）；facade 注入用量上下文。

## 5. 设置面

- settings-catalog：`packages/shared/src/settings-catalog/items.ts` :30-107——7 个条目 id `capability.{能力}`（store 指向 `capabilityModels.{能力}` 路径，`card:'capability-model'` 族）。**本设计零新增条目**（60 §6 决策）。
- `CapabilityModelSection.svelte`（`apps/desktop/src/renderer/src/lib/features/settings/`）：一能力一卡（选实例 → 填模型 id datalist → 填 Key）；embedded 形态供对话内设置卡复用（D58/D89）。
- 核心适配器：`packages/core/src/settings/contributions/capability.ts` + `settings/adapters.ts` :507-600。
- **定向测试护栏**（AGENTS.md 指定）：`packages/shared/test/unit/settings-catalog.test.ts`、`packages/core/test/unit/settings-item-writes.test.ts`、`packages/core/test/unit/settings-adapters-coverage.test.ts`、`apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts`。

## 6. 关键基线速查

- **迁移 head**：main 至 0074（0074_conversation_notes.sql）——**开工前以 `ls packages/core/migrations/main | tail -3` 为准**，新迁移从下一个号起（设计写的 0075 若已被占用顺延，并同步改 60 号文档与 P1）。
- **DEV 编号**：开工前 `rg "DEV-" DEVIATIONS.md | tail -5` 取最后一个，新偏差顺延。
- **D 编号**：决策表最大 D123，本设计占 D124（60 号 + README 决策表已登记）。
- **既有文档漂移备忘**：58 号（D122）漏登 README 决策表；本设计的 D124 已正确登记，勿重蹈。
- **相关测试现状**：`packages/core/test/unit/` 下 `media-adapters / media-service / media-service-usage / media-tools / media-delivery` 为行为基线——P2 改造后这些必须全绿（适配器行为零变化的证据）。

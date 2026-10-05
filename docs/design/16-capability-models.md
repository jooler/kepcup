# 16 能力模型（非对话模型）与厂商适配

对话（推理）模型走 pi 的厂商注册表（见 [14-models-and-browser.md](14-models-and-browser.md)），本篇定义其余模型能力——向量、重排、多模态（图片理解）、语音识别、语音生成、图片生成、视频生成——的**配置方式**与**逐厂商 API 适配**。联网检索供应商（web_search 工具的配置）见 [21-web-search.md](21-web-search.md)；语音/视频的 Bot 工具消费见 [20-conversation-media.md](20-conversation-media.md)。

## 设计原则

旧方案按厂商组织：一个厂商条目里按能力登记若干模型，再为每能力另设「默认引用」，用户面对两层间接（条目 + 默认引用），且厂商弹框里要一次看懂六种能力的端点差异。新方案按**用户心智**组织：

> 需要什么类型的模型 → 用哪个厂家的 → 提供需要的配置。

- 每种能力在设置页占一个独立 section，配置 = **厂商 + 模型 + Key**；一种能力至多一条生效配置。
- 厂商下拉只列出**已适配该能力**的厂商（由描述符的能力矩阵决定）；某厂商缺某能力时天然不出现。
- 端点差异完全下沉到适配层：用户永远只填一个兼容根（厂商条目，可选）、模型 id 与 Key，不需要按模型类型填多个 URL。
- API Key 按**厂商**共享：同一厂商的对话与各能力配置复用同一条 Key（`provider:{厂商id}`），在任意 section 设置后全局生效。

内置厂商与能力矩阵（2026-10 对照官方文档核验）：

| 能力 | 阿里云百炼 | 火山方舟 |
|---|---|---|
| chat | ✓ | ✓（seed-2.1 系、deepseek-v4 系） |
| embedding | ✓（文本 + 多模态向量） | ✓（仅多模态向量端点，见下文） |
| rerank | ✓（原生 text-rerank） | ✗（数据面无 rerank 接口，重排在 VikingDB） |
| multimodal | ✓ | ✓（seed-2.1 系自带多模态理解） |
| asr / tts | ✓ | ✗（语音属火山独立语音产品线） |
| image / video | ✓ | ✓（seedream / seedance 系列） |

预置模型只登记核验时官方「模型列表」**在售**的 id（下线模型实测/文档均不可用，如方舟 seed-1.6 系、doubao 文本向量、seedream-3.0-t2i、seedance-1.0-lite-t2v）；datalist 仅供候选，可自由输入其他 id。

## 设置页结构（设置 - 模型）

自上而下：

| Section | 内容 |
|---|---|
| 默认模型 | 主模型、轻量模型（对话引用，pi 方案不变） |
| 并发 | `providerConcurrency.default` |
| 厂商 | 内置 / 自定义 / 国内厂商卡片；国内厂商条目只登记**对话**模型 |
| 能力模型 | 向量 → 重排 → 多模态 → 语音识别 → 语音生成 → 图片生成 → 视频生成，每个 section 同构：厂商下拉、模型输入（预置候选）、Key、测试、保存 |
| 向量来源 | 本地模型 / 使用上方向量模型配置；展示就绪状态与维度 |

### 向量来源的本地实现（DEV-007 已落实）

`source='local'` 时的推理栈完全经环境管理器按需安装到应用私有目录，**不入应用安装包**：

| 组件 | 环境条目 | 内容与体积 | 来源 |
|---|---|---|---|
| 模型 | `embedding-model` | `bge-small-zh-v1.5` ONNX 导出（512 维 / 中文 BERT 词表 / CLS 池化），`model.onnx` + `vocab.txt` + `config.json`，约 90MB | BAAI 官方权重的 Xenova 移植（BAAI 官方仓库无 ONNX 导出），ModelScope 分发 |
| 运行库 | `onnxruntime` | `onnxruntime-node` + `onnxruntime-common` npm tarball，约 108MB | npm 官方 tarball（registry.npmmirror.com 与 registry.npmjs.org 字节一致，integrity 已核对） |

- **审批与安装**：两个条目合成**一张审批卡**（体积为合计，明细在原因里写全），批准后先装运行库再装模型（`EnvManager#ensureChainedItem`，模式同 uv→python）；安装完成自动触发一次 `memory_vec_rebuild`（旧条目此前只有全文检索）。catalog 用 `files` 安装类型逐文件钉住 url/sha256。
- **加载**：`LocalEmbedder` 用 `createRequire` 从 `toolchains/onnxruntime/{version}/` 加载 onnxruntime-node，会话与词表按安装目录做模块级缓存；embedder id 为 `local:bge-small-zh-v1.5@{version}`，换模型/版本即换 id，向量索引自动重建。
- **GPU 加速按宿主自动选执行单元**（`env/gpu.ts`）：macOS CoreML（随包内置）、Windows DirectML（随包携带 `DirectML.dll`，任意 DX12 显卡：NVIDIA/AMD/Intel，无需 CUDA/cuDNN）、Linux CPU（npm 发行包未携带 CUDA EP——如需 Linux GPU 加速须改用 CUDA 发行包，记跨系统清单）。首选 EP 会话创建失败时回退纯 CPU，推理永不因此失败。
- **性能预算**（任务书：CPU 单条 ≤50ms）：macOS arm64 warm 实测约 36ms；首条含会话初始化约 2s（一次性）。
- 分词：自实现 BERT WordPiece（`memory/bert-tokenizer.ts`，CJK 逐字 + 标点切分 + 小写 + `##` 续片贪心匹配），与 HF BertTokenizer(do_lower_case=true) 对齐，序列上限 512。

## 数据模型

```ts
// shared/domain/vendors.ts
modelCapabilitySchema = z.enum(['chat', 'embedding', 'rerank', 'multimodal', 'image', 'tts', 'asr', 'video']);

// shared/domain/types.ts
capabilityModelSchema = z.object({
  vendor: vendorIdSchema,        // 仅接受已登记的国内厂商
  model: z.string().min(1),      // 厂商侧模型 id
});

settingsSchema.capabilityModels = {
  embedding: capabilityModelSchema.nullable().default(null),
  rerank:    …, multimodal: …, asr: …, tts: …, image: …, video: …,
};
```

- `embedding.source`（`'' | 'local' | 'provider'`）与 `embedding.dim` 保留；`source='provider'` 即「使用向量模型 section 的配置」，不再单独存 provider/model。
- 各能力的默认引用字段（`defaultEmbeddingModel`、`defaultMultimodalModel`、`defaultSpeechRecognitionModel`、`defaultAudioGenerationModel`、`defaultImageGenerationModel`、`defaultVideoGenerationModel`）**废除**——能力 section 的配置本身就是默认值。
- 旧 `vendorProviders` 条目只承载对话模型（`models: [{id, name?, contextWindow?, input?}]`，不再带 `capability`）；`capabilityModels` 中引用的厂商**无需**存在厂商条目，Key 与 baseUrl 直接按厂商解析。
- baseUrl：`providerCompatBaseUrl` 先取厂商条目的覆盖值（用户在厂商 section 改过兼容根），否则用描述符默认根。能力配置没有独立 baseUrl——同厂商一个根。

## 适配层契约

core 侧 `media/` 每家厂商一个适配器，实现厂商无关的 `VendorAdapter`（`types.ts`）。网关（`service.ts`）按能力取 `capabilityModels[capability]`，解析出厂商、模型与 Key 后路由：

| 方法 | 能力 | 语义 |
|---|---|---|
| `embed(ctx, model, texts)` | embedding | 文本向量，返回与输入同序的 `number[][]` |
| `rerank?(ctx, model, params)` | rerank | `query + documents[] → [{index, score}]`，按 score 降序 |
| `understandImage?(ctx, model, params)` | multimodal | 图片理解（视觉问答），返回文本 |
| `transcribeSpeech?(ctx, model, params)` | asr | 语音转文本 |
| `synthesizeSpeech?(ctx, model, params)` | tts | 文本转语音（base64） |
| `generateImage(ctx, model, params)` | image | 文生图 / 图片编辑（带参考图即编辑） |
| `submitVideo / videoStatus / cancelVideo?` | video | 异步任务提交 / 轮询 / 尽力取消 |

未挂方法的组合在 UI（能力矩阵）与运行时（`NOT_IMPLEMENTED`）都不开放。网关新增公开方法：`rerank`、`understandImage`、`embedTexts(vendor, model, texts)`、`embeddingReady()`、`testCapability(capability, {vendor, model})`；RPC `media.generateImage / synthesizeSpeech / transcribeSpeech / generateVideo / videoStatus / rerank / understandImage`。`media.*` 入参的 `model` 是**裸模型 id**（省略时用能力配置），不再携带厂商前缀。

## 逐能力 API 参考

以下端点均以厂商的 baseUrl / apiRoot 为基准（见各厂商描述符）。截至实现时的官方文档口径；厂商侧字段演进以官方文档为准，预置模型 id 仅供 datalist 候选，可自由输入。

### 向量（embedding）

| 厂商 | 端点 | 说明 |
|---|---|---|
| 百炼 | 兼容根 `POST /embeddings` | `text-embedding-v3/v4`、Qwen3-Embedding 系列（OpenAI 格式） |
| 百炼 | 原生 `POST {apiRoot}/api/v1/services/embeddings/text-embedding/text-embedding` | v1/v2 早期模型；`input.texts`，25 条/批 |
| 百炼 | 原生 `POST {apiRoot}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding` | `tongyi-embedding-vision` / multimodal 系列；`input.contents[{text}]`，10 条/批 |
| 火山方舟 | `POST {baseUrl}/embeddings/multimodal` | 官方现役向量端点只剩多模态向量化 API（文本向量模型与 OpenAI 文本 `/embeddings` 已下线）；`input` 为带 type 的对象数组（文本项 `{type:'text', text}`），且**整个 input 融合为单个向量**——批量语义（一条文本一个向量）必须逐条请求，适配器并发发出后按输入顺序归位；响应 `data.embedding` |

适配器按模型家族路由（百炼：vision/multimodal → 多模态原生端点，`text-embedding-v[12]` → 早期原生端点，其余 → 兼容根）。网关保证调用方拿到与输入同序的向量。

预置：百炼 `text-embedding-v4 / text-embedding-v3 / tongyi-embedding-vision-plus-2026-03-06`；方舟 `doubao-embedding-vision-251215`（前代 250615 官方标注「即将下线」）。

### 重排（rerank）

统一契约：`{query, documents[], topN?}` → `results: [{index, score}]`（index 为输入文档下标，score 降序）。检索场景一次候选 ≤ 20 条，远低于各家上限。

| 厂商 | 端点 | 请求体 | 响应 | 备注 |
|---|---|---|---|---|
| 百炼 | `POST {apiRoot}/api/v1/services/rerank/text-rerank/text-rerank` | `{model, input: {query, documents}, parameters: {top_n, return_documents: false}}` | `output.results[].{index, relevance_score}` | 模型 `gte-rerank-v2`、`qwen3.7-text-rerank`；上限 500 条/请求；`qwen3-rerank` 走独立的兼容式 `/reranks` 端点，暂不适配。官方文档域名已切至 `{业务空间}.cn-beijing.maas.aliyuncs.com`——baseUrl 覆盖以 `/compatible-mode/v1` 结尾时 apiRoot 推导仍成立 |

火山方舟数据面**没有** rerank 接口与 rerank 模型（官方模型列表与 API 手册均无；重排能力在 VikingDB 向量库，属异构产品与鉴权体系），能力矩阵不开放；不要凭模型命名规律推测 rerank 型号。

预置：百炼 `gte-rerank-v2 / qwen3.7-text-rerank`。

### 多模态（multimodal，图片理解）

统一实现：厂商各自 **OpenAI 兼容根** `POST /chat/completions`，`messages[0].content = [{type: 'image_url', image_url: {url}}, {type: 'text', text}]`；图片用 URL 或 data URI。响应取 `choices[0].message.content`（字符串；个别模型返回分段数组时拼接其中的 text 段）。

与对话链路的分工：Bot 对话中用户发图仍由 pi 注册表里 `input` 含 `image` 的对话模型处理；本能力面向独立的图片理解调用（`media.understandImage`，如未来的图片描述工具）。

预置：百炼 `qwen3-vl-plus / qwen-vl-plus`（`qwen-vl-max-latest` 需单独开通，实测 Access denied，不预置）；方舟 `doubao-seed-2-1-pro-260915 / doubao-seed-2-1-lite-260915`（官方模型列表带「多模态理解」能力标签）。

### 语音识别（asr）

| 厂商 | 端点 | 说明 |
|---|---|---|
| 百炼 | 兼容根 `POST /chat/completions` + `input_audio` 内容块 | qwen3-asr 系列；音频为 data URI，回复即转写文本 |
| 火山方舟 | —— | 数据面不提供，能力矩阵不开放 |

预置：百炼 `qwen3-asr-flash`。

### 语音生成（tts）

| 厂商 | 端点 | 说明 |
|---|---|---|
| 百炼（qwen-audio-tts 系列） | `POST {apiRoot}/api/v1/services/audio/tts/SpeechSynthesizer` | 音频生成（官方「音频生成 API 参考」）：文本放 `input.text_prompt`，**不接收 voice/parameters**（声音由参考音频驱动，不支持系统音色）；仅非实时型号可用（`qwen-audio-3.1-tts-next` 实测可用；`qwen-audio-3.1-tts-flash` 为实时 WebSocket 专用型号，HTTP 通道报错） |
| 百炼（qwen3-tts 系列） | `POST {apiRoot}/api/v1/services/aigc/multimodal-generation/generation` | 音色驱动的语音生成，与图片生成同端点；`input.text` + `parameters.voice`（Qwen 音色如 `Cherry`，CosyVoice 音色无效）；响应同下 |
| 百炼（cosyvoice 系列） | `POST {apiRoot}/api/v1/services/audio/tts/SpeechSynthesizer` | CosyVoice（逐步下架）；音色/格式/语速在 `parameters` 下；预置音色按模型代际带后缀（v2 → `longxiaochun_v2`，v3 系 → `longxiaochun_v3`，适配器自动选择） |
| 火山方舟 | —— | 数据面不提供，能力矩阵不开放 |

适配器按模型 id 分流：`qwen-audio-*tts*` → SpeechSynthesizer + text_prompt（无音色）；`qwen*tts*` → multimodal-generation + 音色；其余（cosyvoice）→ SpeechSynthesizer + 代际音色。三路响应结构一致（`output.audio.data` 或 24h 有效直链，立即取回字节）。

预置：百炼 `qwen-audio-3.1-tts-next / qwen3-tts-flash / qwen3-tts-instruct-flash / cosyvoice-v3-flash / cosyvoice-v2`（`qwen-audio-3.1-tts-flash` 为实时专用、`cosyvoice-v3.5-flash` 不存在，均不可用于 HTTP 通道）。

### 图片生成（image，含编辑）

| 厂商 | 端点 | 说明 |
|---|---|---|
| 百炼 | `POST {apiRoot}/api/v1/services/aigc/multimodal-generation/generation` | qwen-image 家族同步接口；编辑 = `input.messages[0].content` 带 `image` 项；尺寸分隔符原生为 `*`（适配层自动转换）；响应取 `output.choices[0].message.content[].image` |
| 火山方舟 | `POST /images/generations` | seedream 系列；`image` 接受字符串或数组；n>1 用 `sequential_image_generation: 'auto'` + `max_images`；响应 `data[].url/b64_json` |

预置：百炼 `qwen-image / qwen-image-plus / qwen-image-edit / qwen-image-edit-plus`；方舟 `doubao-seedream-4-0-250828 / doubao-seedream-4-5-251128`。

Bot 侧消费入口：响应 loop 工具 `generate_image`（P15）——文生图，产物落 workspace `.generated/`，Bot 经 `send_message` 的 `attachment_paths` 发给用户。能力未配置 / 厂商缺 Key 时网关抛 `CAPABILITY_NOT_CONFIGURED` / `PROVIDER_AUTH_FAILED`，工具转 `SETUP_REQUIRED`，orchestrator 中断执行并以结构化 setup 失败 settle，对话内呈现图像模型设置卡片（[18-inline-setup.md](18-inline-setup.md)）。

### 视频生成（video，异步任务）

| 厂商 | 提交 | 轮询 | 取消 |
|---|---|---|---|
| 百炼 | `POST {apiRoot}/api/v1/services/aigc/video-generation/video-synthesis`（头 `X-DashScope-Async: enable`；首帧 `input.media[0] = {type: 'first_frame'}`） | `GET {apiRoot}/api/v1/tasks/{id}`（`PENDING/RUNNING/SUCCEEDED/…`） | `POST {apiRoot}/api/v1/tasks/{id}/cancel` |
| 火山方舟 | `POST {baseUrl}/contents/generations/tasks`（content 数组 text + `image_url` 带 `role: 'first_frame'`；`watermark: false`） | `GET {baseUrl}/contents/generations/tasks/{id}` | `DELETE` 同路径 |

`media.generateVideo` 只提交并返回 `{provider, taskId}`，调用方用 `media.videoStatus` 轮询（core 内另有 `pollVideo` 长等待助手）。

预置：百炼 `wan2.7-t2v / wan3.0-video / wan2.2-t2v-plus`；方舟 `doubao-seedance-1-0-pro-250528 / doubao-seedance-2-0-260128`。

## 连通性测试（providers.test 带 capability）

每个能力 section 的「测试」先落盘配置与 Key，再发一次最小真实请求：

| 能力 | 探测 |
|---|---|
| chat | pi 注册表最小 ping（历史行为，不变） |
| embedding | 一次单词 embed |
| rerank | query + 2 条短文档 |
| multimodal | 内置 32×32 纯色 PNG + 「图中是什么」，返回非空文本即通过 |
| image / tts / asr | 一次最小生成（asr 用内置静音 WAV，返回 200 即通过；编辑专用模型 id 含 edit 时附带探针 PNG 走编辑路径） |
| video | 提交任务后立即取消（提交即校验 Key、模型与参数，零成片计费） |

厂商卡片不带 capability 的测试（如「更换 Key」）按对话探测；厂商未登记对话模型但能力配置引用了它时，按其能力配置探测（校验 Key 有效性）。

## 记忆检索的重排接入

[04-memory.md](04-memory.md) 的混合检索在 RRF 融合后增加可选重排：融合 top-20 的条目以 `content` 为文档、检索问句为 query 调用 `media.rerank`，按重排结果取最终条数；未配置或调用失败时保持 RRF 顺序（重排永远不阻断检索）。更换重排模型不影响向量索引——重排不产生向量。

## 新增厂商适配指南

1. `shared/domain/vendors.ts`：`vendorIdSchema` 增加厂商 id，登记 `VendorDescriptor`（名称、默认兼容根、apiRoot、**能力矩阵**、各能力预置模型、控制台地址）。
2. `core/media/adapters/`：实现 `VendorAdapter`，只挂该厂商提供的能力方法；共享工具在 `media/embeddings.ts`（OpenAI 兼容向量）、`media/vision.ts`（OpenAI 兼容图片理解）、`media/rerank.ts`（重排响应解析）。
3. `core/media/service.ts` 的 `ADAPTERS` 表登记一行。
4. 单元测试：适配器端点/载荷/响应解析（`media-adapters.test.ts`）+ 网关路由（`media-service.test.ts`）。

不做旧配置迁移：schema 变更后旧数据中的过时字段由 zod 剥离或回落默认值，用户按新结构重新配置即可。从预置移除的厂商（如 siliconflow）残留配置在设置读取时直接丢弃（`SettingsService` 的 `dropUnknownVendors`），避免严格枚举让设置加载失败。

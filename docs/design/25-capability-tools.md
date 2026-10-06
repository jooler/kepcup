# 25 能力补位工具（图片理解与语音转写）

主模型（对话模型）没有的能力不应让它「口头承认做不到」，而应让它调用工具补位——某一类型模型的能力以工具的形式存在，用户未配置对应模型时，走对话内提示设置（D58）。图片生成、语音生成、视频生成、联网检索已按此模式落地（[16](16-capability-models.md)/[18](18-inline-setup.md)/[20](20-conversation-media.md)/[21](21-web-search.md)）；本篇补齐剩余两个能力：**multimodal（图片理解）→ `understand_image` 工具**、**asr（语音转写）→ `transcribe_audio` 工具**。配置、厂商适配器、RPC、设置页 section、设置卡的能力映射均已就绪（16 号文档、`media.understandImage / transcribeSpeech`），缺的只是 response loop 的工具消费与 facade 的 setup guard 接线。

## 决策

- **D68 能力补位工具**：新增 `understand_image`（multimodal）与 `transcribe_audio`（asr）两个 Bot 工具，与 `generate_image` 系列同一模式——工具常驻（media 网关就绪即注册，不按配置裁剪），缺能力/缺 Key 时工具返回 `SETUP_REQUIRED`，orchestrator 中断 run 以结构化 setup 失败 settle，对话内嵌对应能力设置卡，保存后自动 `runs.retry` 续跑。素材来源统一为「对话附件 id 或 workspace/project 内路径」，工具内解析字节转 data URI 进适配器；返回内容包 `<untrusted>`。非视觉主模型面对图片的回退文案改为指引 `understand_image`。

## 背景与缺口

- **图片理解**：用户发图到非视觉主模型时，触发批注入按 `model.input` 判定丢弃字节，只留一行回退文案（`pi-engine.ts`「可用 get_attachment 获取文件，或建议用户配置支持视觉的模型」）——get_attachment 只是把文件复制进 workspace，非视觉模型依然「看不见」；`media.understandImage`（厂商 OpenAI 兼容视觉端点）无任何调用方。
- **语音转写**：用户发音频附件（语音留言、会议录音）时，上下文只有一行附件行，模型完全无从下手；`media.transcribeSpeech`（百炼 qwen3-asr 兼容通道）同样无调用方。
- 边界澄清：这不是 22 号技能阶梯的范畴——技能解决「陌生文件格式」，图片/音频是主模型**感官缺失**的问题，属于能力补位（16 号文档对 multimodal 的定位即「面向独立的图片理解调用」）。

## 工具定义

两个工具并入现有媒体工具文件（facade 接口 `MediaToolFacade` 定义在 `tools/image-tools.ts`）：`understand_image` 进 `image-tools.ts`，`transcribe_audio` 进 `speech-tools.ts`；注册条件与既有媒体工具一致（`deps.media` 就绪即注册，`tools/index.ts`）。

### understand_image（multimodal）

| 参数 | 类型 | 说明 |
|---|---|---|
| `images` | `string[]`（1–4） | 每项为 workspace/project 内路径或 `att_` 附件 id |
| `prompt` | `string` | 对图片的问题/指令（「描述这张图」「读出图里的表格数据」） |

- 字节解析：附件 id 走 `attachments.readBytes`（校验归属当前对话，同 `get_attachment`）；路径走 `gateway.checkPath(read)`（越权即失败结果）。转 `data:{mime};base64,…` 传 `UnderstandImageParams.images`， mime 按扩展名表（复用 `tools/index.ts` 的 `MIME_BY_EXTENSION`）。
- 预算与 20 号视觉注入对齐：≤4 张、单张 ≤5MB，超限项跳过并在结果中说明；全部超限 → 失败结果。
- 结果：适配器返回的文本包 `<untrusted>`（图片内容是外部数据，纪律同附件文本/检索结果）。
- 描述写明双轨用途：当前对话模型看不了图时用本工具；有视觉的模型一般直接看图（不诱导绕路）。
- 系统提示联动：`pi-engine.ts` 的回退文案改为「可用 understand_image 工具理解图片内容」。

### transcribe_audio（asr）

| 参数 | 类型 | 说明 |
|---|---|---|
| `audio` | `string` | workspace/project 内路径或 `att_` 附件 id（单个） |
| `language` | `string?` | 语言提示（BCP-47，如 `zh`），透传 `TranscriptionParams.language` |

- 字节解析同上；转 `audioBase64 + audioMime` 传 `media.transcribeSpeech`。
- 大小上限沿用附件通道的 30MB（core 侧校验已有）；长音频分片不做（非目标），超限如实报 `INVALID_INPUT`。
- 结果：转写文本包 `<untrusted>`。
- 典型场景：用户发语音/录音附件 → 附件行入上下文 → 模型调本工具拿文本再答复。

## facade 与 setup 引导接线

- `MediaToolFacade`（`tools/image-tools.ts`）增两个方法：`understandImage({images, prompt})`、`transcribeSpeech({audioBase64, audioMime, language?})`。
- orchestrator `#mediaFacade` 的 `setupGuard` capability 联合类型由 `'image' | 'tts' | 'video'` 扩为含 `'multimodal' | 'asr'`，新方法同 guard 包装——`CAPABILITY_NOT_CONFIGURED / PROVIDER_AUTH_FAILED` 记 `{kind:'capability-model', capability}` 后原样抛回，工具转 `SETUP_REQUIRED`。
- `setupRequirementSchema` 的 capability 枚举已含全部七能力（shared/domain/types.ts），零改动；`SetupRequiredCard` 按 capability 泛化映射到 `CapabilityModelSection`（i18n `settings.capabilityTitle.multimodal / .asr` 已存在），UI 零新增。
- 工具构造函数新增依赖：`attachments`（附件字节）与 `gateway`（路径检查），从 `buildResponseTools` 的既有 deps 传入。

## 测试锚点

- 单测：`understand_image`（成功 / 附件越权 / 超限跳过 / 未配置 → SETUP_REQUIRED）、`transcribe_audio`（成功 / 未配置 → SETUP_REQUIRED / 超限）；`#mediaFacade` guard 记 `multimodal` / `asr` requirement。
- 集成（response-loop）：非视觉 mock 模型 + 图片附件 → 工具命中 → 未配置时 run `failed` + `setup={kind:'capability-model', capability:'multimodal'}` → 配置后 `runs.retry` 续跑成功；asr 同。
- e2e：音频附件触发设置卡，卡片呈现「语音识别模型」section，保存后自动续跑。

## 非目标

- 语音输入（用户侧按录转文字 / 语音消息）已另行落地，见 [26](26-voice-input.md)；本篇只覆盖模型侧的 `transcribe_audio` 工具。
- 长音频分片转写与说话人分离；视频转码与抽帧理解。
- `understand_image` 不承担批量离线描述任务（Wiki 图片整合另走 17 号 MinerU 路线）。
- embedding / rerank 不工具化：它们是记忆检索的内部环节，模型无需感知（16 号定位）。

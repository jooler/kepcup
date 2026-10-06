# 20 对话附件与媒体

用户在对话里上传文件、模型生成图片/语音/视频，是 Bot 从"纯文字聊天"走向"干活"的基本盘。本文覆盖三件事：**用户上传附件**（输入、队列、发送）、**媒体内联展示**（图片缩略图、音视频播放、灯箱放大预览）、**模型生成媒体**（图片已有，补语音与视频工具）以及**图片进模型视觉通道**。文件到达后"用哪个技能识别"的路由见 [22-file-skill-routing.md](22-file-skill-routing.md)；联网检索见 [21-web-search.md](21-web-search.md)。

## 决策

- **D61 附件与媒体**：用户附件走既有 `attachments` 通道（上传即落盘会话附件目录，草稿阶段预挂、flush 转正）；`drafts.add` 增 `attachmentIds`，发送前可移除（`attachments.detach`，仅限草稿阶段）；消息附件在渲染层按 mime 内联渲染——图片缩略图（懒加载 blob URL + 渲染层缓存）、视频/音频点击加载后内联播放、其余保持文件 chip；点击媒体打开灯箱（滚轮缩放、拖拽平移、双击适配、前后切换、下载）；新增 `generate_speech` / `generate_video` 工具（产物同 `generate_image` 落 workspace `.generated/`，经 `send_message` 的 `attachment_paths` 随消息发出；视频为提交+轮询的异步任务，工具内轮询并经 progress 汇报）；触发批中的图片附件在模型支持图像输入时以 image part 进入首条 user 消息（≤4 张、单张 ≤5MB），不支持时保持文本行并提示改用 `get_attachment`；上下文附件行补充 mime（见 20）。

## 1 现状与缺口

- 附件存储/RPC 早已备好：`attachments.upload`（base64 ≤40MB，core 侧 30MB 校验）、`attachments.get`、`{home}/conversations/{id}/attachments/`、草稿预挂（`draftId`）与 flush 转正（`attachToMessage`）——但渲染层没有任何上传入口，`drafts.add` 也没有附件参数，整条链路无人使用。
- `MessageAttachments.svelte` 只有「图标 + 文件名」chip；组件注释预留了 inline 预览扩展点。无灯箱。
- Bot 发附件的通道已通：`send_message.attachment_paths`（读 workspace 文件 → upload → attach）；`generate_image` 落盘 `.generated/` 后由模型用同一通道发出。
- 上下文里附件只是一行文本 `（附件：att_x 文件名 12KB）`；用户上传的图片**不会**进入模型——引擎唯一的 image 通道是 `ToolResult.images`（browser_screenshot），且不持久化。
- 模型侧 `MediaService` 已有 `synthesizeSpeech / generateVideo / pollVideo` 与七能力配置（16 文档），但只有 image 被工具消费。

## 2 用户上传链路

```
Composer（按钮/粘贴/拖拽）
  → attachments.upload（字节即传，渲染层预检 30MB；失败 chip 标错可重试）
  → drafts.add({ text, attachmentIds })   ← core 校验归属后绑定 draftId
  → 草稿队列 chip 展示（可 detach 移除）
  → flush（既有链路：attachmentsForDraft → attachToMessage → message.attachments）
```

- **空文本 + 附件**允许发送：`drafts.add` 的 `text` 放宽为可空字符串（渲染层保证「有文本或有附件」才入队）；消息气泡对空文本只渲染附件。
- **移除**：`attachments.detach {id}` 仅当附件仍在草稿阶段（`message_id IS NULL`）可用，删除行与文件；`drafts.remove / removeAll` 级联清理草稿阶段附件（不留孤儿行/文件）。
- 粘贴（`clipboardData.files`）与拖拽（`drop` 的 `DataTransfer.files`）复用同一条上传函数；大小超限/类型拒绝即时 toast（i18n）。

## 3 媒体内联与灯箱

- **渲染层字节获取**：`attachments.get` → base64 → Blob → objectURL；模块级 LRU 缓存（按附件 id，容量上限防内存膨胀），消息流复用同一缓存。
- **按 kind 分支**（`MessageAttachments` 内）：
  - `image/*`：缩略图（max-h 约 40 视高、圆角随连排规则），`<img>` onerror 回退文件 chip（HEIC 等不可解码格式自然降级）；
  - `video/*`：占位卡（时长/大小）→ 点击后加载字节内联 `<video controls>`；
  - `audio/*`：同上，`<audio controls>`；
  - 其余：文件 chip 不变（点击下载）。
- **灯箱**：全局单例组件挂 `ChatView`（渲染时 portal 到 body 末尾并自带 `app-no-drag`——app-region 矩形沿 DOM 顺序收集、z-index 不参与，原地渲染会被 ChatView 顶部 h-16 drag 条与右栏头部 drag 矩形盖住，顶栏按钮点不动，见 app.css），输入为「当前消息的媒体附件列表 + 起始下标」；Dialog 容器 + 自绘缩放（滚轮以光标为中心、指针拖拽平移、双击 1x↔适配、Esc 关闭、←/→ 前后切换）、工具条（缩放比例、下载、关闭）。下载用 blob URL + `<a download>`，不需要主进程参与。
- 用户上传与模型生成的媒体走同一渲染路径，不区分来源。

## 4 模型生成媒体

| 工具 | 能力 | 行为 |
|---|---|---|
| `generate_image`（已有） | image | 同步生成，落 `.generated/`，返回路径 |
| `generate_speech`（新） | tts | 文本 → 语音（voice/format/speed 可选），落 `.generated/{name}.mp3` 等 |
| `generate_video`（新） | video | 提交任务 → 工具内 `pollVideo` 轮询（约 5s 间隔），ctx.progress 汇报阶段，总时限 10 分钟；产物下载挂取消信号与 2 分钟独立超时（content-length 预检 + 200MB 上限），落 `.generated/{name}.mp4` |

- 三者未配置能力时一致返回 `SETUP_REQUIRED`（facade 捕获 `CAPABILITY_NOT_CONFIGURED / PROVIDER_AUTH_FAILED` 记 requirement：speech → `tts`、video → `video`），复用 D58 内联设置引导（`CapabilityModelSection` 已支持 tts/video）。
- 模型把产物经 `send_message.attachment_paths` 发出（提示词已写明）；消息到达后即走第 3 节渲染。

## 5 图片进视觉通道

- `EngineMessage` 增可选 `images: [{mimeType, base64}]`；orchestrator 组装触发消息时从**触发批**消息的图片附件取字节（≤4 张、单张 ≤5MB，超限跳过并保留文本行）。
- 引擎在建首条 user 消息时判定 `model.input` 含 `image`：支持 → text + image blocks；不支持 → 丢弃字节、追加一行提示（「图片未注入：当前模型不支持图像输入，可用 get_attachment 或配置多模态模型」）。判定逻辑与 `ToolResult.images` 同源。空文本（纯附件）不产生空 text block——部分厂商（Anthropic）对空文本块直接 400。
- `run_steps` 的 `request` 记录对 image block 脱敏为占位（`[image image/png ~120KB]`），避免 base64 灌库——模型「看到什么」仍完整（有占位即看到了图）。
- 历史消息中的图片不回放（仅触发批注入一次）；需要回看的路径是 `get_attachment`（复制到 workspace 后 `read` 工具同样产 image part）。

## 6 测试锚点

- core 单测：drafts 附件绑定/校验/detach/级联清理；flush 转正后 `message.attachments` 完整；`generate_speech/generate_video` 工具（假媒体 facade：成功、能力缺失 SETUP_REQUIRED、视频轮询超时）；视觉注入（EngineMessage blocks 组装、超限跳过、不支持模型的文本替换、persistSteps 脱敏）。
- e2e：上传图片发送 → 缩略图渲染 → 灯箱打开；mock-llm 场景下 bot 带图回复的展示。

## 7 非目标

- 不做附件续传/分片（30MB 内一次传完）、不做消息编辑改附件、不做 HEIC 转码（降级为 chip）、不做视频转码与缩略帧提取、不把历史图片回放进上下文。语音输入（按录转文字 / 语音消息）后续另行落地，见 [26](26-voice-input.md)。

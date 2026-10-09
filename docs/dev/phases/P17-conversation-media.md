# P17 对话附件与媒体（上传、内联渲染、生成工具、视觉注入）

## 目标

用户能在对话里上传文件（按钮/粘贴/拖拽），发送前可管理；消息里的图片/视频/音频内联渲染、可点击灯箱放大；模型能用工具生成语音与视频；触发批中的图片直接进入支持视觉的模型。

## 依赖

P01（响应 loop、草稿队列）、P15（SETUP_REQUIRED 内联引导模式）。

## 设计依据

- [design/20-conversation-media.md](../../design/20-conversation-media.md)（全文，决策 D61）
- [design/18-inline-setup.md](../../design/18-inline-setup.md)（setup 中断/续跑模式）
- [03-data-model.md](../03-data-model.md)（attachments/drafts 表）
- [04-agent-runtime.md](../04-agent-runtime.md)（工具目录、EngineMessage）
- todo/conversation-rich-media.md（规划与验收口径）

## 背景（现状，实现前必读）

- 附件后端已完备：`attachments.upload/get`（core 30MB 校验）、`AttachmeantsService`（草稿预挂 `draftId`、`attachToMessage` 转正、`attachmentsForDraft`）；`flushDrafts` 已按 `attachmentsForDraft` 转正——**渲染层无任何上传入口，`drafts.add` 无附件参数**，链路断在两端。
- `draftSchema` 无 attachments 字段；草稿列表返回不含附件。
- `MessageAttachments.svelte` 只有文件名 chip；无灯箱；`attachments.get` 无渲染层调用点。
- `drafts.add` 的 `text` 为 `min(1)`；纯附件消息需要放宽。
- 引擎：`EngineMessage.content` 仅 string；image 通道只有 `ToolResult.images`（`model.input` 含 `image` 时转 content blocks）；`onPayload` 把完整请求写 `run_steps.request`——注入图片必须脱敏。
- `MediaService.synthesizeSpeech / generateVideo / videoStatus / pollVideo` 与 tts/video 能力配置已就绪，无工具消费；`#mediaFacade` 目前只记 image 的 setup。
- `drafts.remove/removeAll` 不清理草稿附件（当前无入口制造孤儿，新增上传入口后必须级联）。

## 任务（全部完成）

- [x] shared：`draftsAddInputSchema` 增 `attachmentIds`、`text` 放宽可空；`draftSchema` 增 `attachments`；新增 `attachments.detach`；`setupRequirement` 不变
- [x] core/drafts：`list` 联结附件；`add` 校验并绑定 attachmentIds（归属对话、未挂消息/其他草稿）
- [x] core/attachments：`detach`（仅草稿阶段，删行删文件）、`deleteDraftFiles`（草稿删除级联）；RPC 绑定与 drafts.remove/removeAll 接线
- [x] core/tools：`speech-tools.ts`（generate_speech、generate_video——pollVideo 轮询、progress、10 分钟上限）；`MediaToolFacade` 扩展；orchestrator facade 记 tts/video setup
- [x] core/agent：`EngineMessage.images`；pi-engine 组装 content blocks（不支持图像的模型降级为提示文本）；orchestrator 从触发批取图片附件（≤4 张、单张 ≤5MB）；`persistSteps` 对 image block 脱敏占位
- [x] core/context：`renderMessageLine` 附件行带 mime
- [x] desktop/chats：Composer 上传按钮/粘贴/拖拽（30MB 预检、失败 chip 可重试、会话切换清空）；`chat.addDraft` 带 attachmentIds；DraftQueue 附件 chip + 移除
- [x] desktop/chats：`MessageAttachments` 内联渲染（image 缩略图懒加载 + blob 缓存 store；video/audio 点击加载；file chip 点击下载）；`MediaLightbox.svelte`（缩放/平移/切换/下载）挂 ChatView；空文本纯附件气泡
- [x] desktop/i18n：`attachments.*` / `lightbox.*` 文案
- [x] 测试：core 单测（绑定/detach/级联、speech/video 工具三态、视觉注入与脱敏）；e2e 上传→缩略图→灯箱

## 验收（2026-10-04 全部通过）

1. 选择/粘贴/拖拽图片 → chip 出现（超限报错、失败 chip 可重试）→ Enter 入草稿（抽屉 chip 可移除）→ 发送后消息渲染缩略图，点击灯箱缩放/切换/下载（e2e `attachments.spec.ts` 覆盖按钮上传全链路）。
2. 空文本纯附件可发送（core 集成 `conversation-attachments.test.ts`：绑定校验/flush 转正/detach/级联清理 5 例）。
3. 音视频点击加载内联播放、文件 chip 点击下载（渲染路径与图片同源缓存）。
4. tts/video 能力未配置 → `SETUP_REQUIRED` → 内联设置卡 → 自动续跑（单测 `media-tools.test.ts` 6 例覆盖三态与视频轮询）。
5. 视觉注入：支持视觉的模型收 image blocks（单测 `vision-injection.test.ts`），`run_steps.request` 中 base64 替换为 `{type:'image', mimeType, approxBytes}` 占位。
6. `pnpm test` 108 文件 851 passed + 2 skipped；desktop build / svelte-check（0 error）/ eslint 干净。

## 备注

1. 选择/粘贴/拖拽图片 → chip 出现（失败有错误态）→ Enter 入草稿（抽屉 chip 可移除）→ 发送后消息气泡下渲染缩略图，点击灯箱可缩放/切换/下载。
2. 纯附件（无文本）可发送；消息正确显示。
3. 音频/视频附件点击后内联播放；文件 chip 点击触发保存。
4. 配置 tts/video 能力后模型可经工具生成语音/视频并随消息发出、正确内联播放；未配置时出内联设置卡、完成后原 run 续跑。
5. 用支持视觉的模型发图，run_steps.request 中图片为占位符（无 base64），模型答复内容证明看到了图；不支持视觉的模型收到文本提示。
6. `pnpm test` 全绿（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)）；svelte-check/build 与基线一致。

## 备注

- 渲染层上传即 `attachments.upload`（同头像上传的 base64 通道，30MB 上限与 core 一致）；不做分片/续传。
- 视频轮询在工具执行体内完成（run 状态行经 progress 可见），不引入新的后台任务类型。

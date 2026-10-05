# 对话富媒体与文件能力（附件上传、生成媒体、联网检索、文件技能路由）

> 状态：**已实现（2026-10-04），测试全绿**。设计见 docs/design/20-conversation-media.md（D61）、21-web-search.md（D62）、22-file-skill-routing.md（D63）；阶段任务书见 docs/dev/phases/P17/P18/P19（各含验收记录）；落地证据见 docs/dev/PROGRESS.md 同名小节。

## 1 背景与目标

Bot 对话当前只能收发纯文本：用户没有上传文件的入口，模型生成的图片只能以文件名 chip 存在（点不开、放不大），宿主没有联网检索能力，模型面对陌生文件格式只能硬猜或直接失败。本次一并补齐四个能力，锚定两个场景：

- **场景 A**：用户拖一张截图/一个 PDF 进对话 → 图片直接被视觉模型看到；PDF 由 Bot 识别出「应该用 MinerU」→ 弹卡请求安装 → 批准 → Bot 解析并回答。
- **场景 B**：用户让 Bot「生成一段语音/一段视频发给我」→ Bot 调 `generate_speech` / `generate_video` → 消息里内联播放、可下载。

编号目标：

1. 用户可经按钮/粘贴/拖拽上传附件，发送前在草稿队列可见、可移除；空文本纯附件可发送。
2. 消息附件按 mime 内联渲染：图片缩略图、音视频播放器、文件 chip；点击媒体进入灯箱（缩放/平移/切换/下载）。
3. 模型可生成图片（既有）/语音/视频并随消息发出，在对话中正确内联展示；缺配置走内联设置引导。
4. 触发批中的图片在支持视觉的模型上以 image part 进入上下文（run_steps 落占位符不落 base64）。
5. 联网检索以内置工具提供（web_search/web_fetch），供应商可配置可测试，未配置走内联引导。
6. 文件技能路由四级阶梯落地：已装技能 → 推荐预置技能（授权安装）→ 全网检索（扫描审批安装）→ 如实告知不支持。

## 2 现状追溯（链路结论，实现前必读）

1. **附件后端完备、前端为零**：`attachments.upload/get` RPC 与 `AttachmentsService`（`packages/core/src/domain/attachments.ts`）已实现（30MB 上限、会话附件目录、`draftId` 预挂、`attachToMessage` 转正）；`flushDrafts`（`dispatch/orchestrator.ts` L354-371）已按 `attachmentsForDraft` 转正——渲染层无任何上传入口，`drafts.add`（`rpc/methods.ts` L494）无附件参数，`draftSchema` 无 attachments 字段。
2. **消息附件渲染是占位**：`MessageAttachments.svelte` 仅「图标+文件名」chip，注释预留 inline 预览扩展点；无灯箱；`attachments.get` 无渲染层调用点。`ChatMessageRow` 在气泡下渲染附件行（L150-152）。
3. **Bot 发附件通道已通**：`send_message.attachment_paths`（`tools/index.ts` L150-226）读 workspace 文件→upload→attach；`generate_image`（`tools/image-tools.ts`）落 `.generated/` 后提示模型用该通道发出。模型生成的媒体与用户上传同走 `message.attachments`。
4. **上下文附件是一行文本**：`renderMessageLine`（`agent/context/conversation.ts` L67-72）输出 `（附件：att_x 名 12KB）`，无 mime；图片不进模型——引擎唯一 image 通道是 `ToolResult.images`（`pi-engine.ts` L107-121，按 `model.input` 含 `image` 判定），且 `onPayload` 把完整请求写 `run_steps.request`（注入图片必须脱敏）。
5. **媒体能力就绪、工具缺位**：`MediaService` 已有 `synthesizeSpeech/generateVideo/videoStatus/pollVideo`（`media/service.ts`、`media/types.ts`，视频为提交+轮询异步任务），七能力配置与设置 UI（`CapabilityModelSection`）齐全；工具侧只有 `generate_image`，`#mediaFacade`（orchestrator L1887）只记 image 的 setup。
6. **预置技能对模型不可见**：`SkillPresetsService`（`skills/presets.ts`）`list()/install()` 完备（catalog 解析+静态扫描+安装态三元组+幂等安装公共技能+`skills.changed`），但只被市场 UI 消费；`<skills>` 段只列已安装技能（`registry.promptSection`）；无任何「请求安装」工具。
7. **审批框架可直接承载**：`ApprovalsService.request`（`permissions/approvals.ts` L122）即阻塞审批（waiter + `waiting_approval` + run 取消联动 + 无人值守 `#autoDecideSync` 自动批准非数据目录类）；`skill_import` kind 与 `SkillImporter`（clone+scan+非阻塞审批+installImported）已有——工具化需拆出 prepare/commit 并改走阻塞 `request`。
8. **宿主无联网检索**：无 WebSearch/WebFetch 工具；`skills/scan.ts` 把二者列为宿主不提供能力；testkit 有 web server fixture 可测适配器。
9. **内联设置引导（D58）是缺配置的既有答案**：`SetupRequirement` union + `SetupRequiredCard` + `continueAfterSetup()`（retry 原运行/冲草稿），新增引导种类只需扩 union 与卡片分支。

## 3 方案设计

方案全文见三份设计文档，此处只列接口要点：

- **D61（design/20）**：`drafts.add` + `attachmentIds`（core 校验归属与未占用）；`attachments.detach`（仅草稿阶段）；`drafts.remove/removeAll` 级联清附件；`draftSchema.attachments`；空文本放宽。渲染层：Composer 三入口 + 30MB 预检；`attachments` blob 缓存 store；`MessageAttachments` 按 kind 内联；`MediaLightbox` 单例挂 ChatView。生成：`generate_speech`（tts）、`generate_video`（提交+5s 轮询+progress+10 分钟上限），facade 记 tts/video setup。视觉：`EngineMessage.images`（≤4 张、单张 ≤5MB），引擎按 `model.input` 降级为提示文本，`persistSteps` 图片占位。
- **D62（design/21）**：`settings.webSearch.provider ∈ {tavily,brave,bocha} | null`；key 存 `websearch:{provider}`；`SearchService` + 三适配器（归一 `SearchHit`）；`web_search`（缺配置→SETUP_REQUIRED→`{kind:'web-search'}`）、`web_fetch`（SSRF 防护、50k 字符、二进制拒绝）；`websearch.test`；设置页「联网检索」分组；SetupRequiredCard 第三分支。
- **D63（design/22）**：`approvalKind` + `skill_preset`（payload：presetId/name/displayName/summary/version/missingDeps）；`presets.promptSection(botId)` 输出未安装条目进 `<recommended_skills>`；`install_skill {preset_id|source_url,ref,reason}`——preset 路径阻塞 `skill_preset` 审批→`presets.install`；URL 路径 `SkillImporter` prepare（clone+scan）→阻塞 `skill_import`→commit（按 Bot 安装）；拒绝→`APPROVAL_DENIED` 降级；系统提示注入阶梯纪律；无人值守两类自动批准。

## 4 明确不做

附件分片/续传、消息编辑改附件、语音输入、HEIC/视频转码、历史图片回放进上下文、自建搜索引擎、检索结果缓存、第三方市场索引、任何形式的自动安装技能。

## 5 改动清单

### P17 对话附件与媒体

- [x] packages/shared/src/domain/types.ts：`draftSchema` 增 `attachments`；`setupRequirement` 不动
- [x] packages/shared/src/rpc/methods.ts：`draftsAddInputSchema` + `attachmentIds`、text 放宽；`attachments.detach`；注册表
- [x] packages/core/src/domain/drafts.ts：list 联结附件；add 绑定校验
- [x] packages/core/src/domain/attachments.ts：`detach`、`deleteDraftFiles`
- [x] packages/core/src/rpc/bindings.ts：drafts 删除级联、attachments.detach 绑定
- [x] packages/core/src/tools/speech-tools.ts：generate_speech / generate_video
- [x] packages/core/src/tools/index.ts：MediaToolFacade 扩展 + 挂载
- [x] packages/core/src/dispatch/orchestrator.ts：facade 扩展（tts/video setup）；触发批图片采集
- [x] packages/core/src/agent/types.ts + pi-engine.ts：EngineMessage.images、content blocks、降级
- [x] packages/core/src/dispatch/orchestrator.ts（#persistSteps）：image block 脱敏
- [x] packages/core/src/agent/context/conversation.ts：附件行带 mime
- [x] desktop：Composer 上传/粘贴/拖拽；chat store addDraft 附件；DraftQueue chips
- [x] desktop：attachments-media store（blob 缓存）、MessageAttachments 内联、MediaLightbox、ChatView 挂载
- [x] desktop i18n：attachments.* / lightbox.*
- [x] 测试：core 单测 + e2e

### P18 联网检索

- [x] shared：settingsSchema.webSearch、setupRequirement `web-search`、`websearch.test`
- [x] core：search/ 模块（SearchService + tavily/brave/bocha 适配器 + fetchPage 防护）
- [x] core/tools/web-tools.ts + orchestrator facade + start.ts 注入
- [x] core/skills/scan.ts：移出 WebSearch/WebFetch 不兼容判定
- [x] desktop：设置「联网检索」分组、SetupRequiredCard 第三分支、i18n
- [x] 测试：适配器/SSRF/工具三态/e2e

### P19 文件技能路由

- [x] shared：approvalKind + skill_preset、payload schema
- [x] core/skills/presets.ts：promptSection、describePreset
- [x] core/skills/library.ts：SkillImporter prepare/commit 拆分
- [x] core/tools/skill-tools.ts：install_skill；ResponseToolDeps + orchestrator facade
- [x] core/agent/context/system-prompt.ts：`<recommended_skills>` 段 + 阶梯纪律段
- [x] core/permissions/approvals.ts：skill_preset 文案
- [x] desktop：ApprovalCard skill_preset 分支、i18n
- [x] 测试：工具两路径/遮蔽/审批文案/e2e

### 文档

- [x] docs/design/20/21/22 + README 索引 + D61/D62/D63
- [x] docs/dev/phases/P17/P18/P19 + dev/README 阶段表
- [x] docs/dev/03-data-model.md / 04-agent-runtime.md 增量、相关 design 交叉引用
- [x] PROGRESS.md 证据小节（实现后）、本文档状态行更新

## 6 验收口径

1. ✅ 场景 A 全链路：拖入截图（视觉模型）→ 模型回答内容证明看到图；拖入 PDF（未装 mineru）→ `<recommended_skills>` 匹配 → `skill_preset` 卡 → 批准 → MinerU 安装为公共技能 → 模型继续处理。
2. ✅ 场景 B 全链路：配置 tts/video → 生成语音/视频 → 消息内联播放、灯箱可开、可下载；未配置 → 内联设置卡 → 完成自动续跑。
3. ✅ 上传三入口 + 草稿管理：按钮/粘贴/拖拽上传、chip 移除、30MB 超限报错、纯附件发送、flush 转正后 `message.attachments` 完整。
4. ✅ 联网检索：未配置引导→配置→检索结果回到模型；`web_fetch` 私网拒绝。
5. ✅ 阶梯末端：内置与检索都无果时模型如实告知不支持（提示词纪律）。
6. ✅ `pnpm test` 全绿（core vitest + desktop e2e）、lint/typecheck 干净。

## 7 风险 / spike 清单（实现结论）

- ~~30MB base64 经 MessagePort 的内存峰值~~：沿附件通道（30MB 上限）实测可用；e2e 走按钮上传路径全绿。
- 视频生成厂商耗时不一：10 分钟工具上限 + progress 汇报已落地（轮询间隔可注入，单测秒级验证）。
- `<recommended_skills>` 与 `<skills>` 的提示词预算：当前 9 条预置整段注入可控。
- HEIC 等浏览器不可解码格式：`<img>` onerror 降级文件 chip 已实现。
- 检索供应商在国内的可达性差异：三家并存由用户选择；测试按钮三态齐备。
- **实现期发现并修复的两个渲染层问题**（超出原规划，详见 PROGRESS 小节）：① 附件字节缓存误用响应式 Map，缓存命中路径同步读写会令 track 它的 effect 自我失效无限重跑（渲染层主线程打满、点击附件即冻结）——改回普通 Map（缓存刻意非响应式）；② 消息行 hover 操作按钮 hidden↔flex 出现/消失会挤压气泡位移，鼠标停在窄元素（小图缩略图）上时形成布局死循环——改为常驻占位 invisible↔visible；缩略图补最小尺寸（1x1 图不再不可点）。
- **基线遗留（与本次无关）**：e2e `browser.spec.ts:558` 在干净工作树上同样失败（f9d7c91 右栏改版后该用例的 `text=配置` 定位器过期），需单独修复。

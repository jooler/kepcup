# 53 语音对话模式

26 号暂缓的「语音对话模式」（D69 二次修订时保留设计、入口隐藏）恢复实施。形态参考 Grok 语音条（悬浮胶囊：头像 + 波形 + 设置 + 切文字 + 麦克风 + 关闭）：进入后**输入坞原位切换为语音条**，用户点麦克风说话即发送语音消息，Bot 回复自动语音播报；**对话全程以文字记录在消息列表**——用户消息 = 转写文本 + 音频附件（26 号「语音消息语义」的落地），Bot 消息 = 既有文字落库 + 渲染层播报（音频不落库）。

与 Grok 全屏语音模式的关键差异：Grok 进入语音模式后聊天列表被盖住，需要「切文字」键展开记录；KepCup 的语音条**只接管输入坞，消息列表始终可见可滚动**——「全部转为文字记录到消息列表」是一等需求，天然满足，因此不设「切文字」键，关闭即回文字输入。

**状态：已实施（2026-11-01，开发收口）；首轮真机验收后修订 v2 已实施（2026-11-01，WP5–WP8 提交 9ebb59ec / 0d4ffa1b / f3d8a86d / b67a420a）；第二轮真机验收后修订 v3 已实施（2026-11-01，WP9–WP12）——见文末[「修订 v2」](#修订-v22026-1101首轮真机验收反馈)与[「修订 v3」](#修订-v32026-1101第二轮真机验收反馈)。** 决策 **D106**；执行方案与实施记录见 [todo/voice-conversation.md](../../todo/voice-conversation.md)。实现与本文的偏差已就地加「实现修订」注。

## 决策

- **D106 语音对话模式**：
  - **入口**：输入坞左下工具行（附件键旁）加「语音对话」键（lucide `Speech`，title「语音对话」）；仅**私聊**会话且非 readOnly 显示，录音中禁用。点击预检 `isCapabilityReady('asr')` 与 `isCapabilityReady('tts')`，缺哪个 `chatSession.requestCapabilitySetup(哪个)` 置卡（`SetupRequiredCard` 位置不变，语音模式不进入），配好后重新点击——语音模式内部不再处理缺能力。
  - **语音条**：占据输入坞原位（同层 `absolute z-30` 替换，不走 Portal——不与窗口拖拽带重叠），布局 `Bot 头像 ｜ 波形/状态区（弹性）｜ 设置键 · 麦克风键 · 关闭键(红 X)`。头像复用 `BotAvatar`；录音波形复用 `recording.level` + `levelToHeight`；播报态用 CSS 动画波形（真实电平 P3，可参考 `MicrophoneTest` 的 AnalyserNode 方案）。
  - **半双工**：开始录音即打断播报——停当前音频 + **清空未播队列**（插话作废：被作废的回复只留文字在列表，不再补播，与语音助手惯例一致）；录音 / 识别期间新到的 Bot 消息照常入队但暂不播，回到空闲后按序播。发送后可立即再录，不必等回复。
  - **Bot 播报走渲染层编排**（voice-mode store 订阅消息事件 → `media.synthesizeSpeech` → `Audio` 播放），core 零改动（仅 loopType 枚举加值，见下）；播报音频**不落附件**——文字已在列表，落附件会让每次回复都多一个音频文件、拖慢落库且污染上下文附件行。
  - **退出**：关闭键 / Esc / 切换会话 / 组件卸载——停止录音、清播报队列。

## 交互状态机

| 态 | 波形/状态区 | 麦克风键 | 说明 |
|---|---|---|---|
| idle | 提示文案「点击麦克风说话」；run 进行中显示「正在思考…」 | 空心 Mic | 可录音；播报队列按序消费 |
| recording | 实时电平波形 + `m:ss` 计时（复用录音胶囊视觉） | 实心 ■（点击 = 停止并转写发送） | 60s 到点自动停止；<500ms 丢弃提示 |
| transcribing | Loader | 禁用 | 识别完成即发送，回 idle |
| speaking | 合成中 Loader → 播报中动画波形 | Mic（点击 = 打断并开始录音） | 一次一条；队列空回 idle |

- Esc 仲裁（escape-layers，`inline` 档）：recording 中 Esc = 取消录音（丢弃），其余态 Esc = 退出语音模式。
- 识别为空（没说话）：toast 且不发送，回 idle。
- 转写失败（非缺设置原因）：**空文本 + 附件照发**（26 号语义，Bot 收到附件行后可用 `transcribe_audio` 自行转写兜底）；`CAPABILITY_NOT_CONFIGURED` / `PROVIDER_AUTH_FAILED` → 置卡。**实现修订**：实现顺序为转写在上传之前，能力错误出现时尚未上传、无附件可撤——原「撤回已传附件」分支自然失效，缺设置只置卡、不发送不上传。
- 播报失败：**第一条即停队列** + toast（带「打开设置」深链）——缺配置 / 断网时逐条跳过会连环失败刷 toast；停队后不自动重试，下条消息到来重新开始。

## 用户语音发送链路（26 号「语音消息语义」落地）

```
sensors.open('microphone') → startVoiceRecording(stream, onLevel)   // 传感器层：总闸/TCC/设备/回退全复用
  → stop(): 16kHz mono WAV base64（voice-recorder 复用，60s≈1.9MB）
  → media.transcribeSpeech({ audioBase64, audioMime: 'audio/wav' }) → text
  → composerDrafts.uploadFiles(File(`voice-{ts}.wav`, 'audio/wav')) // blob 包 File 走既有上传管道；语音条不渲染 chips
  → settle() → chatSession.send(text, { attachmentIds })            // 走 performComposerSend / sendGuard 防重入
  → messages.send（空文本 + 纯附件合法）
```

- 录音 / 转写内容不进输入框草稿；发送成功 `commitSent` 摘记录。**实现修订**：发送失败不撤回附件——chip 原样留在 composerDrafts（见下条），退回文字模式可见可删。
- 语音发送与文字输入共用同一 composerDrafts 会话实例：退出语音模式后若有未完成的异常残留（chip），在文字模式可见可删，无静默孤儿（7 天 sweepOrphans 兜底）。
- **实现修订（主模型门禁）**：语音发送不走文字直发的 `gateForSend`（转写已完成、内容不回输入框，拦下也无草稿可留）；缺主模型等场景由 core run 结构化 setup 失败兜底出卡，配好后 `continueAfterSetup` 重试续跑。
- **实现修订（连发防重入）**：语音发送与文字直发共用 sendGuard（按会话分闸），guard 忙时语音**排队等空闲（`waitForIdle` 串行化）而非忽略**——转写文本是用户已说出口的话，不允许静默丢弃；空闲后按转写完成序逐条发出，文本与附件配对完整。
- 群聊（项目组）不提供入口：多 Bot 场景「谁回复」不明确、播报需按 Bot 区分音色，本期只做私聊。

## Bot 语音播报链路（渲染层编排，核心新增）

`voice-mode.svelte.ts`（features/chats，Svelte `$state` 单例）：

- **入队**：chat-session 在 `#ingestMessage` 处暴露一个轻量订阅口（如 `onIncomingMessage(cb)`），voice-mode 注册——条件 `senderType='bot' && kind='text' && conversationId=当前会话 && 文本非空 && 语音模式开启中` → 入朗读队列。进入模式时**不补播**历史消息。**实现修订**：入队复用 `isVisibleInTranscript`（与消息列表同一可见性口径）——setupAnswer / task interim 等列表不可见的消息不播；原文「interim 中间说明与最终回复都播」按此修正为「列表可见才播」（播的 = 列表记的，风险 #3）。
- **朗读文本提取** `extractSpeechText(md)`（独立 util 纯函数）：剥围栏代码块（整体跳过——代码不朗读）、行内 code 保留文字、图片丢弃、链接保留文本、去表格 / 标题 / 引用 / 强调标记；结果 >2000 字截断 + toast 提示「内容过长，已播报前 2000 字」（一次播报的体验上限；TTS schema 的 50k 上限不设防无意义）。
- **合成与播放**：`core.call('media.synthesizeSpeech', { text, format: 'mp3' })`（voice / speed 缺省，dashscope 默认音色）→ Blob → objectURL → `new Audio()` 播放 → `ended` 后 revoke 并取下一条；一次只播一条，无并播。
- **打断 / 清理**：开始录音（停当前 + 清队）、退出模式、切换会话（pause + 清队 + revoke）。

## 能力、设置与记账

- 能力复用 **asr**（录音转写）与 **tts**（播报合成）：目录条目、`capability-model` 设置卡、inline setup、传感器层全部现成，**settings-catalog 零新增**——语音对话模式是会话内即时态（入口即开关），无持久用户配置；将来加「音色 / 语速 / 自动播报开关」再按 generic field-editor 模式登记（`store: { kind: 'settings', generic: true }` + `card: 'field-editor'`）。
- **记账**：`loopTypeSchema`（shared/domain/types.ts）加 `'voice_reply'`，bindings 的 `media.synthesizeSpeech` 传入——渲染层播报的 TTS 用量与 Bot `generate_speech`（无 loop 上下文）、语音输入转写（`voice_input`）区分。shared 契约改动后先 `pnpm --filter @kepcup/shared build`。

## 边界

- 语音模式为会话内即时态：不持久、不跨会话；关闭后历史照常在列表（文字 + 用户音频附件内联 `<audio>` 回放，MessageAttachments 既有能力）。
- readOnly 会话入口隐藏；实现修订：会话打开期间动态翻转为 readOnly（如卡片会话被关闭）时自动退出语音模式（否则 readOnly 分支顶掉语音条、无关闭键可退）；Bot 正在 run 时可继续录音发送（消息正常排队触发新一轮）；语音条可与 `RunStatusLine`、`SetupRequiredCard` 并存（都在消息列表 / 输入坞上方，互不遮挡）。
- 60s / 500ms 上限沿用 voice-recorder 常量；麦克风设备选择 / 隐私总闸 / TCC 全走传感器层（31 号）。
- 退出语音模式时输入框草稿原样保留。

## 测试锚点

- 渲染层单测（均已落地，`apps/desktop/src/renderer/src/lib/features/chats/`）：`extractSpeechText.test.ts`（围栏代码块 / 行内 code / 链接 / 图片 / 表格标题引用强调 / 截断）、`voice-mode.svelte.test.ts`（四态转移表 / Esc 分档 / 麦克风意图 / store 行为）、`voice-announce.svelte.test.ts`（`announceEntryFor` 入队条件含可见性口径 + 播报队列：顺序消费 / 暂播 / 插话作废清队 / 失败停队 / 退出清理 / objectURL revoke）、`voice-send.test.ts`（转写分支：空识别 / 缺设置置卡不上传 / 非缺设置空文本 + 附件照发 / guard 忙排队串行）、`composer-send.test.ts` 增补（sendGuard 的 `waitForIdle` 排队语义）、`lib/stores/chat-session.svelte.test.ts` 增补（`onIncomingMessage` 订阅口透传 `message.created`）。
- core：无新行为；loopType 枚举加值 → shared 契约测试同步（`voice_reply` 记账）。
- e2e 暂缓（需麦克风 + TTS 真实能力，随真机验收清单人工覆盖）；testid：`composer-voice-mode-entry` / `voice-mode-bar` / `voice-mode-mic` / `voice-mode-close`。
- 定向跑：chats 渲染层单测 + `locales.test.ts` + shared 契约测试（`pnpm --filter @kepcup/shared build` 先行）。

## 非目标（本期）

- 流式 ASR——点击式收发音沿用 26 号 D69；静音自动断句已随修订 v2 纳入（V2-4，基于录音电平的端点检测，非流式 ASR）。
- 播报音频落附件——文字已在列表、音频按需合成即可；双方语音消息的播放形态已随修订 v3 统一为语音气泡（V3-2）。
- 全屏语音接管（Grok 的整屏模糊背景形态）。
- 群聊（项目组）语音对话、多 Bot 多音色。
- 音色 / 语速设置项；播放侧真实电平波形（AnalyserNode）。
- 「自动连续对话」（回复播完自动开始下一轮录音）——保持点击式主动权在用户。
- **连续听 + 流式 VAD 切片**（2026-11-02 评估后不做）：麦克风常开、按 3s 静音切段、段间静音裁剪需要改造录音管道为按样点切片、并发 ASR/发送编排、全双工 AEC 与常开麦克风的隐私模型；风险高（回声污染用户消息 / 段序错乱），本期维持点击式录音。后续单独立项。

## 分期

- **P1 发送侧**：入口键 + 语音条 UI + 录音发送（26 号语义落地）+ i18n。可独立交付：语音对话先做到「说 → 文字进列表」。
- **P2 播报侧**：voice-mode store + `extractSpeechText` + `synthesizeSpeech` 播放队列 + 插话打断 + `voice_reply` 记账。
- **P3（按反馈）**：重播键 / 音色语速设置 / 播放侧真实电平 / 群聊评估。

## 修订 v2（2026-11-01，首轮真机验收反馈）

首轮真机验收暴露的问题：客户端 ASR 实际生效（用户气泡里就是转写文本），但按 26 号「语音消息语义」随消息发出的原始 WAV 附件，在 Bot 上下文里只是一行 `（附件：att_xxx voice-xxx.wav [audio/wav] 275KB）`——系统提示词的附件阶梯 + `transcribe_audio` 工具描述明确要求「用户发来语音/录音附件必须用本工具获取内容」，Bot 于是照章派出任务自行转写；用户要求「用语音回复」时 Bot 又有 `generate_speech` 可调，合成音频走文件产物（FileArtifacts）通道返回，只有下载没有播放。整体观感是「上传附件 → Bot 干活」，不是「打电话」。本轮修订目标：**对用户是一场语音通话，对模型仍是一问一答的文本对话**。调研（LiveKit / Pipecat 语音 Agent 框架、ChatGPT 语音模式）确认「客户端 ASR → 文本进 LLM → 客户端 TTS」级联就是业界标准管线，方案方向不变，缺的只是语义标注与交互细节。执行方案见 todo 的 WP5–WP8。

### V2-1 Bot 收到纯文本（origin: 'voice' 语义标注）

- 用户语音消息发送时经 `messages.send` 新输入 `voiceMode: true` → 消息 content 记 `origin: 'voice'`（`textContentSchema.origin` 枚举加值，沿用 `workbench` / `delegation` / `widget` 先例；content 是 JSON 列，零迁移）。
- core 上下文两处标注（`agent/context/conversation.ts`）：① `renderMessageLine` 对 voice 消息的音频附件条目追加「语音原始录音，正文即其转写」；② `buildTriggerSegment` 新增 `voiceWakeHint`（与 `delegationWakeHint` / `projectWakeHint` 同模式）：本批消息来自语音对话模式——正文即用户语音的转写文本，音频附件仅为原始录音存档，无需再用 `transcribe_audio` 转写或读取；回复将由客户端自动转为语音播报——不要调用 `generate_speech`，回复请口语化、简短、适合朗读（代码块 / 表格不会被播报）。
- 播报排除：`announceEntryFor` 增加 `content.origin !== 'task'`——任务侧消息（`forward_task_result` 转发结果与任务 run 内 `send_message` / `send_media` 的可见说明，D75）只供阅读、不播报。
- **实现修订（转写失败降级）**：标注与 `voiceWakeHint` 只对**正文非空**的 voice 消息生效（`isVoiceMessageWithTranscript`）。转写失败分支发的是「空文本 + 附件」，此时若仍声称「正文即其转写」会堵死 Bot 的 `transcribe_audio` 兜底、丢掉用户话语；空正文的 voice 消息退回普通音频附件语义（`origin: 'voice'` 照常落库，仅上下文标注条件化）。
- **实现修订（标注时机）**：core 的服务端 schema parse 会剥离未声明键——`messages.send` 输入必须加 `voiceMode` 字段，否则渲染层传了也会被静默丢掉（`rpc/server.ts` 的 `parseOrThrow`）。

### V2-2 双方语音统一播放器（H5 音频组件）

- 新组件 `AudioPlayer.svelte`（features/chats）：播放/暂停键 + 进度条 + 时长，点击切换播放/暂停；替代 MessageAttachments 音频分支的裸 `<audio controls>`（用户 wav 附件，点击播放即懒加载字节）。
- Bot 发回的音频文件产物（`FileArtifacts.svelte`，如 `generate_speech` 的 mp3/wav）：MessageArtifact 无 mime 字段，按扩展名识别音频，渲染为同一 AudioPlayer 行（字节经 `files.preview` 取），保留原卡片的查看 / 下载入口。
- Bot 文本气泡「朗读」键：bot text 气泡操作区加播放/暂停小键（tts 能力 ready 才显示）——对任意历史回复按需 TTS 朗读，与播报队列共用音频缓存与打断仲裁（V2-3）。
- **实现修订（视图与逻辑分离）**：仓库没有可挂组件的 vitest DOM 项目，播放器状态机放在 `audio-player.svelte.ts`（idle / playing / paused / ended、ended 归零重播、metadata 未到不 seek），`AudioPlayer.svelte` 只做视图。文件产物的音频识别在 `artifact-kind.ts` 的 `isAudioArtifact()`（扩展名集合，`.webm` / `.ogv` 已归视频的不吞）；字节走 FileViewer 同一条 `files.preview` 通道。

### V2-3 播报音频缓存与仲裁

- 新模块 `speech-audio.svelte.ts`：Bot 语音音频缓存 messageId → { objectURL, mimeType }，内存 LRU（约 20 条，逐出即 revoke）；播报队列与手动朗读都经它取音频（未命中才 `synthesizeSpeech`），播完不再立即 revoke（生命周期归缓存管）。
- 仲裁：任一播放开始都停掉另一个（播报中点朗读 = 打断播报、播指定消息；朗读中新播报到来 = 打断朗读）；语音模式录音开始仍走既有 `interruptSpeech` 清队。
- **实现修订（录音接管扬声器）**：录音开始（`acquireRecording` 拿到流，TCC 等待期不算）统一 `speechAudio.stop()`——语音模式与文字语音输入两路共点收口。`stop()` 以**抢占语义**收尾：等待中的播放 promise 解析为 preempted（不挂起），与 `interruptSpeech` 的 epoch 作废互为幂等（先到者生效、后到者 no-op），不会双 toast。否则会出现「语音模式 idle 但朗读键在出声」时开口说话、TTS 与录音同开、转写收进回声。
- **实现修订（缓存存活期）**：播报音频缓存是**全局会话级**（退出语音模式不清），历史回复朗读与重播都依赖它；播完不 revoke，逐出（LRU 20）才 revoke。

### V2-4 静音自动发送（端点检测）

- 录音电平（`onLevel` 已有 50ms 节流的映射电平）接纯函数端点状态机（voice-mode.svelte.ts 扩展 + 单测）：电平 ≥ 阈值持续 ~250ms 记为「已说话」（hasSpoken），此后电平持续低于阈值 3s → 进入「待发送」子态。
- 待发送态：停止键变**绿色发送键**，点击立即停止 + 转写 + 发送；不点击则 2s 后自动发送——用户停止说话后 5s 内内容必然发出（业界端点 500–800ms，此处取长换「可见的发送确认」，常量可调）。
- 全程未说话（hasSpoken=false）持续 5s：自动取消录音并 toast「未检测到语音」，不再干等 60s 上限。60s / 500ms 既有边界不变。
- **实现修订（信号来源与安全侧）**：端点机由**电平帧驱动**（worklet 静音帧照发，仅 50ms 节流），不另起 5s 定时器——纯状态机可单测；帧停流的设备故障由 60s 上限兜底。`speech-resumed` 不做 250ms 持续确认（倒计时只剩 2s，等确认会把用户开口截在倒计时尾部）；误退回的代价只是再等一轮 3s 静音。2s 倒计时与 60s 上限汇入同一个 `stopVoiceModeRecording`，相位守卫保证后到者 no-op；`clearVoiceModeRecordingTimers()` 单点覆盖 stop / cancel / exit / 卸载四类收尾。

### V2-5 播放中语音打断（barge-in）与停止播放键

- 播报**播放中**（仅 playing；合成中无声音可打断、不监听）开一路麦克风监听：`sensors.open('microphone')` 约束带 `echoCancellation: true` 消除扬声器 TTS 回声；播放开始 ~500ms 后再武装（规避 AEC 收敛期泄漏），电平超阈值持续 ~200ms 判定用户开口 → 停播清队（`interruptSpeech`）→ 释放监听 → 走正常 `acquireRecording` 开始录音。
- 监听失败（权限 / 设备）静默降级为点击打断；隐私总闸关闭时监听流随传感器 hub 统一停止；退出模式 / 播完 / 打断全路径拆除监听。
- 语音条播报中新增**停止播放键**（■，设置键与麦克风键之间）：点击 = 停当前 + 清队，回 idle，不开始录音。
- **实现修订（归属门禁，审查 P2）**：主聊天与卡片对话两个 Composer 可同时挂载（项目会话的 `ProjectView` 只 CSS 隐藏聊天体，卡片对话再挂一个），而 voiceMode 是模块单例——第一版实现里隐藏实例也会渲染语音条、武装自己的监听，并可能抢先触发 barge-in，把录音写进**错误的会话**。现 `voiceMode` 记录 `ownerConversationId`（enter 写入、exit 清空），语音条渲染 / 播报入队 / 播报器注入 / barge-in 武装与触发 / 全部收尾路径（Esc、切会话、readOnly 翻转、麦克风停用、组件卸载）统一走 `voiceModeOwned` 门禁，只有归属实例接管（同源也修掉了既有的播报串扰）。同时 barge-in 触发回调用「相位仍是 speaking」二次守卫，双实例同拍触发只起一条录音链路。
- **实现修订（权限门）**：监听武装额外要求 `sensors.state.microphone.permission === 'granted'`——未授权时空开流会在**播报中弹 TCC 授权框**（用户只是在听回复），违背「静默降级」；进入语音模式时 `sensors.refresh('microphone')` 刷新快照（hub 启动不查权限），用户录过一次音后监听自然可用。AEC 消回声、阈值与持续时长只能真机校准（`SPEECH_LEVEL_THRESHOLD` / `BARGE_IN_SUSTAIN_MS` / `BARGE_IN_ARM_DELAY_MS` 均注明真机可调）；`AudioContext` 若停在 suspended，`getFloatTimeDomainData` 返回全零 → 监听静默失效，降级为点击打断。

### 调研锚点（2026-11-01）

- 端点检测：Pipecat 默认 `min_endpointing_delay` 500ms（blog.pipecat.ai/using-a-transformer-to-improve-end-of-turn-detection）；LiveKit 对 800ms 静音延迟的讨论（livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection）。
- barge-in 惯例：AEC（`getUserMedia` echoCancellation）消扬声器回声 + 播放期提高触发阈值 / 延迟武装 + hangover，否则把自己播的 TTS 当用户插话（github.com/elizaOS/eliza/issues/27245）。
- 管线形态：ChatGPT 初代语音模式即 Whisper → GPT → TTS 级联、历史以文字记录（reddit.com/r/ChatGPT/comments/1day7c1）；微信 / Telegram 语音消息持久化原始音频 + 点击播放，与我们用户侧附件语义一致。

## 修订 v3（2026-11-01，第二轮真机验收反馈）

第二轮真机验收的四类问题：① 全局朗读键跑偏——每条 Bot 消息都多了 TTS 按钮，而需求只是「语音对话模式下自动播报」；② 语音模式下的 Bot 回复仍是文本气泡，消息列表不像通话记录；③ 语音模式在录音 / 发送后没有保持，无法连续以语音沟通；④ 系统提示词没有语音模式声明，Bot 长篇汇报、派任务前没有即时反馈；⑤ Bot 语音消息没有持久语义标记，列表无法识别与回放。目标：**语音模式下双方消息都是语音消息形态（药丸 + 麦克风 + 波形进度 + caption），Bot 回复自动播报；其它会话维持原文互形态，不再有朗读键**。

### V3-1 删除全局朗读键

- 撤销 V2-2 在 Bot 文本气泡上加的朗读键（`ChatMessageRow` 的 `message-read-aloud` 与相关 i18n）：TTS 只由语音模式自动触发，普通对话不提供逐条朗读入口。
- `speech-audio` 保留，但职责改为：语音气泡点击播放、播报队列、用户录音附件回放共用唯一音频声道（仲裁不变）。

### V3-2 双方语音消息气泡

- 新组件 `VoiceMessageBubble.svelte`（features/chats）：药丸外形（用户气泡底色跟随当前对话 Bot 的**强调色**——与用户文本气泡同一 `resolveAccentColor` 取色口径，无 Bot 时回退主色；Bot `bg-muted`）、左侧麦克风、主体波形、点击整个药丸播放 / 暂停、波形按播放进度着色（已播柱不透明、未播 28%）、右侧时长（元数据到达后显示）；正文以 caption 放在气泡下方（`whitespace-pre-wrap`，可选中）。
- 判定与波形在 `voice-message.ts`（纯函数）：`origin === 'voice'` 的 text 消息 = 语音消息；用户消息必须带音频附件（转写失败但附件在也照常可播），Bot 消息不需要附件（音频按需合成）。波形由消息 id 的 FNV-1a / xorshift 生成 22 根固定轮廓（0.3–1），同一条消息重渲染不变。
- 渲染：`MessageBody` 在撤回分支之后优先渲染语音气泡；`ChatMessageRow` 把用户语音消息的音频附件从 `MessageAttachments` 过滤掉（不重复渲染播放器卡），其它附件照常。
- 播放源：用户 = `attachmentUrl` 拉原始 WAV；Bot = `speech-audio.ensureUrl`（TTS 缓存 / 合成）。`speech-audio` 新增 `toggleSource(messageId, loadAudio)` 与 `currentTime` / `duration` / `progress`（timeupdate 驱动）；暂停保留进度，停止 / 播完 / 抢占归零。
- **实现修订（非语音消息零变化）**：`origin` 不是 `voice` 的消息、任务消息（`origin:'task'`）、卡片消息全部走原有渲染，不出现语音气泡。

### V3-3 语音模式持续开启（会话级即时态）

- 语音模式进入后保持 active：录音 → 发送 → Bot 播报 → 回到 idle，只是相位回 idle，模式不退出；用户可连续点麦克风发送下一句。退出仍只由用户主动关闭 / Esc / 切会话 / readOnly / 组件卸载触发。
- core 新增会话级即时态（不落库、重启即清）：RPC `conversations.setVoiceMode { conversationId, active }` → `Orchestrator.setVoiceMode`（内存 Set）；进入 / 退出 / 卸载由 Composer 同步。`messages.send(voiceMode: true)` 也会把该会话置为语音模式（RPC 丢失时的兜底）；退出只走显式 RPC（分享 / 组件消息不推断退出）；会话删除时清掉。
- **实现修订（状态归属）**：沿用 V2-5 的 `ownerConversationId` 门禁——只有归属 Composer 同步 core，隐藏实例不得改写别人的语音模式。

### V3-4 系统提示词 `<voice_conversation>`

- `SystemPromptInput.voiceMode` + `buildSystemPrompt` 新段（只对 `loop: 'turn'` 且会话处于语音模式时注入，任务轮永不注入）：
  1. **立刻给反馈**：需要 `start_task` 或任何要等一阵的操作时，先 `send_message` 发一句简短确认（「我需要拉起独立任务处理，请稍后」），再调用工具；这是语音模式下 `send_message` 的正当用法（优先于「不用 send_message 发进度」的常规限制），本轮最终回复保持一两句。
  2. **只给结论**：任务结束 / 查询完成后直接说结果（「没有待提交文件」「有 3 个文件尚未提交」），不罗列文件明细、工作区状态、执行过程或技术细节；用户追问再展开。
  3. **口语化、简短**：1–3 句，不用 Markdown（标题 / 列表 / 代码块 / 表格 / 链接不会被朗读），不念文件路径、id、长串数字。
  4. **不要调用 `generate_speech` / 语音合成工具**：客户端会自动合成并播放。
- 英文界面用同义英文文案（同一组规则、同一顺序）。
- **实现修订（与触发段 hint 的分工）**：`voiceWakeHint`（V2-1）继续在触发批里说明「正文即转写、音频附件是存档、不要 transcribe_audio」——那是本批消息的事实；回复形态规则上移到系统提示词，任务结果触发的回合也持续生效。

### V3-5 Bot 回复记 `origin:'voice'`

- 语音对话轮的 Bot 可见回复（最终回复，及 `send_message` 的主动消息）在 content 记 `origin:'voice'`：UI 据此**持久**渲染语音气泡（退出模式后历史消息仍是语音形态），播报队列据此自动播放。无正文（纯附件）不标。
- 任务轮消息保持 `origin:'task'`（`forward_task_result` / 任务内 `send_message` / `send_media`）：不渲染语音气泡、不播报（V2-1 的排除不变）。
- **实现修订（提示词与标记同源）**：`voiceTurn = !isTask && 会话处于语音模式` 在 run 起点采一次，同时用于系统提示词与回复标记；中途退出语音模式不会让这一轮已生成的回复失去语音形态（autoplay 仍按当时的 active 判断）。
- **实现修订（自动播放口径）**：播报队列仍只在 `voiceMode.active` 时消费；语音模式下 `speechAudio.isPlaying` 的任何来源（队列 / 气泡点击 / 用户录音回放）都武装 barge-in，用户开口即停播并进入录音（V2-5 的武装条件从「speaking + playing」放宽为「active + isPlaying」；触发回调允许 idle 相位，`interruptSpeech` 在 idle 是 no-op）。

### V3-6 独立审查修正

- **P1 退出后不被在途语音发送复活**：不再把 `messages.send(voiceMode:true)` 写进会话级即时态。
  本轮语音语义改为「显式 `conversations.setVoiceMode` **或** 触发批里含用户语音消息」在 run 起点
  采一次（`batchHasVoiceMessage`）——RPC 丢失时本轮仍是语音轮，但退出后完成的在途发送不会把
  会话永久置真，后续文字轮不会被错误注入 `<voice_conversation>` / 标成语音。
- **P1 在途取源与录音互斥**：`speechAudio.stop()`（录音开始 / 停止播放 / 退出 / 卸载统一入口）
  与任何 `play()` 都递增手动取源世代——在途的 TTS 合成 / 附件拉取落地后不再自动外放；
  `VoiceMessageBubble` 在 recording / transcribing 相位禁用（与 v2 朗读键同一门禁）。
- **P2 生命周期一致性**：`setVoiceMode(true)` 清掉其它会话（core 与渲染层都只有一个语音会话）；
  从别的会话进入时先释放旧归属；卸载清理用「进入时登记的会话 id + 当前 owner」核对，不再依赖
  view 派生（`session.clear()` 会先置空 view，CardChat / close / leaveCurrent 曾漏掉退出）；
  `exitVoiceMode` 同时停音频并作废在途取源。
- **P2 降级路径**：`routeWithoutModel` 的可见说明（任务失败 / 中断）是语音轮的 Bot 文本，标
  `origin:'voice'`（自动播报 + 可回放），任务结果转发仍保持 `origin:'task'`。
- **P3 防护**：`messages.edit` 保留 content 里的语义字段（否则编辑语音消息会变成普通文本）；
  `conversations.setVoiceMode` 拒绝项目组（语音模式只存在于私聊 / 卡片对话）；语音规则补充
  「任务结果的长报告不要整段转发 / 复述」以消解与平台规则「转发长结果」的张力。

### V3-7 自动播报的列表源与手动接管（2026-11-02 第二轮反馈）

- **自动播报改为以消息列表为源**：不再依赖 `message.created` 订阅口，Composer 在语音模式
  期间扫描 `chatSession.view.messages` 中 **seq 水位之后**的新消息（`collectAnnounceEntries`），
  逐条经 `announceEntryFor` 入队。进入模式时把水位设为当前最大 seq（不补播历史）；列表更新
  一定会触发效果，事件漏投 / 订阅晚挂载都不会漏播。任务侧消息（`origin:'task'`）仍排除。
- **手动接管**：用户点击任意语音气泡时，`onManualPlayStart` → `voiceMode.takeManualControl()`：
  停当前 + 清空未播队列、本轮后续新音频不再自动播（`manualPlaybackOverride`）；下一段用户语音
  `record-started` 时恢复自动播报。手动点击的目标消息由 `speech-audio` 直接播放，天然抢占当前声道。
- **队列语义**：自动播报期间新音频入队顺序播放；手动点击时当前内容切换为用户点击的消息、队列
  清空，此后由用户手动操作。
- 连续听评估结论见「非目标」：不做常开麦克风 + VAD 切片，维持点击式录音（风险：切片正确性、
  并发转写/发送、TTS 回声、隐私与常开流）。

- **实现修订（审查 P1）**：`toggleSource` 必须在 `onManualPlayStart()` / 抢占**之后**再取
  世代号——接管会经播报队列的 `stopCurrent` 调 `speechAudio.stop()` 递增世代，先取号会让
  用户点的那条被自己的停播作废（取源落地后直接返回，永远不播）。补单测覆盖「播报中手动点
  另一条：接管后点击的消息照常播放」。

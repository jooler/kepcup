# 53 语音对话模式

26 号暂缓的「语音对话模式」（D69 二次修订时保留设计、入口隐藏）恢复实施。形态参考 Grok 语音条（悬浮胶囊：头像 + 波形 + 设置 + 切文字 + 麦克风 + 关闭）：进入后**输入坞原位切换为语音条**，用户点麦克风说话即发送语音消息，Bot 回复自动语音播报；**对话全程以文字记录在消息列表**——用户消息 = 转写文本 + 音频附件（26 号「语音消息语义」的落地），Bot 消息 = 既有文字落库 + 渲染层播报（音频不落库）。

与 Grok 全屏语音模式的关键差异：Grok 进入语音模式后聊天列表被盖住，需要「切文字」键展开记录；KepCup 的语音条**只接管输入坞，消息列表始终可见可滚动**——「全部转为文字记录到消息列表」是一等需求，天然满足，因此不设「切文字」键，关闭即回文字输入。

**状态：已实施（2026-11-01，开发收口；真机验收待用户执行）。** 决策 **D106**；执行方案与实施记录见 [todo/voice-conversation.md](../../todo/voice-conversation.md)。实现与本文的偏差已就地加「实现修订」注。

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

- 流式 ASR / 静音自动断句（VAD）——点击式收发音沿用 26 号 D69。
- 播报音频落附件 / Bot 气泡「重播」键（P3 按反馈评估）。
- 全屏语音接管（Grok 的整屏模糊背景形态）。
- 群聊（项目组）语音对话、多 Bot 多音色。
- 音色 / 语速设置项；播放侧真实电平波形（AnalyserNode）。
- 「自动连续对话」（回复播完自动开始下一轮录音）——保持点击式主动权在用户。

## 分期

- **P1 发送侧**：入口键 + 语音条 UI + 录音发送（26 号语义落地）+ i18n。可独立交付：语音对话先做到「说 → 文字进列表」。
- **P2 播报侧**：voice-mode store + `extractSpeechText` + `synthesizeSpeech` 播放队列 + 插话打断 + `voice_reply` 记账。
- **P3（按反馈）**：重播键 / 音色语速设置 / 播放侧真实电平 / 群聊评估。

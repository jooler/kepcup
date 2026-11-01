# 语音对话模式（D106）— 执行方案

> 状态：**开发完成待真机验收（2026-11-01）**（当日设计定稿、用户已确认全部取舍，WP1–WP3 提交 b806479f / 25133a07 / f69007b7，WP4 开发收口）。设计见 [docs/design/53-voice-conversation.md](../docs/design/53-voice-conversation.md)（D106），发送链路按 [docs/design/26-voice-input.md](../docs/design/26-voice-input.md)「语音消息语义」一节；两份都先读再开工。
> 现状锚点：录音管道 / 传感器层 / asr+tts 能力卡 / 附件管道全部现成，core 零改动（仅 loopType 加值）；`Composer.svelte:1078-1079` 有「语音对话模式暂缓」旧注释，实现时删除并指向本方案。
> 约定：迭代中只跑定向测试（AGENTS.md：`node scripts/run-tests.mjs run <文件>`）；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；改设置相关代码跑 settings 四件套（语音功能本身无 settings 改动；收口期顺带修复 9defc083 遗留的 deep-link 白名单漏登，四件套 + deep-link 定向 96/96 已跑绿）；i18n 改动跑 `locales.test.ts`；收口跑一次全量 `pnpm test`。

## 0 工作包总览与依赖

```
WP1 shared 记账（loopType voice_reply，小）─┐
WP2 渲染层发送侧（入口 + 语音条 + 录音发送）─┴► WP3 渲染层播报侧 ─► WP4 收口与真机验收
        （M1 = WP1+WP2：说→文字进列表；M2 = WP3：回复自动播报+打断；M3 = WP4）
```

WP2 不依赖 WP1（发送侧只用既有 `voice_input` 转写）；WP3 依赖 WP2 的 UI 态与 WP1 的记账标签。

## WP1 shared 契约与用量记账（M1，可与 WP2 并行）

文件：`packages/shared/src/domain/types.ts`（`loopTypeSchema`，`voice_input` 旁 :1585）、`packages/core/src/rpc/bindings.ts`（`media.synthesizeSpeech` 绑定 :660-664）、`apps/desktop/src/renderer/src/lib/features/settings/UsageSection.svelte`（loopType → i18n 标签映射 :22 附近）、`apps/desktop/src/renderer/src/lib/i18n/locales/zh-CN.ts` / `en-US.ts`（`usage.loop.voice_input` 旁 :1147 / :1187）。原方案的「今日后台用量」过滤已随 ea816292（2026-10-19 移除后台用量上限）删除，后台用量口径不复存在，该项自然失效，无需处理。

- [x] `loopTypeSchema` 加 `'voice_reply'`（注释：语音对话模式播报（53），渲染层前台行为）。
- [x] `media.synthesizeSpeech` 绑定传入 `{ loopType: 'voice_reply' }`（对齐 `transcribeSpeech` 的 `voice_input` 写法）。
- [x] `UsageSection.svelte` 标签映射加 `voice_reply: 'usage.loop.voice_reply'`。
- [x] i18n：`usage.loop.voice_reply`（zh「语音播报」/ en "Voice reply"）。
- [x] 定向：`pnpm --filter @kepcup/shared build` + shared 契约相关单测 + `locales.test.ts`。
- 验收：语音模式播报一次后，用量页出现「语音播报」归类（「不计入后台用量」随口径删除自动成立）。

## WP2 渲染层发送侧（M1）

文件：`apps/desktop/src/renderer/src/lib/features/chats/Composer.svelte`（入口键 + 语音模式切换 + 录音/转写/发送编排；删 :1078-1079 旧注释）、`apps/desktop/src/renderer/src/lib/features/chats/VoiceModeBar.svelte`（新，语音条 UI）、`apps/desktop/src/renderer/src/lib/features/chats/voice-mode.svelte.ts`（新，本包只做 UI 状态机，播报队列 WP3 扩展）、i18n `voiceMode.*` 键（zh-CN / en-US 同步）。

- [x] **入口键**：输入坞左下工具行（附件键旁）加「语音对话」键（lucide `Speech`，`data-testid="composer-voice-mode-entry"`）；仅私聊会话（`conversation.type !== 'project'`）且非 readOnly 显示，录音中禁用。点击预检 `isCapabilityReady('asr')` / `isCapabilityReady('tts')`，缺哪个 `chatSession.requestCapabilitySetup(哪个)` 置卡、不进入；都 ready → 进入语音模式（输入坞原位切换为语音条，草稿保留）。
- [x] **VoiceModeBar**：布局 `BotAvatar ｜ 波形/状态区（弹性）｜ 设置键 · 麦克风键 · 关闭键(红 X)`；占据输入坞原位（同层替换，**不用 fixed/Portal**，不接 `data-window-overlay`）；testid `voice-mode-bar` / `voice-mode-mic` / `voice-mode-close`。四态：idle（提示「点击麦克风说话」；run 进行中显示「正在思考…」）/ recording（实时电平波形 + `m:ss` 计时，复用录音胶囊视觉与 `voice-dot` 动画）/ transcribing（Loader）/ speaking（WP3 接入，先占位）。
- [x] **录音发送**（26 号「语音消息语义」落地）：复用 `startRecording` 的传感器链路（能力预检之外的部分：隐私总闸 → TCC 门 → `sensors.open('microphone')` → `startVoiceRecording`，60s 上限 / 500ms 下限 / 设备回退提示全沿用）；停止 → `media.transcribeSpeech` → 空识别 toast 不发送 → WAV 包 `File('voice-{ts}.wav','audio/wav')` 走 `composerDrafts.uploadFiles` → `settle` → `chatSession.send(text, { attachmentIds })`（走 `performComposerSend` / `sendGuard` 防重入）→ `commitSent`。转写失败非缺设置：空文本 + 附件照发；`CAPABILITY_NOT_CONFIGURED` / `PROVIDER_AUTH_FAILED`：撤回已传附件（`attachments.detach`）+ 置卡（实现修订：转写先于上传，能力错误发生时无附件可撤，只置卡——见 53 号「实现修订」注）。语音条不渲染 chips，但与文字草稿共用 composerDrafts（异常残留退回文字模式后可见可删）。
- [x] **状态机与清理**：发送后立即可再录（不等回复）；Esc 仲裁（escape-layers `inline` 档）：recording 中 Esc = 取消录音丢弃，其余态 = 退出语音模式；关闭键 / 切换会话 / 组件卸载（`$effect` cleanup）= 停止录音 + 释放流 + 回文字输入。
- [x] i18n：`voiceMode.*`（进入/提示文案/过长/失败等，键名对齐 `composer.voice*` 风格）；`locales.test.ts` 绿。
- [x] 渲染层单测：voice-mode UI 状态机纯逻辑（能抽纯函数的部分：状态转移、时长格式化复用既有）。
- 验收（真机）：私聊进入语音模式 → 说话 → 停止 → 消息列表出现用户消息（文字 + 音频附件内联 `<audio>` 可回放）→ Bot 文字回复正常落库显示；缺 asr / 缺 tts 分别置对应能力卡；Esc 分档正确；切会话退出无残留；群聊与 readOnly 会话无入口。

## WP3 渲染层播报侧（M2）

文件：`apps/desktop/src/renderer/src/lib/features/chats/extractSpeechText.ts`（新）、`apps/desktop/src/renderer/src/lib/features/chats/voice-mode.svelte.ts`（扩展播报队列）、`apps/desktop/src/renderer/src/lib/stores/chat-session.svelte.ts`（`#ingestMessage` :485 处暴露轻量订阅口，如 `onIncomingMessage(cb)`）、`VoiceModeBar.svelte`（speaking 态实装）。

- [x] **extractSpeechText**（纯函数 + 单测）：剥围栏代码块（整体跳过）、行内 code 保留文字、图片丢弃、链接保留文本、去表格 / 标题 / 引用 / 强调标记；>2000 字截断（调用方 toast 提示，每条一次）。
- [x] **入队**：经 chat-session 订阅口收 `message.created`——条件 `senderType='bot' && kind='text' && conversationId=当前会话 && 文本非空 && 语音模式开启中`，**且复用 transcript-visibility 的可见性口径**（`isVisibleInTranscript` 过滤后的才播，setupAnswer / task interim 等不可见消息不播）；进入模式不补播历史。
- [x] **播报队列**：逐条 `core.call('media.synthesizeSpeech', { text, format: 'mp3' })`（voice / speed 缺省）→ Blob（type 取返回 mimeType）→ objectURL → `new Audio()` 播放 → `ended` revoke 取下一条；一次一条。speaking 态区分「合成中 Loader / 播放中波形动画」。
- [x] **插话作废**：真正进入 recording（拿到流，非点击瞬间——TCC 弹框等待期不打断）→ 停当前音频 + 清空未播队列（被作废回复只留文字）；recording / transcribing 期间新 Bot 消息照常入队但暂播，回 idle 按序播。
- [x] **失败降级**：第一条播报失败即停队 + toast（带「打开设置」深链到 models 分区）；不自动重试，下条消息到来重新开始。
- [x] **清理**：退出模式 / 切会话 = pause + 清队 + revoke 全部 objectURL。
- [x] 定向单测：`extractSpeechText`（代码块 / 行内 code / 链接 / 图片 / 截断）+ voice-mode 队列逻辑（入队条件 / 作废清队 / 失败停队 / 退出清理——事件源抽成可注入的纯逻辑测）。
- 验收（真机）：语音模式内 Bot 回复自动播报、播完回 idle；播报中点麦克风立即停播并开始录音；连发多句回复按序播；断 tts 场景停队 + toast 不刷屏；退出后一切停止、列表内容完整。

## WP4 收口与真机验收（M3）

> 真机验收待用户执行（2026-11-01 开发收口，自动化部分全绿）。

文件：`docs/design/53-voice-conversation.md`（状态改已实施）、`docs/design/README.md`（索引行 / D106 行状态与链接）、`docs/design/26-voice-input.md`（暂缓标记收口）、`docs/dev/PROGRESS.md`（记录）、`todo/voice-conversation.md`（本文件勾结）。

- [ ] 全量验收清单（真机，逐条勾）：
  - [ ] 缺 asr / 缺 tts 预检置卡；配齐后可进入
  - [ ] 说话 → 列表出现文字 + 音频附件（可回放）
  - [ ] Bot 回复自动播报；插话打断；连续多句按序播
  - [ ] Esc 分档（录音取消 / 空闲退出）；关闭键；切会话清理
  - [ ] 群聊 / readOnly 无入口
  - [ ] 60s 到点自动停止转写发送；<500ms 丢弃提示
  - [ ] 断网转写失败 → 空文本 + 附件照发，Bot 可 `transcribe_audio` 兜底转写
  - [ ] tts 失败 → 停队 + toast 深链，不连环刷
  - [ ] 用量页「语音播报」归类正确（WP1 验收）
- [x] 定向测试清单：WP1 + WP2 + WP3 各项 + `node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/i18n/locales.test.ts`。
- [x] 收口：跑一次全量 `pnpm test`；PROGRESS 记录；文档勾结。

## 风险与注意

1. **打断时机绑定「拿到流」而非「点击」**：TCC 授权弹框可能停留数秒，点击瞬间停播会在用户还没开口时白打断；以 `sensors.open` 成功、录音真正开始为准。
2. **长回复合成延迟**：TTS 是整段非流式，2000 字可能合成 10s+——speaking 态必须有「合成中 Loader」，避免像卡死；P3 再评估按段落切分流水线合成。
3. **播报可见性口径必须复用 `isVisibleInTranscript`**：否则会播出列表里看不到的内容（setupAnswer、task interim 等），破坏「播的 = 列表记的」一致性。
4. **objectURL 泄漏**：每条播完即 revoke；清队 / 退出统一 revoke；异常路径（组件卸载）由 `$effect` cleanup 兜底。
5. **不要动 core / orchestrator**：播报纯渲染层编排；若实现中发现需要 core 支持（如「回复语音化」落附件），回到 53 号设计先修订，不就地加。
6. **语音条不要走 fixed / Portal**：输入坞原位替换不在窗口拖拽带内；若实测发现遮挡冲突，先回看 53 号 §D106 的定位决策再改。
7. **CSP / 资源**：无新增音频资源文件（复用 `voice-capture-worklet`）；播放走 blob objectURL，`script-src 'self'` 不影响 `media-src`（`<audio>` blob 播放已被 MessageAttachments 验证过）。
8. **settings 快照未加载时预检放行**（26 号惯例）：由 core 错误码兜底置卡，不在渲染层阻塞。

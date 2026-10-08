# 26 语音输入

输入坞的语音化（参考 Grok）：**语音键**（点击开始录音，UI 变为「停止 + 计时 + 点点」胶囊，再点停止并转文字填入输入框）。识别一律走能力模型（asr，[16](16-capability-models.md)），未配置时走对话内设置引导（D58，[18](18-inline-setup.md)）。Bot 侧消费音频的 `transcribe_audio` 工具见 [25](25-capability-tools.md)。**语音对话模式**（输入坞整体切语音条、按住发音频消息）已设计但**暂缓实现**，入口隐藏（设计保留在本文，恢复时按「语音消息语义」一节实现）。

## 决策

- **D69 语音输入**（2026-10-06 二次修订：长按改点击切换，语音对话模式暂缓）：输入坞右侧语音键（白圆 AudioLines 图标，与原语音对话键同款样式）——**点击**开始录音，原位变为录音胶囊（■ 停止方块 + `0:04` 计时 + 点点错相动画），**再点**胶囊停止并转写填入输入框（已有文本则接一个空格）；Esc 取消。有内容或草稿队列非空时该位置是发送键（出现逻辑不变），录音中若输入框有内容则胶囊与发送键并列（同 Grok 图 1 布局）。未配置 asr 能力时点击置起语音识别模型设置卡（复用 D58，`SetupRequiredCard` 已按能力泛化），配好后重新点击。录音管道直接采 16kHz 单声道 PCM 编码 WAV（不使用 MediaRecorder 的 webm/opus——部分 ASR 厂商不收）。
- **语音对话模式（暂缓）**：输入坞整体切语音条、按住采集、松开直接以音频形式发送；语音消息 = 音频附件（`voice-*.wav`）存进对话列表 + 转写文本作为消息内容发给模型；识别为空不发送；非缺设置的识别失败音频照发（空文本 + 附件），Bot 可用 `transcribe_audio` 工具对附件自行转写。恢复实现时按「语音消息语义」一节。

## 入口与状态

| 状态 | 右侧按钮 | 点击行为 |
|---|---|---|
| 空输入 + 空队列 | 语音键（白圆 AudioLines） | 预检 asr（未配置→设置卡，不出录音 UI）→ TCC 授权门 → 开始录音 |
| 录音中 | 录音胶囊（■ + `m:ss` + 点点） | 停止并转写填入输入框（60s 到点自动停止转写；<500ms 丢弃并提示） |
| 识别中 | 胶囊加载态 | — |
| 有内容或队列非空 | 发送键 | 既有行为（addCurrent / flush），出现逻辑不变 |

- Esc 取消录音（丢弃并释放麦克风）；切换会话 / 组件卸载同（`$effect` cleanup）。
- 转写结果为空（没说话）：toast 提示且不填入。

## 语音消息语义（暂缓，恢复实现时按此执行）

发送链路复用 20 号附件管道：WAV blob 包成 File 走 `composerDrafts.uploadFiles`（chip、失败 toast 同源）→ `settle` 拿 attachmentId → `chat.addDraft(转写文本, { attachmentIds })` → `chat.flush()`。效果：

- 对话列表里是一条带音频附件的消息（20 号的内联 `<audio>` 播放），消息文本即转写文本——「语音保存在对话列表中，内容转换为文字发送给模型」。
- 转写失败（网络等非缺设置原因）不拦发送：空文本 + 附件照发，Bot 收到附件行后可用 `transcribe_audio`（25 号）对附件转写，模型侧兜底。
- 识别结果为空（没说话）：toast 提示且不发送。
- 缺设置：不发送、撤回已传附件、置起设置卡。

## 录音管道（voice-recorder.ts）

```
getUserMedia({audio: 单声道 + 回声消除 + 降噪 + 自动增益})
  → AudioContext(16kHz) → AudioWorklet（独立资源文件 voice-capture-worklet.js）
  → PCM Float32 块累积 + RMS 电平（50ms 节流回调，驱动波形）
  → stop(): 拼合 → Int16 → WAV 容器（44 字节头）→ base64
```

- 不用 MediaRecorder：Chromium 只产 `audio/webm;codecs=opus`，qwen3-asr 等兼容通道不收 webm；WAV 16k mono 全厂商兼容，60s 约 1.9MB。
- **采集约束全是软性（ideal）**：`channelCount: 1` 这类精确约束在部分设备上会直接 `OverconstrainedError`（stereo-only 的 USB 麦克风、显示器拾音等），此时回退裸设备（放弃回声消除等处理）再试一次——授权通过却「无法访问麦克风」的典型根因。
- **worklet 必须同源资源加载，不能内联**：渲染层 CSP（`index.html` meta）`script-src 'self'` 拦 blob: 与 data: 脚本——最初用 blob URL 内联，`addModule` 直接被 CSP 拒绝（症状：授权正常但永远「无法开始录音」）；改 `?url` 后又因文件 <4KB 被 Vite 内联成 data: URL，打包版复发。最终 `?url&no-inline` 强制独立文件（`assets/voice-capture-worklet-*.js`），dev 与打包版同源加载。失败原因（getUserMedia / addModule 的底层异常）现在透传到 toast（`composer.voiceMicFailed`）便于定位。
- **（D76 修订）硬件部分已收编进传感器层**：设备枚举、授权门、设备偏好、启停与「硬件」分区改由 [31-sensors.md](31-sensors.md) 统一管理，本节的设备选择描述为现状，实现后以 31 为准；本管道只保留 WAV 采集 / 编码。
- **输入设备可选**：设置页新增「硬件」分区（`HardwareSection`），枚举 `enumerateDevices()` 的音频输入（未授权时浏览器不给设备名，提示先按录一次授权后刷新）；选择持久化在 localStorage（`kepcup.micDeviceId`，渲染层本机偏好不进 core），空 = 跟随系统默认。
- worklet 节点接零增益 GainNode 落地——不接目的地不会被音频 graph 拉动，直接接 destination 会回声。
- 单测锚纯函数：`encodeWav`（容器头/夹紧）、`formatRecordingDuration`、`levelToHeight`；采集链路需真实麦克风，不在单测内。

## 缺设置引导（与 D58 同层）

- 预检：`settingsStore.isCapabilityReady('asr')`（能力配置非空 + 厂商 Key 在）；settings 快照未加载时放行，由 core 错误兜底。
- 置卡：`chat.requestCapabilitySetup('asr')`——与发送门禁共用 `#pendingSetup`，`SetupRequiredCard` 按 capability 泛化渲染 `CapabilityModelSection`（asr 的 i18n 早已就绪）；`continueAfterSetup` 收卡（语音场景没有待续跑的 run/草稿，用户重新按录即可）。
- 兜底：录音后 `media.transcribeSpeech` 返回 `CAPABILITY_NOT_CONFIGURED / PROVIDER_AUTH_FAILED` 时同样置卡。

## 权限（macOS TCC）

macOS 的麦克风授权弹框**只出现一次**：首次 `getUserMedia` 被拒（或弹框被关掉）后，系统永远不再弹框，后续请求直接抛 `NotAllowedError`——这就是「只有失败提示、没有系统反馈」的原因。因此按录前走显式授权门（`mic-access.ts`，经主进程 IPC）：

| TCC 状态 | 动作 |
|---|---|
| `granted` | 直接开始采集 |
| `not-determined` | `systemPreferences.askForMediaAccess('microphone')` **主动拉起系统授权弹框**；批准 → 开始采集（授权弹框期间松开 = 取消，会话号机制已覆盖），拒绝 → denied 路径 |
| `denied` / `restricted` | 系统**不会再弹**：toast 提示 + 「打开系统设置」按钮深链 `x-apple.systempreferences:…?Privacy_Microphone`，用户手动打开开关后重试 |
| `unknown` | 通用失败提示 |

- 非 macOS 无 TCC：主进程直接返回 granted（Windows 用自己的隐私指示器）。
- dev 模式的授权归属是**宿主终端应用**（responsible process）——弹框会写「终端/VS Code 想使用麦克风」；打包版归属 KepCup 自身。
- macOS 打包需 `NSMicrophoneUsageDescription`（electron-builder.yml `mac.extendInfo` 已加），否则打包版直接被系统拒绝。

## 测试锚点

- 渲染层单测：voice-recorder 纯函数（WAV 编码、时长、电平映射）。
- e2e（需麦克风/伪设备，暂缓）：语音键点击 → 录音胶囊出现 → 点击胶囊 → 输入框出现转写文本；未配置 asr → 设置卡出现。
- core 侧：`transcribe_audio` 工具见 25 号锚点；语音消息本身是既有附件/草稿链路的复用，无新 core 行为。

## 非目标

- 边说边出字的流式转写（当前点击开始→点击停止→整体识别）；ASR 流式 API 接入。
- 微信式「滑到上方取消 / 松开取消」双区手势（当前滑出即取消，单一手势）。
- 语音条内编辑转写文本（识别结果直接进输入框的路径已覆盖编辑需求）。
- 语音消息的波形气泡展示（复用 20 号内联 `<audio>` 播放器）。

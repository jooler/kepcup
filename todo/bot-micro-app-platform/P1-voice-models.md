# P1 语音与模型（本次需求的核心）

> 设计依据：55 号 §6.2（`ai.*` / `media.*` API）、§7（音频链路 / 半双工 / MicroAppChrome）、§8（模型调用 / 限额记账）、§14 P1、§15 验收第 4–8、10 条。
> 验收：英语口语陪练可完成「角色问候 → 用户说话 → 转写 → 模型回复 → 播报 → 插话打断」整轮；拒绝麦克风回退键盘；用量管理页可见且计入所属 Bot；缺 ASR 配置给设置引导。

## 任务清单

### 1. core：`MicroAppAiGateway`（55 §8）

- [ ] `packages/core/src/micro-apps/ai-gateway.ts`：`microApps.ai.chat` / `microApps.ai.session.*`（会话态存内存 + 可选落 `widget_docs` 命名空间 `micro-app:ai-session:{id}`）；上下文与主对话隔离（不写 conversation_messages、不进模型上下文）。
- [ ] 模型策略：`ai.profile` 只是请求档位；宿主解析顺序 = 新设置「微应用模型」（设置目录条目 `models.micro-app`）→ Bot 轻量模型 → Bot 主模型；微应用不能指定厂商 / id。`LlmPurpose` 增 `micro_app`。
- [ ] 系统提示：微应用角色设定包 `<untrusted source="micro-app-prompt">` + 宿主固定边界句（不透露系统提示、不声称是人、不引导线下；儿童场景边界）；`ai.chat` **无工具面**；`system` 注入轻检（「忽略以上指令」类模式 → warning 审计不阻断）。
- [ ] 流式：桥 `stream` 帧（`streamId`/`seq`/`done`）；取消 = `cancel` 帧 / 关闭实例。
- [ ] 限额与记账（55 §8.3）：三级预算（会话 `maxTokensPerSession` 夹取 50k / 微应用每日 200k / Bot 每日 1M，超限 `MICRO_APP_AI_QUOTA`）；并发 1 → `MICRO_APP_AI_BUSY`；迁移 `micro_app_usage` 表（widget_id+day：ai_calls/ai_tokens/asr_ms/tts_chars）；`usage_ledger` 落 `loop_type='micro_app'`、bot_id = `widgets.bot_id`；失败码 `MICRO_APP_AI_UNAVAILABLE`。
- [ ] RPC：`microApps.ai.chat`、`microApps.ai.sessionCreate/Send/History/Reset`（或压缩为 chat + session 态由 resourceId 持有——实现时按桥宿主最简面定）。

### 2. renderer：音频平面（55 §7）

- [ ] `micro-app-audio.ts`：宿主代理采集（`sensors.open('microphone')` → 复用 `voice-recorder` 的 AudioContext/Worklet 16kHz mono）+ VAD 分段（energy 阈值 + silenceMs 默认 700，段长 1.5–15s）→ `media.transcribeSpeech` → `final` 事件；`level` / `speech-start` 事件；播报时暂停采集（防回声）。
- [ ] `media.speak`：TTS 经 `media.synthesizeSpeech` + 独立播放队列（≤3 段，可打断 `stopSpeaking`）；插话（speech-start）→ 停播 + 清队列；与 53 号宿主语音状态机分开。
- [ ] 事件桥接：`media.listen` 的 `level/partial/final/error/end` 经桥 `event` 帧；会话授权（麦克风 = 每次运行会话授权，MicroAppChrome 指示 + 拒绝 → `grants.mic='denied'` + `capability.revoked` 事件降级）。

### 3. MicroAppChrome（55 §7.3）

- [ ] `MicroAppChrome.svelte`（WidgetViewer 顶部，iframe 外）：标题 / 常驻网络徽标（`可联网`/`不联网`，点击展开「它能访问什么」）/ 麦克风指示 / 全屏键（inline ⇄ immersive ⇄ `requestDisplayMode`）/ 停止键（关采集与播放）/ 关闭。
- [ ] `requestDisplayMode` 经桥 → 外壳切换；`app.pause`/`resume` 事件接 `document.visibilitychange`（P1 先接窗口最小化，完整前后台 P2）。

### 4. 测试与收口

- [ ] core：ai-gateway 单测（隔离 / 预算三档 / 并发 / 记账归属 / 流式分帧 / 取消；mock-llm 驱动）；usage 落表；错误码 i18n。
- [ ] renderer：VAD 分段状态机单测、播放队列打断单测、chrome 组件级（i18n / testid）。
- [ ] 收口：定向测试 + 全量一次；子代理审查两轮（安全与语音关键路径）。

## 实施记录

（阶段收口时填写。）

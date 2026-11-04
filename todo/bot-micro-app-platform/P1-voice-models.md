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

## 实施记录（2026-11-04）

### 交付内容

**shared**
- spec：`MICRO_APP_RUNTIME_PHASE` 前移 P1；`MICRO_APP_IMPLEMENTED_CAPABILITIES` += `ai.chat` / `media.listen` / `media.speak`；API 索引 += `media.listen.start` / `media.listen.stop`；预算常量（微应用每日 200k / Bot 每日 1M）；`MICRO_APP_ERROR_HINTS` += `MICRO_APP_BRIDGE_CLOSED`（errors.ts 同步注册 + i18n）。
- 垫片（generate.ts）：`kepcup.ai.chat / ai.session(...)`（流式 = call + stream → AsyncIterable 原语）；`kepcup.media.listen(...) → Listener{start/stop/on}`（channelId 动态事件通道）；`speak` / `stopSpeaking`；流通道 `error` 事件 → 迭代器 reject（fail(code)）。
- 契约：`microApps.ai.chat / sessionCreate / sessionSend / sessionHistory / sessionReset / cancel / dispose`、`microApps.media.transcribe / synthesize`、`micro-app.stream` 事件、`microAppInstanceRefSchema`（resourceId + `mai_` 实例键）；`loopTypeSchema` += `micro_app`；设置 `microAppModel`（schema + patch + 目录条目 `models.micro-app` + core 适配器 + 设置页下拉 + FieldEditor 通用卡可用 + i18n 两语言）。

**core**
- 迁移 `0069_micro_app_usage.sql`（widget_id + day 主键；ai_calls / ai_tokens / asr_ms / tts_chars）。
- `micro-apps/ai-gateway.ts`（`MicroAppAiGateway`）：
  - **隔离**：不写 conversation_messages、不进主对话（测试钉住）；`ai.chat` 无工具面。
  - **路由**：`routeFor(deps,'micro_app',botId)`（llm-router 增 purpose，`light_for_bot` 规则 + `settings.microAppModel` 优先；外部 Agent 路由明确拒绝）。
  - **系统提示**：角色设定包 `<untrusted source="micro-app-prompt" meta="widget=…,version=…">` + 宿主固定边界句（不自称人 / 不引导线下 / 儿童找家长）；注入模式命中只记审计（§8.4）。
  - **预算**：会话（清单 maxTokensPerSession 夹取 ≤50k，实例计数）/ 微应用每日 200k / Bot 每日 1M（跨微应用聚合）；并发 1 / 实例（`MICRO_APP_AI_BUSY`）。
  - **流式**：ack 立即带 streamId，后台跑流；delta / done / error 经 `micro-app.stream` 事件；`ai.cancel` / `ai.dispose` 收口。
  - **记账**：`usage_ledger`（runId 合成 `mai_use_*`、loopType `micro_app`、botId = `widgets.bot_id`）+ `micro_app_usage` 累计；会话轮数上限；实例 LRU（64）有界。
- `WidgetService.microAppContextOf(resourceId)`：resourceId → 生效版本清单（权限 / 预算 / 归属 Bot）。
- `microApps.media.transcribe / synthesize`：经 MediaService（usage {botId, loopType micro_app}）+ `micro_app_usage` 记 asr_ms（WAV 时长估算）/ tts_chars。
- 预检探针 P1：`ai.chat` → 模型路由可解析；`media.listen` / `media.speak` → ASR / TTS capability 配置（缺配置给 reason + 设置深链）。
- start.ts：`services.microAppAi` 装配 + 关闭时 dispose。

**renderer**
- `micro-app-audio.ts`：`MicroAppAudioSession`（宿主代理采集：sensors.open + 16k worklet + 能量 VAD——语音持续 220ms 起段、静音 silenceMs（默认 700）收段、段长 1.5–15s、过短丢弃；转写经 `microApps.media.transcribe` → `final` 事件；错误 → `error` 事件）与 `MicroAppSpeakQueue`（≤3 段顺序播放、`stopSpeaking` 清队列且未播段以 `MICRO_APP_BRIDGE_CLOSED` 收口、播放期电平只做插话检测——阈值更高防 TTS 回灌、插话即停播 + speech-start）。
- 桥宿主：`ai.*` 转发（方法名 → RPC 映射）、`media.listen` 授权门（会话授权非 granted → `MICRO_APP_CAPABILITY_DENIED`）+ 通道生命周期 + 事件推送、`media.speak/stopSpeaking`、`app.requestDisplayMode`（经外壳 + display-mode 事件）、`app.close`（通知）、`revokeCapability`（停采集 + capability.revoked）、`forwardStreamEvent`（实例过滤）；ready 的 `grants.mic` 改为读取器（跟随授权态）。
- `WidgetRuntime`：微应用路径注入音频面与 ai 转发；`micro-app.stream` 订阅 → 桥事件；麦克风撤销 effect → revokeCapability；`stopAudio()` 导出给外壳停止键；`pinVersion` 续期（P0 二轮）不变。
- `WidgetViewer` header = MicroAppChrome（微应用卡）：**常驻网络徽标**（可联网/不联网，点击展开访问范围）、**麦克风指示 / 会话授权开关**（红 = 使用中；关即撤销）、全屏键（inline 420px ⇄ immersive 铺满，requestDisplayMode 同一落点）、停止键（停采集 + 停播放）、重载 / 关闭不变；每次打开重置麦克风授权（不跨打开保留）。
- i18n：`botWidget.microApp.*` chrome 10 键 + `usage.loop.micro_app` 两语言。

### 与任务书的偏差

1. **ai.session 会话为内存态**（实例生命周期；LRU 64 实例 / 每实例 8 会话）：设计 §8.1「微应用历史归微应用所有，存 storage」——持久化由微应用自己负责（模板 P3 示范 `session:` 前缀快照）。host 侧持久化会引入跨实例一致的复杂度，P1 不做。
2. `media.listen` 的 `partial` 事件 P1 未实现（ASR 适配器是整段转写；设计 §7.2 标注可选）。垫片的 on('partial') 契约在，宿主不派发。
3. 插话检测用「播放期间更高电平阈值」而非独立回声消除（53 号同思路）；全双工仍是 §16 不做。
4. `microApps.media.*` 没有独立 `microApps.media.speak` 的 host 端播放 RPC——播放完全在渲染端（桥宿主 → MicroAppSpeakQueue），core 只做合成 + 记账（与设计 §7.2「TTS 在宿主侧合成与播放」一致，「宿主」= renderer）。

### 测试证据

- core 集成：`packages/core/test/integration/micro-app-ai.test.ts` 7/7（mock-llm：chat 记账归属 / 上下文隔离 / session 多轮 + history + reset / 流式 delta+done 事件拼回全文 / 并发 1 / 微应用每日预算 / dispose 释放并发位 / 未声明能力拒绝）。
- 渲染端：`micro-app-bridge-host.test.ts` 17/17（新增：listen 授权门 + 通道生命周期 + 事件、ai 转发、requestDisplayMode + display-mode 事件、forwardStreamEvent 实例过滤、revokeCapability）；`micro-app-audio.svelte.test.ts` 5/5（顺序播放 / 队列上限（在播+排队）/ 插话停播清队列 / stopSpeaking 未播段收口 / 非播放期不误触）。
- shared：sdk 守卫更新到 P1 白名单（23/23）；垫片执行测试含 close 收口新码。
- 设置链路：settings-catalog / item-writes / adapters-coverage / card-components 全绿（94 用例）。
- 定向回归 74 文件 931 通过 / 1 跳过；`desktop` typecheck 0 错误。

### 遗留

- VAD 收段状态机与采集链路依赖真实 AudioWorklet，无 node 级单测（与 53 号 voice-recorder 同口径：真实麦克风不在单测内）；行为由 S2 预览（P3）与手动验收覆盖。
- 会话恢复（app.pause 时微应用写 storage）是 SDK 约定，模板示范在 P3。

## 第一轮审查与修复（2026-11-04）

独立子代理审查结论 **FIX FIRST**（3 条 P0、9 条 P1、5 条 P2、7 条 P3）。全部 P0/P1 与可低成本修复的 P2/P3 已修复：

1. **（P0-1/F1）ai 面端到端断裂**：宿主 `aiCall` 现在一律加盖自己铸造的 `instanceId`（盖掉 iframe 传值）——之前垫片出参缺 instanceId，所有 `kepcup.ai.*` 都会被 schema 拒。
2. **（P0-2/F2）`media.speak` 不可用**：`speakQueue.setInstance` 在桥建立后接通。
3. **（P0-3/F3）实例键可伪造（并发 / 会话预算分身、跨实例 DoS）**：core 侧 `#bindings`（instanceId → resourceId 首用绑定，之后逐方法核对该对）+ `cancel / dispose / sessionHistory / sessionReset` 全部过 `#contextFor`（能力 + 归属）；集成测试锁「同 instanceId 换 resourceId 拒绝」。
4. **（P1-4/F4）dispose 接错生命周期**：`MicroAppAudioSession.stop` 不再 dispose 实例；实例收口移到 `WidgetRuntime.stop`（关闭即取消在途、释放会话与并发位）。
5. **（P1-5/F5）流前失败悬挂迭代器**：`#startStream` 的 catch 兜底发 `kind:'error'` 事件（预算 / 路由 / 模型解析失败也有终态）；集成测试锁「预算超限的流式调用收到 error 事件且无 delta」。
6. **（P1-6/F6）流取消到不了 core**：桥宿主收到字符串 target 的 `cancel` 帧转发 `microApps.ai.cancel`；垫片 `wireAbort`（AbortSignal → 迭代器 return → cancel 帧）。
7. **（P1-7/F7）监听通道 id 撞车 + 无上限**：单调计数 `#channelSeq`；并发通道上限 4（`WIDGET_RATE_LIMITED`）。
8. **（P1-8/F8）续期后 stale resourceId**：`currentResourceId` 在续期回调更新，ai / 媒体面调用时读取。
9. **（P1-9/F9）bot_id 空的 Bot 级预算**：显式跳过 + 审计告警（口径上 widgets.bot_id NOT NULL）。
10. **（P1-10/F10）麦克风启动失败泄漏**：start 的装配段 try/catch → `#teardown()` 再抛。
11. **（P1-11/F11）ASR 在途丢段**：收段排队（`#pendingSegments`）逐段排空，不再丢弃。
12. **（P2-13/F13）流错误丢 code**：垫片迭代器以带 `.code` 的 Error 拒绝（含在途 waiter）。
13. **（P2-16/F16）取消调用无终态回执**：桥宿主对被取消的 call 回 `MICRO_APP_BRIDGE_CLOSED` 错误帧（§6.3 恰好一条终态）。
14. （P2-14/F14）垫片 `ai.chat` 接受 `signal`（AbortSignal → return() → cancel）；（P2-15）会话方法归属校验并入 F3；（P3）实例驱逐注释改 FIFO、`micro_app_usage` 回放夹具（public-skills-migration 摘表）修复全量。
15. 未修（记录）：ASR/TTS 无限额（P1 设计只要求 token 预算；P2 管理页可视化后一并考虑）；`dispatchLocal` 对未知 subId 的兜底双投递（无害）。

新增测试：垫片↔RPC 接缝（ai.chat 出参过 schema + 宿主盖章；流式 ack→delta→done→error 全链；listen 通道事件派发）、实例归属绑定、流前失败收口。回归 75 文件 933→936 通过 / 1 跳过；typecheck 0 错误。

## 第二轮复审与修复（2026-11-04）

复审结论 FIX FIRST（1 条 P1、2 条 P2、6 条 P3），全部处置：

1. **（P1-1）续期永久毒化归属 + speak/transcribe 打过期资源**：归属改为**按 widgetId 绑定**（`#bindings: instanceId → widgetId`；续期换 resourceId、同微应用不打断，集成测试锁「同卡重开新资源后 chat 照常」）；`MicroAppSpeakQueue` / `MicroAppAudioSession` 的 resourceId 改为**读取器**（调用时取当前值）。
2. **（P2-2）dispose 丢弃 resourceId（归属校验死码）**：绑定层透传 + 归属不符**抛错**（不再静默 no-op）；测试锁「换资源 dispose 拒绝、正确归属成功」。
3. **（P2-3）合成期间打断仍播一整段**：`run()` 合成后核 epoch、`#play` 起播前再核——停止键 / 插话不再漏段。
4. （P3-4）`ai.cancel` / `ai.dispose` 补进 API 索引（capability ai.chat，能力门生效）；（P3-5）用户取消的流错误码改 `MICRO_APP_BRIDGE_CLOSED`（原 BUSY 的 hint 误导）；（P3-7）F16 测试更新为「恰好一条 `MICRO_APP_BRIDGE_CLOSED` 终态回执」。
5. 未修（记录）：单槽插话监听 vs 4 通道（单通道应用不受影响，P3）；麦克风启动失败的错误码细分（P3）；跨微应用「猜 instanceId 抢绑定」经评估不可达（iframe 只能经宿主桥，宿主盖章；渲染层已攻破则整体失守）。

修复后定向回归 74 文件 921 通过 / 1 跳过；全量 `pnpm test` 7650 通过 0 失败（migration 回放夹具修复后）。**P1 收口。**

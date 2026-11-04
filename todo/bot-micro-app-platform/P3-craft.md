# P3 制作流程升级与生态前身

> 设计依据：55 号 §6.1（写作知识分层 / `micro_app_sdk_inspect`）、§11（制作流程升级 / 检查器规则）、§14 P3、§15 验收第 11、12 条。
> 验收：非一线模型经制作流程交付的语音微应用无阻断、可通过 S2 全流程（mock ASR / 模型 / 播报离线整轮）；修改已有微应用能引用最近诊断；基准 13 条（含 3 条语音 / 对话），门槛「无阻断交付 ≥8/10」。

## 任务清单

### 1. craft loop 多文件 + 清单（55 §11）

- [ ] 草稿目录增 `micro-app.json` + 多文件（`assets/` 等）；BUILD/FIX 可写集合扩展；`widget_template` 升级为包骨架模板（语音陪练 / 表单 / 看板三模板，能被清单校验器解析并跑通 S2）。
- [ ] SPEC 阶段必答：能力清单与理由、**联网用途与失败降级**（net=open 保留要写用途）、降级路径、每轮对话成本估算；修改已有微应用时先读最近 24h 诊断进需求。
- [ ] GATE：清单校验（`app.manifest-invalid`）、权限最小性（`app.permission-overbroad`）、SDK 一致性（只调声明能力 `app.permission-undeclared`）、资源路径与体积、`app.fallback-missing`（声明任何宿主能力但无文本回退 → warning，通用化）、`app.cost-estimate-missing`、`app.capability-unavailable`（+ 设置深链）、`app.sdk-deprecated`、`app.net-open-default`。
- [ ] REVIEW 增：儿童内容安全、隐私（录音 / 外传）、成本、无麦克风降级。
- [ ] DELIVER：写清单 + 包 + 用量预算；卡片展示网络范围与能力清单（P0 卡片能力复用）。
- [ ] S2 预览：宿主能力 mock——`ai.chat` 返回脚本化回复（fixtures 或内置脚本）、`media.listen` 注入 fixture 转写、`media.speak` 记录不发声；跑通「一轮完整对话」验收步骤；`net.fetch` 失败归 `preview.offline-network`。

### 2. 写作知识分层 + 自省（55 §6.1）

- [ ] `sdk.md` 入口（≤4KB，信任边界第一段）+ `references/`（每能力 1–3KB：完整契约 / 错误码 / 限额 / 可复制示例）+ `templates/` + `.d.ts`；守卫测试进 CI（大小 / 引用存在 / 模板可解析可预览 / `.d.ts` 重生成无 diff / 检查器引用的 API 名都在 spec）。
- [ ] 制作 loop 工具 `micro_app_sdk_inspect`（按名取契约，≤2KB；未知名返回可用方法列表；结果进 loop 历史不进主对话）。

### 3. 基准

- [ ] 基准需求 13 条（10 存量 + 3 语音 / 对话：口语陪练整轮、打断降级、进度恢复）；门槛「无阻断交付 ≥8/10」；基准 runner 与记录。

### 4. 测试与收口

- [ ] core：craft 多文件状态机、检查器全部新规则、S2 mock、inspect 工具、基准脚本。
- [ ] 收口：定向 + 全量一次；子代理审查一轮。

## 实施记录

（阶段收口时填写。）

## 实施记录（2026-11-05）

### 交付内容

- **craft loop 多文件 + 清单**（55 §11）：`widget_craft` 增 `micro_app` 参数（manifest 持久化 `microApp` 旗标，续做沿用）；草稿目录支持包文件（BUILD/FIX 可写 `micro-app.json` 与安全相对路径文件，单文件 ≤1MB / 包 ≤8MB / 宿主记录与 `references/` 只读）；快照 / 回滚覆盖包全集；`DraftDigest` 增 `bundleSha256`（microAppBundleSha256，回执带包摘要——改资产不改 HTML 也要重过 GATE）；修改已有微应用时 `craftSource` 带回清单原文与包文件原样种草稿；交付走 P2 的 create/update（manifest + files）。
- **SPEC 阶段必答**（55 §11）：微应用草稿的 SPEC 提示增「能力清单与理由 / 联网用途与失败降级 / 降级路径 / 每轮成本估算」；**修改已有微应用先读最近 24h 运行时诊断**（`readDiagnostics` 装配接线，outline 注入「最近 24 小时运行时诊断」段）。
- **GATE 检查器**（55 §11 全部规则）：新文件 `check/micro-app-check.ts`——清单校验（`app.manifest-invalid`）、包路径与体积（`app.bundle-invalid`）、只调声明能力（`app.permission-undeclared`）、权限最小性（`app.permission-overbroad`，storage.kv 例外）、键盘回退（`app.fallback-missing`，声明任何环境能力但页面无 `<input>/<textarea>`）、成本估算（`app.cost-estimate-missing`）、联网用途（`app.net-open-default`，net=open 且 spec 未写用途）、宿主可用性（`app.capability-unavailable`，warning + 原因，探针从装配层注入）；`app.sdk-deprecated` P0 注册 P3 生效。存量组件草稿（无清单）整条路径跳过。
- **S2 能力 mock**（55 §11）：垫片 `call()` 增 `window.__kepcupMockBridge` 缝（正式打开路径永不触发）；`buildMicroAppPreviewMock(fixtures)` 生成单行 mock 桥（fixtures.storage / queries 初值、`ai` 脚本化回复（流式走垫片自己的迭代器管线，mock 用 `options.subId` 定向发帧）、`transcripts` listen fixture、speak 记录到 `window.__kepcupSpoken`、context 记录、未实现方法按 NOT_DECLARED 拒）；`injectMicroAppSdk` 增 `mockScript` 参数；`createWidgetPreviewRunner` 对微应用草稿走 mock 注入（桌面预览外壳**零改动**），相对路径资源加载失败归 `preview.offline-network`（正式运行时包内相对资源可加载）。fixtures schema 增 `ai` / `transcripts`（缺省空，存量零变化）。
- **写作知识分层**（55 §6.1）：`buildMicroAppSdkReferenceBodies()` 生成 6 篇 references（manifest/storage/errors/ai/media/lifecycle，与 spec 同源组装——限额常量、错误 hint 直接引用），宿主在草稿创建时物化到 `references/`（模型只读）；入口 `sdk.md` 由 craft 系统提示直接携带（微应用草稿分支），**发现并修复入口超 4KB**（P2 能力扩容后 4459 字节——压缩到 3650，守卫测试锁住）；`micro_app_sdk_inspect` 工具（SPEC/BUILD/FIX 都可用）：按名取契约 ≤2KB、未知名返回可用方法列表。
- **模板**（55 §11）：`templates/micro-app.ts` 三个包骨架——`micro-voice-tutor`（语音陪练：storage.kv/ai.chat/media.listen/media.speak/context.update，net=none 儿童向收紧，键盘回退，session: 进度恢复）、`micro-form-intake`（表单收集 + reply）、`micro-data-board`（命名查询看板）；每个都带 micro-app.json（+ fixtures / queries），单测锁「能被清单校验器解析且 GATE 全绿」。
- **基准**（55 §14 P3）：briefs.json 10 → **13 条**（+voice-tutor / voice-word-card / voice-story 三条语音对话需求）；基准汇总 JSON 增 `threshold: { minDelivered: 8, total: 13, met }`（无阻断交付 ≥8/10）。

### 测试证据

- `packages/shared/test/unit/micro-app-sdk.test.ts`：references 篇目 / 大小 / 内容引用能力与错误码守卫、inspect 已知/未知名、mock 脚本单行无 `//`（+3）。
- `packages/shared/test/unit/micro-app-shim.test.ts`：**vm 真执行** mock 缝——app.ready 声明能力、ai.chat 脚本化流式（迭代器逐段）、listen transcript final、speak 记录、context.update、未知方法拒绝（+3）。
- `packages/core/test/unit/micro-app-check.test.ts`（8）：存量草稿 null、合法清单零问题、manifest-invalid 短路、undeclared + bundle-invalid（反斜杠路径）、overbroad、fallback-missing（有/无 input）、cost/net（spec 文案触发边界）、capability-unavailable。
- `packages/core/test/integration/micro-app-craft.test.ts`（2）：**微应用整轮 e2e**（SPEC 四要素 → BUILD 包模板 → GATE 警告触发一轮 FIX → REVIEW → 交付：版本行 manifest_json / bundle_sha256 落库、BUILD 工具面带 inspect、knownIssues 无 app.* 错误、任务上下文无 HTML）；inspect 按名/未知名。
- 定向回归：shared+core 11 文件 **144/144**；桌面端 widgets + locales **72/72**；typecheck（shared/core）0 错误。

### 偏差与决策记录

1. **入口超限的发现**：`buildMicroAppSdkMd` 在 P2 能力扩容后已超 4KB，但 P0/P2 无消费方未暴露——P3 首次在 craft 提示真实使用时被字节守卫拦下。压缩了信任边界段与能力行（limits 移入 references），「每条 API 一行签名」保留。属「运行时按需计算」策略的预期收益：漂移在构造上不可能。
2. **S2 mock 的流式实现**：mock 不自建迭代器，复用垫片的 streamIterable 管线（`options.subId` 定向发帧）——API 语义单一来源仍是垫片，mock 只实现宿主侧路由。
3. **S2 的相对资源**：预览只给入口 HTML；包内相对资源加载失败归 offline-network（warning，非缺陷）。css/js 内联未做（模板不需要；记 P4 若做市场评估再考虑）。
4. **审查 findings 的 digest 键**未带包摘要（report 只认 html/queries）：纯资产改动不重触发审查——审查看语义，GATE 才管字节；记为已知取舍。
5. 基准 13 条是**真实模型评测脚本**（默认跳过，KEPCUP_BENCH_* 环境变量触发）；门槛「≥8/10」记录在汇总 JSON 的 `threshold.met`，不在 CI 断言（与 D87 基准同做法）。

## 审查记录（2026-11-05，独立子代理一轮 → FIX FIRST → 全部处置）

**发现与处置**（P0×1 / P1×2 / P2×8 / P3×6，审查 diff bb067781..15860350）：

- **P0-1 多文件 craft 被自家 S0 规则阻断（修）**：`isBrokenUrl` 把一切相对路径判死，入口引用 `assets/app.js` 得两条阻断错误。修：`staticCheck` 增 `bundlePaths` 输入（HTML 属性 / CSS @import / url() / 动态 import / setAttribute / export-from 全部走 `brokenResourceUrl`——命中包内文件放行，包内不存在仍报错且文案改为「包里没有这个文件」）；run-check 传入包路径清单；守卫测试锁三模板 + 相对资源写法。
- **P1-2 修改流程写坏二进制资产（修）**：base64→binary→utf8 字符串→utf8 文件把 PNG/woff2 换成 U+FFFD。修：`WidgetDraft.writeBytes`（按原字节写），种子路径改用它。
- **P1-3 预览 mock 的 fixtures 逃逸 `<script>`（修）**：嵌入 JSON 未转义 `<`。修：`\u003c` / `\u2028` / `\u2029` 全量转义；守卫测试加 `</script><script>alert(1)</script>` 用例。
- **P2-4 回执不绑定资产字节（修）**：`DraftDigest` / 回执增 `filesSha256`（排序 path:sha256 整体摘要），GATE 回执与交付关卡同口径比对——改资产不改 HTML 也要重过 GATE（台账原申报落地）。
- **P2-5 正式垫片带 mock 缝 + mock 宽于真实宿主（修）**：垫片缝用 `/*KC-MOCK-SEAM*/` 标记包住，`buildMicroAppShim(theme, {preview})` 生产版剥掉（守卫测试：生产垫片不含 `__kepcupMockBridge`）；mock 与正式宿主同闸——已实现方法按声明能力拒绝（桥方法→能力映射嵌入 mock）、storage.set 配额 / 键数、context.update 形状（headline ≤80 / data ≤1KB），错误码同源。
- **P2-6 preview offline 兜底吞真缺陷（修）**：`net::ERR` 豁免收紧到「message 里出现包内真实存在的路径」；包里没有的路径照常报缺陷。
- **P2-7 references/manifest.md 字段名与 schema 漂移（修）**：改为 `display: { mode: … }` 并明示「不是 displayMode」；collections 限额改从常量组装；守卫测试断言清单字段条目无 `displayMode`。
- **P2-8 `app.sdk-deprecated` 无发射点（修）**：`microAppDraftIssues` 对 spec 标记 deprecated 的方法（签名前缀文本扫描）发射 warning；当前 spec 无 deprecated 方法，规则潜伏待用。
- **P2-9 spec.md 缺失时成本/联网检查静默跳过（修）**：spec 为 null 也发对应 warning（文案区分「没有 spec.md」与「没写」）——四要素不再免检。
- **P2-10 基准语音条目未走微应用路径 + 门槛稀释（修）**：briefs 3 条语音需求加 `microApp: true`，runner 透传 `micro_app`；门槛改比率（`delivered/runs ≥ 0.8`）并单列 voiceDelivered/voiceTotal。
- **P2-11 两个模板零测试（修）**：新增 `micro-app-templates.test.ts`——三模板逐一 validateMicroAppManifest + runWidgetCheck 断言零 error、非 blocked。
- **P3 顺手修**：mkdir 排除宿主目录（reports/snapshots/references 空目录也不可建）；修改非微应用组件传 `micro_app:true` 直接拒绝。
- **P3 记录不修**（备忘）：提示词矛盾（legacy「相对路径不存在」与微应用「用相对路径」并存——P0-1 修复后已按草稿类型分流语义，提示分流留待提示瘦身时做）；restore 不复活快照里有而当前被删的文件（模型无删除能力，不可达）；mock collections.get 错误码 NOT_FOUND 与真实桥命名差异；mock listen 重放同一转写序列（脚本化语义，验收多条轮需备足 fixtures）。

**测试证据**：审查者跑过的 12 文件口径 + 新模板测试 = **167/167 通过**（shared sdk 19 / shim 14 / templates 3 / check 8 / craft e2e 2 / legacy craft 2 / widgets-service 51 / widget-tools 10 / micro-app-service 16 / ai 10 / p2 11 / 桥宿主 21）；shared/core typecheck 0 错误。

## 收口：§15 十七条验收核对（2026-11-05）

| # | 验收 | 证据 |
|---|---|---|
| 1 | 任务上下文只收回执不见代码 | `micro-app-craft.test.ts`（任务步骤无 `<!DOCTYPE\|<script`）+ `widget-craft.test.ts`（回执 ≤1500 字） |
| 2 | 卡片：名/版本/能力清单/网络范围/预计成本/计费 Bot | `BotWidgetCard.svelte` 网络行最前 + `botWidget.microApp.cost`（计费 Bot 名）+ 能力清单（预检生效版本口径）；`micro-app-consent.svelte.test.ts` |
| 3 | 首次确认；扩权重确认；只改代码标「代码已更新」 | 能力面指纹门控（`micro-app-gate.ts` + `micro-appEffectiveConsentOk` 双闸）+ `micro-app-consent.svelte.test.ts` / `micro-app-gate.svelte.test.ts` |
| 4 | 打开即英语问候（TTS） | `micro-app-shim.test.ts`（speak 协议）+ 语音陪练模板（init 即 ask→speak）；实机手动步骤：打开模板微应用 |
| 5 | 说话→转写→回复→播报整轮 | `micro-app-audio.svelte.test.ts`（采集→分段→pending 队列）+ `micro-app-ai.test.ts`（网关）+ mock vm 整轮（`micro-app-shim.test.ts` P3 组） |
| 6 | 插话立即停止播报 | `micro-app-audio.svelte.test.ts`（epoch 打断，合成期不漏段）+ `MicroAppSpeakQueue.stopSpeaking` |
| 7 | 关闭再打开继续进度 | `session:` 约定（references/lifecycle.md + 语音陪练模板 init 读回）；storage 持久化（P0 起即有） |
| 8 | 拒麦克风切键盘 | `app.fallback-missing` 检查（`micro-app-check.test.ts`）+ 模板 input 回退 + 桥宿主 CAPABILITY_DENIED（`micro-app-bridge-host.test.ts`） |
| 9 | 用量展示 + 计费 Bot 累计 | `micro_app_usage`（0068）+ 管理页用量段（`microApps.list` usage）+ `micro-app-p2.test.ts` 管理入口 |
| 10 | 断网/模型失败可读错误 + 进度保留 | `MICRO_APP_AI_UNAVAILABLE` / `BRIDGE_CLOSED`（errors.ts + `MICRO_APP_ERROR_HINTS`，shim 测试 code+hint） |
| 11 | S2 离线跑通一整轮（mock ASR/模型/播报） | mock 缝 vm 真执行（sdk/shim 测试）+ 预览 mock 注入（`preview.ts` 微应用分支）+ craft e2e |
| 12 | 检查器无阻断项；自检状态如实上卡 | `micro-app-templates.test.ts`（三模板 GATE 全绿）+ unverified/passed 交付口径（`widget-craft.test.ts`） |
| 13 | ≤300 字诊断 + 当天不重复 + 管理页次数 | `micro-app-p2.test.ts` 诊断组 + P2 审查修复（0070 持久去重 + 每日 5 条上限） |
| 14 | 诊断表无内容列 | `micro-app-p2.test.ts` pragma 断言（无 message 列） |
| 15 | 缺配置打开前标「当前不可用」+ 深链 | preflight 探针（ai.chat / media.*，`micro-apps-bindings.ts`）+ 卡片预检失败重试 |
| 16 | 网络范围最前 + 常驻徽标 + open 明示 | `BotWidgetCard.svelte` 网络行 + `WidgetViewer.svelte` MicroAppChrome 徽标 + netOpen 文案「未限制域名」 |
| 17 | context.update 下一轮可见/无气泡/可清除/自由文本拒 | `micro-app-p2.test.ts` context 组 + meta 属性注入（conversation.ts）+ clearContext |


# P0 契约与骨架（存量行为不变）

> 设计依据：55 号 §3（架构与运行档位）、§4（包与清单）、§5（能力与权限）、§6（SDK 与桥协议 v2）、§9.1（版本双指针）、§14 P0、§15 验收第 3/15/16 条相关部分。
> 硬验收：**存量组件「无清单」路径行为零变化**（既有 widgets 相关测试原样全绿即证据）；带 `storage.kv` 清单的微应用能打开；未声明能力调用被拒；确认卡显示能力与当前可用性；只改代码不扩大能力面时不出新卡（仅对带清单微应用）。

## 任务清单

### 1. shared：SDK spec 单一事实来源（55 §6.1）

- [ ] `packages/shared/src/micro-app-sdk/spec.ts`：
  - `MICRO_APP_SPEC_VERSION = 'kepcup-micro-app/1'`；
  - 能力闭合枚举 `MICRO_APP_CAPABILITIES`：每项 `{ id, title, summary, grant, limits, phase, mcpApps? }`，覆盖 55 §5.1 全表（`storage.kv`、`storage.collection`(P2)、`ai.chat`、`media.listen`、`media.speak`、`host.reply`、`host.openLink`、`context.update`(P2)、`files.pick`(P3)、`notify`(P3)；`net.fetch` 不进枚举、由 `net.mode` 表达）；每项带确认卡人话文案；
  - API 方法索引 `MICRO_APP_API`（方法名、能力归属、签名描述、参数 / 返回 shape 描述、deprecated?）——垫片 / d.ts / sdk.md / 检查器 / mock / `micro_app_sdk_inspect` 全部从它生成；
  - 错误契约 `MICRO_APP_ERROR_HINTS`：`MICRO_APP_*` 错误码 → 作者向 `hint`（点名哪次调用 / 期望什么 / 下一步改什么）；
  - MCP Apps 机械映射表（55 §6.3：`openLink ↔ ui/open-link` 等）；
  - 限额常量（会话 token 上限夹取 50k、事件订阅 32、`net` 档位枚举等）。
- [ ] `packages/shared/src/micro-app-sdk/generate.ts`：`buildMicroAppShim()`（单行、指纹 `kepcup-micro-app-sdk-v1`、实现桥 v2 客户端 + `kepcup.app/storage/query/reply/openLink/ui` P0 面 + `app.ready()`）、`buildMicroAppSdkMd()`（入口 ≤4KB：信任边界第一段 + 能力清单 + 每条 API 一行签名 + 最常见 3 个错误 + references 指针）、`buildMicroAppDts()`、`microAppPreviewMockSpec()`（P0 骨架，P1/P3 扩充）。
- [ ] 守卫测试 `packages/shared/test/unit/micro-app-sdk.test.ts`：sdk.md ≤4KB 且引用的 references/ 模板名在 API 索引里存在；shim 单行、不含 `//` 注释；映射表两侧一致；API 索引里每个方法的能力 id 都在闭合枚举里；错误 hint 都指向注册过的 `MICRO_APP_*` 码；能力枚举与清单 schema 的 enum 一致。

### 2. shared：清单与 RPC 契约（55 §4.2）

- [ ] `packages/shared/src/domain/micro-app.ts`：
  - `microAppManifestSchema`（strict）：`spec`（未知拒绝）、`slug`、`name`、`description`、`entry`（P0 必须存在且 html）、`display?`、`permissions[]`（闭合枚举，未知拒绝）、`ai?{profile?, maxTokensPerSession?}`、`net?{mode: open|allowlist|none, allowlist?[]}`（缺省 `open`）、`queries?`；
  - 常量：`MICRO_APP_BUNDLE_MAX_BYTES`（8MB）、`MICRO_APP_BUNDLE_FILES_MAX`（64）、`MICRO_APP_NAME_MAX_CHARS` 等；
  - `microAppCapabilityFingerprint(manifest)`：纯函数，canonical = 排序后的 permissions + net.mode + 排序后 allowlist（用于确认记忆，无 crypto）；
  - 卡片字段：`widgetCardSchema` 增可选 `manifestSummary?`（name/slug/permissions/net/ai/maxTokensPerSession）、`capabilityFingerprint?`、`bundleSha256?`、`latestVersion?`（zod default 兼容旧卡）；
  - RPC：`microApps.preflight {messageId}` → `{ items: [{capability, available, reason?, settingDeepLink?}] }`（登记 methods.ts 两处 + events 如需）。
- [ ] `errors.ts` 追加：`MICRO_APP_MANIFEST_INVALID`、`MICRO_APP_CAPABILITY_DENIED`、`MICRO_APP_CAPABILITY_NOT_DECLARED`、`MICRO_APP_CAPABILITY_NOT_CONFIGURED`、`MICRO_APP_UNSUPPORTED_SPEC`（+ i18n `chats.errorCode.*` 两语言）；注意与既有 `WIDGET_*` 并存。

### 3. core：清单校验、bundle 摘要与版本双指针（55 §4.3 / §9.1）

- [ ] 迁移 `0067_micro_app_manifest.sql`：`widget_versions` += `manifest_json TEXT NOT NULL DEFAULT ''`、`bundle_sha256 TEXT NOT NULL DEFAULT ''`、`permissions_json TEXT NOT NULL DEFAULT '[]'`；`widgets` += `next_version INTEGER`（NULL = 跟随卡片钉住版本）。
- [ ] `packages/core/src/micro-apps/manifest.ts`：校验（zod + 闭合枚举 + 当前运行时已实现能力集（P0：`storage.kv` / `host.reply` / `host.openLink`）之外的声明 → `MICRO_APP_MANIFEST_INVALID` 带定位）；bundle 规范化摘要（清单 canonical JSON + entry + 文件按路径排序）sha256 在 core 计算。
- [ ] `WidgetService.create/update` 增可选 `manifest` 入参（制作 loop 交付路径；P0 测试直接调服务）：落三列 + 卡片字段；**微应用**更新时置 `widgets.next_version = 新版本`；存量路径（无 manifest）不写这些列、不动 next_version（零变化）。
- [ ] `open`：微应用卡按 `next_version ?? 卡片钉住版本` 解析生效版本（版本行被修剪 → 既有「版本不存在」路径）；回传 manifest 摘要与指纹；`#pinnedVersion` 完整性检查对微应用改为「生效版本行的 html sha256 与该行记录一致 + manifest 来自同一行」。
- [ ] `microApps.preflight` RPC（`packages/core/src/rpc/micro-apps-bindings.ts`）：按生效版本清单逐能力检查当前宿主可用性：`ai.chat` → Bot 模型 / 微应用模型设置是否解析得到模型；`media.listen` → ASR capability 是否配置；`media.speak` → TTS 是否配置；返回设置深链（`settings` + 对应 anchor）。

### 4. 渲染端：桥 v2 宿主 + 确认卡升级（55 §5.2 / §6.3）

- [ ] `widget-bridge-v2.ts`（guard，纯函数）：帧 `{k: call|stream|cancel|ack|error|event|event-ack|close, …}` 校验、方法白名单（P0：`app.ready`、`app.setTitle`、`storage.*`、`query`、`openLink`、`reply`、`theme.get`、`setHeight`）、尺寸上限、事件订阅 ≤32。
- [ ] `micro-app-bridge-host.ts`：来源校验（`event.source === iframe.contentWindow`）；按版本 `permissions` 路由（未声明 → `MICRO_APP_CAPABILITY_NOT_DECLARED`，记审计位）；`app.ready` 返回 `{capabilities, grants{mic,net}, theme, displayMode, viewport, instanceId}`；主题经 `event` 帧推送；背压：`subId` seq 连续性，缺口即 `close` 帧通知重连。
- [ ] `WidgetRuntime.svelte` 分流：`card.manifestSummary` 存在 → micro-app 路径（新垫片由 core 注入 + 新桥宿主），否则原路径**逐字节不变**。
- [ ] `consent.svelte.ts`：微应用按 `widgetId` 记 `{fingerprint, bundleSha256, at}`（新 localStorage key `kepcup.microApp.consents.v1`，有界）；指纹相同代码更新 → 沿用确认，卡上标「代码已更新，权限未扩大」；能力面扩大 → 重新确认。存量组件逻辑零变化。
- [ ] `BotWidgetCard.svelte`：微应用确认卡 = 网络行（最前、单独一行、按档位措辞：`可联网（未限制域名）` / `可联网（仅 …）` / `不联网`）+ 能力清单（spec 人话）+ 预计成本行（`ai.maxTokensPerSession` + 计费 Bot 名）+ 预检结果（不可用项标「当前不可用」+ 设置深链，打开前可见）+ [查看代码] [打开]；`有新版本，重新打开生效` 徽标（`card.version < card.latestVersion`）。
- [ ] i18n：`botWidget.microApp.*` 与 `chats.errorCode.MICRO_APP_*` 两语言、键序一致。

### 5. 检查器与错误契约骨架（55 §11 / §6.2）

- [ ] `check/rules.ts` 注册：`app.manifest-invalid`（error，草稿带 `micro-app.json` 时校验）、`app.net-open-default`（warning，`net.mode=open` 且 spec.md 未写联网用途）、`app.permission-undeclared`（error，代码调用不在清单里的能力）、`app.sdk-deprecated`（warning）；P0 实现前两条 + 后两条的规则骨架（craft 多文件在 P3，P0 只在草稿含 manifest 时生效）。
- [ ] 检查 issue 的 `hint` 与运行时 `error.hint` 同源于 `MICRO_APP_ERROR_HINTS` / spec 文案。

### 6. 测试与收口

- [ ] shared：spec 守卫 + 清单 schema + 指纹函数（扩大 / 收紧 / 域名变化各案例）。
- [ ] core：manifest 校验（未知能力 / spec 未知 / net 缺省 open / allowlist 缺域名）；create/update 落列与卡片字段；next_version 指针；open 生效版本解析；preflight（缺 ASR / 缺模型 → 不可用 + 深链）；**存量组件全流程回归 = 既有 widgets-service / craft / bridge 测试不动且全绿**。
- [ ] 渲染端：v2 guard/host 协议测试（来源校验、恰好一条终态回执、stream/event/cancel、订阅上限、seq 缺口断开）、consent 指纹测试（沿用 / 重新确认 / 旧路径不变）。
- [ ] 收口：`pnpm --filter @kepcup/shared build` → 定向测试全绿 → 全量 `pnpm test` 一次。
- [ ] 子代理审查（general-purpose，输入 = P0 diff + 55 §3–§6/§9.1/§14 P0 + 本验收清单）→ 修完全部问题 → 第二轮复审。

## 实施记录（2026-11-04）

### 交付内容

**shared**
- `micro-app-sdk/spec.ts`（单一事实来源）：`MICRO_APP_SPEC_VERSION`、能力闭合枚举（10 项，`net.fetch` 不进枚举）、API 方法索引（30 条）、错误码 → 作者向 hint（8 条，code 注册进 `ERROR_CODES`）、MCP Apps 映射表、限额常量、`MICRO_APP_RUNTIME_PHASE` / `MICRO_APP_IMPLEMENTED_CAPABILITIES`（阶段开关）。
- `micro-app-sdk/generate.ts`：`buildMicroAppShim()`（桥 v2 客户端垫片：call/stream/cancel/event-ack、AsyncIterable 流原语、seq 缺口检测、单行、无 `//`）、`buildMicroAppSdkMd()`（≤4KB 入口，信任边界第一段）、`buildMicroAppDts()`、`microAppPreviewMockSpec()`、`microAppImplementedApiMethods()`（白名单派生）。**运行时按需生成，不落盘**——生成物与 spec 的漂移在构造上不可能（比「重新生成无 diff」守卫更强），守卫测试锁约束（见下）。
- `domain/micro-app.ts`：`microAppManifestSchema`（strict、闭合枚举、net 缺省 open）、`microAppCapabilityFingerprint()`、卡片摘要 schema、确认记录类型、`microApps.preflight` RPC 契约。
- `widgets-ui.ts`：卡片 + open 输出增可选 `microApp` / `capabilityFingerprint` / `bundleSha256`（zod default 兼容旧卡）；查询模板 schema 抽到 `widget-query.ts`（打断 `widgets-ui ↔ micro-app` 导入环，原符号再导出，存量导入不动）。
- `apps-ui.ts`：`buildWidgetRuntimeCspHeader({connectDomains})` 可选参数（缺省不变；`none` / 域名数组收紧 connect-src）。
- `errors.ts` + `rpc/methods.ts`：8 个 `MICRO_APP_*` 错误码 + `microApps.preflight`（rpcMethodSchemas + APP_METHODS 双登记）。

**core**
- 迁移 `0067_micro_app_manifest.sql`：`widget_versions` += `manifest_json` / `bundle_sha256` / `permissions_json`；`widgets` += `next_version`。
- `micro-apps/manifest.ts`：宿主独占校验（spec 版本、已实现能力裁决、allowlist 域名形状、entry=index.html）、bundle canonical 摘要、`microAppCspFor()`。
- `micro-apps/preflight.ts` + `rpc/micro-apps-bindings.ts`：探针注册表 + `microApps.preflight`（P0 能力恒可用，P1 接模型 / ASR / TTS 探针）。
- `WidgetService`：create/update 接受 `manifest`（清单是能力与查询的唯一来源）；微应用更新置 `next_version`；**形态切换（存量 ↔ 微应用）拒绝**；`#resolveEffectiveVersion`（存量 = 卡片钉住 + 原完整性校验；微应用 = 双指针，查询防偷换校验保留）；open/source 按生效版本；微应用注入桥 v2 垫片 + 按 net 档位 CSP；craftSource 带回清单；`effectiveMicroAppOf()`；移交复制带三新列。
- `sdk-injection.ts`：`injectMicroAppSdk()`（共用主题 / 滚动条 / kit，垫片换 `buildMicroAppShim`；注入逻辑抽 `buildInjection` / `injectAfterHead`，存量路径输出逐字节不变）。
- 检查器：注册 `app.manifest-invalid` / `app.net-open-default` / `app.permission-undeclared` / `app.sdk-deprecated`（P0 注册 + 提示词同源；草稿带 `micro-app.json` 的扫描随 P3 多文件制作接线）。

**renderer**
- `micro-app-bridge-guard.ts` + `micro-app-bridge-host.ts`：桥 v2（来源校验、方法白名单、**能力路由**——未声明 → `MICRO_APP_CAPABILITY_NOT_DECLARED` + spec 同源 hint、`app.ready` 协商、事件 seq/ack、背压超窗断开、cancel、恰好一条终态回执）。
- `micro-app-consent.svelte.ts`：按 widgetId 记 `{fingerprint, bundleSha256, at}`；同指纹 bundle 变 → `codeUpdated`。
- `BotWidgetCard.svelte`：微应用确认卡（网络行单独一行最前、能力清单（spec 人话）、成本行、预检不可用项 + 设置深链、「有新版本」/「代码已更新」徽标）；存量组件卡路径零变化。
- `WidgetRuntime.svelte`：open 输出带清单 → 挂 `MicroAppBridgeHost`，否则原 `WidgetBridgeHost`；open 后对**生效版本指纹**再核一次（卡片门控可能过期，能力扩大兜底拒绝）。
- i18n：`botWidget.microApp.*` 13 键 + `chats.errorCode.MICRO_APP_*` 8 条，两语言键序一致（locales.test 通过）。

### 与任务书的偏差（均为「按长期收益最大化」的拍板）

1. **生成物不落盘**：设计 §6.1 的「`.d.ts` 重新生成后无 diff」守卫以运行时生成替代；`references/` 以索引（`MICRO_APP_SDK_REFERENCES`）登记、P0 只生成 P0 篇目引用，P3 写文件内容并接 craft `read`。
2. **`latestVersion` 不进卡片描述符**：卡片「有新版本」徽标改用 preflight 返回的生效版本（卡片字段会过期，preflight 是活的）。
3. **清单 queries 内联**：设计 §4.2 的 `"queries": "queries.json"` 文件引用在 P0 以内联数组承载（多文件包 P2 落地时可平滑接受两种形状）。
4. **形态切换拒绝**：任务书未写，实施中补（两张确认卡之间无法比较能力面）。
5. 检查器四规则 P0 注册 + 提示同源，扫描引擎随 P3 接线（P0 制作 loop 仍是单文件，规则不命中）。

### 测试证据

- shared：`packages/shared/test/unit/micro-app-sdk.test.ts` 15/15（sdk.md ≤4KB、引用存在、垫片单行无 `//` 无 resourceId、白名单随阶段、枚举 / 映射 / hint 同源、指纹不变式、strict 清单）。
- core：`packages/core/test/unit/micro-app-service.test.ts` 13/13（清单裁决、卡片字段、双指针 / 回退 / 修剪、垫片与 CSP 分档、open 输出、预检、形态切换、存量零变化）。
- renderer：`micro-app-bridge-host.test.ts` 12/12 + `micro-app-consent.svelte.test.ts` 5/5。
- **存量零变化**：widget 相关全量定向（shared/test + core widget 全家 + 渲染端 widgets + locales）69 文件 899 通过 / 1 跳过（既有跳过项）。
- `pnpm --filter @kepcup/{shared,core} build`、`@kepcup/desktop typecheck` 全过（svelte-check 仅余 1 条与本次无关的既有警告）。

### 遗留

- `app.*` 事件通道的动态订阅上限（32）在协议常量与 host 结构上就位，媒体订阅 P1 接线。
- `microApps.preflight` 的 P0 探针全为恒可用；P1 注册 ai/media 探针后才有「当前不可用」分支的真实数据。

## 第一轮审查与修复（2026-11-04）

独立子代理审查（输入 = P0 diff + 55 §3–§6/§9.1/§11/§13.2/§14 P0 + 验收清单）结论 SHIP，产出 5 条 P1、7 条 P2、11 条 P3。全部 P1/P2 与可低成本修复的 P3 已修复并补测试：

1. **publish 丢微应用字段（P1）**：发卡改带 `microAppCardFields`（bundle 以版本行为准），补回归测试（降级双运行时 = 设计红线）。
2. **垫片 `app.on('theme')` 不派发（P1）**：theme 分支补 `dispatchLocal`；新增 vm 真实执行测试（垫片 ↔ host 帧互演：ready/ack/error+hint/theme/订阅上限/close/setTitle/reply 无手势）。
3. **确认卡展示发卡时摘要而非生效摘要（P1）**：`microApps.preflight` 输出增 `microApp` 生效摘要，卡片能力 / 网络 / 成本一律以预检为准。
4. **续期可能换掉在跑实例（P1）**：`widgets.ui.open` 增 `pinVersion`（微应用续期钉住运行中版本；存量忽略），WidgetRuntime 续期传入。
5. **门控测试缺口（P1）**：抽 `micro-app-gate.ts` 纯判定（pre-open fail-closed + open 后生效指纹复核）+ 测试。
6. confirmAndOpen 存生效 bundle（P2/F6）；检查器 hint 从 spec 枚举派生（F7）；订阅上限在垫片强制（F8）；预检失败显式重试态且门控不放行（F9）；移交复制带 `next_version`（F10）；close 帧改 `MICRO_APP_BRIDGE_CLOSED`（新码 + hint + i18n，F11）；成本行显示 Bot 名（通讯录回退 botId，F12）；预审报错文案按形态分文案恢复存量原句（F13）；sdk.md 按字节校验（F14）；清单嵌套对象 strict（F15）；`netNone` 用 WifiOff 图标（F19）；`event-ack seq=0` 接受（F18）；poster 随生效版本（F21）；交付拒绝内嵌 v1 垫片的入口 HTML（F17）。
7. 未修（记录在案）：settingDeepLink.section 的类型收敛（P1 探针产出常量时一并做）；版本偏移下旧渲染器开新卡（Electron 原子更新语义内可接受）。

修复后定向回归 71 文件 912 通过 / 1 跳过；`shared`/`core` build 与 `desktop` typecheck 全过。

## 第二轮复审与修复（2026-11-04）

复审结论 FIX FIRST，1 条 P1 + 1 条 P2 + 5 条 P3，全部处置：

1. **（P1）pre-open 门控比对卡片冻结指纹与「确认记生效指纹」矛盾 → 扩权更新后旧卡死胡同**：`microAppOpenAllowed` 改为「存在该微应用的确认记录即放行到 open」（`recordOf`），能力面执法保留在 open 后的 `microAppEffectiveConsentOk`（生效指纹复核不变）——扩权旧卡：卡片确认 → 记新指纹 → open → 复核通过；未确认面 → open 后拒绝回确认流程，自愈闭环。测试更新锁新语义。
2. **（P2）查询预审门控跟卡片冻结的 queriesCount，与 open 按生效版本强制预审不一致 → 加查询的更新后旧卡死锁**：`microApps.preflight` 输出增 `queriesNeedReview` / `queriesCount`（生效版本），卡片 `needsReview` / 查询提示全部改用预检值。
3. （P3）F17 内嵌垫片拒绝补测试；`event-ack seq=0` 用例；移交复制注释补微应用确认语义（副本新 id 需重新确认，安全侧）。
4. （P3，不修）`widgetQueryDefSchema` 保持**非 strict**：`widget-check-run.test.ts` 锁住了「多余键静默剥离」的规范化语义（canonical {name, sql}），与清单 strict 有意不同——在 `widget-query.ts` 注释说明。
5. （P3，记录）微应用卡门控硬依赖 `microApps.preflight` RPC：新渲染器 + 旧 core 会锁死微应用卡；Electron 原子更新语义内不可达，与「版本偏移」备忘同口径。

修复后定向回归 71 文件 913 通过 / 1 跳过；全量 `pnpm test` 已在收口跑过一次（7613 通过 + 1 个与本阶段无关的 `permission-bridge` 超时抖动，单跑 29/29 通过复核）。**P0 收口。**


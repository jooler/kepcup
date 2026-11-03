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

## 实施记录

（阶段收口时填写：做了什么、偏差、测试证据。）

# 34 KepCup 供应商（云端大模型 / 检索中转）

用户打开应用后**登录一次**，即可让对话模型、能力模型与联网检索走 KepCup 自建的上游中转，无需自己去各家控制台申请 API Key。高级用户可打开「高级配置」，混用自家凭据与 KepCup 供应商。本文规定桌面端接入契约、供应商服务端（独立仓库）的产品与架构边界，以及面向中国大陆公众提供生成式 AI 服务的合规设计。

决策编号 **D83**。**状态：已定稿，待实施。** 服务端独立仓库（暂名 `kepcup-supplier`），境内云独立部署（Node / NestJS + PostgreSQL，见 §6）；本文是桌面与服务端的共同规格。

相关：D11 / D07（本地优先，本决策引入**可选**云账号）、D25（敏感数据加密）、D45 / D14（模型配置与用量账本）、D16（能力模型）、D58 / D18（对话内设置引导与 onboarding）、D62 / D21（联网检索）、D70（管家 onboarding）、D72（外部智能体订阅）、D73 / D29（系统浏览器 + loopback 授权范式）、D74（`kepcup.com` Cloudflare 基座，见 §1.3）、D85 / [36](36-wiki-multimodal-ingest.md)（Wiki 派生会消耗能力模型额度）。

## 决策

- **D83 KepCup 供应商**：
  1. **零配置主路径**：「登录 KepCup」→ 系统浏览器完成手机号注册 / 登录（微信扫码须绑定手机号）并授权本机 → loopback 换设备凭证 → 进入**托管模式**：对话、能力模型与联网检索按服务端目录默认值走供应商；设置页的 DIY 模型类分区在托管模式下收起。
  2. **托管是叠加层，不改写用户配置**：托管模式下由解析层读取 `settings.supplier.catalog` 的默认值；用户的 `defaultMainModel` / `capabilityModels` / `webSearch` / `embedding` **原样保留、不被写入 `kepcup`**。退出登录或打开高级配置后，用户原有配置立即恢复生效。
  3. **高级配置**：`settings.supplier.advanced`。关 = 托管模式（已登录时）；开 = 用户自己的配置生效，且对话厂商与能力 provider 下拉中多出 **KepCup**，可混用。
  4. **首次启动三选一**：登录 KepCup / 自行填写模型配置 / **我有订阅（D72，保留）**。供应商只是多一个模型供应商，不取代 ACP 外部智能体。
  5. **客户端永不持有上游 Key**：上游 Key、计价、轮替只在服务端；桌面只存 `supplier:access` / `supplier:refresh`。
  6. **首期能力全集**：DIY 能配的对话、七种能力与检索，供应商 P0 全部提供（§2.1）。
  7. **目录即契约**：每个逻辑模型 id 声明上下文窗口、最大输出、输入模态、工具调用等契约；服务端只把它路由到满足契约的上游。**向量模型的逻辑 id 永久绑定一个具体模型与维度**，换模型 = 发新 id，客户端随之重建向量。
  8. **计费可靠性 P0**：统一信用金额度池；每次调用**预占后结算**；非流式调用带 `Idempotency-Key`（P0）；流式中断按实际用量结算；连通性探测免费。
  9. **商业化**：三档 ¥69 / ¥199 / ¥599 每月 = 写入该档信用金；每种模型与检索在管理端单独定价；超额须升级订阅（不可按量加购）；支付 Jeepay；只按未使用额度比例退款；不支持降档。
  10. **合规优先于「只转发」**：服务面向中国大陆公众，按《网络安全法》《个人信息保护法》《生成式人工智能服务管理暂行办法》《人工智能生成合成内容标识办法》等要求设计（§7）：只接入已完成备案的上游模型；手机号实名；输入输出内容安全审核；生成内容标识；网络日志留存不少于六个月；**正文默认不持久化**，仅审核命中的样本与处置记录依法留存；正文一律不用于训练。公开上线以合规门禁全部满足为前提。
  11. **供应商与本地功能完全解耦**：不购买、未登录或供应商不可用，均不影响任何本地功能。连接应用的 OAuth（CIMD、目录等）仍由 D74 的 Cloudflare 基座承担，与供应商无关。
  12. **服务端栈**：Node + NestJS + PostgreSQL，部署于**境内云**（ICP 与数据境内存储要求），使用 `kepcup.com` 的子域名；与 Cloudflare 栈分离。

## 1 产品目的与边界

### 1.1 要解决什么

| 痛点 | 做法 |
|---|---|
| 新用户不知道去哪申请 Key、填哪个 baseUrl | 登录即用，默认模型与检索由目录下发 |
| 国内多厂商、峰谷价、单账号限频 | 服务端统一计价与多凭据轮替，客户端无感 |
| 想降低门槛又不丢掉 DIY | 托管叠加层 + 高级配置混用；退出即回到原配置 |
| 需要可持续运营 | 订阅档位 + Jeepay + 用量可见 |

### 1.2 明确不做（本期）

- 设备凭证跨设备同步（每台设备单独授权；账号可多设备，见 §4.3）。
- 再套一层第三方聚合中转（供应商即自有中转）。
- 供应商侧持有用户的 Google / Notion 等连接应用令牌（仍属 D73 本地优先）。
- 完整企业财务（发票 / 对公合同）；本期订阅收据级。
- 海外支付与海外模型：目录只含已备案的境内模型；境外模型只能由用户在高级配置里用**自己的** Key 接入（不属于本服务）。
- 把供应商网关作为任意 OpenAI 兼容代理对第三方转售。
- 套餐降档；超额按量加购。
- 中转 `web_fetch`（本机直连 + SSRF 防护，见 §5.5）。

### 1.3 与既有「云」设计的关系

| 文档 / 设施 | 关系 |
|---|---|
| D74 / 29 §15 Cloudflare | 承担连接应用的 OAuth 基座（CIMD `https://kepcup.com/oauth/client.json`、目录、将来的托管授权网关），**维持不变**。用户不买 KepCup 服务时，本地应用及连接应用功能不受任何影响。供应商是独立产品线与独立部署，不复用 Workers 运行时，也不进入连接应用的授权链路。 |
| `todo/hosted-auth-gateway.md` | 仍默认不建；与供应商登录不是同一服务。 |
| D72 外部智能体订阅 | onboarding「我有订阅」保留；与 KepCup 供应商并列（路由规则见 §5.3）。 |

## 2 现状与差距（代码摸底，2026-10-12）

### 2.1 DIY 路径今天能配置什么（供应商首期须对齐的全集）

**对话模型**（设置 › 模型；`buildModelRegistry` / PiEngine）：

| 来源 | 配置位置 | 说明 |
|---|---|---|
| pi 内置厂商 | 厂商卡片 + `provider:{id}` Key | OpenAI / Anthropic / Google 等 |
| 自定义 OpenAI 兼容 | `settings.customProviders` | `custom:{id}` |
| 国内厂商对话 | `settings.vendorProviders`：`dashscope` / `volcengine` | 只登记 chat 模型；Key 按厂商共享 |
| 默认引用 | `defaultMainModel` / `defaultLightModel` | Bot 可覆盖（Profile `main_model` / `light_model`） |

凭据在每次请求时经 `auth.apiKey.resolve` 异步解析（`agent/models.ts`），供应商 token 可在此处取用与刷新。

**能力模型**（`settings.capabilityModels`，每种至多一条；`MediaService` → 厂商适配器）：

| 能力 | 用途 | DIY 已适配厂商 | 入口 |
|---|---|---|---|
| `embedding` | 文本向量（另可 `embedding.source=local` 用本机 jina） | dashscope、volcengine | `GatewayEmbedder` |
| `rerank` | 检索重排 | 仅 dashscope | `media.rerank` |
| `multimodal` | 图片理解 | dashscope、volcengine | `understand_image` |
| `asr` | 语音转写 | 仅 dashscope | 语音输入 / `transcribe_audio` |
| `tts` | 语音合成 | 仅 dashscope | `generate_speech` |
| `image` | 文生图 / 图编辑 | dashscope、volcengine | `generate_image` |
| `video` | 文生视频（提交 + 轮询） | dashscope、volcengine | `generate_video` |

**联网检索**（`settings.webSearch` + `websearch:{provider}`）：`tavily` / `brave` / `bocha`，归一为 `SearchHit{title,url,snippet}`，最多 8 条，HTTP 超时 15s。

### 2.2 接入差距（对照代码）

| 项 | 现状 | 差距 |
|---|---|---|
| 设置解析 | `SettingsService.get()` 严格解析，失败直接抛 `INTERNAL`；`dropUnknownVendors` 按 `capabilityModels.*.vendor` 清除未知厂商 | 字段改名必须带读时迁移，否则全量设置损坏或能力配置被静默清空（§5.2） |
| 模型注册 | builtin + custom + vendorProviders，同步构建自 settings | 注册 `kepcup`；目录须本地缓存（离线启动） |
| 能力网关 | `MediaService.#resolve` 只认 `dashscope` / `volcengine`，Key 取 `provider:{vendor}` | 增加 KepCup 媒体客户端；按「有效配置」路由 |
| 检索 | 三家适配器 | `kepcup` 适配器 |
| 用量 | `usage_ledger` 仅 LLM loop 写入；**媒体调用（向量/重排/图/音/视频）完全不记账**；每日后台预算按 token 计 | 媒体调用记账；记录信用金扣减；预算支持金额维度（§5.6） |
| 并发 | `providerConcurrency` 按 provider 键，默认 4 | 托管模式下全部流量汇入同一 provider，需拆键（§5.4） |
| 路由 | `LlmRouter` 有内置模型时后台 loop 优先内置 | 明确托管模式与 D72 订阅用户的后台路由（§5.3） |
| Onboarding / 设置 / 账号 / 支付 | 无 | 本文 §5、§8 |

## 3 总体架构

```text
┌──────────── KepCup Desktop ─────────────┐
│ Onboarding / 设置 / 用量 / Setup 卡       │
│ settings.supplier（账号摘要/advanced/目录缓存）│
└──────────▲───────── Port A RPC ─────────┘
           │
┌──────────┴──────── core ─────────────────┐
│ SupplierAccount：登录/刷新(single-flight)/退出│
│ SupplierCatalog：拉取/缓存/版本            │
│ effectiveModelConfig(settings) ← 叠加层   │
│   ├ buildModelRegistry（kepcup chat）     │
│   ├ MediaService（kepcup 媒体客户端）      │
│   └ SearchService（kepcup 检索）           │
│ usage_ledger（含媒体调用、信用金扣减）      │
└──────────▲───────────────────────────────┘
           │ HTTPS · Bearer 设备 access · Idempotency-Key · Affinity-Key
┌──────────┴── kepcup-supplier（境内云，子域名）──┐
│ NestJS + PostgreSQL                              │
│ Auth · Gateway · Moderation · Labeling · Router  │
│ Metering(预占/结算) · Billing(Jeepay) · Catalog  │
│ Admin · Portal · Audit/Log(≥6个月元数据)          │
└──────────▲───────────────────────────────────────┘
           │ 上游 Key 仅存此侧
     已备案的境内模型（OpenAI 兼容 / 原生媒体 API）· 检索 API
```

**信任边界**：上游 Key、轮替、内部成本只在服务端；客户端可见套餐、信用金用量、目录（逻辑 id 与契约）。正文的处理见 §7.4。

## 4 账号、设备与授权

### 4.1 身份

| 方式 | 说明 |
|---|---|
| 手机号 + 短信验证码 | 注册 / 登录主路径；即实名的基础（§7.2） |
| 微信扫码 | 登录便利；**首次使用必须绑定手机号**；可与手机号同期交付或稍后 |
| 邮箱 | 非目标 |

### 4.2 设备授权

**授权码 + PKCE + 本机 loopback**（对齐 D73 / RFC 8252）：

1. core 起临时 `127.0.0.1` 回调（复用 `apps/auth/callback-server.ts` 约束：Host 校验、state、超时、无脚本结果页）。
2. `shell.openExternal` 打开 `https://{supplier-host}/oauth/authorize?...`。
3. 用户在浏览器登录 / 注册，阅读并同意服务协议与隐私政策（含「对话内容将经 KepCup 发送至模型上游处理」的告知同意，§7.5），确认「授权此设备」。
4. 回调带 `code` → core 用 PKCE verifier 换 `access_token` + `refresh_token`；写入 `secrets`；`settings.supplier.account` 写非敏感摘要（掩码手机号、`plan`、`displayName`）。
5. access 短效（约 1h）；refresh 长效、**轮换式**（每次刷新签发新 refresh，旧的作废）、可吊销。

**刷新规则**：

- core 内 **single-flight**：并发请求共享一次刷新，避免轮换竞争把自己踢下线。
- 请求返回 401 → 刷新一次并重放该请求一次；仍 401 → 进入「登录已失效」。
- 刷新得到 `invalid_grant` → 清除凭证、进入未登录（托管叠加层失效，用户原配置自动生效）；网络错误 → 保持登录态、标记离线，不清凭证。
- 不自动弹浏览器；由横幅 / Setup 卡引导重新登录。

**为何不用 API Key 粘贴**：降低泄露面、可吊销单设备、与「登录」心智一致。个人访问令牌留作 P2。

### 4.3 多设备

| 规则 | 取值 |
|---|---|
| 同一账号活跃设备数 | 无上限 |
| 额度 | 账号级共享同一信用金池 |
| 退出 | `supplier.logout` 吊销本机 refresh；用户中心可列出并远程吊销设备 |

## 5 桌面端行为

### 5.1 有效配置：托管叠加层

core 提供唯一的解析函数 `effectiveModelConfig(settings)`，模型注册、媒体路由、检索、向量来源、`LlmRouter` 都只读它，不各自判断登录态：

| 状态 | 对话 / 能力 / 检索 | 向量来源 |
|---|---|---|
| 未登录（任意 advanced） | 用户配置 | 用户配置 |
| 已登录 + advanced=false（**托管**） | 目录 `defaults`（`kepcup/*`） | 用户已是 `local` → **保留 local**；否则用目录默认向量模型 |
| 已登录 + advanced=true | 用户配置；下拉多出 KepCup，可混用 | 用户配置 |

- **不写回**：托管模式不修改 `defaultMainModel` / `capabilityModels` / `webSearch` / `embedding`。服务端改了默认值，客户端刷新目录后自动跟随；退出登录或打开高级配置，用户原配置原样生效。
- 高级配置下引用了 `kepcup` 的条目在退出登录后变为「不可用」，走 D58 Setup 卡（卡上含「登录 KepCup」与「改用其它配置」）。
- 默认值：首次 onboarding 选「登录 KepCup」→ advanced=false；选「自行配置」→ advanced=true；既有用户后续在设置里登录 → 登录确认页让用户选择「托管」或「仅把 KepCup 加入可选项」（默认托管）。
- 设置 UI：托管模式下「模型」「能力模型」「向量来源」「联网检索」分区收起为一行摘要（「由 KepCup 提供 · 打开高级配置可自定义」），不是删除。

### 5.2 设置结构与迁移

```ts
settings.supplier = {
  account: { userIdMasked, displayName, plan } | null,  // 非敏感摘要；null = 未登录
  advanced: boolean,                                     // 缺省 true（不改变既有用户行为）
  catalog: SupplierCatalog | null,                       // 目录缓存（§6.4 GET /v1/catalog）
}
```

**能力配置字段**：`capabilityModels.*` 由 `{ vendor, model }` 改为 `{ provider, model }`，`provider = z.union([vendorIdSchema, z.literal('kepcup')])`（不用宽松 string，拼写错误应被拒）。`vendorIdSchema` 仍只含 DIY 国内厂商。

迁移要求（与改名同一提交落地）：

- **读时迁移**：`storedSettingsSchema` 之前的预处理把旧 `vendor` 映射为 `provider`；`dropUnknownVendors` 改为检查 `provider ?? vendor`，且接受 `kepcup`。
- **写时兼容**：provider 为 DIY 厂商时同时写出 `vendor` 字段，降级到旧版本时能力配置不丢失；`kepcup` 条目在旧版本中会被 `dropUnknownVendors` 置空（可接受，不会导致设置解析失败）。
- 测试覆盖：旧格式读入、新格式读入、含 `kepcup` 的设置被旧逻辑读入不抛错。

### 5.3 对话模型、Bot 覆盖与后台路由

- `buildModelRegistry` 从 `settings.supplier.catalog` 注册 `kepcup` 对话模型：`baseUrl` = 供应商 API 根；`auth.apiKey.resolve` 取 `supplier:access`（必要时触发 single-flight 刷新）；模型元数据（`contextWindow`、`maxTokens`、`input`、`reasoning`）**全部来自目录契约**，不在客户端写死。
- 目录缓存保证离线 / 慢网启动时注册表照常构建；目录拉取时机：登录后、启动后（后台）、每 6 小时、收到 `SUPPLIER_CATALOG_STALE` 时。
- **Bot 覆盖**：托管模式下，Bot Profile 中指向 KepCup 目录的模型覆盖照常生效；指向 DIY 厂商的覆盖**保留但不生效**，Bot 面板提示「高级配置下生效」。Bot 选择外部智能体引擎（D72）始终生效——那是用户自己的订阅通道，不属于模型覆盖。
- **后台 loop 路由**：`LlmRouter` 照旧「有内置模型优先内置」。托管模式下「内置」即 KepCup，因此「我有订阅」用户登录后，后台 loop 将改为消耗 KepCup 信用金。登录确认页必须写明这一点；希望后台继续走订阅的用户使用高级配置。

### 5.4 能力模型、检索与并发

- `MediaService.#resolve` 读有效配置：DIY 厂商走既有 `VendorAdapter`；`kepcup` 走 KepCup 媒体客户端（Bearer 同上），覆盖 embed / rerank / understandImage / transcribeSpeech / synthesizeSpeech / generateImage / submitVideo + videoStatus（+ cancel）。
- `webSearch` 有效值为 `kepcup` 时走 `POST /v1/web/search`，结果归一为 `SearchHit`，上限 8 条、超时 15s，与现网一致。advanced 下可选回 tavily / brave / bocha。
- **向量**：目录中的向量逻辑 id 永久绑定模型与维度（§6.1）。有效向量模型 id 变化（登录、退出、目录默认值换代）时，按现有规则入队 `memory_vec_rebuild`，并在设置页提示「正在重建记忆索引（将消耗额度）」。保留 `local` 的托管用户不受影响。
- **并发键拆分**：对话用 `kepcup`，媒体与向量用 `kepcup:media`，各自走 `providerConcurrency`（默认值沿用）。服务端按套餐限流，429 带 `Retry-After`，客户端经 `model-retry.ts` 退避。
- **亲和键**：同一会话的对话请求带 `X-KepCup-Affinity`（会话 id 的哈希），服务端在 TTL 内把它粘到同一渠道与同一 Key，保住上游的提示词缓存命中。

### 5.5 联网检索与 `web_fetch`

- 托管模式下检索强制 `kepcup`；未登录不能选 `kepcup`。
- `web_fetch` 仍本机直连（D62 SSRF 防护），不经供应商：中转抓页会放大 SSRF 与隐私面。

### 5.6 用量与预算

- **媒体调用记账（对所有 provider 生效）**：`MediaService` 每次成功调用写 `usage_ledger`，`loop_type` 取调用上下文（工具调用随所在 run，记忆向量为 `memory`，Wiki 派生为 `wiki_derive`），按次与按量字段尽量填写。这同时补上 DIY 路径媒体调用不记账的缺口。
- **信用金扣减**：供应商响应头 `X-KepCup-Charge`（单位：分）写入 `usage_ledger` 新增的可空列 `credit_spent`（迁移号在合并时取下一个空号）。`cost_usd` 仍只用于 DIY。
- **每日后台预算**：在现有 token 维度之外增加可选的「每日后台信用金上限」（按 Bot），托管模式下默认开启一个保守值。超限的后台任务照现有机制推迟到次日。
- **周期用量**：`supplier.usage` 拉取 `{ plan, creditTotal, creditSpent, creditReserved, percentUsed, periodStart, periodEnd }`；设置页与侧栏展示；短缓存，登录后与额度类错误后失效。百分比以服务端账本为准；本地账本用于按 Bot / loop 分析。

### 5.7 Onboarding

```text
欢迎 → 模型步三选一
        ├─ 登录 KepCup → 浏览器授权（含协议与告知同意）→ 托管模式（advanced=false）
        ├─ 自行配置 → ProviderSetupForm（现状）→ advanced=true
        └─ 我有订阅 → D72 外部智能体（始终保留）
     → 权限 → 沙箱 → 管家
```

- 跳过模型步仍允许；主界面横幅同时提供「登录 KepCup」与「去配置」。
- 无任何可用模型时走 D58 `main-model` 卡（含登录入口）。

### 5.8 错误与引导

| 情况 | 错误码 | 客户端表现 | 重试 |
|---|---|---|---|
| 未登录且无可用模型 | — | D58 `main-model`（含登录） | — |
| 刷新失败（invalid_grant） | `SUPPLIER_AUTH_EXPIRED` | 横幅「登录已失效」；用户原配置自动生效 | 否 |
| 额度不足 / 预占失败 | `SUPPLIER_QUOTA_EXCEEDED`（402） | 引导升级订阅，或打开高级配置改走 DIY | 否 |
| 套餐不含该模型 | `SUPPLIER_MODEL_FORBIDDEN`（403） | 提示并引导升级 | 否 |
| 目录过期 / 逻辑 id 下线 | `SUPPLIER_CATALOG_STALE`（409） | 刷新目录后重试一次 | 一次 |
| 输入未通过内容安全审核 | `SUPPLIER_CONTENT_BLOCKED`（400，`stage=input`） | 本条请求失败并显示中性提示；后台 loop 记为跳过 | 否 |
| 输出流被审核中止 | `SUPPLIER_CONTENT_BLOCKED`（流内事件，`stage=output`） | 已收到的内容按审核结果撤下或截断，消息标记「内容已被中止」 | 否 |
| 账号被限制 / 暂停 | `SUPPLIER_ACCOUNT_RESTRICTED`（403） | 横幅说明并链接用户中心 | 否 |
| 限流 | 429 | `model-retry.ts` 退避；耗尽后说明供应商限流 | 是 |
| 上游 5xx | 502/503 | 重试；日志只含供应商 request id | 是 |

> **注**：`SUPPLIER_CONTENT_BLOCKED` 必须是不可重试错误，后台 loop（记忆反思、Wiki 维护等）遇到时跳过该任务，不进入重试风暴。

## 6 服务端模块

独立仓库 `kepcup-supplier`：**Node.js + NestJS + PostgreSQL**，部署于境内云，使用 `kepcup.com` 的子域名（具体名待运维定）。选择境内云而非 Cloudflare 的原因：ICP 与数据境内存储要求、PostgreSQL 事务型记账、支付异步回调与长连接流式代理。Cloudflare 继续只承担 D74 的连接应用 OAuth 基座。

| 模块 | 职责 |
|---|---|
| Auth | 手机号短信、微信扫码（绑定手机）、设备授权码、轮换 refresh、吊销 |
| Gateway | chat 兼容代理（SSE）、全能力媒体代理、检索代理、鉴权、幂等、亲和、超时 |
| Moderation | 输入 / 输出内容安全审核（文本、图像），流式分段审核与中止（§7.3） |
| Labeling | 生成图片 / 音频 / 视频的显式与隐式标识（§7.3） |
| Router | 逻辑 id → 上游渠道；契约校验；多 Key 轮替；亲和粘滞；失败切换 |
| Metering | 预占 / 结算 / 释放；信用金账本；`percentUsed` |
| Billing | 三档订阅、Jeepay、按未用额度比例退款（无降档） |
| Catalog | 逻辑 id 契约、默认值、版本号 |
| Admin | 渠道与 Key、峰谷成本、能力槽路由与定价、档位信用金、审核策略与处置 |
| Portal | 用户中心：订购 / 升级、用量、设备、退款申请、投诉举报、账号注销、个人信息查阅导出 |
| Audit/Log | 网络日志与处置记录留存（§7.4） |
| Risk | 异常用量、短信刷取防护、违规账号处置 |

### 6.1 目录契约与路由

- **逻辑模型 id**：`kepcup/{logicalId}`。每个 id 在目录中声明契约：`capability`、`contextWindow`、`maxOutputTokens`、`input`（text / image）、`toolCalling`、`reasoning`；能力模型另声明各自参数面（如 TTS 音色、图片尺寸、视频时长档位）。
- **路由约束**：管理端为每个能力槽（主模型、轻量、embedding、rerank、multimodal、asr、tts、image、video、web_search）选择上游时，**只能选满足该逻辑 id 契约的已备案模型**。契约变更 = 新 id 或目录版本递增。
- **向量特例**：embedding 逻辑 id 永久绑定一个具体模型与维度，不允许改路由；换代时发布新 id 并把默认值切过去，客户端据此重建向量（§5.4）。
- **渠道与轮替**：每个上游渠道有厂商类型、baseUrl、多条 Key、权重 / 优先级、冷却时间。按亲和键在 TTL 内粘滞同一渠道与 Key；遇 429 / 特定 5xx 标记冷却再切换。轮替细节对客户端不可见。

### 6.2 计量：预占、结算与边界情况

| 场景 | 规则 |
|---|---|
| 一般调用 | 请求到达时按「输入估算 + `max_tokens` × 单价」或「按次单价」**预占**；余额（扣除在途预占）不足 → 402；完成后按上游实际用量**结算**，多退少补 |
| 流式中断（用户停止 / 断线） | 按上游返回的 usage 结算；上游未返回时按服务端分词器估算「已发送输出 + 输入」结算 |
| 输入被审核拦截 | 不扣费，释放预占 |
| 输出被审核中止 | 按已产生的上游用量结算（上游成本已发生） |
| 视频异步任务 | 提交时预占；成功时结算；失败 / 取消按上游实际计费结果结算（上游不计费则全额释放） |
| 连通性探测 | `POST /v1/probe/{capability}` 免费、限频，返回能力可用性而不真正生成；桌面「测试」按钮用它 |
| 预占过期 | 超时未结算的预占自动释放并告警 |

**峰谷成本**：管理端可配置周期峰段与指定时段的内部成本价，用于对用户标价的调价依据；用户只看到公布的单价与信用金扣减。落价时刻（请求结束 / 首 token）在实现时选定一种并写入管理端说明。

### 6.3 幂等（P0）

- 非流式请求必须带 `Idempotency-Key`（UUID）；网关对「同一账号 + Key」在 24h 内返回同一结果，且只计费一次。
- 流式 chat：上游调用开始前重复到达 → 复用；开始后重复到达 → 409。
- 桌面：`model-retry.ts` 在「尚未收到任何响应」时重试，复用同一 Key；媒体客户端每次逻辑调用生成一个 Key，重试复用。

### 6.4 API 形态（对桌面；P0 全部具备）

目录与账号：

| 端点 | 用途 |
|---|---|
| `GET /v1/catalog` | 版本号、逻辑 id 契约、按能力分组的模型、默认值（主 / 轻量 / 各能力 / 检索） |
| `GET /v1/account/me` | 套餐、设备、掩码手机号、账号状态（正常 / 受限） |
| `GET /v1/account/usage` | 信用金总额 / 已用 / 在途预占 / 周期 |
| OAuth 授权 / token / revoke | 设备登录 |

调用（语义一一覆盖 `VendorAdapter` / `SearchService`，避免桌面写平行业务逻辑）：

| 端点 | 能力 | 备注 |
|---|---|---|
| `POST /v1/chat/completions` | chat | OpenAI 兼容，SSE；流内可下发审核中止事件 |
| `POST /v1/embeddings` | embedding | 返回维度与目录契约一致 |
| `POST /v1/rerank` | rerank | `{query, documents[]}` → 排序 index |
| `POST /v1/images/understand` | multimodal | 对齐 `understandImage` |
| `POST /v1/audio/transcriptions` | asr | 音频 → 文本 |
| `POST /v1/audio/speech` | tts | HTTP 非实时通道 |
| `POST /v1/images/generations` | image | 文生图 / 参考图编辑；结果已加标识（§7.3） |
| `POST /v1/videos/generations` + `GET …/{taskId}` | video | 异步提交 + 轮询 + 可选 cancel；结果已加标识 |
| `POST /v1/web/search` | web_search | `{query, max_results}` → `SearchHit[]` |
| `POST /v1/probe/{capability}` | 探测 | 免费、限频 |

**生成媒体的交付**：图片 / 音频 / 视频在服务端完成标识后，存入供应商自有对象存储，以**供应商域名下的短时签名 URL**（如 24h）交付，到期删除。这既满足标识要求，也避免向客户端暴露上游厂商的存储地址。

错误体统一带稳定 `code`（§5.8）。日志中不出现上游 Key 与上游账号 id，对账用内部渠道 id。

### 6.5 不中转的项

| 项 | 结论 |
|---|---|
| 本机 jina 向量 | 不中转；托管模式下已在用 local 的用户保留 local |
| `web_fetch` | 本机直连 + SSRF 防护 |
| 实时 WebSocket TTS / ASR | 现网 DIY 也未开放；P0 只做 HTTP 通道 |
| 用户自备的各家 Key | 不上传、不代管 |
| 连接应用 OAuth | 由 D74 Cloudflare 基座承担，与供应商无关 |

## 7 合规设计（面向中国大陆公众）

本节把监管要求转化为设计约束。具体条款适用范围、留存期限与申报路径以**法务出具的上线清单**为准；本节列出的是产品与架构必须预留的能力。

### 7.1 主体资质（上线门禁）

| 项 | 说明 |
|---|---|
| ICP 经营许可证 | 付费订阅属经营性互联网信息服务 |
| 生成式 AI 服务上线手续 | 调用已备案模型对外提供服务，按属地网信部门要求办理登记（或备案，以法务认定为准）；准备安全评估材料（拦截关键词库、拒答测试集等） |
| 算法备案 | 如被认定具有舆论属性或社会动员能力则需办理；法务判定 |
| 网络安全等级保护 | 建议按二级建设并测评 |
| 短信签名、微信开放平台、支付商户号 | 各自资质 |

在门禁全部满足前，供应商只以**白名单内测**形式运行，不对公众开放注册与收费。

### 7.2 上游与实名

- 目录中的上游**只允许已完成备案的模型**；管理端在添加渠道时记录备案号，未填写不得上线该渠道。
- 账号以手机号注册（手机号实名）；微信登录必须绑定手机号。
- 服务协议明确使用规范、违规处置与投诉渠道；未成年人保护措施（年龄声明 / 未成年人模式 / 不面向未成年人的约定）由法务确定后在注册流程落实。

### 7.3 内容安全与生成内容标识

- **输入审核**：对话文本、图片理解的输入图片、图片编辑的参考图，在调用上游前经审核；命中 → 拒绝（不扣费），返回 `SUPPLIER_CONTENT_BLOCKED`。
- **输出审核**：
  - 流式对话按句段缓冲审核，命中时停止传输并下发中止事件；
  - 非流式结果在返回前审核；
  - 生成的图片 / 音频 / 视频在交付前审核。
- **处置**：对违规使用者按协议采取警示、限制功能、暂停或终止服务；保存处置记录；依法向主管部门报告。管理端提供处置工作台。
- **标识**：
  - 生成的图片 / 音频 / 视频在服务端加隐式标识（文件元数据）和显式标识（按标识办法要求的形式），然后再交付；
  - 桌面保存生成文件时不得剥离元数据（现有 `generate_*` 工具按原字节落盘，保持即可）；
  - 对话界面对 KepCup 来源的回复提供「AI 生成」提示（以法务认定的形式为准）。
- **审核与后台 loop**：后台 loop 的请求同样经审核；被拦截时按不可重试处理（§5.8）。

### 7.4 日志与数据留存

| 数据 | 留存 | 说明 |
|---|---|---|
| 网络日志（元数据） | **不少于六个月** | 账号 id、设备 id、时间、来源 IP、端点、逻辑模型 id / 渠道 id、token 与次数、扣减金额、状态码、耗时、审核结论、request id |
| 对话 / 媒体正文 | **默认不持久化** | 仅在内存中流经网关与审核；不写盘、不进日志 |
| 审核命中样本与处置记录 | 按法务确定的期限 | 加密存储、访问留痕，仅限合规与处置用途 |
| 生成媒体 | 交付用短时存储（如 24h）后删除 | 见 §6.4 |
| 计费与订单 | 按财务与税务要求 | |

- 正文与样本一律不用于训练；对外宣传「不用于训练」须与上游协议一致。
- 数据境内存储；不向境外传输。

### 7.5 个人信息保护

- 登录授权页提供服务协议与隐私政策，并就「对话内容与上传资料将经 KepCup 发送至第三方模型提供方处理」取得用户同意。桌面设置页的托管模式说明中也展示同样的告知。
- 用户中心提供：个人信息查阅与导出、账号注销（注销后删除账号数据，依法需留存的日志除外）、投诉举报入口与处理时限承诺。
- 最小必要：客户端只上传调用所需内容；不上传本地记忆库或 Wiki 整库（它们只以单次请求内容的形式出现）。

## 8 套餐与支付

### 8.1 统一信用金额度池

| 档位 | 价格 | 含义 |
|---|---|---|
| 基础 | ¥69 / 月 | 信用金 C1；能力全集 |
| 专业 | ¥199 / 月 | 信用金 C2 ≥ C1；限流更高 |
| 旗舰 | ¥599 / 月 | 信用金 C3 ≥ C2 |

- 每种模型与检索源在管理端单独定价（按 token 和 / 或按次）；按 §6.2 预占与结算；`percentUsed = creditSpent / creditTotal`。
- 超额：硬拒绝 `SUPPLIER_QUOTA_EXCEEDED`，唯一出路是升级。
- 档位差异在于信用金与限流，不是能力可用性。

### 8.2 退款与档位变更

- 按**未使用信用金比例**退款（已消耗与在途预占不退）；走 Jeepay 退款与对账。
- 不支持降档；可升级；周期结束后改订低档视为新周期新订单。
- 升档：付费成功后立即生效（实现时在「补差」与「重置周期」中选定一种，写入订单状态机）。

### 8.3 Jeepay 与用户中心

- 用户中心发起订购 / 升级 → 业务单 → Jeepay 统一下单 → 异步通知验签 → 发放或调整信用金；查单补偿、关单、退款走 Jeepay；验签失败不得发放权益。
- 桌面不直连 Jeepay，只打开用户中心或展示订阅状态。

## 9 与 KepCup 代码的集成锚点

| 位置 | 改动要点 |
|---|---|
| `packages/shared` `domain/types.ts` | `settings.supplier`；`capabilityModelSchema` 改 `provider`（读时迁移）；`webSearchProviderSchema` 增 `kepcup`；错误码 |
| `packages/core/src/domain/settings.ts` | 读时迁移；`dropUnknownVendors` 兼容 `provider ?? vendor` 与 `kepcup` |
| 新增 `packages/core/src/supplier/` | 账号（登录、single-flight 刷新、退出）、目录缓存、`effectiveModelConfig`、媒体与检索客户端 |
| `packages/core/src/agent/models.ts` | 按目录注册 `kepcup`；`resolve` 取供应商 token |
| `packages/core/src/agent/llm-router.ts` | 读有效配置；Bot 覆盖在托管模式下的规则 |
| `packages/core/src/media/service.ts` | 按有效配置路由；**所有调用记账** |
| `packages/core/src/memory/` | 有效向量模型变化触发重建 |
| `packages/core/src/search/` | `kepcup` 适配器 |
| `packages/core/src/agent/model-retry.ts` | 复用 Idempotency-Key；`SUPPLIER_*` 不可重试码 |
| `packages/core/src/usage/budget.ts`、`domain/usage.ts` | `credit_spent` 列；信用金维度的后台预算 |
| `packages/core/src/apps/auth/callback-server.ts` | 复用给供应商登录 |
| `packages/core/src/rpc/bindings.ts` | `supplier.login` / `logout` / `account` / `usage` / `catalog.refresh` |
| `OnboardingWizard.svelte` | 模型步三选一 |
| 设置导航 / 模型类分区 / 账户分区 | 托管模式收起摘要；登录确认（托管 / 仅加入可选项）；告知文案 |
| Bot 面板模型选择 | 托管模式只列 KepCup 目录；DIY 覆盖标注「高级配置下生效」 |
| 消息渲染 | 「内容已被中止」状态；KepCup 来源「AI 生成」提示 |
| `UsageSection.svelte` | 供应商周期用量与信用金 |
| `SetupRequiredCard` | 登录入口 |

## 10 分期

### P0 — 白名单内测：登录 + 能力全集 + 计费可靠

- **服务端**：
  - 手机号登录（微信扫码可同期或稍后）、设备 OAuth、轮换 refresh；
  - 目录契约、能力槽路由（仅已备案模型）、chat + 七种能力 + web_search 全部可调；
  - 预占 / 结算、幂等键、免费探测；
  - 输入输出审核与流式中止、生成媒体标识与短时签名交付；
  - 元数据日志（≥6 个月）、处置记录；
  - 管理端手工入信用金。
- **桌面**：
  - 登录 / 退出 / single-flight 刷新；托管叠加层 `effectiveModelConfig`；
  - `provider` 字段与读写迁移；目录缓存；
  - Bot 覆盖与后台路由规则；向量重建；并发键拆分与亲和键；
  - 媒体调用记账与 `credit_spent`；全部错误码；
  - onboarding 三选一与登录告知同意。

### P1 — 公开上线：商业化与合规门禁

- 合规门禁全部满足（§7.1–§7.5）后开放公众注册。
- Jeepay 订购 / 升级 / 退款全流程；用户中心（含投诉举报、注销、个人信息导出）。
- 多 Key 轮替与亲和粘滞调优；峰谷成本记账；信用金维度后台预算的默认值调优。
- 微信扫码（若 P0 未做）；高级配置混用体验打磨。

### P2 — 扩展

- 个人访问令牌；年付；更细消费明细与发票；风控加强；实时音视频通道另议。

## 11 风险与开放项

| 项 | 说明 |
|---|---|
| 资质与申报路径 | 登记 / 备案、算法备案、等保等级以法务清单为准；未满足前不公开上线 |
| 未成年人保护 | 具体措施待法务确定（§7.2） |
| 审核误杀 | 后台 loop 被拦截按跳过处理；管理端可调策略；需观察误杀率 |
| 审核延迟 | 流式分段审核会增加首字与段间延迟；P0 量化并设上限 |
| 上游条款 | 中转转售须符合各上游的服务条款；按条款选型 |
| 「AI 生成」提示形式 | 以法务认定为准 |

## 12 验收锚点（P0）

- **托管叠加**：新装用户选「登录 KepCup」→ 授权成功 → 进入托管模式：对话、七种能力、检索走 KepCup，`settings` 中用户字段**未被改写**；退出登录后原配置（或空配置 → Setup 卡）立即生效。
- **已有用户登录**：本机已用 local 向量的用户登录后仍为 local，不触发重建；选「仅加入可选项」时行为与登录前一致，下拉多出 KepCup。
- **迁移**：旧版本设置（`vendor` 字段）升级后能力配置完整保留；含 `kepcup` 的设置被旧版本读取时应用可启动。
- **能力**：embedding、rerank、multimodal、asr、tts、image、video 经 `/v1/probe` 探测成功，且各完成一次真实调用；`web_search` 返回归一结果。
- **向量契约**：目录默认向量 id 换代后，客户端自动重建且检索正常；同一 id 下维度不变。
- **计费**：模拟 5xx 重试不产生重复扣费；用户停止流式回复后按已用量结算；余额不足时预占失败返回 402；视频取消按规则结算；探测不扣费。
- **记账**：媒体调用（含 DIY 厂商）出现在 `usage_ledger`；KepCup 调用带 `credit_spent`；后台信用金上限生效。
- **合规**：输入命中审核返回 `SUPPLIER_CONTENT_BLOCKED` 且不扣费、不重试；流式输出中止后消息标记正确；生成图片带隐式标识；网关存储与日志中抽样检索不到正文；元数据日志可按账号检索。
- **解耦**：断开供应商（或未登录）时，DIY、ACP、连接应用（Cloudflare OAuth）功能全部正常。
- **安全**：`secrets`、RPC、日志、界面中检索不到任何上游厂商 Key。
- **退出与吊销**：吊销 refresh 后明确提示、可重新登录，不出现循环弹窗。

---

## 修订记录

- 2026-10-11：初稿（D83）。基于对 `buildModelRegistry`、`SearchService`、`OnboardingWizard`、`usage_ledger`、D73 loopback、设置 schema 的只读摸底。
- 2026-10-11：P0 范围改为 DIY 可配置能力全集；补 §2.1 清单、全端点与不可中转边界。
- 2026-10-11：消化十条拍板：统一信用金额度池、能力槽路由、设备无上限、子域名独立部署、按未用额度退款且不降档、保留「我有订阅」、Nest + PostgreSQL、能力配置用 `provider` 字段。
- 2026-10-12：按代码审查与补充拍板重写：
  - **托管改为叠加层**，不再改写用户配置，退出即恢复；
  - `provider` 字段带读写迁移、类型收紧为联合枚举；
  - 目录契约，向量逻辑 id 永久绑定模型与维度；
  - 已用 local 向量的用户保留 local；
  - 计费改为预占 / 结算，幂等提前到 P0，补齐流式中断、视频与探测规则；
  - 媒体调用记账、`credit_spent` 与信用金维度后台预算；
  - 并发键拆分与亲和粘滞；single-flight 与轮换 refresh；
  - 明确 Bot 覆盖与 D72 后台路由；生成媒体经供应商域名短时签名交付；
  - **合规**：「只转发不记录」改为按监管要求设计（已备案上游、手机号实名、输入输出审核、生成内容标识、元数据日志 ≥6 个月、正文默认不持久化、审核样本依法留存、个人信息权利）；P0 定为白名单内测，公开上线以合规门禁为前提；
  - 部署改为境内云，并写明原因；
  - Cloudflare 维持仅承担连接应用 OAuth（D74），供应商与本地功能完全解耦。

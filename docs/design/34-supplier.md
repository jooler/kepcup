# 34 KepCup 供应商（云端大模型 / 检索中转）

用户打开应用后**登录一次**，即可让对话模型、轻量模型与联网检索全部走 KepCup 自建的上游中转，无需自己去各家控制台申请 API Key。高级用户仍可打开「启用高级配置」，混用自家凭据与 KepCup 供应商。本文规定桌面端接入契约与供应商服务端（独立仓库，后续拆出）的产品与架构边界。

决策编号 **D83**。**状态：已定稿，待实施。** 服务端独立仓库（暂名 `kepcup-supplier`），子域名独立部署（Node / Nest + PostgreSQL，见 §6）；本文是桌面与服务端的共同规格。

相关：D11 / D07（本地优先，本决策引入**可选**云账号）、D25（敏感数据加密）、D45 / D14（模型配置与用量账本）、D16（能力模型）、D58 / D18（对话内设置引导与 onboarding）、D62 / D21（联网检索）、D65（MCP，与本决策无关）、D70（管家 onboarding）、D73 / D29（系统浏览器 + loopback 授权范式可复用）、D74（`kepcup.com` Cloudflare 基座；供应商业务服务**不**与托管授权网关混为一谈——见 §1.3）。

## 决策

- **D83 KepCup 供应商**：
  1. **零配置主路径**：用户在桌面端「登录 KepCup」→ 系统浏览器完成手机号（微信扫码可与登录一并做，或按工作量稍后补，见 §9）注册 / 登录并授权本机 → loopback 换设备凭证 → 对话、全部能力模型与联网检索默认走供应商；设置页「模型」「能力模型」「向量来源」「联网检索」在此模式下**隐藏**。
  2. **高级配置开关**：`settings.supplier.advanced`。关闭 = 只走 KepCup（已登录时）；打开 = 露出 DIY，并在对话厂商与能力 `provider` 下拉中增加 **KepCup**，可混用。
  3. **首次启动三选一**：登录 KepCup / 自行填写模型配置 / **我有订阅（D72，保留）**。自行填写 → advanced 默认开；登录成功 → advanced 默认关，并按服务端目录 defaults 写齐主/轻量对话、七种能力与检索（向量 `source=provider`）。供应商只是多了一个模型供应商，**不取代** ACP 外部智能体。
  4. **客户端永不持有上游 Key**：上游 Key、计价、轮替只在服务端；桌面只存 `supplier:access` / `supplier:refresh`。
  5. **首期能力全集**：凡 DIY 能配的能力与检索，供应商 P0 全部提供（见 §2.1）；目录与桌面默认一次写齐。
  6. **调用与配置形态**：对话 OpenAI 兼容；能力走供应商媒体 API；检索 `/v1/web/search`。能力配置字段改为更宽的 **`provider` 字符串**（`dashscope` / `volcengine` / `kepcup` …），**不**把 `kepcup` 塞进 `vendorIdSchema`（后者仍仅 DIY 国内厂商 `dashscope` | `volcengine`）。幂等键见 §6.3。
  7. **商业化（统一额度池）**：三档 ¥69 / ¥199 / ¥599 每月 = 写入该档**总额度（信用金）**；每种模型与检索在管理端单独定价（按 token 或按次）；用量 % = 已消耗金额 / 总额度；**超额必须升级订阅**（不可按量加购超额包）。支付 Jeepay。**只支持按未使用额度比例退款；不支持降档**。
  8. **路由在服务端**：管理端按应用能力槽（主模型、轻量、embedding…、检索）配置当前选用的上游模型 / 检索源及价格；用户请求只带能力意图（或桌面写入的逻辑模型 id），**由服务端选路上游**。桌面 defaults 来自 `GET /v1/models`，不在客户端写死型号表。
  9. **可选、可退出**：登录不是使用前提；无设备数上限；退出 / 吊销后回 DIY 或 ACP 路径。
  10. **服务端栈**：独立子域名部署；**Node + NestJS + PostgreSQL**；与 D74 Cloudflare 静态 / 目录栈分离。网关**只转发、不记录**提示词 / 回复 / 多媒体正文。

## 1 产品目的与边界

### 1.1 要解决什么


| 痛点                         | 做法                   |
| -------------------------- | -------------------- |
| 新用户不知道去哪申请 Key、填哪个 baseUrl | 登录即用，默认模型与检索由供应商下发   |
| 国内多厂商、峰谷价、单账号限频            | 服务端统一计价与多凭据轮替，客户端无感  |
| 想降低门槛又不丢掉 DIY              | 高级配置开关 + 混用          |
| 需要可持续运营                    | 订阅档位 + Jeepay + 用量可见 |


### 1.2 明确不做（本期）

- 不做令牌云同步多台设备共用同一设备凭证（每台设备单独授权；账号可多设备，见 §4）。
- 不做把 Composio / Nango / 第三方聚合中转再套一层（供应商即自有中转）。
- 不做供应商侧持有用户的 Google/Notion 等连接应用令牌（仍属 D73 本地优先；与 `todo/hosted-auth-gateway.md`「默认不建」一致）。
- 不做企业发票 / 对公合同流程的完整财务系统（可后续；本期订阅收据级即可）。
- 不做海外 Stripe 并行（支付通道以 Jeepay 覆盖国内为主；国际化另议）。
- 不把供应商网关当成任意 OpenAI 兼容代理给第三方公开转售（仅服务已登录的 KepCup 客户端与官网用户中心）。
- 不做套餐**降档**；不做「超额后按量加购」而不升档（超额唯一出路是升级订阅）。
- 网关不做提示词 / 回复 / 多媒体正文的持久化或短时审计落盘（只转发）。

### 1.3 与既有「云」相关设计的关系


| 文档                            | 关系                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| D74 / 29 §15 Cloudflare       | CIMD、目录、将来托管授权网关；**账号体系曾明确「不做」**——那是针对「为了连第三方 MCP 而建账号」。本决策是**独立产品线**：为大模型 / 检索中转建账号，不改变 D73 本地持令牌原则。 |
| `todo/hosted-auth-gateway.md` | 仍默认不建；与供应商登录不是同一服务。                                                                                   |
| D72 外部智能体订阅                   | onboarding「我有订阅」保留；与 KepCup 供应商并列，互不替代。                                                               |


## 2 现状与差距（代码摸底，2026-10-11）

### 2.1 DIY 路径今天能配置什么（供应商首期必须对齐的全集）

**对话模型**（设置 › 模型；进 `buildModelRegistry` / PiEngine）：


| 来源            | 配置位置                                                             | 说明                                                      |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| pi 内置厂商       | 厂商卡片 + `provider:{id}` Key                                       | OpenAI / Anthropic / Google 等（pi-ai `builtinProviders`） |
| 自定义 OpenAI 兼容 | `settings.customProviders`（id / name / baseUrl / models）         | `custom:{id}`                                           |
| 国内厂商对话        | `settings.vendorProviders`：`dashscope`（阿里云百炼）、`volcengine`（火山方舟） | 只登记 **chat** 模型；Key 按厂商共享                               |
| 默认引用          | `defaultMainModel` / `defaultLightModel`（`provider/modelId`）     | Bot 可覆盖                                                 |


**能力模型**（设置 › 能力模型；`settings.capabilityModels`，每种至多一条；网关 `MediaService` → 适配器）。**D83 修订**：条目由 `{ vendor: VendorId, model }` 改为 `{ provider: string, model }`——`provider` 可为 `dashscope` / `volcengine` / `kepcup` 等；`vendorIdSchema` **仍只**含 DIY 国内厂商，不收录 `kepcup`：


| 能力 key       | 用途                                              | DIY 已适配厂商（`vendors.ts`）        | 桌面入口 / RPC                                                 |
| ------------ | ----------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `embedding`  | 文本向量（记忆检索；另可 `embedding.source=local` 用本机 jina） | dashscope、volcengine           | `CapabilityModelSection`；`media` embed / `GatewayEmbedder` |
| `rerank`     | 检索重排                                            | **仅** dashscope（方舟无数据面 rerank） | `media.rerank`                                             |
| `multimodal` | 图片理解（视觉问答）                                      | dashscope、volcengine           | `understand_image` 工具；`media.understandImage`              |
| `asr`        | 语音转写                                            | **仅** dashscope                | 语音输入 / `transcribe_audio`；`media.transcribeSpeech`         |
| `tts`        | 语音合成                                            | **仅** dashscope                | `generate_speech`；`media.synthesizeSpeech`                 |
| `image`      | 文生图 / 图编辑                                       | dashscope、volcengine           | `generate_image`；`media.generateImage`                     |
| `video`      | 文生视频（提交 + 轮询）                                   | dashscope、volcengine           | `generate_video`；`media.generateVideo` / `videoStatus`     |


**联网检索**（设置 › 联网检索；`settings.webSearch` + `websearch:{provider}`）：


| 供应商 id   | 适配器                                | 结果面（归一后）                              |
| -------- | ---------------------------------- | ------------------------------------- |
| `tavily` | POST api.tavily.com/search         | `SearchHit{title,url,snippet}`，最多 8 条 |
| `brave`  | GET api.search.brave.com/…         | 同上                                    |
| `bocha`  | POST api.bochaai.com/v1/web-search | 同上                                    |


另：`web_fetch` 是宿主直连抓页（SSRF 防护），**不是**可配置的检索供应商，不经供应商中转（见 §5.3）。

**不在「供应商替代」范围、但需在文档里说清的**：


| 项                                        | 原因                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 本机向量 `embedding.source=local`（jina ONNX） | 本机推理，无法「中转」；登录 KepCup 且未开高级配置时，改为 `source=provider` + `capabilityModels.embedding` 指向 KepCup 云端向量；高级配置下仍可选 local |
| pi 内置 / 自定义 / 百炼 / 方舟的**用户自备 Key**       | DIY 保留；供应商提供的是平行的 `kepcup` 厂商与能力目录，不是替用户保管其百炼 Key                                                                |
| D72 外部智能体订阅                              | 并列路径，不经供应商网关                                                                                                     |


### 2.2 接入差距


| 项          | 现状                                                      | 差距                                                                 |
| ---------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| 模型注册       | `buildModelRegistry`：builtin + custom + vendorProviders | 注册 `kepcup` 对话目录；Credential 读 `supplier:access`                    |
| 能力网关       | `MediaService` 只路由 `dashscope` / `volcengine` 适配器       | 增加 **KepCup 媒体适配器**（或把 `kepcup` 登记为第三家 `VendorId` / 平行路由），七种能力全部可调 |
| 设置         | 无账号、无 advanced                                          | `settings.supplier`；登录且 advanced=false 时隐藏模型 / 能力 / 检索 DIY，并写入全集默认 |
| 密钥         | `provider:*` / `websearch:*`                            | `supplier:access` / `supplier:refresh`；禁止上游 Key 下发                 |
| 检索         | tavily / brave / bocha                                  | `kepcup` 适配器 → 供应商 `/v1/web/search`（结果面不低于上表）                      |
| 用量         | 本地 `usage_ledger`                                       | 继续记；另拉供应商周期用量 %（可按能力拆明细，P1 打磨）                                     |
| Onboarding | Key / 我有订阅                                              | 加「登录 KepCup」；成功则写齐对话 + 七种能力 + 检索默认                                 |
| OAuth 回调   | D73 loopback                                            | 复用，勿内嵌 WebView                                                     |
| 用户账号 / 支付  | 无                                                       | 服务端 + Jeepay                                                       |


## 3 总体架构

```text
┌──────────── KepCup Desktop ────────────┐
│ Onboarding / 设置 / 用量条 / Setup 卡     │
│ settings.supplier + secrets(supplier:*) │
└──────────▲────────── Port A RPC ────────┘
           │
┌──────────┴──────── core ────────────────┐
│ SupplierAccount（登录/刷新/退出/用量%/目录）│
│ buildModelRegistry ← kepcup chat         │
│ MediaService ← provider 路由（含 kepcup） │
│ SearchService ← kepcup web_search        │
│ usage_ledger 仍本地记账                  │
└──────────▲──────────────────────────────┘
           │ HTTPS（Bearer 设备 access）
           │ Idempotency-Key（不落正文）
┌──────────┴── kepcup-supplier（子域名独立部署）─┐
│ Node + NestJS + PostgreSQL                    │
│ Gateway（只转发）· Auth · Billing(Jeepay)      │
│ Router / 轮替 · 统一额度池计量 · Catalog/Admin │
│ 能力槽配置页（对应桌面每类模型设置）· Portal    │
└──────────▲────────────────────────────────────┘
           │ 上游 Key 仅存此侧
     OpenAI兼容 / 各厂原生媒体 API / 检索 API
```

部署：**供应商 API 使用 `kepcup.com` 的子域名（具体名待运维定），与 D74 Cloudflare Workers / 静态资源栈独立部署**，不共用同一套 Workers 运行时。

**信任边界**：上游 Key、内部轮替、峰谷成本只在服务端；客户端可见套餐名、**统一额度池**的用量百分比、按能力的目录与 defaults。网关**不持久化**提示词 / 回复 / 多媒体正文。

## 4 账号、设备与授权

### 4.1 身份


| 方式          | 说明                   |
| ----------- | -------------------- |
| 手机号 + 短信验证码 | 注册 / 登录主路径之一         |
| 微信扫码        | 注册 / 登录；已绑手机可直接授权。可与手机登录同一期交付，或按工作量略后于手机号（不阻塞「能登录」的 P0） |
| （预留）邮箱      | 非目标首期                |


**假设（待合规确认，见 §10）**：面向中国大陆用户；是否需要强制实名、ICP、短信服务商与微信开放平台资质，以法务 / 上线清单为准，本文不假装已具备。

### 4.2 设备授权（桌面拿到的凭证）

推荐 **授权码 + PKCE + 本机 loopback**（对齐 D73 / RFC 8252），而不是把长期 API Key 贴进设置框：

1. core 起临时 `127.0.0.1` 回调（复用 callback-server 约束：Host 校验、state、超时、无脚本结果页）。
2. `shell.openExternal` 打开 `https://{supplier-host}/oauth/authorize?...`（或 `/login?device=…`）。
3. 用户在浏览器登录 / 注册并确认「授权此设备」。
4. 回调带 `code` → core 用 PKCE verifier 换 `access_token` + `refresh_token` + 过期时间；写入 `secrets`；`settings.supplier` 写入非敏感摘要（`userId` 掩码、`plan`、`displayName`、`advanced`、`loggedIn:true`）。
5. access 短效（建议 1h 量级）；refresh 长效、可吊销；刷新只在 core，失败则清登录态并触发 UI「重新登录」。

**为何不用纯 API Key 粘贴**：降低泄露面、支持吊销单设备、与「登录」心智一致；高级用户若需要自动化，可在用户中心另发「个人访问令牌」（P2 可选），仍不是上游 Key。

### 4.3 多设备

| 规则 | 取值 |
|---|---|
| 同一账号活跃设备数 | **无上限** |
| 额度 | **账号级共享**同一订阅统一额度池（各设备合计消耗） |
| 退出 | 本机 `supplier.logout` 吊销该 refresh；用户中心仍可列出设备并远程吊销（便于丢设备），但不设数量门槛 |


## 5 桌面端行为

### 5.1 设置与可见性


| `supplier.loggedIn` | `supplier.advanced` | 模型 / 能力模型 / 向量来源   | 联网检索        | 默认                                                                 |
| ------------------- | ------------------- | ------------------ | ----------- | ------------------------------------------------------------------ |
| false               | false               | 显示（现状）             | 显示          | 用户自配或空                                                             |
| false               | true                | 显示                 | 显示          | 同上                                                                 |
| true                | false               | **隐藏**             | **隐藏**      | 主/轻量 + 七种 `capabilityModels` + `webSearch` +（若原为 local）向量改走 KepCup |
| true                | true                | 显示，厂商与能力下拉含 KepCup | 显示，含 KepCup | 可混用；Bot 可覆盖对话模型（D45）                                               |


「隐藏」不是删除配置：用户曾经填过的 DIY Key 仍留在 `secrets`，关掉高级配置只是 UI 与**默认路由**不再用它们。

设置页增加：

- 「账户」或「KepCup」分区：登录 / 退出、套餐名、用量进度条、打开用户中心（`openExternal`）、高级配置开关。
- 窄屏「我」tab 可放同一摘要（D82）。

### 5.2 对话与能力模型解析

登录且未开高级配置时（一次写齐，**不允许**只配 chat 而留下 image/asr 等空配置）：

- `defaultMainModel` / `defaultLightModel` → `kepcup/{chatModelId}`（具体 id **待定**，由目录 `defaults` 下发）。
- `capabilityModels.{embedding,rerank,multimodal,asr,tts,image,video}` 全部写成 `{ provider: 'kepcup', model: <目录 defaults 或服务端逻辑 id> }`（字段名是 **`provider`**，不是 `vendor`）。
- `embedding.source`：若为 `local` 或空，改为 `provider`（云端向量）；用户此后开高级配置可改回 local。
- `buildModelRegistry` 注册 `kepcup`：`baseUrl` = 供应商 API 根；auth 读 `supplier:access`（不是 `provider:kepcup`）；过期先 refresh。
- `MediaService`：按 `capabilityModels.*.provider` 路由——`dashscope` / `volcengine` 走既有 `VendorAdapter`；`kepcup` 走 KepCup 媒体适配器（Bearer 同上），覆盖 embed / rerank / understandImage / transcribeSpeech / synthesizeSpeech / generateImage / submitVideo+videoStatus（+ 可选 cancel）。
- 并发键：`providerConcurrency['kepcup']`。

打开高级配置时：

- 对话：`kepcup` 与 builtin / custom / dashscope / volcengine 并列；Bot 可混用。
- 能力：各 `CapabilityModelSection` 的 **provider** 下拉含 `kepcup` 与 DIY 国内厂商；可混用（例如对话走 KepCup、图片仍走 `dashscope`）。
- DIY Key 仍用 `provider:{id}` / `websearch:{provider}`，与供应商凭证并存。

### 5.3 联网检索

- `webSearch.provider = 'kepcup'`（扩展 `webSearchProviderSchema`）。
- 适配器 `POST /v1/web/search`，Bearer = access token；归一为既有 `SearchHit{title,url,snippet}`，语义与上限对齐现网（结果数上限 8、超时约 15s）。供应商内部可选用 tavily / brave / bocha 或其它上游，**对桌面只暴露一家 KepCup**；advanced 打开后用户仍可选回 tavily / brave / bocha 自备 Key。
- 未登录不能选 kepcup；登录且 advanced=false 时强制 kepcup。
- `web_fetch` **仍本机直连**（D62 SSRF 防护），不经供应商——它不是「可配置检索供应商」，中转抓页会放大 SSRF 与隐私面，首期明确不做。

### 5.4 Onboarding（修订模型步）

```text
欢迎 → 模型步三选一
        ├─ 登录 KepCup → 浏览器授权 → 写默认对话+七种能力+检索 / advanced=false
        ├─ 自行配置 → ProviderSetupForm（现状）→ advanced=true
        └─ 我有订阅 → D72 外部智能体（**始终保留入口**；与是否登录 KepCup 无关）→ advanced 不强制
     → 权限 → 沙箱 → 管家
```

- 跳过模型步：仍允许（`modelSkipped`）；主界面横幅可同时提供「登录 KepCup」与「去配置」。
- 管家访谈不依赖供应商已登录；但无任何模型可用时仍走 D58 `main-model` 卡（卡上增加登录入口）。

### 5.5 错误与引导


| 服务端 / 本地情况   | 客户端表现                                           |
| ------------ | ----------------------------------------------- |
| 未登录且无 DIY 模型 | D58 `main-model`（含登录按钮）                         |
| access 刷新失败  | 清登录态；横幅「登录已失效」；不自动弹浏览器                          |
| 402 / 额度用尽   | `SUPPLIER_QUOTA_EXCEEDED`；引导**升级订阅**或打开高级配置改走 DIY；不提供「按量加购超额」 |
| 403 套餐不含该模型  | `SUPPLIER_MODEL_FORBIDDEN`                      |
| 429          | 走既有模型重试（`model-retry.ts`）；耗尽后失败文案说明供应商限流        |
| 上游 5xx       | 重试后失败；日志只含供应商 request id，不含上游 Key               |


### 5.6 用量展示

- **本地** `usage_ledger`：每次成功 / 部分成功的模型调用照记，`provider='kepcup'`，`cost_usd` 可为 null（订阅制）或由响应头换算的估算（若服务端下发）。
- **供应商周期用量**：`supplier.usage` 拉取 `{ plan, creditTotal, creditSpent, percentUsed, periodStart, periodEnd, resetsAt }`——`percentUsed = creditSpent / creditTotal`（统一额度池）；设置页与侧栏展示；短缓存，登录后与关键错误后作废。
- 百分比以**服务端账本为准**；本地 `usage_ledger` 只做 Bot/loop 分析，不与信用金逐笔对齐。

## 6 服务端模块

独立仓库 `kepcup-supplier`：**Node.js + NestJS + PostgreSQL**；部署在 **`kepcup.com` 子域名**，与 D74 Cloudflare Workers / 静态 / 目录**独立部署**（可同注册域，不共用 Workers 运行时）。

| 模块       | 职责                                            |
| -------- | --------------------------------------------- |
| Auth     | 手机号短信、微信扫码、会话、设备授权码、refresh 吊销                |
| Gateway  | chat 兼容代理、**全能力媒体代理**、检索代理、鉴权、幂等、超时、流式 / 异步任务 |
| Router   | 模型 → 上游路由；多凭据轮替；失败换 Key / 换上游（策略可配）           |
| Pricing  | 对用户的模型/检索标价；内部峰谷成本；扣减信用金记账                 |
| Billing  | 三档订阅、统一额度池、Jeepay、按未使用额度比例退款（无降档）     |
| Metering | 按模型/检索单价扣减信用金；`percentUsed`；额度用尽硬拒绝          |
| Catalog  | 能力槽 → 当前选用模型/检索源；对桌面暴露目录与 defaults            |
| Admin    | 上游凭据与轮替、峰谷成本、按能力槽配置页（自由添加模型/检索并定价）、档位信用金 |
| Portal   | 用户中心（订购/升级、用量 %、设备列表与吊销、按量退款申请入口） |
| Risk     | 设备指纹辅助、异常用量、短信刷取防护（细节待定）                      |


### 6.1 上游与轮替

- 每个上游「渠道」：厂商类型、baseUrl、**多条 API Key**、适用模型列表、权重 / 优先级、冷却时间。
- 调用时按策略选 Key（轮询 / 最少近期 429 / 加权）；收到 429 / 特定 5xx 标记冷却并换下一条；**客户端不可见**轮替细节。
- 管理端为每个**应用能力槽**（主模型、轻量模型、embedding、rerank、multimodal、asr、tts、image、video、web_search）指定当前路由目标与对用户计价；可自由增删模型 / 检索源条目。用户侧请求到达后按槽位（或桌面带的逻辑 model id）选路上游，客户端不配置上游真实型号。

### 6.2 峰谷计价

管理员可配置：


| 能力   | 说明                                                        |
| ---- | --------------------------------------------------------- |
| 周期峰段 | 例如每周一至五 09:00–21:00（时区可配，默认 `Asia/Shanghai`）为峰，其余为谷       |
| 指定峰段 | 某段绝对时间（活动 / 故障）强制峰或强制谷                                    |
| 单价   | 每模型（或每模型组）峰 / 谷的输入 / 输出价格；**具体数字待定，文档用占位**                |
| 记账   | 网关在请求结束时按**结束时刻**或**首 token 时刻**落价（二选一，实现时钉死并写进 admin 说明） |


对用户：只看见**统一信用金额度池**与模型/检索标价（见 §7）。峰谷价主要用于**内部成本与对用户标价的调价依据**；用户账单按管理端公布的单价扣减信用金，不向用户展示「当前是峰段」。

### 6.3 幂等

- 客户端对非流式或可安全重试的请求带 `Idempotency-Key`（UUID）；网关对同一用户 + Key 在 TTL（建议 24h）内返回同一结果 / 同一上游请求 id，避免高级配置下重试导致双计费。
- 流式 chat：幂等键在「尚未开始上游调用」前重复到达则复用；已开始则返回冲突或继续原流（实现钉一种，推荐：**开流前去重，开流后第二次请求 409**）。
- 桌面侧：模型重试层在「尚未收到任何响应」时重试，应复用同一 Idempotency-Key（接入点在 `pi-engine` / 供应商 fetch 包装）。

### 6.4 API 形态（对桌面；**P0 全部具备**）

目录与默认：


| 端点                        | 用途                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/models`          | 返回按 `capability` 分组的模型列表（`chat` / `embedding` / `rerank` / `multimodal` / `asr` / `tts` / `image` / `video`）及推荐 `defaults`（主模型、轻量、各能力各一、检索说明） |
| `GET /v1/account/me`      | 套餐、设备、绑定手机掩码                                                                                                                                  |
| `GET /v1/account/usage`   | 周期用量百分比与重置时间（可附按能力粗分）                                                                                                                         |
| OAuth 授权 / token / revoke | 设备登录                                                                                                                                          |


调用：


| 端点                                                      | 对应桌面能力       | 备注                                                                                 |
| ------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `POST /v1/chat/completions`                             | chat（主 / 轻量） | OpenAI 兼容；SSE 流式；含视觉输入时可与 multimodal 模型重叠，由目录标注                                    |
| `POST /v1/embeddings`                                   | embedding    | 文本数组 → 向量数组；维度写入/校验与桌面 `embedding.dim` 一致                                          |
| `POST /v1/rerank`                                       | rerank       | `{ query, documents[] }` → 按分排序的 index 列表                                          |
| `POST /v1/images/understand`（名可微调）                      | multimodal   | 图 + 提示 → 文本；入参对齐 `understandImage`                                                 |
| `POST /v1/audio/transcriptions`                         | asr          | 音频 base64/上传 → 文本                                                                  |
| `POST /v1/audio/speech`                                 | tts          | 文本 → 音频；**HTTP 非实时**通道（与现网 dashscope 预置一致；实时 WebSocket 音色链路 DIY 也未作为设置项开放，供应商首期不做） |
| `POST /v1/images/generations`                           | image        | 文生图 / 带参考图编辑                                                                       |
| `POST /v1/videos/generations` + `GET …/videos/{taskId}` | video        | 异步提交 + 轮询；可选 cancel                                                                |
| `POST /v1/web/search`                                   | web_search   | `{ query, max_results }` → `SearchHit[]`；覆盖现有三家供应商的结果面                             |


路径命名以实现时 OpenAPI 为准；原则是**一一覆盖** `VendorAdapter` / `SearchService` 已暴露的语义，避免桌面为供应商再写一套平行业务逻辑。

错误体带稳定 `code`（`SUPPLIER_QUOTA_EXCEEDED` / `SUPPLIER_MODEL_FORBIDDEN` / …）。

**安全与日志**：禁止回显上游 Key / 账号 id；对账用内部 channel id 与计量字段（token 数、次数、扣减金额）。多媒体经 TLS **只转发**——**不记录**提示词、回复正文、图/音/视频载荷（可保留 request id、状态码、耗时、扣减金额等元数据）。

### 6.5 无法或不做中转的项（诚实边界）


| 项                               | 结论                                    |
| ------------------------------- | ------------------------------------- |
| 本机 jina 向量                      | 不中转；登录主路径改用云端 embedding               |
| `web_fetch`                     | 保持本机直连 + SSRF 防护                      |
| 上游实时 WebSocket TTS / 实时 ASR     | 现网设置项也未开放；供应商 P0 只做与 DIY HTTP 通道同级的能力 |
| 用户自备的 pi 内置 / 自定义 / 百炼 / 方舟 Key | 不上传、不代管；仅 DIY / 高级配置使用                |


## 7 套餐与支付

### 7.1 统一额度池（已定）

三档订阅价即写入该周期的**信用金总额**（具体信用金面值可与标价 1:1 或另定换算，实施时在管理端配置，本文不编造数字）：

| 档位 | 价格 | 含义 |
|---|---|---|
| 基础 | ¥69 / 月 | 信用金 C1；可调用能力全集（路由由管理端能力槽决定） |
| 专业 | ¥199 / 月 | 信用金 C2 ≥ C1；限流可更高 |
| 旗舰 | ¥599 / 月 | 信用金 C3 ≥ C2 |

计价规则：

- 管理端为**每一种模型、每一种检索源**配置对用户单价（按 token 和/或按次）。
- 每次成功（或计费策略认定成功）的调用按单价扣减信用金；`percentUsed = creditSpent / creditTotal`。
- **超额**：硬拒绝并返回 `SUPPLIER_QUOTA_EXCEEDED`，产品路径是**升级到更高档**；不做「超额按量加购」。
- 三档差异主要在信用金多少与限流，**不是**「低档不能用图片」——能力全集对已订阅用户开放，能否打到某上游由管理端槽位配置决定。

### 7.2 退款与档位变更（已定）

- **退款**：支持按**未使用信用金比例**退款（已消耗部分不退）；对接 Jeepay 退款接口与对账。
- **不支持降档**（例如 599 → 199）；用户可升级；周期结束可选择不再续费或改订其它档（改订低于当前档视为新周期新订，不继承「降档」语义——实施时在订单状态机写清）。
- 升档：付费成功后**立即**把信用金补差或切换到新档额度（实施时钉一种：补差 vs 重置周期）。

### 7.3 Jeepay

- 用户中心发起订购 / 升级 → 业务单 → Jeepay 统一下单 → 异步通知验签 → 发放或调整信用金。
- 查单补偿、关单、退款走 Jeepay；验签失败不得发权益。
- 桌面不直连 Jeepay，只打开用户中心或展示订阅状态。

### 7.4 用户中心

登录、订购与**升级**、用量百分比与简易消费明细、设备列表与远程吊销（无数量上限）、绑定手机 / 微信、按量退款申请、基础收据。与桌面共用 `usage` API。


## 8 与 KepCup 的集成锚点（实现时对照）


| 位置                                                | 改动要点                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` `settingsSchema` / `vendors.ts` | 增 `supplier`；`webSearchProviderSchema` 增 `kepcup`；**`capabilityModelSchema.vendor` → `provider: string`**（可 `kepcup`）；`vendorIdSchema` 保持仅 `dashscope`\|`volcengine` |
| `packages/shared` RPC                             | `supplier.login*` / `logout` / `usage` / `catalog`（目录含 defaults）                                                           |
| `packages/core/src/agent/models.ts`               | 注册 `kepcup` chat provider；Credential 走 supplier token                                                                      |
| `packages/core/src/media/`                        | 按 `provider` 分支：DIY `VendorId` 走原适配器；`kepcup` 走供应商媒体客户端（七种能力）                                                         |
| `packages/core/src/search/`                       | `kepcup` adapter                                                                                                           |
| `packages/core/src/domain/secrets.ts`             | 键名约定；退出时删除                                                                                                                 |
| `packages/core/src/apps/auth/callback-server.ts`  | 复用或抽公共库给 supplier                                                                                                          |
| `packages/core/src/apps/shell-facade.ts`          | 打开授权 / 用户中心 URL                                                                                                            |
| `packages/core/src/rpc/bindings.ts`               | 挂 RPC                                                                                                                      |
| `OnboardingWizard.svelte`                         | 模型步三选一                                                                                                                     |
| `ProviderSetupForm` / 设置导航                        | 按 `advanced` 与登录态显隐；账户分区                                                                                                   |
| `UsageSection.svelte`                             | 增加供应商周期 %                                                                                                                  |
| `SetupRequiredCard`                               | 登录入口                                                                                                                       |
| `usage_ledger`                                    | provider=`kepcup` 无需迁表                                                                                                     |


## 9 分期

### P0 — 登录 + 能力全集闭环（硬门禁）

- 服务端（Nest + PostgreSQL）：**手机号登录必须**；微信扫码**允许与登录一并完成，或按工作量紧随其后**（不因微信资质/工作量卡住「手机号可登录 + 全能力调用」）；设备 OAuth；能力槽管理与模型/检索定价；统一额度池计量；chat + 七种能力 + web_search 全部可调；用量 %；上游 Key 可先单条。
- 桌面：登录/退出；`provider` 字段改造；写齐 defaults；隐藏 DIY；Media/Search 走 KepCup；onboarding 三选一（含「我有订阅」）；失败码。
- 支付可先管理端手工入信用金；Jeepay 可并行启动但不阻塞能力联调。

### P1 — 商业化与韧性

- Jeepay 订购/升级/按量退款全流程；用户中心；多 Key 轮替；峰谷成本记账；幂等键；微信扫码若 P0 未做则本阶段补齐。
- 高级配置混用打磨；额度用尽升级引导。

### P2 — 扩展

- 个人访问令牌；年付；更细明细与发票预留；风控；生产加固；超出当前 DIY 设置面的实时 WebSocket 音视频另议。


## 10 风险与合规（开放标记）


| 项      | 说明                                                 |
| ------ | -------------------------------------------------- |
| 本地优先叙事 | 供应商是**可选加速器**；文案需写明「对话内容经 KepCup 服务器中转至模型上游」       |
| 内容与日志  | **已定：网关不记录提示词 / 回复 / 多媒体正文，只转发**；元数据（request id、状态、耗时、扣减）可记；对外宣传「不用于训练」须与上游协议一致 |
| 资质     | ICP、应用备案、短信、微信开放平台、支付商户号——上线门禁，非本设计可关闭             |
| 实名     | 是否强制；待定                                            |
| 未成年人   | 待定                                                 |
| 上游 ToS | 中转是否允许；按厂商条款选型                                     |


## 11 验收锚点（P0）

- 新装用户 onboarding 选「登录 KepCup」→ 授权成功 → DIY 分区隐藏；主/轻量模型、七种 `capabilityModels`（`provider:'kepcup'`）、`webSearch.provider` 已指向 KepCup；`embedding.source=provider`。三选一里「我有订阅」仍在。
- 管家可对话；`web_search` 返回归一结果；下列能力各至少一次真实探测成功（可用 `providers.test` / 媒体探测或等价）：embedding、rerank、multimodal、asr、tts、image、video（视频允许「提交即取消」）。
- 选「自行配置」→ 高级配置为开，行为与今日一致（含 local 向量与 tavily/brave/bocha）。
- `secrets` / RPC / 日志 / 界面中检索不到任何上游厂商 Key。
- 断网与吊销 refresh 行为同前：明确错误、可重新登录、不自动死循环弹窗。
- 高级配置下可混用：例如对话 / 检索走 KepCup，图片 `provider:'dashscope'` 自备 Key。
- 额度用尽返回升级引导；管理端改能力槽路由后，客户端无需发版即可打到新上游（目录刷新后）。
- 抽样检查网关日志 / 存储：无提示词、回复、多媒体正文残留。


---

## 修订记录

- 2026-10-11：初稿（D83）。基于对 `buildModelRegistry`、`SearchService`、`OnboardingWizard`、`usage_ledger`、D73 loopback、设置 schema 的只读摸底；价格档位按产品口述，额度与模型名显式留作待定。
- 2026-10-11：按产品要求将 **P0 范围改为 DIY 可配置能力全集**——对话 + embedding / rerank / multimodal / asr / tts / image / video + tavily/brave/bocha 等价检索面；删除「首期不做图片/音视频」「embeddings P2」等表述；补 §2.1 清单、§6.4 全端点、§6.5 不可中转边界（local 向量、`web_fetch`、实时 WebSocket 音视频）；分期与验收同步加严。
- 2026-10-11：消化 §12 十条拍板并删节——统一信用金额度池与按模型/检索定价、超额须升级；管理端能力槽自由配置与服务端路由；微信可与登录同期或按工作量稍后；设备无上限；网关只转发不记正文；子域名独立部署；只按未使用额度比例退款、不降档；onboarding 保留「我有订阅」；Nest + PostgreSQL；能力配置改用 `provider` 字段（方案 B）。文首标**已定稿，待实施**。


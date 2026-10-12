# KepCup 供应商（D83）：实施方案

> 状态：**已定稿，待实施**（设计重写与补充拍板：2026-10-12）。设计依据 [docs/design/34-supplier.md](../docs/design/34-supplier.md)（下称「34」）。
> 前置：[review-fixes-2026-10-12.md](review-fixes-2026-10-12.md) 的任务 2（媒体调用记账）。
> 补充拍板（2026-10-12）：
> ① 按监管要求设计：已备案上游、手机号实名、内容审核、生成内容标识、元数据日志 ≥6 个月、正文默认不持久化；
> ② Cloudflare 只承担连接应用 OAuth（D74），供应商部署在境内云，与本地功能完全解耦。
> 分支 / worktree：桌面侧建议 `t/d83-supplier` @ `/home/jyy/wt/kepcup-d83`。服务端是**独立仓库** `kepcup-supplier`，不在本仓库实现。
> **测试纪律**：开发中只跑定向测试，用 `node scripts/run-tests.mjs run <文件>`，在 `kepcup-test:trixie` 容器里跑；typecheck / lint 在宿主跑。本方案改动 shared 契约与 main 迁移，收尾全量跑一次，对照基线（33 个环境性失败）。

## 0. 总览与顺序

本方案是纯新增功能。桌面侧按与现有代码的耦合度从高到低排列；服务端在独立仓库推进，桌面侧通过 mock 服务联调。

| # | 任务 | 侧 | 规模 | 依赖 |
|---|---|---|---|---|
| 1 | 能力配置 `vendor` → `provider` 改名与读写迁移 | 桌面 | M | — |
| 2 | 托管叠加层 `effectiveModelConfig` | 桌面 | L | 1 |
| 3 | 账号登录（PKCE + loopback、single-flight、轮换 refresh） | 桌面 | M | — |
| 4 | 目录缓存与 `kepcup` 对话模型注册 | 桌面 | M | 2、3 |
| 5 | KepCup 媒体客户端、检索适配器、向量重建 | 桌面 | M | 2 |
| 6 | 调用可靠性：幂等键、并发键拆分、亲和、错误码 | 桌面 | M | 4、5 |
| 7 | 信用金记账与后台信用金预算 | 桌面 | S–M | 修正文档任务 2 |
| 8 | Bot 覆盖与后台路由规则 | 桌面 | S–M | 2 |
| 9 | UI：onboarding、登录确认与告知、设置、用量、消息状态 | 桌面 | L | 2–7 |
| 10 | Mock 供应商服务（桌面联调与测试夹具） | 桌面 | M | 与 3 同步 |
| 11 | 服务端核心 | 服务端 | L | — |
| 12 | 服务端合规能力与上线门禁 | 服务端 + 法务 | L | 11 |
| 13 | 商业化（Jeepay、用户中心） | 服务端 | L | 11（P1） |

- 任务 1 风险低，可以在 D85 的空档里先做。
- P0 = 白名单内测：桌面 1–10，服务端 11 与 12 中的技术部分。
- 公开上线 = 12 的资质门禁全部满足，加上 13。

## 1. 现状（2026-10-12 读取，以代码为准）

| 位置 | 现状 |
|---|---|
| `packages/shared/src/domain/types.ts` | `capabilityModelSchema = { vendor: vendorIdSchema, model }`；`webSearchProviderSchema = ['tavily','brave','bocha']`；`embeddingConfigSchema.source ∈ '', local, provider` |
| `packages/shared/src/domain/vendors.ts` | `vendorIdSchema = ['dashscope','volcengine']` |
| `packages/core/src/domain/settings.ts` | `get()` 严格解析，失败直接抛 `INTERNAL`；`dropUnknownVendors` 按 `capabilityModels.*.vendor` 把未知厂商置空 |
| `packages/core/src/agent/models.ts` | `buildModelRegistry` 同步构建；每次请求经 `auth.apiKey.resolve` 异步取 Key |
| `packages/core/src/media/service.ts` | `#resolve` 只认 DIY 厂商，Key 取 `provider:{vendor}` |
| `packages/core/src/search/` | 三家适配器，最多 8 条结果，HTTP 超时 15s |
| `packages/core/src/agent/llm-router.ts` | `routeFor`：有内置模型时后台 loop 优先内置 |
| `packages/core/src/agent/model-retry.ts` | 429 / 5xx 退避重试 |
| `packages/core/src/usage/budget.ts` | 每日后台预算按 token 统计 |
| `packages/core/src/apps/auth/callback-server.ts` | D73 loopback 回调服务（可复用） |
| main 迁移 | 当前最大编号 0034（`0034_mail_uid_validity.sql`）；新迁移在合并时取下一个空号 |
| `.vendor` 引用 | core、renderer 与测试中约 22 处 |

## 2. 桌面任务

### 任务 1 能力配置字段改名与迁移（34 §5.2）

- shared：
  - `capabilityProviderSchema = z.union([vendorIdSchema, z.literal('kepcup')])`；
  - `capabilityModelSchema = { provider, model }`；
  - `vendorIdSchema` 保持不变。
- `domain/settings.ts`：
  - 在 `storedSettingsSchema` 解析之前做预处理，把每个能力条目的 `vendor` 映射为 `provider`；
  - `dropUnknownVendors` 改为检查 `provider ?? vendor`，并接受 `kepcup`。
- 写出兼容：provider 为 DIY 厂商时同时写出 `vendor` 字段（降级到旧版本时能力配置不丢失）。
- 替换约 22 处 `.vendor` 读取（`grep -rn "\.vendor\b"`，排除 `vendorProviders` 等无关项）。renderer 中的 `CapabilityModelSection` / `EmbeddingSection` / settings store 同步修改。
- 测试：
  - 旧格式读入；新格式读入；
  - 含 `kepcup` 的设置被旧版 `dropUnknownVendors` 逻辑读入时不抛错；
  - 写出的 JSON 同时带 `vendor`；
  - `settings-service.test.ts`、`settings-providers.test.ts`、`media-service.test.ts` 定向通过。

### 任务 2 托管叠加层（34 §5.1）

- 新建 `core/src/supplier/effective-config.ts`，提供 `effectiveModelConfig(settings): { mainModel, lightModel, capabilityModels, webSearchProvider, embedding }`，规则如下：
  - 未登录 → 用户配置；
  - 已登录且 advanced=false（托管）→ 用目录 defaults，但用户原本 `embedding.source === 'local'` 时保留 local；
  - 已登录且 advanced=true → 用户配置（下拉里多出 KepCup）。
- 改造以下读取点，统一读有效配置：
  - `agent/models.ts`（默认主 / 轻量模型）；
  - `agent/llm-router.ts`；
  - `media/service.ts#resolve`；
  - `search/service.ts`；
  - `memory/service.ts`（向量来源与模型）；
  - D58 setup 判定（无可用模型时的 Setup 卡）。
- **托管模式不写回**用户的设置字段。
- 测试：三种状态 × 各读取点；托管 → 退出登录 → 用户原配置生效；托管模式下 settings 中的用户字段保持不变。

### 任务 3 账号登录（34 §4.2）

- 新建 `core/src/supplier/account.ts`：
  - PKCE + loopback 授权，复用 `apps/auth/callback-server.ts` 的约束：Host 校验、state、超时、无脚本结果页；
  - 通过 `shell-facade` 打开授权页；
  - 用 code 换 token 后写入 secrets：`supplier:access`、`supplier:refresh`；
  - `settings.supplier.account` 只存非敏感摘要。
- 刷新：
  - single-flight，并发请求共享同一个刷新 Promise；
  - refresh token 轮换；
  - 请求返回 401 → 刷新一次并重放一次；
  - `invalid_grant` → 清除凭证并转为未登录；
  - 网络错误 → 保持登录态，标记离线。
- 退出：调用 revoke，删除 secrets，清空 `account`。
- RPC：`supplier.login` / `supplier.logout` / `supplier.account`。
- 测试（对接 mock 服务）：并发 10 个请求时只刷新一次；轮换后旧 refresh 失效；`invalid_grant` 后有效配置回落为用户配置。

### 任务 4 目录缓存与对话模型注册（34 §5.3、§6.1）

- `settings.supplier.catalog` 缓存目录：版本号、逻辑 id 契约、defaults。
- 拉取时机：登录后；启动后在后台拉取；每 6 小时；收到 `SUPPLIER_CATALOG_STALE` 时。
- `buildModelRegistry` 按目录注册 `kepcup` provider：
  - `baseUrl` = 供应商 API 根；
  - `resolve` 取 access token（必要时触发刷新）；
  - `contextWindow` / `maxTokens` / `input` / `reasoning` 全部取自目录契约。
- 离线启动时用缓存的目录构建注册表。
- 测试：用缓存离线构建；目录版本变化后注册表随之更新；契约字段正确映射。

### 任务 5 媒体客户端、检索适配器、向量重建（34 §5.4、§6.4）

- `core/src/supplier/media-client.ts`：实现与 `VendorAdapter` 同语义的 KepCup 版本，覆盖 embed / rerank / understandImage / transcribeSpeech / synthesizeSpeech / generateImage / submitVideo + videoStatus + cancel。生成的媒体通过供应商签名 URL 下载。
- `search/adapters.ts` 新增 `kepcup` 适配器（`POST /v1/web/search`）；`webSearchProviderSchema` 增加 `kepcup`。
- 连通性测试改走 `POST /v1/probe/{capability}`（免费）。
- 向量：有效向量模型 id 变化时，按现有机制入队 `memory_vec_rebuild`，并通过 `app.notice` 提示「正在重建记忆索引（将消耗额度）」。
- 测试：mock 服务覆盖七种能力与检索；向量 id 换代触发重建；保留 local 的托管用户不触发重建。

### 任务 6 调用可靠性（34 §5.4、§5.8、§6.3）

- 幂等：
  - 非流式请求生成 `Idempotency-Key`；
  - `model-retry.ts` 与媒体客户端在「尚未收到任何响应」时重试，复用同一个 Key。
- 并发键：对话用 `kepcup`，媒体与向量用 `kepcup:media`。
- 亲和：对话请求带 `X-KepCup-Affinity`（会话 id 的哈希）。
- 错误码（shared）：`SUPPLIER_AUTH_EXPIRED`、`SUPPLIER_QUOTA_EXCEEDED`、`SUPPLIER_MODEL_FORBIDDEN`、`SUPPLIER_CATALOG_STALE`、`SUPPLIER_CONTENT_BLOCKED`、`SUPPLIER_ACCOUNT_RESTRICTED`。
  - `CONTENT_BLOCKED` / `QUOTA` / `FORBIDDEN` / `RESTRICTED` 不重试；
  - 后台 loop 遇到 `CONTENT_BLOCKED` 时跳过该任务（不 fail、不重试）。
- 流内审核中止事件：已收到的内容按服务端指示撤下或截断，消息标记「内容已被中止」（新增消息状态字段或元数据，按 01 号消息模型选择最小改动）。
- 测试：模拟 5xx 重试时只发生一次扣费（mock 端校验 Key）；内容拦截不重试；后台 loop 跳过。

### 任务 7 信用金记账与预算（34 §5.6）

- main 新迁移（取下一个空号）：`usage_ledger` 增加 `credit_spent INTEGER NULL`（单位：分）。
- KepCup 响应头 `X-KepCup-Charge` 写入 `credit_spent`；同时适用于对话与媒体调用（媒体调用记账来自修正文档任务 2）。
- `budget.ts`：增加可选的按 Bot「每日后台信用金上限」，托管模式下默认开启一个保守值（具体值实现时定，并写入设置说明）。
- `supplier.usage` RPC 拉取服务端周期用量，短缓存。
- 测试：迁移测试；信用金上限触发 defer；token 预算行为不回归。

### 任务 8 Bot 覆盖与后台路由（34 §5.3）

- 托管模式下：
  - Bot Profile 的 `main_model` / `light_model` 指向 KepCup 目录 → 生效；
  - 指向 DIY 厂商 → 保留但不生效，Bot 面板提示「高级配置下生效」。
- Bot 选择外部智能体引擎（D72）始终生效。
- `LlmRouter`：托管模式下「内置模型」即 KepCup，登录确认页必须告知 D72 订阅用户：后台 loop 将改为消耗信用金。
- 测试：路由矩阵（托管 / 高级 × 有无 Bot 覆盖 × 有无 ACP 引擎）。

### 任务 9 UI（34 §5.1、§5.7、§7）

- Onboarding 模型步改为三选一：登录 KepCup / 自行配置 / 我有订阅。
- 既有用户在设置里登录时，出现确认页：托管，或仅把 KepCup 加入可选项（默认托管）；并展示告知文案（内容经 KepCup 发送至第三方模型提供方处理；D72 用户的后台路由提示）。
- 设置：
  - 新增「账户 / KepCup」分区：登录、退出、套餐、用量进度、打开用户中心、高级配置开关；
  - 托管模式下，模型 / 能力模型 / 向量来源 / 联网检索分区收起为一行摘要；
  - 窄屏「我」tab 显示账户摘要（D82）。
- Bot 面板模型选择：托管模式只列目录模型，DIY 覆盖加标注。
- 消息渲染：「内容已被中止」状态；KepCup 来源回复显示「AI 生成」提示（形式以法务认定为准，先做成可配置）。
- `UsageSection.svelte`：显示供应商周期用量与信用金。
- `SetupRequiredCard` 增加登录入口。
- 测试：渲染层组件单测；e2e 走一遍 mock 登录 → 托管 → 退出。

### 任务 10 Mock 供应商服务

- 在 `packages/testkit` 中实现最小 mock：
  - 授权（PKCE）、token、轮换、revoke；
  - `/v1/catalog`、`/v1/account/*`；
  - chat SSE（可注入审核中止事件）、七种能力、检索、probe；
  - 幂等校验与扣费计数、402 / 403 / 409 / 429 注入。
- 作为桌面 1–9 的测试夹具，也供服务端联调前的对接验证使用。

## 3. 服务端任务（独立仓库 `kepcup-supplier`）

> 这部分在独立仓库开工，本节是范围清单。实施细节在该仓库的方案文档中展开。

### 任务 11 服务端核心（34 §6）

NestJS + PostgreSQL，部署在境内云。模块：

- Auth：手机号短信；微信扫码，强制绑定手机；设备授权码；轮换 refresh；吊销。
- Gateway：chat SSE、全能力媒体、检索、鉴权、幂等、亲和、超时。
- Router：逻辑 id → 渠道；契约校验；多 Key 轮替与亲和粘滞；**只允许已备案模型**，渠道上记录备案号。
- Catalog：逻辑 id 契约与 defaults；向量 id 永久绑定。
- Metering：预占 / 结算 / 释放；流式中断结算；视频任务结算；免费 probe；预占过期释放。
- Admin：渠道与 Key、能力槽路由与定价、档位信用金、手工入账（P0 无支付）。

### 任务 12 合规能力与上线门禁（34 §7）

- 技术部分（P0）：
  - 输入 / 输出审核：文本与图像；流式分段审核与中止；
  - 生成媒体的显式与隐式标识，经供应商域名的短时签名 URL 交付，到期删除；
  - 元数据网络日志 ≥6 个月；正文不落盘；审核命中样本与处置记录加密留存、访问留痕；
  - 违规处置工作台。
- 资质部分（公开上线门禁，法务主导）：
  - ICP 经营许可证；
  - 生成式 AI 服务登记或备案（以法务认定为准），以及安全评估材料；
  - 算法备案（如适用）；
  - 等保（建议二级）；
  - 短信签名、微信开放平台、支付商户号；
  - 未成年人保护措施；
  - 服务协议与隐私政策。

### 任务 13 商业化（P1）

- Jeepay：订购、升级、按未用额度比例退款，异步通知验签，查单补偿。
- 用户中心：订购 / 升级、用量、设备管理、退款申请、投诉举报、账号注销、个人信息导出。

## 4. 收尾

- 全量测试跑一次（shared 契约与迁移）。
- 更新 `docs/design/34-supplier.md` 状态行与 README 的 D83 行。
- `docs/dev/PROGRESS.md` 记录实现与测试证据。

## 5. 非目标（本期）

个人访问令牌；年付与发票；实时 WebSocket 音视频；海外支付与海外模型；中转 `web_fetch`；供应商代管连接应用令牌（D73 / D74 不变）。

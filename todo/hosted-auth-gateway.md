# 托管授权网关（auth.kepcup.com / mcp.kepcup.com）— 任务书（D73 P4，**未实现，默认不建**）

> 状态：仅任务书，未开工（2026-10-10）。它是 `todo/connected-apps.md` §8 第一项的展开，给后续编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。上游设计：`docs/design/29-connected-apps.md` §11.7（托管授权网关）、§15.3（Cloudflare 方案）、§5（授权引擎）、§8（审批与安全）、§14 #4 / #6。
>
> **默认立场：不建。** 能本地直连的平台一律本地直连；网关是**例外通道**，只有 §1 的决策清单全部满足、且用户明确批准后才启动 G1 及以后（G0 只是决策与法务，不写代码）。
>
> **前置（已有，网关复用而非重写）**：
>
> - 客户端的 MCP OAuth 全链路（P0–P3）：`packages/core/src/apps/auth/{flow,runtime-provider,registry}.ts`、`apps/token-vault.ts`、`apps/connections.ts`、`apps/oauth-clients.ts`。**网关对客户端而言就是一个"支持 CIMD 的普通远程 MCP server + 授权服务器"**，所以交互授权、运行时刷新、断开吊销、工具锁定、风险分级、污点外发全部原样生效，不需要新的授权路径（§6）。
> - CIMD 文档 `infra/cloudflare/oauth-cimd/`（`https://kepcup.com/oauth/client.json`，`KEPCUP_OAUTH_CLIENT_ID`）；子注册表 `infra/cloudflare/registry/`（`com.kepcup/*` 命名空间留给 KepCup 自有 server）；校验器 `packages/app-validator`（`kepcup-app validate --auth`，可直接拿来验网关）；测试假服务 `packages/testkit/src/fake-oauth-mcp-server.ts`。
>
> **硬约束**：
>
> - 只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。
> - 标注「**用户待办**」的事项（Cloudflare 套餐 / 资源、域名、平台应用注册、法务页面、DPA、密钥）由用户完成，Agent 只做准备与验证脚本，不要尝试代为登录或注册（见 §13）。
> - **令牌离开本机是该特性的本质**，因此：连接卡必须明示「经 KepCup 服务器中转」；网关**绝不**存工具入参 / 结果、**绝不**记录令牌或请求体；第三方令牌**永不**下发给客户端（MCP 规范 URL elicitation 一节的硬性要求，见 §15 参考）。
> - 客户端既有契约零回归：令牌明文只出现在 core 发请求的那一刻；本任务书不改变任何本地直连平台的行为。
> - 外部协议 / 库 API 细节凡标注「实现时核对」的，开工时必须对照当时的官方文档确认后再写代码。

## 0. 先读什么（按顺序）

1. 设计 29 §5.6（运行时 / 交互授权分离——网关**不得**改变它）、§8.2 / §8.3（工具锁定、污点）、§11.7、§15.3、§14 #4 / #6。
2. 代码：`apps/auth/flow.ts`（客户端身份选择 `resolveIdentity`：BYO → 预注册 → 已存 DCR → CIMD → DCR）、`apps/auth/runtime-provider.ts`（`ConnectionAuthProvider` 只做标准 `refresh_token` 刷新，失败抛 `AppAuthRequiredError`）、`apps/disconnect.ts`（`AppDisconnector`：RFC 7009 先吊销再清 Vault）、`apps/catalog.ts` + `packages/shared/src/domain/connector-catalog.ts`（`connectorAuthSchema`：`kind` / `registration` / `clientRef`）、`apps/directory-merge.ts`（`builtin` 条目端点 / 认证钉死）、`mcp/service.ts`（`#authProviderFor` / `#emitNeedsAuth`）。
3. 外部资料（本任务书 §15 列出，开工时重新打开；以下为 2026-10-10 联网读到的版本）：Cloudflare `workers-oauth-provider` README 与 `docs/{authorization-server,advanced-configuration,upstream-sign-in,consent-page}.md`；Agents SDK「MCP handler APIs」；MCP Authorization 2026-07-28；MCP Elicitation（URL 模式）。
4. `todo/developer-portal.md`（同为 Cloudflare 服务端任务书：目录结构、内存适配器测试做法、SSRF 与 Turnstile 经验可照搬）与 `infra/cloudflare/registry/{README.md,schema.sql,test/helpers.ts}`（`D1Like` 风格内存适配器）。

## 1. 何时启动：决策清单（G0 的产出）

### 1.1 触发条件（至少满足一条，且逐平台论证）

某个**用户确实需要**的平台无法用「本地客户端身份」接入，具体指下列之一：

1. 平台只发**保密客户端**（必须带 client secret，且不接受 PKCE-only 的公共客户端），secret 不能随桌面应用分发；
2. 平台只接受 **https 的固定回调地址**，不接受 RFC 8252 回环（`http://127.0.0.1:{port}`）；
3. 平台要求**服务端持有**经审核的应用（例如审核只面向 Web 应用，或只为服务端回调发放生产资格）；
4. 平台的访问策略要求**固定出口 IP / 域名**（企业 allowlist）。

### 1.2 先排除的更便宜方案（全部"不可行"才允许建网关）

| 方案                                                            | 适用                               |
| --------------------------------------------------------------- | ---------------------------------- |
| 预注册**非保密**桌面 / 原生客户端（`oauth-clients.json`，U3/U4） | Google（Desktop app）、Entra 等    |
| CIMD / DCR 直连（`registration: auto`）                         | Notion、Linear 等开放注册的服务端  |
| 用户自带客户端（BYO，`apps.setClientCredentials`）              | 开发者、企业自建                   |
| `api-key` 类连接（`auth.kind: 'api-key'`）                       | 只提供 API key / PAT 的服务        |
| 厂商官方远程 MCP（令牌留在本机）                                 | 绝大多数                           |
| 等厂商支持 CIMD / 公共客户端，或向厂商申请合作                   | Figma（白名单）、GitHub（CIMD 待核；2026-10-10 用户决定 GitHub **推迟到本网关**——GitHub App / OAuth App 都要求 client secret，是首批候选之一） |

> 网关**解决不了**"平台不让 KepCup 接入"的问题（如 Figma 的客户端白名单）：网关在平台眼里仍是 KepCup 的一个应用，同样要过平台审核。它只解决"客户端形态不被接受"。

### 1.3 当前候选清单（2026-10-10，**全部待 G0 实测确认**）

- Slack：设计 29 §1.4 记为「只允许 Marketplace 发布或工作区内部应用」——这是**审核**问题而非客户端形态问题，网关不能绕过；是否接受公共客户端 + 回环回调「实现时核对」。
- Google / Microsoft 365：桌面公共客户端可行，**不需要网关**。
- 结论：**目前没有一个已确认需要网关的平台。** 本任务书为"将来出现"准备，G0 之前不得写任何 G1+ 代码。

### 1.4 G0 决策记录（每个候选平台一份，写进本文件末尾「决策记录」，用户批准）

- [ ] 平台、用户价值（有多少用户要、没有它损失什么）、1.1 的哪一条、1.2 每个替代方案为何不可行（附官方文档链接与日期）。
- [ ] 平台是否允许"第三方服务端代用户持有令牌"（开发者条款，如 Google API Services User Data Policy 的 Limited Use 要求、Slack 的 API 条款）「实现时核对」。
- [ ] 最小 scope 清单与对应的读 / 写工具清单（网关只暴露 KepCup 自写的工具，见 §4.3）。
- [ ] 法务：隐私政策、DPA、子处理者清单、数据地域（§9）；用户确认接受**令牌离开本机**这一产品代价。
- [ ] 成本测算（§10）与回滚预案（§10 的 kill switch）。
- 验收：用户在决策记录上明确写"批准启动 G1"。否则任务书保持原状。

## 2. 目标与非目标

**目标**：对 §1 批准的平台，用户在 KepCup 里点「连接」→ 系统浏览器完成第三方授权 → Bot 照常调用该应用的工具；与本地直连的体验一致，仅多一个诚实的披露与服务端依赖。

**不做（明确）**：

- 不做 KepCup 账号体系 / 登录页 / 付费（设计 29 §14 #6：仅当 §5 的身份方案无法成立时才另立设计）。
- 不做通用 MCP 代理 / 聚合商（不代理任意第三方 MCP server，不转发客户端令牌——令牌透传被规范禁止）。
- 不做令牌云同步 / 多设备共享连接（一台设备一份授权，换设备重新连接）。
- 不存、不读、不分析用户的工具入参与结果（网关只是内存里的管道）。
- 不为"本地直连可行"的平台建网关；不把网关作为默认来源。
- 不引入 Nango / Composio 等第三方中间件（设计 29 §11.7 已否决 Nango：需 Postgres + Redis）。
- 不做 DPoP / mTLS 绑定令牌（列为 G5 可选，§12）。
- 不在本任务书内实现企业 EMA（见 `todo/enterprise-ema.md`）。

## 3. 用户可见的诚实披露

- 目录卡与连接卡（`apps/desktop/src/renderer/src/lib/features/apps/` 下的目录网格与连接详情组件）对网关连接加固定标签 **「经 KepCup 服务器中转」**，副文案：「你的 {平台} 授权令牌保存在 KepCup 服务器（欧盟），用于代你调用 {平台}；工具的输入输出会经过该服务器但不会被保存。」点击进入隐私政策对应章节。
- 首连确认步（既有 `reviewing_tools` 复核页）追加一行同样的披露，并要求勾选「我理解令牌将保存在 KepCup 服务器」（模式照搬 P3 社区应用的 `acknowledgeCommunity`：渲染端勾选 + core 强制，缺确认 → `INVALID_INPUT`）。
- Bot 详情 / 审批卡的账号行不变；审计 `app_connect` 明细增加 `relay: 'kepcup-gateway'`。
- 网关挂了或被停用时，连接状态为 `error`（保留授权），文案区分「KepCup 网关不可用」与「平台不可用」。
- 设置里可一键「断开并删除服务器上的数据」（= `apps.disconnect`，见 §6.4 的语义）。

## 4. 服务端架构（Cloudflare，设计 29 §15.3）

```
KepCup 桌面 ──(A) MCP OAuth(CIMD) ──► auth.kepcup.com   授权服务器（workers-oauth-provider）
     │                                   │  /authorize → 同意页 → 跳第三方 → /callback/{provider}
     │                                   ▼
     └──(B) MCP(Streamable HTTP) ──► mcp.kepcup.com/{provider}/mcp   资源服务器（Agents SDK createMcpHandler）
                                         │  校验网关令牌 → 取该用户的上游令牌 → 调用平台 API
                                         ▼
                                    UpstreamVault（Durable Object，eu 管辖区）  ──(C)──► 平台 API / 平台 OAuth
```

### 4.1 授权服务器（A 段：KepCup ↔ 网关）

- 用 `@cloudflare/workers-oauth-provider`。2026-10-10 读到的 README 是 1.x 形态：`OAuthAuthorizationServer`（授权服务器）+ `OAuthResourceServer`（资源服务器，经 Service Binding 调 `validateToken`）分角色部署，单 Worker 的 `OAuthProvider` 仍支持「实现时核对 API 形态与版本」。推荐**分角色**：`auth.kepcup.com`（AS）与 `mcp.kepcup.com`（RS）两个 Worker，经 Service Binding 通信，`resources` 列出每个平台的规范 URI（`https://mcp.kepcup.com/{provider}/mcp`，令牌按 RFC 8707 绑定受众，A 平台的令牌**打不开** B 平台）。
- 打开 `clientIdMetadataDocumentEnabled: true`，`wrangler.jsonc` 加兼容标志 `global_fetch_strictly_public`（库文档：缺其一则不会宣告 `client_id_metadata_document_supported`；此标志用于 CIMD 抓取的 SSRF 防护）。客户端身份就是既有的 `KEPCUP_OAUTH_CLIENT_ID`；**不开 DCR**（`disallowPublicClientRegistration` 之类选项「实现时核对」），避免任何人给自己注册客户端去钓鱼。
- 存储：库要求绑定 KV `OAUTH_KV`（授权码、授权记录、令牌哈希；库 `storage-schema.md` 说明令牌 / 授权码 / 密钥只存哈希，`props` 用只有令牌持有者能解开的密钥加密）。KV 最终一致、免费版每日写 1000 次（设计 29 §15）→ 需 Workers Paid；同一授权码的并发兑换窗口等已知限制以库文档为准「实现时核对」。
- 令牌寿命：`accessTokenTTL` 短（建议 15 分钟～1 小时，库下限 60 秒）；`refreshTokenIdleTTL` 滑动（建议 30 天不用即过期，与 §9 保留期一致）；刷新令牌轮换由库完成（库文档：新旧两个令牌都能恢复一次丢失响应的刷新）。
- 上游失败的映射（库文档 `upstream-sign-in.md`）：上游刷新答 `invalid_grant` → 在 `tokenExchangeCallback` 抛 `OAuthError('invalid_grant')`（库会撤销该授权，客户端 `ConnectionAuthProvider` 收到永久失败 → 连接 `expired` → 重连卡）；上游暂时故障 → 抛 `temporarily_unavailable`（客户端 `token()` 的临时故障分支：令牌未过期则继续用，见 `runtime-provider.ts`）。
- `onError` 把库的 `internal.category / reason` 映射成指标（§11），**不**把 `detail` 原样写日志。

### 4.2 资源服务器（B 段：MCP）

- 用 Agents SDK `createMcpHandler`（无状态 Streamable HTTP；`McpAgent` 已废弃且功能冻结，不采用；对仅支持 2025-11-25 有状态握手的客户端的兼容性**必须实测**——KepCup 现用 `pi-mcp@1.0.2`，只说到 2025-11-25，见 `connected-apps.md` 附录 B.6）。`allowedHostnames: ['mcp.kepcup.com']`，`corsOptions` 收紧（桌面客户端不是浏览器，Origin 缺省本就合法；浏览器 Origin 一律拒绝）。
- 认证上下文：库的 `ctx.props` / `ctx.auth`（SDK v2 回调里是 `context.http.authInfo`）；handler 里**自己**校验 scope（库只宣告 `requiredScopes`、不替你执行），不足则返回 403 + `WWW-Authenticate: Bearer error="insufficient_scope" scope="…"`——正是客户端 step-up（设计 29 §5.4）已支持的路径。
- 无状态意味着没有服务端推送：`tools/list_changed` 收不到，客户端靠 `MCP_TOOL_LIST_CACHE_MS` 过期 / 手动刷新（B.6 已分析，客户端无需改）。

### 4.3 工具面：只暴露 KepCup 自写的工具

- 网关**不是**通用代理：每个平台一组由 KepCup 编写、审阅的工具（如 `slack_search_messages`、`slack_post_message`），逐个带 `title`、`readOnlyHint` / `destructiveHint` / `openWorldHint` 注解、读写拆分、名称 ≤ 64（`kepcup-app validate` 的全部规则，G3 以它为门禁）。这样风险分级（`core/mcp/risk.ts` 注解优先）才可靠，且不存在"恶意第三方 MCP server"（§8 威胁表）。
- 工具实现只做：校验入参（zod）→ 取上游令牌 → 调平台 API（固定主机白名单，§8 SSRF）→ 瘦身后返回。**不落盘、不打日志**。
- 工具契约变更 = 网关发布 = 客户端按既有工具锁定（设计 29 §8.2）弹复核。发布流程要求：工具清单的 `tool_contract_hash` 写进发布说明；`builtin` 条目可在应用发版时预批准已知哈希（设计 29 §14 #8）。

### 4.4 上游令牌保险库（C 段）

选型比较（**推荐 B**，其余记录在案）：

| 方案                         | 做法                                                                                        | 优点                                         | 缺点 / 否决理由                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A 库自带 `props`             | 上游令牌放 `completeAuthorization({ props })`，在 `tokenExchangeCallback` 里随刷新轮换        | 服务端静态时无法解密（密钥由用户令牌包裹）；零额外存储 | 绑定单个授权（用户 × 客户端）；断开时**无法替用户撤销上游令牌**（没有明文）；运营方无法在滥用时主动吊销 |
| **B Durable Object 保险库**   | 每个 `(provider, 上游账号)` 一个 DO（SQLite 后端，`eu` 管辖区），内含加密的上游令牌，单写者串行刷新 | 刷新令牌轮换天然串行；可在断开 / 滥用时主动吊销；元数据可审计 | 服务端持有密文 + 密钥，信任模型比 A 弱（靠应用层加密与运营纪律缓解）                              |
| C D1 表 + 应用层加密          | 同 B，行存 D1                                                                                | 简单                                         | 刷新并发要自己做锁；D1 有 Time Travel 备份（密文长期保留，与删除承诺冲突）「实现时核对」           |

**B 的细则**：

- DO 命名 = HMAC(服务端密钥, `provider|上游账号id`)，不用明文账号 id；D1（可选）只存**非机密**索引：`(vault_id, provider, status, created_at, last_refresh_at)`，**不存令牌、不存邮箱**。
- 应用层加密：AES-256-GCM；每用户密钥 = HKDF-SHA256(主密钥 `KEK_vN`, salt = vault_id, info = `kepcup-gw-vault`)；随机 96 位 nonce（每次写都换）；AAD = `vault_id|provider|version`；记录带 `kid`（主密钥版本）。主密钥放 Worker secret（Secrets Store 仍为 beta，设计 29 §15.2），**离线备份**（丢失 = 所有上游令牌作废，全员重连）。
- 轮换：新增 `KEK_v(N+1)`，读到旧 `kid` 时解密后用新密钥重写（惰性迁移）；旧版本在全部迁移完成（或最长 30 天，与刷新令牌空闲期对齐）后删除；演练写进运维手册（G4）。
- 管辖区：`eu`（创建后不可改；DO 命名空间的 `jurisdiction('eu')` 与 D1 创建参数「实现时核对」；设计 29 §15.3 已定：不依赖企业版 Data Localization Suite）。注意：Worker 代码仍在全球边缘执行，处理中的明文可能出现在非 EU 的数据中心——**隐私政策必须如实写"存储在欧盟，处理发生在最近的边缘节点"**（法务确认 §9）。
- 刷新单飞：所有上游刷新都在该 DO 内串行；上游返回新刷新令牌必须**先写入再返回**；上游 `invalid_grant` → 置 `revoked` 并让库侧授权失效。
- 吊销：RFC 7009 `/revoke`（客户端断开时调用）→ 先调平台吊销端点（若有）→ 删除 DO 内容 → 幂等返回 200。平台无吊销端点时仅删除本地并在隐私页说明用户需到平台"已授权应用"页手动移除。

## 5. 身份：没有 KepCup 账号体系时，用什么标识"同一个用户"？（**待用户决定**）

网关需要一个稳定的 `userId` 来：绑定授权记录与上游令牌、做账号关联页的"同一用户"校验、做限流与滥用封禁。

| 选项                                          | 做法                                                                                                                              | 评价                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **I1 上游账号即身份（推荐）**                 | 每个平台一个资源；`/authorize` 把用户送去该平台登录，回调后 `userId = {provider}:{平台账号稳定id}`（Slack 为 team+user，Google 为 `sub`）| 零账号体系、零额外 PII；库的 `upstream-sign-in` 流程就是这个形态；多账号 = 多个授权（与 KepCup 多连接模型一致）；`__Host-` 绑定 Cookie 天然把"发起者"与"完成者"绑在同一浏览器 |
| I2 设备绑定密钥                               | 桌面端生成密钥对，用 DPoP（RFC 9449）或 `private_key_jwt` 向网关证明"同一台设备"                                                   | CIMD 文档是静态共享的，**无法承载每设备公钥**；DPoP 在库中的支持「实现时核对」；工程量大。作为 G5 可选的"令牌绑定设备"增强而非身份 |
| I3 OAuth 设备码流程（RFC 8628）登录 KepCup 账号 | 需要账号体系                                                                                                                       | 违背"不做账号体系"，除非 I1 不成立才考虑                                                                                               |
| I4 邮箱魔法链接                               | 同上                                                                                                                              | 同上，且引入邮件通道与 PII                                                                                                             |

**推荐 I1**，并记为开放决策 Q1。I1 的已知代价：用户换了平台账号 = 新身份；平台账号被封 = 授权失效（本就如此）。

## 6. 客户端侧改动（KepCup 桌面）

> 原则：**尽量不动授权引擎**。网关在客户端眼里就是普通 MCP OAuth。

### 6.1 目录与 schema

- `connectorAuthSchema`（`packages/shared/src/domain/connector-catalog.ts`）：`registration` 枚举新增 `'hosted'`（语义：客户端身份固定为 CIMD、授权服务器是 KepCup 网关；`kind` 必须 `oauth`、`clientRef` 必须 `null`）。另加可选 `relay: { operator: 'kepcup', provider: string }`。**不新增 `auth.kind: 'hosted'`**——授权方式仍是 OAuth，变的只是"谁持有令牌"，放在 `registration` / `relay` 上更准确（若实现时更倾向于 `kind`，需同步改动 `AppCatalogEntry.authKind` 等所有消费方，评审决定）。
- 防冒充（重点）：`superRefine` + `directory-merge.ts` 双重约束——`registration: 'hosted'` **仅允许** `tier: 'builtin'`，且 `remotes[0].url` 的主机必须在 shared 常量 `HOSTED_GATEWAY_HOSTS`（`['mcp.kepcup.com']`）内；签名目录里的远端条目、`community` / `verified` / `developer` 条目声明 `hosted` 一律丢弃并计入 `drops`（沿用现有 drop 原因机制，新增 `hosted_not_allowed`）。否则第三方可以借"经 KepCup 服务器中转"的标签获得信任，或反过来把别人的服务器伪装成 KepCup 网关。
- `ConnectorCatalog`（`apps/catalog.ts` 的 `#unavailableReason`）：网关全局关闭（remote kill switch，§10）或 `settings.apps.hostedGateway === false` 时，hosted 条目 `connectable: false`，`unavailableReason` 说明。

### 6.2 授权流程（`apps/auth/flow.ts`）

- `resolveIdentity`：hosted 条目**只能**走 CIMD（授权服务器元数据声明 `client_id_metadata_document_supported`）；否则中止（`OAUTH_FLOW_FAILED`），**不退回 DCR**——与预注册条目"绝不退回 DCR / CIMD"同一思路，且校验发现到的 `issuer` 等于常量 `HOSTED_GATEWAY_ISSUER`（防止被重定向到别的授权服务器）。
- 授权端点主机校验：现有"自定义 / developer 需用户核对授权主机"逻辑对 hosted 条目按 `builtin` 处理（主机固定为 `auth.kepcup.com`）。
- `reviewing_tools` 事件新增 `relay` 字段，渲染端据此显示披露与确认勾选（§3），core 在 `confirmTools` 强制（照 `tierRequiresConnectAck` 的写法新增 `relayRequiresAck`）。

### 6.3 连接行与 Token Vault

- `app_connections` 新增 `relay TEXT NULL`（迁移 `{N}_app_connection_relay.sql`，`N` 为届时 main 的下一个空号，见 `connected-apps.md` §2.1）：存 `kepcup-gateway:{provider}`。理由：目录条目可能下架或被改，标签与审计必须独立于目录；`AppConnection` 视图加 `relay`。（可选替代：由 `issuer === HOSTED_GATEWAY_ISSUER` 推导，省迁移；实现时二选一并记入 DEVIATIONS。）
- Token Vault **不变**：`conn:{id}:access|refresh` 存的是**网关**发的令牌；`issuer = https://auth.kepcup.com`；客户端身份是 CIMD（常量，不落 `oauth_clients` 表）。**客户端从不持有任何第三方令牌**——安全测试要覆盖：整套流程后，客户端各存储中检索不到上游令牌样本（网关令牌样本也只出现在 Vault 与请求头里，沿用 P0 安全测试的扫描器）。

### 6.4 断开 / 吊销语义

- `AppDisconnector`：对 hosted 连接，RFC 7009 吊销**视为必做**（现为 best-effort 只记日志）：网关侧 `/revoke` 级联删除上游令牌与保险库。若吊销请求失败（离线 / 5xx），连接仍在本地删除，但 UI 提示「服务器上的数据将在 30 天内自动清除，或到 {设置页 URL} 手动清除」，并把待办记入 `app_disconnect` 审计 `{ relay, revoked: false }`。
- 网关端兜底：授权空闲超 `refreshTokenIdleTTL` → 库侧过期；每日 Cron（`purgeExpiredData` + 保险库清扫）删除孤儿上游令牌（§9）。
- 「删除我的全部数据」：网关提供 `DELETE /v1/me`（需有效网关令牌）→ 删除该 `userId` 的全部授权与保险库；客户端设置页入口调用它（G5）。

### 6.5 运行时、污点与工具锁定

- `ConnectionAuthProvider`：不变（标准 `refresh_token` 刷新到 `auth.kepcup.com`）。上游被用户在平台侧撤销 → 网关 `invalid_grant` → `AppAuthRequiredError{ reason: 'expired' }` → 既有重连卡。
- 工具来自 MCP，所以风险分级（`core/mcp/risk.ts`）、逐工具策略、`app_tool_grants`、污点外发（`apps/taint.ts`：读过应用数据后外发通道降级确认）、工具定义锁定、`<untrusted>` 包裹**全部原样适用**；hosted 工具并不因为"是 KepCup 自己的"而放宽（无特例，测试断言）。
- 外部智能体（ACP）桥：同一路径，无改动。

## 7. 账号关联页（`/authorize` 与 `/connect`）安全要求

MCP 规范（Elicitation，URL 模式「Phishing」一节）要求：**服务端必须保证发起授权请求的用户与完成授权的用户是同一人**，且对 URL 篡改有抵抗力。网关的实现：

- **主路径（推荐）**：账号关联就是 A 段的 `/authorize`。用库的同意页 / 上游登录助手（`beginConsent` → `approveConsent` → `beginUpstream` → `finishUpstream` → `completeAuthorization`，库文档 `upstream-sign-in.md` / `consent-page.md`）：
  - 同意页绑定浏览器的 **`__Host-` 前缀 Cookie**（`Secure; HttpOnly; SameSite=Lax; Path=/`，无 `Domain`，10 分钟）；`Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY`；同意页展示：客户端名（"KepCup"，来自 CIMD）、**将授予的平台权限**、"令牌保存在 KepCup 服务器"的披露与隐私政策链接；Deny 路径用 `denyConsent()`。
  - 上游 `state` 一次性、10 分钟、绑定同一浏览器 Cookie，请求从服务端存储恢复（不信任表单隐藏字段）；PKCE 用于网关 → 平台的授权码兑换。
  - **每个客户端授权前都要同意**（混淆代理防护）：KepCup 所有安装共享一个 `client_id`（CIMD），所以"记住同意"只允许记在同一浏览器，且绝不跨 `redirect_uri`（回环端口不同的安装互不继承）。
  - `redirect_uri`：对客户端回调按库的 CIMD 校验（https 或回环 http，无 userinfo / fragment）并**精确匹配**请求中的值；对平台回调固定 `https://auth.kepcup.com/callback/{provider}`，精确登记在平台应用里，不接受任何参数化 / 通配。
  - 从不接受 `?next=` 之类的跳转参数；错误只经库的 `authorizationErrorRedirect` 带 `state` 与 `iss` 返回。
  - CSRF：状态改变只走 POST，带一次性 `handle` + Cookie 绑定；`SameSite=Lax` 不够，所以仍要 handle；Origin / Fetch-Metadata 头校验。
- **备用路径（G4 可选，URL 模式 elicitation）**：仅当客户端 MCP 栈支持 elicitation 后启用（`pi-mcp@1.0.2` 不支持，KepCup 不声明 `elicitation` 能力，见 B.6）。网关在工具调用中途返回 `input_required`（URL 模式），URL 指向 `https://auth.kepcup.com/connect?h={opaque}`：
  - `h` 是**一次性不透明句柄**（服务端记录 `{userId, provider, scopes, clientId, exp≤10min, used}`；`requestState` 完整性保护、不含 PII、不是预认证 URL）；
  - 页面要求会话 Cookie（`__Host-`）中的 `userId` **等于**记录里的 `userId`，否则拒绝并提示"请在发起请求的设备 / 浏览器登录同一账号"，并记一次可疑事件；
  - 客户端侧（将来）必须：显示完整 URL、突出域名、征得同意后才打开、不预取（规范客户端要求），沿用既有 `shell.openExternal` + 主进程协议校验。
- 页面自身：无第三方脚本、严格 CSP（`default-src 'none'` + 内联样式用 nonce）、不回显未转义的平台返回内容。

## 8. 威胁模型

| 威胁                                    | 路径                                                         | 缓解                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网关令牌被窃（桌面端）                  | 读本机 Vault / 内存 / 日志                                    | 同本地令牌：只存 secrets 表、逐值脱敏；短 `accessTokenTTL`；刷新轮换 + 库的重用检测；可在设置里断开（吊销级联）；G5 可选 DPoP 绑定                         |
| 网关令牌重放（别的机器）                | Bearer 令牌无绑定                                             | 短寿命 + 受众绑定（RFC 8707）+ 异常 IP / 速率告警；G5 DPoP                                                                                                |
| 上游令牌被窃（网关侧）                  | 存储泄露 / 运营方滥权 / Worker 代码被投毒                       | 应用层加密 + 每用户密钥 + `kid`；密钥只在 Worker secret；DO 密文无明文账号；最小 scope；部署走 CI 且需双人审阅；依赖锁版本；Worker 代码是最大信任面，在隐私页如实说明 |
| 混淆代理（confused deputy）             | 攻击者用已同意的客户端 ID 发起授权，诱导受害者完成上游授权         | 每客户端同意、`__Host-` 绑定 Cookie、一次性 `state`、精确 redirect 匹配、`frame-ancestors 'none'`（§7）                                                      |
| 账号关联钓鱼（URL elicitation）         | Alice 把自己的关联链接发给 Bob，令牌绑到 Alice                  | 句柄记录 `userId`，页面校验会话 `userId` 一致（§7 备用路径）；主路径中发起者与完成者天然是同一浏览器                                                       |
| 开放重定向 / 授权码注入                 | 篡改 `redirect_uri`、`state`                                  | 精确匹配、不接受跳转参数、PKCE（网关 → 平台）、库对 CIMD `redirect_uris` 的校验                                                                           |
| 经提供方元数据的 SSRF                   | 网关去抓平台元数据 / 用户给的 URL                              | 平台端点**写死在代码 / 配置**，不做运行期发现；`fetch` 目标走主机白名单；唯一的动态抓取是库对 CIMD 的抓取，已由 `global_fetch_strictly_public` 保护            |
| 恶意工具服务器                          | 网关代理了第三方 MCP server                                   | **不代理第三方 MCP**；工具全为 KepCup 自写（§4.3）；平台返回的数据当不可信文本，由客户端 `<untrusted>` + 污点规则处理                                       |
| 提示注入经平台数据外泄                  | 邮件 / 消息里的指令让 Bot 外发                                | 客户端既有污点外发控制（§6.5）；网关写工具带完整注解、强制客户端审批；网关层不新增"信任"                                                                  |
| 令牌透传 / 跨受众滥用                   | 把客户端令牌转发给平台，或 A 平台令牌用于 B 平台                | 网关签发自己的受众绑定令牌；平台调用只用上游令牌；校验 `aud` 等于本资源；上游令牌永不进入响应                                                              |
| 跨用户串号                              | DO / KV 键冲突、AAD 缺失                                       | 保险库键 = HMAC(用户标识)，AAD 含 `vault_id|provider`；单测枚举跨用户读写                                                                                |
| 日志 / 追踪泄露                         | 请求体、令牌进 Workers Logs / Logpush                           | 网关 Worker 关闭 `observability`；自写日志只允许枚举字段；`onError.detail` 不入日志；回归测试扫描所有 `console` 输出                                         |
| 滥用 / 配额耗尽                         | 单用户刷爆平台应用级配额、拿网关发垃圾消息                      | 每用户令牌桶（DO 内）、每 IP 与每用户速率限制、每平台应用级熔断、写工具二次确认由客户端承担 + 服务端每日写上限、kill switch（§10）                            |
| 供应链 / 误部署                         | 库升级改变安全语义                                             | 钉版本；升级需读 changelog（尤其 EMA 实验性选项以外的稳定 API）；`kepcup-app validate --auth` 与安全测试作为 CI 门禁                                        |
| KV 最终一致带来的重放窗口                | 同一授权码 / 刷新令牌并发兑换                                   | 依赖库的轮换与前一令牌宽限设计；不自造并发语义；关键状态（保险库）放 DO 单写者                                                                            |

## 9. 数据最小化、隐私与合规

**服务端会持有的数据（穷举）**：

| 数据                              | 位置                          | 保留期                                                                                  |
| --------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| 授权记录（`userId`、客户端 ID、scope、加密 props）| `OAUTH_KV`                   | `refreshTokenIdleTTL`（建议 30 天空闲过期）；断开即删                                      |
| 上游令牌（密文）                  | UpstreamVault DO（`eu`）       | 与授权同生命周期；断开 / 过期 / `DELETE /v1/me` 即删；Cron 清孤儿                           |
| 上游账号展示名（可选，用于限流 / 滥用定位）| DO 内，加密                    | 同上                                                                                    |
| 聚合指标（无用户标识）            | Analytics Engine              | 平台限制 3 个月（设计 29 §15）                                                           |
| 滥用封禁记录（HMAC 后的标识 + 原因）| D1                            | 封禁期 + 12 个月（法务确认）                                                              |

**不持有**：工具入参 / 结果、平台数据正文、邮箱 / 手机号、IP（限流用 Cloudflare 速率限制绑定，不落库）、设备 ID。

- 日志：默认**零内容日志**；允许的结构化字段仅 `{ts, provider, tool, outcome, latency_ms, status}`；采样关闭。
- 删除：`apps.disconnect`（§6.4）、`DELETE /v1/me`、网站上的数据删除说明页（用户待办：法务页面）、邮件渠道兜底；承诺 30 天内完成并在隐私页写明。
- GDPR：KepCup 作为网关数据的控制者；需要 Cloudflare DPA 与子处理者清单（Cloudflare、各平台）、处理活动记录、数据保护影响评估（DPIA，因处理第三方账号凭据）、数据泄露响应预案（72 小时通报）「法务确认」。中国大陆用户（KepCup 的主要用户群之一）的个人信息出境条款 **「实现时核对」**，需单独的法务意见后才能向其开放。
- 平台条款：Google 的 API 服务用户数据政策（Limited Use）、Slack 的 API 条款等对"服务端持有用户令牌 / 转存数据"的限制「实现时核对」——这是 G0 的必答项。
- 隐私政策（`https://kepcup.com/privacy`，U-M2）必须新增"托管网关"章节，并由 CIMD 的 `policy_uri` 与目录条目的 `privacyPolicy` 指向。

## 10. 滥用、限流与成本

- **限流**：Workers Rate Limiting 绑定（按 IP）；DO 内令牌桶（按 `userId × provider`，保护平台应用级配额）；全局熔断（平台 429 / 5xx 比例过高时暂时拒绝新请求并返回 `Retry-After`）；`/authorize` 与 `/token` 单独更严的阈值。
- **写工具上限**：服务端每用户每日写调用上限（防止被劫持后批量发消息），超限返回结构化错误，客户端按普通失败文案处理。
- **kill switch**：Workers 变量 / KV 开关，可按平台、按用户停用，停用时 MCP 端返回 503 + 固定错误体；客户端目录同步经签名索引下发 `hosted` 条目的 `disabled` 标志（避免客户端无限重试）。
- **成本模型（上线前按当时价格测算，不在此写死金额）**：变量 = 月活连接数 × 日均工具调用数 × 单次调用的 Worker 请求数（MCP 一次调用约 1–2 个请求）；KV 写入（授权 / 每次令牌刷新约 2–3 次写）；DO 请求与时长（保险库读 / 刷新，调用路径上通常是毫秒级）；Analytics Engine 数据点；出站流量（Cloudflare 无出口费但平台 API 配额是另一类成本）。已知固定项：Workers Paid $5/月起（设计 29 §15.4）。G0 需给出"1000 / 1 万活跃连接"两档估算。

## 11. 可观测性与运维

- 指标（Analytics Engine，无用户标识）：授权开始 / 完成 / 失败（按库 `onError.internal.category/reason`）、令牌刷新成功率、上游 `invalid_grant` / 429 / 5xx、工具调用结果分类与延迟、`kv_rate_limited`、限流命中、kill switch 状态。
- 告警：刷新失败率突增（可能是上游吊销了 KepCup 应用）、5xx、同意页异常（`userId` 不匹配次数）、保险库解密失败（密钥问题）。告警渠道由用户指定（§13）。
- 运维手册（G4）：密钥轮换演练、紧急吊销某平台全部授权、应对平台撤销 KepCup 应用、事件响应、回滚、数据删除请求处理。
- 状态页（可选）：公开 `auth.kepcup.com` / `mcp.kepcup.com` 的可用性；客户端对 `error` 状态的文案指向它。

## 12. 阶段与任务（每项含验收）

> 目录：`infra/cloudflare/gateway/`（与 `registry/` 同级；独立 `wrangler.jsonc` 与 `tsconfig.json`，**不进 pnpm 工作区**；沿用 registry 的 `cf-types.d.ts` 与"业务层只依赖最小接口、绑定适配只在入口"做法）。测试用内存适配器（`KVLike`、`DurableObjectLike`、`D1Like` 用 `node:sqlite`），不引入 wrangler / miniflare。定向测试用 `node scripts/run-tests.mjs run infra/cloudflare/gateway`，Docker 环境见 `connected-apps.md` §2.2。

### G0 决策与法务（无代码）

- [ ] 完成 §1.4 的决策记录；用户批准。
- 验收：决策记录里每个平台都附 1.2 的逐项否决理由与官方文档链接；用户写明"批准启动 G1"。

### G1 客户端披露与 schema（可独立于服务端先做，门禁关闭）

- [ ] shared：`registration: 'hosted'`、`relay`、`HOSTED_GATEWAY_HOSTS` / `HOSTED_GATEWAY_ISSUER`；目录 schema 与 `directory-merge.ts` 的防冒充规则；`connectable` 与 kill switch；渲染端标签与确认勾选；core 强制确认。
- [ ] 迁移 `{N}_app_connection_relay.sql`（或改为推导，记 DEVIATIONS）。
- [ ] testkit：用 `startFakeOAuthMcpServer` 扮演"网关"（CIMD + 受众绑定 + `/revoke`），构造 hosted 目录条目。
- 验收：非 builtin / 主机不在白名单 / 带 `clientRef` 的 hosted 条目被拒并有 drop 原因；hosted 条目对只支持 DCR 的授权服务器**不退回 DCR**；缺确认的 `confirmTools` → `INVALID_INPUT`；连接卡出现"经 KepCup 服务器中转"；断开时吊销失败有明确 UI 与审计；既有本地直连用例零回归；令牌扫描仍零明文。

### G2 授权服务器骨架

- [ ] `infra/cloudflare/gateway/`：AS Worker（CIMD 开启、`global_fetch_strictly_public`、无 DCR、每平台一个 `resource`）、同意页（§7 全部要求）、`/callback/{provider}`、平台配置表（端点写死）。
- [ ] 以 testkit 假上游（`startFakeOAuthMcpServer` 扮演平台 AS）做 A 段端到端。
- 验收：同意页：无 Cookie 的 POST 被拒 / 换浏览器回调被拒 / `state` 重放被拒 / `redirect_uri` 不精确被拒 / 可被 iframe 嵌入的请求被拒（响应头断言）/ 同意先于任何上游跳转；CIMD 文档 http、重定向、超大、`client_id` 不一致均被拒；`kepcup-app validate --auth` 对网关通过；真实 KepCup core（`ConnectFlowManager`）经假平台走通连接。

### G3 保险库与上游刷新

- [ ] UpstreamVault DO（HKDF 每用户密钥、`kid`、AAD、单写者刷新、先写后返回）、`tokenExchangeCallback` 接入、吊销级联、每日清扫 Cron。
- 验收：存储里检索不到上游令牌明文（扫描 KV / DO / D1 / 日志 / 响应）；跨用户读写被拒；篡改密文或 AAD 解密失败；密钥轮换惰性迁移后旧 `kid` 不可再用；并发刷新只发生一次上游请求；上游 `invalid_grant` → 客户端 `expired`；上游 5xx / 429 → `temporarily_unavailable`、授权不被撤销；`/revoke` 后保险库为空且对平台吊销端点发出过请求；幂等重复吊销返回 200。

### G4 MCP 工具面与加固

- [ ] `createMcpHandler` 资源服务器、首个平台的工具集（注解齐全、读写拆分、zod 入参、主机白名单、不落盘 / 不打日志）、scope 校验与 403 step-up、速率限制、写工具日限额、kill switch、指标与告警、`DELETE /v1/me`。
- [ ] 可选：URL 模式 elicitation 备用路径（§7）——仅当客户端栈支持后。
- 验收：`kepcup-app validate` 全部通过（每个工具有 `title` 与风险注解、名称 ≤ 64）；缺 scope → 403 `insufficient_scope`，客户端 step-up 卡出现；受众不符的令牌 401；响应与日志无令牌 / 入参 / 结果；工具契约哈希变化 → 客户端出现"工具变更待复核"；限流 / 熔断 / kill switch 生效且客户端显示 `error` 文案；`onError` 的 `detail` 不入日志（扫描）。

### G5 客户端联调与 UX

- [ ] hosted 目录条目（`builtin`）+ 发行门禁（`connector-release-gates.json` 初始 `approved: []`）；设置页"断开并删除服务器数据"调用 `DELETE /v1/me`；隐私政策章节链接。
- [ ] 可选增强：DPoP 绑定（需库支持与桌面端密钥存放设计，单独评审）。
- 验收：Docker 内真实 core + 网关 Node 适配器 + 假平台的端到端（目录连接 → Bot 调用读 / 写工具 → 写工具审批卡显示账号与风险 → 污点期间外发降级 → 刷新 → 断开级联）全绿；渲染端披露与确认测试通过。

### G6 上线（含用户待办）

- [ ] 部署演练文档与 `verify.mjs`（外部冒烟：发现端点、`401` 挑战、CIMD 可用、同意页响应头、速率限制、kill switch）。
- 验收：用户待办（§13）全部完成后，真实平台测试账号走通"连接 → 调用 → 令牌过期刷新 → 平台侧撤销 → 重连 → 断开删除"；放行发行门禁需用户批准；先小范围（白名单用户）再全量。

## 13. 用户待办（Agent 不做，不要代为登录 / 注册 / 创建资源）

> 汇总见 `todo/connected-apps-user-actions.md`「P4 启动前的用户决定」；以下为明细。

- [ ] **G0 决策**：是否启动、哪个平台、是否接受令牌离开本机的产品代价、身份方案 Q1。
- [ ] **Workers Paid**（KV 写入、DO、Cron 需要）；Cloudflare **DPA** 签署 / 确认。
- [ ] **域名**：`auth.kepcup.com`、`mcp.kepcup.com`（Worker 自定义域 + DNS）；`eu` 管辖区的 DO / D1 资源创建；回填 `wrangler.jsonc` 占位 id。
- [ ] **平台应用注册**：以 KepCup 名义在目标平台创建**保密**应用（Web 回调 `https://auth.kepcup.com/callback/{provider}`），完成平台审核 / 验证；client secret 只放 `wrangler secret put`。
- [ ] **密钥**：生成保险库主密钥 `KEK_v1`（`wrangler secret put`），并**离线备份**；安排轮换提醒。
- [ ] **法务页面**：隐私政策"托管网关"章节、服务条款、数据删除说明页、子处理者清单、DPIA、泄露响应预案；中国大陆出境意见。
- [ ] **WAF / 速率限制规则**与 Bot Fight Mode 对 `/.well-known/*`、`/token`、`/register`（若有）的例外（同设计 29 §15.1 的抓取问题）。
- [ ] 告警渠道与值班联系人；kill switch 的操作权限人。
- [ ] 真实测试账号（目标平台）用于 G6。

## 14. 开放问题

| #   | 议题                                                                             | 推荐默认                                                                                               |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Q1  | 身份方案（§5）                                                                    | I1 上游账号即身份                                                                                      |
| Q2  | 保险库选型（§4.4）：DO（B）还是库 `props`（A，服务端不可解密但断开无法替用户撤销上游令牌）| B；若目标平台无吊销需求且更看重"服务端不可解密"，可重议 A                                              |
| Q3  | 库的 1.x 形态与 KV 依赖是否满足；是否需要自写授权服务器                            | 采用库；G2 用假上游验证其行为后再定                                                                     |
| Q4  | `pi-mcp` 对 elicitation / 2026-07-28 的支持节奏                                    | 不依赖；主路径不需要 elicitation（§7）                                                                  |
| Q5  | 单个 `mcp.kepcup.com/{provider}` 还是一个聚合 MCP                                 | 每平台一个资源（受众隔离、爆炸半径小）                                                                  |
| Q6  | 是否提供 DPoP 绑定                                                                | G5 评审；默认不做                                                                                       |
| Q7  | 网关是否也承载 KepCup 自有的其它服务端能力                                         | 否（职责单一）                                                                                          |
| Q8  | 中国大陆用户的数据出境合规                                                         | 法务意见前不向大陆用户开放，或在客户端按地区隐藏 hosted 条目                                              |
| Q9  | 平台是否允许服务端持有用户令牌（Limited Use 等）                                   | G0 必答                                                                                                 |

## 15. 参考

> 2026-10-10 联网读取。「实现时核对」：开工时以当时官方文档为准。

- Cloudflare `workers-oauth-provider`：<https://github.com/cloudflare/workers-oauth-provider>（README；`docs/authorization-server.md`〔CIMD 开关、`global_fetch_strictly_public`、DCR、令牌寿命〕、`docs/advanced-configuration.md`〔`tokenExchangeCallback`、RFC 8693 `allowTokenExchangeGrant`、EMA 实验性选项、`onError` 分类〕、`docs/upstream-sign-in.md`、`docs/consent-page.md`、`storage-schema.md`〔`props` 加密〕）
- Cloudflare Agents SDK「MCP handler APIs」（`createMcpHandler`、无状态、MRTR elicitation、`McpAgent` 废弃）：<https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/> ；MCP 总览 <https://developers.cloudflare.com/agents/model-context-protocol/>
- MCP Authorization 2026-07-28：<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> ；Client Registration：<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>
- MCP Elicitation（URL 模式、第三方授权模式、"Phishing"同一用户校验）：<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>
- MCP 安全最佳实践（令牌透传、混淆代理）：<https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices>
- RFC 8252（原生应用）、RFC 8707（资源指示）、RFC 9207（`iss`）、RFC 7009（吊销）、RFC 8693、RFC 9449（DPoP）、CIMD 草案 `draft-ietf-oauth-client-id-metadata-document`
- 本仓库：`todo/connected-apps.md` §8 与附录 B.6、`todo/developer-portal.md`、`infra/cloudflare/{oauth-cimd,registry}/`、设计 29 §11.7 / §15.3

## 与已实现模块的接缝

| 模块                                                    | 变化                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/domain/connector-catalog.ts`       | `registration` 增 `'hosted'`、可选 `relay`；`superRefine` 限 `builtin` + 主机白名单                          |
| `packages/shared/src/constants.ts`                      | `HOSTED_GATEWAY_HOSTS`、`HOSTED_GATEWAY_ISSUER`                                                           |
| `packages/core/src/apps/directory-merge.ts`             | 远端条目声明 `hosted` 一律丢弃（新 drop 原因）；快照 `builtin` 的 hosted 端点钉死                            |
| `packages/core/src/apps/catalog.ts`                     | `#unavailableReason`：网关停用 / 设置关闭时不可连接                                                        |
| `packages/core/src/apps/auth/flow.ts`                   | hosted 只走 CIMD、不退回 DCR；校验 `issuer`；`reviewing_tools` 带 `relay`；`confirmTools` 强制披露确认       |
| `packages/core/src/apps/disconnect.ts`                  | hosted 连接的吊销视为必做并提示失败后果；审计带 `relay`                                                    |
| `packages/core/src/apps/connection-store.ts` + 迁移     | `app_connections.relay`（或推导）                                                                          |
| `apps/auth/runtime-provider.ts`、`token-vault.ts`、`registry.ts` | **不变**                                                                                          |
| `mcp/service.ts`、`apps/taint.ts`、`apps/tool-lock.ts`、`mcp/risk.ts` | **不变**（hosted 工具无特例）                                                               |
| `packages/app-validator`                                | 作为网关的 CI 门禁复用（无改动）                                                                           |
| `packages/testkit`                                      | 新增"假上游平台"便捷配置（复用 `fake-oauth-mcp-server.ts`，轮换刷新令牌 / 吊销 / 429 / `invalid_grant` 注入已有） |
| `apps/desktop/src/renderer/.../features/apps/`          | 披露标签、确认勾选、"断开并删除服务器数据"入口                                                              |
| `infra/cloudflare/gateway/`（新）                       | AS Worker、RS Worker、UpstreamVault DO、Cron、README、`verify.mjs`                                         |

## 决策记录（G0 填写）

> 尚无。每个候选平台一节：平台 / 触发条件 / 否决的替代方案 / 条款核对 / 成本估算 / 用户批准日期。

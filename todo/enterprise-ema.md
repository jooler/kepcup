# 企业托管授权（MCP Enterprise-Managed Authorization / Okta XAA）— 任务书（D73 P4，**未实现**）

> 状态：仅任务书，未开工（2026-10-10）。它是 `todo/connected-apps.md` §8 第二项的展开，给后续编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。上游设计：`docs/design/29-connected-apps.md` §1.2（EMA 一行）、§11.8（企业）、§5（授权引擎）、§5.6（运行时 / 交互授权分离）、§8（审批与安全）。
>
> **前置（已有，EMA 在其上叠加而非改写）**：
>
> - 授权引擎：`packages/core/src/apps/auth/{flow,runtime-provider,registry}.ts`（交互流程只用 pi-mcp 低层函数；运行时 `ConnectionAuthProvider` 只做标准 `refresh_token` 刷新、**从不开浏览器**，失败抛 `AppAuthRequiredError`）。
> - `apps/token-vault.ts`（令牌逐值存 secrets 表）、`apps/connections.ts`、`apps/connection-store.ts`、`apps/oauth-clients.ts`、`apps/disconnect.ts`、`apps/audit.ts`（`audit_log` 的 `app_*` 动作）。
> - 目录：`packages/shared/src/domain/connector-catalog.ts` 的 `connectorAuthSchema`（`kind` / `registration` / `clientRef` / `scopes`）、`apps/catalog.ts`、`apps/directory-sync.ts` + `directory-merge.ts`（签名目录与分级信任：`builtin` / `verified` / `community` / `developer`）、`apps/tier.ts`。
> - CIMD 客户端身份 `KEPCUP_OAUTH_CLIENT_ID = https://kepcup.com/oauth/client.json`（`infra/cloudflare/oauth-cimd/`）。
> - 测试假服务：`packages/testkit/src/fake-oauth-mcp-server.ts`。
>
> **硬约束**：
>
> - 只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。
> - 标注「**用户待办**」的事项（企业 IdP 租户、平台账号、管理员配置、发行与许可决策）由用户完成，Agent 只做准备与验证脚本，不要尝试代为登录或注册（见 §14）。
> - **运行时永不自行发起交互登录**（设计 29 §5.6 的延伸）：企业 SSO 会话过期时，运行时只抛 `AppAuthRequiredError`（新增原因 `enterprise_sso`），由用户在界面 / 对话卡上点「重新登录」触发。
> - 令牌明文规则不变：ID Token、IdP 刷新令牌、访问令牌只允许出现在 core 发 HTTP 请求的那一刻与 Token Vault 内部；**ID-JAG 只存在于内存、一次使用、不落盘、不进日志**。
> - 个人连接的行为与测试**零回归**；没有企业配置时本特性完全不可见。
> - 外部协议细节凡标注「实现时核对」的，开工时必须对照当时的官方文档 / 目标 IdP 与 MCP server 的实际行为确认后再写代码。EMA 扩展与 ID-JAG 草案仍在演进（草案当前 `-04`，2026-05-21）。

## 0. 先读什么（按顺序）

1. 本文 §1 的流程图（先把"谁向谁要什么"搞清楚，再读代码）。
2. 设计 29 §5.1（客户端身份选择顺序）、§5.3（令牌存储与刷新）、§5.6、§8、§11.3（分级）、§11.8。
3. 代码：
   - `apps/auth/flow.ts`：`resolveIdentity`（BYO → 预注册 → 已存 DCR → CIMD → DCR）、`startCallbackServer`（`auth/callback-server.ts`，回环、校验 `Host`、一次性）、`OAUTH_CALLBACK_PORTS`（`packages/shared/src/constants.ts`，`[47615, 47616, 47617]`）；`exchangeAuthorizationCode` / `startAuthorization` 的用法。
   - `apps/auth/runtime-provider.ts`：`#doRefresh`（`refreshAuthorization`、single-flight、世代号 `epoch` 防断开后写回、`PERMANENT_GRANT_ERRORS`）——EMA 的"静默续期"要插入到这里（§6.2）。
   - `apps/auth/registry.ts`：`providerFor` / `invalidate` / `clientFor`；`apps/token-vault.ts`：命名规则 `conn:{id}:access|refresh`，机密逐值存放（`redact()` 按整值匹配）。
   - `apps/connection-store.ts` / `0025_app_connections.sql`：`app_connections` 列、`(connector_id, account_sub)` 唯一索引、`oauth_clients` 表。
   - `apps/tier.ts`（`tierAllowsBotLevelGrant`、`appToolDurations`）、`apps/taint.ts`、`domain/types.ts` 的 `appsSettingsSchema`（`developerMode` / `taintGuard` / `directorySync`）。
4. 外部资料（本文 §16 列出；2026-10-10 联网读到）：MCP 扩展页与稳定规范 `enterprise-managed-authorization`、IETF 草案 `draft-ietf-oauth-identity-assertion-authz-grant`、RFC 8693、RFC 7523、MCP 博客「Enterprise-Managed Authorization」。
5. `todo/developer-portal.md` / `todo/hosted-auth-gateway.md`：同系列任务书的写法；`hosted-auth-gateway.md` §6 讨论的"客户端不变、服务端托管"与本任务书互不依赖。

## 1. EMA / XAA 是什么，流程是什么

**EMA**（MCP 扩展 `io.modelcontextprotocol/enterprise-managed-authorization`，2026-06-18 稳定）：企业 IdP 成为"哪个用户可以用哪个客户端连哪个 MCP server"的唯一决策者。底层是 IETF 草案 **Identity Assertion JWT Authorization Grant（ID-JAG，Okta 称 Cross App Access / XAA）**，由 RFC 8693 令牌交换 + RFC 7523 JWT bearer 授权组合而成。

```
(1) 用户在 KepCup 里用企业 IdP 登录一次（OIDC 授权码 + PKCE，系统浏览器 + 回环回调）
     KepCup ──► IdP /authorize … ◄── 授权码 ──► IdP /token ──► ID Token（+ 可选 IdP 刷新令牌）   [保存：身份断言]
(2) 对每个要连接的 MCP server：
     KepCup ──► IdP /token  (RFC 8693)
                grant_type=urn:ietf:params:oauth:grant-type:token-exchange
                requested_token_type=urn:ietf:params:oauth:token-type:id-jag
                audience=<该 MCP server 的授权服务器 issuer>   resource=<MCP server 规范 URI，可选>   scope=…
                subject_token=<ID Token>  subject_token_type=urn:ietf:params:oauth:token-type:id_token
                + 客户端认证（与 SSO 时相同）
     IdP 评估管理员策略（用户 / 组 / 条件访问）  ──► ID-JAG（JWT，typ=oauth-id-jag+jwt，约 5 分钟）
(3) KepCup ──► MCP server 的授权服务器 /token  (RFC 7523)
                grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer   assertion=<ID-JAG>   client_id=<KepCup 在该 AS 的客户端 id>
     AS 验证 ID-JAG（签名 / iss 受信 / aud / client_id 绑定 / resource / exp / jti）──► 访问令牌（受众绑定到该 MCP server；通常无刷新令牌）
(4) KepCup 用访问令牌调 MCP server。**全程没有逐应用的同意页，也不把用户重定向到 MCP server 的授权端点。**
```

要点（均来自 §16 的规范原文）：

- MCP 客户端须在每个请求的 `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` 里声明 `"io.modelcontextprotocol/enterprise-managed-authorization": {}`「实现时核对：KepCup 现用 `pi-mcp@1.0.2` 的握手是 2025-11-25 `initialize`，是否有每请求 `_meta` 能力声明的位置，见 §6.5」。
- 授权服务器通过元数据 `authorization_grant_profiles_supported` 含 `urn:ietf:params:oauth:grant-profile:id-jag`（且 `grant_types_supported` 含 `jwt-bearer`）宣告支持；IdP 通过 `identity_chaining_requested_token_types_supported` 含 `urn:ietf:params:oauth:token-type:id-jag` 宣告能签发。
- ID-JAG 的 `client_id` 声明 = 客户端在**资源授权服务器**的客户端 id，IdP 需要知道这个映射；客户端若用 **CIMD URL** 作 client id，则是全局命名空间，IdP 不必维护映射（草案 §5）。
- **续期阶梯**（草案 §4.4.3）：访问令牌过期 → 可重新提交原 ID-JAG（若未过期）→ ID-JAG 过期则用 ID Token 重新向 IdP 换 → ID Token 过期则用 IdP 刷新令牌换新 ID Token（或直接把 IdP 刷新令牌作 `subject_token`，若 IdP 支持）→ 都不行才需要用户重新登录 IdP。资源 AS **不应**签发刷新令牌（草案 SHOULD NOT）——所以 EMA 连接的"刷新"=重新交换，不是 `refresh_token` 授权。
- 管理员侧的价值：集中开关 / 审计 / 立即撤销（在 IdP 禁用用户或取消连接即全端生效，但**已签发的访问令牌**在到期前仍有效，见 §9）。

## 2. 目标与非目标

**目标**：

1. 企业用户在 KepCup 用公司账号登录一次，即可"零点击"连接管理员已放行的、支持 EMA 的应用（出现在目录里就绪的状态，或进入对话时静默建立），无逐应用同意页。
2. 管理员通过**托管配置**控制：IdP、允许的应用、可用分级、是否禁用社区目录 / 开发者模式 / 个人连接、审计导出。
3. 与个人连接并存，且不会把个人账号与企业账号混用（EMA 博客点名的风险）。
4. 现有审批、风险分级、工具锁定、污点外发、持续授权**全部照常**——企业连接不是特权通道。

**不做（明确）**：

- 不做 SAML-only 的 IdP（草案 §4.5 的 SAML → 刷新令牌互换另起；见开放问题 Q3，默认不做）。
- 不做 KepCup 作为 IdP / 授权服务器（KepCup 只是 EMA **客户端**）。
- 不做 SCIM / 用户目录同步、不做企业管理后台、不做集中式云端策略下发服务（配置来源是本机托管文件，§5）。
- 不做 EMA 的服务端（`workers-oauth-provider` 有实验性的 EMA 校验选项，那是托管网关/自有 MCP server 的话题，见 `hosted-auth-gateway.md`，不在本任务书）。
- 不绕过 MCP server 自己的授权：服务器不支持 ID-JAG 时回落到普通个人 OAuth（或按策略禁止），**不**伪造断言。
- 不做 DPoP / 令牌绑定（草案 §9.8 相关；`cnf` 声明出现时按"失败即关闭"处理，§9）。
- 不做令牌云同步 / 多设备；不做基于 IdP 的 Bot 权限同步。
- 不做计费 / 许可证校验（开放问题 Q5）。

## 3. 服务端 / IdP 侧前提与首批平台

### 3.1 前提（缺一不可，逐项在 E0 记录）

1. **IdP 支持签发 ID-JAG**：元数据里有 `identity_chaining_requested_token_types_supported` 含 id-jag。MCP 博客（2026-06-18）称 Okta 是首个支持的 IdP（Cross App Access）；Entra / Google Workspace / 其他 IdP 的支持情况「实现时核对」。
2. **KepCup 在 IdP 里被注册**为 OIDC 客户端（管理员操作）。规范 §7.1 指出多数企业 IdP 只允许登录已预注册的客户端——所以每个组织都有**各自的 SSO `client_id`**，来自托管配置（§5），而不是 KepCup 的全球常量。
3. **IdP 管理员建立"KepCup ↔ 目标 MCP server"的连接并分配用户 / 组**（Okta 称在应用的连接管理里配置请求方应用与资源应用「实现时核对具体菜单与名称」）。
4. **目标 MCP server 的授权服务器**宣告 `urn:ietf:params:oauth:grant-profile:id-jag`、信任该企业 IdP 的 issuer、并接受 KepCup 的客户端身份。
5. **客户端形态**（本任务书最大的开放风险，E0 先实测）：草案 §9.1 写明该授权"应仅支持保密客户端；公共客户端应走常规授权码流程"。KepCup 是桌面公共客户端，没有可保密的 secret。可选路径见 §7。

### 3.2 首批平台

目录当前 6 家（`apps/desktop/resources/connectors/catalog.json`）：`notion`、`linear`、`atlassian`、`sentry`、`canva`、`stripe`。MCP 官方博客（2026-06-18）列出已支持 EMA 的服务器：Asana、Atlassian、Canva、Figma、Granola、Linear、Supabase，Slack 在加入中。

| 目录应用    | EMA 支持                          | 依据 / 状态                            |
| ----------- | --------------------------------- | -------------------------------------- |
| `linear`    | 博客列为支持                      | 「实现时核对」：AS 元数据 + 实测        |
| `atlassian` | 博客列为支持                      | 「实现时核对」：同上；管理员域名 / 客户端限制另有要求 |
| `canva`     | 博客列为支持                      | 「实现时核对」                          |
| `notion`    | 未见官方说明                      | 「实现时核对」                          |
| `sentry`    | 未见官方说明                      | 「实现时核对」                          |
| `stripe`    | 未见官方说明                      | 「实现时核对」                          |
| Figma / Asana / Supabase 等 | 博客列为支持；Figma 另有客户端白名单 | 不在目录 / 待 U4                        |

**规则**：EMA 就绪与否**以运行时发现为准**（AS 元数据 `authorization_grant_profiles_supported`），目录里的 `enterprise.supported` 只是提示 / 开关（§6.3），两者不一致时以发现结果为准并在开发者模式日志里记一行。

## 4. 与个人连接并存、身份绑定

### 4.1 并存规则

- 同一 Connector 可以同时有个人连接与企业连接（`app_connections` 允许同 `connector_id` 多行；`(connector_id, account_sub)` 唯一索引按账号区分）。设计 29 §6 的"同一 Bot 对同一 Connector 至多勾选一个 Connection"**保持**——一个 Bot 要么用个人的、要么用企业的，工具名仍是稳定的 `app_{slug}_*`。
- 每个连接带来源标记 `grant_kind`：`code`（个人 / 常规授权码）、`ema`（企业）。界面（连接列表、Bot 勾选、审批卡的账号行）对企业连接加**组织徽标**（组织名来自托管配置），审批卡显示"以 {企业账号} 身份（{组织}）…"，降低混用风险。
- 组织策略 `personalConnections`：`allow`（默认）| `deny_for_listed`（对 `enforceEnterprise` 列表中的应用，禁止创建个人连接，并在 Bot 勾选里隐藏已有的个人连接）| `deny`（禁止全部个人连接）。已存在的个人连接不删除，只是不可勾选，并给出一次性说明（避免静默丢数据）。

### 4.2 身份绑定

- **企业会话**（一个组织 × 一个 IdP 账号）：`(org_id, idp_issuer, idp_sub[, tenant])` 为键，保存 ID Token（及 IdP 刷新令牌）。一台设备同一时刻**只允许一个**企业会话（切换账号 = 先登出，登出清理该会话派生的全部 EMA 连接令牌）。
- **EMA 连接**的 `account_sub = ema:{idp_issuer}|{idp_sub}`（`idp_sub` 取 ID-JAG / ID Token 的 `sub`；多租户 IdP 加 `tenant`，草案 §6），因此不会与同一 Connector 下的个人账号合并；`label` 取 ID Token 的 `email` / `preferred_username`（仅显示用，不作授权依据）。
- 访问令牌的主体由资源 AS 决定；KepCup 不信任也不解析它。工具调用的账号展示继续用既有 `whoami` 机制，仅作显示。
- 企业会话登出 / 被 IdP 吊销 / 用户被移出组 → 由该会话派生的 EMA 连接全部置 `expired`（原因 `enterprise_sso`），**不自动回落**到个人连接。

## 5. 企业配置：来源与形态

**现状**：仓库内没有"托管设置 / MDM"机制（对 `managed` / `MDM` 的检索只命中无关代码），`settings` 全部用户可写（`settings.update`）。所以这是新增能力。

### 5.1 来源（推荐：托管配置文件，只读，操作系统管理员可写）

| 平台    | 位置（**本任务书的提案**，E0 与用户确认）                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| macOS   | `/Library/Application Support/KepCup/managed-settings.json`（root 属主；MDM 配置描述文件可部署）；可选再读 MDM 托管偏好域 |
| Windows | `%ProgramData%\KepCup\managed-settings.json`（仅管理员可写）；可选再读 `HKLM\Software\Policies\KepCup`                |
| Linux   | `/etc/kepcup/managed-settings.json`                                                                               |

- core 启动时读取一次并监听文件变化（热更新）；**文件不是用户可写路径**（属主 root / Administrators）。检测到其权限允许非管理员写入时：忽略该文件并告警（防止用户自己伪造托管配置、也防止恶意软件降级策略）。
- 备选 / 补充：设置页「企业」分区手动填写 IdP（**仅用于评估和测试**，标注"未受管"，不能下发策略锁定；`enforce*` 类策略只认托管文件）。
- 不做：基于邮箱域名的远程发现（`/.well-known/kepcup-org.json`）——会引入钓鱼面（任何人可声称某个域）；若将来要做，必须签名并走与目录相同的验签链路。

### 5.2 Schema（shared zod，`packages/shared/src/domain/enterprise.ts`，新）

```jsonc
{
  "version": 1,
  "org": { "id": "acme", "name": "ACME Corp" },
  "idp": {
    "issuer": "https://acme.okta.com",          // 经发现文档取端点；必须 https
    "clientId": "0oa…",                          // 管理员在 IdP 为 KepCup 注册的 OIDC 客户端
    "clientSecret": null,                        // 仅当 IdP 要求且管理员接受放进托管文件时（见 §7）
    "scopes": ["openid", "email", "offline_access"],
    "hint": "okta"                               // okta | entra | google | generic，仅影响文案与排错提示
  },
  "policy": {
    "allowedApps": ["linear", "atlassian"],       // 目录 slug 白名单；"*" = 全部；缺省 = 不限制
    "maxTier": "verified",                        // 允许的最高信任分级：builtin | verified | community | developer
    "disableCommunityDirectory": true,            // 隐藏 community 条目并停用远端目录里的 community
    "disableDeveloperMode": true,                 // 锁定 settings.apps.developerMode = false，禁止 MCPB / 自定义 server
    "disableCustomServers": false,
    "personalConnections": "deny_for_listed",     // allow | deny_for_listed | deny
    "enforceEnterprise": ["linear"],
    "forceTaintGuard": true,                      // 锁定 settings.apps.taintGuard = true
    "toolApproval": { "denyBotLevelGrants": true }, // 禁用"对该 Bot 总是允许"
    "auditExport": { "kind": "file", "path": "~/.kepcup/audit-export/" }  // 见 §11
  }
}
```

- 校验失败（schema 非法、`idp.issuer` 非 https、重复键）→ 整份配置忽略并**在设置页显示明确错误**（而不是半生效）；`version` 未知同理。
- `clientSecret` 放在托管文件里等同于"公司内部可见的机密"，不是安全边界；优先 §7 的公共客户端路径。出现时进入 Token Vault（`ent:{orgKey}:client_secret`），不进日志 / RPC。
- 托管值**覆盖**用户值，并随 `settings.get` 返回 `locked: string[]` 供界面置灰；强制发生在 core（`settings.update` 拒绝改动被锁字段），不依赖渲染端。

### 5.3 策略生效点（见"接缝"表）

目录列表（`allowedApps` / `maxTier`）、`apps.connect`（拒绝不在白名单的目标）、签名目录合并（丢弃超出 `maxTier` 的远端条目，沿用 drop 原因机制）、`tier.ts`（`denyBotLevelGrants`）、`settings`（锁定字段）、Bot 勾选（`personalConnections`）、MCPB 安装与自定义 server（`disableDeveloperMode` / `disableCustomServers`）。

## 6. 客户端设计

### 6.1 企业登录（新模块 `packages/core/src/apps/enterprise/`）

- `org-config.ts`：读取 / 校验 / 热更新托管配置，暴露只读 `OrgPolicy`。
- `idp-session.ts`：OIDC 授权码 + PKCE（S256）+ `nonce` + `state`，系统浏览器（`shell.openExternal`，同既有主进程校验）+ 回环回调（**复用** `auth/callback-server.ts` 与 `OAUTH_CALLBACK_PORTS`；`redirect_uri` 必须是管理员在 IdP 登记的那几个，文案里给出 `http://127.0.0.1:47615/callback`、`:47616`、`:47617` 与 `http://127.0.0.1/callback`——与 `client.json` 一致）。校验：`iss` 等于配置的 `idp.issuer`（RFC 9207 的 `iss` 参数存在则比对）、ID Token 的 `aud` = `clientId`、`nonce`、`exp` / `iat`（容忍 60 秒时钟偏差）、签名（取 JWKS 验证，即使 TLS 直连时规范允许省略）。ID Token 与 IdP 刷新令牌各存一个 secret：`ent:{orgKey}:id_token`、`ent:{orgKey}:refresh`（名称只允许 `[a-z0-9:_-]`，`orgKey` 用 `org.id` 的哈希前缀）。
- 发现与出站请求：IdP 端点从 `idp.issuer` 的发现文档取（`/.well-known/openid-configuration` 与 RFC 8414），全部走 `createSafeFetch`（`auth/safe-fetch.ts`）；管理员配置也当作"半可信"输入——拒绝私网 / 回环（测试钩子除外）。
- 登录是**交互动作**，只由用户在设置页「企业」或对话卡触发；新增 RPC `enterprise.login` / `enterprise.logout` / `enterprise.status`，事件 `enterprise.session_status`。

### 6.2 EMA 连接与静默续期（改动 `flow.ts` 选择逻辑 + `runtime-provider.ts`）

- **选择**：`apps.connect({ target:{kind:'catalog', connectorId}, mode?: 'enterprise' })`。当企业会话存在、策略允许、目录条目 `auth.enterprise.supported` 且发现到 AS 宣告 `id-jag` 时走 EMA，否则走原有流程（或按策略禁止）。EMA 路径**不起回调服务、不开浏览器**（IdP 会话在登录时已建立），所以可以在后台"零点击"完成；是否在会话建立后自动为 `allowedApps` 全量预连接由开放问题 Q4 决定（推荐：仅在用户首次勾选 / 使用时才交换，不预热）。
- **交换链**（新 `ema-grant.ts`，只用 `fetch` + 已有低层函数辅助，不引入 `McpOAuthProvider`）：
  1. 发现 MCP server 的 PRM → AS 元数据（复用 `discoverOAuthServerInfo`，同样的 SSRF fetch），确认 `authorization_grant_profiles_supported` ∋ id-jag 与 `jwt-bearer`；
  2. 向 IdP `/token` 做 RFC 8693：`audience` = **AS 元数据里校验过的 issuer**（不是目录里的字符串）、`resource` = `selectResource(serverUrl, prm)`、`scope` = 目录 `auth.scopes.default`（空则不传）、`subject_token` = ID Token；客户端认证与 SSO 时一致；
  3. 向 AS `/token` 做 RFC 7523：`assertion` = ID-JAG，`client_id` = `KEPCUP_OAUTH_CLIENT_ID`（CIMD）或该 AS 的预注册客户端（§7）；
  4. 结果交给既有 `TokenVault.saveTokens`（无 refresh token → 写入时会清掉旧 refresh，符合预期）。
- **运行时续期**：`ConnectionAuthProvider` 增加可注入的 `GrantRenewer`（接口 `renew(connectionId): Promise<OAuthTokens>`，默认实现 = 现有 `refreshAuthorization`）。`grant_kind='ema'` 的连接用 EMA 实现：访问令牌近到期（`OAUTH_REFRESH_SKEW_MS`）时在**同一 single-flight** 内执行 §1 的续期阶梯；任何一步需要用户交互（IdP 会话已死、条件访问要求重新认证、`insufficient_user_authentication`）→ `markExpired` + 抛 `AppAuthRequiredError{ reason:'enterprise_sso' }`，从不开浏览器。世代号 `epoch` 与"刷新期间被断开则丢弃结果"的保护照用。
- `appAuthReasonSchema`（`packages/shared/src/domain/types.ts`）新增 `'enterprise_sso'`，D58 连接卡与 `SetupRequiredCard` 增加对应文案与"重新登录企业账号"按钮。

### 6.3 目录元数据

`connectorAuthSchema` 增加可选 `enterprise: { supported: boolean, idpHint?: 'okta'|'entra'|'google'|'generic' }`（缺省 `{ supported: false }`）：

- `supported` 只是目录侧提示（决定是否展示"企业登录可用"、是否尝试 EMA）；真实就绪以 AS 元数据为准；
- `idpHint` 仅用于排错文案（例如"该应用经 Okta XAA 验证过"），**不**参与信任决策；
- 远端目录条目声明 `enterprise` 时只作提示使用，信任分级与 `maxTier` 策略不变；`community` 条目即使声明 `supported` 也受 `maxTier` 约束。

### 6.4 数据模型

迁移 `{N}_enterprise_ema.sql`（`N` 为届时 main 的下一个空号，见 `connected-apps.md` §2.1；`approvals` 不涉及）：

- `app_connections` 增 `grant_kind TEXT NOT NULL DEFAULT 'code'`、`enterprise_org TEXT NULL`；
- 新表 `enterprise_sessions`（非机密元数据：`org_id`、`idp_issuer`、`idp_sub_hash`、`label`、`id_token_exp`、`created_at`、`last_exchange_at`、`status`）；机密仍只在 secrets 表。

### 6.5 协议能力声明

规范要求客户端声明扩展能力。`pi-mcp@1.0.2` 的握手固定走 2025-11-25 `initialize`；每请求 `_meta` 能力在该版本的位置「实现时核对」。若无法声明，则只要 AS 在 `jwt-bearer` 路径上接受 KepCup 的交换即可工作（声明主要用于服务端提示"必须用企业流程"）；若某服务器**强制**企业流程而客户端无法声明，是一个 E5 的互操作缺口，登记 DEVIATIONS 并等 `pi-mcp` / 官方 SDK 升级（附录 B.6 的升级触发条件）。

### 6.6 与审批 / 污点 / 工具锁定

不变。企业连接的工具同样走 `core/mcp/risk.ts` 分级、`app_tool_grants`（受 `denyBotLevelGrants` 约束）、污点外发、工具定义锁定；`maxTier` 之外的条目不可见。

## 7. 客户端身份与"公共客户端"问题（E0 的核心）

两处不同的客户端 id，不要混淆：

| 关系                                | 客户端 id                                       | 谁登记                                                             |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| KepCup ↔ 企业 IdP（SSO + 令牌交换） | **组织专属** `idp.clientId`（托管配置）          | 企业管理员在 IdP 注册 KepCup（公共 + PKCE，回环回调）               |
| KepCup ↔ 资源 AS（jwt-bearer）      | `KEPCUP_OAUTH_CLIENT_ID`（CIMD）或预注册客户端   | 无需企业参与（CIMD）；IdP 把它写进 ID-JAG 的 `client_id` 声明        |

问题：草案要求保密客户端；CIMD 客户端是静态共享文档，`token_endpoint_auth_method: none`（`infra/cloudflare/oauth-cimd/public/oauth/client.json` 现状），无法证明"是 KepCup 本尊"。可选路径，**E0 spike 决定**：

1. **接受公共客户端**：资源 AS 自行决定（`workers-oauth-provider` 的 EMA 选项有 `allowPublicClients`，默认要求客户端认证「实现时核对各目标 AS」）；风险由 IdP 策略（只对白名单 `client_id` 与用户组签发 ID-JAG）与 AS 的"受信 issuer"共同承担。
2. **CIMD + `private_key_jwt`**：EMA 规范允许 CIMD 客户端用 `private_key_jwt`。但密钥必须在 CIMD 文档的 JWKS 里公开，所有安装共享同一私钥 ⇒ 不是真正的保密。**不推荐**（把私钥放进客户端分发物等于公开）。
3. **组织自备保密客户端**：管理员在资源 AS（或经 IdP）为本组织注册一个保密客户端，把 `client_id`（及 secret）放进托管配置的 per-app 条目；客户端用它做 jwt-bearer。符合草案，但 per-org per-app 的配置成本高，且 secret 落在端点。
4. **KepCup 托管 EMA 代理**：由 KepCup 服务端持有保密客户端——令牌经过 KepCup 服务器，违背本地优先，且与 `hosted-auth-gateway.md` 的披露要求叠加。**不推荐**。

**建议**：E0 先对 Linear / Atlassian / Canva 实测 1（公共 + CIMD）是否被接受；若多数拒绝则采用 3，并在 `enterprise.apps` 配置段允许 per-app 的 `clientId` / `clientSecret`；2 与 4 不做。

CIMD 文档需要补充 `grant_types`（`token-exchange`、`jwt-bearer`）与 `authorization_grant_profiles_supported`（草案 §8 要求声明了 id-jag 的客户端同时声明这两种授权类型）——这会改动 `client.json`，而该文件"字段改动视同发布，走评审、URL 永不更换"（`connected-apps-user-actions.md` M2），因此改动须单独评审并由用户部署。

## 8. 失败模式

| 场景                                          | 表现                                                                 | 处理                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| IdP 会话过期且无刷新令牌                       | 续期阶梯最后一步需要交互                                             | 运行时：`AppAuthRequiredError{enterprise_sso}`；界面：企业会话"需重新登录"，对话卡按钮     |
| 条件访问 / 需要更强认证                        | IdP 返回 `insufficient_user_authentication`（草案 §9.2，可带 `max_age`） | 同上，登录时带 `max_age` / `acr_values` 重新认证后重试一次                                   |
| 用户被移出组 / IdP 策略拒绝该应用              | 令牌交换返回 `access_denied` / `invalid_target`（具体码「实现时核对」） | 连接置 `expired` 并说明"组织未放行该应用"，**不**回落到个人连接                              |
| 用户在 IdP 被禁用                              | ID Token 刷新失败 `invalid_grant`                                     | 企业会话 `revoked`；派生连接全部失效；清理 ID Token / 刷新令牌                              |
| 资源 AS 不支持 id-jag / 不信任该 IdP           | 元数据缺失 / `invalid_grant`                                          | 连接失败文案区分"服务器未启用企业登录"；按策略决定是否允许走个人 OAuth                      |
| ID-JAG 过期 / 被拒（`jti` 重放、`aud` 不符）   | `invalid_grant`                                                       | 重新向 IdP 换一份新的 ID-JAG 再试**一次**，仍失败则报错（不无限重试）                       |
| 访问令牌被撤销但未过期                         | MCP 调用 401                                                          | 与 `ConnectionAuthProvider.onUnauthorized` 一致：尝试一次续期（重新交换），失败则 `expired` |
| 网络 / IdP 5xx                                 | 临时故障                                                              | 同现有刷新的临时故障分支：令牌未过期继续用，已过期才抛                                      |
| 托管配置变更 / 被删除                          | 策略收紧                                                              | 热更新；被禁用的应用在下次工具列表刷新时下线；已有企业连接保留数据但不可用，给出原因        |
| 时钟偏差                                       | `exp`/`iat` 校验失败                                                   | ID Token 容忍 60 秒；ID-JAG 由 IdP/AS 校验，客户端只在 `iat` 明显在未来时报"系统时间错误"提示 |

## 9. 安全设计

- **断言保管**：ID Token / IdP 刷新令牌逐值存 secrets（`ent:{orgKey}:*`），经 `redact()` 脱敏；**ID-JAG 不落盘**（内存变量，请求完即丢，不进日志 / 审计 / 事件 / 错误信息）；访问令牌同普通连接。安全测试沿用 P0 的"全存储扫描"方法，新增样本：ID Token、IdP 刷新令牌、ID-JAG、`client_secret`。
- **受众 / 资源绑定**：交换请求的 `audience` 取自**已验证的** AS 元数据 issuer，`resource` 取自 `selectResource`；拒绝在 IdP 返回的 ID-JAG 中 `aud` / `resource` 与请求不一致的情形（客户端可不验签，但**可以**解码比对 `aud`/`resource`/`client_id`，作为发错目标的纵深防御）。
- **重放**：`jti` 的一次性由资源 AS 强制（客户端不能依赖）；客户端的责任是不缓存、不重发 ID-JAG 超过一次重试。`workers-oauth-provider` 的 EMA 重放标记是 KV 上的尽力而为（库文档明确"不要说成全局一次性"）——这是服务端话题，此处提醒不要在客户端文案里承诺"防重放"。
- **`cnf` / `authorization_details`**：ID-JAG 含 `cnf`（DPoP）或 `authorization_details` 时，KepCup 不支持处理 ⇒ 失败即关闭（报错而非忽略）。
- **IdP 钓鱼 / 托管配置投毒**：托管文件必须来自管理员可写路径（§5.1）；`idp.issuer` 变更触发"登出旧会话并清理派生连接"；登录页（系统浏览器）展示的是 IdP 域名，设置页在登录前显示完整 issuer 与组织名供核对。
- **混淆企业与个人**：UI 徽标 + 审批卡账号行 + `personalConnections` 策略（§4）；审计里区分 `grant_kind`。
- **令牌寿命与撤销延迟**：IdP 侧禁用用户 / 取消连接后，已签发的访问令牌到期前仍有效（常见 1 小时～1 天，由 AS 决定）；客户端不能缩短它，只能在发现 IdP 会话失效时**立即丢弃本地令牌**并停用连接。文案不得承诺"即时全端撤销"。
- **SSRF**：IdP / AS / PRM 的所有抓取走 `createSafeFetch`；回环例外仅测试钩子。
- **日志**：开发者模式的授权事件日志（`auth/flow-log.ts`）对 EMA 步骤只记阶段与错误码（`idp_login`、`token_exchange`、`jwt_bearer`），不记任何令牌 / 断言。

## 10. 管理员侧需求（IT 在 IdP 里要配什么）

> 以下为通用步骤；各 IdP 的菜单与术语「实现时核对」，E0 产出一份"管理员部署指南"（可发给客户）。

1. **注册 KepCup 为 OIDC 应用**：应用类型原生 / 公共客户端，授权码 + PKCE；重定向 URI 登记 `http://127.0.0.1/callback`、`http://127.0.0.1:47615/callback`、`:47616`、`:47617`（与 CIMD 文档一致，回环端口规则见 RFC 8252）；授权类型含刷新令牌（以便静默续期）与令牌交换；记下 `client_id`（以及 IdP 若要求的 secret）。
2. **启用 ID-JAG 签发**并建立"KepCup（请求方）→ 目标 MCP 应用（资源方）"的连接（Okta：Cross App Access / XAA 的应用连接；Entra / Google Workspace 的对应能力「实现时核对」）。
3. **分配用户 / 组与可授予的 scope**（决定谁能通过 KepCup 用哪个应用）。
4. **分发托管配置**（§5）：通过 MDM / 软件分发把 `managed-settings.json` 放到系统路径。
5. 在目标 MCP 服务器一侧（若需要）把该 IdP 加入受信 issuer、允许 KepCup 的客户端 id（CIMD URL 或预注册）。
6. 验证：用测试账号登录 KepCup → 看到"组织：ACME"徽标 → 连接 Linear 无同意页 → 在 IdP 取消该应用的分配 → 下次续期时连接失效。

## 11. 审计与导出

- 复用 `audit_log`（`apps/audit.ts` 的 `AppAuditor`）：新增动作 `app_ema_login`、`app_ema_logout`、`app_ema_exchange`（明细仅含 `connectionId`、`connectorId`、`org`、`idp_issuer`、`audience`、`resource`、`scope`、`outcome`、`errorCode`，**不含**任何令牌 / 断言 / 邮箱）、`app_ema_policy_denied`；既有 `app_connect` / `app_disconnect` 增加 `grantKind`。
- 导出（`policy.auditExport`）：E5 先做**本地 NDJSON 追加文件**（按日滚动，管理员用现有终端日志收集工具拉取）；syslog / HTTP 推送列开放问题 Q6。导出内容与 UI 内审计同源，导出过程本身也受脱敏。
- 汇总：Bot 详情 / 设置页「企业」显示本机企业会话与 EMA 连接状态，便于排错。

## 12. 测试策略

**原则**：全部离线，不访问真实 IdP / 厂商；真实验证放用户待办（§14）。

- **testkit 新增 `fake-oidc-idp.ts`**：OIDC 发现（含 `identity_chaining_requested_token_types_supported`）、`/authorize`（无 UI，直接回调，校验 PKCE / nonce / `redirect_uri` 精确匹配）、`/token`（授权码 → 签名的 ID Token + 刷新令牌；RFC 8693 → 签名的 ID-JAG，`typ: oauth-id-jag+jwt`；`subject_token` 为刷新令牌的变体）、`/jwks`；可注入：策略拒绝 / `insufficient_user_authentication` / 用户禁用（刷新 `invalid_grant`）/ ID-JAG 带 `cnf` / `aud` 不符 / 过期。签名用 `node:crypto`（ES256/RS256），不引入新依赖。
- **扩展 `fake-oauth-mcp-server.ts`**：配置项 `idJag: { trustedIssuers, jwks, requireClientAuth, allowPublicClients }`；元数据宣告 `authorization_grant_profiles_supported` 与 `grant_types_supported` 含 `jwt-bearer`（现为 `['authorization_code','refresh_token']`）；`/token` 处理 `jwt-bearer`：校验 typ / 签名 / iss / aud / client_id 绑定 / resource / exp / `jti` 重放，签发**无刷新令牌**的受众绑定访问令牌；记录请求供断言（现有 `tokenRequests` / `RecordedTokenRequest` 机制）。
- **单元**：托管配置解析 / 权限检查 / 锁定字段；`idp-session`（state / nonce / `iss` / `aud` 校验、回环回调）；`ema-grant` 请求体逐字段（audience、resource、subject_token_type、requested_token_type）；`GrantRenewer` 续期阶梯每一档（ID-JAG 复用 → 重新交换 → 刷新 ID Token → 需要交互）；`epoch` 竞态（交换期间断开）。
- **集成**：真实 core + 假 IdP + 假 AS+MCP：登录 → 勾选 Bot → 工具调用 → 强制令牌过期 → 静默重新交换 → IdP 禁用用户 → `enterprise_sso` 卡片；个人 / 企业并存与 `personalConnections` 策略；`maxTier` 过滤签名目录；`disableDeveloperMode` 锁定设置。
- **安全**：全存储扫描（ID Token / IdP 刷新令牌 / ID-JAG / 访问令牌 / client secret 在 `runs.db`、`audit_log`、日志、RPC 返回、事件、模型请求体中零出现）；托管文件权限不当被忽略；`cnf` / `authorization_details` 失败即关闭；错误的 `iss` / `aud` / `nonce` 被拒；运行时从不打开浏览器（假 `shell.openExternal` 调用次数断言为 0）。
- 契约：假 IdP / AS 的行为以 §16 规范示例报文为准；对真实服务的核对放 E6。

## 13. 阶段与任务（每项含验收）

> 测试用 `node scripts/run-tests.mjs run <文件或目录>`（Docker，见 `connected-apps.md` §2.2）；交付前一次全量 + `pnpm lint` + `pnpm typecheck`。

### E0 调研与决策（无产品代码）

- [ ] 对 Linear / Atlassian / Canva（及目录其余应用）读取 AS 元数据，记录 `authorization_grant_profiles_supported`、是否接受公共 / CIMD 客户端（§7）；对一个可用的测试 IdP（Okta 开发者租户或公开的测试 IdP）跑通一次 ID-JAG 全流程（手工 curl 即可）；确认 IdP 对公共客户端做令牌交换的要求。
- [ ] 与用户确认托管配置路径与分发渠道（Q2）、许可策略（Q5）。
- 验收：写入本文件「E0 记录」：每个应用的结论与证据日期；§7 的路径选择；管理员部署指南草稿（§10）。**未完成 E0 不进入 E1。**

### E1 testkit：假 IdP + 假 AS 扩展

- [ ] §12 的 `fake-oidc-idp.ts` 与 `fake-oauth-mcp-server.ts` 的 `jwt-bearer` 扩展，自带自测。
- 验收：对假 AS 手工完成 SSO → 交换 → jwt-bearer 的全链路；全部注入场景（拒绝 / 重放 / aud 不符 / cnf / 过期）返回规范错误码；`fake-oauth-mcp-server` 既有测试零回归。

### E2 托管配置与策略

- [ ] shared schema `enterprise.ts`；`apps/enterprise/org-config.ts`（读取 / 权限检查 / 热更新）、`OrgPolicy`；`settings` 锁定（`locked` 字段、`settings.update` 拒绝）；目录与签名目录合并的 `allowedApps` / `maxTier` / `disableCommunityDirectory` 过滤；`tier.ts` 的 `denyBotLevelGrants`；MCPB / 自定义 server 限制；渲染端灰显与说明。
- 验收：各策略逐项（允许 / 拒绝 / 热更新）单测；配置文件权限不当被忽略并告警；非法 schema 整体忽略且界面报错；锁定字段无法被 `settings.update` 修改（core 层断言）；无企业配置时全部既有测试零回归。

### E3 企业登录

- [ ] `idp-session.ts`、RPC / 事件、设置页「企业」分区（手动评估模式标注"未受管"）、登出清理、`enterprise_sessions` 迁移。
- 验收：对假 IdP——登录成功；`state` / `nonce` / `iss` / `aud` 篡改被拒；回调重放被拒；换端口回调按登记规则；登出清除全部 `ent:*` 秘密并使派生连接失效；`shell.openExternal` 仅在用户点击登录时调用。

### E4 EMA 连接与静默续期

- [ ] `ema-grant.ts`、`flow.ts` 的路径选择、`GrantRenewer`、`runtime-provider.ts` 的 EMA 续期阶梯、`grant_kind` / `account_sub` 规则、`enterprise_sso` 原因与连接卡文案、`maxTier` / `personalConnections` 在连接与 Bot 勾选处的强制。
- 验收：集成——零点击连接（无同意页、无浏览器）；令牌过期静默续期且单飞；IdP 会话死亡 → `enterprise_sso`；个人 / 企业并存且同 Bot 至多一个；企业连接审批卡带组织徽标与账号；运行时 0 次打开浏览器；全存储扫描零明文；个人连接用例零回归。

### E5 审计、导出、能力声明与互操作

- [ ] 审计动作与本地 NDJSON 导出；`client.json` 更新方案（提交评审，**由用户部署**）；`_meta` 能力声明（视 §6.5 结论）；开发者模式日志。
- 验收：审计明细无令牌 / 邮箱；导出文件滚动与脱敏；对假服务器强制企业流程时的行为符合 §6.5 结论。

### E6 真实环境验证（含用户待办）

- [ ] 用真实 IdP 租户 + 至少一个真实支持 EMA 的 MCP server 走通 §10 第 6 步；核对 §3.2 表中所有「实现时核对」项并回填本文件。
- 验收：用户确认；`docs/dev/PROGRESS.md` 新增"企业 EMA"行；偏差记 `DEVIATIONS.md`。

## 14. 用户待办（Agent 不做，不要代为登录 / 注册 / 创建资源）

> 汇总见 `todo/connected-apps-user-actions.md`「P4 启动前的用户决定」；以下为明细。

- [ ] **启动决定**：是否做企业版、目标客户的 IdP（Okta / Entra / Google / 其他）、是否接受仅支持 OIDC（不含 SAML-only）。
- [ ] **测试 IdP 租户**：一个 Okta 开发者租户（或其他支持 ID-JAG 签发的 IdP），能创建应用与连接；以及（若 E0 选择路径 3）能在目标 MCP 服务器一侧注册保密客户端的测试账号。
- [ ] **目标平台的测试账号**：Linear / Atlassian / Canva 等支持 EMA 的服务器的企业或试用租户（Atlassian 需管理员权限）。
- [ ] **托管配置的发行与分发渠道**：安装包（MSI / pkg / deb）与 MDM 部署方式；配置文件路径最终确认。
- [ ] **许可 / 定价决定**（开放问题 Q5）：企业特性是否需要许可校验。
- [ ] **CIMD 文档变更评审与部署**（§7，`client.json` 的 `grant_types` / `authorization_grant_profiles_supported`）。
- [ ] 隐私政策补充：企业会话与审计导出（本地文件，数据不离开设备）。

## 15. 开放问题

| #   | 议题                                                              | 推荐默认                                                                         |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Q1  | 公共客户端能否用 EMA（§7）                                         | E0 实测；多数拒绝则采用"组织自备保密客户端"                                      |
| Q2  | 托管配置来源与路径（§5.1）                                         | 本机只读托管文件；手动评估模式不能锁策略                                         |
| Q3  | 是否支持 SAML-only IdP                                             | 不支持（草案 §4.5 需要额外的断言 → 刷新令牌互换，另立任务）                      |
| Q4  | 会话建立后是否对 `allowedApps` 预连接                              | 否：用户首次勾选 / 使用时才交换                                                  |
| Q5  | 许可 / 计费 / 是否仅限特定发行渠道                                  | 先不做校验，企业配置存在即启用（用户决定）                                       |
| Q6  | 审计导出形态（本地文件 / syslog / HTTP）                            | 本地 NDJSON；其余按客户需求                                                      |
| Q7  | `pi-mcp@1.0.2` 能否声明 EMA 扩展能力（§6.5）                       | 不阻塞；记 DEVIATIONS，等升级触发条件（附录 B.6）                                 |
| Q8  | 企业 + 托管网关叠加：EMA 令牌是否可经网关                          | 否（网关任务书不覆盖；企业场景保持令牌留在设备）                                 |
| Q9  | 一台设备多个组织会话                                               | 不支持（一次一个企业会话）                                                       |

## 16. 参考

> 2026-10-10 联网读取；规范仍在演进，「实现时核对」。

- MCP 扩展页：<https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization> ；稳定规范（ext-auth 仓库）：<https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx> ；SEP-990
- MCP 博客「Enterprise-Managed Authorization: Zero-touch OAuth for MCP」（2026-06-18，采用方与已支持服务器名单）：<https://blog.modelcontextprotocol.io/posts/enterprise-managed-auth/>
- IETF 草案 Identity Assertion JWT Authorization Grant：<https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/>（读到 `-04`，2026-05-21；上游 `draft-ietf-oauth-identity-chaining`）
- RFC 8693（令牌交换）：<https://www.rfc-editor.org/rfc/rfc8693> ；RFC 7523（JWT bearer 授权）：<https://www.rfc-editor.org/rfc/rfc7523> ；RFC 8707、RFC 9207、RFC 8252、RFC 9470（step-up 认证挑战）
- MCP Authorization 2026-07-28：<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- Okta Cross App Access：第三方集成文档（Zuplo、Scalekit、MintMCP）可见其使用方式，Okta 一手文档地址未能离线确认——开工时从 Okta 开发者站点查找「Cross App Access」「实现时核对」；公开测试环境 `xaa.dev`（第三方）可作联调参考「实现时核对」
- Cloudflare `workers-oauth-provider` 的实验性 EMA 校验（服务端视角，了解 AS 侧如何校验 ID-JAG、`allowPublicClients`、重放标记的局限）：<https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/advanced-configuration.md>
- 本仓库：`todo/connected-apps.md` §8 与附录 B.6、`todo/hosted-auth-gateway.md`、设计 29 §1.2 / §11.8

## 与已实现模块的接缝

| 模块                                                      | 变化                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/domain/enterprise.ts`（新）          | 托管配置 / 策略 / 企业会话视图 schema                                                                                  |
| `packages/shared/src/domain/connector-catalog.ts`         | `connectorAuthSchema` 增 `enterprise?: { supported, idpHint? }`                                                        |
| `packages/shared/src/domain/types.ts`                     | `appAuthReasonSchema` 增 `'enterprise_sso'`；`settings.get` 返回 `locked`                                              |
| `packages/core/src/apps/auth/flow.ts`                     | 增加"企业路径"选择（不起回调服务）；客户端身份沿用 CIMD / 预注册；不改动个人流程                                         |
| `packages/core/src/apps/auth/runtime-provider.ts`         | 注入 `GrantRenewer`；`grant_kind='ema'` 用重新交换代替 `refresh_token`；需要交互 → `enterprise_sso`                      |
| `packages/core/src/apps/auth/registry.ts`                 | `providerFor` 按连接 `grant_kind` 选择续期实现                                                                          |
| `packages/core/src/apps/token-vault.ts`                   | 新命名空间 `ent:{orgKey}:id_token|refresh|client_secret`（逐值）                                                        |
| `packages/core/src/apps/enterprise/*`（新）               | `org-config.ts`、`idp-session.ts`、`ema-grant.ts`、`policy.ts`                                                          |
| `packages/core/src/apps/catalog.ts` / `directory-merge.ts` | `allowedApps` / `maxTier` / `disableCommunityDirectory` 过滤（沿用 drop 原因机制）                                      |
| `packages/core/src/apps/tier.ts`                          | `denyBotLevelGrants`                                                                                                   |
| `packages/core/src/apps/connections.ts` / `connection-store.ts` + 迁移 | `grant_kind`、`enterprise_org`、`enterprise_sessions`；Bot 勾选与 `personalConnections`                    |
| `packages/core/src/apps/disconnect.ts`                    | 企业连接断开：无 RFC 7009 吊销对象时只清本地；登出时批量失效                                                            |
| `packages/core/src/apps/audit.ts`                         | 新动作 `app_ema_*`；`grantKind` 字段；NDJSON 导出                                                                      |
| `packages/core/src/domain/settings.ts`（及 `settings.update` 绑定） | 托管字段锁定                                                                                                  |
| `packages/testkit`                                        | 新 `fake-oidc-idp.ts`；`fake-oauth-mcp-server.ts` 增 `jwt-bearer` / id-jag                                              |
| `infra/cloudflare/oauth-cimd/public/oauth/client.json`    | 增 `grant_types` / `authorization_grant_profiles_supported`（须评审，用户部署）                                          |
| `mcp/service.ts`、`mcp/risk.ts`、`apps/taint.ts`、`apps/tool-lock.ts` | **不变**（企业连接无特例）                                                                                  |

## E0 记录（填写）

> 尚无。每个目标应用一节：AS 元数据 / 公共客户端是否接受 / 实测日期 / 结论。

# 连接应用（D73）需要用户手动处理的事项

> 状态：2026-10-10 汇总（P0–P3 已实现；P4 的两份任务书已写，未实现）。这些事项 Agent **不能也不应代做**（要登录账号、注册平台应用、持有私钥、改 Cloudflare 账户设置）。Agent 已把准备材料与验证脚本做好，每项下面写明「材料在哪、你要做什么、做完怎么验证、卡住哪个阶段的验收」。
>
> 编号沿用 `todo/connected-apps.md` §2.3（U1–U5）；新增的 M 系列是合入与账号类杂项。完成一项就在这里打勾，并在 `docs/dev/PROGRESS.md` 对应阶段补一行验收记录。

## 总览


| #   | 事项                                                                                                                                 | 卡住什么                              | 状态  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --- |
| U1  | 部署 CIMD 文档并验证；Notion / Linear 手工走通一次                                                                                               | P0 门禁（真实环境部分）                     | [ ] |
| U2  | ~~首批应用测试账号 → 登录实测 → 放行~~ **已移出用户待办（2026-10-10）**：这是逐家适配，转为开发任务，见 [extension-center.md](extension-center.md) §4 / X5 | — | —   |
| U3  | GitHub App 注册（预注册客户端）                                                                                                              | P2 §6.4 的 GitHub 条目、P2 门禁的真实预注册走通 | [ ] |
| U4  | Google / Microsoft / Slack / Figma 的平台注册与审核                                                                                        | P2 §6.4 对应条目                      | [ ] |
| U5  | 目录签名密钥、`dl.` / `registry.` / `developers.` 子域、Workers Paid、D1 / Turnstile / GitHub OAuth 应用；`kepcup-app validate --auth` 对真实上架应用实测 | P3 的线上部分与真机验收（本地实现与测试不依赖）         | [ ] |
| M1  | 合入 main 前的最终确认与迁移重编号                                                                                                               | 合入 main                           | [ ] |
| M2  | 隐私政策页面与 CIMD 里的 `logo_uri` / `policy_uri`                                                                                          | U1 之前                             | [ ] |




## C0 — Cloudflare 凭证（让 Agent 能直接操作 Cloudflare；U1 / U5 的前置）

已装好新的 Cloudflare CLI `cf`（beta）与 `wrangler`；详细方法见 [infra/cloudflare/README.md](../infra/cloudflare/README.md)。

- [x] 确认 `kepcup.com` **在哪个 Cloudflare 账号下**（账号 id `37918f50…`；会话环境里原有的令牌属于别的账号 / 项目，没有使用）。
- [x] 在该账号建**令牌 A「kepcup-deploy」**（Workers Scripts / D1 / Account Settings 读 + kepcup.com 的 Zone 读、DNS、Workers Routes、Cache Purge），按 README §4.1。
- [x] `cp .env.example .env && chmod 600 .env`，填 `CLOUDFLARE_ACCOUNT_ID` 与令牌（**不要贴进聊天**）。
- [x] 运行 `infra/cloudflare/with-env.sh check`，目标 zone 可见（2026-10-10 通过）。
- [ ] （仅在需要时）令牌 B「kepcup-zone-admin」用于 WAF / Bot Fight Mode；免费套餐的 Bot Fight Mode 可能只能在控制台手动关。
- [ ] 升级 Workers Paid 仍然只能你在控制台做。



## C1 — 剩余的 Cloudflare 变更（顶级域记录、CIMD、registry 域名、dl 域名、限速规则均已由 Agent 完成）

已完成并验证：`AAAA kepcup.com 100::`、`oauth-cimd` 部署（`verify.mjs` 通过）、`registry.kepcup.com` custom domain（冒烟通过）。详情见 [infra/cloudflare/README.md](../infra/cloudflare/README.md) §7。仍待办：

- [x] （已由 Agent 完成）`registry.kepcup.com` 的 WAF 限速规则已写入（每 IP 每 10 秒 60 次，免费套餐唯一的一条限速规则）。
- [x] （已由 Agent 完成）`dl.kepcup.com` 已上线并验签通过；签名私钥在 `.env`（**请自行备份**），公钥已登记进 `CONNECTOR_INDEX_PUBLIC_KEYS`（`kepcup-2026-1`）。之后更新目录：`infra/cloudflare/sign-directory.sh --out infra/cloudflare/directory/public/connectors/v1 --key-id kepcup-2026-1`，再 `with-env.sh wrangler deploy --config infra/cloudflare/directory/wrangler.jsonc`。
- [ ] 首次定时同步（:17 UTC）后确认 `sync_state` 有数据、`/v0.1/servers` 非空。



## U1 — CIMD 文档部署与验证（P0 门禁）

材料：`infra/cloudflare/oauth-cimd/`（`wrangler.jsonc`、`public/oauth/client.json`、`public/_headers`、`README.md`、`verify.mjs`）。

- [x] **已决定（2026-10-10）：先用免费版**。kepcup.com 的 Bot Fight Mode 本来就是关的（`fight_mode:false`，Agent 只读核对过），CIMD 现在可被授权服务器正常抓取（`verify.mjs` 通过）。**约束**：免费版下保持 Bot Fight Mode 关闭；若以后要开，必须先升级 Pro 并用 WAF 自定义规则 Skip `/oauth/*` 与 `/.well-known/*`（免费版只能整站开关，开了会拦掉授权服务器对 CIMD 的抓取，表现为 `invalid_client`）。同时不要启用「Block AI bots」覆盖 `/oauth/*`（设计 29 §15.1）。
- [x] （已由 Agent 完成）`wrangler deploy`（路由 `kepcup.com/oauth/*`，只接管该路径，与现有官网并存）。`www` 跳转、尾斜杠规范化等规则不能作用于 `/oauth/*`（不得重定向）。
- [x] （已由 Agent 完成，通过）运行 `node infra/cloudflare/oauth-cimd/verify.mjs`：应当检查 200、`application/json`、无重定向、≤5 KB、`client_id` 与 URL 逐字相等、内容与仓库文件一致。
- [x] **外部可用性监控（2026-10-10 决定用 GitHub Actions）**：`.github/workflows/uptime.yml` 每 20 分钟跑 `oauth-cimd/verify.mjs`、`directory/verify.mjs`（验签）和注册表冒烟（200、结构、非空、POST 405），失败由 GitHub 发邮件。仓库是公开的，标准 runner 免费不限分钟。**定时触发只在默认分支生效，所以要等 M1 合并到 main 后才开始跑**；合并后可在 Actions 页手动触发一次确认。注册表在 17:17 UTC 首次同步前为空，工作流会判失败（预期）。需要状态页或更密频率时再加 UptimeRobot 免费版。
- [x] **已完成（2026-10-10，用户实测）**：Notion 与 Linear 官方 MCP 以「自定义」方式连接均成功；结果已记入 `docs/dev/PROGRESS.md`「连接应用 P0」。（调用 / 过期重连 / 断开未逐项回报。）



## U2 — 已移出用户待办（2026-10-10）

用户决定：测试各家、补目录数据、放行本质是**逐家适配**，属于后续开发；产品形态也改为把「技能市场」升级为「扩展中心」（Skills / 连接 / MCP 三组），连接组按「测试好一家上一家」预置，不再让用户自建 MCP 连接。完整任务书：[extension-center.md](extension-center.md)（§4 是单家适配流程，X5 是逐家适配的持续任务）。

对你仍有影响的只有一点：适配每一家时，**账号持有人要在浏览器里登录授权一次**，并自备测试账号 / 站点（密码和令牌不给 Agent、不贴进聊天）。Notion、Linear 账号已就绪，排在最前。

## U3 — GitHub App 注册

GitHub 的授权服务器元数据没有声明 CIMD / DCR，也没有吊销端点，所以需要预注册客户端。

- [ ] 注册 KepCup 的 GitHub App（设备 / 回环回调以 GitHub 当时文档为准，最小权限）。
- [ ] 把**平台定义为非保密**的客户端信息填入 `apps/desktop/oauth-clients.json`（`{ [clientRef]: { issuer, clientId, clientSecret? } }`，现为 `{}`；不要放保密的 secret），并在目录条目里写对应 `auth.clientRef` 与 `registration: "preregistered"`。
- [ ] 真实走通一次预注册客户端授权（P2 门禁要求「至少一个预注册条目真实走通」，Google 或 GitHub 任一即可）。



## U4 — 大平台注册与审核

- [ ] **Google**：Cloud 项目、OAuth 同意屏幕、「桌面应用」类型客户端、应用验证；首批只用非受限范围（`drive.file`、日历、`gmail.send` 等）。受限范围需要 CASA 安全评估——是否做由你决定。
- [ ] **Microsoft 365**：Entra 应用注册（公共客户端 + 回环回调）。
- [ ] **Slack**：只能用已发布 / 内部应用——需要创建并上架（或内部分发）Slack 应用。
- [ ] **Figma**：需向 Figma 申请合作 / 白名单；未获批准前不进目录。
- [ ] 每一项完成后：填 `oauth-clients.json` + 目录条目，跑一次真实授权。



## U5 — P3 的线上部分（目录签名与服务端）

本地实现与测试不依赖这些（用一次性测试密钥和本地假服务），但上线需要。生产公钥列表在你生成密钥前是**空的**——此时目录同步自动停用，只用随应用打包的快照。

- [ ] 生成 **Ed25519 目录签名密钥对**：私钥只放 CI 的加密环境变量（`KEPCUP_CONNECTOR_SIGNING_KEY`），**不进仓库、不进 Workers Secrets**；公钥（含 `keyId`）填入 shared 常量 `CONNECTOR_INDEX_PUBLIC_KEYS` 并随应用发布。密钥轮换流程见 `infra/cloudflare/directory/README.md`。
- [ ] 创建子域并部署：`dl.kepcup.com`（签名索引与增量，`infra/cloudflare/directory/`）、`registry.kepcup.com`（子注册表 Worker，`infra/cloudflare/registry/`：先创建 D1 数据库并把 `database_id` 填进 `wrangler.jsonc`，初始化 `schema.sql`，配置 Cron）。
- [ ] 升级 **Workers Paid**（约 $5/月起；D1 容量、Workflows、Sandbox 需要）。
- [ ] 开发者门户（`todo/developer-portal.md`，本期只出任务书）将来需要：`developers.kepcup.com`、GitHub OAuth 应用、Turnstile 站点密钥、R2 / D1。
- [ ] 部署后分别运行各目录下的 `verify.mjs`；`registry.kepcup.com` 另按 `infra/cloudflare/registry/README.md`「部署」第 6–7 步回填并 `curl` 冒烟，并逐条核对该 README「响应形状：已对照与仍需核对」里的推断项（严格 `ResponseMeta`、422、游标、`updated_since` 边界、`/v0` 别名、D1 行为）——本期离线，未在真实 Cloudflare 运行时验证。
- [ ] 目录签名 CI 步骤：把 `scripts/sign-connector-index.mjs` 接入 CI（每次目录变更签名并发布到 `dl.kepcup.com`；用法与增量生成见 `infra/cloudflare/directory/README.md`）。填入公钥并发布应用新版本之后，旧版本客户端没有公钥，目录同步对它们仍是停用的——这是预期行为。
- [ ] **真机验收（todo §7.8 的用户部分）**：自动化只验了自写的 Linear 形态 `server.json` 夹具 + 假服务器。请取一个已上架 Claude / ChatGPT 目录的真实应用（如 Linear 官方 MCP）的 `server.json`，补上 `_meta["app.kepcup/connector"]` 后运行 `node packages/app-validator/dist/cli.js validate <server.json> --auth`（先 `pnpm --filter @kepcup/app-validator build`；`--auth` 要在浏览器里登录），把结果记入 `docs/dev/PROGRESS.md`「连接应用 P3」。



## P4 启动前的用户决定（两份任务书均**未开工**，默认不启动）

任务书：[hosted-auth-gateway.md](hosted-auth-gateway.md)（托管授权网关）、[enterprise-ema.md](enterprise-ema.md)（企业托管授权）。下面是 Agent 动手前需要你拍板的事；没有你的明确批准，两者都保持任务书状态。

- [ ] **托管网关：是否启动？** 默认不建。只有某个你确实需要的平台无法用本地客户端身份接入（任务书 §1 的决策清单，G0）才启动；目前没有已确认需要的平台（Google / Microsoft 走桌面公共客户端；Slack / Figma 的瓶颈是平台审核，网关绕不过）。同意启动即同意「令牌离开本机」的产品代价。
- [ ] 网关身份方案（任务书 §5 Q1）：推荐「上游账号即身份」，不做 KepCup 账号体系；如不接受请在 G0 前说明。
- [ ] 网关法务与数据地域：隐私政策「托管网关」章节、Cloudflare DPA、子处理者清单、数据删除说明页；欧盟存储与大陆用户出境的法务意见（任务书 §9）。
- [ ] 网关前置资源（G6 才需要）：Workers Paid、`auth.kepcup.com` / `mcp.kepcup.com`、`eu` 管辖区资源、保险库主密钥（离线备份）、平台应用注册（保密客户端）。
- [ ] **企业 EMA：是否做企业版？** 目标 IdP（Okta / Entra / Google / 其他）、是否接受仅 OIDC（不含 SAML-only）、许可与定价（任务书 Q3 / Q5）。
- [ ] 企业测试环境（E0 / E6 才需要）：Okta 开发者租户（或其他支持 ID-JAG 签发的 IdP）、Linear / Atlassian / Canva 等支持 EMA 的服务器的测试租户。
- [ ] 托管配置的发行渠道与路径（任务书 §5.1 的提案：各平台系统级只读 `managed-settings.json`）、`client.json` 增加 `grant_types` / `authorization_grant_profiles_supported` 的评审与部署（任务书 §7，属 M2 的「发布即评审」范围）。



## M1 — 合入 main 前的最终确认（Agent 不会自行合入）

- [ ] 你明确同意后再合入 main；合入前 Agent 会：把 main 合进分支、迁移重新编号（当前分支用 `0025_app_connections`、`0026_app_tools`、`0027_egress_approval`，若 main 又新增迁移则顺延；`app-connections-migration.test.ts` 等有编号断言的测试同步改）、跑全量测试一次。
- [ ] 与主工作树里他人尚未提交的改动（共享的 `types.ts` / `constants.ts` / `methods.ts` / `events.ts` / `bindings.ts` / `zh-CN.ts`）会有文本冲突，由 Agent 在分支侧解决。
- [ ] 合入后删除分支 `t/d73-connected-apps`（本地 worktree `/home/jyy/wt/kepcup-d73` 与远端分支）。
- [ ] 推送方式：HTTPS 凭据缓存会过期，分支一律用 SSH 推（`git push git@github.com:jooler/kepcup.git t/d73-connected-apps:t/d73-connected-apps`）。



## M2 — 隐私政策与 CIMD 元数据

- [ ] 在 `https://kepcup.com/privacy` 放上隐私政策页面（`client.json` 的 `policy_uri` 与目录条目都会引用；Agent 写的是占位地址，**请确认 URL 与内容**）。
- [ ] 提供 `https://kepcup.com/oauth/logo.png`（`client.json` 的 `logo_uri` 目前是占位，文件不存在）。
- [ ] `client.json` 一旦发布，`redirect_uris` / `client_name` 等字段改动视同发布，走评审；**URL 永不更换**。



## 其他待你决定的开放项（不阻塞）

- [ ] **DEV-022**（`docs/dev/DEVIATIONS.md`，P3 的 13 项偏差，推荐全部保留）——请确认；其中第 11 项的前提是 U5 之前生产公钥列表为空。
- [ ] 目录增量文件的客户端消费（脚本已生成，客户端每次拉完整索引；目录变大后再做）。
- [ ] 技能克隆的体积 / 时间上限（D63 既有行为，克隆发生在审批之前；DEV-022 第 4 项）。
- [ ] §6.8「+」菜单临时开关（P2 可选项，当前未做）。
- [ ] MCPB 的 URL 下载与目录卡片「安装本地包」按钮（P2 已做本地文件安装，URL 下载未做）。
- [ ] 若将来增加由 Agent 发起的 MCPB 安装入口，必须先给安装审批卡加「永不自动批准」标记（DEV-021 第 5 项）。
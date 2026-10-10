# 连接应用（D73 / D74）进度总览：已完成、未完成、阻塞在谁

> 更新：2026-10-10（P3 提交 `d4bed6b` 之后，已把 main 合入分支）。本文只做**汇总与导航**，细节以链接的文档为准；执行方案是 [connected-apps.md](connected-apps.md)，产品契约是 [design/29](../docs/design/29-connected-apps.md)。
>
> 分支：`t/d73-connected-apps`（独立长期分支，**未合入 main**，合入需你明确同意）。迁移：main `0025_app_connections`、`0026_app_tools`、`0027_egress_approval`（P3 没有新增迁移）。
>
> 扩展中心（[extension-center.md](extension-center.md) X0–X4 / X6：技能市场 → Skills / 连接 / MCP 三组，自定义入口收进开发者模式）已在 `t/extension-center` 分支实现，待评审合并；X5 逐家适配另行推进。

## 1. 一眼看懂

| 阶段 | 内容                                                                 | 代码 / 自动化测试 | 真实环境验收                               |
| ---- | -------------------------------------------------------------------- | ----------------- | ------------------------------------------ |
| P0   | MCP OAuth 地基（自定义 HTTP server 走 OAuth、令牌库、运行时刷新）    | **完成**          | 待 U1（部署 CIMD、Notion / Linear 手工走通） |
| P1   | 连接应用 MVP（目录、多账号、Bot 授权、风险分级审批、工具锁定、设置「应用」、ACP 能力包） | **完成**          | 待逐家适配（[extension-center.md](extension-center.md) X5） |
| P2   | 规模化（step-up、污点外发、按需发现、预注册 / BYO 客户端、MCPB、开发者模式、协议版本调研） | **完成**（§6.8 可选项未做） | 待 U3 / U4（真实预注册客户端走通一次）     |
| P3   | 开放平台基座（签名目录索引、分级信任、子注册表 Worker、校验器 CLI、MCP Apps 渲染、随附技能、开发者门户任务书） | **完成**          | 待 U5（签名密钥、子域与 Worker 部署）      |
| P4   | 企业与托管网关                                                       | **只出任务书**（见 §4） | 不适用（本期不实现）                       |

最近一次全量测试（P3 收口）：3375 通过 / 26 失败——26 例全是原有的沙箱 / es-git / wiki 环境基线文件，无新增失败；`pnpm typecheck`、`pnpm lint` 通过。

## 2. 已完成（按能力说，不按阶段）

**授权与令牌**

- 自定义 HTTP MCP server 可选 OAuth：CIMD / DCR / 手填三条注册路径、PKCE + `iss` 校验、本机回调服务（校验 `Host`）、SSRF 防护的发现请求。
- 令牌逐值存加密 secrets（Token Vault），不进 RPC 返回 / 界面 / 日志 / `runs.db` / 审计 / 模型上下文；有专门的安全测试扫描全部落点。
- 运行时只刷新、**绝不**自行弹浏览器；授权失效在对话里出重连卡，重连后 `runs.retry` 续跑；断开会向授权服务器吊销。
- 客户端选择顺序：本机手填（BYO）→ 目录 `clientRef` 预注册 → 已存 DCR → CIMD → DCR；预注册条目签发方对不上时直接失败，不回退。

**连接与目录**

- 内置目录 6 家（Notion、Linear、Atlassian、Sentry、Canva、Stripe），**当前发行门禁全部关闭**（逐家适配见 [extension-center.md](extension-center.md)）。
- 多账号、账号识别（id_token / userinfo / `whoami`）、首次连接工具复核、Bot 勾选、对话内「请求连接」卡、群聊多个 Bot 并发请求合并到同一流程。
- 设置「应用」分区（扩展中心之后只管已连接账号；发现与添加在扩展中心「连接」组，自定义 MCP 在「设置 → 开发者模式」，见设计 29 §16）；连接详情页（权限、逐工具风险与策略、待复核 diff、持续授权撤销、重新连接、断开影响提示）。

**安全策略**

- 风险分级（只读 / 写 / 破坏性，复用 W5）+ 审批时长：写工具可「仅这一次 / 本对话 / 对该 Bot 总是」，破坏性仅一次；无人值守自动批准并审计风险档与账号。
- 工具定义锁定（防 rug pull）：新增 / 变更的工具复核前不暴露。
- 污点外发控制：读过应用数据后，`web_fetch` / `web_search` / 浏览器 / 沙箱 bash / `watch_create` / `git_remote` / 自定义 MCP 外发 / ACP 桥都要确认；污点随委派与群聊传播；`settings.apps.taintGuard` 可关。
- step-up（追加权限）：同一对话同一连接 30 分钟内最多一张卡。
- 分级信任：community 应用写工具不能「总是允许」、首连必须确认；目录里社区分组默认折叠。
- 按需工具发现：应用工具超过 40 个时只注入摘要 + `app_search_tools` / `app_call_tool`。

**开放平台基座**

- 签名目录索引：Ed25519 验签、防回滚、与打包快照合并；生产公钥列表在你生成密钥前为空，此时自动停用，只用快照。
- 子注册表 Worker（`infra/cloudflare/registry/`）：官方 OpenAPI v0.1 只读子集，D1 + 定时同步，审核结果经窄接口写入。
- 校验器 CLI `kepcup-app validate`（`packages/app-validator`），含 `--auth`。
- MCP Apps 渲染：特权协议 + 沙箱 iframe + 严格 CSP；界面发起的写操作必须人工确认；真实 Electron 的 e2e 安全测试（含已修复的 core-port 劫持）。
- MCPB 本地包安装（zip 加固、sha256 绑定、敏感配置入 secrets）、开发者模式（原始工具定义、脱敏授权日志、手动刷新）。
- 随附技能：连接后提示安装，走原有 `skill_import` 审批。

## 3. 未完成（四类）

### 3.1 需要你动手（Agent 不做，清单见 [connected-apps-user-actions.md](connected-apps-user-actions.md)）

| #  | 事项                                             | 阻塞                                           |
| -- | ------------------------------------------------ | ---------------------------------------------- |
| C0 | Cloudflare 凭证（`.env` 里的令牌 + 账号 ID；`cf` 已装好，见 [infra/cloudflare/README.md](../infra/cloudflare/README.md)） | **所有 Agent 直接操作 Cloudflare 的前提**（U1 / U5 的部署与 DNS / WAF 操作） |
| U1 | 部署 CIMD 文档、跑 `verify.mjs`、Notion / Linear 手工走通 | P0 真实验收                                    |
| ~~U2~~ | **已移出用户待办（2026-10-10）**：逐家适配转为开发任务，随「扩展中心」推进，见 [extension-center.md](extension-center.md) | 在此之前目录 6 家在发行版里**不可见** |
| ~~U3~~ | **已决定推迟（2026-10-10）**：GitHub 需要 client secret，等 P4 托管网关；P2 的真实预注册验收改用 Google（U4） | GitHub 条目（推迟）                            |
| U4 | Google / Microsoft / Slack / Figma 的注册与审核  | 对应目录条目                                   |
| U5 | 签名密钥、`dl.` / `registry.` / `developers.` 子域、Workers Paid、D1 / Turnstile / GitHub OAuth | P3 线上部分                                    |
| M1 | 合入 main 的最终确认                             | 合入                                           |
| M2 | 隐私政策页面与 `logo.png`                        | U1                                             |

### 3.2 待你决定

- **DEV-022**（P3 的 13 项偏差，推荐全部保留）：[DEVIATIONS.md](../docs/dev/DEVIATIONS.md)。DEV-019 / 020 / 021 已决定。

### 3.3 后续工程（代码层面没做的）

| 事项                                              | 说明                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| §6.8「+」菜单临时开关                             | 计划里的可选项，未做                                                 |
| §6.4 的 Google / Microsoft / Slack / GitHub / Figma 目录条目 | **机制已做**（预注册表、BYO），条目本身要等 U4（GitHub 已推迟到 P4 托管网关）                   |
| 目录增量文件                                      | 签名脚本会产出，客户端暂不消费（总是拉全量）                         |
| MCPB：URL 下载、目录卡片「安装本地包」按钮        | 目前只能选本地文件安装；后端 `fromCatalog` 已就绪                    |
| 随附技能的克隆上限                                | 克隆发生在审批之前、没有大小与时间上限——技能导入（D63）的后续项      |
| 开发者门户（`developers.kepcup.com`）             | 只有任务书 [developer-portal.md](developer-portal.md)，未实现        |
| 子注册表在真实 Cloudflare 运行时的验证            | 本地用 `node:sqlite` 模拟 D1；README 列了待核对的假设                |
| ACP 桥发起的 MCP Apps 调用                        | 不产生卡片（有意如此，已记录）                                       |
| MCPB 若将来允许 Agent 发起安装                    | 必须先给安装审批卡加「永不自动批准」标记（DEV-021 第 5 项，代码里有注释） |

### 3.4 只有任务书，不在本期实现（P4）

- [hosted-auth-gateway.md](hosted-auth-gateway.md)：托管授权网关——**只有**某平台无法用本地客户端身份接入时才启动，默认不建。
- [enterprise-ema.md](enterprise-ema.md)：企业托管授权（ID-JAG / Okta XAA）客户端支持。

## 4. 文档地图（从哪里读起）

| 想知道什么                         | 读哪里                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| 产品为什么这样设计                 | [design/29](../docs/design/29-connected-apps.md)（含各阶段「实施注」）                   |
| 每阶段做了什么、验证结果、评审修复 | [PROGRESS.md](../docs/dev/PROGRESS.md) 的「连接应用 P0 / P1 / P2 / P3」                  |
| 实现与设计 / 方案的偏差            | [DEVIATIONS.md](../docs/dev/DEVIATIONS.md) 的 DEV-019 ~ DEV-022                          |
| 代码结构、模块职责                 | [02-architecture.md](../docs/dev/02-architecture.md)「连接应用」                         |
| 数据表、配置与缓存文件             | [03-data-model.md](../docs/dev/03-data-model.md)                                         |
| 提示词段、工具、审批规则           | [04-agent-runtime.md](../docs/dev/04-agent-runtime.md)                                   |
| 怎么跑测试、假服务器               | [05-testing.md](../docs/dev/05-testing.md)「假授权 + MCP 服务器与连接应用测试」          |
| 逐项勾选与实施记录                 | [connected-apps.md](connected-apps.md)                                                   |
| 平台探测结论、协议版本、MCP Apps spike | connected-apps.md 附录 B（B.1–B.7）                                                      |
| 你要手动做的事                     | [connected-apps-user-actions.md](connected-apps-user-actions.md)                         |
| 「扩展中心」与逐家适配（取代原 U2）  | [extension-center.md](extension-center.md)                                               |
| 部署材料                           | `infra/cloudflare/{oauth-cimd,directory,registry}/`（各有 README 和 `verify.mjs`）       |

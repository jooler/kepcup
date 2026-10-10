# 开发者门户（developers.kepcup.com）— 任务书（D73 P3，**未实现**）

> **优先级说明（2026-10-10）**：本门户**降级为后续**。长尾厂商的需求先由[本机连接](local-connector-authoring.md)（设计 29 §17：Bot 读文档生成只在本机运行的连接，用户确认后可用）覆盖；本门户只在需要「**共享 / 审核 / 签名分发 / 已验证（verified）等级**」时再做。本机条目可导出成 `server.json`，将来就是提交入口——所以门户的提交格式不要与本机条目分叉。

> 状态：**仅任务书，未开工**（2026-10-10）。它是 `todo/connected-apps.md` §7.7 的展开，给后续编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。上游设计：`docs/design/29-connected-apps.md` §11.3（分级）、§11.4（目录服务）、§11.5（开发者流程）、§15（Cloudflare 部署）。
>
> **前置（已有）**：
>
> - 子注册表 Worker `infra/cloudflare/registry/`（`registry.kepcup.com`，只读，已实现并有测试）——门户的"审核结果"经它的窄 RPC（`src/reviews.ts`：`getServerForReview` / `submitReview` / `revokeReview`，约束见该目录 `schema.sql` 与 README「审核合并规则」）写入 `reviews`；审核只能挂在**同步已入库**的 `(name, version)` 上（§1、§9）。
> - 校验器 `packages/app-validator`（bin `kepcup-app`，agent C 编写中）——流水线的第一道自动检查。契约：`kepcup-app validate <server.json | url> [--auth]`，`--json` 机器输出（`ValidationReport`：`schemaVersion`、`checks[]`（`id`/`severity`/`message`/`hint`/`subject`）、`summary`、`exitCode` 0|1；以该包 README 为准）。**门户不重写校验逻辑，只调用并存档报告。**
> - 客户端侧的工具定义锁定与复核（设计 29 §8.2，`app_connection_tools.approved_hash/current_hash`）、目录同步（`apps/directory-sync.ts`）。
>
> **硬约束**：
>
> - 只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。
> - 标注「**用户待办**」的事项（Cloudflare 套餐 / 资源、Turnstile 密钥、GitHub OAuth 应用、子域、DNS）由用户完成，Agent 只做准备与验证脚本，不要尝试代为登录或注册（见 §10）。
> - **绝不执行提交者的任何代码**：只抓取 `server.json`、探测其**远程**（`streamable-http`）MCP 端点、读取公开材料。`packages[]` 里的 npm / PyPI / OCI / MCPB 包**只记录、不安装、不运行**（`mcpb` 包只下载并校验 `fileSha256` 与 manifest，不解包执行）。
> - 门户出站抓取一律走 SSRF 防护（§8）；任何密钥（GitHub client secret、Turnstile secret、会话签名密钥）只放 Worker secret，不进仓库、不进日志、不进 R2/D1 明文。**门户没有 registry 的数据库句柄，也没有写 registry 的凭据**：它只能经 service binding 调用 registry Worker 上的窄 RPC（§9）。
> - `tier` 的唯一来源是门户的审核状态机（经由 `reviews` 表）；`server.json` 里的自标 tier 一律无效（子注册表已剔除）。
> - 测试不访问真实网络：GitHub、DoH、被探测的 MCP server 都用本地假服务；Cloudflare 绑定用 `D1Like` 风格的内存适配器（参考 `infra/cloudflare/registry/test/helpers.ts`）。

## 1. 目标与非目标

**目标**：第三方开发者（个人或公司）能在 `developers.kepcup.com` 自助完成：

1. 证明自己拥有 Registry 命名空间（`io.github.<user>/*` 用 GitHub 登录证明；`com.example/*` 用 DNS TXT 证明）；
2. 为**已发布到官方 MCP Registry** 的 `(name, version)` 提交审核（及审核用材料：测试账号、正反用例、隐私政策链接、图标）；门户**不**接收任意 `server.json`，也不是新的发布渠道（见 §1.1）；
3. 看到自动校验 / 探测 / 渲染检查的结果与人工审核进度；
4. 通过后上架：自动获得 `community`；人工审核通过升为 `verified`；
5. 之后管理版本、查看（匿名、可选的）安装量与错误率；工具契约变了就必须提交新版本。

**非目标**：不托管开发者的 MCP server；不做付费 / 分成；不做面向最终用户的评论评分；不做企业私有目录（P4）；不替代官方 Registry 的发布流程（门户只是 KepCup 目录的准入，不往官方注册表发布）。

### 1.1 提交如何进入 registry（决定：**必须先发布到官方注册表，门户只挂审核**）

registry 的响应是 `servers LEFT JOIN reviews`：没有 `servers` 行的审核**不可见**，而 `servers` 由 Cron 从官方注册表同步，并且 `ON CONFLICT … WHERE excluded.updated_at >= servers.updated_at` 会覆盖任何非上游来源的写入。因此选方案 **A：要求提交者先把 `(name, version)` 发布到官方 Registry（官方的命名空间验证已做过一遍），门户只给它附加审核 / 分级**：

- 单一事实来源：目录条目的内容永远是官方注册表同步来的那份；门户不能、也不需要往 `servers` 写行（不存在"门户写入被同步冲掉"的竞态，也没有第二条能污染目录内容的写路径）。
- 审核绑定**确切内容**：门户用 RPC `getServerForReview(name, version)` 取 registry 里已净化的 `server.json` 与其 sha256 来审（**不抓取提交者给的 URL**，这一步没有 SSRF，也没有"审的与上架的不是同一份"的 TOCTOU）；`submitReview` 带 `expectedSha256`，内容在审核期间被同步改变则返回 `stale`，要求重审。
- 同步延迟：提交后若 registry 还没同步到（≤ 1 小时 + 缓存），提交进入 `awaiting_registry`，由 Workflow 定时重查（上限 48 小时，之后 `withdrawn`），不是失败。
- 代价：只面向愿意发布到官方注册表的开发者。这与"为 ChatGPT / Claude 目录开发的应用近乎零改动入驻"一致；不发布到官方的私有应用走 `developer` 档（本机手动添加），不进公共目录。
- 否决的方案 B（门户直接写 `servers`，并让同步跳过这些行）：要给同步加"来源"概念与冲突规则，把不可信内容的写路径放进 registry，复杂度与攻击面都更大，且目录将与官方分叉。

## 2. 架构（全部在 Cloudflare，设计 29 §15）

```
浏览器 ──► developers.kepcup.com  Worker（Hono 或手写路由；Static Assets 放前端）
            ├─ GitHub OAuth（Web 流程）→ 会话 Cookie（__Host-，HttpOnly，SameSite=Lax）
            ├─ DoH TXT 挑战（cloudflare-dns.com / dns.google）
            ├─ Turnstile 校验（提交与登录后的敏感操作）
            ├─ D1：开发者、命名空间、提交、审核、事件
            ├─ R2：审核材料（截图、测试账号说明、校验报告 JSON、探测抓包）
            ├─ Workflows：提交流水线（可重试、可观测、可人工插入"等待审核"步骤）
            │     ├─ 取 server.json（RPC getServerForReview，不抓提交者 URL）
            │     ├─ kepcup-app validate（Container / Sandbox SDK 内运行）
            │     ├─ 探测远程 MCP server（Sandbox SDK / Containers，出站受限）
            │     └─ MCP Apps 渲染检查（Browser Run）
            └─ Workers Analytics Engine：匿名遥测写入与开发者看板查询
registry.kepcup.com  ◄── service binding + 窄 RPC（getServerForReview / submitReview / revokeReview，§9）
```

- 域名 `developers.kepcup.com`（用户待办）；Worker 名 `kepcup-developers`；代码放 `infra/cloudflare/developers/`（与 `registry/` 同级，独立 `wrangler.jsonc`，**不进 pnpm 工作区**，用 `tsconfig.json` 单独类型检查，沿用 registry 的 `cf-types.d.ts` 做法）。
- 逻辑与绑定解耦：业务代码依赖最小接口（`D1Like`、`R2Like`、`WorkflowStarter`、`Fetcher`），测试用内存实现；绑定适配只在 `src/index.ts`。
- Sandbox SDK / Containers / Browser Run 仅 Workers Paid 提供（§10）。Containers 镜像只含：Node（运行 `kepcup-app`）+ 一个"探测器"脚本；**无出站网络白名单之外的访问**。

## 3. 数据模型（门户 D1，与 registry D1 分库）

```sql
developers(id TEXT PK, github_id INTEGER UNIQUE, github_login TEXT, display_name TEXT,
           contact_email TEXT, email_verified_at TEXT,   -- 未验证的邮箱不发任何邮件（§8）
           created_at TEXT, banned_at TEXT)
namespaces(namespace TEXT PK,                -- 小写规范化后的 'io.github.alice' 或 'com.example'
           developer_id TEXT REFERENCES developers(id),
           method TEXT CHECK (method IN ('github','dns')),
           proof TEXT,                        -- github: 数字 id；dns: 命中的 TXT 记录
           verified_at TEXT, expires_at TEXT, -- dns 命名空间 90 天复验
           revoked_at TEXT)
dns_challenges(id TEXT PK, developer_id TEXT, domain TEXT, token TEXT, -- 随机 32 字节 base64url
               created_at TEXT, expires_at TEXT, consumed_at TEXT)
submissions(id TEXT PK, developer_id TEXT, name TEXT, version TEXT,    -- 已在 registry 入库的 (name, version)
            registry_sha256 TEXT,             -- getServerForReview 取到的内容哈希（审核绑定的内容）
            state TEXT,                       -- §4 状态机
            tier_requested TEXT CHECK (tier_requested IN ('community','verified')),
            workflow_instance_id TEXT, created_at TEXT, updated_at TEXT,
            UNIQUE (name, version))
checks(submission_id TEXT, stage TEXT,        -- 'validate'|'probe'|'render'|'scan'
       status TEXT CHECK (status IN ('pass','warn','fail','error','skipped')),
       report_r2_key TEXT, summary_json TEXT, started_at TEXT, finished_at TEXT,
       PRIMARY KEY (submission_id, stage))
reviews_outbox(id TEXT PK, submission_id TEXT, name TEXT, version TEXT, op TEXT, -- 'submit'|'revoke'
               tier TEXT, review_status TEXT, notes TEXT, tool_contract_hash TEXT,
               expected_sha256 TEXT, created_at TEXT,
               pushed_at TEXT, last_error TEXT)  -- 待推送队列，重放幂等（§9）
review_events(id TEXT PK, submission_id TEXT, actor TEXT, -- 'system'|'reviewer:<numeric github id>'|'developer'
              from_state TEXT, to_state TEXT, note TEXT, at TEXT)
contract_reports(name TEXT, version TEXT, observed_hash TEXT, day TEXT,
                 bucket TEXT,                   -- 服务端派生（§7），绝不取自客户端
                 PRIMARY KEY (name, version, observed_hash, day, bucket))
probe_requests(name TEXT, version TEXT, requested_at TEXT, reason TEXT)  -- §7：上报只会排队探测
```

R2 键：`submissions/{id}/server.json`（registry 取来的副本）、`.../validate.json`、`.../probe.json`、`.../render/{n}.png`、`.../materials/*`。保留期：被拒绝的提交 90 天后清理；`approved` 的永久保留。**R2 材料不从门户源站提供**（§8）。

## 4. 审核状态机

```
draft ──submit──► awaiting_registry ──registry 已入库──► queued ──workflow──► checking ──必需检查全过──► community_live ──request verified──► in_review
  │                     │ 48h 未入库                       │                    │ fail                                   │                         ├─ approve ─► verified_live
  │                     └──────────► withdrawn             │                    └────────► rejected_auto                  │                         └─ reject  ─► community_live（保留社区档，附理由）
  └─ withdraw ──► withdrawn                               （被拒后需 bump 版本并重新发布到官方注册表；同 (name,version) 不可重复提交，防刷）
任意 *_live ──probe 确认的契约漂移（§7）──► needs_rereview ──人工复审通过──► *_live | ──宽限期满未处理──► suspended
任意 *_live ──abuse/ban/withdraw──► suspended / withdrawn（registry reviews 置 rejected → 对外不再带 tier）
```

- 迁移只由服务端函数执行，每次迁移写一条 `review_events`；非法迁移抛错（单测枚举全部合法 / 非法边）。
- **自动层级**：`checking` 全部必需检查通过 → 写 `community`（`review_status=approved`）。必需检查 = `validate` 无 error、`probe` 无 fail、`scan` 无 fail；`render` 仅对声明 `ui: true` 的提交必需。`warn` 不阻断但显示给审核员。
- **人工层级**：`verified` 需要命名空间已验证 + 测试账号可用 + 审核员逐项勾选清单（写进 `review_events.note` 的结构化 JSON）。审核员授权规则见 §8「审核员授权」。
- `tier_requested` 只是请求；实际 tier 由状态机给出。
- **撤销延迟**：`revokeReview` 写入 registry 后，各边缘节点最多约 5 分钟（registry 的 `s-maxage=300`）才不再展示 tier；客户端目录是签名索引的每日拉取，所以对已装客户端的传播以"天"计——紧急撤销需配合索引重签 / 手动 purge，写进运维手册（D6）。

## 5. 命名空间证明

> 门户验证的是"这个开发者有权为该命名空间申请 **KepCup 分级**"，与官方 Registry 自己的发布验证互相独立（后者是前置条件，§1.1）。

- **规范化**：命名空间与 server 名先转小写再比较 / 存储（官方 Registry 的比较区分大小写，`io.github.Alice/x` 与 `io.github.alice/x` 是不同的名字；门户拒绝与已有名字仅大小写不同的提交，并把 `namespaces` 键存为小写，避免靠大小写绕过归属）。
- **GitHub**：OAuth Web 流程（scope 最小：`read:user`；组织成员核对再加 `read:org`）。`io.github.<login>/*` 只能由 `<login>` 本人提交，按不可变的**数字 id** 判定并同步更新 `github_login`（改名不丢归属；也防止他人注册被释放的旧用户名后冒领——归属一旦建立绑定数字 id，旧 login 被他人占用不会转移）。**组织命名空间**（`io.github.<org>/*`）：申请者必须是该 org 的 **owner / admin**（`GET /orgs/{org}/memberships/{user}` 的 `role=admin` 且 `state=active`），普通成员不行；需要 `read:org` 与 org 授权，拿不到则走 DNS 或人工。
- **DNS TXT**：为 `com.example/*` 签发挑战 `kepcup-developer-verification=<token>`，开发者在 `_kepcup-challenge.example.com` 下加 TXT。校验见 §8「DoH」：**两家解析器必须一致，否则失败关闭**。域名按反向 DNS 规则换算（`com.example` → `example.com`，拒绝公共后缀本身，如 `com`、`co.uk`，用 Public Suffix List 内置快照）。挑战 24 小时过期、一次性；命名空间有效期 90 天，到期前（已验证的）邮箱提醒复验。
- 子域：`com.example.api/*` 只证明 `api.example.com`，不继承 `example.com`；反之 `example.com` 的验证**不**自动覆盖其子域命名空间。
- **发布时再校验（TOCTOU）**：`namespaces` 的有效性在 ① 创建提交 ② Workflow 的 `publish-community` / `approve` 步骤**写 registry 之前**各检查一次（未撤销、未过期、开发者未封禁；DNS 命名空间在写入前重新做一次 DoH 校验）；任一失败则不写，状态回 `needs_rereview` 并通知。
- 保留命名空间：`com.kepcup/*`（KepCup 自有，设计 29 §15.2）、`io.modelcontextprotocol/*` 等拒绝提交；近似仿冒（Unicode 混淆、`kepcup` 变体）进人工队列。

## 6. 提交流水线（Workflows）

输入：`submission_id`。每个阶段是独立 step（可重试、幂等），结果写 `checks` + R2。

1. **fetch**（不抓取提交者 URL）：RPC `getServerForReview(name, version)` 取 registry 里的 `server.json` 与 sha256，存 R2 并记入 `submissions.registry_sha256`；不存在 → `awaiting_registry`。强校验 `name` 的命名空间属于该开发者（§5，且重新校验有效期）。`status = deleted` 的版本拒绝。
2. **validate**：在 Container 里执行 `kepcup-app validate <server.json> --json`（不带 `--auth`），存报告。`--auth` 需要真实授权，由人工审核阶段用审核用测试账号做（§4 的清单项），不进自动流水线。
3. **probe**（远程 MCP server 探测；只对 `remotes[]`，每个 URL 与它派生出的每个 URL 都先过 §8 的 SSRF 检查）：
   - 无凭据请求 → 记录 `401` + `WWW-Authenticate` / PRM / AS 元数据（与 validate 的结果交叉）；
   - 若服务器**允许匿名** `initialize` + `tools/list`：拉取完整工具清单；否则只记录"需要授权，工具清单将在人工审核阶段用测试账号获取"，并以提交者上传的"工具清单快照"（可选，JSON）作为基线，标 `unverified_snapshot`；
   - 对工具清单做静态扫描：**描述注入模式**（"ignore previous"、对 LLM 的指令 / 角色扮演 / 隐藏 Unicode / 零宽字符 / 超长描述 / 要求调用其他工具或泄露系统提示）、**读写拆分与注解**（缺 `title` / 缺 `readOnlyHint` 等，复用 app-validator 的启发式）、**过宽 scope**（授权元数据里的 `scopes_supported` 与清单声明差距；`*`、`admin`、`full_access` 之类）、**外链域名**（工具描述 / 结果示例里的 URL 域名，对照提交的域名清单与已知短链 / 追踪域）；
   - 计算 **`tool_contract_hash`**：对规范化（JCS，RFC 8785）后的 `[{name,title,description,inputSchema,annotations}…]`（按 `name` 排序）取 sha256；与客户端侧逐工具哈希（`app_connection_tools.current_hash`）使用**同一规范化函数**——实现时把它抽到 `packages/shared`，门户与桌面端共用，并加一致性测试向量。
   - 探测只做 `initialize`、`tools/list`、`resources/list`（及 `ui://` 资源读取），**不调用任何工具**。
4. **render**（仅 `ui: true`）：用 Browser Run 打开 MCP Apps 的 `ui://` HTML（由 probe 读取后注入到门户自己的沙箱页，`sandbox="allow-scripts"` 无 same-origin，CSP 取自 `_meta.ui.csp`），截图存 R2，检查：是否违反声明的 CSP、是否尝试访问未声明域名、控制台 / 网络错误、是否在 10 秒内完成首次渲染。不登录、不传凭据。**页面出站网络被阻断或只能经 §8 的出站代理**（见下）。
5. **scan 汇总**：合并上述发现，按规则给每项打 `pass|warn|fail`，生成人类可读摘要；任何 `fail` → `rejected_auto`（附可操作的 `hint`）。
6. **publish-community**：重新校验命名空间（§5），然后 RPC `submitReview({tier:'community', status:'approved', toolContractHash, expectedSha256})`（经 outbox，§9），状态 → `community_live`，发通知。
7. **wait-human**（仅请求 verified 时）：Workflow 进入 `waitForEvent("review-decision")`，超时 30 天自动退回 `community_live`。

整个工作流有总超时与每 step 超时；任一 step 抛错有限次重试后标 `error` 并转人工队列，**不会**因为基础设施故障自动判拒。

## 7. 工具契约变更与复审

- 上架版本记录 `tool_contract_hash`（来自 probe，写入 registry `reviews`）。
- 设计 29 §11.4：服务端工具变化但**未提交新版本** → 桌面端走 §8.2 复核（用户侧），同时**可选、匿名**地上报 `(name, version, observedHash)`。
- 门户接口 `POST /api/v1/contract-reports`（无需登录；桌面端是非浏览器客户端，Turnstile 不适用）。**上报是不可信输入，只能触发"重新探测"，绝不直接改变对外可见的 tier / status，也不会因为沉默而下架**：
  - **入口防护**：Cloudflare Rate Limiting 绑定按 IP 限速；载荷固定 JSON schema ≤ 512 B；只接受目录里存在的 `(name, version)` 且 `observedHash` 为 64 位十六进制。
  - **去重桶由服务端派生，不取自客户端**：`bucket = HMAC(服务端密钥, 日期 | IP /24（IPv6 /48）)` 截断；`contract_reports` 以 `(name, version, observed_hash, day, bucket)` 唯一。客户端无法自选桶来伪造"多个来源"，也不存 IP。
  - **阈值只用于排队探测**：同一 `(name, version)` 当日收到来自 ≥ N（默认 5）个不同桶、且 `observedHash ≠ tool_contract_hash` 的相同哈希 → 写一条 `probe_requests`（每 `(name,version)` 每 6 小时最多一次，防被刷成探测放大器）。
  - **只有门户自己的探测结果能改变状态**：
    - 若该 server 允许匿名 `tools/list`：重新探测得到的哈希确实变化 → `needs_rereview`，通知开发者提交新版本（宽限 7 天），期间 registry 经 `submitReview(status:'pending')` 让该版本不再带 tier；宽限期满未处理 → `suspended`（`revokeReview`）。哈希未变 → 丢弃上报，记录计数。
    - 若该 server **无法匿名探测**（需要授权）：上报**不能被验证**，只给人工审核队列加一条提醒（`review_events` 备注 + 看板标记）；**不改变可见 tier / status，不因开发者沉默自动 suspend**，由审核员用测试账号手动复探后决定。
  - 因此攻击者即使灌入大量假上报，最多造成一次受限频的探测，无法降级竞争对手，也无法为自己的恶意改动"洗白"。
- 开发者提交新版本即走正常流水线（该版本须先发布到官方注册表）；旧版本保持 `*_live` 直到被新版本取代或手动下架。

## 8. 安全设计

### 8.1 SSRF（门户会抓取 / 探测用户可影响的 URL：`remotes[].url`、PRM / AS 元数据 URL、`ui://` 资源引用的外链）

- **分层**：Worker 侧做**字符串 / 解析前**检查；真正的网络隔离靠 Container 内的**出站代理**（Workers 的 `fetch` 不暴露解析结果，不能自己做 IP 校验）。所有探测与渲染流量都经这个代理，Worker 自己**不直接 `fetch` 任何用户可影响的 URL**。
- **Worker 侧拒绝（在把 URL 交给代理前）**：非 `https:`；带用户信息；端口非 443（必要时白名单 8443）；主机为 **IP 字面量**（含十进制 / 八进制 / 十六进制整数写法如 `2130706433`、`0x7f.1`、`0177.0.0.1`、IPv6 方括号、IPv4 映射 `::ffff:…`）；主机在 `*.kepcup.com`（含 `registry.` / `developers.` / `auth.` 等自有域，防打自己）、`localhost`、`*.local`、`*.internal`、`*.localhost`、无点单标签主机名、解析为 IDN 的需转 punycode 后再判。
- **代理侧拒绝（解析后）**：回环 `127/8`、`0.0.0.0/8`、私网 `10/8` `172.16/12` `192.168/16`、链路本地 `169.254/16`（含云元数据 `169.254.169.254`）、CGNAT `100.64/10`、`192.0.0.0/24`、`192.0.2/24` `198.51.100/24` `203.0.113/24`（文档段）、`198.18/15`（基准测试）、组播 `224/4`、保留 `240/4`、广播；IPv6：`::1`、`::/128`、`fc00::/7`、`fe80::/10`、`ff00::/8`、IPv4 映射 `::ffff:0:0/96`、**NAT64 `64:ff9b::/96`**、**6to4 `2002::/16`**、Teredo `2001::/32`，对嵌入的 IPv4 再按上表判一次。
- **DNS rebinding 的具体机制**：出站代理负责"解析 → 校验 → **按已校验的 IP 连接**"，并保留原始主机名作 SNI / `Host` / 证书校验；不二次解析。同一请求的重定向每一跳都重走这套流程（≤ 3 跳，只允许 https）。应用层的"先查一次再 fetch"不算防护。
- **二阶 SSRF**：探测过程中从响应里**派生出的 URL**（`WWW-Authenticate` 的 `resource_metadata`、PRM 的 `authorization_servers`、AS 元数据的各个端点、`ui://` 资源里的外链）都视为不可信输入，**每一个都重新走上面全部检查**，并受"每次探测最多访问 N 个不同主机（默认 8）"的限制。
- **Browser Run**：被渲染页面的出站网络要么完全阻断，要么只能经同一出站代理；页面无 cookie、无门户会话、不带 Authorization；拦截对 `data:` / `blob:` 之外的所有请求并记录（用于"越权域名"检查）。
- **目标主机与已验证命名空间绑定**：`remotes[].url` 的主机必须是已验证命名空间对应域名或其子域（`com.example` → `example.com` / `*.example.com`），或在提交里显式列出并经人工放行的第三方托管域（如 `*.workers.dev` 之类托管平台，每次人工确认）；此外对每个**目标主机**限速（每主机每小时探测次数上限），防止门户被用作打任意第三方的跳板。
- 响应体大小与时间上限（探测每请求 10 秒、总 60 秒、响应 ≤ 1 MB）；Container 出站只允许 DNS + 目标 443，禁止访问 Cloudflare 内部元数据与门户自身绑定；Worker → Container 的调用带一次性令牌。

### 8.2 其他

- **不执行提交代码**：见硬约束。探测器只做协议级请求。
- **提交内容当作不可信数据**：服务端 JSON schema 校验 + 长度上限；渲染到门户页面时一律转义（审核员页面是高价值目标，CSP 严格，`script-src 'self'`）；`description` 等字段里的"指令"只作为文本显示。
- **DoH**：`cloudflare-dns.com` 与 `dns.google` **两家都必须成功返回且都包含该 token**；任一超时 / 报错 / 缺失 / 不一致一律**失败关闭**（命名空间不通过，提示稍后重试），不做"一家成功即可"的降级。DNSSEC `AD` 位仅记录。
- **Turnstile 服务端校验**（`POST https://challenges.cloudflare.com/turnstile/v0/siteverify`）：必须同时满足 `success === true`、`hostname` 等于 `developers.kepcup.com`、`action` 等于该表单约定的值、`challenge_ts` 在 5 分钟内；令牌**一次性**（把令牌的哈希存 D1 / KV，带 TTL 防重放；siteverify 本身也只接受一次）；超时 / 非 2xx / 响应畸形一律**失败关闭**；`secret` 只放 Worker secret；`remoteip` 可选传入。
- **GitHub OAuth**：`state` 绑定发起登录的**浏览器**——登录前先下发 `__Host-` 前缀、`HttpOnly; Secure; SameSite=Lax` 的预登录 Cookie（存 `state` 的哈希 + PKCE verifier 的引用），回调时比对 Cookie 与 `state` 参数；`state` 一次性、5 分钟过期；`redirect_uri` 精确匹配 `https://developers.kepcup.com/auth/github/callback`（不接受查询参数 / 其他路径）；**登录成功后轮换会话 id**（丢弃预登录 Cookie，签发新的会话 Cookie，防会话固定）。
- **会话 / CSRF**：会话 Cookie 用 `__Host-`；服务端存会话 id 的 sha256（随机 256 位），可吊销；所有写接口要求自定义头 + `SameSite=Lax` + Origin 校验。
- **审核员授权**：审核员身份 = **数字 GitHub id** 白名单（Worker var / secret，**不用 login**，login 可改名被他人占用）；**不得审核自己名下的提交**，也不得审核"相关命名空间"的提交（同一开发者、同一 org、同一 DNS 域或其子域下的任何提交）；批准 `verified` 要求两名不同审核员（或一名审核员 + 命名空间已验证 ≥ 7 天的冷却，实现时二选一并写进状态机测试）；审核动作全部写 `review_events`（追加式，不可改写），敏感动作（批准 verified、封禁）要求二次确认。
- **邮件**：`contact_email` 必须先验证（发一次性链接，24 小时过期）才会用于任何通知；未验证的邮箱只存不发，避免被当作垃圾邮件 / 骚扰中继。
- **R2 材料**：不经门户源站提供，放在**独立来源**（如 `materials.kepcup-usercontent.example`，不是 `*.kepcup.com`，避免与门户 Cookie / CSP 同站）；响应一律带 `X-Content-Type-Options: nosniff`、`Content-Disposition: attachment`（图片预览用经重编码的缩略图），不渲染 HTML / SVG。
- **上传限制**：内容类型白名单（`image/png`、`image/jpeg`、`image/webp`、`application/pdf`、`application/json`、`text/plain`），按魔数核对而非信任客户端声明；单文件 ≤ 10 MB，单提交总量 ≤ 50 MB；不接受压缩包 / 可执行文件 / SVG / HTML。
- **滥用与限额**：每开发者每日最多 10 次提交、同时 ≤ 3 个进行中；`workflow` 并发上限；Turnstile 用于登录后首次提交、命名空间挑战创建、联系人邮箱变更；被拒后同 `(name,version)` 不可重复提交；封禁开发者即 `suspended` 其全部上架项。
- **隐私**：门户存开发者的 GitHub id / login / 联系邮箱（用于通知）；不存最终用户数据；遥测见 §11。

## 9. 与 registry 的写入方式（决定：service binding + 窄 RPC；**不共享 D1 绑定**）

门户要处理不可信内容（提交材料、探测结果、第三方元数据），所以**不给它 registry 数据库的任何句柄**——否决"共享 D1 绑定"（它等于让一个解析不可信内容的组件拥有目录库的完整读写权）。改为：

- registry Worker 暴露一个 `WorkerEntrypoint` RPC 类（**只能经 service binding 到达，没有公共路由**；与现有只读 `fetch` 并存），方法只有三个，均由 `infra/cloudflare/registry/src/reviews.ts` 实现（已实现并有测试，RPC 外壳随 D4 添加）：
  - `getServerForReview(name, version)` → `{ serverJson, sha256, status }`（registry 里已净化的内容）；
  - `submitReview({ name, version, tier, status, notes?, toolContractHash?, expectedSha256? })`；
  - `revokeReview({ name, version, notes? })`。
- **不变量由 registry 强制，门户无法绕过**：只能给同步已入库的 `(name, version)` 写审核；`reviewed_at` 由 registry 生成、毫秒精度、对同一行严格递增（**批准与撤销都必须有**，使撤销也能通过 `updated_since` 被增量拉取方看到）；批准时 sha256 由 registry 读当前行得出（不接受调用方提供），`expectedSha256` 不符返回 `stale`；批准必须带 `toolContractHash`；写入是条件 upsert `WHERE excluded.reviewed_at > reviews.reviewed_at`（并发时较新者胜）。库级 `CHECK`（`reviewed_at NOT NULL` 且 ISO-ms 格式、批准须带 64 位 sha256）是最后一道防线，**实现 RPC 外壳时不得删除或放宽**。
- **凭据**：service binding 本身即授权，**没有任何"写 registry 的密钥"**；因此 §8 / §13 里也没有这一项。只有门户 Worker 被绑定，registry 的 RPC 类不对外路由。
- **outbox 与幂等**：门户先写 `reviews_outbox`（带 `expected_sha256`），再由单一串行消费者（Workflow step / Queue consumer）调用 RPC；失败重放安全（条件 upsert + 同一 `id` 去重）；一个 `(name, version)` 的写入严格串行（同一消费者按 `created_at` 顺序），避免撤销被较早的批准覆盖——即使乱序，registry 的 `excluded.reviewed_at > reviews.reviewed_at` 也保证最后一次写入胜出。
- **撤销可见性**：见 §4——边缘约 5 分钟，已装客户端按索引重签周期（天）。
- 否决方案 B'（门户经 HTTP + 共享密钥调 registry 的写接口）：多一个公网写面和一个要保管的共享密钥；service binding 更小。

## 10. API 清单（均 JSON；写接口要求会话 + CSRF 头）

| 方法与路径 | 说明 |
|---|---|
| `GET /auth/github/start` · `GET /auth/github/callback` · `POST /auth/logout` | GitHub 登录 / 登出 |
| `GET /api/v1/me` | 当前开发者与命名空间 |
| `POST /api/v1/namespaces/dns-challenge` `{domain}` | 创建 DNS 挑战（Turnstile） |
| `POST /api/v1/namespaces/dns-verify` `{domain}` | 触发 DoH 校验 |
| `POST /api/v1/submissions` `{name, version, tierRequested}` | 为已发布到官方注册表的 `(name, version)` 创建提交（Turnstile；限额；不接受任意 server.json / URL） |
| `GET /api/v1/submissions` · `GET /api/v1/submissions/{id}` | 列表 / 详情（含 `checks`、报告下载链接、`review_events`） |
| `POST /api/v1/submissions/{id}/materials` | 上传审核材料（R2 预签名或 Worker 直传，按类型 / 大小限制） |
| `POST /api/v1/submissions/{id}/request-verified` · `POST …/withdraw` | 状态推进 |
| `GET /api/v1/servers/{name}/stats` | 开发者看板（匿名聚合：安装量、错误率、版本分布） |
| `POST /api/v1/contract-reports` | 匿名契约哈希上报（§7；无登录；只会排队探测，不改变可见状态） |
| `GET /review/queue` · `POST /review/{id}/decision` | 审核员队列与决定（白名单） |
| `GET /healthz` | 存活 |

前端：最小 Static Assets 页面（提交表单、状态页、审核员页），不引入大型框架；可访问性与中英文（沿用桌面端文案风格）。

## 11. 匿名可选遥测（Workers Analytics Engine）

- 桌面端 **opt-in**（设置里默认关；文案说明只上传 `(name, version)` + 计数 + 错误类别）；上报只经 `POST /api/v1/telemetry`（无登录、限速、固定 schema）。
- Analytics Engine 数据点：`index1 = name@version`；`blob1 = event`（`install|connect|tool_error|auth_error|contract_drift`）、`blob2 = errorClass`（枚举，禁止自由文本）；`double1 = 1`。**不写** IP、设备 id、账号、工具参数 / 结果。保留期 3 个月（平台限制）；超过的聚合落 D1 日表。
- 开发者看板只显示自己名下 server 的聚合（≥ 10 次才显示，避免反推个体）。
- 这些数据不得进入任何审批 / 排序逻辑之外的用途；隐私政策页需同步更新（用户待办 M2 相关）。

## 12. 阶段与任务（每项含验收）

### D0 骨架与门禁

- [ ] `infra/cloudflare/developers/`：`wrangler.jsonc`（D1 / R2 / Workflows / Analytics Engine 绑定、路由 `developers.kepcup.com/*`、占位 id）、`schema.sql`（§3）、`tsconfig.json`、`cf-types.d.ts`、README（含 §13 用户待办）、根 `vitest.config.ts` 注册 `infra-developers` 项目。
- [ ] 业务层最小接口 + 内存适配器（D1 / R2 / Workflow 启动器 / Fetcher / DoH 客户端）。
- 验收：`npx tsc -p infra/cloudflare/developers --noEmit` 通过；Docker 内 `node scripts/run-tests.mjs run infra/cloudflare/developers` 全绿；`pnpm lint` 不受影响。

### D1 身份与命名空间

- [ ] GitHub OAuth（预登录 `__Host-` Cookie 绑定 state + PKCE、精确 redirect_uri、登录后轮换会话 id、数字 id 绑定）；会话存储与吊销；org 命名空间需 owner/admin 角色；名字小写规范化。
- [ ] DNS 挑战：签发、过期、一次性；DoH 双源**必须一致**否则失败关闭；PSL 拒绝公共后缀；复验与过期；写 registry 前再校验一次命名空间（TOCTOU）。
- 验收：假 GitHub / 假 DoH 服务下——登录成功 / state 篡改 / 无预登录 Cookie / 换浏览器回调 / 回调重放 / redirect_uri 不精确 / 登录前后会话 id 不同；命名空间归属判断（`io.github.alice` 只属 alice，`Alice` 大小写变体被拒；org 普通成员被拒、admin 通过；改名后按数字 id 仍归属）；DoH 单源缺失 / 矛盾 / 超时一律失败；`com.example` 的 TXT 通过后才能提交 `com.example/*`；保留命名空间被拒。

### D2 提交与状态机

- [ ] 提交接口（只收 `(name, version)`，registry 未入库 → `awaiting_registry`；schema 校验、限额、Turnstile 校验器可注入）、`submissions`/`review_events`、状态机（§4）；审核员授权（数字 id、禁自审 / 相关命名空间、verified 双人或冷却）。
- 验收：非法迁移全部被拒（枚举测试）；同 `(name,version)` 重复提交被拒；限额与并发上限；Turnstile 逐项（`success` 假 / `hostname` 不符 / `action` 不符 / 令牌过期 / 令牌重放 / 超时 → 全部失败关闭）；审核员自审与相关命名空间审核被拒；未验证邮箱不发信；事件日志完整。

### D3 流水线

- [ ] Workflow 骨架与 step 幂等重试；fetch（经 RPC `getServerForReview` 取 registry 内容，不抓提交者 URL）+ validate（调用 `kepcup-app --json`，用假 Container 执行器测试）。
- [ ] SSRF 层（§8.1）：Worker 侧主机 / 端口 / IP 写法检查 + 假出站代理（解析 → 校验 → 按 IP 连接，保留 SNI / Host），二阶 URL 递归校验，每探测主机数上限，目标主机与命名空间绑定。
- [ ] probe（假 MCP server：匿名 / 需授权 / 恶意描述 / 过宽 scope / 外链域名样本）+ 静态扫描规则 + `tool_contract_hash`（与桌面端共用规范化函数的一致性向量）。
- [ ] render（假 Browser Run 接口：CSP 违规 / 越权域名 / 超时样本）。
- 验收：每类恶意样本被对应规则判 `fail`/`warn`；SSRF 套件（私网 / 回环 / 元数据 / 重定向到内网 / DNS rebinding 模拟 / 非标端口 / 用户信息 URL）全部拒绝（含十进制 / 八进制 / 十六进制 IP 写法、IPv4 映射、NAT64 / 6to4、`192.0.0.0/24`、`198.18/15`、组播、`*.kepcup.com`；PRM / AS 元数据里指向内网的派生 URL；Browser Run 页面发起的内网请求）；基础设施错误 → `error` 而非 `rejected_auto`；探测过程**从未**调用 `tools/call`（假服务器断言）。

### D4 审核与上架

- [ ] registry 侧：`WorkerEntrypoint` RPC 外壳（`getServerForReview` / `submitReview` / `revokeReview`，复用 `src/reviews.ts`，**只**经 service binding 可达）；门户侧 `reviews_outbox` 串行消费者（幂等、失败重放）；`community` 自动写入；`verified` 人工队列与决定；撤销 = `rejected`。
- [ ] 契约上报（§7）：服务端派生去重桶、IP 限速、只排队探测（每 `(name,version)` 6 小时一次）、可匿名探测的才由**探测结果**改变状态、不可探测的只提醒人工。
- 验收：端到端（内存适配器）提交 → `community_live` → registry 列表响应带 `_meta["app.kepcup/connector"].tier = community`（可复用 registry 的 `worker.ts` 读路径做断言）；批准 → `verified`；撤销后不再带 tier；契约漂移上报达到阈值触发 `needs_rereview`，低于阈值 / 同桶重复不触发；客户端自带的 `bucket` 字段被忽略；大量假上报最多产生一次受限频的探测、**不改变**可见 tier / status；无法匿名探测的 server 上报只产生人工提醒、永不自动 suspend；上报接口限速与载荷限制；registry 的 RPC 拒绝：未入库版本、缺 `toolContractHash` 的批准、`expectedSha256` 不符（`stale`）、非单调 `reviewed_at`；撤销后 `updated_since` 拉取能看到该条目。

### D5 开发者看板与遥测

- [ ] 遥测写入与聚合（Analytics Engine 适配器 + 内存假实现）、开发者看板、最小前端。
- 验收：遥测载荷拒绝自由文本 / 多余字段；k-匿名阈值；看板只返回本人名下数据。

### D6 联调与上线（含用户待办）

- [ ] 与桌面端：目录同步消费 registry 的 `app.kepcup/connector`.tier（见 `apps/directory-sync.ts` 现有契约）；契约上报与遥测开关的客户端侧（另立任务，不在本文件实现）。
- [ ] 部署演练文档、`verify.mjs`（外部冒烟：健康检查、登录跳转、提交接口 401/422、CSP 响应头）。
- 验收：全部"用户待办"完成后，一个真实的测试 server 走通"登录 → 命名空间 → 提交 → community → 人工 verified"，并在桌面端目录里看到分组与认证标。

## 13. 用户待办（Agent 不做，不要代为登录 / 注册 / 创建资源）

> 汇总见 `todo/connected-apps-user-actions.md` U5；以下是门户这条线的明细。

- [ ] **Workers Paid**：Sandbox SDK / Containers / Browser Run 仅付费版提供；Workflows、D1 配额也建议在付费版上跑。
- [ ] **子域与 DNS**：`developers.kepcup.com`（Worker 路由或自定义域）；`registry.kepcup.com` 见 `infra/cloudflare/registry/README.md`。
- [ ] **GitHub OAuth App**（Web 流程）：回调 `https://developers.kepcup.com/auth/github/callback`；把 client id 放 `vars`、client secret 放 `wrangler secret put GITHUB_CLIENT_SECRET`。
- [ ] **Turnstile**：创建 widget（域名 `developers.kepcup.com`），站点密钥放前端 / vars，密钥 `wrangler secret put TURNSTILE_SECRET`。
- [ ] **Cloudflare 资源**：门户 D1（`wrangler d1 create`）、R2 桶、Workflows、Analytics Engine 数据集；回填 `wrangler.jsonc` 占位 id。
- [ ] **审核员白名单**：审核员的**数字 GitHub id**（不是 login）；以及 registry Worker 与门户 Worker 之间的 service binding（部署时在门户 `wrangler.jsonc` 里声明；无需任何共享密钥）。
- [ ] **WAF 速率限制规则**：registry（见其 README）与门户公共入口（`/api/v1/contract-reports`、`/api/v1/telemetry`、登录回调）。
- [ ] **R2 材料的独立来源域名**（不与 `*.kepcup.com` 同站）与对应 DNS / 自定义域。
- [ ] **邮件通道**（开发者通知、命名空间到期提醒）：Cloudflare Email Service / 外部服务二选一，由你决定。
- [ ] **隐私政策与条款页面**更新（遥测、开发者数据）——与 M2 一并处理。
- [ ] 部署：`wrangler deploy`；Bot Fight Mode / WAF 对 `/api/v1/contract-reports`、`/api/v1/telemetry` 的例外（桌面端非浏览器请求）。

## 14. 参考

- MCP Registry：<https://modelcontextprotocol.io/registry/about>、<https://github.com/modelcontextprotocol/registry>（OpenAPI：<https://registry.modelcontextprotocol.io/openapi.json>；命名空间验证：GitHub / DNS / HTTP）
- Cloudflare：Workflows、D1、R2、Turnstile、Workers Analytics Engine、Sandbox SDK、Containers、Browser Run 文档（实现时以当时文档为准）
- DoH：Cloudflare `https://cloudflare-dns.com/dns-query`（`application/dns-json`）、Google `https://dns.google/resolve`
- MCP 安全最佳实践：<https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>
- 本仓库：`infra/cloudflare/registry/{README.md,schema.sql,src/worker.ts}`、`packages/app-validator`、设计 29 §8.2（工具定义锁定）

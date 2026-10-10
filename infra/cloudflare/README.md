# Cloudflare 操作：工具、凭证与使用约定

> 状态：2026-10-10。适用于 `infra/cloudflare/` 下所有部署材料（`oauth-cimd`、`directory`、`registry`）以及之后的 D1 / DNS / WAF 操作。账号侧的"要你手动做的事"仍以 [todo/connected-apps-user-actions.md](../../todo/connected-apps-user-actions.md) 为准，本文只讲**怎么让 Agent 直接操作 Cloudflare**。

## 1. 工具

| 工具 | 版本 | 用途 |
| ---- | ---- | ---- |
| `cf`（新的 Cloudflare CLI，2026-09-28 公测） | `1.0.0-beta.14`，已全局安装（`npm i -g cf`，要求 Node ≥ 22.18） | 覆盖整个 Cloudflare API（2900+ 命令）：zone、DNS、D1、WAF、Bot、令牌、账号设置…… 用 `cf cli search "<要做什么>"` 找命令；输出默认 JSON |
| `wrangler` | `4.88.0`，已有 | 部署本仓库的 Worker / 静态资源（各目录里的 `wrangler.jsonc`）。`cf deploy` 要求先 `cf migrate` 把项目转成 `cloudflare.config.ts`——公测期不做，等 `cf` 稳定后再迁 |

分工：**部署用 wrangler，其余 API 操作用 cf**。两者都读环境变量 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`；`cf` 不支持 Global API Key，也不复用 wrangler 的登录。

## 2. 你需要做的（共 3 步）

1. **确认 `kepcup.com` 在哪个 Cloudflare 账号下**（见 §3 的发现），取该账号的 Account ID。
2. **建令牌 A**（日常、最小权限，§4.1）；需要改 Bot Fight Mode / WAF 时再建**令牌 B**（§4.2）。
3. `cp .env.example .env && chmod 600 .env`，填入 `CLOUDFLARE_ACCOUNT_ID` 与令牌。**令牌不要贴进聊天**，只放进 `.env`。

然后在仓库根目录运行只读自检：

```
infra/cloudflare/with-env.sh check
```

它会告诉你：令牌是否有效、属于哪个账号、能不能看到 `kepcup.com`。通过后告诉我，我就能直接操作。

## 3. 目前的发现（2026-10-10，只读查询，未改任何东西）

- 这个会话的 shell 里**本来就有** `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`（账号 `ryonggang@gmail.com`，ID 以 `fe9ca692…` 开头）。
- 该令牌**只看得到一个 zone：`omnecells.com`**（Free 套餐），**看不到 `kepcup.com`**。它大概是别的项目（OmneCells）用的令牌；`kepcup.com` 要么在另一个 Cloudflare 账号下，要么这个令牌被限定到单个 zone。
- 因此：我**没有**拿它做任何写操作，也不会拿它部署 kepcup 的东西。
- ⚠️ `cf` 的规则是"**环境变量优先于 `.env`**"。直接在仓库里跑 `cf` 会悄悄用上那个 omnecells 令牌。所以**一律通过 `infra/cloudflare/with-env.sh` 运行**：它会先清掉所有 `CLOUDFLARE_*` / `CF_*` 变量，再只从仓库 `.env` 取值（已用假令牌验证：环境里的令牌不会漏进去）。

## 4. 令牌配方

创建入口：Cloudflare 控制台 → 选对账号 → **Manage Account → Account API Tokens → Create Token → Create Custom Token**（账号级令牌不绑定个人，适合自动化；界面里没有的话用 My Profile → API Tokens）。权限名称以创建页为准（"Edit" 与 "Write" 是同一级别的不同叫法）。

通用设置：**Account Resources** 选本账号；**Zone Resources** 选 *Specific zone → kepcup.com*；**TTL** 设一个到期日；可选 **Client IP Address Filtering** 填本机出口 IP。

### 4.1 令牌 A「kepcup-deploy」（日常）

| 范围 | 权限 | 用来做什么 |
| ---- | ---- | ---------- |
| Account | Workers Scripts : Edit | 部署 `oauth-cimd` / `directory` / `registry` |
| Account | D1 : Edit | 建 `kepcup-registry` 库、执行 `schema.sql` |
| Account | Account Settings : Read | `cf auth whoami`、wrangler 解析账号 |
| Zone | Zone : Read | 按名字查 zone |
| Zone | DNS : Edit | `dl.` / `registry.` 的 custom domain 会自动建 DNS 记录；也用于手动加记录 |
| Zone | Workers Routes : Edit | `kepcup.com/oauth/*` 路由 |
| Zone | Cache Purge : Purge | CIMD 文档改动后清缓存（可选） |

之后做 P3 开发者门户时再追加（现在不要给）：Workers R2 Storage : Edit、Turnstile : Edit、Containers : Edit。

### 4.2 令牌 B「kepcup-zone-admin」（按需、高权限、短 TTL）

| 范围 | 权限 | 用来做什么 |
| ---- | ---- | ---------- |
| Zone | Zone Settings : Edit | 区域级设置 |
| Zone | Zone WAF : Edit（以及旧叫法 Firewall Services : Edit） | 给 `/oauth/*`、`/.well-known/*` 加 Skip 规则、为 `registry.` 加限速规则 |
| Zone | Bot Management : Edit | 关闭 / 调整 Bot Fight Mode（接口要求 `Bot Management Write`） |
| Zone | Zone : Read | 查 zone |

建议 TTL ≤ 7 天并限定本机 IP。**免费套餐的 Bot Fight Mode 可能无法通过 API 切换**——那样只能你在控制台点一下（Security → Bots → Bot Fight Mode），这时令牌 B 都不用建。

### 4.3 只能你在控制台做的

- **升级 Workers Paid**（账单）。
- 购买 / 转入域名；在注册商处改 NS。
- 创建 GitHub OAuth 应用（开发者门户）、各平台 OAuth 客户端（见 user-actions 的 U3 / U4）。

## 5. 操作约定（我遵守什么）

- 凭证只放在 `.env`，**从不回显**；脚本只解析 `CLOUDFLARE_*` 白名单键，其余内容一律不执行。
- **只读查询**（列 zone / Worker / D1 / DNS、`check`）可以随时做。
- **会改线上状态的操作**（部署、建库、改 DNS / 路由 / WAF）：只做你这次明确要求的事，做之前先说清计划；**影响整个 zone 的变更**（Bot Fight Mode、删除 DNS 记录、改 NS）一律先问你。
- 令牌 B 只在需要改 WAF / Bot 设置的那一刻用，用完提醒你让它过期。
- 变更后给你看结果（JSON 摘要），并把做过的事记进 `docs/dev/PROGRESS.md` 对应阶段。

## 6. 轮换与撤销

- 怀疑泄露：控制台 → Account API Tokens → 对应令牌 → **Roll**（换新值）或 **Delete**。
- 重建后只需改 `.env`，无需改任何代码。
- 换机器：重新 `cp .env.example .env` 填写即可；`cf auth login` 的设备登录是另一条路径，不用于本仓库的自动化。

## 7. 线上变更记录（Agent 做过的事，最新在前）

账号 id `37918f50…`；kepcup.com zone `91ba5016c1b4df6855cf21439cbd20c9`（Free）。该账号还有 `botrunning.com`、`fincop.cc`、`inkcop.cc` 三个 zone 和 Worker `inkcop-web`、`oss-cache`，属于其他项目，**不碰**。

| 日期 | 动作 | 结果 |
| ---- | ---- | ---- |
| 2026-10-10 | 只读盘点：DNS、Worker、D1、Bot Management | kepcup.com **没有任何 DNS 记录**；Bot Fight Mode 本来就是关的（`fight_mode:false`）；账号里没有 D1 |
| 2026-10-10 | `cf d1 create --name kepcup-registry` | 已建，id `efc7712f-a979-414e-b315-3640cd00a600`（WEUR，无管辖区限制；公开元数据，无用户数据） |
| 2026-10-10 | `wrangler d1 execute kepcup-registry --remote --file=schema.sql` | 已建表（`servers` / `reviews` / `sync_state`） |
| 2026-10-10 | 部署 Worker `kepcup-registry`（D1 绑定 + Cron `17 * * * *`，**暂不带域名路由**） | 已部署，版本 `4e1a846e…`；首次同步在下一个整点后的 :17（UTC） |
| 2026-10-10 | 尝试创建 kepcup.com 顶级域的 `AAAA 100::`（已代理）记录 | 当时被自动模式的安全分类器拦下，未创建；用户加了 Bash 权限规则后重试成功 |
| 2026-10-10 | `cf dns records create`：`AAAA kepcup.com 100::`（已代理） | 已建，记录 id `7443880c…` |
| 2026-10-10 | 部署 `kepcup-oauth-cimd`（路由 `kepcup.com/oauth/*`） | 已上线，版本 `7b446bf9…`；`verify.mjs` 通过；`/oauth/logo.png` 为 `image/png` |
| 2026-10-10 | 注册表改用 custom domain `registry.kepcup.com` 并重新部署 | 已上线，版本 `a6b99ada…`；冒烟：GET 200、ETag 条件请求 304、POST 405；表仍为空，等 :17 UTC 的首次同步 |
| 2026-10-10 | 本机生成 Ed25519 签名密钥（keyId `kepcup-2026-1`）：私钥种子只写进 `.env` 的 `KEPCUP_CONNECTOR_SIGNING_KEY`，公钥登记进 `CONNECTOR_INDEX_PUBLIC_KEYS` | 私钥不入库、不上传 Cloudflare；**请自行备份 `.env` 里这一行**，丢失只能走轮换 |
| 2026-10-10 | 用 `infra/cloudflare/sign-directory.sh` 签名（6 条目）并部署 `kepcup-directory`，custom domain `dl.kepcup.com` | 已上线，版本 `ea6b872f…`；`directory/verify.mjs` 通过 |
| 2026-10-10 | 写入 `http_ratelimit` 规则：`registry.kepcup.com` 每 IP（按 colo）每 10 秒 60 次，超出封 10 秒 | 已生效，ruleset `75902de5…`、rule `9a0b198f…`（免费套餐仅允许 1 条限速规则，已占用）；改动前被分类器拦下，用户追加更窄的 Bash 规则后成功 |
| 2026-10-10 | 确认注册表首次定时同步 | 17:17 UTC 同步成功，`servers` 表 800 条（8 页 × 100，`SYNC_MAX_PAGES=8`），游标已保存，之后每小时接着同步；`/v0.1/servers` 返回真实数据 |

### 等你放行的

暂无。线上待办只剩首次注册表同步（:17 UTC）的确认。

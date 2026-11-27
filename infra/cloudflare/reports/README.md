# reports — AI 内容举报 Worker（`reports.kepcup.com`）

Microsoft Store 政策 11.16（Live Generative AI Content）的举报接收端（方案
`todo/ai-content-reporting.md` §7 / §11）：Cloudflare Workers + D1 + Cron，独立部署单元
（独立 D1 / 域名，与 `../registry/` 同构）。桌面端点 👎 后 core 异步推送举报 payload，
Worker 重算 hash 校验、按 client 时间桶去重、限流后入库；管理员经同源内嵌 Web UI
（`https://reports.kepcup.com/admin/`）或 bearer-token admin API（`scripts/report-triage.mjs`）
triage。

```
infra/cloudflare/reports/
  wrangler.jsonc    Worker + D1 绑定 + cron + custom domain（database_id 已回填真实值）
  schema.sql        D1 表：reports（两条 UNIQUE 去重约束）/ report_rate / report_ip_rate / report_pow_used / report_daily
  verify.mjs        线上冒烟脚本（部署后跑，零依赖；见下文「部署后冒烟」）
  src/index.ts      导出 fetch + scheduled（默认导出 ExportedHandler）
  src/worker.ts     公开管线（§7.4 十二步 + PoW 6.5 + 日上限 10.5，去重先于限流）、IP/客户端限流、日志
  src/pow.ts        PoW challenge 签发 / 验证（任务 5A 协议 v1；WebCrypto + atob/btoa，禁 node:crypto）
  src/admin.ts      /v1/admin/*（bearer 或会话 Cookie、常量时间比较、list/detail/patch/delete-client/stats）+ /admin* 会话端点与页面路由
  src/admin-ui.ts   管理端单页资产（任务 5B：ADMIN_HTML/ADMIN_JS/ADMIN_CSS 字符串常量，vanilla JS 零依赖零构建）
  src/dedupe.ts     canonicalJson + content/payload hash（WebCrypto；与 core 的 node:crypto 实现以 fixture 向量互锁；proof 剥离）
  src/validate.ts   手写校验（shape/enum/长度/控制字符；数值与 shared REPORT_* 常量同步）
  src/db.ts         D1 语句封装（§7.5 限流 SQL 逐字一致；PoW 单次使用 / 日上限 / 清理）
  src/types.ts      D1Like / Env / ReportPayload（手写镜像 shared schema，注释注明同步维护）
  src/cf-types.d.ts 本地声明的最小 Cloudflare 类型（@cloudflare/workers-types 可直接替换）
  tsconfig.json     独立类型检查：npx tsc -p infra/cloudflare/reports --noEmit（不在 pnpm 工作区内）
  test/             vitest（根 vitest.config.ts 的 `infra-reports` 项目）
scripts/report-triage.mjs   日常处置 CLI（本目录之外的唯一配套，零依赖）
```

## 资源清单

| 资源 | 值 | 说明 |
|---|---|---|
| Worker | `kepcup-reports` | 独立部署单元，`workers_dev:false` |
| 域名 | `reports.kepcup.com` | custom domain；DNS 与证书由 wrangler 部署时自动创建 |
| D1 | `kepcup-reports` | id 是公开资源标识，见 `wrangler.jsonc` 的 `database_id`（建库时回填）与 `../README.md` §7（线上变更表） |
| Secret | `REPORT_ADMIN_TOKEN` | admin API bearer 与 Web UI 会话签名密钥（同一值），随机 32 字节 hex；**同一值**放仓库根 `.env` 的 `KEPCUP_REPORT_ADMIN_TOKEN`（已 gitignore），供 CLI/冒烟使用 |
| Secret | `IP_HASH_SALT` | IP 限流的 HMAC 盐，随机 32 字节 hex；**只**在 Worker secret，不进 `.env`、不进任何仓库文件 |
| Secret | `REPORT_POW_SECRET` | PoW challenge 签名密钥（任务 5A），随机 32 字节 hex；**只**在 Worker secret，不进 `.env`、不进任何仓库文件；未配置时不启用 PoW |
| vars | 见 `wrangler.jsonc` | 客户端限流 60s、IP 100/h、去重窗口 content 24h / payload 90d、保留 365 天、PoW 难度 20 / TTL 10 分钟、日上限 2000 |
| Cron | `23 4 * * *` | 每日清理过期 reports / report_rate / report_ip_rate / report_pow_used / report_daily |

限流与反滥用（客户端 1/min、IP 100/h、PoW、日上限 2000/天）**全部在 Worker + D1 内
实现**，不依赖 WAF——kepcup.com 免费套餐仅允许 1 条 zone 级限速规则，已被 registry
占用；本 Worker 不需要（也不要再）动 WAF。发现滥用时调低 `REPORT_IP_LIMIT`、调低
`REPORT_DAILY_LIMIT` 或调高 `REPORT_POW_DIFFICULTY`（改 `wrangler.jsonc` vars 后
`wrangler deploy`；PoW 逃生开关见下文「反滥用」节）。

## 契约

- payload 契约：`packages/shared/src/domain/report.ts`（§5.1）；Worker 不 import
  `@kepcup/shared`（独立部署单元），`src/types.ts` 手写镜像并由固定向量锚定。
- 固定向量：`packages/shared/test/fixtures/report-v1.json`（所有权在 shared，测试直接
  `../../../..` 相对引用）：
  - content hash = `69a79ef1…`（`message.text` 原文 utf8 sha256）；
  - payload hash = `66f397f8…`（去 reportId/createdAt/hashes 后 canonicalJson utf8 sha256）。
  core（node:crypto）与 Worker（crypto.subtle）各有一份 hash 实现，**禁止只改一边**；
  `test/dedupe.test.ts` 与 `test/contract.test.ts` 复算校验。`verify.mjs` 里还有一份
  只读的 node:crypto 副本用于自建 fixture。

## 公开接口

| 方法与路径 | 说明 |
|---|---|
| `GET /healthz` | `{ok:true, version}`，无鉴权 |
| `GET /v1/challenge` | PoW challenge 签发（任务 5A，见「反滥用」节） |
| `POST /v1/reports` | 举报受理，见下方管线 |

错误为 JSON `{error, issues?}`：415（非 application/json）、413（body > 128 KiB，流式计数）、
400（坏 JSON / 校验失败 / hash 不一致 / PoW 失败）、429（限流 / 日上限，带 `Retry-After` 与
`retryAfterMs`）、405（其他方法，带 `Allow`）、404（未知路径）。所有响应带
`Content-Type: application/json`、`Cache-Control: no-store`、`X-Content-Type-Options:
nosniff`；**不带任何 CORS 头**（原生 core fetch 不需要，浏览器页面不可读响应，§8）。

### 管线顺序（§7.4 + 任务 5A，顺序即语义）

方法/路径 → Content-Type → 流式 body 计数（128 KiB 硬上限）→ JSON.parse → 手写校验 →
重算两 hash（`proof` 是传输层字段，不进 hash）→ **PoW 验证（6.5）** → reportId 幂等 →
时间桶去重预检（服务端时钟）→ IP 粗限流（100/h，HMAC(ip)，`IP_HASH_SALT` 未配置时跳过
——**部署必配**）→ 客户端限流（§7.5 条件 upsert，1/min）→ **全局日上限（10.5）** →
`INSERT OR IGNORE`（UNIQUE 索引并发兜底）。**去重先于限流**：重复点击返回
`200 {status:'duplicate', reason}`，不占 1/min 名额、也不占日额度；**PoW 先于幂等读**：
proof 失败的请求不产生任何 D1 读，重放预解算池拿不到 duplicate。

## 反滥用（PoW + 日上限，任务 5A）

举报端点是匿名写入口（无账号体系），在既有的 1/min/client + 100/h/IP + 双 hash 去重之上，
再加两层：**工作量证明（PoW）**抬高批量提交的单价，**全局日上限**封顶绝对量。

### PoW 协议 v1

1. 客户端 `GET /v1/challenge` → 200 `{challenge, difficulty, expiresAt, algorithm:'sha256'}`。
   challenge = `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`，payload =
   `{ n: 16字节hex随机数, exp: 过期ms, d: difficulty, ipf: ip_hash }`；HMAC 密钥是
   `REPORT_POW_SECRET`。TTL 默认 10 分钟（`REPORT_POW_TTL_MS`）。`ipf` 复用
   `IP_HASH_SALT` 的 HMAC 逻辑把 token 绑定到请求 IP（防换 IP 重放）；盐未配置时两侧
   都按空串比对（与 IP 限流的「未配则跳过」语义一致）。
2. 求解：找 ASCII `solution` 使 `sha256(utf8(n + ':' + solution))` 的**前导零比特数 ≥
   difficulty**（默认 20，约 2^20 次 ≈ 0.3s Node 单核）；验证端一次哈希 + 计数。
3. 提交：POST body 顶层加兄弟键 `proof: { challenge, solution }`。**payload schema/hash
   契约不变**——`proof` 是传输层字段，payload hash 剥离清单从 [reportId, createdAt,
   hashes] 扩为 + proof；`packages/shared` 的 `reportPayloadSchema` 不知道 proof。
4. 验证（管线 6.5）：无 proof → 400 `missing_proof`；验签失败 / 格式错 →
   `challenge_invalid`；过期 → `challenge_expired`；`ipf` 与本次请求 ip_hash 不符 →
   `challenge_ip_mismatch`；解不满足难度 → `proof_invalid`；单次使用冲突 →
   `challenge_reused`。**challenge 失败一律 400、不带 Retry-After**（客户端解新题，
   不是等待）。单次使用表 `report_pow_used` 以 `sha256(完整 challenge 字符串)` 为主键、
   记首次绑定的 report_id：`INSERT OR IGNORE`，changes=0 且已存 report_id === 本次
   reportId → 放行（崩溃重发幂等），否则拒绝（防预解算池重放）。
5. 客户端（core 发送器）：POST 前先 GET challenge 并求解；`enabled:false`（PoW 关闭）
   或 challenge 端点 404（旧版 Worker）→ 无 proof 直发；收到 400 且 error 是上述六种
   原因 → 换新 challenge 重解重试**恰好一次**；求解超上限按网络错误退避。

### 参数

| var / secret | 默认 | 说明 |
|---|---|---|
| `REPORT_POW_SECRET` | （secret，部署必配） | challenge 的 HMAC-SHA256 密钥；未配置时不启用 PoW |
| `REPORT_POW_DIFFICULTY` | `20` | 解的前导零比特数；**0 = 逃生开关**，challenge 返回 `{enabled:false, difficulty:0, …}` 且提交不要求 proof |
| `REPORT_POW_TTL_MS` | `600000` | challenge 有效期（10 分钟） |
| `REPORT_DAILY_LIMIT` | `2000` | 全局日上限：按 UTC 日期计数的受理总数（`report_daily` 表）；超过 → 429 + `Retry-After` 至次日 UTC。duplicate 不占额度（去重先于计数）；被拒请求与 IP 限流同语义，消耗一次计数 |

`REPORT_POW_SECRET` 部署步骤（值不进终端历史、不进仓库）：

```bash
printf '%s' "$(openssl rand -hex 32)" | ../../../infra/cloudflare/with-env.sh \
  ../../../apps/website/node_modules/.bin/wrangler secret put REPORT_POW_SECRET
```

应急开关：被滥用时调低 `REPORT_DAILY_LIMIT` 或调高 `REPORT_POW_DIFFICULTY`（改
`wrangler.jsonc` vars 后 `wrangler deploy`）；PoW 出问题时设 `REPORT_POW_DIFFICULTY=0`
整体关闭（旧客户端带 proof 提交也会被接受——proof 是普通字段，校验只在 difficulty>0 时进行）。

与 Turnstile 的取舍：Turnstile 需要域名密钥对与浏览器 widget/iframe，而本端点的唯一
客户端是桌面 core 的原生 fetch（无浏览器环境），故用自托管 PoW（无第三方依赖、无
隐私外泄面）；真被打穿时再评估付费 WAF。

## Admin API（§7.6）

鉴权接受两种等价来源：`Authorization: Bearer <REPORT_ADMIN_TOKEN>`（CLI 通道，行为不变），
或 `POST /admin/session` 签发的会话 Cookie（Web UI 通道，见下节）。secret 未配置时整棵
子树（含 `/admin*`）404（隐藏入口）；比较先各自 sha256 再逐字节 diff（常量时间）。

会话 Cookie 鉴权的写操作（PATCH/DELETE）有第二道 CSRF 防线：`Origin` 头存在且非本源 →
403（bearer 不受影响，CLI 无 Origin 头）；GET 不校验。

| 方法与路径 | 说明 |
|---|---|
| `GET /v1/admin/reports?status=&limit=&before=&client=` | 列表，默认 new / limit 20 / keyset 分页（`nextBefore` 游标）；返回摘要 + 200 字正文预览，**不含 payload_json** |
| `GET /v1/admin/reports/:id` | 详情：全部列 + 解析后的完整 `payload` |
| `PATCH /v1/admin/reports/:id` | `{status:'triaged'\|'actioned'\|'dismissed', note?}`；`note` **省略 = 保留原值，`null` = 清除**；写 `updated_at`（`new` 是系统初始态，不可手工设置） |
| `DELETE /v1/admin/clients/:clientId` | 删该 client 全部 reports + report_rate 行（隐私删除请求） |
| `GET /v1/admin/stats` | 按状态计数 + 最近 7 天计数 |

## 管理端 Web UI（任务 5B）

浏览器打开 **`https://reports.kepcup.com/admin/`**（`/admin` 308 到 `/admin/`，查询串不
保留），输入 Admin Token（与 `REPORT_ADMIN_TOKEN` 同值）登录即可：看统计卡、按
状态/Client 筛选举报列表（keyset 翻页）、看完整 payload、改处置状态 + 备注、按 clientId
双重确认删除。内部工具，中文文案，暗色跟随系统。

- **会话**：登录成功签发 `__Host-kepcup_reports_session=<exp>.<sig>` Cookie——HttpOnly、
  Secure、SameSite=Strict、Path=/、**有效期 12 小时**。sig = HMAC-SHA256（密钥直接取
  `REPORT_ADMIN_TOKEN`，消息 `reports-session:<exp>`），会话**服务端零状态**；**轮换
  token 即刻失效全部会话**（密钥变了验签全不过）。
- **安全特性**：
  - 严格 CSP（页面与资产同头）：`default-src 'none'; script-src 'self'; style-src
    'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none';
    base-uri 'none'; form-action 'self'`——无内联脚本/样式、无第三方外链、不可被嵌入；
  - Cookie HttpOnly（脚本读不到）+ SameSite=Strict（跨站不携带）；
  - CSRF 第二道：Cookie 鉴权的 PATCH/DELETE 校验 `Origin` 头，非本源 403；
  - **XSS 防线**：全部动态内容经 `textContent` 渲染（举报正文是不可信输入），UI 源码
    无任何 markup 注入面（测试静态审计锁定），CSP 兜底；HTML/JS/CSS 不含任何 token
    字样，页面与资产无鉴权可取（秘密只在 API 层校验）；
  - 登录失败只回 401 + 通用路由日志（token 是 32 字节 hex 熵，在线爆破不可行，未加
    验证码/限速；Workers 也没有可用的服务端 sleep）。
- **资产与构建**：页面与 `app.js`/`app.css` 是 `src/admin-ui.ts` 导出的字符串常量，
  wrangler 打包零配置、无任何前端构建链；资产带内容 sha256 ETag（支持 304）——注意响应
  同时是 `no-store`，浏览器不会存缓存、不会自动走 If-None-Match 复验，304 只对显式带
  该头的工具/代理有意义（保留 ETag 是零成本的正确性兜底）。
- **删除门控只是防误触**：按 Client 删除的两道门（形似 id 输入 + 携 clientId 的 confirm
  弹窗）都在 UI 层；服务端只校验长度 ≤128，不做 clientId 形制检查，API/CLI 调用不受门控。
- **为什么内嵌而非外站/Astro**：同源免 CORS、Cookie 天然可用、严格 CSP 无需配置矩阵，
  且省掉第二个部署单元——单页管理工具用 vanilla JS 足够。
- **与 CLI 的关系**：同一套 `/v1/admin/*` JSON API（`scripts/report-triage.mjs` 的
  bearer 通道不变）；Web UI 适合人工看与点，CLI 适合脚本化与审计留痕，二者同权。

## 日常处置（triage CLI，§7.7）

token 从环境变量 `KEPCUP_REPORT_ADMIN_TOKEN` 读（与 Worker secret 同值，放仓库根 `.env`，
已 gitignore；脚本缺它直接退出，**永不打印 token**）。以下命令在**仓库根**执行。
`KEPCUP_REPORT_ENDPOINT` 可覆盖域名（默认 `https://reports.kepcup.com`，不带 `/v1`）。
错误响应原样展示状态码与 body。

```bash
# 列待处理（默认 status=new、limit 20）
node --env-file=.env scripts/report-triage.mjs list
node --env-file=.env scripts/report-triage.mjs list --status new --limit 50
node --env-file=.env scripts/report-triage.mjs list --client client-… --before '<nextBefore 游标>'

# 看单条完整 payload
node --env-file=.env scripts/report-triage.mjs show rep_…

# 处置：标记状态 + 备注
node --env-file=.env scripts/report-triage.mjs set rep_… triaged --note "初判：越权内容"
node --env-file=.env scripts/report-triage.mjs set rep_… actioned --note "已加入系统提示词拦截"
node --env-file=.env scripts/report-triage.mjs set rep_… dismissed --note "误报"

# 合规询问：按状态计数 + 近 7 天受理数
node --env-file=.env scripts/report-triage.mjs stats

# 隐私删除（用户要求删数据）；交互确认，脚本化场景加 --yes
node --env-file=.env scripts/report-triage.mjs delete-client client-…
```

处置流程（§7.7 五步；1–4 步也可在 `https://reports.kepcup.com/admin/` 上人工完成）：

1. 每日（至少每周）`list --status new` 过一遍。
2. 逐条 `show` 看详情；涉及违法 / 严重有害内容的当天处理。
3. `set … triaged` 评估；需要改提示词 / 模型 / 过滤的进入发版，无需处理的 `dismissed`。
4. 处理完 `set … actioned --note …`（备注写明动作，便于审计）。
5. 数据保留 365 天；用户要求删除时按 `delete-client` 删；若收到 Microsoft 合规询问，
   用 `GET /v1/admin/stats` 与下面的 D1 查询证明有机制、有处置记录。

## 部署状态（2026-11-27）

已由 Agent 按 §11.1 完成：创建 D1（`kepcup-reports`，id 已回填 `wrangler.jsonc`）、建表、
写入两个 secret、部署 Worker 与 Cron，并绑定 custom domain `reports.kepcup.com`（DNS 与
证书由 wrangler 自动创建）。`verify.mjs` 冒烟全部 PASS。线上变更记录见
`../README.md` §7。

## 部署（从零参考）

> 凭证经 `infra/cloudflare/with-env.sh` 从仓库根 `.env` 注入（先清 shell 里的
> `CLOUDFLARE_*` 再取值，**永不回显 token**）；wrangler 用仓库内
> `apps/website/node_modules/.bin/wrangler`（本机无全局安装）。以下命令在
> `infra/cloudflare/reports/` 目录里执行，相对路径按该目录写。

1. **建 D1**（输出的 database_id 回填 `wrangler.jsonc`；资源标识非机密）：
   ```bash
   ../../../infra/cloudflare/with-env.sh \
     ../../../apps/website/node_modules/.bin/wrangler d1 create kepcup-reports
   ```
2. **建表**（全新库，`schema.sql` 全部 IF NOT EXISTS，幂等）：
   ```bash
   ../../../infra/cloudflare/with-env.sh \
     ../../../apps/website/node_modules/.bin/wrangler d1 execute kepcup-reports --remote --file=schema.sql
   ```
3. **写 secrets**（值不进终端历史、不进仓库；token 同值追加进 `.env`）：
   ```bash
   grep -q '^KEPCUP_REPORT_ADMIN_TOKEN=' ../../../.env || \
     printf 'KEPCUP_REPORT_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" >> ../../../.env
   TOKEN=$(grep '^KEPCUP_REPORT_ADMIN_TOKEN=' ../../../.env | cut -d= -f2-)
   printf '%s' "$TOKEN" | ../../../infra/cloudflare/with-env.sh \
     ../../../apps/website/node_modules/.bin/wrangler secret put REPORT_ADMIN_TOKEN
   printf '%s' "$(openssl rand -hex 32)" | ../../../infra/cloudflare/with-env.sh \
     ../../../apps/website/node_modules/.bin/wrangler secret put IP_HASH_SALT
   printf '%s' "$(openssl rand -hex 32)" | ../../../infra/cloudflare/with-env.sh \
     ../../../apps/website/node_modules/.bin/wrangler secret put REPORT_POW_SECRET
   # 回读校验（只列名字不显示值）：wrangler secret list 应含三个 secret 名
   ```
   token 轮换：重新 `wrangler secret put REPORT_ADMIN_TOKEN`，并同步更新 `.env`。轮换
   即刻失效全部 Web UI 会话（会话签名密钥就是该 token，见「管理端 Web UI」节）。
4. **部署**（custom domain 首次生效可能要几秒）：
   ```bash
   ../../../infra/cloudflare/with-env.sh \
     ../../../apps/website/node_modules/.bin/wrangler deploy
   ```
5. **冒烟**：
   ```bash
   node --env-file=../../../.env verify.mjs
   ```
   检查项：healthz、坏 JSON 400、合法 payload 201 accepted、同内容重发 200 duplicate
   （不占限流名额）、不同内容立即重发 429（带 Retry-After/retryAfterMs）、admin 无
   token 401/404、有 token 的 list/PATCH/stats/DELETE-client 与删除后列表为空、
   PoW（任务 5A）：`GET /v1/challenge` 200 → 脚本内求解（difficulty 20 约 1s）→ 201、
   同 proof 换 reportId → 400 `challenge_reused`、无 proof → 400 `missing_proof`
   （服务端 PoW 关闭时降级为「无 proof → 201」并标注）。脚本自建
   fixture（随机 clientId + 随机正文后缀）并**自己清理**测试行。注意：clientId 与正文
   每次随机，重跑（哪怕 60 秒内连跑）不会命中上一轮的去重/限流行，第 3 项仍是 201；
   只有为调试固定后缀时，重跑第 3 项才会拿到 duplicate（content 去重窗口 24 小时，
   等一分钟不够），换后缀或改正文即可。

## D1 排查 SQL

```bash
# 在 infra/cloudflare/reports/ 里；--command 换成下面的语句
../../../infra/cloudflare/with-env.sh \
  ../../../apps/website/node_modules/.bin/wrangler d1 execute kepcup-reports --remote --command "…"
```

```sql
-- 按状态计数（§11.3）
select status, count(*) from reports group by status;

-- 待处理 newest first（正文截 80 字，便于直接 triage）
select id, received_at, bot_name, model_provider, model_id, substr(message_text, 1, 80)
  from reports where status = 'new' order by received_at desc limit 20;

-- 某个 client 的全部举报（隐私删除前确认影响面）
select id, status, received_at from reports where client_id = '…' order by received_at desc;

-- 最近 7 天受理量
select count(*) from reports where received_at >= (strftime('%s','now') * 1000 - 7*86400000);

-- 校验表结构与索引都在（应列出 reports / report_rate / report_ip_rate /
-- report_pow_used / report_daily 及对应索引）
select name, type from sqlite_master where type in ('table','index') and name not like 'sqlite_%'
  order by type, name;
```

## 数据保留与清理

- `reports` 保留 365 天（`REPORT_RETENTION_DAYS`）；cron `23 4 * * *` 删除
  `received_at < now-365d` 的 reports、`last_at < now-24h` 的 report_rate、
  `window_start < now-IP_WINDOW` 的 report_ip_rate、`used_at < now-24h` 的
  report_pow_used（challenge TTL 只有 10 分钟，1 天绰绰有余）与 `day < now-7d` 的
  report_daily。
- 去重窗口：content 24h / payload 90d（时间桶，§5.5），与
  `packages/shared/src/domain/report.ts` 的 `REPORT_*_DEDUPE_MS` 默认一致；改 wrangler vars
  即可调整（设 0 = 永久去重，bucket 恒 0）。

## 已知限制

- **Web UI 单管理员视角**：同源内嵌单页（任务 5B）无自动轮询、无操作审计日志（处置
  留痕靠 PATCH 写进 note）；无 `#reportId` 深链（不能从 URL 直达某条详情，只能在列表里
  点）；「全部状态」视图是浏览器侧合并四种状态查询，翻页用裸时间戳游标，毫秒级并列的
  边界行极罕见情况下可能跳过；会话 12 小时、服务端零状态，无单独注销全部会话手段
  （轮换 token 即全部失效）。
- **限流不依赖 WAF**：免费套餐唯一的 zone 限速规则名额已被 registry 占用；本 Worker 的
  限流全在 Worker + D1（客户端 1/min + IP 100/h + 去重）。要更紧的 IP 限制只能改 vars
  或买 WAF 额度。
- **IP 限流依赖 `CF-Connecting-IP`**：该头缺失时跳过 IP 限流（见 src/worker.ts）——只有
  本地 dev 直连会这样，生产经 Cloudflare 必带。
- **免费额度**：Workers Free 每天 10 万次请求、D1 免费档每天 10 万行读 / 1 千行写；举报
  量级（1/min/client + 100/h/IP）远低于此。`wrangler tail kepcup-reports` 可看路由级
  JSON 日志（不含 payload）。
- **admin token 单值**：无多管理员 / 权限分级；轮换即覆盖（见上「部署」第 3 步）。
- **去重窗口即 vars**：改窗口不用动 schema（bucket 服务端计算）；但改短只影响新受理，
  库内旧行不回填。

## 测试

```bash
# 仅在 Docker 中（见 docs/dev/05-testing.md / AGENTS.md）
node scripts/run-tests.mjs run infra/cloudflare/reports
# 类型检查（宿主机）
npx tsc -p infra/cloudflare/reports --noEmit
```

与 registry 一样不引入 wrangler / miniflare：`test/helpers.ts` 用 `node:sqlite` 内存库实现
`D1Like`（batch / run / first / all），请求经 `handleRequest` 直调，服务端时钟用注入的固定
`now`（推进即模拟时间桶/窗口翻转）。fixture 复用
`packages/shared/test/fixtures/report-v1.json`。

## 日志与隐私（§8）

console.log 只输出两种 JSON 行：`{reportId, status, httpStatus}` 或
`{path, method, status}`——绝不打 payload、正文、clientId、IP、token，也不打
challenge / solution 原文（admin 详情路径里的 id 会被折叠成 `/v1/admin/<资源>`）。
原始 IP 不落库（只存 HMAC）；admin 列表只带正文预览，完整 payload 仅在详情接口出现。
verify.mjs / report-triage.mjs 同样不打印 token 与 PoW 原文。

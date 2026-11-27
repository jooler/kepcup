# 64 AI 生成内容举报（Microsoft Store 11.16，as-built）

> 状态：**已实施并上线（2026-11-27）**。方案与执行记录：`todo/ai-content-reporting.md`（历史方案，保留原样；与实现的偏差见本文 §11）。上游政策：Microsoft Store Policies 7.20 §11.16。

## 1. 背景与政策映射

Store 11.16（Live Generative AI Content）要求：元数据披露 live generative AI、在 Partner Center 勾选、生成内容遵守商店政策、**提供向开发者举报不当内容的手段**、**对举报采取适当行动**。本设计落实后两条（举报入口 + 可检索可处置的举报库）；前两条是 Partner Center 人工提交项，清单见 [docs/dev/06-release.md](../dev/06-release.md) §「待补充」。

| 条款 | 要求 | 本设计的对应 |
|---|---|---|
| 11.16 | 举报渠道 | Bot 消息 👎 = 举报入口（本机入队，后台发送） |
| 11.16 | 对举报采取适当行动 | Worker + D1 举报库（`new/triaged/actioned/dismissed`）+ admin API + triage CLI + 处置流程（§8） |
| 10.5.1 | 隐私政策 URL | `https://kepcup.com/privacy/` 已含应用完整政策与举报披露（apps/website i18n） |
| 10.5.2 | 向外部服务发送个人信息需 opt-in + 说明接收方 | 点击 👎 是显式动作即视为同意（不弹二次确认，已确认的定稿决策）；披露写在隐私政策与产品条款 |
| 10.5.4 | 安全传输/存储 | HTTPS 固定官方域名；D1 静态加密；本机 `main.db` 已是加密库；payload 不含 API Key |
| 11.12 | UGC（若适用） | 用户与自己的 Bot 对话，不构成公开 UGC 社区；举报流程按更严格的 11.16 处理 |

## 2. 架构总览（文字版）

```
渲染层（apps/desktop renderer）
  MessageReactionBar（hover emoji 面板）/ ChatMessageRow 右键菜单「举报不当内容」
        │  app RPC：messages.react / messages.reactions / reports.submit
        ▼
core（本机，main.db 加密库；packages/core/src/domain/reports.ts + reactions.ts）
  reports.submit：校验可举报性 → local 重读正文 / team 用快照 → redact+清洗+截断
    → canonicalJson 双 hash → INSERT OR IGNORE report_outbox（迁移 0084）
  reactions：message_reactions 表（scope 隔离本机/团队），仅本机
        │  后台发送器：1 条/分钟/client，POST https://reports.kepcup.com/v1/reports
        ▼
Worker kepcup-reports（infra/cloudflare/reports/，Cloudflare Workers）
  管线：校验 → 重算 hash → PoW 验证（6.5，任务 5A）→ 幂等 → 时间桶去重
    → IP/客户端限流 → 全局日上限（10.5）→ 入库
        ▼
D1 kepcup-reports（静态加密）
  reports / report_rate / report_ip_rate / report_pow_used / report_daily；
  cron「23 4 * * *」删过期行（365 天保留）
        ▼
triage：scripts/report-triage.mjs（bearer admin API：list/show/set/delete-client/stats）
  与 管理端 Web UI（任务 5B：浏览器 /admin/ 同源内嵌单页 → 同一套 /v1/admin/*）
```

要点：渲染层只负责交互；`reports.submit` 只入队不等待网络；队列在 core 的 `main.db`（关应用不丢、启动续发）；服务端是独立部署单元（独立 Worker / D1 / 域名），不复用 registry / relay。

## 3. 数据契约

- **唯一事实来源**：`packages/shared/src/domain/report.ts`——payload 顶层 schema（`reportPayloadSchema`）、子结构（client / source / bot / message / replyTo / context / usage / tools / providers / hashes）、内容上限常量（`REPORT_*_MAX_BYTES`）、去重窗口（`REPORT_CONTENT_DEDUPE_MS` 24h、`REPORT_PAYLOAD_DEDUPE_MS` 90d）、reaction 白名单（`MESSAGE_REACTION_EMOJIS` 12 个）与 scope 形状（`^local$|^team:[0-9a-f]{16}$`）。
- **RPC**：`packages/shared/src/rpc/methods.ts` 的 `messages.react` / `messages.reactions` / `reports.submit` / `reports.cancel`（均在 `APP_RPC_METHODS`）。`reports.submit` 输出 `queued | duplicate | rejected`（`rejected` 只作诊断，UI 静默）；`reports.cancel` 撤回本机队列里尚未发出的举报——按 (clientId, messageId) 删 `report_outbox` 的 pending/failed 行（输出 `cancelled`），行已 sending/sent 或本 client 无行输出 `not_revocable` + `reason: sent|sending|none`（见 §11.j）。
- **固定向量**：`packages/shared/test/fixtures/report-v1.json`——content hash 前缀 `69a79ef1…`、payload hash 前缀 `66f397f8…`。core（`node:crypto`）与 Worker（`crypto.subtle`）各有一份 hash 实现，以该向量逐字节互锁，禁止只改一边。
- **hash 定义**：content = 正文（text）或卡片 canonicalJson（card）的 sha256；payload = 去掉 `reportId / createdAt / hashes / proof` 后的 canonicalJson 的 sha256（递归按 key 字典序排序、数组保序；`proof` 是 PoW 传输层兄弟键，任务 5A，shared schema 不知道它）。bucket 由两侧各自时钟计算，不进 hash。
- **上限**：正文 32KB、卡片 16KB、replyTo 2KB、每条 context 2KB×最多 4 条、profile 8KB、附件元数据 ≤20 条、整包 128KB；清洗顺序 = `secrets.redact()` → 去 C0 控制字符（保留 `\n` `\t`）→ UTF-8 字节截断（不劈多字节/代理对，置 `truncated`）。
- **永不发送**：API Key（已知 Key 替换 `[REDACTED]`）、完整系统提示词（`systemRole` 只允许 `null` 或 `'butler'` 枚举）、工具输出全文、记忆条目、附件二进制、团队服务器地址（团队来源只带 16 hex 的 `serverHash`）。

## 4. 本机核心

**迁移 `0084_ai_reporting.sql`**（`packages/core/migrations/main/`）：

- `report_outbox`：发送队列。唯一索引 `(client_id, content_hash, content_bucket)` 与 `(client_id, payload_hash, payload_bucket)`（`INSERT OR IGNORE` 判重，并发安全）；`status ∈ pending/sending/sent/failed`；不建 FK 到 `messages`（团队消息不在本机库）。sent 行保留不清理（占住去重槽位）；pending/failed 行可被 `reports.cancel` 按 (client_id, message_id) 删除（§11.j）——删除即释放去重槽位，同内容窗口内可重新举报。
- `message_reactions`：`PRIMARY KEY (scope, message_id, client_id)`，每条消息每 client 至多一个 emoji；只存本机，不进消息内容、不参与团队同步。

**`ReportService`**（`packages/core/src/domain/reports.ts`）：

- `submit()`：local 来源用 `messages.getById()` 重读正文（不信任渲染层）；team 来源用渲染层快照（`snapshot` 必填，模型/usage 信息可缺失不阻塞）。Bot 已删除仍可举报（名字尽力回退，profile 空对象）。返回 `queued / duplicate / rejected`；rejected 原因：`not_reportable`（非可举报的 Bot 消息）、`payload_too_deep`（深嵌套 RangeError 收口）、`payload_too_large`（>128KB）。
- 排队（1 条/分钟/client）：`next_attempt_at = max(now+60s, 该 client 最后一行非 failed 的 next_attempt_at+60s)`；不同 client 各自计时。
- 发送状态机 `#tickOnce()`：条件 UPDATE 抢占（pending→sending）→ POST（`redirect:'error'`，15s 超时）；2xx → sent；429 → `max(Retry-After/retryAfterMs, 60s)` 退避；408/425/5xx/网络错误 → 指数退避 60s×2^n（上限 1h，±20% jitter）；其余 4xx/3xx → failed（schema 不兼容需发版修，不自动重试）；最多 20 次。
- 生命周期：`start()` 把崩溃残留的 `sending` 重置回 `pending` + 15s 轮询（timer `unref()`）；`close()` 只清定时器不等网络。
- 日志只记 `reportId / status / 错误码`，禁止正文 / clientId。

**`ReactionsService`**（`packages/core/src/domain/reactions.ts`）：set（白名单校验，`null` 取消）/ list（按 `(message_id, emoji)` 聚合 `count` + `mine`）；不校验消息存在性（团队消息可能不在本机库）。

## 5. Worker（reports.kepcup.com）

**公开管线**（`src/worker.ts`，顺序即语义）：方法/路径（405/404）→ Content-Type（415）→ 流式 body 计数（硬上限 128 KiB，超 413）→ JSON.parse（400）→ 手写校验（shape/枚举/长度/控制字符，400 + issues 不回显正文）→ WebCrypto 重算双 hash（不一致 400；`proof` 是传输层兄弟键，不进 hash）→ **PoW 验证（6.5，任务 5A，见下）** → `reportId` 幂等（200 duplicate/report_id）→ 服务端时钟时间桶去重预检（200 duplicate/content|payload）→ IP 粗限流（`CF-Connecting-IP` 的 HMAC-SHA256，固定 1h 窗口 100 次，429）→ 客户端限流（`report_rate` 条件 upsert 60s，429 + `Retry-After` + `retryAfterMs`）→ **全局日上限（10.5，任务 5A，见下）** → `INSERT OR IGNORE`（200 duplicate 并发兜底 / 201 accepted）。**去重先于限流**：重复点击不占 1/min 名额、也不占日额度。

**反滥用 PoW（任务 5A，协议 v1）**：举报端点是匿名写入口，`GET /v1/challenge` 签发 HMAC 签名的 challenge（`v1.<base64url(payload)>.<base64url(HMAC)>`，payload `{n:16字节hex, exp, d, ipf}`，密钥 `REPORT_POW_SECRET`），客户端求解 `sha256(utf8(n + ':' + solution))` 前导零比特 ≥ difficulty（默认 20，`REPORT_POW_DIFFICULTY`；TTL 10 分钟 `REPORT_POW_TTL_MS`），POST 时以顶层兄弟键 `proof: {challenge, solution}` 提交（shared payload 契约不变）。验证（6.5）在幂等读**之前**：无 proof / 验签失败 / 过期 / IP 绑定不符 / 解不满足难度 / 单次使用冲突分别返回 `missing_proof / challenge_invalid / challenge_expired / challenge_ip_mismatch / proof_invalid / challenge_reused`，一律 400、不带 Retry-After（客户端解新题而非等待）。`ipf` 把 token 绑定到签发时的 ip_hash（复用 `IP_HASH_SALT`；盐未配时两侧按空串比对）——**防换 IP 重放**；单次使用表 `report_pow_used` 以 `sha256(完整 challenge)` 为主键并绑定首个 report_id（`INSERT OR IGNORE`，同 challenge 同 reportId 的崩溃重发放行、换 reportId 拒绝）——**防预解算池**。逃生开关：`REPORT_POW_DIFFICULTY=0` 或 secret 未配置 → challenge 返回 `{enabled:false, difficulty:0, …}` 且提交不要求 proof；core 发送器对 disabled / 旧版端点 404 降级为无 proof 直发，对 PoW 400 换新 challenge 重试恰好一次，求解超上限按网络错误退避。与 Turnstile 的取舍：本端点唯一客户端是桌面 core 的原生 fetch（无浏览器 widget 环境），自托管 PoW 无第三方依赖、无隐私外泄面，真被打穿再评估付费 WAF。

**全局日上限（任务 5A）**：`report_daily(day, count)` 按 UTC 日期原子累加（步 10.5，在去重之后——duplicate 不占额度），超过 `REPORT_DAILY_LIMIT`（默认 2000）→ 429 + `Retry-After` 至次日 UTC；被拒请求消耗一次计数（与 IP 限流同语义）。cron 同步清理 `used_at < now-1d` 的 pow 行与 `day < now-7d` 的日计数行。

**Admin API + Web UI**（`src/admin.ts` + `src/admin-ui.ts`，任务 5B）：`/v1/admin/*` 鉴权接受 bearer `REPORT_ADMIN_TOKEN` 或会话 Cookie 二选一（CLI 通道不变），先各自 sha256 再逐字节比较（常量时间）；secret 未配置时整棵子树（含 `/admin*`）404（隐藏入口）。`GET /v1/admin/reports`（keyset 分页，摘要不含 payload_json）、`GET /v1/admin/reports/:id`（完整 payload）、`PATCH`（status: triaged/actioned/dismissed + note）、`DELETE /v1/admin/clients/:clientId`（隐私删除：删该 client 全部举报与限流行）、`GET /v1/admin/stats`。管理端 Web UI：`https://reports.kepcup.com/admin/` 同源内嵌 vanilla JS 单页（资产为 `src/admin-ui.ts` 的 HTML/JS/CSS 字符串常量，wrangler 打包零配置、零依赖零构建；`POST/DELETE /admin/session` 签发/清除 `__Host-` 会话 Cookie，12h），处置走 CLI 或 Web UI 均可。

**Cron**：`23 4 * * *` 每日清理 `received_at` 超 365 天的 reports、超 1 天的 client rate 行、过期 IP 窗口行。

**日志**：JSON 单行——举报路径 `{reportId,status,httpStatus}`、其余 `{path,method,status}`；admin 路径折叠（见 §11.f），绝不出现正文 / clientId / IP / token。响应统一 `application/json` + `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`，不带 CORS 头。

## 6. 部署资源清单（as-built，2026-11-27 已上线）

| 资源 | 值 |
|---|---|
| Worker | `kepcup-reports`（`workers_dev:false`，observability 开） |
| Custom domain | `reports.kepcup.com`（`custom_domain:true`，DNS/证书 wrangler 自动建） |
| D1 | `kepcup-reports`，database_id `1e63e07f-bd54-40b3-852f-7b4665bdc7d1`（公开资源标识） |
| Secret | `REPORT_ADMIN_TOKEN`（admin bearer；同值放仓库根 `.env` 的 `KEPCUP_REPORT_ADMIN_TOKEN` 供 CLI，已 gitignore） |
| Secret | `IP_HASH_SALT`（IP HMAC 盐；只在 Worker secret，不进任何仓库文件） |
| Secret | `REPORT_POW_SECRET`（PoW challenge 签名密钥，任务 5A；只在 Worker secret，不进任何仓库文件；主代理部署阶段写入） |
| Cron | `23 4 * * *` |
| vars | `REPORT_RATE_LIMIT_MS=60000`、`REPORT_IP_LIMIT=100`、`REPORT_IP_WINDOW_MS=3600000`、`REPORT_CONTENT_DEDUPE_MS=86400000`、`REPORT_PAYLOAD_DEDUPE_MS=7776000000`、`REPORT_RETENTION_DAYS=365`、`REPORT_POW_DIFFICULTY=20`、`REPORT_POW_TTL_MS=600000`、`REPORT_DAILY_LIMIT=2000`、`BUILD_VERSION=1.0.0`（与 shared 常量默认值一致） |

部署与冒烟流程见 `infra/cloudflare/reports/README.md`（`verify.mjs` 全 PASS；线上变更记录 `infra/cloudflare/README.md` §7）。限流全部在 Worker + D1 内实现，不动 WAF（kepcup.com 免费套餐唯一 zone 限速规则已被 registry 占用）。

## 7. UX（桌面端）

- Bot 消息（`senderType==='bot'`、kind text/card、未撤回）hover 操作组第一个按钮是 emoji（lucide `Smile`）；用户消息没有。
- 面板：5 个快捷 emoji `👍 👎 ❤️ 😂 🎉` + 展开常用网格（合计固定 12 个白名单）。非 👎：切换本机 reaction（再点取消），持久化到 `message_reactions`，刷新仍在；👎：加 👎 reaction 并 `reports.submit` 入队；已是 👎 再点 = 切换关闭（见下）。
- **👎 语义**：首次点击即入队并视为同意发送；不弹隐私确认、不弹成功/重复 toast（👎 chip 就是状态）。已是 👎 再点 = 切换关闭：移除 👎 emoji（`messages.react null`）并 `reports.cancel` 撤回尚未发出的举报（pending/failed 本机删除；sending/sent 不可撤，仅移除 emoji）——全程静默，两个 RPC 并发互不等待。撤回只承诺「尚未发出的举报」：sending 窗口（点击后 challenge+POST 往返的数秒）内举报可能已在线路上，UI 无法与已送达区分（§11.j）。
- 气泡下方 reaction chip 行：`😊 3`（>1 显示数量），自己的 reaction 高亮且可点（非 👎 点击 = 取消 reaction；自己的 👎 chip 点击 = 同上的切换关闭路径，aria-label 复用 `messages.reactions.emoji.👎`）；他人的 chip（含 👎）只读；scope 按 client 聚合，不跨设备同步。
- 右键菜单「举报不当内容」（`data-testid="context-message-report"`）与 👎 同流程——窄屏（hover 组不渲染）与键盘用户的可达路径。
- `rejected / duplicate` 全静默；发送失败只写本机日志，不提示。

## 8. 处置流程（11.16「take appropriate actions」，as-built）

1. 每日（至少每周）过一遍待处理：Web UI（`https://reports.kepcup.com/admin/`，任务 5B）或 `node --env-file=.env scripts/report-triage.mjs list`（默认 `--status new`）。
2. `show rep_…` 逐条看完整 payload；违法/严重有害内容当天处理。
3. `set rep_… triaged` → 评估；需改提示词/过滤/模型的进发版，无需处理 `set … dismissed`。
4. 处理完 `set rep_… actioned --note "…"`（动作入备注，便于审计）。
5. 保留 365 天（cron 自动删）；用户要求删除时 `delete-client <clientId>`（隐私删除请求经隐私政策公示的邮箱通道进来）；合规询问用 `stats` + D1 导出证明有机制、有处置记录。

## 9. 安全与隐私（as-built）

| 项 | 实现 |
|---|---|
| 传输 | HTTPS（custom domain 自动证书）；core 固定官方端点、`redirect:'error'`、15s 超时；不代理不走用户配置。`KEPCUP_REPORT_ENDPOINT` 覆盖是测试缝（`__KEPCUP_TEST_HOOKS__` 门控，终审补齐 todo §6.2 的 dev-only 门控）：打包产物 define false 折叠剔除，环境变量无法重定向（`apps/desktop/scripts/dist.mjs` 与 `pack-hooks.cjs` FORBIDDEN_MARKERS 双重复核） |
| 本机存储 | `main.db` 加密库（payload 含正文，但用户本机本就有原文）；清空应用数据即删本地副本 |
| 服务端存储 | D1 静态加密；只存清洗/截断后文本 + 完整 payload JSON；不存 API Key |
| IP | 不存原始 IP；HMAC-SHA256（`IP_HASH_SALT`）后存 `ip_hash`，仅限流用 |
| 日志 | Worker `{reportId,status,httpStatus}` / 路由行（admin 资源段折叠）；core 只记 `reportId/status/错误码`；无正文/clientId/IP |
| Admin | bearer 或会话 Cookie（二选一）+ 常量时间比较；未配置 404；token 只在 Worker secret 与本地 `.env` |
| Web UI 会话（任务 5B） | `__Host-kepcup_reports_session=<exp>.<sig>`：HttpOnly + Secure + SameSite=Strict + Path=/ + 12h；sig = HMAC-SHA256（密钥即 `REPORT_ADMIN_TOKEN`），服务端零状态，轮换 token 即全量失效 |
| Web UI CSP（任务 5B） | `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`（页面与资产同头）+ no-store + nosniff；无内联脚本/样式、无外链 |
| Web UI CSRF / XSS（任务 5B） | CSRF：SameSite=Strict 为主，Cookie 鉴权的 PATCH/DELETE 另校验 `Origin`（非本源 403；bearer 不受影响）；XSS：动态内容全部 `textContent` 渲染（UI 源码无 markup 注入面，测试静态审计锁定）+ CSP 兜底 |
| CORS | 不返回任何 CORS 头（原生 fetch 不需要；浏览器页面不可读响应） |
| 输入 | 128 KiB 流式计数、手写校验（不执行内容）、hash 重算 |
| 滥用 | 去重（content 24h / payload 90d 时间桶）→ PoW challenge（HMAC 签名 + IP 绑定 + 单次使用 + reportId 绑定，400 不带 Retry-After）→ IP 100/h → client 1/min → 全局日上限 2000/UTC 天（429 + Retry-After 至次日零点）；`proof`/challenge 原文不进日志；Cloudflare 边缘兜底 |
| 同意 | 点击 👎 即显式同意发送该条举报（10.5.2）；不点击不发送；无二次弹窗（定稿决策），披露在隐私政策/产品条款完整给出 |
| 删除 | admin `DELETE /v1/admin/clients/:clientId`（邮箱请求通道）+ 本机清数据；服务端保留 365 天后 cron 自动删 |

## 10. 测试地图

| 层 | 文件 | 覆盖点 |
|---|---|---|
| shared 契约 | `packages/shared/test/unit/reports-contracts.test.ts` | 四 RPC 进 `APP_RPC_METHODS`、输入输出 schema 往返 |
| 固定向量 | `packages/shared/test/fixtures/report-v1.json` | content/payload hash 共同锚点（两侧实现互锁） |
| core | `packages/core/test/unit/reports.test.ts` | payload 构建（bot/profile/usage/tools/providers/context/replyTo/附件）、local 重读防篡改、team 快照、拒绝路径、redact、截断、hash、去重窗口/时间桶边界、排队与 429/5xx/4xx 退避、启动恢复、cancel（pending/failed 删并释放槽位、跨桶多行全删、sending/sent/none 不可撤、撤后 kick 零 POST） |
| core | `packages/core/test/unit/reactions.test.ts` | set/toggle/聚合/mine/scope 隔离/白名单 |
| core | `packages/core/test/unit/ai-reporting-migration.test.ts` | 0083→0084 升级、表/索引/约束、重复插入 changes=0 |
| core | `packages/core/test/unit/report-contract.test.ts` | core 构建结果与 fixture 双 hash 逐字节一致 |
| Worker | `infra/cloudflare/reports/test/worker.test.ts` | 管线顺序、校验、413/415/400/429、幂等、日志无泄漏、PoW 六种 400 与单次使用/reportId 幂等（任务 5A）、日上限 429/次日重置/duplicate 不占额度、cron 清理 pow/daily 行 |
| Worker | `infra/cloudflare/reports/test/dedupe.test.ts` | canonicalJson 边界值与 hash 复算（与 fixture parity） |
| Worker | `infra/cloudflare/reports/test/admin.test.ts` | 鉴权/隐藏入口/list/detail/patch/delete-client/stats/分页 |
| Worker | `infra/cloudflare/reports/test/contract.test.ts` | Worker 实现与 fixture 双 hash 一致 |
| 桌面 UI | `apps/desktop/src/renderer/src/lib/features/chats/message-reactions.svelte.test.ts` | 面板/👎 入队/chip 聚合高亮/👎 再点 = react null + reports.cancel（cancelled 清状态、not_revocable 保留）（配套 `MessageReactionBar.svelte`、`MessageReactionChips.svelte`、`message-reactions.svelte.ts`、`message-reaction-target.ts`） |
| e2e | `apps/desktop/test/e2e/message-reactions.spec.ts` | hover → 👎 → chip；右键菜单 `context-message-report`；假 Worker 的 challenge（difficulty 4）→ 带 proof 的 POST 恰好一次、再点 👎 chip 消失且不增发 POST |
| 线上冒烟 | `infra/cloudflare/reports/verify.mjs` | healthz / 201 / duplicate / 429 / admin 拒绝与放行 / challenge→solve→201、challenge_reused、missing_proof |

## 11. 与方案的偏差记录（todo/ai-content-reporting.md → as-built）

(a) **canonicalJson 双实现逐字节 parity**：方案 §5.4 只要求「同一组固定向量做契约测试」；实现先把两侧（core `node:crypto` / Worker `crypto.subtle`）在边界值上对齐——undefined 值的对象键剔除、undefined 数组元素与顶层 undefined/function/symbol 折算 `null`、NaN/±Infinity → `null`、`-0` → `"0"`、数字走 V8 `Number::toString`、字符串转义即 `JSON.stringify` 语义——再以 `packages/shared/test/fixtures/report-v1.json` 逐字节锚定（core `report-contract.test.ts` + Worker `dedupe.test.ts`/`contract.test.ts` 双向复算）。

(b) **team 快照契约补可选 `conversation:{type}`**：方案 §5.2 只写「conversation.type：team 用快照」，未定 shape；实现给 `reportTeamSnapshotSchema` 加了可选 `conversation: { type: conversationTypeSchema }`，缺省时 core 回退本地 `conversations.get`，再回退 `'dm'`（local 来源缺省回退 `'direct'`）。

(c) **scope 直接使用 `session.source`**：方案 §5.6 的 scope 定义（`local` / `team:<serverHash>`）在实现里不做独立映射表——渲染层 `message-reactions.svelte.ts` 把会话来源 `SourceId` 直通为 scope（team 来源本身已是 `team:<hash>` 形状），`reports.submit` 的 `source` 同源；形状由 `MESSAGE_REACTION_SCOPE_PATTERN`（`^local$|^team:[0-9a-f]{16}$`）守卫。

(d) **`rejected` 语义扩展**：方案 §6.5 里 `rejected` 只表示「不是可举报的 Bot 消息」；实现把 payload 构建失败也收口为 `rejected`——深嵌套触发 RangeError → `payload_too_deep`、整包 >128KB → `payload_too_large`（§6.2 的 128KB 检查点从「抛错」变为「静默拒收」）。UI 对一切 `rejected` 保持静默，语义与 `not_reportable` 一致：这条举报不存在。

(e) **排队算法 failed 行不计入队尾**：方案 §6.2 写「按该 client 的 pending/sending/sent 最后时间 + 60s 排队」；实现为 `status != 'failed'`——失败行不重试，也不该把新举报顶到陈旧 failed 行的未来时间点之后（否则一次 429 长退避后的 failed 会让后续举报全部晚发）；取 `max(now+60s, last+60s)`，首条立即。

(f) **admin 路径日志折叠**：方案 §8 只约束「禁止打印 payload、正文、clientId、IP」；实现加 `logPath()` 把 `/v1/admin/<resource>/<id>` 折叠为 `/v1/admin/<resource>`——举报 id 与 `DELETE /v1/admin/clients/:clientId` 的 clientId 因此永不进 console（Cloudflare observability 会原样持久化 stdout）。

(g) **profile 的 runtime 段走 `payload.bot.runtime` 专段**：`profile_json` 的 runtime 段带插件/连接/MCP id 等与举报无关的字段（§5.3 要求去掉）；实现 `#trimmedProfile` 只保留画像五段（identity/persona/role/boundaries/behavior），模型配置单行走 `payload.bot.runtime`（`reportBotRuntimeSchema`），`systemRole` 只允许 `null` 或 `'butler'` 枚举——完整系统提示词在任何路径都不出本机。

(h) **反滥用 PoW + 全局日上限（任务 5A 增补）**：原方案 §7.5 明确「可选全局日上限：本期不做」；上线后增补——`GET /v1/challenge` 签发 HMAC challenge（`REPORT_POW_SECRET`），POST 以顶层兄弟键 `proof` 提交（§6.5，先于幂等读；payload hash 剥离清单 + proof，shared 契约不变），六种 challenge 失败一律 400 不带 Retry-After；`report_daily` 日上限 2000/UTC 天（§10.5，去重后计数，duplicate 不占额度）。逃生开关 `REPORT_POW_DIFFICULTY=0`；core 侧 challenge→solve→重试恰好一次，详见 §5。

(i) **任务 5A 已接受的四个现状缺口（评审定案，不改行为，留档）**：① **challenge GET 无鉴权/无限流**——`GET /v1/challenge` 不校验、不限量，任何人可预取任意多枚 challenge；接受理由：签发只是一次 HMAC（成本可忽略），真实成本压在求解（difficulty）与单次使用表（6.5），预取换不来绕过；若日后签发本身被打成成本点，再给该端点加 IP 粗限流。② **日上限被拒占额**——步 10.5 先 `bumpDailyCount` 再比较，超限的 429 请求已消耗一次计数（与 IP 限流同语义，README/§5 均已注明）；极端后果只是当日额度少 1，不会放大。③ **入库 payload_json 含 proof**——`reports.payload_json` 存整份 POST body（含已消费的 challenge token 与 solution），admin 详情可见；接受理由：token 已单次消费、不含用户数据，且剥离需要改 insert 路径（不影响 hash/去重）。④ **REPORT_POW_SECRET 未配置 = PoW 静默不强制**（fail-open 逃生开关，challenge 返回 `{enabled:false}`、提交不要求 proof）——部署必配已在 README/§9 注明；接受理由：宁可临时降级也不让举报入口 5xx。

(j) **「举报不可撤回」决策修订为「发送前可撤」（👎 toggle 定稿，任务 6）**：原 §7 定稿决策「已是 👎 再点 no-op；举报不可撤回」与 §6.4「failed 行保留不清理」修订为——已是 👎 再点 = 切换关闭：移除 👎 emoji 并调 `reports.cancel`，把本机 `report_outbox` 里该 (clientId, messageId) 的 **pending 与 failed 行直接删除**（failed 行从未送达，本地丢弃属正确语义），返回 `cancelled` 并释放去重唯一索引槽位（同内容窗口内可重新举报——与 §6.4 原本的「sent/failed 行保留」表述相比，failed 行不再永久占用槽位）；行已进入 sending/sent 或本 client 无行 → `not_revocable`（reason `sent`/`sending`/`none`），仅移除 emoji。**已发送的举报不可由客户端撤回**，用户侧删除仍走隐私政策两通道（本机清数据 + 邮件 `delete-client`）。`reports.cancel` 是纯本机行为：不联系 Worker、不产生网络请求，Worker 与 D1 契约零改动。**已知竞态（接受，不改行为）**：`submit` 的同步 kick 会在返回前把新行认领成 sending（条件 UPDATE 先于首个 await），所以「点 👎 后立刻再点撤回」通常落在 sending 窗口内得到 `not_revocable('sending')`；若该次发送随后失败，`#retry` 会把行拨回 `pending` 并稍后照常送达——举报最终发出而 UI 已移除 👎（崩溃恢复 `start()` 的 sending→pending 同理）。该窗口内「发送中」与「已送达」对用户不可区分，撤回语义因此只承诺「撤尚未发出的举报」：pending/failed 撤得掉，sending 之后的一切不追回。

**团队配套（嵌套私有仓 `jooler/kepcup-team-server`，commit `08e5aeb`）**：`apps/team-server/server/src/policy/method-policy.ts` 新增 3 个受控方法——`messages.react` / `messages.reactions` / `reports.submit`，均 `guarded('conversation')`；团队来源举报经团队服务器转发到宿主 core 处理，payload 的 `source` 只带 `team:<serverHash>`，不含团队服务器地址。

## 12. 参考

- 政策：Microsoft Store Policies 7.20 §11.16 / §10.5 — <https://learn.microsoft.com/en-us/windows/apps/publish/store-policies>
- 历史方案：`todo/ai-content-reporting.md`（含轮次拆分与已确认决策表；偏差以本文 §11 为准）
- 契约：`packages/shared/src/domain/report.ts`、`packages/shared/src/rpc/methods.ts`
- 本机核心：`packages/core/src/domain/reports.ts`、`packages/core/src/domain/reactions.ts`、`packages/core/migrations/main/0084_ai_reporting.sql`
- Worker：`infra/cloudflare/reports/`（README 含资源清单、契约、处置命令、部署步骤）
- 处置 CLI：`scripts/report-triage.mjs`
- 披露页面：`https://kepcup.com/privacy/`（apps/website i18n privacy/terms 段）、[docs/dev/06-release.md](../dev/06-release.md) §「待补充」

# reports — AI 内容举报 Worker（`reports.kepcup.com`）

Microsoft Store 政策 11.16（Live Generative AI Content）的举报接收端（方案
`todo/ai-content-reporting.md` §7 / §11）：Cloudflare Workers + D1 + Cron，独立部署单元
（独立 D1 / 域名，与 `../registry/` 同构）。桌面端点 👎 后 core 异步推送举报 payload，
Worker 重算 hash 校验、按 client 时间桶去重、限流后入库；管理员经 bearer-token admin API
triage。**本期（第 1 轮）只交付骨架 + 单测，不部署**；部署在阶段 2（§12 第 2 轮）。

```
infra/cloudflare/reports/
  wrangler.jsonc    Worker + D1 绑定（database_id 占位 TODO_FILL_AFTER_D1_CREATE）+ cron + custom domain
  schema.sql        D1 表：reports（两条 UNIQUE 去重约束）/ report_rate / report_ip_rate
  src/index.ts      导出 fetch + scheduled（默认导出 ExportedHandler）
  src/worker.ts     公开管线（§7.4 十二步，去重先于限流）、IP/客户端限流、日志
  src/admin.ts      /v1/admin/*（bearer、常量时间比较、list/detail/patch/delete-client/stats）
  src/dedupe.ts     canonicalJson + content/payload hash（WebCrypto；与 core 的 node:crypto 实现以 fixture 向量互锁）
  src/validate.ts   手写校验（shape/enum/长度/控制字符；数值与 shared REPORT_* 常量同步）
  src/db.ts         D1 语句封装（§7.5 限流 SQL 逐字一致）
  src/types.ts      D1Like / Env / ReportPayload（手写镜像 shared schema，注释注明同步维护）
  src/cf-types.d.ts 本地声明的最小 Cloudflare 类型（@cloudflare/workers-types 可直接替换）
  tsconfig.json     独立类型检查：npx tsc -p infra/cloudflare/reports --noEmit（不在 pnpm 工作区内）
  test/             vitest（根 vitest.config.ts 的 `infra-reports` 项目）
```

## 契约

- payload 契约：`packages/shared/src/domain/report.ts`（§5.1）；Worker 不 import
  `@kepcup/shared`（独立部署单元），`src/types.ts` 手写镜像并由固定向量锚定。
- 固定向量：`packages/shared/test/fixtures/report-v1.json`（所有权在 shared，测试直接
  `../../../..` 相对引用）：
  - content hash = `69a79ef1…`（`message.text` 原文 utf8 sha256）；
  - payload hash = `66f397f8…`（去 reportId/createdAt/hashes 后 canonicalJson utf8 sha256）。
  core（node:crypto）与 Worker（crypto.subtle）各有一份 hash 实现，**禁止只改一边**；
  `test/dedupe.test.ts` 与 `test/contract.test.ts` 复算校验。

## 公开接口

| 方法与路径 | 说明 |
|---|---|
| `GET /healthz` | `{ok:true, version}`，无鉴权 |
| `POST /v1/reports` | 举报受理，见下方管线 |

错误为 JSON `{error, issues?}`：415（非 application/json）、413（body > 128 KiB，流式计数）、
400（坏 JSON / 校验失败 / hash 不一致）、429（限流，带 `Retry-After` 与 `retryAfterMs`）、
405（其他方法，带 `Allow`）、404（未知路径）。所有响应带
`Content-Type: application/json`、`Cache-Control: no-store`、`X-Content-Type-Options:
nosniff`；**不带任何 CORS 头**（原生 core fetch 不需要，浏览器页面不可读响应，§8）。

### 管线顺序（§7.4，顺序即语义）

方法/路径 → Content-Type → 流式 body 计数（128 KiB 硬上限）→ JSON.parse → 手写校验 →
重算两 hash → reportId 幂等 → 时间桶去重预检（服务端时钟）→ IP 粗限流（100/h，
HMAC(ip)，`IP_HASH_SALT` 未配置时跳过——**部署必配**）→ 客户端限流（§7.5 条件 upsert，
1/min）→ `INSERT OR IGNORE`（UNIQUE 索引并发兜底）。**去重先于限流**：重复点击返回
`200 {status:'duplicate', reason}`，不占 1/min 名额。

## Admin API（§7.6）

全部要求 `Authorization: Bearer <REPORT_ADMIN_TOKEN>`；secret 未配置时整棵子树 404（隐藏
入口）；比较先各自 sha256 再逐字节 diff（常量时间）。本期无 Web UI；阶段 2 提供
`scripts/report-triage.mjs`（`list` / `show` / `set` / `delete-client`）。

| 方法与路径 | 说明 |
|---|---|
| `GET /v1/admin/reports?status=&limit=&before=&client=` | 列表，默认 new / limit 20 / keyset 分页（`nextBefore` 游标）；返回摘要 + 200 字正文预览，**不含 payload_json** |
| `GET /v1/admin/reports/:id` | 详情：全部列 + 解析后的完整 `payload` |
| `PATCH /v1/admin/reports/:id` | `{status:'triaged'\|'actioned'\|'dismissed', note?}`；写 `updated_at` |
| `DELETE /v1/admin/clients/:clientId` | 删该 client 全部 reports + report_rate 行（隐私删除请求） |
| `GET /v1/admin/stats` | 按状态计数 + 最近 7 天计数 |

## 数据保留与清理

- `reports` 保留 365 天（`REPORT_RETENTION_DAYS`）；cron `23 4 * * *` 删除
  `received_at < now-365d` 的 reports、`last_at < now-24h` 的 report_rate、
  `window_start < now-IP_WINDOW` 的 report_ip_rate。
- 去重窗口：content 24h / payload 90d（时间桶，§5.5），与
  `packages/shared/src/domain/report.ts` 的 `REPORT_*_DEDUPE_MS` 默认一致；改 wrangler vars
  即可调整（设 0 = 永久去重，bucket 恒 0）。

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

## 部署（阶段 2，占位）

一次性部署步骤以方案 §11.1 为准（`infra/cloudflare/with-env.sh` 注入凭证；不要在命令行
回显 token）：

1. 建 D1：`wrangler d1 create kepcup-reports`，把输出的 database_id 回填
   `wrangler.jsonc`（现为 `TODO_FILL_AFTER_D1_CREATE` 占位）。
2. 建表：`wrangler d1 execute kepcup-reports --remote --file=schema.sql`。
3. Secrets：`wrangler secret put REPORT_ADMIN_TOKEN`（随机 32 字节 hex）与
   `wrangler secret put IP_HASH_SALT`（未配置则跳过 IP 限流，见 src/worker.ts）。
4. 部署：`wrangler deploy`（custom domain 自动建 reports.kepcup.com 的 DNS/证书）。
5. 冒烟：阶段 2 提供 `verify.mjs`（health / 400 / 201 / duplicate / 429 / admin 拒绝与放行）。
6. 记录到 `../README.md` §7 线上变更表。

## 日志与隐私（§8）

console.log 只输出两种 JSON 行：`{reportId, status, httpStatus}` 或
`{path, method, status}`——绝不打 payload、正文、clientId、IP、token。原始 IP 不落库
（只存 HMAC）；admin 列表只带正文预览，完整 payload 仅在详情接口出现。

# registry — KepCup MCP 子注册表（`registry.kepcup.com`）

官方 MCP Registry OpenAPI **v0.1 的只读实现**（设计 29 §11.4 / §15.2，执行方案 `todo/connected-apps.md` §7.3）：
Cloudflare Workers + D1 + Cache API；Cron 每小时从官方注册表增量同步；KepCup 审核结果存在 D1 `reviews` 表，
合并进响应的 `_meta`。Cloudflare 没有现成的 Registry 产品，所以按官方 OpenAPI 自行实现。

```
infra/cloudflare/registry/
  wrangler.jsonc    Worker + D1 绑定 + cron + 路由 registry.kepcup.com/*（database_id 是占位）
  schema.sql        D1 表：servers / reviews / sync_state
  src/index.ts      导出 fetch + scheduled
  src/worker.ts     路由、校验、keyset 游标分页、ETag / 304、Cache API 读穿透、审核合并
  src/sync.ts       上游增量同步（有界、可续、永不抛出；校验 / 净化每条上游数据）
  src/reviews.ts    `reviews` 的唯一写入口（submitReview / revokeReview，开发者门户经窄 RPC 调用）
  src/util.ts       sha256 / 时间 / `_meta` 净化（sanitizeServerMeta）
  src/types.ts      D1Like / CacheLike 等最小接口（测试用内存 SQLite 实现）
  src/cf-types.d.ts 本地声明的最小 Cloudflare 类型（真实的 @cloudflare/workers-types 可直接替换）
  tsconfig.json     独立类型检查：npx tsc -p infra/cloudflare/registry --noEmit（不在 pnpm 工作区内）
  test/             vitest（根 vitest.config.ts 的 `infra-registry` 项目）+ OpenAPI 子集
```

## 接口

| 方法与路径 | 说明 |
|---|---|
| `GET /v0.1/servers` | 列表。`cursor`、`limit`（默认 30，1–100）、`updated_since`（RFC 3339，**不含**边界）、`search`、`version`（`latest` 或精确版本）、`include_deleted`（带 `updated_since` 时恒为 true） |
| `GET /v0.1/servers/{serverName}/versions` | 某 server 全部版本，发布时间新→旧；`serverName` 是 URL 编码的 `com.example%2Fmy-server`（也容忍未编码的两段写法）。每页最多 1000 条，超出时 `metadata.nextCursor` 给出下一页（`?cursor=`，**KepCup 扩展**；官方此接口不分页），不会静默截断 |
| `GET /v0.1/servers/{serverName}/versions/{version}` | 单个版本，`version` 可为 `latest` |
| `GET /v0.1/health` `/ping` `/version` | 存活 / 构建信息 |

- `/v0/...` 作为 `/v0.1/...` 的别名（官方两者同 schema）。
- **只读**：`GET`；`HEAD` = 无 body 的 GET；`OPTIONS` = `204`（`Allow` / `Access-Control-Allow-Methods: GET, HEAD`）；其余方法 `405`（`Allow: GET, HEAD, OPTIONS`）。发布 / 改状态不在这里；数据来自 Cron 同步，审核结果经 `reviews.ts` 写入。
- **CORS**：`Access-Control-Allow-Origin: *` 是**有意**的——接口公开、只读、无 Cookie / 无凭据（测试断言所有响应都无 `Set-Cookie` / `Allow-Credentials`），跨源页面能做的 `curl` 本来都能做。
- 错误是 `application/problem+json`（`title`/`status`/`detail`/`errors[]`）：未知 server / 版本 `404`、参数不合法 `422`（与官方实际行为一致，如 `limit=500`）、路径百分号编码损坏 `400`。
- `search`：对 name / title / description 做**大小写不敏感（仅 ASCII，同 SQLite `lower()`）子串匹配**，用 `instr()` 而不是 `LIKE`（D1 把 LIKE 模式限制在 50 字节，长一点就会 500；测试适配器模拟了这个限制）。词先 `trim`，最长 **200 个 UTF-8 字节**（按字节不是字符，CJK 约 66 字），超出 `422` 并说明；`%` `_` 按字面处理。
- 分页：按 `(name, version)` keyset，游标是不透明的 base64url（`JSON [a, b]`），插入 / 删除不影响已翻过的页；只有确实还有下一页时才返回 `nextCursor`。谓词写成 `name >= ? AND (name > ? OR version > ?)`，规划器走主键索引 `SEARCH`（`EXPLAIN QUERY PLAN` 测试断言；未用行值比较，不依赖 D1 的行值支持）。

### 缓存与滥用防护

- 响应带 `ETag`（强校验，body 的 SHA-256 前 128 位）；`If-None-Match` 命中返回无 body 的 `304`。对客户端：`Cache-Control: public, max-age=0, s-maxage=300`（浏览器每次带 ETag 复验，边缘最多缓存 5 分钟）。**没有** `stale-while-revalidate`（Workers Cache API 不支持）。
- 200 响应经 Cache API 读穿透；存进 Cache API 的副本是显式 `max-age=300`，命中时再改回上面的客户端标签。
- **缓存键只由解析后的白名单参数构成**：未知参数、重复参数（与处理器一致，**取第一个值**）、空值、`search` 大小写 / 首尾空白、`include_deleted=false`、`limit=30`（默认值）、`/v0` 别名、未编码的 server 名等价写法都落到同一个键；随便加 `?junk=…` 不会造出新条目（测试断言）。
- **可见性延迟**：审核通过 / 撤销写入 D1 后，各 Cloudflare 数据中心最多约 **5 分钟**（`s-maxage=300`；Cache API 不跨 colo 清除）才看到；上游数据另外要等下一次 Cron（每小时）。要更短就调小 `EDGE_TTL_SECONDS`。
- **建议在 Cloudflare 控制台加 WAF 速率限制规则**（Workers 内不做限流；缓存只挡住重复请求，D1 读仍可能被"不同合法参数"放大）：对 `registry.kepcup.com` 的 `GET /v0.1/*` 按 IP 限 60 请求 / 10 秒（超出 Managed Challenge 或 429），并对 `search=` 非空的请求单独收紧到 10 请求 / 10 秒。属用户待办。

## 审核合并规则（`reviews` → `_meta`）

- 只有 `review_status = 'approved'` **且**记录的 `server_json_sha256` 仍等于该行当前 `servers.server_json_sha256` 的审核结果对外可见；`pending` / `rejected` / 内容已变（重新同步后 server.json 变了）/ 没有审核记录 = **不带 tier**，重新批准后才恢复。
- 可见时在每条响应的 `_meta` 加：`app.kepcup/connector: { tier }` 与 `app.kepcup/review: { tier, status: "approved", reviewedAt, toolContractHash, notes? }`。审核按 **(name, version)** 生效，不跨版本。
- **tier 只信 `reviews` 表**：输出时（以及同步入库前）从发布者的 `server._meta` 与其 `io.modelcontextprotocol.registry/publisher-provided` 子对象里剔除注册表自有的键——`app.kepcup/review` 整个、`app.kepcup/connector` 里的 `tier` / `status` / `reviewedAt` / `toolContractHash`、`io.modelcontextprotocol.registry/official`（防止自标 `verified` / 冒充注册表块）。`slug` / `category` 等发布者数据保留。
- `updated_since` 与响应里的 `updatedAt` 取 `max(servers.updated_at, reviews.reviewed_at)`，所以新审核结果**和撤销**也能被增量拉取到。
- **写入口只有 `src/reviews.ts`**（门户经 service binding 上的窄 RPC `submitReview` / `revokeReview` 调用，RPC 外壳随门户 D4 添加）：只能给同步已入库的 `(name, version)` 写审核；`reviewed_at` 由服务端生成、毫秒精度、对同一行严格递增（批准与撤销都必须有）；批准时 sha256 由服务端读当前行得出，不接受调用方提供；批准必须带 `toolContractHash`；写入是 `ON CONFLICT … DO UPDATE … WHERE excluded.reviewed_at > reviews.reviewed_at`（并发时较新者胜）。库级约束（`schema.sql`）：`reviewed_at NOT NULL` 且是 `YYYY-MM-DDTHH:MM:SS.mmmZ`（GLOB），批准必须带 64 位 sha256。
- 上游同步**从不读写** `reviews`（测试断言 sync 的 SQL 不含 `reviews`）。

## 同步（`src/sync.ts`）

- Cron `17 * * * *`：`GET {UPSTREAM}/v0.1/servers?limit=100[&updated_since=水位线][&cursor=…]`，逐页 `INSERT … ON CONFLICT (name, version) DO UPDATE`（`updated_at` 不早于库内才覆盖）。上游缺 `updatedAt` / `publishedAt` / `statusChangedAt` 时用**首次见到的时间**（`first_seen_at`），内容或状态变化才刷新 `updated_at`，不会每轮都变成 `now()`。
- `is_latest` 每个 name 至多一个；新 latest 上位时降级同名其他版本；当前 latest 被删除 / 消失时，从剩余未删除版本里重算（active 优先，其次发布时间最新）。
- **水位线 = 本轮开始时间 − 5 分钟**（不是看到的最大 `updatedAt`）：翻页期间在游标之前被更新的条目，下一轮仍在窗口内，不会丢；5 分钟重叠同时吸收时钟偏差，重复投递无害（幂等）。首次无水位线 = 全量回填；水位线只在整轮拉完才前进；未完成的回填把游标存进 `sync_state.run_cursor`（连同本轮 `run_started_at` / `run_since`），下一次 Cron 接着拉。
- **每轮页数**：默认 **8 页**（`SYNC_MAX_PAGES` 变量可调，`wrangler.jsonc` 的 `vars`）。Workers **Free 每次调用只有 50 个子请求**（fetch 与 D1 调用都算），每页约 1 次 fetch + 2 次 D1，8 页 + 固定开销约 30 次；**Workers Paid（1000 个子请求）可调到 20+**。官方注册表有数千条时首次回填要若干个小时（每轮 800 条）。
- **毒丸防护**：每条上游条目入库前校验——`name` 匹配 `^[A-Za-z0-9.-]+/[A-Za-z0-9._-]+$` 且 ≤ 200；`version` 非空、≤ 128、不是 `latest`、无控制字符；`status` 合法；`statusMessage` 截断到 500；净化后的 `server.json` ≤ 512 KB（D1 行上限 2 MB）。被拒条目计数写入 `sync_state.skipped_count` / `last_skip_reason`。整批写入失败时退回逐条写，坏行被跳过并计数，**游标照常前进**。
- 上游返回**重复 / 回环游标**（`next` 等于当前或本轮见过）：记错误并停止，不持久化未前进的游标。
- 网络失败 / 非 2xx / **重定向**（`redirect: 'manual'`，3xx 直接拒绝）/ 非法 JSON / 响应超过 8 MB（先看 `Content-Length`，再按**字节**流式计数）：不抛出，记入 `sync_state.last_error`，保留已写入的页，下次从游标续；成功后清除。上游必须是 `https://`（回环 `http://127.0.0.1|localhost[:port]` 仅用于本地测试，正则已锚定，`http://localhost.evil.test` 之类被拒）。

## 数据库与索引

`schema.sql` 是**全新库**的建表脚本（`servers` / `reviews` / `sync_state`）。刻意**不建二级索引**：主键 `(name, version)` 已经让 keyset 分页、versions 列表和 reviews 联接都走索引 `SEARCH`；目录是千级条目，偶发的 `updated_since` / `search` / `version=latest` 过滤是廉价扫描，而 `updated_since` 过滤的是 `max(servers.updated_at, reviews.reviewed_at)`，单列索引本来就帮不上。需要时先用 `EXPLAIN QUERY PLAN` 证明收益再加。

### 迁移已有数据库

这个仓库还没有部署过（`database_id` 是占位），正常情况下直接用 `schema.sql` 建新库。若你已按早期版本建过库：`servers` 缺 `server_json_sha256` / `first_seen_at`，`reviews` 的约束更严，且旧版审核没有 sha256（会被视为"未批准"）。最稳妥的做法——先导出审核、重建、回填：

```bash
npx wrangler d1 execute kepcup-registry --remote --command "select * from reviews" --json > reviews-backup.json
npx wrangler d1 execute kepcup-registry --remote --command "drop table servers; drop table reviews; drop table sync_state;"
npx wrangler d1 execute kepcup-registry --remote --file=./schema.sql
# 等 Cron 重新回填 servers，再对需要保留的条目经 submitReview 重新批准（sha256 由服务端重新计算）
```

## 响应形状：已对照与仍需核对

2026-10-10 联网抓取了官方 `https://registry.modelcontextprotocol.io/openapi.json`（OpenAPI 3.1.0，`info.version` 1.0.0），
`test/openapi-v0.1.subset.json` 是它的**手工维护子集**（只含只读 `/v0.1` 操作及其引用的 schema，改动列在文件顶部 `x-kepcup-modifications`），
`test/contract.test.ts` 用它校验 Worker 的每一种响应。**升级官方 OpenAPI 时重新抓取并 diff 这个子集。**

以下是**推断 / 有意偏离**，需要对照官方（实时 OpenAPI 或实现源码 `github.com/modelcontextprotocol/registry`）核对（"verify against live OpenAPI"）：

1. **`_meta` 扩展键**：官方 `ResponseMeta` / `ServerMeta` 是 `additionalProperties: false`，只含 `io.modelcontextprotocol.registry/official`（及 `…/publisher-provided`）。我们在响应 `_meta` 里加 `app.kepcup/connector` / `app.kepcup/review`——严格按生成代码解析的官方客户端可能拒绝；KepCup 客户端按宽松解析。子集里对这两处做了放宽。
2. **参数违规用 422**（官方 huma 实测 `limit=500` → 422 + `errors[]`）。执行方案原写 400；只有路径编码损坏用 400。
3. **游标格式**：官方实测是明文 `name:version`；OpenAPI 只说"用这个原值"（不透明），我们用 base64url，客户端不应解析。
4. **`updated_since` 不含边界**、`nextCursor` 仅在确有下一页时返回（官方可能在满页时就返回）、`GET …/versions` 的排序（按发布时间新→旧）、默认列表返回**所有**版本而非仅 latest——均由实测样本推断，官方文档未写明。
5. **`search`**：官方描述为"按 name 子串"；我们另外匹配 title / description（超集），且限 200 UTF-8 字节。`GET …/versions` 的 `cursor` 分页、`HEAD` / `OPTIONS` 是 KepCup 扩展（官方未列）。
6. `/v0` 别名假定与 `/v0.1` 同形状（官方当前 schema 同名）。
7. **未在真实 Cloudflare 运行时验证**（本期离线、未引入 wrangler / miniflare）：D1 对 `json_extract`、标量 `max(a,b)`、`instr` / `lower`、编号参数 `?NNN`、`ON CONFLICT … DO UPDATE … WHERE`、`batch()` 原子性的支持（均为 SQLite 标准功能，测试用 `node:sqlite` 跑通，并模拟了 D1 的 50 字节 LIKE 限制）；`caches.default` 的实际行为；Workers Free 的子请求上限（以 Cloudflare 当时文档为准）。部署后用下面的 `curl` 冒烟。

## 部署状态（2026-10-10）

已由 Agent 用 `.env` 里的令牌完成：创建 D1（`kepcup-registry`，id 已写入 `wrangler.jsonc`）、建表、部署 Worker 与 Cron，并绑定 custom domain `registry.kepcup.com`（冒烟：GET 200、ETag 条件请求 304、POST 405）。表在首次定时同步（每小时 :17 UTC）前为空。尚未做：WAF 速率限制（zone 级变更被分类器拦下，等你放行，见 `../README.md` §7）。线上变更记录见 `../README.md` §7。

下面的清单保留为"从零部署"的参考；第 2、3、5 步（不含路由）已完成。

## 部署（从零参考）

> 以下由用户在自己的 Cloudflare 账号完成；Agent 只准备材料，不代为登录 / 创建资源 / 部署。**不要把 API token 写进仓库。**
> 对应执行方案 U5（`dl.` / `registry.` 子域；Workers Paid）。

1. **Workers 套餐**：D1 与 Cron 在 Free 即可起步（千级条目）；规模化或与开发者门户 / Workflows 同账号时用 Workers Paid。
2. **创建 D1**：`npx wrangler d1 create kepcup-registry`，把输出的 UUID 填进 `wrangler.jsonc` 的 `database_id`（现为全零占位）。
3. **建表**：`npx wrangler d1 execute kepcup-registry --remote --file=./schema.sql`（全新库；幂等）。已有旧库见上文「迁移已有数据库」。
4. **DNS**：`registry.kepcup.com` 需要一条已代理（橙云）的记录（如 `AAAA registry 100::`），或把 `routes` 改成 `{"pattern":"registry.kepcup.com","custom_domain":true}` 让 wrangler 自动创建。
5. **部署**：`npx wrangler deploy --dry-run`，确认后 `npx wrangler deploy`；Cron（`triggers.crons`）随部署生效。
6. **首次回填**：`npx wrangler triggers`（或在控制台手动触发 scheduled）；全量回填要几轮 Cron（每轮默认 ≤ 8 页 × 100 条；Workers Paid 可把 `SYNC_MAX_PAGES` 调大），查看 `sync_state`：
   `npx wrangler d1 execute kepcup-registry --remote --command "select * from sync_state"`。
7. **冒烟**：`curl -s 'https://registry.kepcup.com/v0.1/servers?limit=2'`；`curl -sI` 看 `ETag`；`curl -s -o /dev/null -w '%{http_code}\n' -X POST https://registry.kepcup.com/v0.1/servers` 应为 405。
8. **Bot / WAF 例外**：目录同步与桌面端若直接访问该域名，确认 Bot Fight Mode / 挑战规则不拦截 `/v0.1/*`（见 `oauth-cimd/README.md` 同类说明）。
9. **WAF 速率限制规则**（见上文「缓存与滥用防护」）。
10. 开发者门户（`developers.kepcup.com`）**不**直接绑定本库：它经 service binding 调用本 Worker 的窄 RPC（`submitReview` / `revokeReview`，见 `todo/developer-portal.md` §9）；在那之前 `reviews` 为空，所有条目都不带 tier。且审核只能挂在同步已入库的 `(name, version)` 上——提交的 server 必须先发布到官方注册表。

## 测试

```bash
# 仅在 Docker 中（见 docs/dev/05-testing.md / AGENTS.md）
node scripts/run-tests.mjs run infra/cloudflare/registry
# 类型检查（宿主机）
npx tsc -p infra/cloudflare/registry --noEmit
```

测试用 `node:sqlite` 内存库实现 `D1Like`、用 Map 实现 `CacheLike`，不依赖 wrangler / miniflare / 网络。

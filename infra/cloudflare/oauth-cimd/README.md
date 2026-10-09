# oauth-cimd — KepCup OAuth 客户端元数据文档（CIMD）

把 `https://kepcup.com/oauth/client.json` 作为静态文件托管在 Cloudflare Workers Static Assets 上
（设计 29 §5.2 / §15.1，执行方案 `todo/connected-apps.md` §4.11）。支持 CIMD 的 OAuth 授权服务器
会把这个 URL 当作 `client_id` 抓取文档，从而免注册地为 KepCup 授权。

```
infra/cloudflare/oauth-cimd/
  wrangler.jsonc            仅静态资源（无 Worker 脚本），路由 kepcup.com/oauth/*
  public/oauth/client.json  CIMD 文档
  public/_headers           /oauth/* 的响应头
  verify.mjs                部署后的外部验证
```

kepcup.com 的 DNS 由 Cloudflare 托管，所以这里不引入其他托管方。

## 硬约束（授权服务器按此校验，违反即 `invalid_client`）

- `client_id` 与文档 URL **逐字相等**：`https://kepcup.com/oauth/client.json`（常量 `KEPCUP_OAUTH_CLIENT_ID`，
  `packages/shared/src/constants.ts`）。**这个 URL 永不更换。**
- 文档 ≤ 5 KB；响应在 10 秒内返回；**不得重定向**（`www` 跳转、尾斜杠规范化、HTTP→HTTPS 之外的任何规则都不能作用于
  `/oauth/*`）。
- `redirect_uris` 只用 `127.0.0.1` 字面量，不用 `localhost`（RFC 8252 §8.3）：`http://127.0.0.1/callback`
  （回环任意端口）+ `OAUTH_CALLBACK_PORTS` 三个固定端口的完整地址。
- 单测 `packages/shared/test/unit/cimd-document.test.ts` 锁住以上与代码常量的一致性。
- 变更纪律：`redirect_uris`、`client_name` 等字段改动视同发布，走评审；`OAUTH_CALLBACK_PORTS` 改了必须同步改这里。

## 用户待办（不属于代码，需要你确认 / 提供）

1. **`logo_uri`**：现为占位 `https://kepcup.com/oauth/logo.png`，**该文件还不存在**。请提供 logo
   （建议 PNG，≥ 128×128，< 100 KB）放到 `public/oauth/logo.png`，或把 `logo_uri` 改成官网已有的 logo URL
   （同步改 `client.json` 后重新部署）。授权同意页可能显示它；缺失只影响展示，一般不致授权失败。
2. **`policy_uri`**：现为 `https://kepcup.com/privacy`，**需要你确认**这是真实存在的隐私政策页面；
   没有的话请先建页面或改成正确地址（部分授权服务器会要求可访问）。
3. **Bot Fight Mode**：见下节，部署前必须决定处理方式（执行方案 U1）。

## 部署

前置：已有 Cloudflare 账号，kepcup.com 在该账号下；本机有 Node 18+。**不要把 API token 写进仓库。**

```bash
cd infra/cloudflare/oauth-cimd
npx wrangler login                     # 或使用 CLOUDFLARE_API_TOKEN（权限：Workers Scripts:Edit + Zone Workers Routes:Edit）
npx wrangler deploy --dry-run          # 先看将上传的资源与路由
npx wrangler deploy                    # 上传 public/ 并创建路由 kepcup.com/oauth/*
node verify.mjs                        # 部署后验证（见下）
```

说明：

- 路由 `kepcup.com/oauth/*` 只接管该路径，官网其余路径不受影响；该 Worker 没有脚本，只服务 `public/` 里的静态资源
  （静态资源请求在 Free 套餐不计费、不限量）。
- `wrangler.jsonc` 里 `html_handling: "none"` / `not_found_handling: "none"`：避免任何自动重定向或 SPA 回退作用于
  `/oauth/*`。
- 若 kepcup.com 的官网本身也是 Worker/Pages，确认其路由优先级不会截走 `/oauth/*`（更具体的路由优先）。
- 回滚：`npx wrangler rollback`，或删除路由；CIMD 宕机只影响**新**授权，已发放的令牌不受影响
  （授权服务器按 `Cache-Control` 缓存文档，最长约 7 天，错误响应不缓存）。

## Bot Fight Mode 注意事项（U1）

授权服务器是**服务端到服务端**抓取该文档，不会执行 JavaScript。若被 Cloudflare 的 JS 挑战 / 机器人防护拦截，
表现为授权服务器报 `invalid_client`（抓取失败）。

- **免费版**：Bot Fight Mode 无法用 WAF 自定义规则或 Page Rules 按路径跳过，只能整个 zone 关闭
  （Security → Bots → Bot Fight Mode）。要保留它，就得升级。
- **Pro 起**：用 Super Bot Fight Mode，并加 WAF 自定义规则对 `/oauth/*` 与 `/.well-known/*` 选择 Skip
  （跳过 Super Bot Fight Mode / 速率限制 / 托管规则）。
- 同时检查：「Block AI bots」「Under Attack Mode」、其他挑战 / 速率限制规则、Page Rules 的重定向（如 `www`
  规范化）都不覆盖 `/oauth/*`。
- 验证被拦截：`verify.mjs` 会在响应带 `cf-mitigated` 头时明确报错；或
  `curl -sI https://kepcup.com/oauth/client.json` 看是否 `403` / `cf-mitigated: challenge`。

## 验证

```bash
# 1) 部署前：本仓库内的静态检查（Docker 测试环境，见 AGENTS.md / docs/dev/05-testing.md）
node scripts/run-tests.mjs run packages/shared/test/unit/cimd-document.test.ts

# 2) 部署后：线上外部验证（200、application/json、无重定向、≤5 KB、client_id 与 URL 相等、内容与仓库一致）
node infra/cloudflare/oauth-cimd/verify.mjs
node infra/cloudflare/oauth-cimd/verify.mjs https://kepcup.com/oauth/client.json   # 显式指定

# 3) 手工
curl -sSI https://kepcup.com/oauth/client.json     # 期望 200 / content-type: application/json / cache-control: public, max-age=86400
curl -sS  https://kepcup.com/oauth/client.json | diff - infra/cloudflare/oauth-cimd/public/oauth/client.json
curl -sSI -o /dev/null -w '%{http_code} %{redirect_url}\n' https://kepcup.com/oauth/client.json   # 期望 200 且无 redirect_url
```

验证通过后在 `docs/dev/PROGRESS.md` 记录；再用 Notion 或 Linear 官方 MCP 以「自定义」方式手工走通一次 CIMD 授权
（P0 验收门禁）。

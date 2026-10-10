# directory — KepCup 签名目录索引（dl.kepcup.com）

把 CI 离线签名后的连接应用目录索引托管为 Cloudflare Workers Static Assets
（设计 29 §11.4 / §15.2，执行方案 `todo/connected-apps.md` §7.1）。客户端
（`packages/core/src/apps/directory-sync.ts`）每日拉取、验签、与随应用打包的快照合并；
验签失败 / 离线一律回落到快照。目录只含元数据，不含任何用户数据。

```
infra/cloudflare/directory/
  wrangler.jsonc                    仅静态资源（无 Worker 脚本），自定义域 dl.kepcup.com
  public/_headers                   缓存头（Static Assets 只认资源根目录的 _headers）
  public/connectors/v1/             CI 把签名产物放这里再部署（index.json 等被 .gitignore 忽略）
  verify.mjs                        部署后的外部验证（拉线上索引并验签）
```

## 文件格式（`/connectors/v1/`）

| 文件 | 内容 | 缓存 |
|---|---|---|
| `index.json` | `{ version: 1, generatedAt, keyId, entries: server.json[], deltas?: [{from,to,path,sha256}] }` | `public, max-age=300` |
| `index.json.sig` | 对 `index.json` **原始字节**的 Ed25519 分离签名，base64（64 字节） | 同上 |
| `deltas/{fromHash}-{toHash}.json` | 内容寻址的增量 `{version,from,to,upsert[],remove[]}`；hash = 条目集（按 `name` 排序、键排序的规范化 JSON）的 sha256 | `public, max-age=31536000, immutable` |

- `entries` 是 MCP Registry `server.json` 加 `_meta["app.kepcup/connector"]` 扩展（同 `catalog.json` 条目）。
- 索引**始终携带完整 `entries`**；增量只是带宽优化，客户端当前不依赖它（`deltas` 里列出的文件以
  `sha256` 绑定，索引本身已签名）。
- 客户端防回滚：`generatedAt` 必须**严格大于**上次接受的值（等于只有字节完全相同才算未变）；
  超前当前时间一天以上也拒绝。所以 CI 每次发布都要用新的（更晚的）`generatedAt`。
- `ETag`：Cloudflare 自动给静态资源加；客户端带 `If-None-Match`，未变返回 304。

## 签名（CI）

私钥只存在 CI 机密里（环境变量 `KEPCUP_CONNECTOR_SIGNING_KEY`：PKCS8 PEM，或 32 字节原始种子的
base64），**绝不入库、绝不写日志、不进 Workers Secrets**。签名发生在 CI 里（离线），Cloudflare 只收到
签名后的静态文件。

```bash
pnpm --filter @kepcup/shared build            # 校验条目 / 公钥列表要用 shared 产物
# 1. 取上一次已发布的目录（用于生成增量；首次发布没有）
mkdir -p prev && curl -fsS https://dl.kepcup.com/connectors/v1/index.json -o prev/index.json
# （需要增量时把 prev/deltas/* 也取回；脚本只携带找得到且 sha256 一致的旧增量）
# 2. 构建 + 签名（私钥只从环境变量读）
KEPCUP_CONNECTOR_SIGNING_KEY="$SECRET" node scripts/sign-connector-index.mjs \
  --out infra/cloudflare/directory/public/connectors/v1 \
  --key-id kepcup-2026-1 \
  [--extra-dir path/to/server.json-files] [--previous prev]
# 3. 签完先本地验一遍，再部署
node scripts/sign-connector-index.mjs --verify infra/cloudflare/directory/public/connectors/v1
cd infra/cloudflare/directory && npx wrangler deploy
node verify.mjs                                 # 部署后验线上
```

- 条目默认来自 `apps/desktop/resources/connectors/catalog.json`；`--extra-dir` 追加一个目录里的
  `*.json`（单个 server.json 或数组），`name` 不得与现有条目重复。
- `--key-id` 必须出现在应用内置的公钥列表里；`--generated-at <ISO|毫秒>` 可固定时间（默认现在）。
- 脚本签完会用对应公钥自检；输出里打印的是**公钥**（base64），私钥从不打印。
- 测试用一次性密钥：`node scripts/sign-connector-index.mjs --generate-dev-key <目录>`（拒绝写进仓库内）。

## 公钥列表与轮换

公钥编进应用：`packages/shared/src/domain/directory-index.ts` 的 `CONNECTOR_INDEX_PUBLIC_KEYS`
（`{ keyId, publicKey(原始 32 字节的 base64), validFrom, validUntil?, revoked }`）。生产列表目前只有 `kepcup-2026-1`（2026-10-10 起）；
列表为空 = 目录同步关闭、只用打包快照（`apps.directory.status` 显示 `disabled / no_keys`）。本机发布用 `infra/cloudflare/sign-directory.sh`（从 `.env` 读私钥）。

轮换（旧密钥 A → 新密钥 B）：

1. 生成 B，公钥以新 `keyId` 追加进列表（`validFrom` 设为计划切换时间之前），发一个应用版本；
2. 等该版本覆盖大部分用户后，CI 改用 B 签名（`--key-id` 换成 B）；
3. 给 A 设 `validUntil`（或下个版本里移除）；A 泄露则立刻设 `revoked: true` 并发版——被吊销的密钥
   签的索引客户端一律拒绝，用户回落到快照 / 上一份已验签缓存；
4. 轮换窗口内两把密钥并存，客户端按索引里的 `keyId` 选公钥。

## 验证

```bash
node infra/cloudflare/directory/verify.mjs                       # 线上 + 内置公钥列表
node infra/cloudflare/directory/verify.mjs https://dl.kepcup.com/connectors/v1 --keys keys.json
curl -sSI https://dl.kepcup.com/connectors/v1/index.json         # 期望 200、cache-control: public, max-age=300
curl -sS  https://dl.kepcup.com/connectors/v1/index.json.sig     # 期望一行 base64（88 字符）
```

## 用户待办（U5，不属于代码，agent 不会代做）

1. **生成真实签名密钥**（Ed25519），把私钥放进 CI 机密 `KEPCUP_CONNECTOR_SIGNING_KEY`；
   把公钥登记到 `CONNECTOR_INDEX_PUBLIC_KEYS` 并发版（在此之前客户端不会联网同步）。
2. **在 CI 里加签名 + 部署步骤**（上面的命令序列；`CLOUDFLARE_API_TOKEN` 需 Workers Scripts:Edit +
   Zone Workers Routes:Edit + 自定义域权限）。
3. **创建子域 `dl.kepcup.com`**：`wrangler deploy` 带 `custom_domain` 路由会自动建 DNS 记录与证书；
   kepcup.com 须在同一 Cloudflare 账号。确认 Bot Fight Mode / 挑战规则不会拦客户端的服务端请求
   （见 `../oauth-cimd/README.md` 同名一节）。
4. **发行门禁**：远端独有条目的 `releaseGate` 必须在应用构建注入的放行清单里
   （`apps/desktop/connector-release-gates.json`）才会显示——这是有意的：门禁权威留在客户端。
5. 首次部署后记入 `docs/dev/PROGRESS.md`，并走一遍 §7.8 的端到端验收（篡改 / 回滚被拒、离线回落）。

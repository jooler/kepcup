# plugins — KepCup 插件市场的签名与分发（用户待办清单）

插件市场（D104，设计 51 §6.1）复用连接器目录（`../directory/`）的签名索引机制：
CI 离线用 Ed25519 对 `index.json` **原始字节**签名，客户端（`packages/core/src/plugins/marketplace-sync.ts`）
每日拉取、验签、防回滚、落缓存。**在本清单完成之前，客户端的
`PLUGIN_INDEX_PUBLIC_KEYS` 是空数组 = 市场关闭，不发任何网络请求。**

通道分工：

- **索引**（`index.json` + `index.json.sig`）：走现有 `dl.kepcup.com` 的 Workers Static
  Assets，新路径 `/plugins/v1/`（`../directory/` 已配好缓存头与 .gitignore）；
- **包**（`{sha256}.kepcup`，单包可达数百 MB）：Workers Static Assets 单文件上限 25 MiB
  装不下，走 **R2 + 自定义域**，对象键内容寻址、不可变。

## 1. 生成真实签名密钥（不与连接器目录共用）

```bash
# 仅用于本地试跑 / 测试的一次性密钥（脚本拒绝写进仓库内）：
node scripts/sign-plugin-index.mjs --generate-dev-key /tmp/plugin-market-key --key-id kepcup-plugins-2026-1
```

生产密钥（Ed25519）在受控环境生成，**私钥只进 CI 机密 `KEPCUP_PLUGIN_SIGNING_KEY`**
（PKCS8 PEM，或 32 字节原始种子的 base64），绝不入库、绝不写日志、不进 Workers Secrets。
生产密钥与连接器目录的 `KEPCUP_CONNECTOR_SIGNING_KEY` **不共用**（两条通道独立轮换与吊销）。

把公钥登记进 `packages/shared/src/domain/plugin-index.ts` 的
`PLUGIN_INDEX_PUBLIC_KEYS`（`keyId` 建议形如 `kepcup-plugins-2026-1`，
`publicKey` = 原始 32 字节公钥的 base64，`validFrom` 设为计划上线时间之前）并发一个应用版本。
**在此之前客户端不联网同步**；登记后见 `../directory/README.md` 的轮换流程（同样适用）。

## 2. 建包分发：R2 bucket + 自定义域

- 建 R2 bucket（建议名 `kepcup-plugins`）与自定义域（建议 `pkg.kepcup.com`）；
- 对象键 = `{sha256}.kepcup`（脚本产物 `<out>/packages/{sha256}.kepcup` 直接对号上传）；
- 对象头：`Cache-Control: public, max-age=31536000, immutable`（内容寻址，永不覆盖——
  同名即同字节）；
- 包不可变，**重新发布同 sha256 = 同字节**，无需失效缓存。

## 3. CI 步骤序列（签名 → 核对 → 上传 → 部署）

```bash
pnpm --filter @kepcup/shared build && pnpm --filter @kepcup/package-guard build

# 1. 取上一版索引（用于核对 generatedAt 递增；首次发布跳过）
mkdir -p prev && curl -fsS https://dl.kepcup.com/plugins/v1/index.json -o prev/index.json || true

# 2. 组包目录 + 策展文件（tier 是信任元数据，只能来自策展，绝不来自包内清单）
#    packages/   <- 待发布 *.kepcup
#    catalog.json <- [{ "file": "x.kepcup", "tier": "verified"|"community",
#                       "summary": { "name", "description", "author" } }]
#    revoked.json <- 可选，[{ "id", "version?", "action": "warn"|"disable", "reason" }]

# 3. 签名（离线；私钥只从环境变量读）
KEPCUP_PLUGIN_SIGNING_KEY="$SECRET" node scripts/sign-plugin-index.mjs \
  --out dist-market \
  --key-id kepcup-plugins-2026-1 \
  --packages packages --catalog catalog.json [--revoked revoked.json] \
  --download-base https://pkg.kepcup.com \
  [--generated-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"]

# 4. 签完先本地验一遍（含每个包副本的 sha256 / 大小核对）
node scripts/sign-plugin-index.mjs --verify dist-market --keys <(echo '[{"keyId":"kepcup-plugins-2026-1","publicKey":"<登记的公钥>","validFrom":0,"revoked":false}]')

# 5. 上传包到 R2（内容寻址、immutable），再部署索引
npx wrangler r2 object put "kepcup-plugins/<sha256>.kepcup" --file "dist-market/packages/<sha256>.kepcup" \
  --cache-control "public, max-age=31536000, immutable"   # 逐个包
cd infra/cloudflare/directory && npx wrangler deploy      # /plugins/v1/ 静态资源一起部署
node infra/cloudflare/directory/verify.mjs                # 连接器目录线上复核（本通道同理可自写）
```

- `generatedAt` 必须**严格递增**（客户端防回滚；`--generated-at` 可固定时间，默认现在，
  且不许超前一天以上）。
- 脚本签完自检；输出里打印的是**公钥**（base64），私钥从不打印。
- 撤销名单：新索引的 `revoked` 数组随下次发布带上即可（`warn` 标记 / `disable` 自动停用）。

## 4. 首次部署后

1. 记入 `docs/dev/PROGRESS.md`；
2. 走一遍端到端验收：篡改 / 回滚被拒、离线回落上一份已验签缓存、撤销 `disable` 自动停用
   （任务书 `todo/plugin-system/P1-1-marketplace-core.md` §5 的对应条目）。

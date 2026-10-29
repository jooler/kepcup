# plugins — KepCup 插件市场的签名与分发（已上线）

插件市场（D104，设计 51 §6.1）的签名索引机制：CI / 本机离线用 Ed25519 对 `index.json`
**原始字节**签名，客户端（`packages/core/src/plugins/marketplace-sync.ts`）每日拉取、验签、
防回滚、落缓存。通道分工：

- **索引**（`index.json` + `index.json.sig`）：`dl.kepcup.com/plugins/v1/`（`kepcup-directory`
  Worker 的静态资源，见 `../directory/README.md`）；
- **包**（`{sha256}.kepcup`）：R2 bucket `kepcup-plugins` + 自定义域 `pkg.kepcup.com`
  （Workers Static Assets 单文件上限 25 MiB 装不下；对象键内容寻址、不可变）。

历史上有过一条连接器目录通道（同一 Worker 的 `/connectors/v1/`），已随 D104 商店化于
2026-10-28 移除——连接能力完全由市场插件承担，该路径已 404。

## 0. 当前状态（2026-10-28：全部就绪，市场已上线）

- ✅ R2 bucket `kepcup-plugins`（WNAM）+ 自定义域 `pkg.kepcup.com`（CNAME 自动创建、
  已代理、TLS active）；
- ✅ 索引域 `dl.kepcup.com/plugins/v1/` 上线（`public/_headers` 配好缓存头；
  `public/.assetsignore` 让 `.gitkeep` / `.gitignore` 不上线）；
- ✅ 签名密钥 `kepcup-plugins-2026-1`：私钥（Ed25519 32 字节种子 base64）在仓库根
  `.env` 的 `KEPCUP_PLUGIN_SIGNING_KEY`（绝不入库、绝不写日志、**不进 Workers Secrets**）；
  公钥登记在 `packages/shared/src/domain/plugin-index.ts` 的 `PLUGIN_INDEX_PUBLIC_KEYS`
  （`validFrom 2026-10-27`）；
- ✅ 首批 18 个官方插件（`plugins/` 开发目录：技能 9 + 连接器 9）已发布，线上索引验签与
  包 sha256 抽检通过；
- ✅ 本机发布包装 `infra/cloudflare/sign-plugins.sh`（从根 `.env` 读私钥）。

## 1. 日常发布（新插件 / 版本更新）

```bash
# 1. 在 plugins/ 里开发：validate → pack（见仓库 plugins/README.md）
# 2. 打包全部插件 + 更新策展文件 catalog.json（tier 只能来自策展，绝不来自包内清单）
# 3. 签名（私钥只从 .env 读；generatedAt 默认现在，必须严格递增）
infra/cloudflare/sign-plugins.sh --out /tmp/market/dist --key-id kepcup-plugins-2026-1 \
  --packages /tmp/market/packages --catalog /tmp/market/catalog.json \
  --download-base https://pkg.kepcup.com
# 4. 本地验签（含每个包副本的 sha256 / 大小核对）
node scripts/sign-plugin-index.mjs --verify /tmp/market/dist --keys <登记公钥的 keys.json>
# 5. 上传包到 R2（逐个；必须带 --remote，否则对象写进本地 miniflare）
npx wrangler r2 object put "kepcup-plugins/<sha256>.kepcup" --remote \
  --file "/tmp/market/dist/packages/<sha256>.kepcup" \
  --cache-control "public, max-age=31536000, immutable"
# 6. 部署索引（⚠️ 先确认 public/plugins/v1/ 里的 index.json / .sig 在位——签名产物
#    不入库，缺了就是把线上索引顶成 404）
cp /tmp/market/dist/plugins/v1/* infra/cloudflare/directory/public/plugins/v1/
cd infra/cloudflare/directory && npx wrangler deploy
# 7. 线上复核：curl 索引 + sig，node scripts/sign-plugin-index.mjs --verify <拉回的目录>
```

## 2. 撤销与轮换

- 撤销：下次发布在索引的 `revoked` 数组带上条目（`warn` 标记 / `disable` 自动停用）；
- 密钥轮换：生成新密钥 → 公钥以新 `keyId` 追加进 `PLUGIN_INDEX_PUBLIC_KEYS`（`validFrom`
  设为切换时间之前）并发应用版本 → 签名切到新密钥 → 旧密钥设 `validUntil`；泄露立即
  `revoked: true` 并发版。被吊销密钥签的索引客户端一律拒绝，用户回落上一份已验签缓存。

## 3. 首次部署后的端到端验收

任务书 `todo/plugin-system/P1-1-marketplace-core.md` §5：篡改 / 回滚被拒、离线回落上一份
已验签缓存、撤销 `disable` 自动停用。已随 2026-10-28 的首次发布记录进 `docs/dev/PROGRESS.md`。

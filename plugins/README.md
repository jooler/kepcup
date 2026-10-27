# KepCup 官方插件（marketplace 首批）

这里是 KepCup 官方插件的**开发目录**：每个子目录是一个独立插件源（`plugin.json` + 贡献），
用 `@kepcup/app-validator` 的 CLI 校验与打包，经 `infra/cloudflare/sign-plugins.sh` 签名后
发布到官方市场（`dl.kepcup.com/plugins/v1/`，包体在 R2 `kepcup-plugins` /
`pkg.kepcup.com`）。应用本身**不再随包内置**任何插件（D104 起转商店分发）。

## 目录约定

```
plugins/
  skill-<id>/          技能插件：skills/<id>/SKILL.md（+ requirements.txt）
  connector-<slug>/    连接器插件：connectors/<slug>/server.json（+ 图标）
  README.md
```

- 插件 id 用 `app.kepcup/<名>`：`com.kepcup` / `local.kepcup` 是保留命名空间，
  市场插件不得使用（`PLUGIN_RESERVED_NAMESPACES`）。
- 连接器目录通道（`dl.kepcup.com/connectors/v1`）已随商店化下线：连接能力完全由
  这里的市场插件承担；`server.json` 的 `_meta` 结构保持 registry 兼容形状。
- 技能展示字段（`displayName` / `icon` / `section` / `tryIt`）是内置插件专属，
  市场插件省略即可，界面回落到 SKILL.md 的 `name` / `description`。

## 开发流程（D104，docs/guides/write-a-plugin.md）

```bash
# 校验（目录）
node packages/app-validator/dist/cli.js validate plugins/skill-docx
# 打包（产物可复现；同时校验归档）
node packages/app-validator/dist/cli.js pack plugins/skill-docx --out /tmp/dist/skill-docx.kepcup
# 本地试装：扩展中心 → 已安装 → 从文件安装…
```

## 发布首批 / 增量发布

```bash
# 1. 打包全部插件到发布目录
mkdir -p /tmp/market/packages && for d in plugins/*/; do
  n=$(basename "$d"); [ "$n" = "README.md" ] && continue
  node packages/app-validator/dist/cli.js pack "$d" --out "/tmp/market/packages/$n.kepcup"
done
# 2. 更新 catalog.json（tier 是策展元数据：verified / community）
# 3. 签名 + 产物（私钥读根 .env 的 KEPCUP_PLUGIN_SIGNING_KEY）
infra/cloudflare/sign-plugins.sh --out /tmp/market/dist --key-id kepcup-plugins-2026-1 \
  --packages /tmp/market/packages --catalog /tmp/market/catalog.json \
  --download-base https://pkg.kepcup.com
# 4. 本地验签，再上传 R2（--remote！）并部署索引（先拉回线上 connectors 产物，见 §0 ⚠️）
node scripts/sign-plugin-index.mjs --verify /tmp/market/dist --keys <(…登记的公钥…)
npx wrangler r2 object put "kepcup-plugins/<sha256>.kepcup" --remote --file "…" \
  --cache-control "public, max-age=31536000, immutable"
cd infra/cloudflare/directory && npx wrangler deploy
```

完整密钥 / 轮换 / 撤销说明见 [infra/cloudflare/plugins/README.md](../infra/cloudflare/plugins/README.md)。

## 首批清单（18 个，2026-10-28 发布）

- 技能 9：docx / xlsx / pptx / pdf / mineru / meeting-notes / weekly-report /
  doc-coauthoring / internal-comms（原内置 `com.kepcup/starter-skills` 逐个拆分）；
- 连接器 9：notion / linear / atlassian / sentry / canva / stripe / cloudflare /
  gcalendar / gdrive（原内置 `com.kepcup/connections` 逐个拆分，server.json 未改）。
